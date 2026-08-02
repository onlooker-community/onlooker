# Environment Variables & Secrets Reference

Complete reference of all environment variables used across the Onlooker platform.

## Quick Reference Table

| Variable | Service | Type | Purpose | Example |
|----------|---------|------|---------|---------|
| `VITE_API_URL` | Web | Build | API endpoint for Vite | `https://api.onlooker.example.com` |
| `JWT_SECRET` | API | Secret | JWT signing key | `openssl rand -hex 32` |
| `ENVIRONMENT` | API | Vars | Deployment environment | `production` |
| `CORS_ORIGIN` | API | Vars | Allowed origin for CORS | `https://onlooker.example.com` |
| `DB_HOST` | API | Vars | D1 database host | Cloudflare D1 (auto) |
| `TOKEN_EXPIRY_MINUTES` | API | Vars | Access token lifetime | `180` |
| `REFRESH_TOKEN_EXPIRY_DAYS` | API | Vars | Refresh token lifetime | `30` |

---

## Web App (Vite React)

### Build-Time Variables

These are baked into the build and available at runtime as `import.meta.env.VITE_*`.

#### Development

**File:** `.env.development.local`

```env
VITE_API_URL=http://localhost:8787
```

**Also in:** `apps/web/wrangler.toml`

```toml
[env.development.vars]
VITE_API_URL = "http://localhost:8787"
```

#### Staging

**File:** `apps/web/wrangler.toml`

```toml
[env.staging.vars]
VITE_API_URL = "https://api-staging.onlooker.example.com"
```

#### Production

**File:** `apps/web/wrangler.toml`

```toml
[env.production.vars]
VITE_API_URL = "https://api.onlooker.example.com"
```

### Usage in Code

```typescript
// src/api/client.ts
const API_URL = import.meta.env.VITE_API_URL;

export async function fetchUser(token: string) {
  const response = await fetch(`${API_URL}/api/users/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.json();
}
```

---

## API (Cloudflare Workers)

### Public Variables

These are environment variables that can be checked into version control.

| Variable | Description | Values |
|----------|-------------|--------|
| `ENVIRONMENT` | Deployment environment | `development`, `staging`, `production` |
| `CORS_ORIGIN` | Allowed origin for CORS | Domain of web app |
| `DB_HOST` | Database host | Auto-managed by D1 |
| `DB_NAME` | Database name | `onlooker_dev`, `onlooker_staging`, `onlooker_prod` |
| `TOKEN_EXPIRY_MINUTES` | Access token lifetime | `180` (3 hours) |
| `REFRESH_TOKEN_EXPIRY_DAYS` | Refresh token lifetime | `30` (30 days) |

#### Development

**File:** `apps/api/wrangler.toml`

```toml
[env.development.vars]
ENVIRONMENT = "development"
CORS_ORIGIN = "http://localhost:5173"
TOKEN_EXPIRY_MINUTES = "180"
REFRESH_TOKEN_EXPIRY_DAYS = "30"
```

#### Staging

**File:** `apps/api/wrangler.toml`

```toml
[env.staging.vars]
ENVIRONMENT = "staging"
CORS_ORIGIN = "https://staging.onlooker.example.com"
TOKEN_EXPIRY_MINUTES = "180"
REFRESH_TOKEN_EXPIRY_DAYS = "30"
```

#### Production

**File:** `apps/api/wrangler.toml`

```toml
[env.production.vars]
ENVIRONMENT = "production"
CORS_ORIGIN = "https://onlooker.example.com"
TOKEN_EXPIRY_MINUTES = "180"
REFRESH_TOKEN_EXPIRY_DAYS = "30"
```

### Secrets (Must not be committed)

These are sensitive values managed via `pnpm wrangler secret put`.

| Secret | Description | Generation |
|--------|-------------|-----------|
| `JWT_SECRET` | Private key for signing JWTs | `openssl rand -hex 32` |
| `DATABASE_PASSWORD` | Database connection password | Strong random password |
| `ENCRYPTION_KEY` | Data encryption key | `openssl rand -hex 32` |
| `OAUTH_CLIENT_SECRET` | OAuth provider secret | From provider dashboard |

#### Set Secrets

```bash
# Production
pnpm wrangler secret put JWT_SECRET --env production
pnpm wrangler secret put DATABASE_PASSWORD --env production
pnpm wrangler secret put ENCRYPTION_KEY --env production

# Staging
pnpm wrangler secret put JWT_SECRET --env staging
pnpm wrangler secret put DATABASE_PASSWORD --env staging
pnpm wrangler secret put ENCRYPTION_KEY --env staging

# Development (optional)
pnpm wrangler secret put JWT_SECRET --env development
```

#### List Secrets

```bash
# View configured secrets (names only, no values)
pnpm wrangler secret list --env production
pnpm wrangler secret list --env staging
```

#### Use Secrets in Code

```typescript
// src/handlers/login.ts
async function handleLogin(request: Request, env: WorkerEnv) {
  const jwtSecret = env.JWT_SECRET;
  const dbPassword = env.DATABASE_PASSWORD;
  
  // Use in your code
  const token = await signJWT({ userId: user.id }, jwtSecret);
}
```

### Access Bindings

These are automatically injected via wrangler configuration.

| Binding | Type | File |
|---------|------|------|
| `DB` | D1Database | See database config section |
| `TOKEN_CACHE` | KVNamespace | See KV config section |

#### D1 Database Binding

**File:** `apps/api/wrangler.toml`

```toml
# Production
[[env.production.d1_databases]]
binding = "DB"
database_name = "onlooker-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

# Staging
[[env.staging.d1_databases]]
binding = "DB"
database_name = "onlooker-db-staging"
database_id = "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy"
```

#### KV Namespace Binding

**File:** `apps/api/wrangler.toml`

```toml
# Production
[[env.production.kv_namespaces]]
binding = "TOKEN_CACHE"
id = "xxxxxxxx"
preview_id = "yyyyyyyy"

# Staging
[[env.staging.kv_namespaces]]
binding = "TOKEN_CACHE"
id = "zzzzzzzz"
preview_id = "wwwwwwww"
```

---

## Environment-Specific Values

### Development

```env
# Web app (.env.local)
VITE_API_URL=http://localhost:8787

# API (wrangler.toml [env.development])
ENVIRONMENT=development
CORS_ORIGIN=http://localhost:5173
TOKEN_EXPIRY_MINUTES=180
REFRESH_TOKEN_EXPIRY_DAYS=30

# Secrets (via wrangler secret put)
JWT_SECRET=<dev-key>
```

### Staging

```env
# Web app (wrangler.toml [env.staging])
VITE_API_URL=https://api-staging.onlooker.example.com

# API (wrangler.toml [env.staging])
ENVIRONMENT=staging
CORS_ORIGIN=https://staging.onlooker.example.com
TOKEN_EXPIRY_MINUTES=180
REFRESH_TOKEN_EXPIRY_DAYS=30

# Secrets (via wrangler secret put)
JWT_SECRET=<staging-key>
DATABASE_PASSWORD=<staging-password>
```

### Production

```env
# Web app (wrangler.toml [env.production])
VITE_API_URL=https://api.onlooker.example.com

# API (wrangler.toml [env.production])
ENVIRONMENT=production
CORS_ORIGIN=https://onlooker.example.com
TOKEN_EXPIRY_MINUTES=180
REFRESH_TOKEN_EXPIRY_DAYS=30

# Secrets (via wrangler secret put)
JWT_SECRET=<prod-key>
DATABASE_PASSWORD=<prod-password>
ENCRYPTION_KEY=<prod-encryption-key>
```

---

## Generating Secure Values

### JWT Secret

```bash
# Generate 32 random bytes as hex string (256 bits)
openssl rand -hex 32

# Example output:
# a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f

# Use this value with:
pnpm wrangler secret put JWT_SECRET --env production
```

### Database Password

```bash
# Generate a strong password
openssl rand -base64 32

# Example output:
# Zx4bY9kL2mN8pQ1wR5sT7uV0xA3cD6eF9gH2jI1lM4nO7qP0rS3uV6wX9yZ2aB5cD

# Use this value with:
pnpm wrangler secret put DATABASE_PASSWORD --env production
```

### Encryption Key

```bash
# Generate 32 random bytes as hex string
openssl rand -hex 32

# Use this value with:
pnpm wrangler secret put ENCRYPTION_KEY --env production
```

---

## Environment Type Reference

### Type: `Build-Time`

- Compiled into the artifact during build
- Cannot change without rebuilding
- Vite: prefixed with `VITE_`
- Example: `VITE_API_URL`

### Type: `Runtime Variables`

- Configured in `wrangler.toml` under `[env.*.vars]`
- Can change without rebuilding (via redeploy)
- Accessed via `env` parameter
- Example: `ENVIRONMENT`, `CORS_ORIGIN`

### Type: `Secrets`

- Managed via `wrangler secret put`
- Never stored in `wrangler.toml` (security!)
- Can change without rebuilding
- Accessed via `env` parameter (same as variables)
- Example: `JWT_SECRET`, `DATABASE_PASSWORD`

### Type: `Bindings`

- Cloudflare resources (D1, KV, etc.)
- Configured in `wrangler.toml` under `[[d1_databases]]`, `[[kv_namespaces]]`, etc.
- Accessed via named bindings (e.g., `env.DB`, `env.TOKEN_CACHE`)
- Example: D1 database, KV namespace

---

## Adding New Environment Variables

### Step 1: Add to wrangler.toml

```toml
[env.production.vars]
NEW_VARIABLE = "value"
```

### Step 2: Update Type Definition

**File:** `apps/api/src/types/index.ts`

```typescript
export interface WorkerEnv {
  // ... existing bindings
  NEW_VARIABLE: string;
}
```

### Step 3: Use in Code

```typescript
async function handleRequest(request: Request, env: WorkerEnv) {
  const value = env.NEW_VARIABLE;
  // Use it
}
```

### Step 4: Deploy

```bash
pnpm --filter @onlooker/api deploy --env production
```

---

## Removing Environment Variables

### For Variables in wrangler.toml

1. Remove from all `[env.*.vars]` sections in `wrangler.toml`
2. Remove from `WorkerEnv` type definition
3. Remove usage from code
4. Commit and deploy

### For Secrets

```bash
# Delete from all environments
pnpm wrangler secret delete SECRET_NAME --env production
pnpm wrangler secret delete SECRET_NAME --env staging
pnpm wrangler secret delete SECRET_NAME --env development
```

---

## Debugging Environment Variables

### Print Variables (Development)

```typescript
// In your handler
export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    console.log('Environment:', env.ENVIRONMENT);
    console.log('CORS Origin:', env.CORS_ORIGIN);
    // NOTE: Never log secrets!
  }
};
```

### View via CLI

```bash
# List all variables for an environment
pnpm wrangler env list --env production

# Check specific variable (read from wrangler.toml)
grep -A 5 "\[env.production.vars\]" apps/api/wrangler.toml
```

### Check at Build Time

```bash
# For web app
pnpm --filter @onlooker/web build
# Vite will show which env vars are used

# For API
pnpm --filter @onlooker/api build
# TypeScript will error if env var is missing from interface
```

---

## Migration Guide

### Moving Between Environments

#### Local → Staging

1. Copy secrets from local to staging:
   ```bash
   # Get local secret
   pnpm wrangler secret list --env development
   
   # Put in staging
   pnpm wrangler secret put JWT_SECRET --env staging
   ```

2. Update `VITE_API_URL` in `wrangler.toml`:
   ```toml
   [env.staging.vars]
   VITE_API_URL = "https://api-staging.onlooker.example.com"
   ```

3. Deploy:
   ```bash
   pnpm deploy:staging
   ```

#### Staging → Production

1. Ensure all production secrets are set:
   ```bash
   pnpm wrangler secret list --env production
   ```

2. Verify production config in `wrangler.toml`

3. Backup database:
   ```bash
   pnpm wrangler d1 export onlooker-db > backup_$(date +%s).sql
   ```

4. Deploy:
   ```bash
   pnpm deploy:prod
   ```

---

## Common Issues

### "Variable is undefined"

**Cause:** Variable not in `wrangler.toml` or type definition

**Solution:**
1. Add to `[env.*.vars]` in `wrangler.toml`
2. Add to `WorkerEnv` type
3. Rebuild and redeploy

### "Secret is not available"

**Cause:** Secret not set via `wrangler secret put`

**Solution:**
```bash
pnpm wrangler secret put SECRET_NAME --env production
# Enter value when prompted
```

### CORS origin mismatch

**Cause:** `CORS_ORIGIN` doesn't match web app domain

**Solution:**
```toml
[env.production.vars]
CORS_ORIGIN = "https://onlooker.example.com"  # Match exactly
```

### Build fails with undefined variable

**Cause:** Missing `VITE_` prefix for build-time vars in web app

**Solution:**
```typescript
// Correct: prefixed with VITE_
const API_URL = import.meta.env.VITE_API_URL;

// Wrong: no prefix (won't be available at build time)
const API_URL = import.meta.env.API_URL;
```

---

## Next Steps

1. Review [DEPLOYMENT.md](./DEPLOYMENT.md) for deployment steps
2. Check [CLOUDFLARE_SETUP.md](./CLOUDFLARE_SETUP.md) for setup details
3. Set up secrets: `pnpm wrangler secret put JWT_SECRET --env production`
