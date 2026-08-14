# API Integration Guide

This document describes how the Onlooker web app integrates with the real Cloudflare Workers API backend.

## Local Development Setup

### Prerequisites

- **Terminal 1**: Running the API server
- **Terminal 2**: Running the web dev server
- Both are configured for default ports (API: 8787, Web: 5173)

### Starting the Servers

**Terminal 1 — Start the Cloudflare Workers API:**

```bash
cd apps/api
pnpm dev
```

This starts the API server on `http://localhost:8787`. You should see:
```
Ready on http://localhost:8787
```

**Terminal 2 — Start the web app (Vite):**

```bash
cd apps/web
pnpm dev
```

This starts the web app on `http://localhost:5173`. You should see:
```
VITE v8.x.x  ready in xxx ms

➜  Local:   http://localhost:5173/
```

### Verification

Both servers should start cleanly with no errors. Navigate to `http://localhost:5173` in your browser. You should see the app load and be able to proceed through the login/signup flow.

## Environment Configuration

The web app's API integration is configured via environment variables read at build time by Vite:

| Variable | Dev Value | Prod Value | Purpose |
|----------|-----------|------------|---------|
| `VITE_API_BASE_URL` | `http://localhost:8787` | `https://api.onlooker.dev` | Base URL for API calls |
| `VITE_USE_MOCK_API` | `false` | `false` | When `true`, requests go to in-memory mock API instead |
| `VITE_API_LOG_REQUESTS` | `true` | `false` | Enable/disable console logging of API calls (tokens redacted) |
| `VITE_API_TIMEOUT_MS` | `15000` (fallback) | `15000` (fallback) | Per-request timeout in milliseconds |
| `VITE_API_MAX_RETRIES` | `2` (fallback) | `2` (fallback) | Auto-retry count for transient failures (5xx/429) |

**Files:**
- `.env.development` — local dev defaults
- `.env.production` — production defaults
- `.env.example` — reference of all available variables

## API Architecture

### Request Pipeline

Requests flow through these layers (from the outermost to the network):

1. **Timeout** — Aborts a request after `VITE_API_TIMEOUT_MS`
2. **Retry** — Exponential backoff with jitter for transient failures (network errors, 5xx, 429)
3. **Auth Refresh** — On `401`, refreshes tokens once and replays the request
4. **Logging** — Records each call with tokens redacted
5. **Network** — Actual `fetch` to the configured base URL

### Authentication

The app uses JWT-based authentication:

1. **Login/Signup** → Server returns `token` (short-lived, ~3 mins) and `refreshToken` (long-lived, ~30 days)
2. **Protected Requests** → `token` sent as `Authorization: Bearer <token>` header
3. **On 401** → Client posts `refreshToken` to `/auth/refresh` to get a new access token, then retries the original request
4. **Token Storage** → Tokens stored in `localStorage` under keys configured in `.env`

### Error Handling

- **4xx errors** (except 401) → Passed through to the caller as-is
- **401 (Unauthorized)** → Triggers token refresh; if refresh fails, session is invalidated and user is redirected to login
- **5xx errors / network timeouts** → Retried up to `VITE_API_MAX_RETRIES` times with exponential backoff
- **429 (Too Many Requests)** → Retried; respects `Retry-After` header if present

### CORS

The API is configured to accept requests from the web app's origin. In local development:
- Web: `http://localhost:5173`
- API: `http://localhost:8787`

These are different origins, so the browser enforces CORS. The API includes appropriate headers:
- `Access-Control-Allow-Origin: http://localhost:5173` (in dev) or the production domain
- `Access-Control-Allow-Credentials: true`
- `Access-Control-Allow-Methods: GET, POST, PATCH, DELETE`
- `Access-Control-Allow-Headers: Authorization, Content-Type`

## API Endpoints

All endpoints are documented in `src/api/types.ts`. Here's a quick reference:

### Authentication Endpoints (public)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/auth/login` | Login with email/password → JWT tokens |
| POST | `/auth/signup` | Register new account → JWT tokens |
| POST | `/auth/refresh` | Exchange refresh token for new access token |
| GET | `/auth/me` | Get current user profile (requires auth) |
| POST | `/auth/logout` | Invalidate session (requires auth) |

### Account Management Endpoints (requires auth)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/auth/profile` | Get user profile |
| PATCH | `/auth/profile` | Update user profile (name, email, etc.) |
| POST | `/auth/change-password` | Change user password |
| DELETE | `/auth/account` | Delete account |
| POST | `/auth/verify-email` | Verify email with token |
| POST | `/auth/resend-verification` | Resend email verification link |
| POST | `/auth/forgot-password` | Initiate password reset |
| GET | `/auth/reset-password/verify` | Verify password reset token |
| POST | `/auth/reset-password` | Reset password with token |

### Protected Data Endpoints (requires auth)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/users/me` | Get user profile (includes metadata) |
| GET | `/api/dashboard` | Get user dashboard data (stats, activity) |

## Testing Integration

Before committing changes to the API client, verify the integration locally. Here's a checklist:

### Signup Flow
- [ ] Load `http://localhost:5173/signup`
- [ ] Enter email, password, optional name
- [ ] Submit form
- [ ] Verify success response (JWT tokens received)
- [ ] Verify tokens in localStorage (`auth_token`, `auth_refresh_token`)
- [ ] Verify automatic redirect to dashboard or onboarding

### Login Flow
- [ ] Load `http://localhost:5173/login`
- [ ] Enter email and password of an existing user
- [ ] Submit form
- [ ] Verify success response (JWT tokens received)
- [ ] Verify automatic redirect to dashboard

### Token Refresh
- [ ] Login successfully
- [ ] Open browser DevTools Console
- [ ] Set `VITE_API_LOG_REQUESTS=true` in `.env.development`
- [ ] Wait for access token to expire (~3 minutes in dev)
- [ ] Observe that the next request triggers a refresh (POST `/auth/refresh`)
- [ ] Verify the refresh succeeds and the original request is replayed

### Profile Page
- [ ] After login, navigate to `/profile`
- [ ] Verify user data loads (name, email, created/last login dates)
- [ ] In DevTools, confirm request includes `Authorization: Bearer <token>` header

### Password Change
- [ ] Navigate to `/settings`
- [ ] Submit password change form
- [ ] Verify success response
- [ ] Logout and re-login with new password to confirm it worked

### Email Verification
- [ ] After signup, check for email verification link
- [ ] Click the link (or manually add the token as a URL parameter)
- [ ] Verify success response

### Logout
- [ ] While logged in, click Logout
- [ ] Verify session is cleared locally (tokens removed from localStorage)
- [ ] Verify automatic redirect to login page
- [ ] Attempt to access protected page → should redirect to login

### Error Scenarios

#### Unauthorized (401)
- [ ] Manually clear `auth_token` from localStorage
- [ ] Refresh the page
- [ ] Verify automatic redirect to login
- [ ] Check that session was properly invalidated

#### Invalid Credentials
- [ ] Attempt login with wrong email
- [ ] Verify error message: "Invalid email or password"
- [ ] Attempt login with wrong password
- [ ] Verify error message: "Invalid email or password"

#### Network Errors
- [ ] Stop the API server (Ctrl+C in Terminal 1)
- [ ] Attempt to login
- [ ] Verify error message (timeout or network error)
- [ ] Restart API server
- [ ] Verify login works again

#### Rate Limiting
- [ ] Attempt login 10+ times rapidly
- [ ] Verify 429 response with `Retry-After` header
- [ ] Verify client retries automatically
- [ ] Wait for backoff to complete
- [ ] Verify subsequent requests succeed

## Common Issues and Solutions

### "API not responding" / "Cannot connect to localhost:8787"

**Problem:** Web app can't reach the API server.

**Solutions:**
1. Verify API server is running: Check Terminal 1 for `Ready on http://localhost:8787`
2. Check port availability: `lsof -i :8787` (should show `wrangler`)
3. Check firewall: If on a restricted network, port 8787 might be blocked
4. Use a different port: Edit `wrangler.toml` and update `.env.development`

### "CORS error" / "No 'Access-Control-Allow-Origin' header"

**Problem:** Browser blocks request due to CORS policy.

**Solutions:**
1. Verify API includes CORS headers (should be in middleware)
2. Check origin: DevTools → Network → Request Headers should show correct origin
3. Try with credentials: Some CORS scenarios require `credentials: 'include'`

### "Tokens in localStorage but still 401"

**Problem:** User has tokens but requests return 401 (Unauthorized).

**Solutions:**
1. Verify token hasn't expired: Decode JWT (use `decodeJwtPayload` in auth-react)
2. Check token rotation: After refresh, old token should be cleared
3. Verify revocation: Logout invalidates tokens server-side; check `REVOKED_TOKENS` in mock or token store in production

### "Infinite redirect loop on 401"

**Problem:** User redirected to login but gets stuck in a loop.

**Cause:** Logout endpoint hitting itself or refresh endpoint hitting itself.

**Solution:** The client is designed to prevent this — logout never hits the network, and refresh-on-401 is exempt from refresh-on-401 to prevent recursion. If this happens, check:
1. Verify `REFRESH_EXEMPT_PATHS` includes `/auth/refresh`
2. Verify logout handler clears tokens locally without calling `/auth/logout`

## File Reference

### Core API Client Files

- `src/api/client.ts` — Main API client with auth, retry, timeout middleware
- `src/api/config.ts` — Environment variable parsing and config resolution
- `src/api/types.ts` — Endpoint contract types (requests/responses)
- `src/api/tokenStore.ts` — JWT token storage (localStorage)
- `src/api/logger.ts` — Request/response logging (tokens redacted)

### Auth Integration

- `src/auth.ts` — Auth state management using `@onlooker/auth-react`
- `src/hooks/useAuthenticatedFetch.ts` — Authenticated data fetching hook
- `src/components/SessionExpiryBanner.tsx` — Warns before token expiry (WS3)

### Page Components

- `src/pages/LoginPage.tsx` — Login form
- `src/pages/SignupPage.tsx` — Signup form
- `src/pages/DashboardPage.tsx` — Protected dashboard (authenticated)
- `src/pages/ProfilePage.tsx` — User profile (authenticated)
- `src/pages/SettingsPage.tsx` — Settings including password change

## Future Work

- **Email Service (WS2):** Queue and send emails (verification, password reset)
- **Session Management (WS3):** Proactive token refresh, cross-tab sync
- **Protected Resources (WS4):** User profiles, dashboards, activity logs
- **Testing & Security (WS5):** End-to-end tests, penetration testing, threat model

## References

- [Vite Environment Variables](https://vitejs.dev/guide/env-and-mode)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [JWT Best Practices](https://datatracker.ietf.org/doc/html/rfc8725)
- [@onlooker/auth-react source](../../packages/auth-react/src) — the package has
  no README, and pointing at one that has never existed is worse than pointing
  at the code that does
