# API Deployment Guide

Deployment guide for Onlooker API to Cloudflare Workers with D1 database.

## Overview

The API runs on **Cloudflare Workers**, a serverless platform that executes TypeScript at the edge.

- **Service:** `onlooker-api`
- **Runtime:** Cloudflare Workers (Node.js compatible)
- **Database:** Cloudflare D1 (SQLite)
- **Regions:** Global (replicated at Cloudflare edge)

## Configuration

### wrangler.toml

Key sections:

```toml
name = "onlooker-api"              # Service name
main = "src/index.ts"              # Entry point
compatibility_date = "2024-12-16"  # Cloudflare API version
compatibility_flags = ["nodejs_compat"]

# Routes: where the API is deployed
routes = [
  { pattern = "api.onlooker.dev/*", zone_name = "example.com" }
]

# Environments: dev, staging, production
[env.production]
[env.staging]
[env.development]
```

### Environment Variables

Each environment has its own configuration:

```toml
[env.production.vars]
ENVIRONMENT = "production"
CORS_ORIGIN = "https://app.onlooker.dev"
TOKEN_EXPIRY_MINUTES = "15"
REFRESH_TOKEN_EXPIRY_DAYS = "30"

[env.production.d1_databases]
binding = "DB"
database_name = "onlooker-db"
database_id = "YOUR-DATABASE-ID"
```

### Operator authority

`OPERATOR_USER_IDS` is a comma-separated list of user ids permitted to act as
an operator — retracting any lesson, blocking or unblocking an author key.
It is a var, not a secret, but it is deliberately not something you edit
casually: it lives in `wrangler.toml` rather than a database row so that
granting it is a deploy someone reviews, not a runtime change anyone with
database access can make unilaterally. Empty (`""`) means nobody is an
operator. See `middleware/principal.ts` for the check itself.

**Staging and production each name one operator** as of 2026-10-03; local
development is empty.

**Their ids are not in this repository.** This repo is public, and a user id
in `wrangler.toml` would publish which account to compromise for moderation
authority. The deploy injects the value instead, with `--var`, from a
repository secret — `OPERATOR_USER_IDS_STAGING` and
`OPERATOR_USER_IDS_PRODUCTION`. It remains a deploy-time value and not a
runtime one, so granting it is still a deploy rather than something database
access alone can do; what is given up is the id being visible in a reviewed
diff. Only development declares the var in `wrangler.toml`, empty, because a
local database is whatever you last seeded.

**There are two secrets, not one, and that is deliberate.** Each
environment's database issues its own user ids, so the production id names
nobody in staging and vice versa. A wrong id fails silently in the worst way:
the moderation routes answer 404 to a non-operator by design, so "this id
does not exist here" and "you may not use this route" are indistinguishable
from outside. If moderation appears not to work, check that the id belongs to
the database that environment is bound to before looking anywhere else.

Find an id with `SELECT id, email FROM users` against that environment's D1.

**To grant:** set the environment's secret and deploy. **To revoke:** delete
the secret and remove the guard and the `--var` from that deploy step in the
same diff — the deploy fails on an empty secret precisely so a revocation is
deliberate rather than a silent gap nobody notices until a lesson needs
pulling.

### Secrets

Sensitive values managed via CLI:

```bash
pnpm --filter @onlooker/api exec wrangler secret put JWT_SECRET --env production
pnpm --filter @onlooker/api exec wrangler secret put RESEND_API_KEY --env production
```

Those two, and nothing else. `DATABASE_PASSWORD` was the second line here and
nothing reads it — D1 is reached through the `DB` binding, which needs no
password. `RESEND_API_KEY` is the one that goes unnoticed when it is missing: the
API logs mail instead of sending it, so the deployment looks healthy and the
password resets never arrive. See
[ENVIRONMENT_VARIABLES.md](../../ENVIRONMENT_VARIABLES.md) for the full list,
which `scripts/source-guards.test.sh` holds to what `WorkerEnv` declares.

## Deployment

### Build

```bash
# Type-check and build
pnpm --filter @onlooker/api build

# This runs wrangler's dry-run to validate configuration
```

### Deploy

```bash
# Deploy to production
pnpm --filter @onlooker/api deploy --env production

# Deploy to staging
pnpm --filter @onlooker/api deploy --env staging

# Deploy to local development
pnpm --filter @onlooker/api deploy --env development
```

### Local Development

```bash
# Start wrangler dev server
pnpm --filter @onlooker/api dev

# Server runs on http://localhost:8787
```

## Database Setup

### Create Database

```bash
# Production
pnpm --filter @onlooker/api exec wrangler d1 create onlooker-db

# Copy database ID and add to wrangler.toml
```

### Run Migrations

CI applies migrations on every merge to `main`, before the schema verifier and
before this worker deploys — see [DEPLOYMENT.md](../../DEPLOYMENT.md). You
should not normally apply them by hand.

Migrations are generated from `packages/db/src/schema.ts` and live in
`packages/db/migrations`; `wrangler.toml` points `migrations_dir` there. Apply
them through wrangler's migration system rather than piping a file, so
`d1_migrations` stays an accurate record of what has been applied:

```bash
# Local (miniflare)
pnpm --filter @onlooker/api exec wrangler d1 migrations apply DB --env staging --local

# Remote — normally CI's job
pnpm migrate:staging
pnpm migrate:prod
```

### Query Database

```bash
# Local
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db --local "SELECT * FROM users"

# Production
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db --remote "SELECT * FROM users"
```

## Monitoring

### View Logs

```bash
# Real-time logs
pnpm --filter @onlooker/api exec wrangler tail --env production

# With filters
pnpm --filter @onlooker/api exec wrangler tail --env production --status ok

# Pretty format
pnpm --filter @onlooker/api exec wrangler tail --env production --format pretty
```

### Metrics

View in Cloudflare Dashboard → Workers → Analytics

- Request count
- Error rate
- CPU time
- Memory usage

## Bindings

### D1 Database

```typescript
// Access in handlers
async function handler(request: Request, env: WorkerEnv) {
  const db = env.DB;
  const user = await db.prepare(
    "SELECT * FROM users WHERE id = ?"
  ).bind(userId).first();
}
```

### KV Namespace

There is no KV namespace bound in any environment. This section showed handlers
reading `env.TOKEN_CACHE`, a binding that has never existed under that name.

`WorkerEnv` does declare `TOKEN_REVOCATION?: KVNamespace`, bound nowhere and read
nowhere, marking where an access-token denylist would attach if that trade is
ever revisited. See the KV Namespace Binding section in
[ENVIRONMENT_VARIABLES.md](../../ENVIRONMENT_VARIABLES.md).

## Endpoints

All endpoints are prefixed with `/auth/` or `/api/`:

```
POST   /auth/login
POST   /auth/signup
POST   /auth/refresh
GET    /auth/me
POST   /auth/logout
GET    /auth/profile
PATCH  /auth/profile
POST   /auth/change-password
DELETE /auth/account
POST   /auth/verify-email
POST   /auth/resend-verification
POST   /auth/forgot-password
GET    /auth/reset-password/verify
POST   /auth/reset-password
GET    /api/users/me
```

## Error Handling

All errors are caught and returned as JSON:

```json
{
  "error": "Email already exists",
  "status": 400
}
```

CORS headers are automatically added to all responses.

## Performance

### Optimization Tips

1. **Index frequent queries** — Add indexes to D1 tables
2. **Cache with KV** — Use KV for tokens and sessions
3. **Use prepared statements** — Prevents N+1 queries
4. **Batch operations** — Combine multiple operations

### Cold Starts

Cloudflare Workers have negligible cold start times (~1ms).

## Security

### CORS

Configured to allow only the web app domain:

```toml
[env.production.vars]
CORS_ORIGIN = "https://app.onlooker.dev"
```

### JWT Validation

All protected routes validate JWT tokens:

```typescript
const token = extractToken(request.headers.get('authorization'));
const user = await validateToken(token, env.JWT_SECRET);
```

### Password Hashing

Passwords are hashed before storage:

```typescript
const hash = await hashPassword(password);
```

### Rate Limiting

No general-purpose limiter in worker code. There is no `rateLimit` function in
this codebase and no KV namespace for one to use — the sample previously here
called both. The worker has two targeted limits instead, both described below:
the mail cap (`src/db/mail-sends.ts`) and the login backoff
(`src/db/login-attempts.ts`).
A browser-side throttle (`apps/web/src/utils/rateLimiting.ts`) used to sit in the
web app; it was unused and is removed, since anything calling the API directly
ignored it anyway.

**Mail is capped inside the worker**, per recipient, per inviter and per day,
in `src/db/mail-sends.ts` (ONL-222, ONL-228). Three resets or three
verification mails per address per hour, and three invites per address per day
across all orgs. Each user may send ten invites a day. Each kind has its own
daily pool: 45 resets, 10 verification mails and 25 invites, 80 in all, under
Resend's free-tier 100. The pools are separate so invites, which anyone can
send because accounts are free, cannot spend the mail a locked-out user needs.
The counters are a D1 table, `mail_sends`, pruned by the five-minute cron.
forgot-password answers a refusal with its usual 200, so the cap cannot say
which addresses have accounts. The other two answer 429 with `Retry-After`.
A spent pool raises a Sentry issue tagged `mail_kind`, once per pool per UTC
day, because from then until UTC midnight legitimate mail of that kind is
refused too. Every later refusal that day is logged as `mail_global_ceiling`
without raising another. Capped addresses and inviters log
`mail_address_capped` and `mail_inviter_capped` and raise nothing.

What does exist is **one** Cloudflare rate limiting rule on the `onlooker.dev`
zone, and one is the whole budget — the plan allows a single rule, and it is
spent. So this is not a rule among several that can be narrowed freely; it is the
only rate limiting the API has at the edge, and the only per-IP limit anywhere.

**"One rule" means one, and that is checkable rather than assumed.** Reading
`GET /zones/{zone}/rulesets/phases/http_ratelimit/entrypoint` is the complete
answer, including for the *previous-version* rate limiting product that this
account predates. Cloudflare upgraded every rule created in that version to the
new one automatically and serves the results through the Rulesets API in this
same phase — they appear tagged "Previous version" in the dashboard — and the
old `/zones/{zone}/rate_limits` API "stopped being supported on 2025-06-15 and
is no longer available". That endpoint answers `403 Authentication error` to the
Zone WAF token, which is not a gap: the one rule this phase holds was created
2026-09-28, after that cutoff, so it cannot be a migrated legacy rule. There is
nothing metering this zone that the read above does not show. Checked
2026-10-17 for ONL-171.

The zone also carries no `http_request_firewall_custom` ruleset, so no custom
WAF rule meters these paths either. Only Cloudflare-managed rulesets
(Normalization, Managed Free, DDoS L7) sit alongside the rate limiting one.

**The rule lives in `scripts/cloudflare/ratelimit.json`**, which is canonical,
and `scripts/cloudflare/apply.sh` is the only thing that should write it. Read
the expression there; this section is the reasoning, not the record.

6 requests per 10 seconds, action block, 10-second mitigation, counted per
client IP **and per datacenter** — `cf.colo.id` is in the characteristics, so
the practical ceiling is a multiple of 6 per 10s rather than a global one.

> **This section used to state a rule that did not exist.** Until 2026-10-17 it
> described five path clauses at 60 requests per minute per client IP with a
> one-minute duration. The zone held one clause — `/api/public/lessons/` — at
> the rate above. So the four `/auth/*` paths named below as covered were not
> covered, for however long that text stood, including
> `/auth/forgot-password`. Measured against the live zone, recorded in ONL-171,
> and the reason the expression now lives in a file that gets applied rather
> than a paragraph that gets believed. PR #209, earlier the same day, repeated
> the claim in this file and in `src/index.ts`; both are corrected here.

**Why those paths.** Each takes no credential and costs something real.
`/auth/forgot-password` reaches `sendEmail` on an unauthenticated request, so
without a limit anyone can mail-bomb a known address and burn the Resend quota.
`/auth/login` verifies a password, which is both CPU and the credential-stuffing
surface. `/auth/signup` creates an account and sends mail. `/auth/reset-password`
takes a token worth guessing at volume. `/api/orgs/invites/verify` runs a
SHA-256 and an indexed D1 read with no credential — token brute force is not
the concern, since the token is 32 bytes of crypto random, but unmetered D1
reads on an anonymous route are, which is the same reason the lessons path is
here (ONL-140). `/api/public/lessons/:id` runs a D1 read per request, and
nothing caches it — not the hit and not the miss, so every request is a real
read. See **Public lesson reads** below for why, and for the one change that
would alter it.

**Why `/auth/refresh` is deliberately excluded**, despite also being
unauthenticated: every active browser session calls it periodically, so behind a
corporate NAT or a mobile carrier a shared per-IP counter would throttle real
users. Guessing a random refresh token is not a realistic attack; legitimate
volume is. `/auth/logout`, `/auth/verify-email` and `/auth/reset-password/verify`
are cheap and low-risk. `/auth/resend-verification` is session-authenticated and
so already behind a credential.

**Before narrowing this rule, know what it is holding.** Removing a path from the
expression removes the only per-IP limit that path has. The mail-sending one is
the expensive mistake.

**What CI does and does not check.** `scripts/cloudflare/apply.test.sh` runs on
every PR and verifies the payload — valid, action `block`, every intended path
present, `/auth/refresh` still absent — and that the applier refuses rather
than overwriting a rule it does not describe. It needs no credential and never
touches the zone.

**The live zone is checked on a schedule** by
`.github/workflows/rate-limit-drift.yml`, which runs `apply.sh --check` with a
read-only token and fails on any difference from the payload, including a zone
with no rule at all. A failure arrives as GitHub's failed-workflow email,
typically within about four hours and within eight on the measured worst case,
because GitHub delivers an hourly cron far less often than hourly. The
workflow's header has the measurement and what is not covered (ONL-180).
Before that, a rule deleted in the dashboard produced no failing check, and the
first symptom would have been a bill or a Resend reputation problem.

**A login backoff does exist now, in worker code**, and it is the one piece of
WS5 that is not this zone rule. `handleLogin` refuses a sign-in after
`FREE_ATTEMPTS` (4) failures against the same address, for a cooldown that
doubles from one minute to a ceiling of thirty
(`src/db/login-attempts.ts`). It counts per account rather than per IP, which
is the dimension the zone rule cannot express — a flat per-IP ceiling just
makes an attacker rotate addresses. The counter keys on a hash of the
submitted address so the 429 reveals nothing about which accounts exist, and
the gate runs before bcrypt, which a source guard asserts.

Still unimplemented: per-account limits on anything other than login. That is
the next slice of ONL-222. Mail is covered: how many mails one address can be
made to receive from many clients is the mail cap described above, not the
zone rule.

### Public lesson reads

`GET /api/public/lessons/:id` takes no credential, so its rate limit is a
Cloudflare edge rule rather than worker code. It is not a rule of its own: it
shares the zone's single rate limiting rule with the unauthenticated `/auth/`
endpoints, described under **Rate Limiting** above. That section is the one to
read and the only place the expression is written down — deliberately, so the two
cannot drift.

A retraction or an author block is not instant, but the delay is in the reader's
browser rather than at the edge. `GET /api/public/lessons/:id` is served with
`public, max-age=60`, so a client that already fetched a lesson can keep showing
it for up to a minute after the operator route returns 200. Re-fetch after the
window before concluding a takedown failed.

**Nothing caches it at the edge.** Verified 2026-10-03 against the live zone and
the Cloudflare documentation:

- Workers Caching — the feature that lets Cloudflare serve a worker's response
  without running the worker — is **off**. It is turned on by a `[cache]` block
  in `wrangler.toml`, and this worker has none. From outside, that looks like
  the absence of a `Cf-Cache-Status` header on every response from
  `api.onlooker.dev`, which is what live requests show.
- Zone cache configuration cannot reach it either. Cache Rules, Cache Response
  Rules, Page Rules and the zone cache level apply to what a worker `fetch()`es
  from an origin, not to the response a worker returns. `handlePublicLesson`
  reads D1 and returns `Response.json`; it never calls `fetch()`, so there is no
  subrequest for a zone rule to act on.

So `max-age=60` is an instruction to the client and nothing else, the takedown
floor is one minute of browser cache, and there is no edge copy to purge. It
also means **every request is a worker invocation and a real D1 read** — nothing
absorbs repeats, which is why the rate limiting rule above is the only thing
standing in front of this route.

**If you ever add `[cache] enabled = true`, read this section first.** Workers
Caching applies RFC 9111 heuristic freshness to responses that set no
`Cache-Control` at all: a `200` is cached for two hours and a `404` for three
minutes. The reasoning "the handler sets `Cache-Control` only on the success
path, so a miss is never cached" holds *only* while caching is off — under
Workers Caching it is exactly backwards, and 404s for lesson ids that do not
exist would start being served from cache. Turning it on would also put a real
edge copy behind the takedown story, which `ctx.cache.purge()` exists to
invalidate.

No test can observe any of this: `SELF.fetch` in the test harness never
populates an edge cache, which is why the retraction and block tests in
`routes/admin-moderation.test.ts` that assert "stops serving it" pass instantly
and prove nothing about production timing.

### Org invite verification

`GET /api/orgs/invites/verify` takes no credential, like
`GET /api/public/lessons/:id` above — the invitation token in the query
string is the credential, not a session.

**It is not covered by the zone's single rate limiting rule.** That rule's
expression, quoted in full under **Rate Limiting**, is:

```
(http.host eq "api.onlooker.dev" and (
  starts_with(http.request.uri.path, "/api/public/lessons/")
  or http.request.uri.path in {"/auth/login" "/auth/signup" "/auth/forgot-password" "/auth/reset-password"}
))
```

`/api/orgs/invites/verify` matches neither clause: it does not start with
`/api/public/lessons/`, and it is not one of the four literal `/auth/`
paths. This route currently has no rate limit at all, at the edge or
anywhere else.

**The fix is widening that one rule's expression, not adding a second
rule.** The plan allows a single Cloudflare rate limiting rule on this
zone, and as **Rate Limiting** above says, it is already spent.

**What a request actually costs:** a SHA-256 of the supplied token
(`hashToken` in `src/utils/crypto.ts`) plus one indexed D1 lookup on
`org_invites.token_hash` (`findInviteByTokenHash` in
`src/db/org-invites.ts`). Brute-forcing the token itself is not the
realistic risk — it is 32 bytes from `crypto.getRandomValues`, the same
construction as `generateRefreshToken` — the unmetered D1 read on every
guess is.

Nothing in CI or in this repository can verify that the zone's rule covers
this path. That is the same reason **Rate Limiting** above gives for
writing itself down: if the gap is never closed, the first symptom is a
bill, not a failing test.

### The org lesson tier

**All three visibility tiers are open.** `POST /lessons` accepts
`visibility: "org"` as of ONL-141; before that it refused the tier outright.
Nothing needs enabling per environment — there is no flag.

**An org lesson's reach follows the TOKEN it was pushed with, not the
author's memberships.** The server reads the org from `machine_tokens.org_id`
and stamps it onto the row; no request field can name an org. The practical
consequences for a support question:

- An account in an org that pushes with a token bound to no org gets
  `outcome: "invalid"` per lesson, naming the token. The fix is minting a new
  token for that org (`POST /api/machines` with `org_id`), not editing the
  lesson. The rest of the batch still lands — push is per lesson, not
  all-or-nothing.
- A token is bound at minting time, after a membership check, and never
  re-checked. An author removed from an org keeps pushing to it until that
  token is revoked. This is deliberate — see D3 — but it means **revoking the
  token is the action that ends the sharing**, not removing the member.
- A lesson keeps the org it was pushed with. Moving an author between orgs
  does not move their existing lessons.

**Deleting an org is not reversible, and it does more than unbind tokens.**
Both columns are `ON DELETE set null` (`packages/db/migrations/0011_*.sql`):

- Every machine token bound to that org becomes private-only. Pushes keep
  working; org lessons from those tokens start being refused.
- Every lesson already shared with that org has its `org_id` nulled. Because
  the read predicate requires `org_id IN (<the reader's orgs>)` and NULL
  matches nothing, those lessons become readable **by their author only** —
  immediately, and permanently, since the org id they referred to no longer
  exists. Renaming an org is the safe operation; deleting one silently
  narrows a body of shared lessons that no later action can restore.

## Rollback

### View Deployments

```bash
pnpm --filter @onlooker/api exec wrangler deployments list --name onlooker-api
```

### Rollback to Previous Version

```bash
pnpm --filter @onlooker/api exec wrangler deployments rollback --id <deployment-id>
```

## Troubleshooting

### "Database binding not found"

```bash
# Verify wrangler.toml has [[d1_databases]] section
grep -A 3 "d1_databases" wrangler.toml

# Check database ID is correct
pnpm --filter @onlooker/api exec wrangler d1 list
```

### CORS Errors

```bash
# Check CORS_ORIGIN matches web app domain
grep "CORS_ORIGIN" wrangler.toml

# Test preflight request
curl -i -X OPTIONS http://localhost:8787/auth/login \
  -H 'Origin: http://localhost:5173' \
  -H 'Access-Control-Request-Method: POST'
```

### Slow Responses

```bash
# Check logs for errors
pnpm --filter @onlooker/api exec wrangler tail --env production

# Add logging to slow endpoints
log('info', 'Slow query', { duration: Date.now() - start });

# Check D1 query performance
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db --remote "EXPLAIN QUERY PLAN SELECT ..."
```

### Secret Not Available

```bash
# List secrets
pnpm --filter @onlooker/api exec wrangler secret list --env production

# Add missing secret
pnpm --filter @onlooker/api exec wrangler secret put JWT_SECRET --env production
```

## Related Docs

- [DEPLOYMENT.md](../../DEPLOYMENT.md) — Full deployment guide
- [ENVIRONMENT_VARIABLES.md](../../ENVIRONMENT_VARIABLES.md) — Environment reference
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Cloudflare D1 Docs](https://developers.cloudflare.com/d1/)

## Quick Commands

```bash
# Development
pnpm dev                           # Start local server
pnpm build                         # Build and validate
pnpm deploy:prod                   # Deploy API and web to production
pnpm deploy:staging                # Deploy API and web to staging

# Monitoring
pnpm tail:api                      # View logs
pnpm tail:api:staging              # View staging logs

# Database
pnpm migrate:prod                  # Apply migrations to production
pnpm migrate:staging               # Apply migrations to staging
pnpm db:backup                     # Export production D1 to backup_<epoch>.sql

# Secrets
pnpm --filter @onlooker/api exec wrangler secret list --env production
pnpm --filter @onlooker/api exec wrangler secret put JWT_SECRET --env production
```
