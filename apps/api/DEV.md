# Onlooker API Development Guide

## Quick Start

```bash
# Install dependencies
pnpm install

# Create the local database. Required once before the first run, and again
# after any schema change in packages/db. Without it every authenticated route
# fails - see "Local database" below.
pnpm exec wrangler d1 migrations apply onlooker-db-local --local --env development

# Start development server (Cloudflare Workers)
pnpm dev

# Type check
pnpm typecheck

# Lint and fix
pnpm lint:fix

# Build for deployment
pnpm build

# Deploy to Cloudflare Workers
pnpm deploy
```

## Project Structure

```
src/
├── index.ts              # Cloudflare Workers entry point
├── router.ts             # Route dispatcher (maps paths to handlers)
├── types/
│   ├── index.ts          # Type definitions and WorkerEnv interface
│   ├── requests.ts       # Request body types
│   └── responses.ts      # Response body types
├── middleware/
│   ├── auth.ts           # JWT extraction and validation
│   ├── error.ts          # Error handling and response formatting
│   └── index.ts          # Middleware exports
├── routes/
│   ├── auth.ts           # WS1: Login, signup, refresh, logout, /auth/me
│   ├── account.ts        # WS2: Profile, password, email verification, account deletion
│   ├── data.ts           # WS4: Protected dashboard and user profile data
│   └── index.ts          # Route exports
└── db/
    └── index.ts          # Database abstraction layer stubs for WS1 integration
```

## API Endpoints

### Authentication (POST requests, no auth required)
- `POST /auth/login` - Login with email/password
- `POST /auth/signup` - Create new account
- `POST /auth/refresh` - Exchange refresh token for new access token
- `POST /auth/logout` - Invalidate session

### Current User (GET, requires access token)
- `GET /auth/me` - Get authenticated user profile

### Account Management (all require access token)
- `GET /auth/profile` - Full account profile with verification status
- `PATCH /auth/profile` - Update name/email
- `POST /auth/change-password` - Change password
- `DELETE /auth/account` - Delete account

### Email Verification (no auth required)
- `POST /auth/verify-email` - Verify email with token
- `POST /auth/resend-verification` - Request new verification email (requires auth)

### Password Reset (no auth required)
- `POST /auth/forgot-password` - Request password reset link
- `GET /auth/reset-password/verify?token=...` - Check if reset link is valid
- `POST /auth/reset-password` - Reset password with token

### Protected Data (require access token)
- `GET /api/users/me` - User profile with timestamps
- `GET /api/dashboard` - Dashboard with stats and activity

## Local database

The API stores everything in D1, reached through the `DB` binding. `wrangler
dev` is local-first, so that binding resolves to a SQLite file under
`apps/api/.wrangler/` and never touches Cloudflare — but the file has to exist
and carry the schema first:

```bash
pnpm exec wrangler d1 migrations apply onlooker-db-local --local --env development
```

Run it once before your first `pnpm dev`, and again whenever `packages/db`
gains a migration. `packages/db` owns the schema; `wrangler.toml` points
`migrations_dir` at it rather than keeping a second copy here.

**If you skip it, the symptom does not mention the database.** Signup returns
`500 Cannot read properties of undefined (reading 'prepare')` — `.prepare()` is
a D1 method being called on a binding that isn't there.

`pnpm dev` passes `--env development`, which is what supplies both the `DB`
binding and the vars below. Plain `wrangler dev` reads `wrangler.toml`'s
top-level block, which has neither, and fails the same way.

## Environment Variables

### Development (wrangler.toml, under `[env.development.vars]`)
```
JWT_SECRET=dev-secret-key-change-in-production
TOKEN_EXPIRY_MINUTES=180
REFRESH_TOKEN_EXPIRY_DAYS=30
ENVIRONMENT=development
CORS_ORIGIN=http://localhost:5173
```

### Production
Set via Cloudflare Workers dashboard or `wrangler secret put KEY`

## Testing Integration

1. **Start the API locally:**
   ```bash
   cd apps/api
   pnpm dev
   # Server runs on http://localhost:8787
   ```

2. **Point web app to local API:**
   ```bash
   # In apps/web/.env.local or via import config:
   VITE_API_URL=http://localhost:8787
   ```

3. **Start web app:**
   ```bash
   cd apps/web
   pnpm dev
   ```

## WS1 Integration Checklist

WS1 needs to implement:

- [ ] User CRUD operations (D1 queries)
- [ ] Password hashing (bcrypt)
- [ ] JWT signing/verification (RS256)
- [ ] Refresh token persistence
- [ ] Email verification token storage
- [ ] Password reset token storage
- [ ] Token revocation checks
- [ ] Last login tracking
- [ ] User metadata queries

See `INTEGRATION.md` for detailed implementation guide.

## Error Responses

All errors follow this format:
```json
{
  "error": "error_code",
  "message": "Human-readable message",
  "details": {}
}
```

Common error codes:
- `unauthorized` - Invalid/missing auth token (401)
- `invalid_credentials` - Wrong email/password (401)
- `user_exists` - Email already registered (409)
- `email_taken` - New email in use by another account (409)
- `invalid_token` - Malformed or expired token (401)
- `invalid_password` - Wrong current password (401)
- `invalid_input` - Missing or invalid request fields (400)
- `not_implemented` - Endpoint not yet implemented, awaiting WS1 (501)

## CORS Headers

CORS is enabled for development:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type, Authorization`

For production, restrict to known origins.
