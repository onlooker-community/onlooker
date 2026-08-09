# Synthetic Heartbeat — Design

**Status:** Complete — approved
**Date:** 2026-08-09

---

## Why this exists

The observability dashboards being built in Cloudflare cannot work without it.

Production has one user. Organic traffic is effectively zero, so every chart sits
at zero — and **zero-because-idle is indistinguishable from zero-because-dead.**
That ambiguity is not hypothetical: `api-staging.onlooker.dev` was unreachable
for days because its route was configured without `custom_domain`, so Cloudflare
never created the DNS record. The worker was deployed, the route existed, and
nothing errored, because no request ever arrived.

Cloudflare's standard analytics datasets are also **sampled**, and its own
documentation names low-traffic endpoints as the case sampling does not serve.

A steady synthetic floor fixes both. It gives the charts a known-constant
baseline, so *deviation from constant* becomes the signal rather than spike
detection that will never fire. It also gives sampling enough volume to work
with.

## What it does

A GitHub Actions workflow on a schedule makes six requests every five minutes,
three per environment.

| # | Request | Expect | Proves |
|---|---|---|---|
| 1 | `GET https://app.onlooker.dev/` | `200` | web app is served |
| 2 | `GET https://api.onlooker.dev/auth/me` | `401` | worker alive, JWT validation reached |
| 3 | `POST https://api.onlooker.dev/auth/refresh` | `401` | D1 read path alive |
| 4 | `GET https://app-staging.onlooker.dev/` | `200` | as above, staging |
| 5 | `GET https://api-staging.onlooker.dev/auth/me` | `401` | |
| 6 | `POST https://api-staging.onlooker.dev/auth/refresh` | `401` | |

Checks 3 and 6 send `{"refreshToken":"heartbeat"}` with
`Content-Type: application/json`.

All six were verified against the live deployments on 2026-08-09 and return
exactly these codes today.

### Why `/auth/refresh` is the database check

`handleMe` calls `requireAuth` first, which throws `401` before reaching
`getUserById`. A bad token there never touches D1, so it proves only that the
worker runs.

`handleRefresh` passes its `400` guard when a `refreshToken` field is present,
then calls `getRefreshToken(env.DB!, ...)`, which hashes the value and queries
the `sessions` table by `token_hash`. A garbage token returns no row and throws
`401` — after a real query has run.

So it exercises connection, table, index and query while **writing nothing**. No
test user, no credentials in secrets, and no synthetic `sessions` rows. That
last point matters: nothing prunes expired sessions today, so a login-based
heartbeat at this cadence would add roughly 1,440 rows a day to production
forever.

### Why the assertion is equality, not "not an error"

Each check asserts the status code **equals** the expected value. A `not 5xx`
check would pass in cases that matter:

- `401` on `/auth/refresh` — the query ran and correctly found nothing. Healthy.
- `500` — it threw. D1 unreachable, table missing, or schema wrong. **This is the
  case that would have caught the earlier incident**, where the API answered
  `200` at the root while no database-backed route could work.
- `200` — a garbage refresh token minted a session. Authentication is bypassed.

Equality catches all three; "not 5xx" catches none of them.

Every request uses `--max-time 10`, so a hanging host fails its check rather
than hanging the job.

## Failure behavior

**Production failures fail the run.** Any of checks 1–3 mismatching exits
non-zero, which turns the run red and triggers GitHub's default failure
notification. That is the entire alerting mechanism — no additional
infrastructure.

**Staging failures do not.** Checks 4–6 emit a `::warning::` annotation and a
job-summary line, and the run stays green.

The asymmetry is deliberate. Staging breaks routinely and by design — mid-deploy,
mid-migration, mid-experiment. A monitor that fires during normal work is one
people mute, and a muted monitor protects nothing.

Both environments are still requested regardless of which is failing, so the
traffic floor the dashboards depend on is never affected by a check's verdict.

## Cadence

`*/5 * * * *` — the minimum GitHub Actions supports.

GitHub warns that scheduled runs can be delayed under load, so cadence is
approximate. That is acceptable: the job is detecting "this has been down for a
while," not measuring precise uptime.

## Known limitation: scheduled workflows disable themselves

GitHub disables scheduled workflows after 60 days of repository inactivity. A
heartbeat that silently switches itself off is exactly the failure class this
exists to prevent, and there is no clean fix inside Actions.

It is covered by a property of the design rather than by a mechanism. The
dashboard's first chart tracks requests per hostname; if the heartbeat stops,
the traffic floor disappears and the chart flatlines. **The dashboard watches the
heartbeat and the heartbeat feeds the dashboard** — each surfaces the other's
failure.

## Out of scope

**Analytics Engine.** Verdicts live in Actions; the requests land in
Cloudflare's HTTP datasets automatically because they cross the edge. Writing
datapoints from Actions would mean API credentials and a payload format for no
gain.

**Any check of the database write path.** `/auth/refresh` covers reads only.
Proving writes needs a real login, which reopens the synthetic-data question
this design specifically avoided.

**The "successful logins" metric** that the second dashboard needs. That
requires an Analytics Engine binding and a `writeDataPoint` call inside the API
worker itself — separate work, tracked separately.

**Consecutive-failure suppression.** Failing only after two or three
consecutive misses would model real outages more faithfully, but needs state
carried between runs. Not worth the complexity in a first version; revisit if
single-blip noise proves annoying in practice.
