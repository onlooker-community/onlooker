# Deployment Checklist

Use this checklist to ensure all deployment steps are completed.

## Pre-Deployment Setup

### Cloudflare Account & Tools

- [ ] Cloudflare account created
- [ ] Domain added to Cloudflare (or using Cloudflare nameservers)
- [ ] `pnpm wrangler login` completed
- [ ] `pnpm wrangler whoami` shows correct account

### Local Development

- [ ] `pnpm install` completed
- [ ] `pnpm dev` works (local development server)
- [ ] Web app loads at `http://localhost:5173`
- [ ] API responds at `http://localhost:8787`
- [ ] No TypeScript errors: `pnpm typecheck`
- [ ] Linting passes: `pnpm lint`
- [ ] Tests pass: `pnpm test`

### Configuration Files

- [ ] `apps/api/wrangler.toml` exists with all sections
- [ ] `apps/web/wrangler.toml` exists with all sections
- [ ] `.github/workflows/deploy.yml` exists (optional but recommended)
- [ ] Route patterns updated with your domain

## Database Setup

### Create Databases

- [ ] Production database created: `pnpm wrangler d1 create onlooker-db`
- [ ] Database ID copied to `apps/api/wrangler.toml` [env.production.d1_databases]
- [ ] Staging database created (optional): `pnpm wrangler d1 create onlooker-db-staging`
- [ ] Staging database ID added to wrangler.toml

### Database Configuration

- [ ] D1 binding added to wrangler.toml with correct database ID
- [ ] Database name matches: `onlooker-db` for production
- [ ] Binding name is `DB`

### Migrations

- [ ] Migration files created in `apps/api/migrations/`
- [ ] `0001_init.sql` includes users, sessions, verification_tokens tables
- [ ] Migrations applied locally: `pnpm wrangler d1 execute onlooker-db --local < ...`
- [ ] Migrations tested locally
- [ ] Migrations applied to staging: `pnpm wrangler d1 execute onlooker-db-staging --remote < ...`
- [ ] Migrations applied to production: `pnpm wrangler d1 execute onlooker-db --remote < ...`

### Database Verification

- [ ] Can query production database: `pnpm wrangler d1 execute onlooker-db --remote "SELECT 1"`
- [ ] Tables exist: `pnpm wrangler d1 execute onlooker-db --remote ".schema"`
- [ ] Indexes created
- [ ] Sample data inserted (for testing)

## Secrets & Environment Variables

### API Secrets

- [ ] Generated JWT secret: `openssl rand -hex 32`
- [ ] Set production secret: `pnpm wrangler secret put JWT_SECRET --env production`
- [ ] Set staging secret: `pnpm wrangler secret put JWT_SECRET --env staging`
- [ ] Listed secrets: `pnpm wrangler secret list --env production`

### API Variables

- [ ] `ENVIRONMENT` set to `production` in wrangler.toml
- [ ] `CORS_ORIGIN` set to web app domain (e.g., `https://onlooker.example.com`)
- [ ] `TOKEN_EXPIRY_MINUTES` set (default: `180`)
- [ ] `REFRESH_TOKEN_EXPIRY_DAYS` set (default: `30`)

### Web Variables

- [ ] `VITE_API_URL` set in `apps/web/wrangler.toml` for each environment:
  - [ ] Development: `http://localhost:8787`
  - [ ] Staging: `https://api-staging.onlooker.example.com`
  - [ ] Production: `https://api.onlooker.example.com`

### Optional: KV Namespace

- [ ] KV namespace created: `pnpm wrangler kv:namespace create "TOKEN_CACHE"`
- [ ] Namespace ID added to wrangler.toml
- [ ] Binding name is `TOKEN_CACHE`
- [ ] Created for both production and staging

## Build & Test

### Build Process

- [ ] API builds without errors: `pnpm --filter @onlooker/api build`
- [ ] Web app builds without errors: `pnpm --filter @onlooker/web build`
- [ ] No TypeScript errors
- [ ] Output directories exist:
  - [ ] `apps/api/` (dist generated during deploy)
  - [ ] `apps/web/dist/` (built)

### Local Testing

- [ ] Start API: `pnpm --filter @onlooker/api dev`
- [ ] Start Web: `pnpm --filter @onlooker/web dev`
- [ ] Web loads at `http://localhost:5173`
- [ ] Web can call API at `http://localhost:8787`
- [ ] Login works with test user
- [ ] No CORS errors in browser console

## Deployment

### API Deployment

- [ ] Dry-run successful: `pnpm --filter @onlooker/api build`
- [ ] Deploy to staging: `pnpm --filter @onlooker/api deploy --env staging`
- [ ] Verify staging deployment: `https://api-staging.onlooker.example.com/`
- [ ] Deploy to production: `pnpm --filter @onlooker/api deploy --env production`
- [ ] Verify production deployment: `https://api.onlooker.example.com/`

### Web Deployment

- [ ] Build complete: `pnpm --filter @onlooker/web build`
- [ ] Verify `dist/` directory exists with assets
- [ ] Deploy to staging: `pnpm --filter @onlooker/web deploy --env staging`
- [ ] Verify staging deployment: `https://staging.onlooker.example.com`
- [ ] Deploy to production: `pnpm --filter @onlooker/web deploy --env production`
- [ ] Verify production deployment: `https://onlooker.example.com`

## Post-Deployment Verification

### API Health

- [ ] API root endpoint responds: `curl https://api.onlooker.example.com/`
- [ ] Returns JSON with version and endpoints
- [ ] Response time < 500ms

### Web App Health

- [ ] Web app loads at `https://onlooker.example.com`
- [ ] All assets load (JS, CSS, fonts, images)
- [ ] No 404 errors for static assets
- [ ] React app initializes without errors
- [ ] Browser console has no errors

### CORS Configuration

- [ ] Preflight request succeeds:
  ```bash
  curl -i -X OPTIONS https://api.onlooker.example.com/auth/login \
    -H 'Origin: https://onlooker.example.com' \
    -H 'Access-Control-Request-Method: POST'
  ```
- [ ] Response includes `Access-Control-Allow-Origin` header
- [ ] Web app can call API endpoints

### Authentication

- [ ] Signup endpoint works: `POST /auth/signup`
- [ ] Login endpoint works: `POST /auth/login`
- [ ] Returns JWT token
- [ ] Token is valid (can decode and verify)
- [ ] Refresh token endpoint works: `POST /auth/refresh`

### Database Integration

- [ ] User created in database during signup
- [ ] User can be queried: `SELECT * FROM users WHERE email = ...`
- [ ] Session created in database after login
- [ ] Can retrieve user by token

### SSL/TLS

- [ ] HTTPS certificate valid and not expired
- [ ] No mixed content warnings (all resources over HTTPS)
- [ ] Certificate issuer is Cloudflare

### Performance

- [ ] Page load time < 2 seconds
- [ ] No slow API responses (> 1 second)
- [ ] Assets cached at edge (check `CF-Cache-Status` header)
- [ ] Cloudflare caching working

### Monitoring & Logs

- [ ] Can view logs: `pnpm wrangler tail --env production`
- [ ] Logs show requests and responses
- [ ] Error logs capture issues
- [ ] Can view Cloudflare Analytics dashboard

## Continuous Deployment (GitHub Actions)

### Setup

- [ ] `.github/workflows/deploy.yml` exists
- [ ] Cloudflare API token generated in dashboard
- [ ] Cloudflare account ID obtained
- [ ] GitHub secrets added:
  - [ ] `CLOUDFLARE_API_TOKEN`
  - [ ] `CLOUDFLARE_ACCOUNT_ID`

### Testing

- [ ] Create test branch and push
- [ ] GitHub Actions workflow runs
- [ ] All checks pass (lint, test, build)
- [ ] No deployment on PR (only on merge to main)

### Staging Deployment

- [ ] Push to `staging` branch
- [ ] GitHub Actions deploys to staging
- [ ] Staging deployment succeeds
- [ ] Can verify at staging URL

### Production Deployment

- [ ] Push to `main` branch
- [ ] GitHub Actions deploys to production
- [ ] Production deployment succeeds
- [ ] Verify production app works

## Documentation

- [ ] [DEPLOYMENT.md](./DEPLOYMENT.md) reviewed and complete
- [ ] [CLOUDFLARE_SETUP.md](./CLOUDFLARE_SETUP.md) matches your configuration
- [ ] [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md) updated with your values
- [ ] [DEPLOYMENT_README.md](./DEPLOYMENT_README.md) reviewed
- [ ] [apps/api/DEPLOYMENT.md](./apps/api/DEPLOYMENT.md) reviewed
- [ ] [apps/web/DEPLOYMENT.md](./apps/web/DEPLOYMENT.md) reviewed
- [ ] README files updated with any custom information
- [ ] Deployment scripts documented

## Security

- [ ] No secrets committed to git
- [ ] JWT secret is strong (32+ random bytes)
- [ ] Database password is strong
- [ ] CORS origin is correctly restricted (not `*`)
- [ ] HTTPS enforced (all traffic over TLS)
- [ ] Environment-specific secrets set correctly
- [ ] Production secrets different from staging/dev

## Rollback Plan

- [ ] Know how to view deployments: `pnpm wrangler deployments list`
- [ ] Know how to rollback: `pnpm wrangler deployments rollback`
- [ ] Database backup exists: `pnpm db:backup`
- [ ] Can restore from backup if needed
- [ ] Know procedure to revert Pages deployment (via dashboard)

## Monitoring & Maintenance

- [ ] Set up alerts for errors
- [ ] Monitor Cloudflare Analytics dashboard
- [ ] Check logs regularly: `pnpm tail:api`
- [ ] Monitor error tracking (if using Sentry)
- [ ] Set schedule for database backups
- [ ] Review and rotate secrets periodically
- [ ] Update dependencies monthly
- [ ] Run security audits regularly

## Optional Enhancements

- [ ] Rate limiting configured in KV
- [ ] Email notifications on errors
- [ ] Slack integration for alerts
- [ ] Sentry for error tracking
- [ ] DataDog for monitoring
- [ ] CDN cache rules optimized
- [ ] Worker analytics enabled
- [ ] Custom analytics dashboard

## Sign-Off

- [ ] All items checked
- [ ] Deployment tested end-to-end
- [ ] Production app stable and responsive
- [ ] Ready for users

---

## Quick Commands Reference

```bash
# Installation
pnpm install
pnpm cloudflare:login

# Development
pnpm dev
pnpm typecheck
pnpm lint
pnpm test

# Build
pnpm build
pnpm --filter @onlooker/api build
pnpm --filter @onlooker/web build

# Deploy
pnpm deploy:prod
pnpm deploy:api:prod
pnpm deploy:web:prod
pnpm deploy:staging

# Monitor
pnpm tail:api
pnpm tail:api:staging

# Database
pnpm wrangler d1 execute onlooker-db --remote "SELECT 1"
pnpm db:backup
pnpm db:migrate

# Secrets
pnpm wrangler secret put JWT_SECRET --env production
pnpm wrangler secret list --env production

# Debugging
pnpm wrangler deployments list --name onlooker-api
curl https://api.onlooker.example.com/ -i
```

---

## When Ready to Deploy

1. ✅ Run through this entire checklist
2. ✅ All items checked
3. ✅ Execute deployment commands
4. ✅ Verify each section works
5. ✅ Monitor logs for errors
6. ✅ Test critical user flows
7. ✅ Monitor for 24 hours post-deployment
8. ✅ If issues, rollback using procedures above

**Deployment Status:** 🟡 Ready when all items checked

---

For detailed instructions, see [DEPLOYMENT.md](./DEPLOYMENT.md)
