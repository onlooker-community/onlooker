# Authenticated Heartbeat — Design

**Status:** Approved, not yet implemented
**Date:** 2026-08-17
**Extends:** [the synthetic heartbeat](2026-08-09-heartbeat-design.md)
**Bead:** `onlooker-9bn`

---

## Why this exists

Every request production serves today is a rejection.

Traffic on the API is exactly two things: the heartbeat, asserting `401`, and
internet background scanners, collecting `404`. There is no third category. So
every log line, every trace and every span describes what the system does when
it turns somebody away.

This was visible once Workers tracing landed (PR #57) and someone looked at what
the traces contained:

- `bcryptjs` at cost factor 10 runs only on login, signup and change-password.
  None of those paths receive production traffic, so the expense that motivated
  part of the observability epic has never been observed running.
- `GET /auth/me` traces as a single span with no D1 child. That is not because
  it does no database work — `handleMe` calls `getUserById` — but because
  `requireAuth` rejects the tokenless heartbeat first. The trace describes the
  rejection.
- `POST /auth/refresh` is the only path with a D1 span, and only by accident: it
  queries `sessions` *before* deciding to reject.

The existing heartbeat is doing exactly what it was designed to do. The gap is
that **"the API correctly says no" and "the API works" are different claims**,
and only the first is monitored. An outage confined to the authenticated path —
a broken JWT secret, a `users` table migration gone wrong, a `requireAuth`
regression — passes all four current checks.

This design closes that gap for **monitoring**. Measuring what a successful
request costs is a separate goal and is explicitly not pursued here; the figures
will come from real traffic when there is some.

## What it does

Four checks per environment, added after the existing four. The existing checks
are unchanged.

| # | Request | Expect | Proves |
|---|---|---|---|
| 5 | `POST /auth/login` | `200`, non-empty `.token` and `.refreshToken` | D1 read, bcrypt compare, JWT sign, session write |
| 6 | `GET /auth/me` with `Authorization: Bearer <token>` | `200`, `.user.email` matches the account | JWT verify, and `getUserById` behind `requireAuth` |
| 7 | `POST /auth/logout` with `.refreshToken` | `200` | revocation runs, and session rows stay bounded |
| 8 | `POST /auth/refresh` with the revoked token | `401` | logout actually revoked |

Check 6 asserts the returned email rather than only the status. A `200`
carrying the wrong user is a worse failure than a `500`, and status alone cannot
see it.

### Why check 8 is worth a request

`handleLogout`'s own comment records that it once revoked nothing at all, so a
logged-out session could call `/auth/refresh` indefinitely, each call minting a
fresh 30-day window. "Logged out" meant only that one browser had forgotten its
tokens.

That regression shipped. Check 8 is the assertion that would have caught it, and
it costs one request against a run that currently makes four.

### Why not a dedicated health endpoint

A `GET /health/authenticated` route would give a stable contract that does not
move when `/auth/me` changes shape. It was rejected.

This project has already made that mistake in its more obvious form. The
heartbeat used to assert only `GET /`, which is a file on disk and cannot fail
the way a routing outage fails — and it passed every check, every 31 minutes, in
both environments, throughout an outage where every route except `/` returned
`404` (`onlooker-stc`, fixed in PR #49).

A monitoring-only endpoint is the same mistake with better manners: it can stay
green while the route users actually reach is broken. `/auth/me` is what the web
app calls on every session restore, so watching it watches the real thing.

### Why a password and not a token

The obvious alternative — store a long-lived refresh token as the secret, skip
the password entirely — does not work here. `handleRefresh` **rotates**: it
revokes the presented token and issues a new one. A stored refresh token would
authenticate exactly once and then fail forever.

## Credentials

Per-environment GitHub secrets. The workflow maps the correct pair into generic
`HEARTBEAT_EMAIL` and `HEARTBEAT_PASSWORD` variables per step, so the script
stays environment-agnostic and the mapping lives in one visible place.

| Secret | Used by |
|---|---|
| `HEARTBEAT_EMAIL_PRODUCTION` / `HEARTBEAT_PASSWORD_PRODUCTION` | the production step |
| `HEARTBEAT_EMAIL_STAGING` / `HEARTBEAT_PASSWORD_STAGING` | the staging step |

**The email is a secret, not an Actions variable.** This repository is public,
which makes its Actions logs public. Secrets are masked in logs; variables are
not. The script must never print either value — check labels name the check, not
the account.

The password is sent via `--data @-` and a heredoc rather than `-d` on the
command line, keeping it out of the process arguments.

### The account address is not routable

`heartbeat@onlooker.dev` in production, `heartbeat-staging@onlooker.dev` in
staging, and **no Email Routing rule for either**. Distinct per environment so a
leaked staging credential is useless against production, and so the rows
describe themselves to whoever finds them in the `users` table later.

No obscure naming. The repository is public and the runbook names the address;
obscurity would buy nothing and cost legibility.

Nothing about provisioning or monitoring needs mail to arrive: `/auth/signup`
sends no email, and `handleLogin` never reads `email_verified`. The usual
argument for a routable address — recovery — does not apply either, because the
account owns nothing and `/auth/signup` is public, so recovering it means
creating another one and updating the secret.

What a routable address would cost is a live, unauthenticated path into a
mailbox. The repository is public, `/auth/forgot-password` is public, so anyone
could fire resets at it indefinitely; and because Email Routing forwards to a
verified personal destination, whoever can read that inbox could complete a
reset and take the account. Unroutable makes password reset impossible by
construction rather than by policy.

The decision is reversible in one direction only, which is why it goes this way
first. Adding a routing rule later changes neither the database row nor the
secret. Removing one later does not un-publish an address that has already been
harvested.

**This account will therefore never verify its email, deliberately.** It is
fine today because nothing in the login path consults `email_verified`. If
verification ever gates login, this heartbeat starts failing — and that is
correct signal, since such a change would also lock out every unverified real
user. It is only *useful* signal if the next person finds this decision written
down instead of a mystery. The runbook repeats it for that reason.

### What this exposes

The script is public, so assume the existence of a monitoring account is known
and its address guessable. Only the password protects it.

That is a smaller change to the threat model than it first appears: `/auth/signup`
is public and unauthenticated, so anyone can already create an account. This adds
one valid credential held in a GitHub secret, not a new class of exposure. The
account is a normal user with no elevated permission, and it must own no data
anyone would miss.

## Failure behavior

Unchanged from the existing design: production failures fail the workflow, which
is the alerting mechanism, because GitHub emails on workflow failure. Staging
runs first, is advisory, and warns without failing.

### Missing credentials: skip locally, fail in CI

If `HEARTBEAT_EMAIL` or `HEARTBEAT_PASSWORD` is absent, checks 5–8 are skipped
with a warning and the run continues. A developer running
`scripts/heartbeat.sh production` by hand has no reason to hold production
credentials, and the four read-only checks are still worth having.

Skipping is also how a check rots into a no-op that passes forever, which is a
failure this project has already had once in a different form.

So the workflow sets `HEARTBEAT_REQUIRE_AUTH=1`, and under that flag absent
credentials are a **failure** rather than a skip. Skip by hand, fail in CI. A
secret that gets deleted or renamed then breaks the build instead of quietly
reducing the heartbeat to what it was before this change.

## What this costs

Derived by counting the calls each handler makes, **not measured**. Re-measure
once it has run, and correct these figures here rather than leaving them to
mislead — the volumes in this repository have been wrong twice already for
exactly that reason.

| | now | after |
|---|---|---|
| checks per environment per run | 4 | 8 |
| api invocations/day, per environment | ~106 | ~318 |
| D1 operations/day, per database | ~53 | ~318 |
| total requests/day, all four hosts | ~424 | ~848 |

All still far below free-tier limits. Two documents need the same correction in
the same change: the expected-volumes table in
[`docs/observability-dashboards.md`](../../observability-dashboards.md), and
Dashboard 4's `401` baseline, which becomes three per environment per run rather
than two once check 8 lands.

### The heartbeat stops being read-only

`scripts/heartbeat.sh` opens by claiming it proves the database read path works
"without writing anything." That stops being true: each run writes a session row
at check 5 and revokes it at check 7.

The header gets rewritten to say so. The property is worth losing — a check that
cannot write cannot verify that writing works — but it is not worth quietly
falsifying the comment that claims it.

## Provisioning

One-time, per environment, using the product's own signup endpoint so the
password hash is produced by the same code path that will later verify it. No
hand-written SQL and no hand-generated bcrypt hash.

Documented in a new runbook, `docs/runbooks/2026-08-17-heartbeat-account.md`,
covering creation, rotation, the rule that the account owns nothing, and that it
is permanently unverified by design.

## Out of scope

- **Measuring what a successful request costs.** The goal here is monitoring.
  Timing figures — how expensive bcrypt actually is on a Worker, what a
  successful request's span tree looks like — come from real traffic later.
- **D1 latency.** Tracing showed a `d1_all` span at 100 ms against a
  `sql_duration_ms` of 0.31, because the Worker ran in `LAX` and the database
  answered from `MIA`. That is `onlooker-ujy` and is not touched here.
- **Choosing an error-reporting vendor.** The epic (`onlooker-k34`) sequences
  that decision after this one, deliberately: evaluating error tooling against
  traffic containing no successful requests would evaluate the wrong thing.
- **Rate limiting and abuse protection on the auth routes.** Unimplemented
  (WS5), unchanged by this.
- **Monitoring whether password-reset mail is delivered.** A real gap —
  `onlooker-9qf` records no DMARC policy and no root SPF on the domain that
  sends resets — and a routable heartbeat address is where you would naturally
  assert it. Not a reason to make this address routable now; that is a design
  question for whoever works `onlooker-9qf`, and adding a routing rule then
  changes nothing here.
