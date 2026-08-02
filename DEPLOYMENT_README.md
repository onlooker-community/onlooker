# Deployment README

Quick start guide for deploying Onlooker to Cloudflare.

## Overview

This project deploys to **Cloudflare** using:
- **Pages** for the web app (Vite + React)
- **Workers** for the API (TypeScript)
- **D1** for the database (SQLite)
- **KV** for caching and rate limiting (optional)

## Architecture

```
┌─────────────────────────────┐
│   Cloudflare Pages          │
│   onlooker.example.com      │
│   (Vite React App)          │
└──────────┬──────────────────┘
           │ API calls
           ▼
┌─────────────────────────────┐
│   Cloudflare Workers        │
│   api.onlooker.example.com  │
│   (TypeScript API)          │
└──────────┬──────────────────┘
           │ SQL queries
           ▼
┌─────────────────────────────┐
│   Cloudflare D1             │
│   (SQLite Database)         │
└─────────────────────────────┘
```

## Quick Start

### 1. Install & Authenticate

```bash
# Install dependencies
pnpm install

# Authenticate with Cloudflare
pnpm cloudflare:login
```

### 2. Create Database

```bash
# Create production database
pnpm wrangler d1 create onlooker-db

# Copy the database ID from output and add to apps/api/wrangler.toml
```

### 3. Configure

Update these files with your settings:

- `apps/api/wrangler.toml` — API config, database ID, routes
- `apps/web/wrangler.toml` — Web app config, API URL

### 4. Set Secrets

```bash
# Generate and set JWT secret
pnpm wrangler secret put JWT_SECRET --env production
# Paste: openssl rand -hex 32
```

### 5. Deploy

```bash
# Deploy everything
pnpm deploy:prod

# Or separately
pnpm deploy:api:prod   # Deploy API
pnpm deploy:web:prod   # Deploy web app
```

## Full Documentation

- **[DEPLOYMENT.md](./DEPLOYMENT.md)** — Complete step-by-step deployment guide
- **[CLOUDFLARE_SETUP.md](./CLOUDFLARE_SETUP.md)** — Detailed Cloudflare configuration
- **[ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md)** — Environment variables reference

## Configuration Files

| File | Purpose |
|------|---------|
| `apps/api/wrangler.toml` | API (Workers) configuration |
| `apps/web/wrangler.toml` | Web app (Pages) configuration |
| `.github/workflows/deploy.yml` | GitHub Actions CI/CD pipeline |

## Deployment Scripts

```bash
# Deploy to production
pnpm deploy:prod

# Deploy to staging
pnpm deploy:staging

# Deploy just API
pnpm deploy:api:prod

# Deploy just web
pnpm deploy:web:prod

# View API logs
pnpm tail:api

# Backup database
pnpm db:backup
```

## Environments

### Development

```bash
# Local development
pnpm dev

# API: http://localhost:8787
# Web: http://localhost:5173
```

### Staging

```bash
pnpm deploy:staging

# API: https://api-staging.onlooker.example.com
# Web: https://staging.onlooker.example.com
```

### Production

```bash
pnpm deploy:prod

# API: https://api.onlooker.example.com
# Web: https://onlooker.example.com
```

## Verification

After deployment:

```bash
# Test API health
curl https://api.onlooker.example.com/

# Test login
curl -X POST https://api.onlooker.example.com/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"test123"}'

# View logs
pnpm tail:api
```

## Troubleshooting

### Database not found
```bash
pnpm wrangler d1 list
# Check database ID in wrangler.toml matches output
```

### CORS errors
```bash
# Verify CORS_ORIGIN in wrangler.toml matches your domain
curl -i -X OPTIONS https://api.onlooker.example.com/auth/login \
  -H 'Origin: https://onlooker.example.com'
```

### Deployment fails
```bash
# Check logs
pnpm tail:api

# View build output
pnpm --filter @onlooker/api build
pnpm --filter @onlooker/web build
```

See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed troubleshooting.

## GitHub Actions

Automatic deployments are configured in `.github/workflows/deploy.yml`:

1. Push to `staging` branch → Deploy to staging
2. Push to `main` branch → Deploy to production
3. Pull requests → Run tests only

Setup:
1. Generate Cloudflare API token
2. Add to GitHub repository secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`

## Key Concepts

### Environment Variables

- **Build-time** (Vite): `VITE_API_URL` in `wrangler.toml`
- **Runtime** (Workers): Variables in `[env.*.vars]` sections
- **Secrets**: Managed via `pnpm wrangler secret put` (never in wrangler.toml)

See [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md) for complete reference.

### Database Migrations

```bash
# Create migration file in apps/api/migrations/

# Run locally
pnpm wrangler d1 execute onlooker-db --local < migration.sql

# Run on production
pnpm wrangler d1 execute onlooker-db --remote < migration.sql
```

### Secrets Management

```bash
# Set a secret
pnpm wrangler secret put JWT_SECRET --env production

# List secrets
pnpm wrangler secret list --env production

# Delete a secret
pnpm wrangler secret delete JWT_SECRET --env production
```

## Performance Tips

1. **Pages caching** — Assets cached at Cloudflare edge
2. **D1 optimization** — Add indexes to frequently queried columns
3. **KV caching** — Use for token validation and session data
4. **Monitoring** — Check Cloudflare Analytics dashboard

## Support

- Cloudflare Docs: https://developers.cloudflare.com/
- Project Issues: https://github.com/onlooker-community/onlooker/issues
- Discord: [invite link]

## Next Steps

1. Read [DEPLOYMENT.md](./DEPLOYMENT.md) for step-by-step deployment
2. Review [CLOUDFLARE_SETUP.md](./CLOUDFLARE_SETUP.md) for detailed setup
3. Check [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md) for config reference
4. Follow GitHub Actions setup for automatic deployments
