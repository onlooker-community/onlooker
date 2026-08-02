# Cloudflare Deployment Guide

This guide covers deploying the Onlooker platform to Cloudflare using Pages (web) and Workers (API) with D1 database.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         User Browser                               │
└────────────────────┬────────────────────────────────────────────────┘
                     │
         HTTPS       │
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│           Cloudflare Pages (Web App)                               │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ Vite + React + TypeScript                                   │  │
│  │ - Static assets cached at edge                              │  │
│  │ - Routing via React Router                                  │  │
│  │ Makes API calls to Workers                                  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│  Domain: onlooker.example.com                                     │
└────────────┬────────────────────────────────────────────────────────┘
             │
    HTTPS    │ Calls
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│         Cloudflare Workers (API)                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ TypeScript Service Worker                                   │  │
│  │ - Authentication (login/signup/refresh)                     │  │
│  │ - Account Management (profile/password)                     │  │
│  │ - Protected Resources (dashboard data)                      │  │
│  │ - CORS handling for Pages requests                          │  │
│  │ - JWT validation & session management                       │  │
│  └──────────────┬──────────────────────────────────────────────┘  │
│  Domain: api.onlooker.example.com                                 │
└──────────────┼──────────────────────────────────────────────────────┘
               │
    SQL        │
               ▼
       ┌───────────────────┐
       │ Cloudflare D1     │
       │ SQLite Database   │
       │ - Users           │
       │ - Sessions        │
       │ - Tokens          │
       │ - Audit Logs      │
       └───────────────────┘

Optional: Cloudflare KV for
           - Token cache/revocation
           - Rate limiting counters
           - Session tokens
```

## Prerequisites

Before deploying to Cloudflare:

1. **Cloudflare Account**
   - Free tier or higher
   - Domain registered or pointed to Cloudflare nameservers
   - Nameserver setup: https://dash.cloudflare.com/

2. **Installed Tools**
   ```bash
   # Verify Node.js version (20+)
   node --version
   
   # Verify pnpm is installed
   pnpm --version
   
   # Wrangler CLI (already in devDependencies)
   pnpm --version
   ```

3. **Cloudflare CLI Authentication**
   ```bash
   pnpm wrangler login
   ```
   This opens your browser to authorize the CLI with your Cloudflare account.

4. **Environment Setup**
   - Domain(s) configured in Cloudflare
   - Nameservers pointing to Cloudflare (if not already)

## Step-by-Step Deployment

### Phase 1: Local Development Setup

#### 1.1 Install Dependencies

```bash
cd /path/to/onlooker
pnpm install
```

#### 1.2 Verify Local Development Works

```bash
# Terminal 1: Start the API
pnpm --filter @onlooker/api dev

# Terminal 2: Start the Web app
pnpm --filter @onlooker/web dev
```

- Web app: http://localhost:5173
- API: http://localhost:8787

#### 1.3 Verify API Routes

Test the API root endpoint:

```bash
curl http://localhost:8787/
```

You should see:

```json
{
  "service": "Onlooker API",
  "version": "0.0.1",
  "endpoints": [
    { "method": "POST", "path": "/auth/login" },
    { "method": "POST", "path": "/auth/signup" },
    ...
  ]
}
```

---

### Phase 2: Create Cloudflare D1 Database

#### 2.1 Create Production Database

```bash
# Create the production D1 database
pnpm wrangler d1 create onlooker-db

# This returns output like:
# ✓ Created database onlooker-db with ID: <DATABASE-ID>
# Database ID: <DATABASE-ID>
```

**Save the DATABASE-ID** — you'll need it for configuration.

#### 2.2 Create Staging Database (Optional)

```bash
pnpm wrangler d1 create onlooker-db-staging
```

#### 2.3 Update wrangler.toml with Database IDs

Edit `apps/api/wrangler.toml` and replace the placeholder database IDs:

```toml
[env.production.d1_databases]
binding = "DB"
database_name = "onlooker-db"
database_id = "YOUR-PRODUCTION-DATABASE-ID"  # Replace this

[env.staging.d1_databases]
binding = "DB"
database_name = "onlooker-db-staging"
database_id = "YOUR-STAGING-DATABASE-ID"  # Replace this
```

#### 2.4 Run Database Migrations

Create migration files in `apps/api/migrations/`:

```bash
# Create migrations directory
mkdir -p apps/api/migrations

# Migration files will be named with timestamps, e.g., 0001_init.sql
```

Example migration file `apps/api/migrations/0001_init.sql`:

```sql
-- Create users table
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email_verified BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create sessions table
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create indexes
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
```

Apply migrations:

```bash
# Development (local)
pnpm wrangler d1 execute onlooker-db --local < apps/api/migrations/0001_init.sql

# Staging
pnpm wrangler d1 execute onlooker-db-staging --remote < apps/api/migrations/0001_init.sql

# Production
pnpm wrangler d1 execute onlooker-db --remote < apps/api/migrations/0001_init.sql
```

---

### Phase 3: Configure Secrets

Secrets are environment variables that should not be committed to git (like JWT keys).

#### 3.1 Set Production Secrets

```bash
# Set JWT secret for production
pnpm wrangler secret put JWT_SECRET --env production

# You'll be prompted to enter the value
# Paste a secure random string (e.g., from: openssl rand -hex 32)

# Set other secrets as needed
pnpm wrangler secret put DATABASE_PASSWORD --env production
pnpm wrangler secret put OAUTH_CLIENT_SECRET --env production
```

#### 3.2 Set Staging Secrets

```bash
pnpm wrangler secret put JWT_SECRET --env staging
pnpm wrangler secret put DATABASE_PASSWORD --env staging
```

#### 3.3 List Configured Secrets

```bash
# View secret names (values are hidden)
pnpm wrangler secret list --env production
pnpm wrangler secret list --env staging
```

---

### Phase 4: Configure KV Namespace (Optional)

For token caching and rate limiting:

#### 4.1 Create KV Namespaces

```bash
# Production
pnpm wrangler kv:namespace create "TOKEN_CACHE" --env production

# Staging
pnpm wrangler kv:namespace create "TOKEN_CACHE" --env staging
```

#### 4.2 Update wrangler.toml

The output will show you the namespace IDs. Update `apps/api/wrangler.toml`:

```toml
[[env.production.kv_namespaces]]
binding = "TOKEN_CACHE"
id = "YOUR-KV-NAMESPACE-ID"
preview_id = "YOUR-KV-PREVIEW-ID"
```

---

### Phase 5: Deploy API to Cloudflare Workers

#### 5.1 Build the API

```bash
pnpm --filter @onlooker/api build
```

Verify no TypeScript errors occur.

#### 5.2 Deploy to Staging

```bash
pnpm --filter @onlooker/api deploy --env staging
```

Expected output:
```
✓ Uploaded worker to Cloudflare
✓ Deployed worker onlooker-api (staging)
```

#### 5.3 Test Staging API

Get the staging URL from the Cloudflare dashboard or:

```bash
pnpm wrangler deployments list --name onlooker-api --env staging
```

Test the endpoint:

```bash
curl https://api-staging.onlooker.example.com/
```

#### 5.4 Deploy to Production

```bash
pnpm --filter @onlooker/api deploy --env production
```

Test the production endpoint:

```bash
curl https://api.onlooker.example.com/
```

---

### Phase 6: Deploy Web App to Cloudflare Pages

#### 6.1 Build the Web App

```bash
pnpm --filter @onlooker/web build
```

Verify the build output is in `apps/web/dist/`.

#### 6.2 Deploy via Wrangler

```bash
# For production deployment
pnpm --filter @onlooker/web deploy --env production
```

#### 6.3 Automatic Deployment via GitHub

See the [GitHub Actions](#github-actions-cicd) section for automatic deployments on push.

#### 6.4 Verify Web Deployment

Visit: https://onlooker.example.com

You should see the React app loading with:
- Correct VITE_API_URL pointing to your API
- No CORS errors in console
- All assets loading correctly

---

### Phase 7: Configure Custom Domain

#### 7.1 Set Pages Custom Domain

1. Go to Cloudflare Dashboard → Pages → onlooker-web
2. Settings → Custom Domains
3. Add your custom domain (e.g., onlooker.example.com)
4. Cloudflare will automatically provision an SSL certificate

#### 7.2 Set Workers Custom Domain

1. Go to Cloudflare Dashboard → Workers → Triggers
2. Add custom domain (e.g., api.onlooker.example.com)
3. Point to your Cloudflare zone

---

### Phase 8: Environment Variables

#### 8.1 Update VITE_API_URL for Production

The Pages deployment must know the API URL. Update `apps/web/wrangler.toml`:

```toml
[env.production.vars]
VITE_API_URL = "https://api.onlooker.example.com"
```

#### 8.2 Verify Environment Variable Access

In `apps/web/src/api.ts` (or similar):

```typescript
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';
```

---

### Phase 9: CORS Configuration

#### 9.1 Update CORS Origin in API

Edit `apps/api/wrangler.toml`:

```toml
[env.production.vars]
CORS_ORIGIN = "https://onlooker.example.com"
```

#### 9.2 Update CORS Logic in API

In `apps/api/src/index.ts`:

```typescript
const ALLOWED_ORIGINS = [
  import.meta.env.CORS_ORIGIN,
  'http://localhost:5173',  // Development
];

// In handleRequest():
const origin = request.headers.get('origin') || '';
if (ALLOWED_ORIGINS.includes(origin)) {
  response.headers.set('Access-Control-Allow-Origin', origin);
}
```

---

### Phase 10: Monitoring & Logs

#### 10.1 View Real-Time Logs

**For API (Workers):**

```bash
# Real-time tail for development
pnpm wrangler tail --env development

# For production
pnpm wrangler tail --env production

# With filters
pnpm wrangler tail --env production --status ok --format pretty
```

**For Web (Pages):**

1. Cloudflare Dashboard → Pages → onlooker-web → Deployments
2. Click on a deployment to see build and runtime logs

#### 10.2 Structured Logging

Add to `apps/api/src/middleware/logger.ts`:

```typescript
export function log(level: 'info' | 'error' | 'warn', message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const entry = JSON.stringify({ timestamp, level, message, ...data });
  console.log(entry);
}
```

Use in handlers:

```typescript
log('info', 'Login attempt', { email, ip: request.headers.get('cf-connecting-ip') });
```

Logs are available in:
- Cloudflare Dashboard → Analytics
- Wrangler CLI: `pnpm wrangler tail`
- Third-party tools: Axiom, Datadog, New Relic, etc.

#### 10.3 Setup Error Tracking

Optional: Integrate with Sentry for error tracking:

1. Create a Sentry project
2. Set environment variable in wrangler.toml: `SENTRY_DSN`
3. Initialize Sentry in `apps/api/src/index.ts`:

```typescript
import * as Sentry from "@sentry/cloudflare-workers";

Sentry.init({ dsn: env.SENTRY_DSN });
```

---

## Verification Checklist

After deployment, verify:

- [ ] Web app loads at https://onlooker.example.com
- [ ] API responds at https://api.onlooker.example.com/
- [ ] Login endpoint: `POST /auth/login` works
- [ ] Signup endpoint: `POST /auth/signup` works
- [ ] Refresh endpoint: `POST /auth/refresh` works
- [ ] D1 database queries return data
- [ ] CORS headers present on API responses
- [ ] No errors in browser console
- [ ] No errors in `pnpm wrangler tail`
- [ ] SSL certificate is valid
- [ ] Page assets load from edge (check CF-Cache-Status header)

### Test Commands

```bash
# Test API health
curl https://api.onlooker.example.com/ -i

# Test CORS preflight
curl -i -X OPTIONS https://api.onlooker.example.com/auth/login \
  -H 'Origin: https://onlooker.example.com' \
  -H 'Access-Control-Request-Method: POST'

# Test login (with test user)
curl -X POST https://api.onlooker.example.com/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"test123"}'

# Test database connection
pnpm wrangler d1 execute onlooker-db --remote "SELECT COUNT(*) FROM users"
```

---

## Environment Variables Reference

### Development (.env.local)

```env
VITE_API_URL=http://localhost:8787
```

### Staging (wrangler.toml)

```toml
[env.staging.vars]
VITE_API_URL = "https://api-staging.onlooker.example.com"
CORS_ORIGIN = "https://staging.onlooker.example.com"
JWT_SECRET = "secrets list"  # Managed via wrangler secret
```

### Production (wrangler.toml)

```toml
[env.production.vars]
VITE_API_URL = "https://api.onlooker.example.com"
CORS_ORIGIN = "https://onlooker.example.com"
JWT_SECRET = "secrets list"  # Managed via wrangler secret
```

---

## Rollback Procedures

### Quick Rollback (Previous Deployment)

```bash
# View deployment history
pnpm wrangler deployments list --name onlooker-api

# Rollback to previous version
pnpm wrangler deployments rollback --id <deployment-id>
```

### Database Rollback

For D1 database, maintain backup snapshots:

```bash
# Export current database state
pnpm wrangler d1 export onlooker-db > backup_$(date +%s).sql

# Restore from backup
pnpm wrangler d1 execute onlooker-db --remote < backup.sql
```

### Pages Rollback

1. Cloudflare Dashboard → Pages → onlooker-web
2. Deployments tab → Click deployment to rollback to
3. Click "Rollback to this deployment"

---

## Troubleshooting

### "Database binding not found"

**Problem:** `Error: Binding "DB" not found`

**Solution:**
1. Verify database ID in `wrangler.toml` is correct
2. Ensure database exists: `pnpm wrangler d1 list`
3. Re-check environment flag: `--env production`

### CORS Errors in Browser

**Problem:** `Access-Control-Allow-Origin` header missing

**Solution:**
1. Check CORS_ORIGIN in wrangler.toml matches your domain
2. Verify API code sets headers correctly
3. Test preflight: `curl -i -X OPTIONS` (see test commands above)

### API Not Responding

**Problem:** Timeout or 502 errors

**Solution:**
1. Check logs: `pnpm wrangler tail --env production`
2. Verify API is deployed: `pnpm wrangler deployments list --name onlooker-api`
3. Check D1 database connection: `pnpm wrangler d1 execute onlooker-db --remote "SELECT 1"`

### Pages Build Fails

**Problem:** `Build failed: Command exited with code 1`

**Solution:**
1. Check build logs in Cloudflare Dashboard
2. Verify build command in `wrangler.toml`: `pnpm build`
3. Run locally: `pnpm --filter @onlooker/web build`
4. Check for missing environment variables at build time

### High Latency or Slow Loads

**Optimization Tips:**
1. Enable page caching: Add Cache-Control headers
2. Use Cloudflare Cache Rules
3. Enable compression: Already done by Cloudflare
4. Optimize D1 queries: Add indexes for frequently queried columns
5. Monitor with Cloudflare Analytics

---

## Deployment Scripts

Add to root `package.json` for easier deployments:

```json
{
  "scripts": {
    "deploy": "pnpm deploy:api && pnpm deploy:web",
    "deploy:staging": "pnpm deploy:api:staging && pnpm deploy:web:staging",
    "deploy:prod": "pnpm deploy:api:prod && pnpm deploy:web:prod",
    "deploy:api": "pnpm --filter @onlooker/api deploy --env development",
    "deploy:api:staging": "pnpm --filter @onlooker/api deploy --env staging",
    "deploy:api:prod": "pnpm --filter @onlooker/api deploy --env production",
    "deploy:web": "pnpm --filter @onlooker/web deploy",
    "tail:api": "pnpm wrangler tail --env production",
    "tail:staging": "pnpm wrangler tail --env staging",
    "db:backup": "pnpm wrangler d1 export onlooker-db > backup_$(date +%s).sql",
    "db:migrate": "pnpm wrangler d1 migrations apply onlooker-db --remote"
  }
}
```

Then deploy with:

```bash
pnpm deploy:prod
```

---

## GitHub Actions CI/CD

See `.github/workflows/deploy.yml` for automatic deployments on push to main.

Setup:
1. Generate Cloudflare API token
2. Add secrets to GitHub: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
3. Push to main branch
4. Deployments run automatically

---

## Additional Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Cloudflare Pages Docs](https://developers.cloudflare.com/pages/)
- [Cloudflare D1 Docs](https://developers.cloudflare.com/d1/)
- [Wrangler CLI Docs](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- [Cloudflare KV Docs](https://developers.cloudflare.com/kv/)

---

## Support

For issues or questions:
1. Check Cloudflare status page: https://www.cloudflarestatus.com/
2. Review logs: `pnpm wrangler tail`
3. Check GitHub issues: https://github.com/onlooker-community/onlooker/issues
4. Community Discord: [invite link]
