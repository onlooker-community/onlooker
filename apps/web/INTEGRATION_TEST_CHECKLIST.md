# API Integration Test Checklist

Use this checklist when testing the web app against the real Cloudflare Workers API backend.

**Prerequisite:** Both servers running
- API: `cd apps/api && pnpm dev` (http://localhost:8787)
- Web: `cd apps/web && pnpm dev` (http://localhost:5173)

## Core Authentication Flows

### Signup Flow
- [ ] Navigate to http://localhost:5173/signup
- [ ] Enter valid email (e.g., newuser@example.com)
- [ ] Enter password (8+ characters)
- [ ] Enter optional name
- [ ] Submit form
- [ ] ✅ Success: JWT tokens in localStorage, redirected to /lessons
- [ ] ✅ DevTools: POST /auth/signup returns 200 with token + refreshToken
- [ ] ✅ Browser: Check Application tab → localStorage has auth_token and auth_refresh_token

### Login Flow
- [ ] Navigate to http://localhost:5173/login
- [ ] Enter existing user email
- [ ] Enter correct password
- [ ] Submit form
- [ ] ✅ Success: JWT tokens in localStorage, redirected to /lessons
- [ ] ✅ DevTools: POST /auth/login returns 200 with token + refreshToken
- [ ] ✅ Profile page loads with user name and email

### Logout Flow
- [ ] While logged in, click Logout button
- [ ] ✅ Tokens cleared from localStorage
- [ ] ✅ Redirected to home/login page
- [ ] ✅ Attempting to access /lessons redirects to /login

## Token Management

### Token Refresh
- [ ] Login successfully
- [ ] Open DevTools → Console
- [ ] Note current access token expiration time (in dev: ~3 minutes)
- [ ] Wait for access token to expire or manually wait ~3 minutes
- [ ] Make any authenticated request (navigate to /profile)
- [ ] ✅ DevTools shows: POST /auth/refresh succeeds
- [ ] ✅ New token received and stored
- [ ] ✅ Original request (GET /api/users/me) retried and succeeds
- [ ] ✅ No 401 response visible to user

### Unauthorized Handling
- [ ] Login successfully
- [ ] Open DevTools → Application → localStorage
- [ ] Delete the auth_token manually
- [ ] Attempt to access /profile or any protected page
- [ ] ✅ 401 response triggers
- [ ] ✅ Refresh fails (no valid refresh token path)
- [ ] ✅ User redirected to /login
- [ ] ✅ Session cleared

## Protected Resources

### Profile Page
- [ ] Login successfully
- [ ] Navigate to http://localhost:5173/profile
- [ ] ✅ Page loads without errors
- [ ] ✅ User data displayed (name, email, createdAt, lastLoginAt)
- [ ] ✅ DevTools: GET /api/users/me includes Authorization header
- [ ] ✅ DevTools: Response status 200, correct user data returned

## Account Management

### Password Change
- [ ] Login successfully
- [ ] Navigate to /settings (or password change page)
- [ ] Enter current password
- [ ] Enter new password (8+ characters)
- [ ] Confirm new password
- [ ] Submit form
- [ ] ✅ Success message displayed
- [ ] ✅ DevTools: POST /auth/change-password returns 200
- [ ] Logout
- [ ] ✅ Login with new password succeeds
- [ ] ✅ Login with old password fails with "Invalid email or password"

### Update Profile
- [ ] Login successfully
- [ ] Navigate to /settings or /profile
- [ ] Update name field
- [ ] Submit form
- [ ] ✅ Success message displayed
- [ ] ✅ DevTools: PATCH /auth/profile returns 200
- [ ] Refresh page
- [ ] ✅ Updated name persists

## Error Cases

### Invalid Credentials
- [ ] Navigate to /login
- [ ] Enter non-existent email
- [ ] Enter any password
- [ ] Submit form
- [ ] ✅ Error message: "Invalid email or password"
- [ ] ✅ DevTools: POST /auth/login returns 401
- [ ] Try with correct email, wrong password
- [ ] ✅ Same error message (no email enumeration)

### Network Errors
- [ ] Stop the API server (Ctrl+C)
- [ ] Attempt login
- [ ] ✅ Error displayed: "Request failed" or "Network error"
- [ ] ✅ DevTools: Request fails (network error or timeout)
- [ ] Restart API server
- [ ] ✅ Login succeeds

### Timeout Errors
- [ ] Configure API to have very slow response (add delay in handler or use network throttling)
- [ ] Attempt any request
- [ ] ✅ Request times out (after ~15 seconds)
- [ ] ✅ Error message: "Request timed out"
- [ ] ✅ Retry behavior triggered (if applicable)

## Request Logging

### Console Logging
- [ ] Verify `VITE_API_LOG_REQUESTS=true` in .env.development
- [ ] Restart web app if it was running
- [ ] Open DevTools → Console
- [ ] Login
- [ ] ✅ Console shows logged API calls: method, URL, status, duration
- [ ] ✅ Tokens are redacted in logs (showing "Bearer [redacted]" not actual token)

## Session Persistence

### Page Reload
- [ ] Login successfully
- [ ] Reload page (F5)
- [ ] ✅ Tokens persisted in localStorage
- [ ] ✅ Session restored automatically

### Tab Sync (WS3)
- [ ] Login in Tab A
- [ ] Open Tab B, navigate to app
- [ ] ✅ Tab B shows logged-in state (session synced)
- [ ] Logout in Tab A
- [ ] ✅ Tab B detects logout and redirects to login (within a few seconds)

## Edge Cases

### Multiple Rapid Requests
- [ ] Login successfully
- [ ] Trigger multiple API calls in rapid succession (click multiple links, etc.)
- [ ] ✅ All requests succeed
- [ ] ✅ No race conditions in token refresh
- [ ] ✅ No duplicate refresh calls (single-flight)

### Concurrent Token Refresh
- [ ] Multiple tabs open to same app
- [ ] In one tab, trigger an action that requires 401 + refresh
- [ ] In another tab, trigger an action that requires 401 + refresh
- [ ] ✅ Single `/auth/refresh` call issued (not one per tab)
- [ ] ✅ Both tabs receive new tokens

### Very Short Token Lifetime
- [ ] Set `ACCESS_TOKEN_TTL_SECONDS` to 10 seconds in mock or backend
- [ ] Login and stay on /lessons
- [ ] ✅ Token auto-refreshes at ~9 seconds (proactive refresh from WS3)
- [ ] ✅ No interruption to user experience

## Performance

### Request Latency
- [ ] Open DevTools → Network
- [ ] Login
- [ ] ✅ POST /auth/login completes in <500ms
- [ ] Navigate to /profile
- [ ] ✅ GET /api/users/me completes in <200ms
- [ ] ✅ Retry-After is respected (no thundering herd)

### Bundle Size
- [ ] Build production: `npm run build` in apps/web
- [ ] ✅ No significant size increase from API integration
- [ ] Check that mock API code is tree-shaken when `VITE_USE_MOCK_API=false`

## Final Sign-Off

- [ ] All core flows work (signup, login, logout, token refresh)
- [ ] All protected resources load correctly
- [ ] Error handling is graceful
- [ ] Logging output is helpful (tokens redacted)
- [ ] No console errors or warnings (except expected browser CORS preflight)
- [ ] Session persists across page reloads
- [ ] Cross-tab sync works (if WS3 implemented)
- [ ] Performance is acceptable

**Ready for merge:** ✅ / ❌

**Tester:** _________________  
**Date:** _________________  
**Notes:** _________________________________________________________________
