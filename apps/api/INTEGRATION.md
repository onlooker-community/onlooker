# WS1 Database Integration Guide

This document describes the integration points for WS1 (database implementation) into the API scaffold created by WS2.

## Overview

The API is a Cloudflare Workers service with a complete route structure and type-safe endpoints. All database queries are stubbed with `TODO` comments indicating what WS1 needs to implement.

## Key Integration Points

### 1. User Authentication (`src/routes/auth.ts`)

#### `handleLogin` - POST /auth/login
**Stubs to replace:**
```typescript
// 1. Query D1: const user = await db.findByEmail(body.email)
// 2. Verify password: const validPassword = await bcrypt.compare(body.password, user.password_hash)
// 3. Generate JWT: const token = await signJwt({ sub: user.id, type: 'access', ... }, env.JWT_SECRET)
// 4. Store refresh token: await tokenStore.storeRefreshToken(user.email, refreshToken, expiresAt)
// 5. Record login: await userStore.recordLastLogin(user.id)
```

**Returns:**
```json
{
  "token": "eyJhbGc...",
  "refreshToken": "eyJhbGc...",
  "user": { "id": "user-123", "email": "user@example.com", "name": "User Name" }
}
```

#### `handleSignup` - POST /auth/signup
**Similar to login but also:**
- Hash password with bcrypt (cost 10)
- Create user record in D1
- Create verification token
- Queue verification email

#### `handleRefresh` - POST /auth/refresh
**Key operations:**
- Verify JWT signature using `env.JWT_SECRET`
- Check token revocation status
- Rotate both access and refresh tokens
- Revoke old refresh token

#### `handleMe` - GET /auth/me
**Requires:**
- Auth context extraction (implemented in middleware)
- Token revocation check
- User lookup by ID

#### `handleLogout` - POST /auth/logout
**Operations:**
- Revoke current access token
- Invalidate all sessions for user

### 2. Account Management (`src/routes/account.ts`)

#### `handleGetProfile` - GET /auth/profile
**Query:**
```sql
SELECT u.*, um.created_at, um.email_verified 
FROM users u 
JOIN user_metadata um ON u.id = um.user_id 
WHERE u.id = ?
```

#### `handleUpdateProfile` - PATCH /auth/profile
**Checks:**
- Email uniqueness if email is being changed
- Reset email verification if email changes

#### `handleChangePassword` - POST /auth/change-password
**Operations:**
- Verify current password
- Update password hash
- Revoke all active tokens (force re-login)

#### `handleDeleteAccount` - DELETE /auth/account
**Cascading deletes:**
- User record
- User metadata
- Refresh tokens
- Email verification tokens
- Password reset tokens

#### Email Verification Endpoints
- `handleVerifyEmail` - POST /auth/verify-email
- `handleResendVerification` - POST /auth/resend-verification

**Storage:**
- Tokens in D1 or KV with TTL (typically 24 hours)
- Single-use: delete after verification or resend

#### Password Reset Endpoints
- `handleForgotPassword` - POST /auth/forgot-password
- `handleVerifyResetToken` - GET /auth/reset-password/verify
- `handleResetPassword` - POST /auth/reset-password

**Storage:**
- Tokens in D1 or KV with 1-hour TTL
- Single-use: delete after successful reset

### 3. Protected Data (`src/routes/data.ts`)

#### `handleGetUserProfile` - GET /api/users/me
**Returns:** UserProfile with creation date and last login timestamp

#### `handleGetDashboard` - GET /api/dashboard
**Aggregates:**
- User info
- Session/activity statistics
- Recent activity log (last 10 events)

## Database Schema Requirements

### Users Table
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### User Metadata Table
```sql
CREATE TABLE user_metadata (
  user_id TEXT PRIMARY KEY,
  email_verified BOOLEAN DEFAULT FALSE,
  last_login_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### Tokens Tables (KV or D1)
```sql
-- Refresh tokens
CREATE TABLE refresh_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Revoked tokens (short TTL)
CREATE TABLE revoked_tokens (
  token TEXT PRIMARY KEY,
  expires_at TIMESTAMP NOT NULL
);

-- Email verification tokens
CREATE TABLE verification_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT FALSE
);

-- Password reset tokens
CREATE TABLE reset_tokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT FALSE
);
```

## JWT Requirements

### Access Token Payload
```json
{
  "sub": "user-id",
  "type": "access",
  "iat": 1704067200,
  "exp": 1704070800,
  "jti": 123
}
```

- **Signature:** RS256 (asymmetric) for production
- **TTL:** 3 minutes (configurable via `TOKEN_EXPIRY_MINUTES`)
- **Secret:** Use `env.JWT_SECRET` (will be private key in production)

### Refresh Token Payload
```json
{
  "sub": "user-id",
  "type": "refresh",
  "iat": 1704067200,
  "exp": 1735689600,
  "jti": 123
}
```

- **TTL:** 30 days (configurable via `REFRESH_TOKEN_EXPIRY_DAYS`)

## Implementation Order

1. **Phase 1 - User CRUD:**
   - Implement `UserStore` interface with D1 queries
   - Implement password hashing (bcrypt)
   - Test signup and login locally

2. **Phase 2 - JWT & Token Management:**
   - Implement JWT signing and verification (RS256)
   - Implement `TokenStore` for refresh token persistence
   - Test token refresh and rotation

3. **Phase 3 - Email Verification:**
   - Implement `VerificationTokenStore`
   - Implement email sending (Mailgun/SendGrid/similar)
   - Test verify-email flow

4. **Phase 4 - Password Reset:**
   - Implement `PasswordResetTokenStore`
   - Implement forgot-password flow
   - Test reset-password flow

5. **Phase 5 - Dashboard Data:**
   - Add activity tracking to login/logout/profile updates
   - Implement dashboard statistics queries
   - Test GET /api/dashboard

## Type References

All request/response types are defined in `src/types/`:
- `requests.ts` - Input validation types
- `responses.ts` - Output serialization types
- `index.ts` - Worker environment and context types

## Testing Against Web App

The web app (`apps/web/src/api/mockApi.ts`) provides reference implementations for all endpoints. After WS1 integration, replace:

```typescript
// In apps/web/src/api/client.ts
export const apiClient = createApiClient({
  baseUrl: "http://localhost:8787", // wrangler dev
  // ... rest of config
});
```

Then run `pnpm dev` in both `apps/api` and `apps/web` to test integration.

## Environment Variables

All environment variables are typed in `WorkerEnv` interface (`src/types/index.ts`):

```typescript
DB_HOST: string;
DB_PORT: string;
DB_NAME: string;
JWT_SECRET: string;
TOKEN_EXPIRY_MINUTES: string;
REFRESH_TOKEN_EXPIRY_DAYS: string;
DB?: D1Database;
TOKEN_REVOCATION?: KVNamespace;
```

Configure these in:
- `wrangler.toml` - for development
- Cloudflare dashboard - for production

## Error Handling

All errors follow the `ApiError` format defined in `src/types/index.ts`:

```typescript
class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown
  ) { ... }
}
```

This ensures consistent error responses across all endpoints.
