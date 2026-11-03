# A Per-Account Circuit Breaker for Signed-In Routes — Design

Linear: ONL-222, the last slice. The mail caps (#248, #249, #257) were the
others.

**Every signed-in request counts against one budget per account, 1,000 per 60
seconds, enforced by a Workers rate limiting binding.** It's a circuit breaker
for a runaway script or a stolen token. No real user should ever meet it.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-11-03.
Sections marked *(measured)* were read from this repository, production or
Cloudflare's documentation on 2026-11-03. Sections marked *(proposed)* are this
document's own.

## The gap *(measured)*

No route that takes a credential has any limit. That's 33 session routes, 5
machine routes and 3 operator routes (`apps/api/src/router.ts`). The zone's one
rate limiting rule covers only the unauthenticated `/auth/*` paths and the
public lesson (`apps/api/DEPLOYMENT.md`, "Rate Limiting"). Login has its own
failed-attempt backoff (`db/login-attempts.ts`).

A per-IP rule is the wrong unit here anyway. It can't tell 30 people behind
one NAT from one attacker, and the plan allows one zone rule, which is used.

## What real traffic looks like *(measured)*

- **Nothing calls the API on its own.** Every CLI request comes from a person
  running `onlooker sync` or `onlooker link`. `apps/cli` has no hook, timer or
  daemon, and the librarian plugin only mentions `sync` in a comment.
- **One sync** sends 1 inventory PUT, one session report per 128 KiB chunk, one
  push per 100 approved lessons, and pull pages of 100 until it catches up. The
  push resends every approved lesson on every run.
- **The worst legitimate burst** is about 74 requests in 15–30 seconds from one
  machine: a first sync with 2,000 approved lessons, a pool 5,000 lessons
  behind, and 3 session chunks. That's roughly 150–300 a minute. A normal sync
  is about 5 requests.
- **Production, last 7 days:** 2 machines, 4 syncs. The largest burst wrote 421
  session rows within one minute, which was a first sync.
- **The CLI doesn't handle 429.** It doesn't retry, back off or read
  `Retry-After`. It treats 429 as transient and tells the user to run the
  command again (`apps/cli/src/api.ts:45`).

## The policy *(approved)*

- **The threat is a runaway or stolen token**, not fair use between accounts.
  The limit protects D1 writes and Worker CPU.
- **One budget per account:** 1,000 requests per 60 seconds, keyed
  `user:<user id>`, shared by the browser and the CLI, across every machine on
  the account.
  - Two machines on one account each doing a worst-case first sync at the same
    moment come to about 600. 1,000 clears that.
  - It caps a runaway at about 17 requests a second.
- **Enforce from the first deploy.** A trip answers 429 and reports to Sentry.

## The mechanism *(approved, measured)*

The Workers rate limiting binding, generally available since 2025-09-19
(Cloudflare docs, "Rate Limiting"):

- A check reads a locally cached count. It adds no D1 query and almost no
  latency.
- It's **approximate**: requests can exceed the limit while counts sync in the
  background.
- It counts **per Cloudflare location**. A stolen token used from many
  locations gets the limit once in each.
- The period must be **10 or 60 seconds**.
- It needs Wrangler 4.36.0 or later. `apps/api` pins `wrangler` at `^4`.

A circuit breaker needs none of the precision it lacks. A D1 counter would add
a write to every signed-in request in order to protect D1 writes, and a Durable
Object is new infrastructure for precision nothing here needs.

## The code *(proposed)*

**Bindings**, in every environment of `apps/api/wrangler.toml`:

- `ACCOUNT_LIMITER`: limit 1000, period 60.
- `LIMIT_REPORT_GATE`: limit 1, period 60. It gates Sentry reports (see
  Alerting).

Each gets its own `namespace_id`, distinct between environments, so staging
traffic can't spend production's counts.

`WorkerEnv` gains both as optional (`RateLimit | undefined`). An environment
without them, such as the test pool's miniflare config, fails open (see
Failure).

**Where it runs:** in `dispatch`, after `resolvePrincipal` and before the
handler, and only when `resolvePrincipal` returns a principal. A route whose
`auth` is `"none"` never consults the limiter.

It runs after the principal because the key has to come from a verified
credential, not a claimed one. So a flood with a valid stolen machine token
still pays the token check (one D1 read and the `last_used_at` write) on every
request. What the limit saves is the handler: the 100-lesson push batches,
session reports and pool reads, which are where the cost actually is.

**The unit:** a small module, `middleware/account-limit.ts`, that owns the key
format, the refusal and the report gate. `dispatch` calls one function from it.

## What the caller sees *(approved)*

- **429**, code `rate_limited`, with `Retry-After: 60`. The binding doesn't say
  when its window resets, so 60 is the honest upper bound.
- The body has the same shape as every other `ApiError`. `ApiError` already
  carries extra headers, which the login backoff uses for `Retry-After`
  (`routes/auth.ts:134`).

## Alerting *(approved)*

Reporting every refused request would turn a runaway into a Sentry quota
problem. So a refusal reports only when `LIMIT_REPORT_GATE` allows it, keyed
`report:<user id>`, which means at most once a minute per account per location.

- Fingerprint `["account_rate_limited"]`.
- Tags: the route's method and its pattern (for example
  `POST /lessons/:id/status`), never the concrete path.
- The user id goes in the event's `extra`, as `user_id`, not in a tag. It's an
  opaque id, not an email. (`CaptureContext` in `packages/monitoring` has no
  per-event user, and `setUser` is global to the isolate.)
- With no `LIMIT_REPORT_GATE`, a refusal still answers 429 but isn't reported,
  since one report per refused request is the flood the gate exists to stop.

## Failure *(approved)*

If `limit()` throws, or either binding is missing, the request goes through. A
broken limiter shouldn't take the API down with it. A throw is reported,
fingerprinted `["account_limiter_failed"]`. A missing binding isn't reported,
because it's the expected state in tests and local dev.

## Tests *(proposed)*

These inject a fake limiter on `env`, so nothing sends 1,000 requests:

- A refused session route and a refused machine route answer 429 with
  `Retry-After: 60` and `rate_limited`, and the handler doesn't run (its side
  effect doesn't happen).
- An allowed request reaches the handler.
- A route whose `auth` is `"none"` never calls the limiter.
- The key is `user:<user id>`, the same for a session and a machine token on
  one account.
- The report gate: two refusals in a row report once.
- A limiter that throws lets the request through and reports
  `account_limiter_failed`. A missing binding lets it through and reports
  nothing.
- A source guard in `scripts/source-guards.test.sh`: in `dispatch`, the limit
  call sits between `resolvePrincipal` and the handler call.

## Docs *(proposed)*

- `apps/api/DEPLOYMENT.md`, "Rate Limiting": the account limit, its size and
  why, the two bindings, the alert, and the fail-open choice.
- The WS5 comment in `apps/api/src/index.ts` stops saying per-account limits
  are missing.

## Out of scope

Filed in Linear rather than built here:

- **The CLI's 429 handling.** Nothing reads `Retry-After`, and the push loop
  calls `client.push` with no catch around it
  (`apps/cli/src/commands/sync.ts:301`). Whether a caller further up catches
  the 429 isn't checked yet. It's a gap with or without this limit.
- **Budgets per machine.** `Principal` deliberately doesn't carry the machine
  id (see `Route.handler`'s comment), and one account budget already covers
  the threat. A stolen session could mint more machine tokens, but they all
  count against the same account.
- **Limiting machine-token minting.** That's a separate control on
  `POST /api/machines`.
