# Failed-Login Backoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After four failed logins against the same address, refuse the fifth and each after it for a cooldown that doubles from 1m to a 30m cap.

**Architecture:** A `login_attempts` table in D1 keyed by the sha256 of the submitted address, incremented by one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` so concurrent failures cannot both read a stale count. `handleLogin` reads it before bcrypt and refuses with 429 + `Retry-After`. The cooldown is derived from `fails` and `last_fail_at` by a pure `cooldownFor`, never stored. Expired rows are pruned by the cron the worker already runs.

**Tech Stack:** Cloudflare Workers + D1 (raw `db.prepare`), drizzle-kit for the migration, vitest with `@cloudflare/vitest-pool-workers`, biome.

**Spec:** `docs/superpowers/specs/2026-10-14-login-backoff-design.md`. Bead: `onlooker-9s0m`. Branch: `meagan/9s0m-login-backoff`, based on `7cd6de7`.

## Global Constraints

- **American English** in every comment, identifier, test name, and commit message.
- **Tabs for indentation.** biome enforces it; `pnpm exec biome check --write <files>` before each commit.
- **Edit tracked files with `Edit`/`Write`, never `sed -i` or heredocs.** The `lineage` and `inspector` plugins hook `PostToolUse` on the file tools, so a shell edit moves the same bytes invisibly and `/lineage` then answers "no record" for a line that was demonstrably written. Project CLAUDE.md; it overrides any general shell preference.
- **Commit through `/git-workflow:commit`**, every time. Conventional commits, subject ≤72 chars including a mood emoji that reflects *this* change, body ≤80 cols explaining why.
- **Reuse `hashToken`** (`apps/api/src/utils/crypto.ts:94`) for the key. Its comment says "The one hash. Imported, never re-declared - two copies drift apart with no symptom until one changes and the other doesn't." Do not write a second sha256.
- **Four gates before the PR**, per the lesson of PR #188: `pnpm --filter @onlooker/api test`, `typecheck`, `lint`, and `bash scripts/source-guards.test.sh` — the last is wired into no pnpm script, so no local sweep runs it unless named.
- **A fresh worktree needs `pnpm install` and `pnpm --filter "@onlooker/api^..." build`** before API tests resolve `@onlooker-community/lesson-contract`. Note the `^` — `@onlooker/api...` includes the app itself, whose `build` is `tsc --noEmit` and will fail on a half-written task.
- **The cooldown is never stored.** `cooldownFor(fails)` plus `last_fail_at` is the only source of truth. A `locked_until` column would be a second one.
- **Fail open** (spec D6): every call into `login_attempts` is wrapped so a D1 failure lets the login proceed rather than 500ing or locking everyone out.
- **Task tracking is `bd`.** Not TodoWrite, not markdown checklists.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/api/src/types/index.ts:117-127` | `ApiError` gains optional response headers | 1 |
| `apps/api/src/middleware/error.ts:57-71` | `errorHandler` merges them onto the response | 1 |
| `apps/api/src/middleware/error.test.ts` | that merge, and that `Content-Type` survives it | 1 |
| `apps/api/src/db/login-attempts.ts` | the curve, the three statements, the prune — all of it | 2, 3, 5 |
| `apps/api/src/db/login-attempts.test.ts` | curve boundaries, the statements, concurrency, prune | 2, 3, 5 |
| `packages/db/src/schema.ts` | the `login_attempts` table | 3 |
| `packages/db/migrations/0015_*.sql` | generated, never hand-written | 3 |
| `packages/db/src/expected-schema.ts` | generated; the schema test reads it | 3 |
| `apps/api/src/routes/auth.ts:101-155` | the gate, the recording, the clear on success | 4 |
| `apps/api/src/routes/login-backoff.test.ts` | the route's behavior, including the ablation | 4 |
| `apps/api/src/scheduled.ts` | prune rides the existing cron | 5 |
| `apps/api/src/scheduled.test.ts` | ordering and the catch, as the sibling prune is pinned | 5 |

---

### Task 1: Let an ApiError carry response headers

**Files:**
- Modify: `apps/api/src/types/index.ts:117-127`
- Modify: `apps/api/src/middleware/error.ts:57-71`
- Test: `apps/api/src/middleware/error.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `new ApiError(status, code, message, details?, headers?)` where `headers?: Record<string, string>`, and an `errorHandler` that merges them. Task 4 needs this to send `Retry-After`.

Why this is its own task: `errorHandler` builds every error response in the API with `headers: { "Content-Type": "application/json" }` and nothing else, so a thrown `ApiError` cannot carry `Retry-After` today. A 429 without it tells a client to back off without saying for how long. WS5's remaining slices (per-account quotas, mail throttling) each need the same header.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/middleware/error.test.ts`, beside the existing `describe("errorHandler")`:

```typescript
describe("errorHandler on an error carrying headers", () => {
	it("merges them onto the response", () => {
		const res = errorHandler(
			new ApiError(429, "rate_limit_exceeded", "Slow down", undefined, {
				"Retry-After": "60",
			}),
		);

		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("60");
	});

	// The envelope is JSON whatever the caller passes, so Content-Type is
	// applied last and cannot be displaced by a careless header map.
	it("keeps its own Content-Type", () => {
		const res = errorHandler(
			new ApiError(429, "rate_limit_exceeded", "Slow down", undefined, {
				"Content-Type": "text/plain",
			}),
		);

		expect(res.headers.get("Content-Type")).toBe("application/json");
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @onlooker/api exec vitest run src/middleware/error.test.ts`
Expected: FAIL. The first case gets `null` for `Retry-After` — `ApiError` has no fifth parameter, so the object is dropped and nothing reaches the response. The second case may pass already, since nothing can displace `Content-Type` yet; it is here to stop the merge in step 3 from being written the other way round.

- [ ] **Step 3: Add the parameter**

In `apps/api/src/types/index.ts`, extend the constructor:

```typescript
export class ApiError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
		public details?: unknown,
		/**
		 * Extra response headers. Rate-limit refusals carry `Retry-After`,
		 * which is the difference between "back off" and "back off for this
		 * long" - errorHandler used to build every error response with only a
		 * Content-Type, so there was no way to say the second one.
		 */
		public headers?: Record<string, string>,
	) {
		super(message);
		this.name = "ApiError";
	}
}
```

- [ ] **Step 4: Merge them in the handler**

In `apps/api/src/middleware/error.ts`, in the `error instanceof ApiError` branch, replace the headers object:

```typescript
			{
				status: error.status,
				// Content-Type last: the envelope below is JSON whatever a
				// caller passes, so a careless header map must not displace it.
				headers: { ...error.headers, "Content-Type": "application/json" },
			},
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @onlooker/api exec vitest run src/middleware/error.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 6: Commit**

Invoke `/git-workflow:commit` with the three files. The why: a 429 that cannot say how long to wait is half an answer, and WS5 has three more refusals coming.

---

### Task 2: The curve

**Files:**
- Create: `apps/api/src/db/login-attempts.ts`
- Test: `apps/api/src/db/login-attempts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `cooldownFor(fails: number): number` returning milliseconds, `FREE_ATTEMPTS = 4`, and `MAX_COOLDOWN_MS = 1_800_000`. Tasks 3, 4 and 5 all import from this module.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/db/login-attempts.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { cooldownFor, FREE_ATTEMPTS, MAX_COOLDOWN_MS } from "./login-attempts.js";

const MINUTE = 60_000;

describe("cooldownFor", () => {
	// Four free attempts is the whole reason a legitimate user who mistypes
	// twice is never delayed. If this boundary moves, that promise moves.
	it("charges nothing for the first four failures", () => {
		expect(cooldownFor(1)).toBe(0);
		expect(cooldownFor(FREE_ATTEMPTS)).toBe(0);
	});

	it("doubles from one minute once the threshold is crossed", () => {
		expect(cooldownFor(5)).toBe(1 * MINUTE);
		expect(cooldownFor(6)).toBe(2 * MINUTE);
		expect(cooldownFor(7)).toBe(4 * MINUTE);
		expect(cooldownFor(8)).toBe(8 * MINUTE);
		expect(cooldownFor(9)).toBe(16 * MINUTE);
	});

	it("caps at thirty minutes however long the run gets", () => {
		expect(cooldownFor(10)).toBe(MAX_COOLDOWN_MS);
		expect(cooldownFor(50)).toBe(MAX_COOLDOWN_MS);
		// Doubling without a cap reaches centuries by fails=60, which is both
		// absurd and a denial of service against the account's real owner.
		expect(cooldownFor(500)).toBe(MAX_COOLDOWN_MS);
	});

	it("treats a nonsense count as no cooldown rather than a negative one", () => {
		expect(cooldownFor(0)).toBe(0);
		expect(cooldownFor(-3)).toBe(0);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @onlooker/api exec vitest run src/db/login-attempts.test.ts`
Expected: FAIL — the module does not exist, so the suite fails to load.

- [ ] **Step 3: Write the module**

Create `apps/api/src/db/login-attempts.ts`:

```typescript
import type { D1Database } from "@cloudflare/workers-types";

/**
 * Failed-login backoff, per submitted address.
 *
 * The whole policy and its three statements live here. See
 * docs/superpowers/specs/2026-10-14-login-backoff-design.md for why it is an
 * escalating cooldown rather than a lockout, and why the key is a hash of
 * every address rather than a user id.
 */

/** Failures answered normally before any cooldown applies. */
export const FREE_ATTEMPTS = 4;

/** The cooldown the first charged failure earns. */
const FIRST_COOLDOWN_MS = 60_000;

/**
 * The ceiling. Doubling without one reaches centuries within sixty failures,
 * which stops being a rate limit and becomes a denial of service against the
 * account's real owner - who may be the person failing to log in.
 */
export const MAX_COOLDOWN_MS = 30 * 60_000;

/**
 * How long a run of `fails` consecutive failures should be refused for.
 *
 * Pure, so the policy is testable without a database, and the single place the
 * curve exists - the table stores a count, never a deadline, so the two cannot
 * disagree and a change here applies to records already written.
 */
export function cooldownFor(fails: number): number {
	if (fails <= FREE_ATTEMPTS) return 0;

	const doublings = fails - FREE_ATTEMPTS - 1;
	return Math.min(FIRST_COOLDOWN_MS * 2 ** doublings, MAX_COOLDOWN_MS);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @onlooker/api exec vitest run src/db/login-attempts.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

Invoke `/git-workflow:commit` with the two files.

---

### Task 3: The table and the three statements

**Files:**
- Modify: `packages/db/src/schema.ts` (after `machine_tokens`, which ends at `:198`)
- Create: `packages/db/migrations/0015_*.sql` (generated)
- Modify: `packages/db/src/expected-schema.ts` (generated)
- Modify: `packages/db/src/__tests__/schema.test.ts`
- Modify: `apps/api/src/db/login-attempts.ts`
- Test: `apps/api/src/db/login-attempts.test.ts`

**Interfaces:**
- Consumes: `cooldownFor`, `FREE_ATTEMPTS` from Task 2.
- Produces:
  - `loginAttemptKey(email: string): Promise<string>` — the hashed key.
  - `activeCooldownMs(db, key, now?): Promise<number>` — milliseconds still to wait, 0 if none.
  - `recordLoginFailure(db, key, now?): Promise<number>` — the new cooldown in milliseconds, 0 while under the threshold.
  - `clearLoginAttempts(db, key): Promise<void>`.

  Task 4 calls all four.

- [ ] **Step 1: Add the table to the schema**

In `packages/db/src/schema.ts`, following the index idiom already used by `users` (`:47-50`) and `sessions` (`:72-76`):

```typescript
/**
 * Failed sign-in attempts, keyed by a hash of the submitted address.
 *
 * Not by user id, deliberately: a row exists whether or not the address has an
 * account, so a 429 says nothing about which addresses are real. Login's 401 is
 * identical for both cases on purpose, and keying this table on a user would
 * hand back the enumeration oracle that identical text exists to deny.
 *
 * Hashed so the table is never a harvestable list of attempted addresses.
 *
 * There is no `locked_until`: the cooldown is a function of `fails` and
 * `last_fail_at` (see cooldownFor in apps/api/src/db/login-attempts.ts), and a
 * stored deadline would be a second source of truth for the same fact.
 */
export const login_attempts = sqliteTable(
	"login_attempts",
	{
		key: text("key").primaryKey(),
		fails: integer("fails").notNull(),
		last_fail_at: text("last_fail_at").notNull(),
	},
	(table) => ({
		lastFailAtIdx: index("login_attempts_last_fail_at_idx").on(
			table.last_fail_at,
		),
	}),
);
```

- [ ] **Step 2: Generate the migration and the expected schema**

```bash
pnpm --filter @onlooker/db generate:migrations
pnpm --filter @onlooker/db generate:expected-schema
```

Expected: a new `packages/db/migrations/0015_<name>.sql` creating the table and the index, a new `meta/0015_snapshot.json`, an updated `meta/_journal.json`, and `login_attempts` added to `EXPECTED_SCHEMA`. Never hand-write any of these four — `expected-schema.ts` says "GENERATED … do not edit" at the top.

- [ ] **Step 3: Write the failing schema test**

Add to `packages/db/src/__tests__/schema.test.ts`, matching the existing per-table `describe` blocks:

```typescript
describe("login_attempts", () => {
	it("keys on the hash and indexes the prune's column", () => {
		const table = EXPECTED_SCHEMA.login_attempts;

		expect(table.columns.find((c) => c.name === "key")?.pk).toBe(1);
		expect(table.columns.find((c) => c.name === "fails")?.notnull).toBe(1);
		expect(table.columns.find((c) => c.name === "last_fail_at")?.notnull).toBe(
			1,
		);
		// The one query that does not go through the primary key.
		expect(table.indexes).toContain("login_attempts_last_fail_at_idx");
	});

	// Storing a deadline alongside the count would let the two disagree.
	it("stores no deadline", () => {
		expect(
			EXPECTED_SCHEMA.login_attempts.columns.map((c) => c.name),
		).not.toContain("locked_until");
	});
});
```

Read the existing blocks first and match how they reach into `EXPECTED_SCHEMA` — if indexes are exposed under a different key than `indexes`, use theirs rather than inventing one.

- [ ] **Step 4: Run the schema test**

Run: `pnpm --filter @onlooker/db test`
Expected: PASS once the generators in step 2 have run. If it fails on a missing `login_attempts` key, step 2 did not complete.

- [ ] **Step 5: Write the failing statement tests**

Add to `apps/api/src/db/login-attempts.test.ts`. These need D1, so they use the workers pool's `env` the way `db/lessons.test.ts:1-17` does:

```typescript
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	activeCooldownMs,
	clearLoginAttempts,
	loginAttemptKey,
	recordLoginFailure,
} from "./login-attempts.js";

const db = () => env.DB;

beforeEach(async () => {
	await db().prepare("DELETE FROM login_attempts").run();
});

describe("recordLoginFailure", () => {
	it("charges nothing for the first four and a minute for the fifth", async () => {
		const key = await loginAttemptKey("ada@example.com");

		for (let i = 0; i < 4; i++) {
			expect(await recordLoginFailure(db(), key)).toBe(0);
		}

		expect(await recordLoginFailure(db(), key)).toBe(60_000);
	});

	// The reason this is one statement. Two concurrent failures that each read
	// the count, add one, and write it back would land as one.
	it("counts two simultaneous failures as two", async () => {
		const key = await loginAttemptKey("ada@example.com");

		await Promise.all([
			recordLoginFailure(db(), key),
			recordLoginFailure(db(), key),
		]);

		const row = await db()
			.prepare("SELECT fails FROM login_attempts WHERE key = ?")
			.bind(key)
			.first<{ fails: number }>();
		expect(row?.fails).toBe(2);
	});

	it("counts each address separately", async () => {
		const ada = await loginAttemptKey("ada@example.com");
		const bob = await loginAttemptKey("bob@example.com");

		for (let i = 0; i < 5; i++) await recordLoginFailure(db(), ada);

		expect(await activeCooldownMs(db(), bob)).toBe(0);
	});

	it("keys on the address case-insensitively, after trimming", async () => {
		expect(await loginAttemptKey("  Ada@Example.com ")).toBe(
			await loginAttemptKey("ada@example.com"),
		);
	});
});

describe("activeCooldownMs", () => {
	it("is zero for an address nobody has failed against", async () => {
		expect(await activeCooldownMs(db(), await loginAttemptKey("new@x.com"))).toBe(
			0,
		);
	});

	it("counts down from the last failure", async () => {
		const key = await loginAttemptKey("ada@example.com");
		const start = new Date("2026-10-14T12:00:00.000Z");
		for (let i = 0; i < 5; i++) await recordLoginFailure(db(), key, start);

		// 40 seconds into a 60 second cooldown.
		const waited = new Date(start.getTime() + 40_000);
		expect(await activeCooldownMs(db(), key, waited)).toBe(20_000);
	});

	it("is zero once the cooldown has run out", async () => {
		const key = await loginAttemptKey("ada@example.com");
		const start = new Date("2026-10-14T12:00:00.000Z");
		for (let i = 0; i < 5; i++) await recordLoginFailure(db(), key, start);

		const later = new Date(start.getTime() + 61_000);
		expect(await activeCooldownMs(db(), key, later)).toBe(0);
	});
});

describe("clearLoginAttempts", () => {
	// Otherwise yesterday's four typos add to today's, and a legitimate user
	// who has logged in successfully since is one mistake from a cooldown.
	it("forgets the run entirely", async () => {
		const key = await loginAttemptKey("ada@example.com");
		for (let i = 0; i < 5; i++) await recordLoginFailure(db(), key);

		await clearLoginAttempts(db(), key);

		expect(await activeCooldownMs(db(), key)).toBe(0);
		expect(await recordLoginFailure(db(), key)).toBe(0);
	});
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm --filter @onlooker/api exec vitest run src/db/login-attempts.test.ts`
Expected: FAIL — the four functions do not exist, so the suite fails to load. If instead it fails with "no such table: login_attempts", the migration from step 2 has not reached the test database; check that `0015` appears in `meta/_journal.json`.

- [ ] **Step 7: Write the statements**

Append to `apps/api/src/db/login-attempts.ts`:

```typescript
import { hashToken } from "../utils/crypto.js";

/**
 * The key for an address: lowercased, trimmed, hashed.
 *
 * `hashToken` is the repository's one sha256 and its comment asks to be
 * imported rather than re-declared, because two copies drift apart with no
 * symptom until one changes.
 */
export async function loginAttemptKey(email: string): Promise<string> {
	return hashToken(email.trim().toLowerCase());
}

/**
 * Milliseconds still to wait before this address may try again, or 0.
 *
 * One primary-key read, run before bcrypt so a refused attempt costs no hash.
 */
export async function activeCooldownMs(
	db: D1Database,
	key: string,
	now: Date = new Date(),
): Promise<number> {
	const row = await db
		.prepare("SELECT fails, last_fail_at FROM login_attempts WHERE key = ?")
		.bind(key)
		.first<{ fails: number; last_fail_at: string }>();

	if (!row) return 0;

	const elapsed = now.getTime() - new Date(row.last_fail_at).getTime();
	return Math.max(cooldownFor(row.fails) - elapsed, 0);
}

/**
 * Count one failure and answer the cooldown it earns, 0 while under the
 * threshold.
 *
 * One statement, for the reason db/orgs.ts records for removeMembership and
 * #198 and #200 both followed: a read followed by a write lets two concurrent
 * failures each see the old count and land as one.
 */
export async function recordLoginFailure(
	db: D1Database,
	key: string,
	now: Date = new Date(),
): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO login_attempts (key, fails, last_fail_at)
			 VALUES (?, 1, ?)
			 ON CONFLICT(key) DO UPDATE
			   SET fails = fails + 1, last_fail_at = excluded.last_fail_at
			 RETURNING fails`,
		)
		.bind(key, now.toISOString())
		.first<{ fails: number }>();

	return cooldownFor(row?.fails ?? 0);
}

/** Forget this address's run, which a successful sign-in earns. */
export async function clearLoginAttempts(
	db: D1Database,
	key: string,
): Promise<void> {
	await db.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
}
```

- [ ] **Step 8: Run them to verify they pass**

Run: `pnpm --filter @onlooker/api exec vitest run src/db/login-attempts.test.ts`
Expected: PASS, 10 tests (4 from Task 2 plus 6 here).

- [ ] **Step 9: Prove the single statement by ablation**

Replace the `INSERT ... ON CONFLICT` body with the read-then-write it exists to avoid:

```typescript
	const existing = await db
		.prepare("SELECT fails FROM login_attempts WHERE key = ?")
		.bind(key)
		.first<{ fails: number }>();
	const fails = (existing?.fails ?? 0) + 1;
	await db
		.prepare(
			`INSERT INTO login_attempts (key, fails, last_fail_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET fails = ?, last_fail_at = ?`,
		)
		.bind(key, fails, now.toISOString(), fails, now.toISOString())
		.run();
	return cooldownFor(fails);
```

Run the file again. Expected: "counts two simultaneous failures as two" FAILS with `fails` of 1. Restore the single statement and re-run to green.

If it passes anyway, the two promises are not actually overlapping in this pool and the test is worthless as written — say so rather than keeping it, and reach for `db.batch` or a tighter construction.

- [ ] **Step 10: Commit**

Invoke `/git-workflow:commit` with the schema, the generated migration files, the schema test, and the two `login-attempts` files.

---

### Task 4: The gate in handleLogin

**Files:**
- Modify: `apps/api/src/routes/auth.ts:101-155`
- Test: `apps/api/src/routes/login-backoff.test.ts` (create)

**Interfaces:**
- Consumes: `loginAttemptKey`, `activeCooldownMs`, `recordLoginFailure`, `clearLoginAttempts` from Task 3; the `headers` parameter from Task 1.
- Produces: the finished behavior. Nothing depends on it.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/login-backoff.test.ts`. The helpers are the ones `routes/account-deletion.test.ts:1-17` uses.

```typescript
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { TEST_PASSWORD } from "../test-support/lessons.js";
import { call, resetOrgTables, signup } from "../test-support/orgs.js";

// handleLogin had no gate of any kind, and the only rate limiting the API has
// is one zone rule at 60 req/min per IP - the wrong unit for a login, and one
// an attacker answers by rotating addresses. onlooker-9s0m.

const db = () => env.DB;
const EMAIL = "ada@example.com";

interface ErrorBody {
	success: false;
	error: { code: string; message: string };
}

beforeEach(async () => {
	await resetOrgTables();
	await db().prepare("DELETE FROM login_attempts").run();
	await signup(EMAIL);
});

const login = (email: string, password: string) =>
	call("/auth/login", null, {
		method: "POST",
		body: JSON.stringify({ email, password }),
	});

const failFourTimes = async (email: string) => {
	for (let i = 0; i < 4; i++) {
		expect((await login(email, "wrong-password")).status).toBe(401);
	}
};

describe("POST /auth/login under repeated failure", () => {
	it("answers 401 four times, then refuses with 429 and a Retry-After", async () => {
		await failFourTimes(EMAIL);

		const refused = await login(EMAIL, "wrong-password");

		expect(refused.status).toBe(429);
		expect((await refused.json() as ErrorBody).error.code).toBe(
			"rate_limit_exceeded",
		);
		// The difference between "back off" and "back off for this long".
		expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
	});

	// The cooldown is not a password check. Answering the correct password
	// during one would let an attacker use the cooldown as an oracle for
	// "that guess was right", which is the opposite of the point.
	it("refuses the correct password while the cooldown is active", async () => {
		await failFourTimes(EMAIL);
		await login(EMAIL, "wrong-password");

		expect((await login(EMAIL, TEST_PASSWORD)).status).toBe(429);
	});

	it("lets a correct password through once the cooldown has expired", async () => {
		await failFourTimes(EMAIL);
		await login(EMAIL, "wrong-password");
		// Reach into the row rather than waiting a minute: the cooldown is
		// derived from last_fail_at, so moving that back is the same thing as
		// time passing, and the suite stays fast.
		await db()
			.prepare("UPDATE login_attempts SET last_fail_at = ?")
			.bind(new Date(Date.now() - 120_000).toISOString())
			.run();

		expect((await login(EMAIL, TEST_PASSWORD)).status).toBe(200);
	});

	it("forgets the run after a successful sign-in", async () => {
		await failFourTimes(EMAIL);

		expect((await login(EMAIL, TEST_PASSWORD)).status).toBe(200);

		// Four more failures must start from zero, so the fourth is still a 401.
		await failFourTimes(EMAIL);
	});

	// D3, and the test a later refactor is most likely to break by keying on
	// user_id for convenience. An address with no account must be counted and
	// refused exactly like one that exists, or the 429 becomes an oracle for
	// which addresses are real.
	it("refuses an address with no account identically", async () => {
		const unknown = "nobody@example.com";
		await failFourTimes(unknown);

		const refused = await login(unknown, "wrong-password");

		expect(refused.status).toBe(429);
		expect((await refused.json() as ErrorBody).error.code).toBe(
			"rate_limit_exceeded",
		);
	});

	it("counts each address separately", async () => {
		await failFourTimes(EMAIL);
		await login(EMAIL, "wrong-password");

		// A second account is untouched by the first one's run.
		const other = await signup("bob@example.com");
		expect(other.token).toBeTruthy();
	});

	// The property this whole keying scheme protects, asserted on the bytes
	// rather than on the status: if the two 401s ever differ - a different
	// message, a details field on one of them - the response becomes an oracle
	// for which addresses have accounts, and no amount of counting hides it.
	it("answers an unknown address and a wrong password identically", async () => {
		const unknown = await login("nobody@example.com", "wrong-password");
		const wrong = await login(EMAIL, "wrong-password");

		expect(unknown.status).toBe(wrong.status);
		expect(await unknown.text()).toBe(await wrong.text());
	});

	// And the same at the threshold, which is the case the 429 could break.
	it("answers both at the threshold identically", async () => {
		await failFourTimes("nobody@example.com");
		const unknown = await login("nobody@example.com", "wrong-password");
		await failFourTimes(EMAIL);
		const wrong = await login(EMAIL, "wrong-password");

		expect(unknown.status).toBe(429);
		expect(wrong.status).toBe(429);
		expect(await unknown.text()).toBe(await wrong.text());
	});
});

describe("POST /auth/login when the counter is unavailable", () => {
	// D6. A D1 failure must not lock every account out of the product. The
	// zone rule still caps 60 req/min per IP underneath.
	it("lets a correct password through", async () => {
		await db().prepare("DROP TABLE login_attempts").run();

		expect((await login(EMAIL, TEST_PASSWORD)).status).toBe(200);

		// Rebuild it for the suites that follow, since the pool shares one
		// database across files.
		await db()
			.prepare(
				`CREATE TABLE login_attempts (
				   key TEXT PRIMARY KEY,
				   fails INTEGER NOT NULL,
				   last_fail_at TEXT NOT NULL
				 )`,
			)
			.run();
	});
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @onlooker/api exec vitest run src/routes/login-backoff.test.ts`
Expected: FAIL. The 429 cases get 401 — `handleLogin` has no gate, so every failure answers the same way. "lets a correct password through once the cooldown has expired" and "forgets the run" may pass trivially, because nothing refuses anything yet; they matter after step 3.

- [ ] **Step 3: Add the gate**

In `apps/api/src/routes/auth.ts`, add to the existing `../db/queries` import block a new import:

```typescript
import {
	activeCooldownMs,
	clearLoginAttempts,
	loginAttemptKey,
	recordLoginFailure,
} from "../db/login-attempts.js";
```

Then rewrite the body of `handleLogin` down to the token issuing:

```typescript
	const body = (await request.json()) as LoginRequest;

	if (!body.email || !body.password) {
		throw new ApiError(400, "invalid_input", "Email and password are required");
	}

	const key = await loginAttemptKey(body.email);

	/**
	 * The refusal, built in one place so the 429's body and header cannot
	 * drift between the gate and the two failure paths.
	 *
	 * It names no count and no window beyond the header: a refusal that
	 * reported "three attempts remaining" would be telling an attacker how to
	 * pace themselves.
	 */
	const tooMany = (waitMs: number) =>
		new ApiError(
			429,
			"rate_limit_exceeded",
			"Too many failed sign-in attempts. Try again shortly.",
			undefined,
			{ "Retry-After": String(Math.ceil(waitMs / 1000)) },
		);

	// Before bcrypt, deliberately. verifyPassword is ~100ms of worker CPU at
	// cost 10, so gating after it would leave the cheap half of the attack -
	// the part that costs us rather than the attacker - entirely intact.
	//
	// Fails open: a D1 failure here must not lock every account out of the
	// product. The zone rule still caps 60 req/min per IP underneath.
	const waiting = await activeCooldownMs(env.DB, key).catch(() => 0);
	if (waiting > 0) throw tooMany(waiting);

	/**
	 * Record one failure and answer with whatever it earned.
	 *
	 * The answer comes from this statement's own count rather than the read
	 * above, so the fifth consecutive failure is itself refused instead of
	 * answering 401 and refusing the sixth.
	 *
	 * Both callers below pass through here, so an address with no account and a
	 * wrong password produce the same 401 and, at the threshold, the same 429.
	 * That identity is the whole reason this table keys on a hash of the
	 * address rather than on a user id.
	 */
	const refuse = async (): Promise<never> => {
		const earned = await recordLoginFailure(env.DB, key).catch(() => 0);
		if (earned > 0) throw tooMany(earned);
		throw new ApiError(401, "invalid_credentials", "Invalid email or password");
	};

	const user = await getUserByEmail(env.DB, body.email);
	if (!user) await refuse();

	const validPassword = await verifyPassword(body.password, user.password_hash);
	if (!validPassword) await refuse();

	// Forget the run. Otherwise yesterday's typos add to today's, and somebody
	// who has signed in successfully since is one mistake from a cooldown.
	await clearLoginAttempts(env.DB, key).catch(() => {});
```

Leave everything from `const expiresInMinutes` onward exactly as it is.

Note for the implementer: `if (!user) await refuse();` leaves TypeScript thinking `user` may be null on the next line, because `refuse` returns `Promise<never>` rather than being a `never`-returning statement. If `tsc` complains, write `if (!user) return await refuse();` — `refuse` always throws, so the `return` is unreachable and only there to narrow the type.

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm --filter @onlooker/api exec vitest run src/routes/login-backoff.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Prove the gate runs before bcrypt**

Add this test to the first describe block:

```typescript
	// D2, by ablation rather than by timing. A non-hash in password_hash has no
	// defined answer from bcrypt.compare - the reasoning queries.ts records for
	// the anonymize path's unusable password - so if the gate moved below
	// verifyPassword, this request would reach it and answer anything but 429.
	it("refuses without reaching bcrypt at all", async () => {
		await failFourTimes(EMAIL);
		await login(EMAIL, "wrong-password");
		await db()
			.prepare("UPDATE users SET password_hash = 'not-a-bcrypt-hash'")
			.run();

		expect((await login(EMAIL, TEST_PASSWORD)).status).toBe(429);
	});
```

Run the file. Expected: PASS. Then move the `if (waiting > 0) throw tooMany(waiting);` line below the `verifyPassword` call and run again: this test must FAIL while the others still pass. Restore the order and re-run to green.

- [ ] **Step 6: Run every gate**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

Expected: API suite green (692 before this plan), `tsc --noEmit` silent, biome 0 errors with the 3 pre-existing `noExplicitAny` warnings intact, source guards `all 42 tests passed`. Nothing here touches lesson tables or adds a binding, so both of the guards that would notice should pass unamended.

- [ ] **Step 7: Commit**

Invoke `/git-workflow:commit` with the two files.

---

### Task 5: Pruning on the cron the worker already runs

**Files:**
- Modify: `apps/api/src/db/login-attempts.ts`
- Modify: `apps/api/src/scheduled.ts:19-32` and its `runScheduled` body
- Test: `apps/api/src/db/login-attempts.test.ts`, `apps/api/src/scheduled.test.ts`

**Interfaces:**
- Consumes: `MAX_COOLDOWN_MS` from Task 2.
- Produces: `pruneLoginAttempts(db, now?): Promise<number>`, and a `ScheduledDeps` field of the same name.

- [ ] **Step 1: Write the failing prune test**

Add to `apps/api/src/db/login-attempts.test.ts`:

```typescript
describe("pruneLoginAttempts", () => {
	// D3 accepts unbounded distinct keys as the price of not leaking which
	// addresses exist. This is what keeps that price bounded.
	it("drops runs whose cooldown can no longer be active", async () => {
		const stale = await loginAttemptKey("stale@example.com");
		const fresh = await loginAttemptKey("fresh@example.com");
		const now = new Date("2026-10-14T12:00:00.000Z");
		await recordLoginFailure(db(), stale, new Date(now.getTime() - 3_600_000));
		await recordLoginFailure(db(), fresh, now);

		expect(await pruneLoginAttempts(db(), now)).toBe(1);

		expect(await activeCooldownMs(db(), fresh, now)).toBe(0);
		const left = await db()
			.prepare("SELECT key FROM login_attempts")
			.all<{ key: string }>();
		expect(left.results?.map((r) => r.key)).toEqual([fresh]);
	});

	it("keeps a row whose cooldown is still running", async () => {
		const key = await loginAttemptKey("ada@example.com");
		const now = new Date("2026-10-14T12:00:00.000Z");
		for (let i = 0; i < 5; i++) await recordLoginFailure(db(), key, now);

		expect(await pruneLoginAttempts(db(), now)).toBe(0);
	});
});
```

Add `pruneLoginAttempts` to the file's import list.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @onlooker/api exec vitest run src/db/login-attempts.test.ts`
Expected: FAIL — `pruneLoginAttempts` is not exported, so the suite fails to load.

- [ ] **Step 3: Write the prune**

Append to `apps/api/src/db/login-attempts.ts`, mirroring `pruneSessionSummaries` (`db/session-summaries.ts:312-326`) down to the return type:

```typescript
/**
 * Drop runs old enough that no cooldown could still be active, and answer how
 * many went.
 *
 * The cutoff is the cap rather than the curve: a row past MAX_COOLDOWN_MS can
 * never be refusing anything whatever its count, so nothing is lost by
 * forgetting it, and an attacker who then starts again starts from zero - which
 * is the same position a legitimate user is in after a successful sign-in.
 *
 * Rides the cron the worker already declares, beside the session-summaries
 * prune. D3 accepts unbounded distinct keys as the price of not leaking which
 * addresses exist; this is what keeps that price bounded.
 */
export async function pruneLoginAttempts(
	db: D1Database,
	now: Date = new Date(),
): Promise<number> {
	const cutoff = new Date(now.getTime() - MAX_COOLDOWN_MS).toISOString();

	const result = await db
		.prepare("DELETE FROM login_attempts WHERE last_fail_at < ?")
		.bind(cutoff)
		.run();

	return result.meta.changes;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @onlooker/api exec vitest run src/db/login-attempts.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Write the failing scheduled test**

Read `apps/api/src/scheduled.test.ts` first and copy how it asserts the session-summaries prune — the ordering and the catch are already pinned there, and this one needs the same treatment. Add a case that the fake deps include `pruneLoginAttempts`, that `runScheduled` calls it, that its count is logged, and that a throw from it reaches `monitor.captureException` with its own tag rather than failing the invocation.

```typescript
	it("prunes login attempts and logs the count", async () => {
		const logs: string[] = [];
		const deps = makeDeps({ logs, pruneLoginAttempts: async () => 3 });

		await runScheduled(fakeEnv, deps);

		expect(logs).toContain(
			JSON.stringify({ event: "login_attempts_pruned", pruned: 3 }),
		);
	});

	// Same reason the sibling prune is caught: this handler's other job is the
	// production health check, and a failed cleanup is not a reason for that to
	// stop running.
	it("reports a failed login-attempts prune without failing the run", async () => {
		const captured: unknown[] = [];
		const deps = makeDeps({
			pruneLoginAttempts: async () => {
				throw new Error("d1 is unhappy");
			},
			captured,
		});

		await expect(runScheduled(fakeEnv, deps)).resolves.toBeUndefined();
		expect(captured).toHaveLength(1);
	});
```

Adapt `makeDeps`, `fakeEnv` and the capture mechanism to whatever that file already defines — do not introduce a second set of fakes.

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @onlooker/api exec vitest run src/scheduled.test.ts`
Expected: FAIL — `ScheduledDeps` has no `pruneLoginAttempts`, so the fake does not typecheck and nothing calls it.

- [ ] **Step 7: Wire it into the cron**

In `apps/api/src/scheduled.ts`, add to the import block, to `ScheduledDeps`, and to `realDeps`:

```typescript
import { pruneLoginAttempts } from "./db/login-attempts.js";
```

```typescript
	pruneLoginAttempts: (db: WorkerEnv["DB"]) => Promise<number>;
```

```typescript
	pruneLoginAttempts,
```

Then, after the existing session-summaries block in `runScheduled`, its own try/catch — separate rather than shared, so one broken prune does not stop the other:

```typescript
	try {
		const pruned = await deps.pruneLoginAttempts(env.DB);
		deps.log(JSON.stringify({ event: "login_attempts_pruned", pruned }));
	} catch (error) {
		deps.monitor.captureException(
			error instanceof Error ? error : new Error(String(error)),
			{ tags: { kind: "login_attempts_prune" } },
		);
	}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `pnpm --filter @onlooker/api exec vitest run src/scheduled.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 9: Run every gate**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/db test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

Expected: all green.

- [ ] **Step 10: Commit**

Invoke `/git-workflow:commit` with the four files.

---

## Closing out

Not plan tasks, but do not skip them:

- `bd update onlooker-9s0m --append-notes "..."` with what the ablations showed and anything the implementation taught that the spec does not say.
- The four gates green, including `bash scripts/source-guards.test.sh`.
- `/git-workflow:pr`. The body should name the two decisions that carry the risk — the key is a hash of *every* submitted address (so the 429 adds no enumeration oracle), and the control fails open (so an attacker who breaks the counter disables it) — because a reviewer reading the diff alone will not see either choice being made.
- `onlooker-9s0m` is the WS5 umbrella and does **not** close with this slice. Per-account quotas elsewhere, mail-send throttling and the IP dimension are still open under it, and `onlooker-9s0m.1` (the timing oracle) is filed and untouched.
- This slice is deployed by the ordinary merge to main: `deploy.yml` migrates before deploying, so 0015 lands ahead of the code that reads it.
