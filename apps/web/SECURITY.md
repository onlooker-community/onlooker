# Web App Authentication — Security Notes & Audit

Scope: the browser-side authentication data path in `apps/web` — token storage,
the API client and its refresh/retry middleware, request logging, form
validation, and client-side abuse protection. This document records the
Phase 3 security audit (WS5), the reasoning behind each control, and the
follow-ups that remain.

The server is the sole authority on authentication and authorization. Every
control here is defense-in-depth or UX; none of it replaces server-side
enforcement.

---

## Audit checklist

| # | Check | Status | Evidence |
|---|-------|--------|----------|
| 1 | Access token never placed in a URL or query string | Pass | `api/client.ts` sends it only as `Authorization: Bearer` (`withAuthHeader`); no `token=` in request construction. |
| 2 | Sensitive data redacted from logs | Pass | `api/logger.ts` `redact()` masks bodies/headers; `safeUrl()` masks sensitive query params; keys include token/password/authorization. |
| 3 | Request logging off by default in production | Pass | `.env.production` sets `VITE_API_LOG_REQUESTS=false`; `config.ts` defaults logging to dev-only. |
| 4 | No `dangerouslySetInnerHTML` / `innerHTML` / `eval` | Pass | Grep of `apps/web/src` returns none. React escapes interpolated values by default. |
| 5 | JWT decoded without trusting its signature client-side | Pass | `packages/auth-react/src/jwt.ts` decodes payload for `exp` scheduling only; never an auth decision. |
| 6 | Refresh loop bounded | Pass | `client.ts` refreshes at most once per request (single-flight `refreshInFlight`); `/auth/refresh` is refresh-exempt. |
| 7 | Failed refresh clears the session | Pass | `performRefresh()` clears tokens and fires `onUnauthorized` when the refresh token is rejected. |
| 8 | Password complexity enforced client-side | Pass | `lib/validation.ts` (min 8 / max 128, mixed case, number, symbol, common-password rejection) wired into `SignupPage`. |
| 9 | Brute-force friction on login | Pass | Enforced by the API, not the browser: `apps/api/src/db/login-attempts.ts` allows 4 failures per address, then answers 429 `rate_limit_exceeded` with `Retry-After` (60s, doubling, capped at 30 min). A Cloudflare zone rate limit covers `/auth/login` per IP (see `apps/api/DEPLOYMENT.md`). The web client has no throttle of its own. |
| 10 | CSRF exposure | N/A | Auth uses bearer tokens in a header, not ambient cookies, so classic CSRF does not apply. Revisit if cookie sessions are ever added. |
| 11 | Tokens in `localStorage` | Accepted risk | See "Token storage" below. Documented tradeoff with mitigations. |
| 12 | Password-reset token in URL | Accepted risk | See "Reset token in URL" below. Inherent to email-link resets; mitigated in logs. |
| 13 | HTTPS enforced in production | Partial | `.env.production` base URL is `https://`. No client-side downgrade guard; enforce at the CDN/host (HSTS). |

---

## Findings & reasoning

### Token storage (`localStorage`) — accepted risk
Both the access and refresh tokens live in `localStorage` (`api/tokenStore.ts`).
This is readable by any JavaScript running on the origin, so a successful XSS
attack can exfiltrate them. We accept this for now because:

- The app is a pure SPA calling a token-based API; there is no server render
  layer to set `HttpOnly` cookies, and `HttpOnly` cookies cannot be read by the
  bearer-token client anyway.
- XSS is mitigated structurally: no `dangerouslySetInnerHTML`, React output
  escaping, and (recommended) a strict Content-Security-Policy at the host.

Mitigations to keep in place:
- Keep access-token lifetime short; rely on refresh rotation (already
  implemented — `/auth/refresh` rotates both tokens).
- Never widen what the app renders as raw HTML.
- Ship a CSP that disallows inline/eval scripts (host/CDN responsibility).

Future hardening option: move the refresh token to an `HttpOnly; Secure;
SameSite=Strict` cookie and have the API set it. That requires backend support
and is out of scope for Phase 3.

### Reset token in URL (`api/accountApi.ts`) — accepted risk
`verifyResetToken()` sends the reset token as a `?token=` query parameter. This
is inherent to email-link password resets (the token *is* the link). Risks
(referrer leakage, browser history, intermediary logs) are mitigated by:

- `safeUrl()` redacting `token` before anything reaches the console log.
- Server requirements (must be enforced): single-use, short TTL, invalidated on
  use and on password change.

Recommendation: confirm the backend treats reset tokens as single-use and
short-lived, and set `Referrer-Policy: no-referrer` (or `same-origin`) on the
reset page.

### Login throttling lives on the server
The web client has no login throttle: a browser-side limiter is trivially
bypassed, so the old one was removed. Throttling is the API's job (failed-login
backoff in `apps/api/src/db/login-attempts.ts`, plus the Cloudflare zone rate
limit), and the client only surfaces the 429 and its `Retry-After`.

### HTTPS
Production config points at an `https://` origin, but nothing in the client
prevents running against an `http://` base URL if misconfigured. Enforce
transport security at the edge: HSTS, HTTP→HTTPS redirect, secure-cookie flags
if cookies are ever introduced.

---

## Open follow-ups (filed for later)

1. **Server-side parity**: password policy and reset-token single-use must be
   enforced on the API. The client rules are advisory. Login rate limiting is
   done: the API enforces it (audit row 9).
2. **Shared password policy**: `lib/validation.ts` duplicates rules the backend
   also needs. Consider promoting the policy into `@onlooker/auth-core` so
   client and server share one source of truth.
3. **CSP + security headers**: add `Content-Security-Policy`,
   `Referrer-Policy`, `X-Content-Type-Options`, and HSTS at the host.
4. **Component-level tests**: integration tests currently exercise the data
   path (client + token store + mock API). Rendering flows need a DOM harness
   (jsdom + `@testing-library/react`) — not yet in the workspace.

---

## Deployment security checklist

Before promoting a build to production:

- [ ] `VITE_API_BASE_URL` is an `https://` origin.
- [ ] `VITE_USE_MOCK_API=false` (never ship the mock API).
- [ ] `VITE_API_LOG_REQUESTS=false`.
- [ ] HSTS enabled and HTTP redirects to HTTPS at the CDN/host.
- [ ] Content-Security-Policy denies inline and `eval` scripts.
- [ ] `Referrer-Policy` set (`no-referrer` or `same-origin`), especially on the
      password-reset page.
- [ ] Backend enforces: password complexity, single-use short-TTL reset
      tokens, refresh-token rotation + reuse detection. (Login rate limiting
      is enforced in code and covered by audit row 9.)
- [ ] No secrets in the client bundle — only `VITE_*` public config is inlined.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm test` are green.
