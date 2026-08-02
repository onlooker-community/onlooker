# Authentication — Developer Guide

How authentication works in `apps/web`, how to configure it, and how to debug it.
For the security posture and the deployment checklist, see
[`../SECURITY.md`](../SECURITY.md).

## Architecture at a glance

```
UI pages (Login/Signup/Reset/Settings)
        │  calls
        ▼
auth.ts  ── createReactAuth() from @onlooker/auth-react
        │  uses
        ▼
api/client.ts  ── createApiClient(): authenticatedFetch + apiClient
        │  layers (network outward): timeout → retry → refresh → logging
        ▼
api/tokenStore.ts   access + refresh token pair (localStorage)
api/config.ts       VITE_* environment configuration
api/logger.ts       redacted request logging
api/mockApi.ts      in-memory backend used until a real API exists
```

Key modules:

- **`src/auth.ts`** — wires `createReactAuth` (provider, `useAuth`,
  `RequireAuth`) to the API client. Owns login/signup/logout/session-load.
- **`src/api/client.ts`** — the resilient client. `authenticatedFetch` is a
  drop-in `fetch`; `apiClient` is the typed `get/post/patch/delete` wrapper.
- **`src/api/tokenStore.ts`** — stores the access + refresh tokens.
- **`src/lib/validation.ts`** — email + password rules and strength scoring.
- **`src/utils/rateLimiting.ts`** — client-side login attempt throttling.

## Auth flows

### Login / signup
1. Page calls `auth.useAuth().login(email, password)` (or `signup`).
2. `auth.ts` posts to `/auth/login`; the response carries a short-lived access
   `token`, a rotating `refreshToken`, and the `user`.
3. The access token is stored via the token store; the refresh token is stored
   alongside it. The session state hydrates and the user is authenticated.

### Authenticated requests
`authenticatedFetch` injects `Authorization: Bearer <access token>`, applies a
per-request timeout, and retries transient failures (network, `5xx`, `429`)
with exponentially backed-off, jittered delays.

### Token refresh (transparent)
On a `401` for a non-exempt request, the client posts the refresh token to
`/auth/refresh`, stores the rotated pair, and replays the original request once.
Refreshes are single-flight (concurrent 401s share one refresh). If refresh
fails, tokens are cleared and `onUnauthorized` fires so the app can redirect to
login. `/auth/login`, `/auth/signup`, and `/auth/refresh` never trigger refresh.

### Logout
`auth.ts` calls `/auth/logout` and always clears both tokens locally, even if
the network call fails.

## Token lifecycle

| Token | Lifetime | Sent as | Storage key (default) |
|-------|----------|---------|-----------------------|
| Access | Short | `Authorization: Bearer` header | `auth_token` |
| Refresh | Long, rotating | Body of `POST /auth/refresh` | `auth_refresh_token` |

Endpoint contract lives in `src/api/types.ts`.

## Configuration (environment variables)

All configuration is read from Vite `VITE_*` variables at build time by
`src/api/config.ts`. Copy `.env.example` to `.env.local` (git-ignored) to
override locally. Every value is optional with a sensible default.

| Variable | Default | Purpose |
|----------|---------|---------|
| `VITE_API_BASE_URL` | `""` (mock) | API origin. Empty means use the mock API. |
| `VITE_USE_MOCK_API` | on when base URL empty | Force the in-memory mock on/off. |
| `VITE_API_TIMEOUT_MS` | `15000` | Per-request timeout before abort. |
| `VITE_API_MAX_RETRIES` | `2` | Retries for transient failures. |
| `VITE_API_RETRY_BASE_DELAY_MS` | `300` | Backoff base delay. |
| `VITE_API_RETRY_MAX_DELAY_MS` | `5000` | Backoff cap. |
| `VITE_AUTH_TOKEN_KEY` | `auth_token` | localStorage key for the access token. |
| `VITE_AUTH_REFRESH_KEY` | `auth_refresh_token` | localStorage key for the refresh token. |
| `VITE_API_LOG_REQUESTS` | on in dev | Log API calls (tokens redacted). |

Never put secrets in `VITE_*` values — Vite inlines them into the public bundle.

## Testing

Auth is covered by:

- `src/__tests__/auth-integration.test.ts` — full flow against the real client
  and mock API: signup → login → `/auth/me` → logout, header injection, the
  refresh middleware (success, failure, exempt paths), retry/timeout, and error
  mapping.
- `src/lib/validation.test.ts` — email/password rules and strength scoring.
- `src/utils/rateLimiting.test.ts` — attempt counting, lockout, expiry, sliding
  window (driven by an injected clock, no real timers).

Run: `pnpm -F @onlooker/web test`.

> Component-render tests are not included yet: the workspace has no DOM test
> harness (`jsdom` + `@testing-library/react`). The integration tests therefore
> exercise the data path rather than React rendering.

## Troubleshooting

**"Session expired" / redirected to login unexpectedly.**
A protected call returned `401` and refresh could not recover it. Check that a
refresh token is present (`localStorage.auth_refresh_token`) and that
`/auth/refresh` returns `{ token, refreshToken }`. A rejected refresh token
clears the session by design.

**Requests hit the mock API instead of the real backend.**
`VITE_USE_MOCK_API` defaults to on whenever `VITE_API_BASE_URL` is empty. Set a
base URL and `VITE_USE_MOCK_API=false`.

**Login always fails against the mock.**
The seed user is `test@example.com` / `password123` (`src/api/mockApi.ts`).

**Slow requests fail with a timeout error.**
Raise `VITE_API_TIMEOUT_MS`. A caller-initiated `AbortController` is respected
and is not retried; only timeouts and network errors are.

**Locked out of login after several attempts.**
Client-side rate limiting (`utils/rateLimiting.ts`) locks a key for 60s after 5
failed attempts. It clears automatically; a successful login resets it.

**No API logs in the console.**
Logging is off in production and gated on `VITE_API_LOG_REQUESTS`. Tokens and
passwords are always redacted, so logs never show credentials.

**`vitest` fails to start with `ERR_PACKAGE_PATH_NOT_EXPORTED` / `module-runner`.**
Known workspace issue: `vitest@4` requires `vite ^6||^7||^8`, but `apps/web`
pins `vite ^5`. Align the web app's `vite` version with the rest of the
workspace, then reinstall.
