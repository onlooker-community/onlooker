# Environment Variables & Secrets Reference

Complete reference of all environment variables used across the Onlooker platform.

Every entry below has a reader in the code. That is the rule this document is
kept to, because it did not used to hold: the table once listed
`DATABASE_PASSWORD`, `ENCRYPTION_KEY`, `OAUTH_CLIENT_SECRET`, `DB_HOST`,
`DB_NAME` and a `TOKEN_CACHE` binding, none of which anything read, alongside
instructions for generating and setting them. They appear to be leftovers from a
template written before this was a D1 app. Meanwhile the three variables the mail
path actually depends on were absent entirely.

That combination is worse than an incomplete document. A reader who follows it,
sets three secrets nothing consumes, and then finds password resets still not
arriving has been actively misled — and the next reader, having noticed one
fictional entry, has no way to know which of the others are real. Ground truth is
`WorkerEnv` in `apps/api/src/types/index.ts` and `apps/api/wrangler.toml`; when
they disagree with this file, they are right and this file is stale.

## Quick Reference Table

| Variable | Service | Type | Purpose | Example |
|----------|---------|------|---------|---------|
| `VITE_API_BASE_URL` | Web | Build | API the bundle calls | `https://api.onlooker.dev` |
| `JWT_SECRET` | API | Secret (var in dev) | JWT signing key | `openssl rand -hex 32` |
| `RESEND_API_KEY` | API | Secret | Sends mail via Resend. Unset means mail is logged, not sent | From the Resend dashboard |
| `ENVIRONMENT` | API | Vars | Deployment environment | `production` |
| `CORS_ORIGIN` | API | Vars | Allowed origin for CORS | `https://app.onlooker.dev` |
| `EMAIL_FROM` | API | Vars | From address on outgoing mail | `Onlooker <noreply@onlooker.dev>` |
| `APP_BASE_URL` | API | Vars | Origin that reset and verification links point at | `https://app.onlooker.dev` |
| `TOKEN_EXPIRY_MINUTES` | API | Vars | Access token lifetime | `15` |
| `REFRESH_TOKEN_EXPIRY_DAYS` | API | Vars | Refresh token lifetime | `30` |

---

## Web App (Vite React)

### Build-Time Variables

These are baked into the build and available at runtime as `import.meta.env.VITE_*`.

**They belong in `.env.<mode>` files, never in `apps/web/wrangler.toml`.** Vite
inlines `VITE_*` at build time, so which API a bundle calls is decided by
`vite build` and is fixed from then on — a deploy cannot redirect it. `apps/web`
is a static-assets Worker with no `main` besides, so it has no runtime that
could read a var at all.

This document previously said the opposite, and the cost was real: it described
per-environment `VITE_API_URL` values living in `wrangler.toml`, which nothing
read under a name nothing used, while one shared `dist/` built against
`api.onlooker.dev` shipped to both hostnames. `app-staging.onlooker.dev` was
reading and writing the production database.

Each environment gets its own build mode and its own file:

| Environment | Build command | File |
|-------------|---------------|------|
| development | `pnpm --filter @onlooker/web dev` | `apps/web/.env.development` |
| staging | `pnpm --filter @onlooker/web build:staging` | `apps/web/.env.staging` |
| production | `pnpm --filter @onlooker/web build` | `apps/web/.env.production` |

```env
# apps/web/.env.staging
VITE_API_BASE_URL=https://api-staging.onlooker.dev
VITE_USE_MOCK_API=false
VITE_API_LOG_REQUESTS=false
```

Both build commands end by asserting that the bundle they produced calls the API
that build mode is named for (`apps/web/scripts/verify-api-target.mjs`). It
reads the emitted assets rather than the config, because the config is what was
wrong last time. It also fails when the bundle names *no* API: with
`--mode staging` and no `.env.staging`, `VITE_API_BASE_URL` is unset and the app
silently falls back to its in-memory mock, which looks perfectly healthy while
serving invented data.

Override anything locally with `apps/web/.env.local`, which is git-ignored. See
`apps/web/.env.example` for the full list of variables.

### Usage in Code

Read config through `resolveApiConfig()` in `src/api/config.ts` rather than
touching `import.meta.env` directly — it centralizes the fallbacks:

```typescript
import { resolveApiConfig } from "./config";

const { baseUrl } = resolveApiConfig();

export async function fetchUser(token: string) {
  const response = await fetch(`${baseUrl}/api/users/me`, {
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
| `CORS_ORIGIN` | Origins allowed to call the API from a browser, comma-separated. Matched exactly — scheme included, no trailing slash. Unset means none | Origin of the web app |
| `EMAIL_FROM` | From address on every message the API sends | `Onlooker <noreply@onlooker.dev>` — the same in all three environments |
| `APP_BASE_URL` | Origin that password-reset and verification links point at. Wrong value means the mail sends and the link lands nowhere useful | Origin of the web app |
| `TOKEN_EXPIRY_MINUTES` | Access token lifetime, and the window a logged-out token stays usable | `15` |
| `REFRESH_TOKEN_EXPIRY_DAYS` | Refresh token lifetime | `30` (30 days) |

`DB_HOST` and `DB_NAME` were listed here and are gone: nothing reads either, and
`DB_NAME` named three databases (`onlooker_dev`, `onlooker_staging`,
`onlooker_prod`) that have never existed. D1 is reached through the `DB` binding,
which carries the database identity itself — see Access Bindings below.

`JWT_SECRET` is a var only in development, where `wrangler.toml` carries a
throwaway value so a fresh clone runs without setup. In staging and production it
is a secret. It is listed under Secrets rather than here.

For where `EMAIL_FROM` and `APP_BASE_URL` sit in the whole mail path — including
the DNS records that decide whether that From address is accepted — see
[docs/runbooks/2026-08-22-mail-authentication.md](./docs/runbooks/2026-08-22-mail-authentication.md).

#### Development

**File:** `apps/api/wrangler.toml`

```toml
[env.development.vars]
JWT_SECRET = "dev-secret-key-change-in-production"
TOKEN_EXPIRY_MINUTES = "15"
REFRESH_TOKEN_EXPIRY_DAYS = "30"
ENVIRONMENT = "development"
CORS_ORIGIN = "http://localhost:5173"
EMAIL_FROM = "Onlooker <noreply@onlooker.dev>"
APP_BASE_URL = "http://localhost:5173"
```

Development is the one environment with `JWT_SECRET` in the file. The value is
deliberately worthless and deliberately committed, so `pnpm dev` works on a fresh
clone with no secret setup. `APP_BASE_URL` points at the Vite dev server, not the
worker, because it is where a link in an email should land.

#### Staging

**File:** `apps/api/wrangler.toml`

```toml
[env.staging.vars]
TOKEN_EXPIRY_MINUTES = "15"
REFRESH_TOKEN_EXPIRY_DAYS = "30"
ENVIRONMENT = "staging"
CORS_ORIGIN = "https://app-staging.onlooker.dev"
EMAIL_FROM = "Onlooker <noreply@onlooker.dev>"
APP_BASE_URL = "https://app-staging.onlooker.dev"
```

#### Production

**File:** `apps/api/wrangler.toml`

```toml
[env.production.vars]
TOKEN_EXPIRY_MINUTES = "15"
REFRESH_TOKEN_EXPIRY_DAYS = "30"
ENVIRONMENT = "production"
CORS_ORIGIN = "https://app.onlooker.dev"
EMAIL_FROM = "Onlooker <noreply@onlooker.dev>"
APP_BASE_URL = "https://app.onlooker.dev"
```

### Secrets (Must not be committed)

These are sensitive values managed via `pnpm --filter @onlooker/api exec wrangler secret put`.

> **Why every wrangler command here carries `--filter @onlooker/api`, and why
> shortening it back to `pnpm wrangler` breaks it.** The repository root has no
> `wrangler.*` file and no root `wrangler` dependency — the binary only resolves
> through hoisting. Run from there, wrangler has no configuration, so `--env
> production` names an environment it has never heard of and the command dies
> with `Required Worker name missing`. Every command in this document used to be
> written that way and none of them could have worked. The filter runs wrangler
> in `apps/api`, where the config lives.

| Secret | Description | Generation |
|--------|-------------|-----------|
| `JWT_SECRET` | Signing key for JWTs. Staging and production only — development takes it from `wrangler.toml` | `openssl rand -hex 32` |
| `RESEND_API_KEY` | Bearer credential for sending mail as this domain | Resend dashboard → API Keys |

Those are the two. `DATABASE_PASSWORD`, `ENCRYPTION_KEY` and
`OAUTH_CLIENT_SECRET` were listed here, with generation commands and `secret put`
lines for each; nothing in the codebase reads any of them. D1 is reached through
a binding and needs no password, nothing is encrypted at rest by this
application, and there is no OAuth provider. They have been removed rather than
marked unused, because a secrets table is read as a checklist.

> **`RESEND_API_KEY` fails quietly, which is the thing to know about it.** It is
> optional in `WorkerEnv` on purpose: with no key, `sendEmail` logs the message
> instead of sending it, so signup and password reset stay exercisable locally
> without a credential. The consequence in a deployed environment is that a
> missing key does not raise anything. Signup returns 201, password reset returns
> its usual success, and the mail simply never arrives. Nothing in the response,
> the status code, or the error rate distinguishes it from a working system.
>
> So confirm it by presence, not by behavior — `wrangler secret list` for the
> environment, below. The DNS half of the same path is in
> [docs/runbooks/2026-08-22-mail-authentication.md](./docs/runbooks/2026-08-22-mail-authentication.md).

#### Set Secrets

```bash
# Production
pnpm --filter @onlooker/api exec wrangler secret put JWT_SECRET --env production
pnpm --filter @onlooker/api exec wrangler secret put RESEND_API_KEY --env production

# Staging
pnpm --filter @onlooker/api exec wrangler secret put JWT_SECRET --env staging
pnpm --filter @onlooker/api exec wrangler secret put RESEND_API_KEY --env staging
```

Development is absent deliberately. `wrangler.toml` supplies `JWT_SECRET` there,
and leaving `RESEND_API_KEY` unset is the point — mail gets logged rather than
sent, so local work does not deliver to real inboxes.

#### List Secrets

```bash
# View configured secrets (names only, no values)
pnpm --filter @onlooker/api exec wrangler secret list --env production
pnpm --filter @onlooker/api exec wrangler secret list --env staging
```

#### Use Secrets in Code

Secrets arrive on `env`, exactly like vars — the difference is where they are
stored, not how they are read:

```typescript
// src/middleware/auth.ts
const payload = await verifyJwt(token, env.JWT_SECRET);
```

### Access Bindings

These are automatically injected via wrangler configuration.

| Binding | Type | Bound where |
|---------|------|-------------|
| `DB` | D1Database | `[[env.*.d1_databases]]` in `wrangler.toml`, all three environments |
| `TOKEN_REVOCATION` | KVNamespace | Nowhere — see below |

#### D1 Database Binding

**File:** `apps/api/wrangler.toml`

```toml
# Production
[[env.production.d1_databases]]
binding = "DB"
database_name = "onlooker-db"
migrations_dir = "../../packages/db/migrations"
database_id = "5473b131-271e-4ce9-84e5-b48a93269dc8"

# Staging
[[env.staging.d1_databases]]
binding = "DB"
database_name = "onlooker-db-staging"
database_id = "ff3a01c8-aedb-4bc2-8231-b8511b353728"
migrations_dir = "../../packages/db/migrations"
```

Development binds `onlooker-db-local` with an obviously fake `database_id`;
`wrangler dev` is local-first, so it resolves to a SQLite file under
`apps/api/.wrangler/` and never reaches Cloudflare. The fake id is there so that
anything which *does* try to reach a real database with it fails loudly instead
of quietly hitting staging.

`migrations_dir` points at `packages/db`, which owns the schema. `wrangler.toml`
carries the reasoning for each of these; it is the source of truth, and the block
above is a copy that can go stale.

#### KV Namespace Binding

**There is none.** `wrangler.toml` declares no `kv_namespaces` in any
environment.

This section used to show `id`/`preview_id` blocks for a binding called
`TOKEN_CACHE`, a name that appears nowhere in the codebase. The real declaration
is `TOKEN_REVOCATION?: KVNamespace` in `WorkerEnv` — optional, bound nowhere,
read nowhere, and deliberately so. It is a signpost for a decision that has not
been made yet: logout revokes the refresh token but cannot withdraw an already
issued access token, because a stateless JWT would need a denylist checked on
every authenticated request. `TOKEN_EXPIRY_MINUTES` stands in for that denylist
today, and `TOKEN_REVOCATION` marks where one would attach if the trade is ever
revisited. See `apps/api/src/routes/auth.ts` and `SESSION_LIFECYCLE` in
`packages/api-contract`.

Adding a KV namespace means creating it, declaring it per environment, and
writing the code that reads it — not filling in the placeholder ids that used to
sit here.

---

## Environment-Specific Values

### Development

```env
# Web app (apps/web/.env.development)
VITE_API_BASE_URL=http://localhost:8787

# API (wrangler.toml [env.development])
ENVIRONMENT=development
CORS_ORIGIN=http://localhost:5173
EMAIL_FROM=Onlooker <noreply@onlooker.dev>
APP_BASE_URL=http://localhost:5173
TOKEN_EXPIRY_MINUTES=15
REFRESH_TOKEN_EXPIRY_DAYS=30
JWT_SECRET=dev-secret-key-change-in-production

# Secrets: none. JWT_SECRET is a committed throwaway above, and
# RESEND_API_KEY is left unset so mail is logged rather than delivered.
```

### Staging

```env
# Web app (apps/web/.env.staging)
VITE_API_BASE_URL=https://api-staging.onlooker.dev

# API (wrangler.toml [env.staging])
ENVIRONMENT=staging
CORS_ORIGIN=https://app-staging.onlooker.dev
EMAIL_FROM=Onlooker <noreply@onlooker.dev>
APP_BASE_URL=https://app-staging.onlooker.dev
TOKEN_EXPIRY_MINUTES=15
REFRESH_TOKEN_EXPIRY_DAYS=30

# Secrets (via wrangler secret put)
JWT_SECRET=<staging-key>
RESEND_API_KEY=<resend-key>
```

### Production

```env
# Web app (apps/web/.env.production)
VITE_API_BASE_URL=https://api.onlooker.dev

# API (wrangler.toml [env.production])
ENVIRONMENT=production
CORS_ORIGIN=https://app.onlooker.dev
EMAIL_FROM=Onlooker <noreply@onlooker.dev>
APP_BASE_URL=https://app.onlooker.dev
TOKEN_EXPIRY_MINUTES=15
REFRESH_TOKEN_EXPIRY_DAYS=30

# Secrets (via wrangler secret put)
JWT_SECRET=<prod-key>
RESEND_API_KEY=<resend-key>
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
pnpm --filter @onlooker/api exec wrangler secret put JWT_SECRET --env production
```

### Resend API Key

Not generated — issued. Create it in the Resend dashboard under API Keys, scoped
to sending only, then:

```bash
pnpm --filter @onlooker/api exec wrangler secret put RESEND_API_KEY --env production
```

Rotating it is the same command with a new value; the worker picks it up on the
next request, with no redeploy. There is no third secret to generate. Sections
for a database password and an encryption key used to sit here, for secrets
nothing reads.

---

## Environment Type Reference

### Type: `Build-Time`

- Compiled into the artifact during build
- Cannot change without rebuilding — so a `wrangler.toml` var can never supply
  one, and each target environment needs its own build
- Vite: prefixed with `VITE_`, read from `.env.<mode>`
- Example: `VITE_API_BASE_URL`

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
- Example: `JWT_SECRET`, `RESEND_API_KEY`

### Type: `Bindings`

- Cloudflare resources (D1, KV, etc.)
- Configured in `wrangler.toml` under `[[d1_databases]]`, `[[kv_namespaces]]`, etc.
- Accessed via named bindings (e.g., `env.DB`)
- Example: the D1 database. It is the only binding this API has.

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
pnpm --filter @onlooker/api exec wrangler secret delete SECRET_NAME --env production
pnpm --filter @onlooker/api exec wrangler secret delete SECRET_NAME --env staging
pnpm --filter @onlooker/api exec wrangler secret delete SECRET_NAME --env development
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
# Secrets: names only, never values. This is the only way to confirm a secret
# is set, and the only check that catches a missing RESEND_API_KEY before a
# user does.
pnpm --filter @onlooker/api exec wrangler secret list --env production

# Vars: they live in the file, so read the file.
sed -n '/\[env.production.vars\]/,/^$/p' apps/api/wrangler.toml
```

There is no `wrangler env list`; it was written here for a while and exits with
`Unknown argument: env`. Vars and secrets are listed by different means because
they are stored in different places — the vars are in the repository, and the
secrets are only ever enumerable by name.

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

1. Set the staging secrets. They are not copied from development — there is
   nothing to copy from, and `secret list` returns names without values by
   design. Staging gets its own freshly generated `JWT_SECRET`, and the Resend
   key from the dashboard:
   ```bash
   pnpm --filter @onlooker/api exec wrangler secret put JWT_SECRET --env staging
   pnpm --filter @onlooker/api exec wrangler secret put RESEND_API_KEY --env staging
   ```

2. Confirm the staging build targets the staging API:
   ```env
   # apps/web/.env.staging
   VITE_API_BASE_URL=https://api-staging.onlooker.dev
   ```

3. Deploy:
   ```bash
   pnpm deploy:staging
   ```

#### Staging → Production

1. Ensure all production secrets are set:
   ```bash
   pnpm --filter @onlooker/api exec wrangler secret list --env production
   ```

2. Verify production config in `wrangler.toml`

3. Backup database:
   ```bash
   pnpm --filter @onlooker/api exec wrangler d1 export DB --env production --remote --output ../../backup_$(date +%s).sql
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
pnpm --filter @onlooker/api exec wrangler secret put SECRET_NAME --env production
# Enter value when prompted
```

### CORS origin mismatch

**Cause:** `CORS_ORIGIN` doesn't match web app domain

**Solution:**
```toml
[env.production.vars]
CORS_ORIGIN = "https://app.onlooker.dev"  # Match exactly
```

### Build fails with undefined variable

**Cause:** Missing `VITE_` prefix for build-time vars in web app

**Solution:**
```typescript
// Correct: prefixed with VITE_
const baseUrl = import.meta.env.VITE_API_BASE_URL;

// Wrong: no prefix (won't be available at build time)
const baseUrl = import.meta.env.API_BASE_URL;
```

---

## Next Steps

1. Review [DEPLOYMENT.md](./DEPLOYMENT.md) for deployment steps
2. Check [DEPLOYMENT.md](./DEPLOYMENT.md) for how the pipeline applies them
3. Set up secrets: `pnpm --filter @onlooker/api exec wrangler secret put JWT_SECRET --env production`
