# Only a 401 Signs You Out — Design

Linear: ONL-243. This follows the per-account limit
(`docs/superpowers/specs/2026-11-03-account-rate-limit-design.md`, ONL-222,
#258).

**The web app clears a session only when the server says it's gone, with a
401.** A 429, a 5xx or a network failure keeps the tokens. The person sees "Can't
reach Onlooker right now" and the app retries.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-11-03.
Sections marked *(measured)* were read from this repository on 2026-11-03.
Sections marked *(proposed)* are this document's own.

## The gap *(measured)*

Every path that checks the session treats any failure as a sign-out:

- **Page load** (`packages/auth-react/src/index.tsx`, the hydrate effect,
  about :373-400): if `loadSession` throws for any reason, it calls
  `clearToken` and `onLogoutCleanup`. That includes a 429, a 5xx, and being
  offline. `onLogoutCleanup` clears the refresh token too
  (`apps/web/src/auth.ts:125`).
- **Proactive refresh** (`refresh`, about :354-364): any failure calls
  `performLogout`. In the web app, `refreshSession` (`auth.ts:113-119`)
  rotates the refresh token, then calls `/auth/me`. A 429 there throws away the
  token that was just rotated.
- **Cross-tab re-hydrate** (the storage handler, about :467-476): same.
- **The refresh call** (`apps/web/src/api/client.ts`, `performRefresh`,
  about :206-210): any non-OK answer clears the tokens. That includes a 429
  from the zone rule, which allows 6 `/auth/*` requests per 10 seconds per IP.
  A network error is the one case that already keeps them (:226-229).

Since #258, `/auth/me` is a counted route, so an account over its budget
signs out every tab that loads or refreshes.

The browser can't read `Retry-After` either. The API sends no
`Access-Control-Expose-Headers`, and the web app is on a different origin from
`api.onlooker.dev`, so `response.headers.get("Retry-After")` is null in
`client.ts`. That undercuts the login backoff and the mail-cap handling, which
assume the header can be read (the comment at `client.ts:159-162`).

## The rule *(approved)*

- **401 means the session is gone.** Clear the tokens and redirect to `/login`,
  as today.
- **400 from `/auth/refresh` also means gone.** It's "Refresh token is
  required" (`apps/api/src/routes/auth.ts:235`), which can't recover. This
  applies only to the refresh call.
- **Anything else is transient:** 429, 5xx, a network failure or a timeout.
  Keep the tokens and retry.
- **A failure that leaves no token behind is a sign-out**, whatever was
  thrown. The web app's `refreshTokens` returns only `true` or `false`, and it
  clears the tokens itself on a 400 or 401, so `refreshSession` throws a plain
  `Error` either way. The auth layer checks whether the access token is still
  stored instead of trusting the error's type. Otherwise a rejected refresh
  would retry forever with nothing to retry with.

## What the person sees *(approved)*

- **On page load**, when the check fails transiently: the usual app frame,
  with "Can't reach Onlooker right now. Trying again in N s." and a **Try
  again** button. It's written as an `aria-live="polite"` status. The app
  retries on its own at the scheduled time, and **Try again** retries
  immediately. When a check succeeds, the page renders as normal.
- **Mid-session**, when the proactive refresh fails transiently: nothing
  visible. The person is already signed in, and the access token is still good
  for about a minute, so the refresh retries quietly. If the token expires
  first, the existing reactive path takes over: the next request gets a 401,
  then refreshes.

## When to retry *(approved)*

- After `Retry-After`, when the server sent one.
- Otherwise a backoff of 5, 10, 20, 40, then 60 seconds, capped at 60. The
  count resets after a success.

## The code *(proposed)*

**API: `apps/api/src/middleware/cors.ts`.** Add `Access-Control-Expose-Headers:
Retry-After` to both branches, the app origins and the public wildcard.
Preflight responses don't need it, because it only applies to the actual
response.

**`packages/auth-core`.** `AuthApiError` gains an optional
`retryAfterMs?: number`. It's set from a parsed `Retry-After` (seconds, or an
HTTP date), and left undefined when the header is missing or unparseable.

**`packages/auth-react`.**

- `createAuthApiClient` reads `Retry-After` on a non-OK response and passes it
  to `AuthApiError`.
- A predicate, `isSessionGone(error)`, is true only for an `AuthApiError` whose
  status is 401. Everything else, including a non-`AuthApiError` throw, is
  transient.
- State gains `unavailable: { retryAt: number } | null`. It's cleared by
  `applySession` and `resetState`.
- **Hydrate:** on a transient failure, keep the tokens, set `loading: false`
  and `unavailable`, and schedule another hydrate at `retryAt`. The pending
  timer is canceled on unmount and on a manual retry.
- **Proactive refresh:** on a transient failure, keep the user and the tokens,
  don't set `unavailable`, and schedule another `refresh` at `retryAt`. A 401
  logs out as today.
- **Cross-tab re-hydrate:** same rule as hydrate.
- **`RequireAuth`** gains `unavailableFallback?: (state: { retryAt: number;
  retry: () => void }) => ReactNode`. When `unavailable` is set and there's no
  user, it renders the fallback rather than redirecting to `/login`. Without a
  fallback, it renders `loadingFallback`, so a consumer that doesn't opt in
  sees the loading screen, not a sign-out.
- `retry` runs a hydrate immediately and cancels the scheduled one.

**Web: `apps/web/src/api/client.ts`.**

- `performRefresh` clears the tokens only on 400 or 401. On any other non-OK
  status it keeps them and returns `false`, as it already does for a network
  error.
- The reactive path in `authenticatedFetch` is a fifth sign-out: a request
  answered 401, the refresh failed, and it calls `tokenStore.clear()` and
  `onUnauthorized` (about :270-278). It should do that only when the refresh
  token is gone, which means `performRefresh` saw a 400 or 401. When the
  refresh failed transiently, it keeps the tokens and answers the caller with
  a synthesized **503**, code `session_unavailable`, not the original 401.
  Passing the 401 on would undo the fix: `createAuthApiClient` clears the
  access token on any 401 it sees (`packages/auth-react/src/index.tsx`, about
  :96-99). A 503 reaches auth-react as a transient failure, and it retries.

**Web: `apps/web/src/App.tsx`.** `Protected` passes an `unavailableFallback`
that renders the `AppShell` with the notice and the button. The countdown
updates once a second.

## Tests *(proposed)*

- **API (`middleware/cors.test.ts`):** both branches send
  `Access-Control-Expose-Headers: Retry-After`.
- **auth-core:** `AuthApiError` carries `retryAfterMs`.
- **auth-react:** with a fake `loadSession` and fake timers:
  - Hydrate with a 401 clears the tokens and resets.
  - Hydrate with a 429 and `retryAfterMs` keeps the tokens, sets `unavailable`
    with that `retryAt`, and succeeds on the scheduled retry.
  - Hydrate with a network error uses the backoff.
  - The backoff runs 5, 10, 20, 40, 60, 60 seconds.
  - `retry()` hydrates immediately and cancels the scheduled one.
  - Proactive refresh with a 429 keeps the user and retries. With a 401 it logs
    out.
  - Cross-tab re-hydrate follows the hydrate rule.
  - `RequireAuth` renders `unavailableFallback` when it's set, falls back to
    `loadingFallback` without one, and never redirects while unavailable.
  - `createAuthApiClient` parses `Retry-After` in both forms.
- **Web (`api/client.test.ts`):** `performRefresh` keeps the tokens on 429 and
  503, and clears them on 400 and 401. A request that 401s while the refresh
  gets a 429 keeps the tokens, answers 503 `session_unavailable`, and doesn't
  call `onUnauthorized`.
- **Web:** the `Protected` route renders the notice, and **Try again** re-runs
  the check.

## Out of scope

- **Several tabs refreshing at once** can trip the zone rule. After this change
  that only delays the refresh, but it doesn't sign anyone out. Refresh-token
  rotation reuse across tabs is a separate question.
- **The CLI's 429 handling** is ONL-242.
