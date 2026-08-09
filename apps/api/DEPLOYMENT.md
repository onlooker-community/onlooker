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
TOKEN_EXPIRY_MINUTES = "180"
REFRESH_TOKEN_EXPIRY_DAYS = "30"

[env.production.d1_databases]
binding = "DB"
database_name = "onlooker-db"
database_id = "YOUR-DATABASE-ID"
```

### Secrets

Sensitive values managed via CLI:

```bash
pnpm wrangler secret put JWT_SECRET --env production
pnpm wrangler secret put DATABASE_PASSWORD --env production
```

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
pnpm wrangler d1 create onlooker-db

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
pnpm wrangler d1 execute onlooker-db --local "SELECT * FROM users"

# Production
pnpm wrangler d1 execute onlooker-db --remote "SELECT * FROM users"
```

## Monitoring

### View Logs

```bash
# Real-time logs
pnpm wrangler tail --env production

# With filters
pnpm wrangler tail --env production --status ok

# Pretty format
pnpm wrangler tail --env production --format pretty
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

```typescript
// Access in handlers
async function handler(request: Request, env: WorkerEnv) {
  const cache = env.TOKEN_CACHE;
  await cache.put(token, 'true', { expirationTtl: 3600 });
}
```

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
GET    /api/dashboard
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

Optional rate limiting with KV:

```typescript
const remaining = await rateLimit(ip, env.TOKEN_CACHE);
if (remaining <= 0) {
  return new Response('Too many requests', { status: 429 });
}
```

## Rollback

### View Deployments

```bash
pnpm wrangler deployments list --name onlooker-api
```

### Rollback to Previous Version

```bash
pnpm wrangler deployments rollback --id <deployment-id>
```

## Troubleshooting

### "Database binding not found"

```bash
# Verify wrangler.toml has [[d1_databases]] section
grep -A 3 "d1_databases" wrangler.toml

# Check database ID is correct
pnpm wrangler d1 list
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
pnpm wrangler tail --env production

# Add logging to slow endpoints
log('info', 'Slow query', { duration: Date.now() - start });

# Check D1 query performance
pnpm wrangler d1 execute onlooker-db --remote "EXPLAIN QUERY PLAN SELECT ..."
```

### Secret Not Available

```bash
# List secrets
pnpm wrangler secret list --env production

# Add missing secret
pnpm wrangler secret put JWT_SECRET --env production
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
pnpm deploy                        # Deploy to production
pnpm deploy --env staging          # Deploy to staging

# Monitoring
pnpm tail:api                      # View logs
pnpm tail:api:staging              # View staging logs

# Database
pnpm db:migrate                    # Apply migrations
pnpm db:backup                     # Backup database

# Secrets
pnpm wrangler secret list --env production
pnpm wrangler secret put JWT_SECRET --env production
```
