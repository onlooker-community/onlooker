# Database Integration Guide

This guide shows how the Onlooker API (WS2) will integrate with the D1 database using Drizzle ORM.

## Architecture Overview

```
┌─────────────────┐
│   Web App       │  (React + Vite)
│  - React Auth   │  - Sign up / Login / Password Reset
│  - Fetch API    │  - Sends credentials to /auth/* endpoints
└────────┬────────┘
         │ HTTPS
         │
┌────────▼────────────────────────────┐
│  Cloudflare Worker (API)             │
│  - Fastify/Hono server               │
│  - Auth handlers                     │
│  - Protected resource endpoints      │
└────────┬────────────────────────────┘
         │
┌────────▼────────────────────────────┐
│  Cloudflare D1 (SQLite)              │
│  - users table                       │
│  - sessions (refresh tokens)         │
│  - email_verification_tokens         │
│  - password_reset_tokens             │
│  - email_change_tokens               │
│  - machine_tokens                    │
│  - audit_logs                        │
└──────────────────────────────────────┘
```

## Environment Configuration

### wrangler.toml

Define the D1 database binding:

```toml
name = "onlooker"
type = "service"
compatibility_date = "2024-11-21"
compatibility_flags = ["nodejs_compat"]

# D1 Database binding
[[d1_databases]]
binding = "DB"
database_name = "onlooker"
database_id = "YOUR_DATABASE_ID"

# (Optional) For local development, add a second binding
[[d1_databases]]
binding = "DB"
database_name = "onlooker"
database_id = "00000000-0000-0000-0000-000000000000"
preview = true
```

### Cloudflare Workers Handler Interface

```typescript
// apps/api/src/types.ts
import { D1Database } from "@cloudflare/workers-types";

export interface ApiEnv {
  DB: D1Database;
  ENVIRONMENT: string;  // "development" | "staging" | "production"
  SECRET_JWT_KEY: string;
  SECRET_REFRESH_TOKEN_KEY: string;
  SECRET_EMAIL_VERIFICATION_KEY: string;
  SECRET_PASSWORD_RESET_KEY: string;
}

export interface ApiRequest extends Request {
  env: ApiEnv;
}
```

## Authentication Flow Implementation

### 1. Signup Endpoint

```typescript
// apps/api/src/handlers/auth/signup.ts
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";
import * as schema from "@onlooker/db";

export async function handleSignup(
  request: Request,
  env: ApiEnv
): Promise<Response> {
  const db = drizzle(env.DB, { schema });
  const body = await request.json();
  const { email, password, name } = body;

  // Check if user already exists
  const existingUser = await db.query.users.findFirst({
    where: eq(schema.users.email, email),
  });

  if (existingUser) {
    return new Response(
      JSON.stringify({ error: "User already exists" }),
      { status: 409 }
    );
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, 10);

  // Create user (soft: email_verified is null initially)
  const userId = crypto.randomUUID();
  const newUser = await db
    .insert(schema.users)
    .values({
      id: userId,
      email,
      password_hash: passwordHash,
      name: name || null,
      created_at: new Date().toISOString(),
      email_verified: null,  // Not verified yet
      deleted_at: null,
    })
    .returning();

  // Create email verification token
  const verificationToken = crypto.randomUUID();
  const hashedVerificationToken = await bcrypt.hash(verificationToken, 10);
  await db.insert(schema.email_verification_tokens).values({
    id: crypto.randomUUID(),
    user_id: userId,
    token: hashedVerificationToken,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
    used_at: null,
  });

  // Create initial session with refresh token
  const refreshToken = crypto.randomUUID();
  const hashedRefreshToken = await bcrypt.hash(refreshToken, 10);
  const sessionId = crypto.randomUUID();
  await db.insert(schema.sessions).values({
    id: sessionId,
    user_id: userId,
    token: hashedRefreshToken,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  });

  // Create access token (JWT, signed with SECRET_JWT_KEY)
  const accessToken = await generateAccessToken(
    userId,
    env.SECRET_JWT_KEY
  );

  // Log signup event
  await db.insert(schema.audit_logs).values({
    id: crypto.randomUUID(),
    user_id: userId,
    action: "user_signup",
    resource_type: "user",
    resource_id: userId,
    created_at: new Date().toISOString(),
  });

  return new Response(
    JSON.stringify({
      token: accessToken,
      refreshToken,  // Plain token returned once; client stores it
      user: {
        id: newUser[0].id,
        email: newUser[0].email,
        name: newUser[0].name,
      },
    }),
    { status: 201, headers: { "Content-Type": "application/json" } }
  );
}
```

### 2. Login Endpoint

```typescript
// apps/api/src/handlers/auth/login.ts
export async function handleLogin(
  request: Request,
  env: ApiEnv
): Promise<Response> {
  const db = drizzle(env.DB, { schema });
  const body = await request.json();
  const { email, password } = body;

  // Find user by email (ignore soft-deleted users)
  const user = await db.query.users.findFirst({
    where: (users, { eq, isNull }) => 
      eq(users.email, email) && isNull(users.deleted_at),
  });

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return new Response(
      JSON.stringify({ error: "Invalid credentials" }),
      { status: 401 }
    );
  }

  // Invalidate old sessions (optional: keep only 1 active session)
  await db
    .delete(schema.sessions)
    .where(eq(schema.sessions.user_id, user.id));

  // Create new refresh token
  const refreshToken = crypto.randomUUID();
  const hashedRefreshToken = await bcrypt.hash(refreshToken, 10);
  await db.insert(schema.sessions).values({
    id: crypto.randomUUID(),
    user_id: user.id,
    token: hashedRefreshToken,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  });

  // Create access token
  const accessToken = await generateAccessToken(user.id, env.SECRET_JWT_KEY);

  // Log login event
  await db.insert(schema.audit_logs).values({
    id: crypto.randomUUID(),
    user_id: user.id,
    action: "user_login",
    resource_type: "session",
    resource_id: crypto.randomUUID(),
    ip_address: request.headers.get("CF-Connecting-IP") || undefined,
    user_agent: request.headers.get("User-Agent") || undefined,
    created_at: new Date().toISOString(),
  });

  return new Response(
    JSON.stringify({
      token: accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
```

### 3. Refresh Token Endpoint

```typescript
// apps/api/src/handlers/auth/refresh.ts
export async function handleRefresh(
  request: Request,
  env: ApiEnv
): Promise<Response> {
  const db = drizzle(env.DB, { schema });
  const body = await request.json();
  const { refreshToken } = body;

  // Find session with this token
  const sessions = await db.query.sessions.findMany({
    where: (sessions, { gte }) => 
      gte(sessions.expires_at, new Date().toISOString()),
  });

  let validSession = null;
  for (const session of sessions) {
    if (await bcrypt.compare(refreshToken, session.token)) {
      validSession = session;
      break;
    }
  }

  if (!validSession) {
    return new Response(
      JSON.stringify({ error: "Invalid or expired refresh token" }),
      { status: 401 }
    );
  }

  // Fetch user
  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, validSession.user_id),
  });

  if (!user || user.deleted_at) {
    return new Response(
      JSON.stringify({ error: "User not found" }),
      { status: 401 }
    );
  }

  // Delete old session
  await db.delete(schema.sessions).where(eq(schema.sessions.id, validSession.id));

  // Create new refresh token (rotation)
  const newRefreshToken = crypto.randomUUID();
  const hashedNewRefreshToken = await bcrypt.hash(newRefreshToken, 10);
  await db.insert(schema.sessions).values({
    id: crypto.randomUUID(),
    user_id: user.id,
    token: hashedNewRefreshToken,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  });

  // Create new access token
  const newAccessToken = await generateAccessToken(user.id, env.SECRET_JWT_KEY);

  return new Response(
    JSON.stringify({
      token: newAccessToken,
      refreshToken: newRefreshToken,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
```

### 4. Email Verification Endpoint

```typescript
// apps/api/src/handlers/auth/verify-email.ts
export async function handleVerifyEmail(
  request: Request,
  env: ApiEnv
): Promise<Response> {
  const db = drizzle(env.DB, { schema });
  const body = await request.json();
  const { token } = body;

  // Find token records (check all, validate hash)
  const tokens = await db.query.email_verification_tokens.findMany({
    where: (tokens, { isNull, gte }) => 
      isNull(tokens.used_at) && gte(tokens.expires_at, new Date().toISOString()),
  });

  let validTokenRecord = null;
  for (const tokenRecord of tokens) {
    if (await bcrypt.compare(token, tokenRecord.token)) {
      validTokenRecord = tokenRecord;
      break;
    }
  }

  if (!validTokenRecord) {
    return new Response(
      JSON.stringify({ error: "Invalid or expired verification token" }),
      { status: 400 }
    );
  }

  // Mark token as used and set email_verified
  await db
    .update(schema.email_verification_tokens)
    .set({ used_at: new Date().toISOString() })
    .where(eq(schema.email_verification_tokens.id, validTokenRecord.id));

  await db
    .update(schema.users)
    .set({ email_verified: new Date().toISOString() })
    .where(eq(schema.users.id, validTokenRecord.user_id));

  // Log event
  await db.insert(schema.audit_logs).values({
    id: crypto.randomUUID(),
    user_id: validTokenRecord.user_id,
    action: "email_verified",
    resource_type: "user",
    resource_id: validTokenRecord.user_id,
    created_at: new Date().toISOString(),
  });

  return new Response(
    JSON.stringify({ success: true }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
```

### 5. Request Password Reset Endpoint

```typescript
// apps/api/src/handlers/auth/request-password-reset.ts
export async function handleRequestPasswordReset(
  request: Request,
  env: ApiEnv
): Promise<Response> {
  const db = drizzle(env.DB, { schema });
  const body = await request.json();
  const { email } = body;

  // Find user (do not leak whether user exists)
  const user = await db.query.users.findFirst({
    where: (users, { eq, isNull }) => 
      eq(users.email, email) && isNull(users.deleted_at),
  });

  // Always return 200 to prevent user enumeration
  if (!user) {
    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // Delete any existing unused reset tokens
  await db
    .delete(schema.password_reset_tokens)
    .where(
      (tokens, { eq, isNull }) => 
        eq(tokens.user_id, user.id) && isNull(tokens.used_at)
    );

  // Create new reset token
  const resetToken = crypto.randomUUID();
  const hashedResetToken = await bcrypt.hash(resetToken, 10);
  await db.insert(schema.password_reset_tokens).values({
    id: crypto.randomUUID(),
    user_id: user.id,
    token: hashedResetToken,
    expires_at: new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString(),  // 1 hour
    created_at: new Date().toISOString(),
    used_at: null,
  });

  // Send reset email with token (via email service, WS3)
  // await sendPasswordResetEmail(user.email, resetToken);

  // Log event (without exposing token)
  await db.insert(schema.audit_logs).values({
    id: crypto.randomUUID(),
    user_id: user.id,
    action: "password_reset_requested",
    resource_type: "user",
    resource_id: user.id,
    created_at: new Date().toISOString(),
  });

  return new Response(
    JSON.stringify({ success: true }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
```

## Protected Endpoint Pattern

All protected endpoints check the JWT access token and require authentication:

```typescript
// Middleware: Extract and validate JWT
export async function validateAuthToken(
  request: Request,
  env: ApiEnv
): Promise<{ userId: string } | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyJWT(token, env.SECRET_JWT_KEY);
    return { userId: payload.sub };
  } catch {
    return null;
  }
}

// Protected endpoint example
export async function handleGetMe(
  request: Request,
  env: ApiEnv
): Promise<Response> {
  const auth = await validateAuthToken(request, env);
  if (!auth) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401 }
    );
  }

  const db = drizzle(env.DB, { schema });
  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, auth.userId),
  });

  if (!user || user.deleted_at) {
    return new Response(
      JSON.stringify({ error: "User not found" }),
      { status: 404 }
    );
  }

  return new Response(
    JSON.stringify({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
```

## Token Lifecycle

```
┌─ Signup
│  ├─ Create user record
│  ├─ Create email_verification_tokens (expires in 24h)
│  ├─ Create sessions with refresh token (expires in 7d)
│  └─ Return access token (expires in 1h) + refresh token
│
├─ Email Verification
│  ├─ Client clicks email link with token
│  ├─ API validates token hasn't expired or been used
│  ├─ Mark token as used
│  └─ Set users.email_verified timestamp
│
├─ Access Token Expiration
│  ├─ After 1 hour, access token expires
│  ├─ Client uses refresh token to get new access token
│  ├─ API validates refresh token against sessions table
│  ├─ Rotate: delete old session, create new one with new refresh token
│  └─ Return new access token + rotated refresh token
│
├─ Logout
│  ├─ Client requests /auth/logout with access token
│  ├─ API validates access token
│  ├─ Delete session record from sessions table
│  └─ Client discards both tokens
│
├─ Session Expiration (7 days)
│  ├─ Refresh token expires
│  ├─ If client tries to use it, validation fails
│  └─ Client must re-login
│
└─ Password Reset
   ├─ User requests password reset (POST /auth/request-password-reset)
   ├─ API creates password_reset_tokens (expires in 1h)
   ├─ Sends email with reset link and token
   ├─ User clicks link and submits new password
   ├─ API validates token
   ├─ Update users.password_hash
   ├─ Mark token as used
   ├─ Invalidate all old sessions (force re-login)
   └─ Return new access token
```

## Database Queries by Endpoint

| Endpoint | Queries |
|----------|---------|
| `POST /auth/signup` | INSERT users, INSERT email_verification_tokens, INSERT sessions, INSERT audit_logs |
| `POST /auth/login` | SELECT users, DELETE sessions, INSERT sessions, INSERT audit_logs |
| `POST /auth/refresh` | SELECT sessions (all), SELECT users, DELETE sessions, INSERT sessions |
| `POST /auth/logout` | SELECT sessions (by token), DELETE sessions, INSERT audit_logs |
| `POST /auth/verify-email` | SELECT email_verification_tokens (all), UPDATE email_verification_tokens, UPDATE users, INSERT audit_logs |
| `POST /auth/request-password-reset` | SELECT users, DELETE password_reset_tokens, INSERT password_reset_tokens, INSERT audit_logs |
| `POST /auth/reset-password` | SELECT password_reset_tokens (all), UPDATE password_reset_tokens, UPDATE users, DELETE sessions, INSERT sessions, INSERT audit_logs |
| `GET /auth/me` | SELECT users |
| `GET /api/users/me` | SELECT users |

## Error Handling

### 400 Bad Request
- Invalid request body
- Malformed email
- Password too short

### 401 Unauthorized
- Invalid credentials
- Expired token
- Token not provided

### 409 Conflict
- User already exists (duplicate email)
- Token already used

### 500 Internal Server Error
- Database connectivity issues
- Unexpected exceptions

## Security Considerations

1. **Password Hashing:** Always hash passwords with bcrypt (cost = 10+)
2. **Token Hashing:** Store hashed tokens in database; return plain token once
3. **Token Rotation:** Refresh tokens are rotated on each use
4. **Soft Deletes:** Preserve audit trail without hard deletes
5. **No User Enumeration:** Password reset endpoint doesn't leak whether email exists
6. **Rate Limiting:** Should be added per IP in WS4 (not in schema)
7. **IP & User-Agent Logging:** Captured in audit_logs for security analysis
8. **Email Verification:** Required before user can access protected resources (optional enforcement)

## Next Steps (WS2+)

- [ ] Implement API handlers in apps/api
- [ ] Add bcrypt and JWT libraries
- [ ] Add email service integration (SendGrid, Resend, etc.)
- [ ] Add rate limiting middleware
- [ ] Add request logging and monitoring
- [ ] Add database connection pooling
- [ ] Add data validation (zod schemas)
- [ ] Add comprehensive error handling
- [ ] Add transaction support for multi-step operations
- [ ] Add database backups strategy
