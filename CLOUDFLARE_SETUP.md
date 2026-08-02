# Cloudflare Setup Guide

Complete reference for configuring Cloudflare infrastructure for the Onlooker platform.

## Table of Contents

1. [Initial Setup](#initial-setup)
2. [D1 Database Configuration](#d1-database-configuration)
3. [Workers Configuration](#workers-configuration)
4. [Pages Configuration](#pages-configuration)
5. [KV Namespace Configuration](#kv-namespace-configuration)
6. [Environment Variables](#environment-variables)
7. [Secrets Management](#secrets-management)

---

## Initial Setup

### 1. Create Cloudflare Account

1. Go to https://dash.cloudflare.com/
2. Sign up or log in
3. Add your domain or use a subdomain

### 2. Install and Authenticate Wrangler

```bash
# Already installed in devDependencies
# Verify installation
pnpm wrangler --version

# Login to Cloudflare
pnpm wrangler login

# This opens a browser to authorize the CLI
```

### 3. Verify Account Setup

```bash
# List your Cloudflare accounts
pnpm wrangler whoami

# Output should show:
# account_id: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# email: user@example.com
```

---

## D1 Database Configuration

D1 is Cloudflare's SQLite database service. It's where all application data lives.

### Create Databases

#### Production Database

```bash
# Create production database
pnpm wrangler d1 create onlooker-db

# Output:
# ✓ Created database onlooker-db with ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**Copy the database ID** — you'll need it.

#### Staging Database (Optional)

```bash
pnpm wrangler d1 create onlooker-db-staging

# Copy this ID too
```

#### Development Database (Local)

For local development, D1 provides a local SQLite instance:

```bash
# No explicit creation needed; Wrangler creates it automatically
# Just run migrations with the --local flag
```

### Configure wrangler.toml

Update `apps/api/wrangler.toml` with your actual database IDs:

```toml
# Production
[env.production.d1_databases]
binding = "DB"
database_name = "onlooker-db"
database_id = "YOUR-PRODUCTION-ID-HERE"

# Staging
[env.staging.d1_databases]
binding = "DB"
database_name = "onlooker-db-staging"
database_id = "YOUR-STAGING-ID-HERE"
```

### Create Migration Files

Create `apps/api/migrations/` directory:

```bash
mkdir -p apps/api/migrations
```

Create migration files with timestamps:

#### `0001_init.sql` — Initial Schema

```sql
-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email_verified BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table (for authentication)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  refresh_token TEXT NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  refresh_expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Verification tokens (for email verification)
CREATE TABLE IF NOT EXISTS verification_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,  -- 'email_verification' or 'password_reset'
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_verification_tokens_user_id ON verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_verification_tokens_token ON verification_tokens(token);
```

#### `0002_audit_logs.sql` — Audit Logging

```sql
-- Audit logs table (for tracking user actions)
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata TEXT,  -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
```

### Run Migrations

#### Local Development

```bash
# Run migrations locally (creates SQLite DB at .wrangler/state/d1/)
pnpm wrangler d1 execute onlooker-db --local < apps/api/migrations/0001_init.sql
pnpm wrangler d1 execute onlooker-db --local < apps/api/migrations/0002_audit_logs.sql

# Verify tables were created
pnpm wrangler d1 execute onlooker-db --local ".schema"
```

#### Staging

```bash
# Apply to staging database
pnpm wrangler d1 execute onlooker-db-staging --remote < apps/api/migrations/0001_init.sql
pnpm wrangler d1 execute onlooker-db-staging --remote < apps/api/migrations/0002_audit_logs.sql

# Verify
pnpm wrangler d1 execute onlooker-db-staging --remote ".schema"
```

#### Production

```bash
# Apply to production database (CAREFUL!)
pnpm wrangler d1 execute onlooker-db --remote < apps/api/migrations/0001_init.sql
pnpm wrangler d1 execute onlooker-db --remote < apps/api/migrations/0002_audit_logs.sql

# Verify
pnpm wrangler d1 execute onlooker-db --remote ".schema"
```

### Test Database Connection

```bash
# From API code, use the binding:
// In handlers: const db = env.DB
// In middleware: await env.DB.prepare("SELECT COUNT(*) FROM users").first()

# From CLI:
pnpm wrangler d1 execute onlooker-db --local "SELECT 1 as test"
pnpm wrangler d1 execute onlooker-db --remote "SELECT 1 as test"
```

---

## Workers Configuration

### Main Configuration File

**Location:** `apps/api/wrangler.toml`

Key sections:

```toml
# Service name and entry point
name = "onlooker-api"
main = "src/index.ts"
compatibility_date = "2024-12-16"
compatibility_flags = ["nodejs_compat"]

# Routes: Where the worker is deployed
routes = [
  { pattern = "api.onlooker.example.com/*", zone_name = "example.com" }
]

# Environment-specific configurations
[env.production]
[env.staging]
[env.development]
```

### Environment Configuration

#### Development (Local)

```toml
[env.development.vars]
ENVIRONMENT = "development"
CORS_ORIGIN = "http://localhost:5173"
JWT_EXPIRY = "3600"
```

```bash
# Run locally
pnpm wrangler dev --env development
```

#### Staging

```toml
[env.staging.vars]
ENVIRONMENT = "staging"
CORS_ORIGIN = "https://staging.onlooker.example.com"
JWT_EXPIRY = "3600"

[[env.staging.d1_databases]]
binding = "DB"
database_name = "onlooker-db-staging"
database_id = "YOUR-STAGING-DATABASE-ID"
```

```bash
# Deploy to staging
pnpm --filter @onlooker/api deploy --env staging
```

#### Production

```toml
[env.production.vars]
ENVIRONMENT = "production"
CORS_ORIGIN = "https://onlooker.example.com"
JWT_EXPIRY = "3600"

[[env.production.d1_databases]]
binding = "DB"
database_name = "onlooker-db"
database_id = "YOUR-PRODUCTION-DATABASE-ID"
```

```bash
# Deploy to production
pnpm --filter @onlooker/api deploy --env production
```

### Binding Configuration

Bindings connect your Worker to Cloudflare resources:

```toml
# D1 Database Binding
[[env.production.d1_databases]]
binding = "DB"
database_name = "onlooker-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

# KV Namespace Binding (see next section)
[[env.production.kv_namespaces]]
binding = "TOKEN_CACHE"
id = "xxxxxxxx"
preview_id = "yyyyyyyy"
```

### Access Bindings in Code

```typescript
// In your handlers, access via env parameter
interface WorkerEnv {
  DB: D1Database;
  TOKEN_CACHE: KVNamespace;
  JWT_SECRET: string;
}

// In handler:
async function handleLogin(request: Request, env: WorkerEnv) {
  const db = env.DB;
  const user = await db.prepare(
    "SELECT * FROM users WHERE email = ?"
  ).bind(email).first();
}
```

---

## Pages Configuration

### Configuration File

**Location:** `apps/web/wrangler.toml`

```toml
name = "onlooker-web"
type = "javascript"
compatibility_date = "2024-12-16"

# Build configuration
[build]
command = "pnpm build"
cwd = "."
output_dir = "dist"

# Environment-specific variables
[env.development.vars]
VITE_API_URL = "http://localhost:8787"

[env.staging.vars]
VITE_API_URL = "https://api-staging.onlooker.example.com"

[env.production.vars]
VITE_API_URL = "https://api.onlooker.example.com"
```

### Access Environment Variables

In your Vite app:

```typescript
// src/api/client.ts
const API_URL = import.meta.env.VITE_API_URL;

export async function loginUser(email: string, password: string) {
  const response = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return response.json();
}
```

### Build and Deployment

```bash
# Development
pnpm --filter @onlooker/web build

# Staging
VITE_API_URL=https://api-staging.onlooker.example.com pnpm --filter @onlooker/web build

# Production
VITE_API_URL=https://api.onlooker.example.com pnpm --filter @onlooker/web build
```

### Deploy via Wrangler

```bash
# Deploy to production
pnpm --filter @onlooker/web deploy --env production

# Deploy to staging
pnpm --filter @onlooker/web deploy --env staging
```

### Manual Deployment via Dashboard

1. Go to https://dash.cloudflare.com/
2. Pages section
3. Connect to GitHub repository
4. Set build command: `pnpm build`
5. Set build output: `dist`
6. Set environment variables in build settings

---

## KV Namespace Configuration

KV (Key-Value) storage is useful for caching and temporary data.

### Create KV Namespaces

```bash
# Production
pnpm wrangler kv:namespace create "TOKEN_CACHE" --env production

# Returns:
# ✓ Successfully created kv namespace with id: xxxxxxxx
# 
# Add this to your wrangler.toml:
# [[env.production.kv_namespaces]]
# binding = "TOKEN_CACHE"
# id = "xxxxxxxx"
# preview_id = "yyyyyyyy"

# Staging
pnpm wrangler kv:namespace create "TOKEN_CACHE" --env staging
```

### Configure in wrangler.toml

```toml
# Production
[[env.production.kv_namespaces]]
binding = "TOKEN_CACHE"
id = "YOUR-KV-NAMESPACE-ID"
preview_id = "YOUR-KV-PREVIEW-ID"

# Staging
[[env.staging.kv_namespaces]]
binding = "TOKEN_CACHE"
id = "YOUR-STAGING-KV-ID"
preview_id = "YOUR-STAGING-KV-PREVIEW-ID"
```

### Use KV in Code

```typescript
// Cache a token
async function cacheToken(token: string, ttl: number, env: WorkerEnv) {
  await env.TOKEN_CACHE.put(token, 'true', { expirationTtl: ttl });
}

// Check if token is revoked
async function isTokenRevoked(token: string, env: WorkerEnv) {
  return await env.TOKEN_CACHE.get(token) === null;
}
```

---

## Environment Variables

### Types of Variables

1. **Build-time variables** (Pages/Vite only)
   - Prefixed with `VITE_`
   - Baked into the build
   - Available at runtime in JS

2. **Runtime variables** (Workers)
   - Defined in `wrangler.toml` under `[env.*.vars]`
   - Accessed via `env` parameter
   - Can be changed without rebuilding

3. **Secrets** (Both Pages and Workers)
   - Managed via CLI or dashboard
   - Never committed to git
   - Accessed via `env` parameter (Workers) or `env.secrets.get()` (Pages)

### Variable Checklist

#### Web App (Vite)

```toml
# apps/web/wrangler.toml

[env.development.vars]
VITE_API_URL = "http://localhost:8787"

[env.staging.vars]
VITE_API_URL = "https://api-staging.onlooker.example.com"

[env.production.vars]
VITE_API_URL = "https://api.onlooker.example.com"
```

#### API (Workers)

```toml
# apps/api/wrangler.toml

[env.production.vars]
ENVIRONMENT = "production"
CORS_ORIGIN = "https://onlooker.example.com"
JWT_EXPIRY = "3600"
TOKEN_EXPIRY_MINUTES = "180"
REFRESH_TOKEN_EXPIRY_DAYS = "30"
```

---

## Secrets Management

### Set Secrets via CLI

```bash
# Production
pnpm wrangler secret put JWT_SECRET --env production
# Enter your secret value when prompted

# Staging
pnpm wrangler secret put JWT_SECRET --env staging

# List secrets (names only, values hidden)
pnpm wrangler secret list --env production
```

### Common Secrets

| Secret | Purpose | Example |
|--------|---------|---------|
| `JWT_SECRET` | Sign and verify JWT tokens | `openssl rand -hex 32` |
| `DATABASE_PASSWORD` | Database connection password | Complex password |
| `OAUTH_CLIENT_SECRET` | OAuth provider secret | From provider dashboard |
| `ENCRYPTION_KEY` | Data encryption | `openssl rand -hex 32` |

### Generate Secure Random Secrets

```bash
# 32 bytes (256 bits) hex string
openssl rand -hex 32

# Base64 version
openssl rand -base64 32

# Use in wrangler:
pnpm wrangler secret put JWT_SECRET --env production
# Paste the generated value
```

### Access Secrets in Code

```typescript
// Workers code
interface WorkerEnv {
  JWT_SECRET: string;
  DATABASE_PASSWORD: string;
}

async function handleLogin(request: Request, env: WorkerEnv) {
  const secret = env.JWT_SECRET;
  // Use secret to sign JWT
}
```

### Rotate Secrets

```bash
# Create new secret
pnpm wrangler secret put JWT_SECRET --env production

# Old and new secrets coexist during rotation period
# Update code to accept both old and new
# Delete old secret when safe
pnpm wrangler secret delete JWT_SECRET_OLD --env production
```

---

## Verification Checklist

After setup, verify everything works:

### D1 Database

- [ ] Created production database
- [ ] Created staging database (optional)
- [ ] Migrations applied successfully
- [ ] Can query data: `pnpm wrangler d1 execute onlooker-db --remote "SELECT COUNT(*) FROM users"`

### Workers

- [ ] `wrangler.toml` has D1 bindings with correct database IDs
- [ ] Secrets configured: `pnpm wrangler secret list --env production`
- [ ] Routes configured for your domain
- [ ] Build succeeds: `pnpm --filter @onlooker/api build`
- [ ] Deployed: `pnpm --filter @onlooker/api deploy --env production`

### Pages

- [ ] `wrangler.toml` has VITE_API_URL environment variables
- [ ] Build succeeds: `pnpm --filter @onlooker/web build`
- [ ] Deployed: `pnpm --filter @onlooker/web deploy --env production`
- [ ] Can access: https://onlooker.example.com

### Integration

- [ ] Web app loads without CORS errors
- [ ] API responds to requests
- [ ] Web app can call API endpoints
- [ ] Database queries return data

---

## Troubleshooting

### "Database not found"

```bash
# Check database exists
pnpm wrangler d1 list

# Check database ID is correct in wrangler.toml
# Re-run: pnpm wrangler d1 create onlooker-db
```

### "Binding 'DB' not found"

```bash
# Ensure wrangler.toml has [[d1_databases]] section
# Check environment flag: --env production
# Rebuild and redeploy
pnpm --filter @onlooker/api build
pnpm --filter @onlooker/api deploy --env production
```

### CORS Errors

```bash
# Check CORS_ORIGIN matches web app domain
# Verify API sets headers:
response.headers.set('Access-Control-Allow-Origin', origin);

# Test preflight request
curl -i -X OPTIONS https://api.onlooker.example.com/auth/login \
  -H 'Origin: https://onlooker.example.com' \
  -H 'Access-Control-Request-Method: POST'
```

### Build Fails

```bash
# Check build logs
pnpm --filter @onlooker/api build

# For Pages, check Cloudflare dashboard build logs
# Ensure dependencies are in package.json
pnpm install
```

---

## Next Steps

1. Follow [DEPLOYMENT.md](./DEPLOYMENT.md) for step-by-step deployment
2. Set up [GitHub Actions](.github/workflows/deploy.yml) for automatic deployments
3. Monitor with [Cloudflare Analytics](https://dash.cloudflare.com/) and [Workers Logs](https://developers.cloudflare.com/workers/observability/logging/)
