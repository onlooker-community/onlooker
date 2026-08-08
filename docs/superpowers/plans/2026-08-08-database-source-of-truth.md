# Database Source of Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `packages/db` the only place the database schema is declared, and make the live databases provably match it.

**Architecture:** Drizzle owns the schema and generates migrations. `apps/api` imports it and queries through drizzle, keeping its existing function signatures so the characterization tests written in Task 1 stay meaningful across the rewrite. A schema verifier runs between migrate and deploy so a worker is never deployed against a database that does not match source.

**Tech Stack:** TypeScript, drizzle-orm 0.31 + drizzle-kit 0.20, Cloudflare D1, `@cloudflare/vitest-pool-workers` (miniflare-backed D1 in tests), Biome, pnpm workspaces.

**Bead:** onlooker-1g9.
**Spec:** `docs/superpowers/specs/2026-08-08-database-source-of-truth-design.md`.

## Global Constraints

- **`apps/api` function signatures do not change.** The six query functions keep `(db: D1Database, ...)`. The drizzle client is constructed inside. This is what lets Task 1's characterization tests stay green across Task 3, which is the entire safety mechanism of this plan. Do not "improve" this into a repository object or a service layer.
- **Three tables only:** `users`, `sessions`, `verification_tokens`. Do not add `email_change_tokens`, `machine_tokens`, or `audit_logs` — they are deliberately deferred to the features that need them.
- **`verification_tokens` stays one table with a `type` discriminator.** Do not split it into `email_verification_tokens` / `password_reset_tokens`.
- **No `IF NOT EXISTS` in any migration.** A migration meeting unexpected state must error, not no-op. This is the exact defect being fixed.
- **Formatting is Biome with tabs.** American English in comments and commit messages.
- **All commits route through the `/commit` skill**, per the repository's CLAUDE.md. Do not hand-write `git commit -m`.
- **Never run migrations or destructive SQL against production.** Task 5 is a human-executed runbook. Tasks 1–4 touch only local files and test databases.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/api/vitest.config.ts` | miniflare-backed D1 test harness | 1 |
| `apps/api/test/apply-migrations.ts` | applies migrations into the test D1 before each suite | 1 |
| `apps/api/src/db/queries.test.ts` | characterization tests for the six query functions | 1, 3 |
| `packages/db/src/schema.ts` | **the** schema declaration | 2 |
| `packages/db/drizzle.config.ts` | drizzle-kit config; currently points at a nonexistent file | 2 |
| `packages/db/migrations/` | generated migrations; old hand-written file removed | 2 |
| `apps/api/wrangler.toml` | `migrations_dir` repointed at the generated migrations | 2 |
| `apps/api/src/db/queries.ts` | six functions, same signatures, drizzle inside | 3 |
| `packages/db/src/expected-schema.ts` | generated snapshot of tables and indexes | 4 |
| `packages/db/scripts/verify-schema.mjs` | compares a live D1 against the snapshot | 4 |
| `.github/workflows/deploy.yml` | verifier wired between migrate and deploy | 4 |
| `docs/runbooks/2026-08-08-database-rebuild.md` | human-executed rebuild procedure | 5 |

---

## Task 1: D1 test harness and characterization tests

`apps/api` has no tests and no test script. This task adds both, pinning current
behavior **before** anything changes. It runs against the schema as it exists
today.

**Files:**
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/test/apply-migrations.ts`
- Create: `apps/api/src/db/queries.test.ts`
- Modify: `apps/api/package.json` (add `test` script and dev dependencies)

**Interfaces:**
- Consumes: the existing six exports of `apps/api/src/db/queries.ts` —
  `createUser(db, email, passwordHash, name?)`,
  `getUserByEmail(db, email)`, `getUserById(db, userId)`,
  `storeRefreshToken(db, userId, token, expiresAt: Date)`,
  `getRefreshToken(db, token)`, `revokeRefreshToken(db, token)`.
- Produces: a working `pnpm --filter @onlooker/api test`, and a test file later
  tasks must keep green.

- [ ] **Step 1: Add the dependencies and test script**

In `apps/api/package.json`, add to `devDependencies`:

```json
		"@cloudflare/vitest-pool-workers": "^0.5.0",
		"vitest": "^4.1.9"
```

and add to `scripts`:

```json
		"test": "vitest run"
```

Then run: `pnpm install`

- [ ] **Step 2: Create the harness config**

Create `apps/api/vitest.config.ts`:

```ts
import {
	defineWorkersConfig,
	readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

// Migrations are read at config time and handed to the test worker as a
// binding, then applied per-suite by test/apply-migrations.ts. This is the
// documented pattern for D1 in vitest-pool-workers.
export default defineWorkersConfig(async () => {
	const migrations = await readD1Migrations("./migrations");

	return {
		test: {
			setupFiles: ["./test/apply-migrations.ts"],
			poolOptions: {
				workers: {
					singleWorker: true,
					miniflare: {
						d1Databases: ["DB"],
						bindings: { TEST_MIGRATIONS: migrations },
					},
				},
			},
		},
	};
});
```

Create `apps/api/test/apply-migrations.ts`:

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

Create `apps/api/test/env.d.ts` so the bindings type-check:

```ts
declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
		TEST_MIGRATIONS: D1Migration[];
	}
}
```

- [ ] **Step 3: Smoke-test the harness before writing real tests**

The exact helper names above are version-sensitive. Prove the harness works in
isolation before depending on it. Create `apps/api/src/db/queries.test.ts` with
only this:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("harness", () => {
	it("has a migrated D1 with the users table", async () => {
		const row = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='users'",
		).first();
		expect(row).not.toBeNull();
	});
});
```

Run: `pnpm --filter @onlooker/api test`
Expected: PASS.

**If it fails**, the helper names or config shape differ in the installed
version. Check the installed package's own README under
`node_modules/@cloudflare/vitest-pool-workers/` and adjust — do not proceed to
Step 4 with a broken harness, and do not skip the harness to write tests
against a mock. A mocked D1 would pin the mock's behavior, not D1's, which
defeats the purpose of this task.

- [ ] **Step 4: Write the characterization tests**

Replace the contents of `apps/api/src/db/queries.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createUser,
	getRefreshToken,
	getUserByEmail,
	getUserById,
	revokeRefreshToken,
	storeRefreshToken,
} from "./queries.js";

// These pin the CONTRACT of each function - what callers observe - not the
// storage representation. Task 3 changes how email_verified is stored, so its
// assertion is deliberately about the semantic ("not yet verified"), never the
// literal column value. A test asserting the literal would have to be edited
// in Task 3, and an edited test pins nothing.

const db = () => env.DB;

beforeEach(async () => {
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM users").run();
});

describe("createUser", () => {
	it("returns the id, email and name of the created user", async () => {
		const result = await createUser(db(), "a@example.com", "hash", "Ada");

		expect(result.email).toBe("a@example.com");
		expect(result.name).toBe("Ada");
		expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("persists the user so it can be found by email", async () => {
		await createUser(db(), "b@example.com", "hash", "Grace");
		const found = await getUserByEmail(db(), "b@example.com");

		expect(found?.email).toBe("b@example.com");
		expect(found?.password_hash).toBe("hash");
	});

	it("creates the user as not yet verified", async () => {
		await createUser(db(), "c@example.com", "hash");
		const found = await getUserByEmail(db(), "c@example.com");

		// Semantic, not literal: false today, null after Task 3.
		expect(Boolean(found?.email_verified)).toBe(false);
	});

	it("accepts a user with no name", async () => {
		const result = await createUser(db(), "d@example.com", "hash");
		expect(result.email).toBe("d@example.com");
	});
});

describe("getUserByEmail", () => {
	it("returns null when no user has that email", async () => {
		expect(await getUserByEmail(db(), "nobody@example.com")).toBeNull();
	});
});

describe("getUserById", () => {
	it("finds a user by id and omits the password hash", async () => {
		const created = await createUser(db(), "e@example.com", "hash", "Alan");
		const found = await getUserById(db(), created.id);

		expect(found?.email).toBe("e@example.com");
		expect(found).not.toHaveProperty("password_hash");
	});

	it("returns null for an unknown id", async () => {
		expect(await getUserById(db(), "no-such-id")).toBeNull();
	});
});

describe("refresh tokens", () => {
	const future = () => new Date(Date.now() + 60_000);
	const past = () => new Date(Date.now() - 60_000);

	it("stores a token and retrieves it by its raw value", async () => {
		const user = await createUser(db(), "f@example.com", "hash");
		await storeRefreshToken(db(), user.id, "raw-token", future());

		const found = await getRefreshToken(db(), "raw-token");
		expect(found?.user_id).toBe(user.id);
	});

	it("does not store the raw token, only a hash", async () => {
		const user = await createUser(db(), "g@example.com", "hash");
		await storeRefreshToken(db(), user.id, "raw-token", future());

		const row = await db()
			.prepare("SELECT token_hash FROM sessions WHERE user_id = ?")
			.bind(user.id)
			.first<{ token_hash: string }>();

		expect(row?.token_hash).not.toBe("raw-token");
		expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("returns null for a token that was never stored", async () => {
		expect(await getRefreshToken(db(), "never-stored")).toBeNull();
	});

	it("returns null for an expired token even though the row exists", async () => {
		const user = await createUser(db(), "h@example.com", "hash");
		await storeRefreshToken(db(), user.id, "stale-token", past());

		expect(await getRefreshToken(db(), "stale-token")).toBeNull();

		const row = await db()
			.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
			.bind(user.id)
			.first<{ n: number }>();
		expect(row?.n).toBe(1);
	});

	it("stops returning a token once it is revoked", async () => {
		const user = await createUser(db(), "i@example.com", "hash");
		await storeRefreshToken(db(), user.id, "doomed-token", future());
		expect(await getRefreshToken(db(), "doomed-token")).not.toBeNull();

		await revokeRefreshToken(db(), "doomed-token");
		expect(await getRefreshToken(db(), "doomed-token")).toBeNull();
	});

	it("revoking a token that does not exist does not throw", async () => {
		await expect(
			revokeRefreshToken(db(), "not-a-real-token"),
		).resolves.toBeUndefined();
	});
});
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @onlooker/api test`
Expected: PASS, 14 tests. These describe the system as it is today.

- [ ] **Step 6: Confirm the suite is wired into the workspace**

Run: `pnpm test`
Expected: `@onlooker/api:test` now appears among the turbo tasks and passes.

- [ ] **Step 7: Commit**

Use the `/commit` skill with:

```
apps/api/package.json
apps/api/vitest.config.ts
apps/api/test/apply-migrations.ts
apps/api/test/env.d.ts
apps/api/src/db/queries.test.ts
pnpm-lock.yaml
```

Suggested subject: `test(api): pin auth query behavior before the drizzle move :safety_vest:`

The body should say these tests exist so the schema rewrite has something to
preserve, and that `apps/api` had no tests at all before this.

---

## Task 2: Make `packages/db` the authority

Corrects the schema, fixes the drizzle-kit config (which points at a file that
does not exist), generates the baseline migration, and repoints wrangler at it.

**Files:**
- Modify: `packages/db/src/schema.ts` (substantial rewrite)
- Modify: `packages/db/drizzle.config.ts`
- Delete: `packages/db/migrations/0001_create_auth_tables.sql`
- Create: `packages/db/migrations/` generated baseline
- Modify: `packages/db/src/__tests__/schema.test.ts`
- Modify: `apps/api/wrangler.toml` (two `migrations_dir` values)

**Interfaces:**
- Produces: `users`, `sessions`, `verification_tokens` drizzle tables exported
  from `@onlooker/db`, plus inferred types `User`, `NewUser`, `Session`,
  `NewSession`, `VerificationToken`, `NewVerificationToken`. Task 3 imports
  these. Column names are exactly:
  - `users`: `id`, `email`, `password_hash`, `name`, `email_verified`,
    `created_at`, `updated_at`
  - `sessions`: `id`, `user_id`, `token_hash`, `expires_at`, `created_at`
  - `verification_tokens`: `id`, `user_id`, `token`, `type`, `expires_at`,
    `created_at`

- [ ] **Step 1: Rewrite the schema**

Replace the entire contents of `packages/db/src/schema.ts`:

```ts
import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Users.
 *
 * email_verified holds an ISO 8601 timestamp, or null when unverified. A
 * boolean would record only whether, never when, and the API's own response
 * type (apps/api/src/types/responses.ts) already declares string | null.
 */
export const users = sqliteTable(
	"users",
	{
		id: text("id").primaryKey(),
		// Uniqueness is declared once, as a named index below. Adding .unique()
		// here as well would make drizzle emit both a UNIQUE constraint and a
		// separate unique index for the same column.
		email: text("email").notNull(),
		password_hash: text("password_hash").notNull(),
		name: text("name"),
		email_verified: text("email_verified"),
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
		updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	},
	(table) => ({
		emailIdx: uniqueIndex("users_email_idx").on(table.email),
		createdAtIdx: index("users_created_at_idx").on(table.created_at),
	}),
);

/**
 * Sessions - refresh tokens, stored hashed.
 *
 * The column is token_hash rather than token because that is what it holds;
 * apps/api SHA-256s the raw token before writing. UNIQUE is deliberate: two
 * sessions sharing a token hash is a defect, and production had lost this
 * constraint.
 */
export const sessions = sqliteTable(
	"sessions",
	{
		id: text("id").primaryKey(),
		user_id: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		token_hash: text("token_hash").notNull(),
		expires_at: text("expires_at").notNull(),
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	},
	(table) => ({
		tokenHashIdx: uniqueIndex("sessions_token_hash_idx").on(table.token_hash),
		userIdIdx: index("sessions_user_id_idx").on(table.user_id),
		expiresAtIdx: index("sessions_expires_at_idx").on(table.expires_at),
	}),
);

/**
 * Verification tokens for email verification and password reset.
 *
 * One table with a type discriminator rather than two tables, because the two
 * flows have identical shapes. email_change_tokens will be its own table when
 * that feature lands, since it carries a new_email column these do not.
 */
export const verification_tokens = sqliteTable(
	"verification_tokens",
	{
		id: text("id").primaryKey(),
		user_id: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		token: text("token").notNull(),
		type: text("type").notNull(),
		expires_at: text("expires_at").notNull(),
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	},
	(table) => ({
		tokenIdx: uniqueIndex("verification_tokens_token_idx").on(table.token),
		userIdIdx: index("verification_tokens_user_id_idx").on(table.user_id),
		typeIdx: index("verification_tokens_type_idx").on(table.type),
		expiresAtIdx: index("verification_tokens_expires_at_idx").on(
			table.expires_at,
		),
	}),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type VerificationToken = typeof verification_tokens.$inferSelect;
export type NewVerificationToken = typeof verification_tokens.$inferInsert;
```

- [ ] **Step 2: Check what `packages/db/src/index.ts` re-exports**

Run: `cat packages/db/src/index.ts`

If it names any of the deleted tables (`email_verification_tokens`,
`password_reset_tokens`, `email_change_tokens`, `machine_tokens`,
`audit_logs`), remove those exports. Keep exports for the three surviving
tables and their types.

- [ ] **Step 3: Fix the drizzle-kit config**

`packages/db/drizzle.config.ts` currently sets
`wranglerConfigPath: "../../wrangler.toml"`, which does not exist — the only
wrangler configs are `apps/api/wrangler.toml` and `apps/web/wrangler.toml` —
and `dbName: "onlooker"`, which matches neither real database
(`onlooker-db`, `onlooker-db-staging`). Replace the file:

```ts
import type { Config } from "drizzle-kit";

export default {
	schema: "./src/schema.ts",
	out: "./migrations",
	dialect: "sqlite",
	driver: "d1-http",
} satisfies Config;
```

`driver`/`dbCredentials` only matter for `drizzle-kit push` and `studio`, which
this repository does not use — migrations are applied by wrangler. Dropping the
broken credentials block is deliberate: a config pointing at a nonexistent file
is worse than no config, because it looks configured.

- [ ] **Step 4: Delete the stale hand-written migration and generate the baseline**

```bash
rm packages/db/migrations/0001_create_auth_tables.sql
rm -rf packages/db/migrations/meta
pnpm --filter @onlooker/db exec drizzle-kit generate
```

Expected: a new `packages/db/migrations/0000_*.sql` plus a `meta/` directory.

- [ ] **Step 5: Verify the generated SQL has no `IF NOT EXISTS`**

```bash
grep -c "IF NOT EXISTS" packages/db/migrations/*.sql || echo "none - good"
```

Expected: `none - good`. If drizzle-kit emitted `IF NOT EXISTS`, edit the
generated file to remove it. A migration that silently no-ops against
unexpected state is the exact defect this work exists to fix.

- [ ] **Step 6: Repoint wrangler at the generated migrations**

In `apps/api/wrangler.toml`, both `[[env.staging.d1_databases]]` and
`[[env.production.d1_databases]]` currently set `migrations_dir = "migrations"`.
Change both to:

```toml
migrations_dir = "../../packages/db/migrations"
```

Replace the existing comment above the staging entry with:

```toml
# Points at packages/db, which owns the schema and generates these migrations.
# Previously "migrations" (apps/api/migrations), which described a different
# schema than packages/db did - that divergence is what onlooker-1g9 fixed.
```

- [ ] **Step 7: Confirm wrangler resolves the new path**

```bash
pnpm --filter @onlooker/api exec wrangler d1 migrations list DB --env staging --remote
```

Expected: it lists the generated migration as unapplied. **If it errors on the
relative path**, wrangler will not read outside the app directory. In that case
stop and report — the fallback is to set drizzle's `out` to
`../../apps/api/migrations` instead and leave `migrations_dir` alone, but that
is a different decision and should not be made silently.

This command is read-only. It does not apply anything.

- [ ] **Step 8: Update the packages/db schema tests**

`packages/db/src/__tests__/schema.test.ts` currently asserts against the
seven-table schema. Replace its entire contents:

```ts
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { sessions, users, verification_tokens } from "../schema.js";

const columnNames = (table: Parameters<typeof getTableConfig>[0]) =>
	getTableConfig(table).columns.map((c) => c.name).sort();

const indexNames = (table: Parameters<typeof getTableConfig>[0]) =>
	getTableConfig(table).indexes.map((i) => i.config.name).sort();

describe("users", () => {
	it("declares exactly the columns apps/api queries", () => {
		expect(columnNames(users)).toEqual([
			"created_at",
			"email",
			"email_verified",
			"id",
			"name",
			"password_hash",
			"updated_at",
		]);
	});

	it("keeps email unique", () => {
		const idx = getTableConfig(users).indexes.find(
			(i) => i.config.name === "users_email_idx",
		);
		expect(idx?.config.unique).toBe(true);
	});

	it("allows email_verified to be null, meaning unverified", () => {
		const col = getTableConfig(users).columns.find(
			(c) => c.name === "email_verified",
		);
		expect(col?.notNull).toBe(false);
	});
});

describe("sessions", () => {
	it("stores a token hash, not a token", () => {
		expect(columnNames(sessions)).toContain("token_hash");
		expect(columnNames(sessions)).not.toContain("token");
	});

	// Production had lost this constraint; two sessions sharing a token hash
	// is a defect, so it is asserted rather than assumed.
	it("keeps token_hash unique", () => {
		const idx = getTableConfig(sessions).indexes.find(
			(i) => i.config.name === "sessions_token_hash_idx",
		);
		expect(idx?.config.unique).toBe(true);
	});

	it("cascades when its user is deleted", () => {
		const fk = getTableConfig(sessions).foreignKeys[0];
		expect(fk.onDelete).toBe("cascade");
	});
});

describe("verification_tokens", () => {
	it("is one table carrying a type discriminator", () => {
		expect(columnNames(verification_tokens)).toEqual([
			"created_at",
			"expires_at",
			"id",
			"token",
			"type",
			"user_id",
		]);
		expect(indexNames(verification_tokens)).toContain(
			"verification_tokens_type_idx",
		);
	});
});

describe("the schema as a whole", () => {
	// The deferred tables are deferred on purpose. If one reappears, it should
	// arrive with the feature that needs it, not by accident.
	it("declares only the three tables in use", async () => {
		const schema = await import("../schema.js");
		const tables = Object.values(schema).filter(
			(v) => v && typeof v === "object" && "_" in v,
		);
		expect(tables).toHaveLength(3);
	});
});
```

- [ ] **Step 9: Run the package's tests and typecheck**

```bash
pnpm --filter @onlooker/db test
pnpm --filter @onlooker/db typecheck
pnpm --filter @onlooker/db lint
```

Expected: all pass.

- [ ] **Step 10: Commit**

Use the `/commit` skill with:

```
packages/db/src/schema.ts
packages/db/src/index.ts
packages/db/drizzle.config.ts
packages/db/src/__tests__/schema.test.ts
packages/db/migrations/
apps/api/wrangler.toml
```

Suggested subject: `feat(db): make packages/db the only schema declaration :straight_ruler:`

The body should note the drizzle-kit config pointed at a wrangler.toml that
does not exist, which went unnoticed because nothing consumed this package.

---

## Task 3: Move `queries.ts` onto drizzle

**Files:**
- Modify: `apps/api/src/db/queries.ts`
- Modify: `apps/api/package.json` (add `@onlooker/db` and `drizzle-orm`)
- Modify: `apps/api/src/db/queries.test.ts` (only if a contract genuinely changed)

**Interfaces:**
- Consumes: `users`, `sessions` and their inferred types from `@onlooker/db`
  (Task 2).
- Produces: the same six exported functions with **unchanged signatures**. The
  exported `User` interface changes one field: `email_verified: boolean`
  becomes `email_verified: string | null`.

- [ ] **Step 1: Add the dependencies**

In `apps/api/package.json` `dependencies`:

```json
		"@onlooker/db": "workspace:*",
		"drizzle-orm": "^0.31.2"
```

Run: `pnpm install`

- [ ] **Step 2: Run the characterization tests first**

Run: `pnpm --filter @onlooker/api test`
Expected: PASS, 14 tests, unchanged from Task 1. This is the baseline the
rewrite must preserve. Do not edit these tests to make later steps easier.

- [ ] **Step 3: Rewrite the query functions**

Replace `apps/api/src/db/queries.ts`. Signatures are identical; only the bodies
and the `User.email_verified` type change.

```ts
import { sessions, users } from "@onlooker/db";
import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

export interface User {
	id: string;
	email: string;
	password_hash: string;
	name?: string;
	// ISO 8601 timestamp of verification, or null when unverified.
	email_verified: string | null;
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
 * The drizzle client is constructed per call rather than passed in, so these
 * signatures stay identical to the raw-D1 versions they replaced. That keeps
 * every call site in routes/auth.ts untouched and keeps the characterization
 * tests meaningful across this rewrite. Construction is a thin wrapper over
 * the binding, not a connection.
 */
const client = (db: D1Database) => drizzle(db as never);

export async function createUser(
	db: D1Database,
	email: string,
	passwordHash: string,
	name?: string,
): Promise<{ id: string; email: string; name?: string }> {
	const userId = crypto.randomUUID();
	const now = new Date().toISOString();

	await client(db)
		.insert(users)
		.values({
			id: userId,
			email,
			password_hash: passwordHash,
			name: name ?? null,
			email_verified: null,
			created_at: now,
			updated_at: now,
		});

	return { id: userId, email, name };
}

export async function getUserByEmail(
	db: D1Database,
	email: string,
): Promise<User | null> {
	const [row] = await client(db)
		.select()
		.from(users)
		.where(eq(users.email, email))
		.limit(1);

	return (row as User) ?? null;
}

export async function getUserById(
	db: D1Database,
	userId: string,
): Promise<Omit<User, "password_hash"> | null> {
	const [row] = await client(db)
		.select({
			id: users.id,
			email: users.email,
			name: users.name,
			email_verified: users.email_verified,
			created_at: users.created_at,
			updated_at: users.updated_at,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	return (row as Omit<User, "password_hash">) ?? null;
}

export async function storeRefreshToken(
	db: D1Database,
	userId: string,
	token: string,
	expiresAt: Date,
): Promise<void> {
	await client(db).insert(sessions).values({
		id: crypto.randomUUID(),
		user_id: userId,
		token_hash: await hashToken(token),
		expires_at: expiresAt.toISOString(),
		created_at: new Date().toISOString(),
	});
}

export async function getRefreshToken(
	db: D1Database,
	token: string,
): Promise<{ user_id: string; expires_at: string } | null> {
	const [row] = await client(db)
		.select({ user_id: sessions.user_id, expires_at: sessions.expires_at })
		.from(sessions)
		.where(eq(sessions.token_hash, await hashToken(token)))
		.limit(1);

	if (!row) return null;

	// Expiry is checked here rather than in SQL because expires_at is an ISO
	// string, so a SQL comparison would be lexicographic. Same behavior as the
	// raw-D1 version: an expired token reads as absent but its row remains.
	if (new Date(row.expires_at) < new Date()) return null;

	return { user_id: row.user_id, expires_at: row.expires_at };
}

export async function revokeRefreshToken(
	db: D1Database,
	token: string,
): Promise<void> {
	await client(db)
		.delete(sessions)
		.where(eq(sessions.token_hash, await hashToken(token)));
}

/**
 * SHA-256 of the raw token. Sessions store only this.
 */
async function hashToken(token: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(token);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 4: Run the characterization tests**

Run: `pnpm --filter @onlooker/api test`
Expected: PASS, all 14, **without editing them**.

If the `email_verified` test fails, check that it asserts
`Boolean(found?.email_verified)` and not a literal `false` — the semantic
assertion is the one that survives the representation change. If any *other*
test fails, that is a real behavior regression in the rewrite: fix the code,
not the test.

- [ ] **Step 5: Check the call sites still type-check**

Run: `pnpm --filter @onlooker/api typecheck`

Expected: PASS. `routes/auth.ts` passes `env.DB!` and is untouched. If
`email_verified` is compared against a boolean anywhere, update that call site
to a truthiness check.

- [ ] **Step 6: Verify the worker still builds**

Run: `pnpm --filter @onlooker/api build`
Expected: PASS (`tsc --noEmit && wrangler deploy --dry-run`). This is a dry run
and deploys nothing.

- [ ] **Step 7: Commit**

Use the `/commit` skill with:

```
apps/api/package.json
apps/api/src/db/queries.ts
pnpm-lock.yaml
```

Suggested subject: `refactor(api): query through drizzle instead of hand-written SQL :recycle:`

The body should explain that signatures were deliberately preserved so the
characterization tests stayed green across the change.

---

## Task 4: Schema verifier and deploy wiring

**Files:**
- Create: `packages/db/scripts/generate-expected-schema.mjs`
- Create: `packages/db/src/expected-schema.ts` (generated, committed)
- Create: `packages/db/scripts/verify-schema.mjs`
- Create: `packages/db/src/__tests__/expected-schema.test.ts`
- Create: `packages/db/src/__tests__/verify-schema.test.ts`
- Modify: `packages/db/package.json` (scripts)
- Modify: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: the three tables from Task 2.
- Produces: `packages/db/scripts/verify-schema.mjs`, invoked as
  `node scripts/verify-schema.mjs <database_name> <env>`, exiting non-zero with
  a printed diff when the live schema does not match `expected-schema.ts`.

- [ ] **Step 1: Write the failing test for the comparison logic**

Create `packages/db/src/__tests__/verify-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { diffSchema } from "../../scripts/verify-schema.mjs";

const expected = {
	users: {
		columns: [
			{ name: "id", type: "TEXT", notnull: 1, pk: 1 },
			{ name: "email", type: "TEXT", notnull: 1, pk: 0 },
		],
		indexes: ["users_email_idx"],
	},
};

describe("diffSchema", () => {
	it("reports no differences when live matches expected", () => {
		expect(diffSchema(expected, expected)).toEqual([]);
	});

	// The whole point of this verifier is that it can fail. A guard never
	// observed failing is indistinguishable from one that cannot fail - which
	// is exactly the bug being fixed here.
	it("reports a missing table", () => {
		const diffs = diffSchema(expected, {});
		expect(diffs.join(" ")).toMatch(/users/);
		expect(diffs).not.toHaveLength(0);
	});

	it("reports a missing column", () => {
		const live = {
			users: { columns: [expected.users.columns[0]], indexes: ["users_email_idx"] },
		};
		expect(diffSchema(expected, live).join(" ")).toMatch(/email/);
	});

	it("reports a column whose nullability changed", () => {
		const live = structuredClone(expected);
		live.users.columns[1].notnull = 0;
		expect(diffSchema(expected, live).join(" ")).toMatch(/notnull/);
	});

	it("reports a missing index", () => {
		const live = structuredClone(expected);
		live.users.indexes = [];
		expect(diffSchema(expected, live).join(" ")).toMatch(/users_email_idx/);
	});

	it("reports an unexpected extra table", () => {
		const live = { ...expected, audit_logs: { columns: [], indexes: [] } };
		expect(diffSchema(expected, live).join(" ")).toMatch(/audit_logs/);
	});
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @onlooker/db test`
Expected: FAIL — `verify-schema.mjs` does not exist.

- [ ] **Step 3: Write the comparison logic**

Create `packages/db/scripts/verify-schema.mjs`:

```js
import { execFileSync } from "node:child_process";

/**
 * Compares two schema descriptions and returns human-readable differences.
 *
 * Comparison is semantic rather than textual. SQLite stores CREATE TABLE text
 * verbatim, including comments, whitespace and ALTER-appended columns, so a
 * string compare would be both noisy and blind to what actually matters.
 */
export function diffSchema(expected, live) {
	const diffs = [];

	for (const [table, spec] of Object.entries(expected)) {
		const actual = live[table];
		if (!actual) {
			diffs.push(`missing table: ${table}`);
			continue;
		}

		for (const col of spec.columns) {
			const found = actual.columns.find((c) => c.name === col.name);
			if (!found) {
				diffs.push(`${table}: missing column ${col.name}`);
				continue;
			}
			for (const key of ["type", "notnull", "pk"]) {
				if (String(found[key]) !== String(col[key])) {
					diffs.push(
						`${table}.${col.name}: ${key} is ${found[key]}, expected ${col[key]}`,
					);
				}
			}
		}

		for (const col of actual.columns) {
			if (!spec.columns.find((c) => c.name === col.name)) {
				diffs.push(`${table}: unexpected column ${col.name}`);
			}
		}

		for (const idx of spec.indexes) {
			if (!actual.indexes.includes(idx)) {
				diffs.push(`${table}: missing index ${idx}`);
			}
		}
		for (const idx of actual.indexes) {
			if (!spec.indexes.includes(idx)) {
				diffs.push(`${table}: unexpected index ${idx}`);
			}
		}
	}

	for (const table of Object.keys(live)) {
		if (!expected[table]) diffs.push(`unexpected table: ${table}`);
	}

	return diffs;
}

/**
 * Tables Cloudflare and wrangler create. Our source does not declare them, so
 * they are not drift.
 */
const IGNORED = (name) =>
	name.startsWith("sqlite_") || name.startsWith("_cf_") || name === "d1_migrations";

function d1Query(database, env, sql) {
	const out = execFileSync(
		"pnpm",
		[
			"--filter", "@onlooker/api", "exec", "wrangler", "d1", "execute", database,
			"--env", env, "--remote", "--json", "--command", sql,
		],
		{ encoding: "utf8" },
	);
	return JSON.parse(out)[0].results;
}

export function readLiveSchema(database, env) {
	const tables = d1Query(
		database, env,
		"SELECT name FROM sqlite_master WHERE type='table'",
	)
		.map((r) => r.name)
		.filter((n) => !IGNORED(n));

	const live = {};
	for (const table of tables) {
		live[table] = {
			columns: d1Query(database, env, `PRAGMA table_info(${table})`).map((c) => ({
				name: c.name, type: c.type.toUpperCase(), notnull: c.notnull, pk: c.pk,
			})),
			indexes: d1Query(
				database, env,
				`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${table}' AND name NOT LIKE 'sqlite_%'`,
			).map((r) => r.name).sort(),
		};
	}
	return live;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [database, env] = process.argv.slice(2);
	const { EXPECTED_SCHEMA } = await import("../dist/expected-schema.js");
	const diffs = diffSchema(EXPECTED_SCHEMA, readLiveSchema(database, env));

	if (diffs.length > 0) {
		console.error(`Schema drift in ${database} (${env}):\n`);
		for (const d of diffs) console.error(`  - ${d}`);
		console.error("\nThe live database does not match packages/db/src/schema.ts.");
		process.exit(1);
	}
	console.log(`${database} (${env}) matches packages/db/src/schema.ts`);
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @onlooker/db test`
Expected: PASS, including all five failure cases.

- [ ] **Step 5: Generate the expected-schema snapshot**

Create `packages/db/scripts/generate-expected-schema.mjs`:

```js
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../dist/schema.js";

/**
 * Derived from the drizzle table objects, not from parsing the generated SQL.
 * Parsing SQL would be a second interpretation of the schema and could
 * disagree with drizzle's own; reading drizzle's metadata cannot.
 *
 * Types are upper-cased on both sides of the comparison because SQLite reports
 * whatever case the CREATE statement used, and that is not something worth
 * failing a deploy over.
 */
function describe(table) {
	const config = getTableConfig(table);

	return {
		columns: config.columns.map((c) => ({
			name: c.name,
			type: c.getSQLType().toUpperCase(),
			notnull: c.notNull ? 1 : 0,
			pk: c.primary ? 1 : 0,
		})),
		indexes: config.indexes.map((i) => i.config.name).sort(),
	};
}

const expected = {};
for (const [key, value] of Object.entries(schema)) {
	// Skip the exported types and anything that is not a drizzle table.
	if (value && typeof value === "object" && "_" in value) {
		expected[getTableConfig(value).name] = describe(value);
	}
}

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(
	resolve(here, "../src/expected-schema.ts"),
	"// GENERATED by scripts/generate-expected-schema.mjs - do not edit.\n" +
		"// Regenerate with: pnpm --filter @onlooker/db generate:expected-schema\n" +
		`export const EXPECTED_SCHEMA = ${JSON.stringify(expected, null, "\t")} as const;\n`,
);

console.log(`wrote src/expected-schema.ts (${Object.keys(expected).length} tables)`);
```

It reads from `dist/`, so build first:
`pnpm --filter @onlooker/db build`

Deriving the snapshot rather than hand-writing it is the point. A
hand-maintained snapshot would be another copy of the schema, which is the
problem this work exists to remove.

Because types are normalized to upper case here, apply the same normalization
in `readLiveSchema` — change its column mapping to
`type: c.type.toUpperCase()`.

Add to `packages/db/package.json` scripts:

```json
		"generate:expected-schema": "node scripts/generate-expected-schema.mjs",
		"verify:schema": "node scripts/verify-schema.mjs"
```

Run: `pnpm --filter @onlooker/db generate:expected-schema`

- [ ] **Step 6: Add the drift guard for the snapshot**

Create `packages/db/src/__tests__/expected-schema.test.ts` asserting that the
committed `expected-schema.ts` equals a freshly generated one, so the snapshot
cannot go stale. This mirrors the guard in
`packages/lesson-contract/src/json-schema.test.ts`, which already works in this
repository.

Run: `pnpm --filter @onlooker/db test`
Expected: PASS.

- [ ] **Step 7: Wire the verifier into the deploy workflow**

In `.github/workflows/deploy.yml`, after the step named
`Apply D1 migrations to Staging` and **before** `Deploy API to Staging`:

```yaml
      - name: Verify Staging schema matches source
        run: pnpm --filter @onlooker/db verify:schema onlooker-db-staging staging
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

And after `Apply D1 migrations to Production`, before `Deploy API to Production`:

```yaml
      - name: Verify Production schema matches source
        run: pnpm --filter @onlooker/db verify:schema onlooker-db production
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Placement is the point: a failure here stops the deploy before a worker ships
against a schema it does not expect.

The verifier imports from `../dist/`, so the deploy must build `@onlooker/db`
before this step. Confirm the existing build step covers it; if not, add
`pnpm --filter @onlooker/db build` ahead of the verification step.

- [ ] **Step 8: Full checks**

```bash
pnpm --filter @onlooker/db test
pnpm --filter @onlooker/db lint
pnpm test
```

Expected: all pass.

- [ ] **Step 9: Commit**

Use the `/commit` skill with:

```
packages/db/scripts/verify-schema.mjs
packages/db/scripts/generate-expected-schema.mjs
packages/db/src/expected-schema.ts
packages/db/src/__tests__/verify-schema.test.ts
packages/db/src/__tests__/expected-schema.test.ts
packages/db/package.json
.github/workflows/deploy.yml
```

Suggested subject: `feat(ci): fail the deploy when a database drifts from source :rotating_light:`

The body should explain that a migration once recorded itself as applied while
changing nothing, so the deploy now checks the live database instead of
trusting the migration ledger.

---

## Task 5: Rebuild the databases — HUMAN-EXECUTED RUNBOOK

> **Do not execute this task autonomously.** It drops production tables. An
> agent's job here ends at writing the runbook and confirming staging. A human
> runs the production section, with the export in hand.

**Files:**
- Create: `docs/runbooks/2026-08-08-database-rebuild.md`

- [ ] **Step 1: Write the runbook**

Create `docs/runbooks/2026-08-08-database-rebuild.md` documenting, as numbered
commands a human can paste:

1. **Export production first.**
   `pnpm --filter @onlooker/api exec wrangler d1 export onlooker-db --env production --remote --output prod-backup-2026-08-08.sql`
   Then confirm the file contains the single `users` row before continuing.
   Everything after this step is destructive; this file is the only way back.
2. **Capture the user row**, so it can be reinserted with the new column set:
   `SELECT id, email, password_hash, COALESCE(name, first_name || ' ' || last_name) AS name, email_verified, created_at, updated_at FROM users;`
   Record the result in the runbook as it is run.
3. **Staging first.** Drop every table including `d1_migrations`, then
   `pnpm migrate:staging`, then
   `pnpm --filter @onlooker/db verify:schema onlooker-db-staging staging`.
4. **Confirm staging works** — a real signup and login round-trip against
   `api-staging.onlooker.dev`, not just a 200 from the root path.
5. **Production**, only after staging passes. Same drop, then `pnpm migrate:prod`,
   then the production verifier.
6. **Reinsert the user**, mapping the old boolean `email_verified` to an ISO
   timestamp if it was true, or `NULL` if it was false.
7. **Confirm production** — log in as that user. Sessions were dropped, so a
   re-login is expected and is the check.

- [ ] **Step 2: Commit the runbook**

Use the `/commit` skill with `docs/runbooks/2026-08-08-database-rebuild.md`.

Suggested subject: `docs(runbook): rebuild both D1 databases from the new baseline :clipboard:`

- [ ] **Step 3: Hand off**

Report to the human that Tasks 1–4 are complete and the runbook is ready, and
that production has not been touched. Do not run step 5 of the runbook.

---

## Definition of Done

- `pnpm test` passes, including the new `@onlooker/api` suite
- the six query functions have identical signatures to before this work
- `packages/db` declares three tables; `apps/api` declares none
- no migration contains `IF NOT EXISTS`
- `verify-schema` has tests proving it *fails* on a missing table, a missing
  column, a changed nullability, a missing index, and an unexpected table
- the deploy workflow verifies schema between migrate and deploy, in both
  environments
- the runbook is committed and production is untouched by any agent

## Not in this plan

Lesson storage tables — subsystem 3 defines those, and this work exists so it
can build on a schema whose declared and real states agree.

The repository/service layering that `typescript-architect:backend-architecture`
recommends. It is a real improvement and is deliberately deferred: it would
change every call site and invalidate the characterization tests that make this
rewrite safe. It becomes cheap *after* this plan, because this plan is what
gives `apps/api` a test harness. Worth its own bead.
