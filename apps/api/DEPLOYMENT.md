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

None in worker code. There is no `rateLimit` function in this codebase and no
KV namespace for one to use — the sample previously here called both.
`apps/web/src/utils/rateLimiting.ts` exists and is **not** this: it throttles the
browser, so anything calling the API directly ignores it.

What does exist is **one** Cloudflare rate limiting rule on the `onlooker.dev`
zone, and one is the whole budget — the plan allows a single rule, and it is
spent. So this is not a rule among several that can be narrowed freely; it is the
only rate limiting the API has, at the edge or anywhere else.

Its expression, which is what makes one rule cover several surfaces:

```
(http.host eq "api.onlooker.dev" and (
  starts_with(http.request.uri.path, "/api/public/lessons/")
  or http.request.uri.path in {"/auth/login" "/auth/signup" "/auth/forgot-password" "/auth/reset-password"}
))
```

60 requests per minute per client IP, action block, one-minute duration.

**Why those paths.** Each takes no credential and costs something real.
`/auth/forgot-password` reaches `sendEmail` on an unauthenticated request, so
without a limit anyone can mail-bomb a known address and burn the Resend quota.
`/auth/login` verifies a password, which is both CPU and the credential-stuffing
surface. `/auth/signup` creates an account and sends mail. `/auth/reset-password`
takes a token worth guessing at volume. `/api/public/lessons/:id` runs a D1 read
per request, and nothing caches it — not the hit and not the miss, so every
request is a real read. See **Public lesson reads** below for why, and for the
one change that would alter it.

**Why `/auth/refresh` is deliberately excluded**, despite also being
unauthenticated: every active browser session calls it periodically, so behind a
corporate NAT or a mobile carrier a shared per-IP counter would throttle real
users. Guessing a random refresh token is not a realistic attack; legitimate
volume is. `/auth/logout`, `/auth/verify-email` and `/auth/reset-password/verify`
are cheap and low-risk. `/auth/resend-verification` is session-authenticated and
so already behind a credential.

**Before narrowing this rule, know what it is holding.** Removing a path from the
expression removes the only limit that path has. The mail-sending one is the
expensive mistake.

Nothing in CI can verify any of this. If the rule is deleted the API keeps
working, and the first symptom is a bill or a Resend reputation problem rather
than a failure. Per-account limits, a login backoff, and mail-send throttling are
still unimplemented — `src/index.ts` has said "WS5: Rate limiting and security
(not yet implemented)" throughout.

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
