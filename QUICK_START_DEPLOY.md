# Quick Start: Deploy Onlooker to Cloudflare

Fast-track guide for experienced DevOps engineers. See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed steps.

## 1. Authenticate (2 minutes)

```bash
pnpm install
pnpm cloudflare:login
pnpm wrangler whoami  # Verify
```

## 2. Create Databases (3 minutes)

```bash
# Production
pnpm wrangler d1 create onlooker-db
# Copy DATABASE-ID

# Staging (optional)
pnpm wrangler d1 create onlooker-db-staging
# Copy this ID too
```

## 3. Configure wrangler.toml (2 minutes)

**File:** `apps/api/wrangler.toml`

Update database IDs in:
- `[env.production.d1_databases]` - database_id = "YOUR-PROD-ID"
- `[env.staging.d1_databases]` - database_id = "YOUR-STAGING-ID"

**File:** `apps/web/wrangler.toml`

Verify VITE_API_URL endpoints:
- Development: `http://localhost:8787`
- Staging: `https://api-staging.onlooker.example.com`
- Production: `https://api.onlooker.example.com`

## 4. Run Migrations (3 minutes)

```bash
# Local (development)
pnpm wrangler d1 execute onlooker-db --local < apps/api/migrations/0001_init.sql

# Staging
pnpm wrangler d1 execute onlooker-db-staging --remote < apps/api/migrations/0001_init.sql

# Production
pnpm wrangler d1 execute onlooker-db --remote < apps/api/migrations/0001_init.sql

# Verify
pnpm wrangler d1 execute onlooker-db --remote "SELECT COUNT(*) FROM users"
```

## 5. Set Secrets (2 minutes)

```bash
# Generate secrets
openssl rand -hex 32  # Copy this

# Production
pnpm wrangler secret put JWT_SECRET --env production
# Paste the random value

# Staging
pnpm wrangler secret put JWT_SECRET --env staging
# Paste a different random value

# Verify
pnpm wrangler secret list --env production
```

## 6. Build & Test (5 minutes)

```bash
# Verify builds work
pnpm --filter @onlooker/api build
pnpm --filter @onlooker/web build

# Test locally
pnpm dev

# In separate terminals:
# Terminal 1: pnpm --filter @onlooker/api dev
# Terminal 2: pnpm --filter @onlooker/web dev
# Check: http://localhost:5173 (web) and http://localhost:8787 (api)
```

## 7. Deploy (5 minutes)

```bash
# Deploy everything at once
pnpm deploy:prod

# Or deploy separately:
pnpm deploy:api:prod    # Deploy API
pnpm deploy:web:prod    # Deploy web

# Verify deployments
pnpm wrangler deployments list --name onlooker-api
```

## 8. Verify (5 minutes)

```bash
# Test API
curl https://api.onlooker.example.com/

# Test CORS
curl -i -X OPTIONS https://api.onlooker.example.com/auth/login \
  -H 'Origin: https://onlooker.example.com' \
  -H 'Access-Control-Request-Method: POST'

# View logs
pnpm tail:api

# Open in browser
# https://onlooker.example.com
```

## Total Time: ~25 minutes

## Key Commands Reference

### Deployment
```bash
pnpm deploy:prod              # Deploy everything to production
pnpm deploy:staging           # Deploy everything to staging
pnpm deploy:api:prod          # Deploy API only
pnpm deploy:web:prod          # Deploy web only
```

### Monitoring
```bash
pnpm tail:api                 # View logs
pnpm tail:api:staging         # View staging logs
```

### Database
```bash
pnpm wrangler d1 list                                    # List all databases
pnpm wrangler d1 execute onlooker-db --remote "SELECT 1" # Test connection
pnpm db:backup                                            # Backup database
```

### Secrets
```bash
pnpm wrangler secret list --env production               # List secret names
pnpm wrangler secret put JWT_SECRET --env production     # Set secret
pnpm wrangler secret delete JWT_SECRET --env production  # Delete secret
```

### Rollback
```bash
pnpm wrangler deployments list --name onlooker-api
pnpm wrangler deployments rollback --id <deployment-id>
```

## Essential Files

| File | Purpose |
|------|---------|
| `apps/api/wrangler.toml` | API configuration |
| `apps/web/wrangler.toml` | Web app configuration |
| `.github/workflows/deploy.yml` | GitHub Actions CI/CD |
| `DEPLOYMENT.md` | Detailed guide |
| `DEPLOYMENT_CHECKLIST.md` | Pre/post verification |

## Environment Mapping

| Env | Web URL | API URL | Database |
|-----|---------|---------|----------|
| Dev | http://localhost:5173 | http://localhost:8787 | Local (auto) |
| Staging | https://staging.onlooker.example.com | https://api-staging.onlooker.example.com | onlooker-db-staging |
| Prod | https://onlooker.example.com | https://api.onlooker.example.com | onlooker-db |

## Troubleshooting Quick Fixes

### Database not found
```bash
pnpm wrangler d1 list
# Check database ID in wrangler.toml
```

### CORS errors
```bash
# Check CORS_ORIGIN in wrangler.toml matches your domain
grep "CORS_ORIGIN" apps/api/wrangler.toml
```

### Build fails
```bash
# Run local build to see errors
pnpm --filter @onlooker/api build
pnpm --filter @onlooker/web build
```

### Secrets not available
```bash
# Verify secret was set
pnpm wrangler secret list --env production

# If missing, set it
pnpm wrangler secret put JWT_SECRET --env production
```

### API not responding
```bash
# Check logs
pnpm tail:api

# Test deployment
curl https://api.onlooker.example.com/ -v
```

## Next: GitHub Actions Setup (Optional)

1. Generate Cloudflare API token:
   - Dashboard → Profile → API Tokens → Create Token
   - Copy: "Edit Cloudflare Workers" template

2. Add to GitHub repository secrets:
   - Settings → Secrets → New repository secret
   - Name: `CLOUDFLARE_API_TOKEN`
   - Value: [paste token]
   - Name: `CLOUDFLARE_ACCOUNT_ID`
   - Value: [from wrangler whoami]

3. Now pushes to `main` auto-deploy to production!

## Success Checklist

- [ ] API responds at https://api.onlooker.example.com/
- [ ] Web loads at https://onlooker.example.com
- [ ] Can login (no CORS errors)
- [ ] User data saved to database
- [ ] Logs visible with `pnpm tail:api`
- [ ] GitHub Actions runs on push (optional)

## For More Details

- Read: [DEPLOYMENT.md](./DEPLOYMENT.md)
- Reference: [DEPLOYMENT_CHECKLIST.md](./DEPLOYMENT_CHECKLIST.md)
- Config: [CLOUDFLARE_SETUP.md](./CLOUDFLARE_SETUP.md)
- Vars: [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md)

---

**Estimated total time from zero to deployed: 30-45 minutes**

Good luck! 🚀
