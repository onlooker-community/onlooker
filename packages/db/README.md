# @onlooker/db

Database schema definitions and migrations for the Onlooker platform using Drizzle ORM and SQLite (Cloudflare D1).

## Overview

This package provides:

- **TypeScript-first schema definitions** using Drizzle ORM
- **Type-safe database operations** with full type inference
- **SQLite migrations** compatible with Cloudflare D1
- **Audit logging support** for compliance and security
- **Token management tables** for sessions, email verification, password reset, and machine tokens

## Tables

### `users`
Core user account table with email, password hash, and verification status.

```typescript
type User = {
  id: string;                 // UUID
  email: string;             // Unique email address
  password_hash: string;     // Bcrypt hashed password
  name?: string;             // Display name (optional)
  created_at: string;        // ISO 8601 timestamp
  email_verified?: string;   // ISO 8601 timestamp when verified (null = unverified)
  deleted_at?: string;       // ISO 8601 soft-delete timestamp (null = active)
};
```

### `sessions`
Active user sessions storing refresh tokens. Refresh tokens are rotated on each use.

```typescript
type Session = {
  id: string;               // UUID
  user_id: string;          // Foreign key to users.id
  token: string;            // Hashed refresh token
  expires_at: string;       // ISO 8601 expiration
  created_at: string;       // ISO 8601 timestamp
};
```

### `email_verification_tokens`
One-time tokens sent to users during signup for email verification.

```typescript
type EmailVerificationToken = {
  id: string;               // UUID
  user_id: string;          // Foreign key to users.id
  token: string;            // Hashed verification token
  expires_at: string;       // ISO 8601 expiration (typically 24 hours)
  created_at: string;       // ISO 8601 timestamp
  used_at?: string;         // ISO 8601 when verified (null = not used)
};
```

### `password_reset_tokens`
One-time tokens sent to users requesting a password reset.

```typescript
type PasswordResetToken = {
  id: string;               // UUID
  user_id: string;          // Foreign key to users.id
  token: string;            // Hashed reset token
  expires_at: string;       // ISO 8601 expiration (typically 1 hour)
  created_at: string;       // ISO 8601 timestamp
  used_at?: string;         // ISO 8601 when reset completed (null = not used)
};
```

### `email_change_tokens`
One-time tokens for users changing their email address.

```typescript
type EmailChangeToken = {
  id: string;               // UUID
  user_id: string;          // Foreign key to users.id
  new_email: string;        // The new email being verified
  token: string;            // Hashed change token
  expires_at: string;       // ISO 8601 expiration (typically 24 hours)
  created_at: string;       // ISO 8601 timestamp
  used_at?: string;         // ISO 8601 when email was changed (null = not used)
};
```

### `machine_tokens`
API keys / machine-to-machine authentication tokens created by users.

```typescript
type MachineToken = {
  id: string;               // UUID
  user_id: string;          // Foreign key to users.id (owner)
  machine_id: string;       // UUID identifying the machine
  name: string;             // Human-readable name (e.g., "GitHub CI")
  token: string;            // Hashed machine token
  created_at: string;       // ISO 8601 timestamp
  expires_at?: string;      // ISO 8601 expiration (null = never expires)
  revoked_at?: string;      // ISO 8601 when revoked (null = active)
  last_used_at?: string;    // ISO 8601 of last successful use
};
```

### `audit_logs`
Security event log for compliance and debugging.

```typescript
type AuditLog = {
  id: string;               // UUID
  user_id?: string;         // Foreign key to users.id (nullable for system events)
  action: string;           // Event type (e.g., "user_login", "password_changed")
  resource_type?: string;   // What was affected (e.g., "session", "email")
  resource_id?: string;     // ID of affected resource
  ip_address?: string;      // IPv4 or IPv6 address
  user_agent?: string;      // User agent string
  created_at: string;       // ISO 8601 timestamp
  details?: string;         // JSON metadata
};
```

## Local Development Setup

### 1. Install Dependencies

```bash
pnpm install
```

This installs Drizzle ORM, Drizzle Kit (for migrations), and Cloudflare Workers types.

### 2. Create Local D1 Database

First, ensure you have Wrangler installed globally (or in your environment):

```bash
# Via mise (recommended)
mise use wrangler@latest

# Or via npm
npm install -g wrangler
```

Create a local D1 database in the root of the monorepo:

```bash
cd /path/to/onlooker

# Create D1 database named 'onlooker'
wrangler d1 create onlooker --local
```

This creates a local SQLite database at `.wrangler/state/d1/db.sqlite`.

### 3. Set Up wrangler.toml

In the root `wrangler.toml`, add or verify the D1 binding:

```toml
name = "onlooker"
type = "service"
compatibility_date = "2024-11-21"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "onlooker"
database_id = "00000000-0000-0000-0000-000000000000"
```

For local development, the `database_id` is a placeholder. It's automatically set when you deploy to production via Cloudflare.

### 4. Initialize the Database Schema

Apply the initial migration to your local database:

```bash
# From packages/db directory
cd packages/db

# Run migration using wrangler
wrangler d1 execute onlooker --local < migrations/0001_create_auth_tables.sql
```

This creates all the tables with their indexes.

### 5. Verify Schema

Check that tables were created:

```bash
# Connect to local D1 database
wrangler d1 execute onlooker --local --command ".tables"
```

You should see:

```
users
sessions
email_verification_tokens
password_reset_tokens
email_change_tokens
machine_tokens
audit_logs
```

## Running Migrations in Development

### Using Drizzle Kit (Recommended for Future Migrations)

```bash
cd packages/db

# Generate new migration from schema changes
pnpm run generate:migrations

# Apply migrations to local database
pnpm run push:migrations
```

**Note:** For the initial setup, we use SQL migrations directly. After the schema is stable, you can use `drizzle-kit generate` to generate migrations automatically when you modify `src/schema.ts`.

### Manual SQL Migrations

If you make changes to the schema and need to apply them:

```bash
cd packages/db

# Apply a migration file
wrangler d1 execute onlooker --local < migrations/0002_your_migration.sql
```

## Using the Database in Your Backend

### In Cloudflare Workers

```typescript
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@onlooker/db";

interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env) {
    const db = drizzle(env.DB, { schema });

    // Query: Find user by email
    const user = await db.query.users.findFirst({
      where: (users, { eq }) => eq(users.email, "user@example.com"),
    });

    // Create: Insert new user
    const newUser = await db.insert(schema.users).values({
      id: crypto.randomUUID(),
      email: "new@example.com",
      password_hash: hashedPassword,
      created_at: new Date().toISOString(),
    }).returning();

    // Update: Change password
    await db
      .update(schema.users)
      .set({ password_hash: newHashedPassword })
      .where((users, { eq }) => eq(users.id, userId));

    // Delete: Soft delete user
    await db
      .update(schema.users)
      .set({ deleted_at: new Date().toISOString() })
      .where((users, { eq }) => eq(users.id, userId));

    return new Response(JSON.stringify(user));
  },
};
```

### In Node.js / Express (for API server)

```typescript
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@onlooker/db";

// Note: D1 is Cloudflare-specific. For Node.js backends,
// you would use `drizzle-orm/better-sqlite3` or `drizzle-orm/node-sqlite`
// and connect to the local SQLite database directly.

// For now, this is a Workers-specific package.
// A Node.js adapter will be added in WS2 if needed.
```

## Token Hashing

All tokens (refresh tokens, verification tokens, reset tokens, machine tokens, etc.) are **hashed before storage** for security reasons.

When storing a token:
```typescript
import bcrypt from "bcrypt";

const plainToken = crypto.randomUUID();
const hashedToken = await bcrypt.hash(plainToken, 10);

await db.insert(schema.sessions).values({
  id: crypto.randomUUID(),
  user_id: userId,
  token: hashedToken,
  expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
});
```

When validating a token:
```typescript
const session = await db.query.sessions.findFirst({
  where: (sessions, { eq }) => eq(sessions.id, sessionId),
});

const isValid = await bcrypt.compare(plainToken, session.token);
```

## Schema Design Decisions

### Why UUID for IDs?
- Better than auto-increment for distributed systems
- Prevents ID enumeration attacks
- Works across multiple database instances

### Why ISO 8601 for Timestamps?
- Timezone-safe (always UTC)
- Sortable as strings
- Parseable by JavaScript `Date.parse()`
- Standard across APIs

### Why Soft Deletes?
- Preserves audit trail and foreign key relationships
- Allows data recovery if needed
- Keeps historical data intact

### Why Hashed Tokens?
- If the database is breached, tokens alone are useless
- Tokens must still be validated by comparing hashes
- Same security model as password hashing

### Why Separate Token Tables?
- Single-use tokens (verification, reset) are short-lived and should be cleaned up
- Long-lived tokens (sessions, machine tokens) need different expiration logic
- Each token type has different use cases and audit requirements

## Future Enhancements

- [ ] Add organization/workspace tables (Phase 4, WS4+)
- [ ] Add role-based access control (RBAC) tables (Phase 4, WS4+)
- [ ] Add notification preferences table (Phase 4, WS5+)
- [ ] Add activity feed / timeline tables (Phase 5+)
- [ ] Add subscription / billing tables (Phase 5+)
- [ ] Implement automatic cleanup of expired tokens (cron job or TTL)
- [ ] Add rate limiting / throttle tables (Phase 5+)

## API Integration

The database is consumed by the API backend (WS2):

- `/auth/signup` - Creates users table entry, sessions entry, and email_verification_tokens entry
- `/auth/login` - Validates user credentials, creates/rotates sessions entry
- `/auth/refresh` - Rotates refresh token in sessions table
- `/auth/logout` - Deletes or invalidates sessions entry
- `/auth/verify-email` - Validates email_verification_tokens entry, sets users.email_verified
- `/auth/request-password-reset` - Creates password_reset_tokens entry
- `/auth/reset-password` - Validates password_reset_tokens entry, updates users.password_hash
- `/api/machines` - CRUD operations on machine_tokens table

## Testing

This package includes TypeScript type checking. No runtime tests yet (test implementation is WS2).

```bash
pnpm run typecheck
```

## Linting

```bash
pnpm run lint
pnpm run lint:fix
```

## Building

```bash
pnpm run build
```

Outputs compiled types and JavaScript to `dist/`.
