# Phase 2: Auth Foundation — Design Spec

**Date:** 2026-08-01  
**Status:** Design Approved  
**Approach:** Hybrid (extract auth-core, build auth-react fresh)

## Overview

Implement working end-to-end authentication in the monorepo. Extract type-safe auth logic from the existing codebase into `@onlooker/auth-core`, build React integration fresh in `@onlooker/auth-react`, and integrate into the web app with mock API endpoints. Users can sign up, log in, access protected routes, and persist sessions via localStorage.

## Goals

1. Extract reusable auth-core types, schemas, and validation
2. Build React auth integration (hooks, providers, guards) with clean patterns
3. Implement login/signup flow in the web app with mock API
4. Verify sessions persist across page reloads
5. Establish foundation for Phase 3+ where mock API is replaced with real backend

## Architecture

### Three-Tier Auth System

**Tier 1: @onlooker/auth-core (Pure TypeScript)**
- Token types and claims (user vs machine tokens)
- Zod validation schemas (LoginInput, SignupInput, etc.)
- Error handling (AuthApiError class)
- Type utilities and guards (isUserTokenClaims, etc.)
- No React, no backend framework—pure types and validation

**Tier 2: @onlooker/auth-react (React Integration)**
- `AuthTokenStorage` interface + localStorage implementation
- `createAuthApiClient` factory for mocked HTTP calls
- `createReactAuth` factory for generic auth state (login, logout, signup, refresh)
- Exported React components: `AuthProvider`, `RequireAuth`
- Exported hook: `useAuth()`
- Flexible design allows swapping mock client for real API in Phase 3

**Tier 3: @onlooker/web (Web App Integration)**
- Mock API layer (intercepts `/auth/*` calls, returns hardcoded responses)
- LoginPage component with email/password form
- Dashboard component (minimal—placeholder for authenticated content)
- Auth provider wraps root App
- Routes: `/login`, `/dashboard` (protected), home (public)

### Data Flow

```
User enters credentials
    ↓
LoginPage form submission
    ↓
useAuth().login(email, password)
    ↓
Mock API endpoint /auth/login
    ↓
Returns { token, user }
    ↓
Token stored in localStorage
    ↓
Auth state updated → user is logged in
    ↓
Redirect to /dashboard
    ↓
RequireAuth guard checks auth.user
    ↓
If authenticated: render Dashboard
If not: redirect to /login
```

**On Page Reload:**
1. Auth-react checks localStorage for token
2. If token exists, calls mock `/auth/me` endpoint
3. If valid, loads user data; if expired, clears localStorage
4. Dashboard only renders after auth state is loaded

## File Structure

### New Files

```
packages/auth-core/src/
├── index.ts                          # Extract from existing repo
    ├── Token types (TokenKind, BaseTokenClaims, UserTokenClaims, MachineTokenClaims)
    ├── Zod schemas (loginInputSchema, signupInputSchema, etc.)
    ├── Error class (AuthApiError)
    ├── Utility functions (isUserTokenClaims, parseAuthTokenClaims, etc.)
    └── Generic types (AuthResponse<T>, AuthSession<T>)

packages/auth-react/src/
├── index.tsx                         # Main exports
    ├── AuthTokenStorage interface
    ├── createLocalStorageTokenStorage() factory
    ├── createAuthApiClient() factory (mock implementation)
    ├── createReactAuth() factory
    │   ├── AuthContext
    │   ├── AuthProvider component
    │   ├── RequireAuth component
    │   ├── useAuth() hook
    │   └── useAuthState() hook
    └── Re-exports from auth-core

apps/web/src/
├── main.tsx                          # Root entry (wrap App in AuthProvider)
├── App.tsx                           # Add routes, wire auth
├── pages/
│   ├── LoginPage.tsx                 # Login form + mock signup
│   └── DashboardPage.tsx             # Protected route (logged-in placeholder)
├── components/
│   ├── LoginForm.tsx                 # Email/password form
│   └── RequireAuthGuard.tsx          # Optional wrapper
└── api/
    └── mockApi.ts                    # Intercept /auth/* calls, return mock responses
```

### Modified Files

```
packages/auth-core/
├── package.json                      # Already has zod, tsconfig correct
├── tsconfig.json                     # Already extends shared config
└── biome.json                        # Already extends shared config

packages/auth-react/
├── package.json                      # Already has react, @onlooker/auth-core
├── tsconfig.json                     # Already extends shared config
└── biome.json                        # Already extends shared config

apps/web/
├── src/main.tsx                      # Wrap App in AuthProvider
├── src/App.tsx                       # Add routes (login, dashboard, home)
├── package.json                      # Add @onlooker/auth-react dependency
└── vite.config.ts                    # No changes needed
```

## Implementation Details

### @onlooker/auth-core

**Extract from existing onlooker-app/packages/auth-core:**
- All token type definitions and claim interfaces
- All Zod validation schemas (login, signup, password change)
- AuthApiError class with status, code, details
- Utility functions and type guards
- AuthResponse<T> and AuthSession<T> generic types

**Key exports:**
```typescript
export interface UserTokenClaims { sub: string; kind: "user"; iat?: number; exp?: number }
export interface MachineTokenClaims { sub: string; kind: "machine"; machine_id: string }
export type AuthTokenClaims = UserTokenClaims | MachineTokenClaims

export const loginInputSchema // { email: string; password: string }
export const signupInputSchema // { email: string; password: string; name?: string }

export class AuthApiError extends Error { status, code, details }
export interface AuthResponse<TUser> { token: string; user: TUser }
export type AuthSession<TUser> = { user: TUser }
```

### @onlooker/auth-react

**Build fresh from scratch (reference existing repo):**

1. **AuthTokenStorage interface** — abstract token persistence
   ```typescript
   export interface AuthTokenStorage {
     getToken(): string | null;
     setToken(token: string): void;
     clearToken(): void;
   }
   ```

2. **createLocalStorageTokenStorage()** — localStorage implementation
   - Stores token under key "auth_token"
   - Graceful fallback if localStorage unavailable

3. **createAuthApiClient()** — mock HTTP factory
   ```typescript
   // Returns { get, post, patch, delete, request }
   // For Phase 2: hardcoded mock responses
   // For Phase 3+: replace with real fetch calls
   ```

4. **createReactAuth()** — generic auth state factory
   ```typescript
   export function createReactAuth<TUser, TExtra extends object>(options: {
     tokenStorage: AuthTokenStorage;
     initialState: TExtra;
     loadSession: () => Promise<AuthSession<TUser>>;
     login: (email: string, password: string) => Promise<AuthResponse<TUser>>;
     signup: (email: string, password: string, name?: string) => Promise<AuthResponse<TUser>>;
     logout?: () => void;
   })
   // Returns { AuthProvider, AuthContext, useAuth, RequireAuth, useAuthState }
   ```

5. **React components**
   - `AuthProvider`: Context provider wrapping the app
   - `RequireAuth`: Guard component—redirects to /login if not authenticated
   - `useAuth()`: Hook to access auth state and actions from any component

### @onlooker/web Integration

**1. Mock API Layer (apps/web/src/api/mockApi.ts)**
```typescript
// Intercept fetch calls to /auth/* endpoints
// Returns hardcoded responses:
// POST /auth/login → { token: "mock-jwt-...", user: { id: "1", email, name } }
// POST /auth/signup → same as login
// GET /auth/me → { user: { id: "1", email, name } }
// POST /auth/logout → { success: true }
```

**2. Login Form Component**
- Email input (required, email validation)
- Password input (required, min 8 chars)
- Submit button
- Error message display
- Loading state during login
- Link to signup (mock implementation for Phase 2)

**3. Dashboard Page**
- Placeholder content: "Welcome, {user.name}!"
- Logout button
- Protected by RequireAuth guard

**4. Root App Setup**
- Wrap in AuthProvider at root
- Set up routes:
  - `/` (home) — public, shows login/dashboard buttons
  - `/login` — login form
  - `/dashboard` — protected, requires auth
- Handle redirect after login

## API Mocking Strategy

**Phase 2 (Current):**
- All API calls return hardcoded mock responses
- No actual backend communication
- Allows testing full auth flow in isolation

**Mock endpoints:**
```
POST /auth/login { email, password }
  → { token: "mock-jwt-signed-payload", user: { id: "1", email: "test@example.com", name: "Test User" } }

POST /auth/signup { email, password, name }
  → same as login

GET /auth/me (with Authorization: Bearer token)
  → { user: { id: "1", email: "test@example.com", name: "Test User" } }

POST /auth/logout
  → { success: true }
```

**Transition to Phase 3:**
- Create real API endpoints in `@onlooker/api`
- Replace mock client with real HTTP calls
- Keep auth-react and auth-core unchanged (no React changes needed)

## Testing Strategy

**@onlooker/auth-core:**
- Unit tests for Zod schema validation
- Unit tests for error class
- Unit tests for type guards

**@onlooker/auth-react:**
- Component tests for AuthProvider, RequireAuth
- Hook tests for useAuth
- Mock token storage tests

**@onlooker/web:**
- Component tests for LoginForm, Dashboard
- Integration test: full login flow (form submission → redirect)
- Integration test: session persistence (reload page, auth state restored)
- Integration test: protected routes redirect unauthenticated users

## Success Criteria

- [ ] @onlooker/auth-core extracts and exports all types, schemas, validation
- [ ] @onlooker/auth-react implements useAuth hook, AuthProvider, RequireAuth
- [ ] @onlooker/web has working login form, mock API, protected routes
- [ ] User can sign up with email/password
- [ ] User can log in with credentials
- [ ] Token stored in localStorage
- [ ] Protected routes redirect unauthenticated users to /login
- [ ] Page reload preserves authentication (if token in storage)
- [ ] Logout clears session and token
- [ ] All tests pass

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Extraction introduces subtle bugs | Keep extraction minimal—types only, no logic changes |
| Mock API too rigid for real API | Use generic createAuthApiClient so swap is painless in Phase 3 |
| Token expiration not handled | Mock JWT never expires for Phase 2; Phase 3 adds refresh logic |
| Session not preserved across page reloads | loadSession check on mount handles this |
| Type mismatches between auth-core and auth-react | Generic types <TUser> ensure compatibility |

## Decisions Recorded

- Hybrid approach: extract auth-core types, build auth-react fresh for clean patterns and understanding
- localStorage for token storage (simple, works for browser-based auth)
- Mock API in web app (fastest path to working auth without backend)
- Generic factories in auth-react allow flexible integration in future phases
- No password reset, no multi-factor auth—Phase 2 focuses on core login flow only
