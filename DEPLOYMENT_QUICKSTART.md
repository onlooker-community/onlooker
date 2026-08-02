# Onlooker Deployment Quick Start

This guide walks you through deploying Onlooker to Cloudflare step-by-step.

## Prerequisites

- Cloudflare account (free tier or higher)
- Domain registered with Cloudflare
- `pnpm` installed (`pnpm --version`)
- Node.js 20+ (`node --version`)

## Step 1: Authenticate with Cloudflare

```bash
pnpm wrangler login
```

This opens your browser to authorize the CLI. After login, verify:

```bash
pnpm wrangler whoami
```

You should see your Cloudflare account email.

## Step 2: Create D1 Databases

### Production Database

```bash
pnpm wrangler d1 create onlooker-db
```

**Save the DATABASE-ID** from the output. You'll need it next.

### Staging Database (Optional)

```bash
pnpm wrangler d1 create onlooker-db-staging
```

## Step 3: Update Configuration

### Update `apps/api/wrangler.toml`

Replace the database IDs in the production and staging sections:

```toml
[env.production.d1_databases]
binding = "DB"
database_name = "onlooker-db"
database_id = "YOUR-PRODUCTION-ID"  # <- Replace with output from Step 2

[env.staging.d1_databases]
binding = "DB"
database_name = "onlooker-db-staging"
database_id = "YOUR-STAGING-ID"  # <- Replace with staging ID
```

### Update `apps/api/wrangler.toml` Routes

Replace `example.com` with your actual domain:

```toml
[env.production]
routes = [
  { pattern = "api.yourdomain.com/*", zone_name = "yourdomain.com" }
]

[env.staging]
routes = [
  { pattern = "api-staging.yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

### Update `apps/web/wrangler.toml` Routes

Replace with your domain:

```toml
[env.production]
route = "yourdomain.com/*"
zone_name = "yourdomain.com"
vars = { VITE_API_URL = "https://api.yourdomain.com" }
```

## Step 4: Run Database Migrations

The migrations already exist in `apps/api/migrations/`. Apply them:

### Production

```bash
pnpm wrangler d1 execute onlooker-db --remote --file apps/api/migrations/0001_init.sql
pnpm wrangler d1 execute onlooker-db --remote --file apps/api/migrations/0002_audit_logs.sql
```

### Staging

```bash
pnpm wrangler d1 execute onlooker-db-staging --remote --file apps/api/migrations/0001_init.sql
pnpm wrangler d1 execute onlooker-db-staging --remote --file apps/api/migrations/0002_audit_logs.sql
```

Verify migrations ran:

```bash
pnpm wrangler d1 execute onlooker-db --remote ".schema"
```

## Step 5: Set Up Secrets

Generate a JWT secret and add it to your environment:

```bash
# Generate a random JWT secret
RANDOM_SECRET=$(openssl rand -hex 32)
echo "JWT Secret: $RANDOM_SECRET"

# Set it in production
pnpm wrangler secret put JWT_SECRET --env production <<< "$RANDOM_SECRET"

# Set it in staging (can be the same or different)
pnpm wrangler secret put JWT_SECRET --env staging <<< "$RANDOM_SECRET"

# Verify
pnpm wrangler secret list --env production
```

## Step 6: Build Applications

```bash
# Build everything
pnpm build

# Or build individually:
pnpm --filter @onlooker/api build
pnpm --filter @onlooker/web build
```

If the build succeeds, you're ready to deploy!

## Step 7: Deploy to Staging (Recommended First)

Test deployment to staging first:

### Deploy API to Staging

```bash
pnpm deploy:api:staging
```

Wait for the deployment to complete. Verify:

```bash
curl https://api-staging.yourdomain.com/
```

You should see JSON with the API version and endpoints.

### Deploy Web to Staging

```bash
pnpm deploy:web:staging
```

Verify:

```bash
open https://staging.yourdomain.com
```

Test the app in your browser:
- Try to sign up
- Try to login
- Check browser console for errors

## Step 8: Deploy to Production

Once staging is verified and working:

### Deploy API to Production

```bash
pnpm deploy:api:prod
```

Verify:

```bash
curl https://api.yourdomain.com/
```

### Deploy Web to Production

```bash
pnpm deploy:web:prod
```

Verify:

```bash
open https://yourdomain.com
```

Test in production:
- Complete sign up / login flow
- Check all pages load
- Verify API calls succeed

## Step 9: Monitor Logs

Watch for errors in real-time:

```bash
# API logs
pnpm wrangler tail --name onlooker-api

# Web logs
pnpm wrangler tail --name onlooker-web
```

## Troubleshooting

### "You are not authenticated"

Run: `pnpm wrangler login`

### "Database not found"

- Verify database ID in `wrangler.toml` matches the one created in Step 2
- Run: `pnpm wrangler d1 list` to see all databases

### "CORS errors in browser"

- Verify `CORS_ORIGIN` in `apps/api/wrangler.toml` matches your domain
- For staging: `https://staging.yourdomain.com`
- For production: `https://yourdomain.com`

### "Build fails"

- Run: `pnpm typecheck` to find TypeScript errors
- Run: `pnpm lint` to check for linting issues
- Check that all environment variables are set

### "API 404 on deploy"

- Verify routes are correct in `wrangler.toml`
- Verify domain is added to Cloudflare
- Check that nameservers point to Cloudflare

## Next Steps

After successful deployment:

1. **Enable HTTPS** - Cloudflare does this automatically
2. **Configure caching** - Update cache rules in Cloudflare dashboard
3. **Set up monitoring** - Use Wrangler tail for logs
4. **Monitor analytics** - Check Cloudflare Analytics dashboard
5. **Set up CI/CD** - See [GitHub Actions deployment](./.github/workflows/deploy.yml)

## Quick Reference

```bash
# Check deployment status
pnpm wrangler deployments list --name onlooker-api

# Rollback a deployment
pnpm wrangler deployments rollback --name onlooker-api

# List all KV namespaces
pnpm wrangler kv:namespace list

# Test API locally before deploying
pnpm --filter @onlooker/api dev

# Stream logs from workers
pnpm wrangler tail --env production
```

---

**Questions?** See the full deployment guide: [DEPLOYMENT.md](./DEPLOYMENT.md)
