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

# Deploy to Cloudflare Workers (from the repository root)
pnpm deploy:api:staging
pnpm deploy:api:prod
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
│   ├── machine-auth.ts   # Machine token extraction and validation
│   ├── principal.ts      # Resolves a route's `auth` to a principal
│   ├── cors.ts           # Origin checks against CORS_ORIGIN
│   ├── error.ts          # Error handling and response formatting
│   └── index.ts          # Middleware exports
├── routes/               # One file per surface: auth, account, lessons,
│                         # machines, orgs, activity, sessions, projects...
├── db/                   # D1 queries, one file per table or concern
├── lessons/, orgs/       # Domain logic the routes share
└── email/                # Outbound mail
```

## API Endpoints

`src/router.ts` is the source of truth. This list is grouped the way that file
is, and every route's `auth` is one of:

- **none** - no credential, or the credential is a token in the request itself
- **session** - a browser access token (`Authorization: Bearer <jwt>`)
- **machine** - a machine token minted at `POST /api/machines`
- **operator** - a session whose user is an operator; anyone else gets a 404

### Authentication
- `POST /auth/login` (none) - Login with email/password
- `POST /auth/signup` (none) - Create new account
- `POST /auth/refresh` (none) - Exchange refresh token for new access token
- `GET /auth/me` (session) - Get authenticated user profile
- `POST /auth/logout` (none) - Revoke the refresh token in the body

### Account Management
- `GET /auth/profile` (session) - Full account profile with verification status
- `PATCH /auth/profile` (session) - Update name/email
- `POST /auth/change-password` (session) - Change password
- `DELETE /auth/account` (session) - Delete account
- `GET /auth/account/deletion-preview` (session) - What deleting would remove
- `POST /auth/verify-email` (none) - Verify email with the token in the body
- `POST /auth/resend-verification` (session) - Request new verification email
- `POST /auth/forgot-password` (none) - Request password reset link
- `GET /auth/reset-password/verify?token=...` (none) - Check if reset link is valid
- `POST /auth/reset-password` (none) - Reset password with token

### Protected Data
- `GET /api/users/me` (session) - User profile with timestamps

### Telemetry
- `POST /api/client-errors` (none) - Errors the browser reports

### Machines (from the browser)
- `POST /api/machines` (session) - Mint a machine token; `org_id` scopes it to an org
- `GET /api/machines` (session) - List this account's machines
- `DELETE /api/machines/:id` (session) - Revoke a machine's token
- `POST /api/machines/:id/remove` (session) - Delete a revoked machine; its sessions stay
- `GET /api/machines/:id/inventory` (session) - One machine's full inventory

### Machine self-report
- `PUT /machine/inventory` (machine) - Replace this machine's inventory
- `POST /machine/sessions` (machine) - Report session summaries

### Lessons (sync, for plugins)
- `POST /lessons` (machine) - Push lessons to the pool
- `GET /lessons` (machine) - Pull the lesson feed
- `POST /lessons/:id/status` (machine) - Transition a lesson's status

### Lessons (browsing, for the web app)
- `GET /api/lessons` (session) - The reader's lessons, paged; `status` and
  `project` repeat, `cursor` and `limit` page
- `GET /api/lessons/:id` (session) - One lesson, for a deep link
- `PATCH /api/lessons/:id/status` (session) - Retract a lesson or make it active
- `GET /api/public/lessons/:id` (none) - One public lesson, anonymously
- `GET /api/activity` (session) - The reader's activity feed
- `GET /api/sessions` (session) - The reader's session history, across machines
- `GET /api/projects` (session) - The reader's own projects
- `GET /api/project-labels` (session) - Display names for projects
- `PUT /api/project-labels` (session) - Set a project's display name

### Orgs
- `POST /api/orgs`, `GET /api/orgs` (session) - Create, list
- `PATCH /api/orgs/:id`, `DELETE /api/orgs/:id` (session) - Rename, delete
- `GET /api/orgs/:id/members` (session) - List members
- `PATCH /api/orgs/:id/members/:userId` (session) - Change a member's role
- `DELETE /api/orgs/:id/members/:userId` (session) - Remove a member, or leave
- `POST /api/orgs/:id/invites`, `GET /api/orgs/:id/invites` (session) - Invite, list
- `DELETE /api/orgs/:id/invites/:inviteId` (session) - Revoke an invite
- `POST /api/orgs/:id/lessons/:lessonId/retract` (session) - Retract a lesson
  shared with the org; one-way
- `GET /api/orgs/invites/verify?token=...` (none) - Check an invite link
- `POST /api/orgs/invites/accept` (session) - Accept an invite

### Operator moderation
- `POST /api/admin/lessons/:id/retract` (operator) - Retract any lesson
- `POST /api/admin/author-blocks` (operator) - Block an author
- `DELETE /api/admin/author-blocks/:authorKey` (operator) - Unblock an author

Who may act inside the session-authenticated org routes (owner or member) is
checked by the handler, not by `auth`; see the comment above them in
`router.ts`.

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
TOKEN_EXPIRY_MINUTES=15
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

   `apps/web/.env.development` already does this, so `pnpm dev` needs no setup.
   To override, use `apps/web/.env.local` (git-ignored):
   ```bash
   VITE_API_BASE_URL=http://localhost:8787
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

Every environment is restricted to the origins its `CORS_ORIGIN` names — no
environment is open, development included. A request whose `Origin` is on the
list gets it echoed back:

- `Access-Control-Allow-Origin: http://localhost:5173` (whatever `CORS_ORIGIN`
  says for the environment you are running)
- `Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type, Authorization`
- `Vary: Origin` on every response, allowed or not

Anything else gets no allow-origin header at all, including when `CORS_ORIGIN`
is unset — a misconfigured environment refuses browsers rather than admitting
everyone. `CORS_ORIGIN` accepts a comma-separated list if you need a second
origin, such as `127.0.0.1` alongside `localhost`.

None of this affects curl or anything server-to-server: CORS is a browser
mechanism, and a request with no `Origin` header is answered normally.

**If the browser starts reporting CORS errors in dev,** check that the address
bar matches `CORS_ORIGIN` exactly — `http://127.0.0.1:5173` is a different
origin from `http://localhost:5173`, and the API is right to refuse it.
