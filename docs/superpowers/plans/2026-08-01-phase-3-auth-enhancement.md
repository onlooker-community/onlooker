# Phase 3: Auth Enhancement — Comprehensive Implementation Plan

> **Goal:** Evolve the Phase 2 auth scaffold into production-ready authentication with real API integration, enhanced features, session management, protected resources, and security hardening.

**Timeline:** 5 workstreams, executing in parallel with 2-week iterations

**Overall Architecture:** 
- Real backend API integration (from onlooker-app)
- Stateful session management with token refresh
- Signup/password recovery flows
- Protected API client middleware
- Comprehensive security & testing

---

## Workstream 1: Real API Integration (Week 1-2)

**Goal:** Replace mock API with production endpoints and implement token refresh flow.

### Tasks

#### Task 1.1: Extract API Client Configuration
- Read existing API setup from onlooker-app
- Map endpoints: login, signup, logout, refresh, me
- Document auth header format and token lifecycle
- Create API config in web app: `src/api/apiClient.ts`

#### Task 1.2: Implement Token Refresh
- Add refresh token storage (localStorage: `auth_refresh_token`)
- Implement refresh endpoint call on 401 response
- Add token refresh middleware to API client
- Handle refresh token expiration gracefully

#### Task 1.3: Replace Mock API
- Update auth.ts to use real endpoints
- Test against staging/dev backend
- Add environment variables for API base URL
- Implement request/response logging for debugging

#### Task 1.4: Error Handling & Retry Logic
- Implement exponential backoff for failed requests
- Handle network timeouts gracefully
- Add user-friendly error messages
- Log errors for monitoring

**Validation:**
- pnpm typecheck passes
- pnpm build succeeds
- Integration with real API endpoints works
- Token refresh flow tested manually

---

## Workstream 2: Authentication Features (Week 1-3)

**Goal:** Build complete signup, password recovery, and settings flows.

### Tasks

#### Task 2.1: Signup Form
- Create `src/pages/SignupPage.tsx` with email, password, name fields
- Add password strength meter
- Implement confirmation email flow (if required)
- Success redirects to login or auto-login

#### Task 2.2: Forgot Password Flow
- Create `src/pages/ForgotPasswordPage.tsx` with email input
- Implement reset link generation
- Create `src/pages/ResetPasswordPage.tsx` for reset
- Add confirmation and error handling

#### Task 2.3: Account Settings
- Create `src/pages/SettingsPage.tsx` (protected route)
- Update profile (name, email)
- Change password form
- Delete account option

#### Task 2.4: Email Verification (if required)
- Add email verification check in session
- Create verification page with resend link
- Block access to protected routes until verified

**Validation:**
- All forms validate input correctly
- API calls succeed
- Error states handled properly
- Typecheck and lint pass

---

## Workstream 3: Session Management (Week 1-2)

**Goal:** Implement production-ready session lifecycle and persistence.

### Tasks

#### Task 3.1: Session Hydration on Load
- Modify `useAuthState()` to call `/auth/me` on app boot
- Restore session from localStorage tokens
- Handle token refresh if needed
- Show loading state while hydrating

#### Task 3.2: Token Expiration Handling
- Calculate token expiration from JWT
- Warn user before expiration (5-min warning)
- Auto-refresh before expiration
- Force re-login on refresh failure

#### Task 3.3: Logout Cleanup
- Clear localStorage tokens
- Call `/auth/logout` endpoint
- Clear any auth-related session state
- Redirect to login page

#### Task 3.4: Multi-Tab Synchronization
- Listen for storage events (logout in another tab)
- Sync auth state across tabs
- Force logout if session invalidated elsewhere

**Validation:**
- Session persists on page reload
- Token refresh works transparently
- Logout clears all state
- Multi-tab sync tested

---

## Workstream 4: Protected Resources (Week 2-3)

**Goal:** Integrate authenticated API calls throughout the web app.

### Tasks

#### Task 4.1: Authenticated API Client
- Create `src/api/authenticatedFetch.ts` with auth middleware
- Auto-inject Authorization header
- Handle 401 errors with token refresh
- Retry failed requests after refresh

#### Task 4.2: User Profile Page
- Create `src/pages/ProfilePage.tsx` (protected)
- Fetch and display user data from `/api/users/me`
- Show user info, email, account creation date
- Link to settings page

#### Task 4.3: Protected Data Fetching
- Create custom hook `useAuthenticatedFetch()` for API calls
- Implement loading, error, data states
- Auto-retry with exponential backoff
- Handle auth errors gracefully

#### Task 4.4: Dashboard Enhancements
- Update dashboard with real user data
- Add activity/analytics (if available from API)
- Link to profile, settings, activity log

**Validation:**
- Protected routes require auth
- API calls include Authorization header
- Token refresh transparent to user
- All protected pages load correctly

---

## Workstream 5: Testing & Security (Week 2-3)

**Goal:** Comprehensive testing, security hardening, and production readiness.

### Tasks

#### Task 5.1: Integration Tests
- Test full auth flow: signup → login → access protected resource → logout
- Test token refresh flow
- Test error handling (invalid credentials, network failure)
- Test session expiration

#### Task 5.2: Security Audit
- Verify no tokens in URLs or logs
- Check HTTPS-only cookie flags (if cookies used)
- Validate CSRF protection
- Check XSS prevention in forms
- Audit localStorage security

#### Task 5.3: Password Validation
- Implement password strength rules (min 8 chars, mix of types)
- Add visual strength meter on signup
- Validate against common passwords
- Client-side and server-side validation

#### Task 5.4: Rate Limiting & Brute Force Protection
- Implement client-side rate limiting
- Detect repeated login failures
- Add CAPTCHA support (optional for Phase 3)
- Log suspicious activity

#### Task 5.5: Documentation & Runbooks
- Document auth flow for developers
- Create troubleshooting guide
- Document environment variables
- Create deployment checklist

**Validation:**
- All integration tests pass
- Security review checklist complete
- No console warnings about auth
- Passwords meet complexity requirements
- Rate limiting prevents brute force

---

## Cross-Cutting Concerns

### Environment Configuration
```bash
# .env.development
VITE_API_BASE_URL=http://localhost:3000
VITE_AUTH_TOKEN_KEY=auth_token
VITE_AUTH_REFRESH_KEY=auth_refresh_token

# .env.production
VITE_API_BASE_URL=https://api.onlooker.dev
```

### Dependency Updates
- `axios` or `fetch` wrapper for authenticated requests
- `js-cookie` for secure cookie handling (if needed)
- `jsonwebtoken` for token parsing (client-side)
- `date-fns` for token expiration calculations

### Type Safety
- Export API response types from backend
- Use generated types from API schema (if available)
- Type user/session objects consistently

### Error Handling Strategy
```typescript
// Consistent error structure
type ApiError = {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};
```

---

## Success Criteria

- [ ] Real API endpoints integrated and tested
- [ ] Token refresh flow works seamlessly
- [ ] Signup, forgot password, settings pages complete
- [ ] Protected routes enforce authentication
- [ ] Session persists across page reloads
- [ ] Multi-tab logout synchronization works
- [ ] All integration tests pass (>90% coverage)
- [ ] Security audit checklist complete
- [ ] No console warnings or errors
- [ ] Deployment guide documented
- [ ] Performance benchmarked (API response times < 500ms)

---

## Parallel Execution Strategy

**Week 1:** All 5 workstreams begin in parallel
- WS1: Extract API config, mock → real integration
- WS2: Signup form, email verification prep
- WS3: Session hydration, token expiration logic
- WS4: Authenticated fetch client, profile page scaffolds
- WS5: Integration test setup, security audit checklist

**Week 2:** Integration & refinement
- WS1: Token refresh testing and edge cases
- WS2: Password recovery, account settings complete
- WS3: Multi-tab sync, logout cleanup
- WS4: Protected resources wired through app
- WS5: Full integration tests, security review

**Week 3:** Polish & shipping
- Cross-workstream integration testing
- Documentation and runbooks
- Performance optimization
- Deployment prep
- Final security review

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Backend API unavailable | Use mock API fallback; test against staging first |
| Token refresh loops | Implement max retry limit; force re-login after failures |
| Sensitive data leaks | Audit storage usage; never log tokens; HTTPS only |
| Performance degradation | Implement request caching; optimize API calls |
| Auth state desync | Use events for multi-tab sync; clear state on logout |

---

## Definition of Done (Per Task)

- [ ] Code complete and committed
- [ ] Tests written and passing (new code tested)
- [ ] TypeScript: zero errors on `pnpm typecheck`
- [ ] Biome: zero errors on `pnpm lint`
- [ ] Build succeeds: `pnpm build`
- [ ] Manual testing: feature works end-to-end
- [ ] Docs updated (comments, README)
- [ ] No console errors or warnings
- [ ] Code reviewed by peer (async)

---

## Success Timeline

- **End of Week 1:** API integration 90% complete, signup form working
- **End of Week 2:** All features implemented, integration tests 80%+ passing
- **End of Week 3:** Production ready, security reviewed, documented

**Total Expected Effort:** 25-30 engineer-days across 5 parallel tracks

---

## Next Steps

1. Create 5 subagents (one per workstream)
2. Each subagent owns their track's tasks and integration points
3. Daily sync on cross-workstream dependencies
4. Deploy to staging end of Week 2, production Week 3
