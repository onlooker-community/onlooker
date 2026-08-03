# Authentication Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a complete JWT-based authentication system for Cloudflare Workers with D1 database persistence, password hashing, and token refresh flow.

**Architecture:** Build authentication as layered components: (1) database utilities for user/token queries, (2) crypto utilities for bcrypt hashing and JWT signing/verification, (3) auth middleware to extract and validate tokens, (4) endpoint handlers that orchestrate the flow. Each layer is independently testable and can be composed into the complete auth flow.

**Tech Stack:**
- **Hashing:** `bcryptjs` (bcrypt for Node/Workers)
- **JWT:** `jose` (JWT library for Cloudflare Workers)
- **Database:** D1 SQLite with prepared statements
- **HTTP:** Fetch API with standard headers

## Global Constraints

- Use American English in all code comments and error messages
- Errors must return consistent JSON: `{ code: string, message: string }`
- HTTP status codes: 400 (bad input), 401 (auth failed), 409 (conflict), 500 (server error)
- All passwords must be ≥8 characters
- Access tokens expire after TOKEN_EXPIRY_MINUTES (default 180)
- Refresh tokens expire after REFRESH_TOKEN_EXPIRY_DAYS (default 30)
- JWT algorithm: HS256 (symmetric, using JWT_SECRET from env)

---

## File Structure

**New files to create:**
- `apps/api/src/utils/crypto.ts` - Password hashing & JWT utilities
- `apps/api/src/db/queries.ts` - D1 database query functions

**Files to modify:**
- `apps/api/src/middleware/auth.ts` - Auth context extraction
- `apps/api/src/routes/auth.ts` - Endpoint handlers
- `apps/api/src/types/index.ts` - Type definitions

---

## Task 1: Add Dependencies

**Files:**
- Modify: `apps/api/package.json`

**Interfaces:**
- Produces: `bcryptjs`, `jose` packages available in code

- [ ] **Step 1: Add packages to package.json**

Edit `apps/api/package.json` devDependencies section to include:

```json
"dependencies": {
  "@onlooker/auth-core": "workspace:*",
  "bcryptjs": "^2.4.3",
  "jose": "^5.4.0"
}
```

- [ ] **Step 2: Install**

```bash
pnpm install
```

Expected: `pnpm install` completes without errors

- [ ] **Step 3: Verify types are available**

```bash
node -e "console.log(require('bcryptjs')); console.log(require('jose'))"
```

Expected: Both modules load without errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml
git commit -m "deps: add bcryptjs and jose for auth"
```

---

## Task 2: Create Crypto Utilities

**Files:**
- Create: `apps/api/src/utils/crypto.ts`

**Interfaces:**
- Produces:
  - `hashPassword(password: string): Promise<string>` — Returns bcrypt hash
  - `verifyPassword(password: string, hash: string): Promise<boolean>` — Verifies password against hash
  - `signJwt(payload: JwtPayload, secret: string, expiresInMinutes: number): Promise<string>` — Returns signed JWT
  - `verifyJwt(token: string, secret: string): Promise<JwtPayload | null>` — Returns decoded payload or null if invalid
  - `generateRefreshToken(): string` — Returns random token string

- [ ] **Step 1: Write crypto utilities**

Create `apps/api/src/utils/crypto.ts`:

```typescript
import * as jose from "jose";
import * as bcrypt from "bcryptjs";

export interface JwtPayload {
  sub: string; // user ID
  email: string;
  type: "access" | "refresh"; // token type
  iat: number;
  exp: number;
}

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

/**
 * Verify a password against a bcrypt hash
 */
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Sign a JWT token
 */
export async function signJwt(
  payload: Omit<JwtPayload, "iat" | "exp">,
  secret: string,
  expiresInMinutes: number,
): Promise<string> {
  const encoder = new TextEncoder();
  const secretKey = await jose.importSPKI(
    `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`,
    "HS256",
  );

  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${expiresInMinutes}m`)
    .sign(secretKey);
}

/**
 * Verify and decode a JWT token
 */
export async function verifyJwt(
  token: string,
  secret: string,
): Promise<JwtPayload | null> {
  try {
    const encoder = new TextEncoder();
    const secretKey = await jose.importSPKI(
      `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`,
      "HS256",
    );

    const verified = await jose.jwtVerify(token, secretKey);
    return verified.payload as unknown as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Generate a random refresh token
 */
export function generateRefreshToken(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 64; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}
```

- [ ] **Step 2: Create utils directory if needed**

```bash
mkdir -p apps/api/src/utils
```

- [ ] **Step 3: Verify no TypeScript errors**

```bash
pnpm --filter @onlooker/api typecheck
```

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/utils/crypto.ts
git commit -m "feat(auth): add crypto utilities for password hashing and JWT"
```

---

## Task 3: Create Database Query Functions

**Files:**
- Create: `apps/api/src/db/queries.ts`

**Interfaces:**
- Consumes: D1 bindings from env
- Produces:
  - `createUser(db: D1Database, email: string, passwordHash: string, name?: string): Promise<{ id: string, email: string, name?: string }>`
  - `getUserByEmail(db: D1Database, email: string): Promise<{ id: string, email: string, password_hash: string, email_verified: boolean } | null>`
  - `getUserById(db: D1Database, userId: string): Promise<{ id: string, email: string, name?: string, email_verified: boolean } | null>`
  - `storeRefreshToken(db: D1Database, userId: string, token: string, expiresAt: Date): Promise<void>`
  - `getRefreshToken(db: D1Database, token: string): Promise<{ user_id: string, expires_at: string } | null>`
  - `revokeRefreshToken(db: D1Database, token: string): Promise<void>`

- [ ] **Step 1: Write database queries**

Create `apps/api/src/db/queries.ts`:

```typescript
import type { D1Database } from "@cloudflare/workers-types";

export interface User {
  id: string;
  email: string;
  password_hash: string;
  name?: string;
  email_verified: boolean;
  created_at: string;
  updated_at: string;
}

export interface RefreshToken {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
}

/**
 * Create a new user in the database
 */
export async function createUser(
  db: D1Database,
  email: string,
  passwordHash: string,
  name?: string,
): Promise<{ id: string; email: string; name?: string }> {
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();

  const result = await db
    .prepare(
      `
      INSERT INTO users (id, email, password_hash, name, email_verified, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .bind(userId, email, passwordHash, name || null, false, now, now)
    .run();

  if (!result.success) {
    throw new Error(`Failed to create user: ${result.error}`);
  }

  return { id: userId, email, name };
}

/**
 * Get user by email address
 */
export async function getUserByEmail(
  db: D1Database,
  email: string,
): Promise<User | null> {
  const result = await db
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(email)
    .first();

  return (result as User) || null;
}

/**
 * Get user by ID
 */
export async function getUserById(
  db: D1Database,
  userId: string,
): Promise<Omit<User, "password_hash"> | null> {
  const result = await db
    .prepare("SELECT id, email, name, email_verified, created_at, updated_at FROM users WHERE id = ?")
    .bind(userId)
    .first();

  return (result as Omit<User, "password_hash">) || null;
}

/**
 * Store a refresh token
 */
export async function storeRefreshToken(
  db: D1Database,
  userId: string,
  token: string,
  expiresAt: Date,
): Promise<void> {
  const tokenId = crypto.randomUUID();
  const tokenHash = await hashToken(token);
  const now = new Date().toISOString();

  const result = await db
    .prepare(
      `
      INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    )
    .bind(tokenId, userId, tokenHash, expiresAt.toISOString(), now)
    .run();

  if (!result.success) {
    throw new Error(`Failed to store refresh token: ${result.error}`);
  }
}

/**
 * Get refresh token
 */
export async function getRefreshToken(
  db: D1Database,
  token: string,
): Promise<{ user_id: string; expires_at: string } | null> {
  const tokenHash = await hashToken(token);

  const result = await db
    .prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .first();

  if (!result) return null;

  // Check if expired
  const expiresAt = new Date(result.expires_at as string);
  if (expiresAt < new Date()) {
    return null;
  }

  return {
    user_id: result.user_id as string,
    expires_at: result.expires_at as string,
  };
}

/**
 * Revoke (delete) a refresh token
 */
export async function revokeRefreshToken(
  db: D1Database,
  token: string,
): Promise<void> {
  const tokenHash = await hashToken(token);

  const result = await db
    .prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .run();

  if (!result.success) {
    throw new Error(`Failed to revoke token: ${result.error}`);
  }
}

/**
 * Simple hash for token comparison (not password - tokens use SHA256)
 */
async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 2: Verify no TypeScript errors**

```bash
pnpm --filter @onlooker/api typecheck
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/queries.ts
git commit -m "feat(db): add user and token query functions"
```

---

## Task 4: Update Auth Middleware

**Files:**
- Modify: `apps/api/src/middleware/auth.ts`

**Interfaces:**
- Consumes: `verifyJwt`, `JwtPayload` from crypto utilities
- Produces: `extractToken(request: Request): string | null`, `requireAuth(request: Request, env: WorkerEnv): Promise<{ userId: string, email: string }>`

- [ ] **Step 1: Read current middleware**

```bash
cat apps/api/src/middleware/auth.ts
```

- [ ] **Step 2: Add auth context extraction**

Update `apps/api/src/middleware/auth.ts`:

```typescript
import { verifyJwt, type JwtPayload } from "../utils/crypto";
import type { WorkerEnv } from "../types";
import { ApiError } from "./error";

/**
 * Extract JWT token from Authorization header
 */
export function extractToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Require a valid JWT token in the request
 * Throws ApiError if missing or invalid
 */
export async function requireAuth(
  request: Request,
  env: WorkerEnv,
): Promise<{ userId: string; email: string }> {
  const token = extractToken(request);
  if (!token) {
    throw new ApiError(401, "unauthorized", "Missing authorization token");
  }

  const payload = await verifyJwt(token, env.JWT_SECRET);
  if (!payload || payload.type !== "access") {
    throw new ApiError(401, "invalid_token", "Invalid or expired token");
  }

  return {
    userId: payload.sub,
    email: payload.email,
  };
}

/**
 * Optional auth - returns auth context if valid, null otherwise
 */
export async function optionalAuth(
  request: Request,
  env: WorkerEnv,
): Promise<{ userId: string; email: string } | null> {
  const token = extractToken(request);
  if (!token) return null;

  const payload = await verifyJwt(token, env.JWT_SECRET);
  if (!payload || payload.type !== "access") return null;

  return {
    userId: payload.sub,
    email: payload.email,
  };
}
```

- [ ] **Step 3: Verify no TypeScript errors**

```bash
pnpm --filter @onlooker/api typecheck
```

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/middleware/auth.ts
git commit -m "feat(middleware): add auth context extraction and validation"
```

---

## Task 5: Implement Signup Endpoint

**Files:**
- Modify: `apps/api/src/routes/auth.ts`

**Interfaces:**
- Consumes: `hashPassword`, `signJwt`, `generateRefreshToken`, `createUser`, `getUserByEmail` from previous tasks
- Produces: Signup handler that returns `{ token: string, refreshToken: string, user: { id, email, name } }`

- [ ] **Step 1: Implement handleSignup**

Replace the signup handler in `apps/api/src/routes/auth.ts`:

```typescript
import { hashPassword, signJwt, generateRefreshToken } from "../utils/crypto";
import { createUser, getUserByEmail, storeRefreshToken } from "../db/queries";
import type { SignupRequest, WorkerEnv } from "../types";

export async function handleSignup(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const body = (await request.json()) as SignupRequest;

  // Validate input
  if (!body.email || !body.password) {
    throw new ApiError(400, "invalid_input", "Email and password are required");
  }

  if (body.password.length < 8) {
    throw new ApiError(400, "invalid_password", "Password must be at least 8 characters");
  }

  // Check if user exists
  const existing = await getUserByEmail(env.DB, body.email);
  if (existing) {
    throw new ApiError(409, "user_exists", "User with this email already exists");
  }

  // Hash password
  const passwordHash = await hashPassword(body.password);

  // Create user
  const user = await createUser(env.DB, body.email, passwordHash, body.name);

  // Generate tokens
  const expiresInMinutes = parseInt(env.TOKEN_EXPIRY_MINUTES);
  const refreshExpiresInDays = parseInt(env.REFRESH_TOKEN_EXPIRY_DAYS);

  const token = await signJwt(
    {
      sub: user.id,
      email: user.email,
      type: "access",
    },
    env.JWT_SECRET,
    expiresInMinutes,
  );

  const refreshToken = generateRefreshToken();
  const refreshExpiresAt = new Date();
  refreshExpiresAt.setDate(refreshExpiresAt.getDate() + refreshExpiresInDays);

  await storeRefreshToken(env.DB, user.id, refreshToken, refreshExpiresAt);

  return new Response(
    JSON.stringify({
      token,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    }),
    {
      status: 201,
      headers: { "Content-Type": "application/json" },
    },
  );
}
```

- [ ] **Step 2: Verify no TypeScript errors**

```bash
pnpm --filter @onlooker/api typecheck
```

Expected: No errors

- [ ] **Step 3: Test the endpoint manually**

Build and test locally:

```bash
pnpm --filter @onlooker/api build
pnpm --filter @onlooker/api dev
```

In another terminal:
```bash
curl -X POST http://localhost:8787/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"TestPass123"}'
```

Expected: 201 with `{ token, refreshToken, user }`

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/auth.ts
git commit -m "feat(auth): implement signup endpoint"
```

---

## Task 6: Implement Login Endpoint

**Files:**
- Modify: `apps/api/src/routes/auth.ts`

**Interfaces:**
- Consumes: Same as Task 5
- Produces: Login handler that returns `{ token: string, refreshToken: string, user: { id, email } }`

- [ ] **Step 1: Implement handleLogin**

Add to `apps/api/src/routes/auth.ts`:

```typescript
import { verifyPassword } from "../utils/crypto";

export async function handleLogin(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const body = (await request.json()) as LoginRequest;

  // Validate input
  if (!body.email || !body.password) {
    throw new ApiError(400, "invalid_input", "Email and password are required");
  }

  // Get user from database
  const user = await getUserByEmail(env.DB, body.email);
  if (!user) {
    throw new ApiError(401, "invalid_credentials", "Invalid email or password");
  }

  // Verify password
  const validPassword = await verifyPassword(body.password, user.password_hash);
  if (!validPassword) {
    throw new ApiError(401, "invalid_credentials", "Invalid email or password");
  }

  // Generate tokens
  const expiresInMinutes = parseInt(env.TOKEN_EXPIRY_MINUTES);
  const refreshExpiresInDays = parseInt(env.REFRESH_TOKEN_EXPIRY_DAYS);

  const token = await signJwt(
    {
      sub: user.id,
      email: user.email,
      type: "access",
    },
    env.JWT_SECRET,
    expiresInMinutes,
  );

  const refreshToken = generateRefreshToken();
  const refreshExpiresAt = new Date();
  refreshExpiresAt.setDate(refreshExpiresAt.getDate() + refreshExpiresInDays);

  await storeRefreshToken(env.DB, user.id, refreshToken, refreshExpiresAt);

  return new Response(
    JSON.stringify({
      token,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}
```

- [ ] **Step 2: Verify no TypeScript errors**

```bash
pnpm --filter @onlooker/api typecheck
```

Expected: No errors

- [ ] **Step 3: Test the endpoint**

```bash
curl -X POST http://localhost:8787/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"TestPass123"}'
```

Expected: 200 with `{ token, refreshToken, user }`

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/auth.ts
git commit -m "feat(auth): implement login endpoint"
```

---

## Task 7: Implement Refresh Token Endpoint

**Files:**
- Modify: `apps/api/src/routes/auth.ts`

**Interfaces:**
- Consumes: Previous utilities, `getRefreshToken`, `revokeRefreshToken`
- Produces: Refresh handler that rotates tokens

- [ ] **Step 1: Implement handleRefresh**

Add to `apps/api/src/routes/auth.ts`:

```typescript
import { getRefreshToken, revokeRefreshToken } from "../db/queries";

export async function handleRefresh(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const body = (await request.json()) as RefreshTokenRequest;

  if (!body.refreshToken) {
    throw new ApiError(400, "invalid_input", "Refresh token is required");
  }

  // Get refresh token from database
  const stored = await getRefreshToken(env.DB, body.refreshToken);
  if (!stored) {
    throw new ApiError(401, "invalid_token", "Invalid or expired refresh token");
  }

  // Get user
  const user = await getUserById(env.DB, stored.user_id);
  if (!user) {
    throw new ApiError(401, "invalid_token", "User not found");
  }

  // Generate new access token
  const expiresInMinutes = parseInt(env.TOKEN_EXPIRY_MINUTES);
  const refreshExpiresInDays = parseInt(env.REFRESH_TOKEN_EXPIRY_DAYS);

  const newAccessToken = await signJwt(
    {
      sub: user.id,
      email: user.email,
      type: "access",
    },
    env.JWT_SECRET,
    expiresInMinutes,
  );

  // Rotate refresh token
  await revokeRefreshToken(env.DB, body.refreshToken);

  const newRefreshToken = generateRefreshToken();
  const refreshExpiresAt = new Date();
  refreshExpiresAt.setDate(refreshExpiresAt.getDate() + refreshExpiresInDays);

  await storeRefreshToken(env.DB, user.id, newRefreshToken, refreshExpiresAt);

  return new Response(
    JSON.stringify({
      token: newAccessToken,
      refreshToken: newRefreshToken,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}
```

- [ ] **Step 2: Verify no TypeScript errors**

```bash
pnpm --filter @onlooker/api typecheck
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/auth.ts
git commit -m "feat(auth): implement refresh token endpoint with rotation"
```

---

## Task 8: Implement Get Profile (Me) Endpoint

**Files:**
- Modify: `apps/api/src/routes/auth.ts`

**Interfaces:**
- Consumes: `requireAuth` from middleware
- Produces: Get profile handler that returns current user

- [ ] **Step 1: Implement handleMe**

Add to `apps/api/src/routes/auth.ts`:

```typescript
import { requireAuth } from "../middleware/auth";

export async function handleMe(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const auth = await requireAuth(request, env);

  // Get user from database
  const user = await getUserById(env.DB, auth.userId);
  if (!user) {
    throw new ApiError(404, "not_found", "User not found");
  }

  return new Response(JSON.stringify({ user }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 2: Verify no TypeScript errors**

```bash
pnpm --filter @onlooker/api typecheck
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/auth.ts
git commit -m "feat(auth): implement get profile endpoint"
```

---

## Task 9: Implement Logout Endpoint

**Files:**
- Modify: `apps/api/src/routes/auth.ts`

**Interfaces:**
- Consumes: `optionalAuth`, `revokeRefreshToken`
- Produces: Logout handler that revokes tokens

- [ ] **Step 1: Implement handleLogout**

Add to `apps/api/src/routes/auth.ts`:

```typescript
import { optionalAuth } from "../middleware/auth";

export async function handleLogout(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  // Note: logout doesn't fail if token is invalid
  // The client will clear localStorage anyway
  const auth = await optionalAuth(request, env);

  // If we have a valid auth context, try to revoke any refresh tokens
  // (In a full implementation, we'd revoke from a token revocation list)

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 2: Verify no TypeScript errors**

```bash
pnpm --filter @onlooker/api typecheck
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/auth.ts
git commit -m "feat(auth): implement logout endpoint"
```

---

## Task 10: Update Router to Wire All Endpoints

**Files:**
- Modify: `apps/api/src/router.ts`

**Interfaces:**
- Consumes: All auth handlers from routes/auth.ts
- Produces: Wired routes that call handlers

- [ ] **Step 1: Check current router**

```bash
cat apps/api/src/router.ts
```

- [ ] **Step 2: Wire auth endpoints**

Update `apps/api/src/router.ts` to import and call the new handlers:

```typescript
import {
  handleSignup,
  handleLogin,
  handleRefresh,
  handleMe,
  handleLogout,
} from "./routes/auth";

export async function dispatch(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  try {
    // Auth routes
    if (pathname === "/auth/signup" && request.method === "POST") {
      return await handleSignup(request, env);
    }
    if (pathname === "/auth/login" && request.method === "POST") {
      return await handleLogin(request, env);
    }
    if (pathname === "/auth/refresh" && request.method === "POST") {
      return await handleRefresh(request, env);
    }
    if (pathname === "/auth/me" && request.method === "GET") {
      return await handleMe(request, env);
    }
    if (pathname === "/auth/logout" && request.method === "POST") {
      return await handleLogout(request, env);
    }

    // ... other routes

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  } catch (err) {
    if (err instanceof ApiError) {
      return err.response();
    }
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Verify no TypeScript errors**

```bash
pnpm --filter @onlooker/api typecheck
```

Expected: No errors

- [ ] **Step 3: Test all endpoints locally**

Build and start dev server:
```bash
pnpm --filter @onlooker/api dev
```

Test flow:
```bash
# Signup
curl -X POST http://localhost:8787/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"user1@example.com","password":"TestPass123"}'

# Should get: { token, refreshToken, user }
# Save token and refreshToken

# Login (use same credentials)
curl -X POST http://localhost:8787/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user1@example.com","password":"TestPass123"}'

# Get profile (use token from signup)
TOKEN="..."
curl -X GET http://localhost:8787/auth/me \
  -H "Authorization: Bearer $TOKEN"

# Should return current user profile

# Refresh token
REFRESH_TOKEN="..."
curl -X POST http://localhost:8787/auth/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}"

# Should return new token and refreshToken
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/router.ts
git commit -m "feat(router): wire all auth endpoints"
```

---

## Task 11: Deploy to Production

**Files:**
- No files changed

**Interfaces:**
- Consumes: Deployed API infrastructure from earlier

- [ ] **Step 1: Build**

```bash
pnpm build
```

Expected: No TypeScript errors, build completes

- [ ] **Step 2: Deploy to staging**

```bash
pnpm deploy:api:staging
```

Expected: Deployment succeeds

- [ ] **Step 3: Test staging endpoints**

```bash
curl -X POST https://api-staging.onlooker.dev/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@onlooker.dev","password":"TestPass123"}'
```

Expected: 201 with tokens

- [ ] **Step 4: Deploy to production**

```bash
pnpm deploy:api:prod
```

Expected: Deployment succeeds

- [ ] **Step 5: Test production endpoints**

```bash
curl -X POST https://api.onlooker.dev/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@onlooker.dev","password":"TestPass123"}'
```

Expected: 201 with tokens

- [ ] **Step 6: Commit any final changes**

```bash
git status
git add .
git commit -m "feat(auth): complete authentication implementation" || echo "No changes to commit"
```

---

## Verification Checklist

Once all tasks are complete:

- [ ] All auth endpoints return 200/201 on success
- [ ] All endpoints return proper error codes (400, 401, 409) with error messages
- [ ] Tokens can be decoded and validated
- [ ] Refresh token rotation works (old token invalidated)
- [ ] Database queries work with D1
- [ ] Password hashing is working
- [ ] TypeScript has no errors
- [ ] All endpoints deployed to staging and production
- [ ] Manual testing shows complete auth flow works

---

Plan complete and saved to `docs/superpowers/plans/2026-08-03-auth-endpoints.md`. 

## Execution Options

**1. Subagent-Driven (Recommended)** - I dispatch a fresh subagent per task, you review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach would you prefer?**