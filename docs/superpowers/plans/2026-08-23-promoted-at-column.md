# `promoted_at` Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote `promoted_at` out of the `lessons` JSON body into an indexed column, so the browser pool read can order newest-first against something SQLite can sort.

**Architecture:** `packages/db/src/schema.ts` is the single source of truth. Drizzle-kit generates the migration from it; `scripts/generate-expected-schema.mjs` derives `expected-schema.ts` from the built table objects; the deploy verifies the live database against that snapshot. `apps/api` does not use drizzle at runtime — every query is raw `db.prepare` — so the only runtime change is the `INSERT` in `createLessonsWithFeed`.

**Tech Stack:** Drizzle ORM 0.31 + drizzle-kit 0.22, Cloudflare D1 (SQLite), vitest 4 with `@cloudflare/vitest-pool-workers`, pnpm workspace.

**Bead:** `onlooker-w5o`
**Spec:** [`docs/superpowers/specs/2026-08-23-lesson-pool-surface-design.md`](../specs/2026-08-23-lesson-pool-surface-design.md), Section 3

## Global Constraints

- **SQLite refuses `ALTER TABLE ... ADD COLUMN ... NOT NULL` without a non-NULL default.** This is true regardless of how many rows the table has — it is not a "the table has data" problem, and an empty production table does not make it go away. The column is therefore declared `.notNull().default("")`.
- **`expected-schema.ts` is GENERATED. Never hand-edit it.** Regenerate with `pnpm --filter @onlooker/db generate:expected-schema`. It imports `../dist/schema.js`, so **`pnpm --filter @onlooker/db build` must run first** or it regenerates from a stale schema.
- **The API test suite applies the real migrations** (`readD1Migrations("../../packages/db/migrations")` in `apps/api/vitest.config.ts`). A malformed migration fails `pnpm --filter @onlooker/api test`, not just the deploy.
- `promoted_at` is **immutable**. It is written once at ingest and never updated — `transitionLesson` must not touch it.
- Commits go through the `/commit` skill. American English. Conventional Commits with a mood emoji.
- Branch off `main`; this repo lands everything via a PR.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/db/src/schema.ts` | Source of truth for the schema | Modify: add column + index to `lessons` |
| `packages/db/migrations/0004_*.sql` | The DDL D1 applies | Create (generated, then one statement appended) |
| `packages/db/src/expected-schema.ts` | Snapshot the deploy verifies against | Regenerate |
| `packages/db/src/__tests__/schema.test.ts` | Asserts the declared shape | Modify: column and index assertions |
| `apps/api/src/db/lessons.ts` | Ingest and reads | Modify: `INSERT` writes `promoted_at` |
| `apps/api/src/db/lessons.test.ts` | D1-level ingest behavior | Modify: assert the column is populated |
| `apps/api/src/db/backfill.test.ts` | The backfill expression | Create |

Tests in `apps/api` are colocated beside the file they cover (`src/db/lessons.test.ts`), not gathered in a `__tests__/` directory — that convention is `packages/db`'s. Follow the local one.

**Not touched, and why it matters:** no query in `apps/api/src/db/lessons.ts` uses `SELECT *` — every read names its columns (`lessons.ts:231`, `lessons.ts:338`). Adding a column therefore cannot silently change an existing response shape.

---

### Task 1: Declare the column and index

**Files:**
- Modify: `packages/db/src/schema.ts:155-172`
- Modify: `packages/db/src/__tests__/schema.test.ts`
- Regenerate: `packages/db/src/expected-schema.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `lessons.promoted_at` (TEXT, notnull) and the index `lessons_user_promoted_at_idx` on `(user_id, promoted_at)`. Task 2 generates DDL from this; Task 3 writes to the column.

- [ ] **Step 1: Write the failing test**

In `packages/db/src/__tests__/schema.test.ts`, the `describe("lessons", ...)` block starts at line 148. Add `"promoted_at"` to its existing column-list assertion (the list is sorted, so it goes between `"id"` and `"schema_version"`), and add the index test alongside. The helpers `columnNames`, `indexNames` and `indexColumnNames` already exist at the top of the file.

**Leave the block's other two tests exactly as they are** — `"cascades when its user is deleted"` and `"has no seq column - ordering lives in lesson_feed"`. Only the column list changes, and one test is added.

```typescript
describe("lessons", () => {
	it("declares exactly the columns the hosted lesson pool needs", () => {
		expect(columnNames(lessons)).toEqual([
			"body",
			"created_at",
			"id",
			"promoted_at",
			"schema_version",
			"status",
			"updated_at",
			"user_id",
			"visibility",
		]);
	});

	// Ordering the pool newest-first is the whole reason this column was
	// lifted out of `body`. Without the index the sort is a scan, and
	// ordering by json_extract could not use one at all.
	it("indexes (user_id, promoted_at) so the pool can be ordered", () => {
		const idx = getTableConfig(lessons).indexes.find(
			(i) => i.config.name === "lessons_user_promoted_at_idx",
		);
		expect(indexColumnNames(idx?.config.columns ?? [])).toEqual([
			"user_id",
			"promoted_at",
		]);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @onlooker/db test
```

Expected: FAIL. The column list reports `promoted_at` missing from the received array, and the index test fails because `idx` is `undefined`.

- [ ] **Step 3: Add the column and index**

In `packages/db/src/schema.ts`, inside the `lessons` table definition, add `promoted_at` after `body`:

```typescript
		body: text("body").notNull(),
		// Lifted out of `body` so the pool can be ordered by it. Immutable:
		// written once at ingest, never updated, so it cannot disagree with
		// the copy inside the JSON.
		//
		// The default is not a fallback anyone should rely on. SQLite refuses
		// ADD COLUMN ... NOT NULL without a non-NULL default - true even for
		// an empty table - so a default is the only way this column can be
		// added to a table that already exists. Ingest always writes a real
		// value; an empty string means a row that predates migration 0004 and
		// escaped the backfill.
		promoted_at: text("promoted_at").notNull().default(""),
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
```

And in the index callback:

```typescript
	(table) => ({
		userIdIdx: index("lessons_user_id_idx").on(table.user_id),
		userPromotedAtIdx: index("lessons_user_promoted_at_idx").on(
			table.user_id,
			table.promoted_at,
		),
	}),
```

- [ ] **Step 4: Rebuild, then regenerate the expected-schema snapshot**

The generator imports `../dist/schema.js`. Building first is not optional — skipping it regenerates the snapshot from the previous schema and the test in Step 5 fails in a confusing way.

```bash
pnpm --filter @onlooker/db build
pnpm --filter @onlooker/db generate:expected-schema
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @onlooker/db test
```

Expected: PASS, including `expected-schema.ts › matches a freshly generated snapshot of the drizzle schema`, which is what proves Step 4 actually ran.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/expected-schema.ts \
        packages/db/src/__tests__/schema.test.ts
```

Then invoke the `/commit` skill. Suggested message:

```text
feat(db): give the pool something it can actually sort by :straight_ruler:

promoted_at lived inside the lessons JSON body, so ordering the pool
newest-first meant json_extract on every row with no index behind it.
Lifting it to a column with an index on (user_id, promoted_at) makes the
ordering the browser read needs a real query plan.

The DEFAULT '' exists only because SQLite refuses ADD COLUMN NOT NULL
without one. Migration 0004 backfills it.

Refs: onlooker-w5o
```

---

### Task 2: Generate the migration and backfill existing rows

**Files:**
- Create: `packages/db/migrations/0004_<generated-name>.sql`
- Create: `apps/api/src/db/backfill.test.ts`

**Interfaces:**
- Consumes: `lessons.promoted_at` and `lessons_user_promoted_at_idx` from Task 1.
- Produces: a migrated database. Task 3's test cannot pass until this exists, because the API suite's D1 is built by applying these migrations.

- [ ] **Step 1: Generate the migration**

```bash
pnpm --filter @onlooker/db generate:migrations
```

This writes `packages/db/migrations/0004_<random-name>.sql`. Open it and confirm it contains exactly two statements — an `ALTER TABLE` carrying `DEFAULT ''`, and a `CREATE INDEX`:

```sql
ALTER TABLE `lessons` ADD `promoted_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `lessons_user_promoted_at_idx` ON `lessons` (`user_id`,`promoted_at`);
```

If the `ALTER TABLE` has no `DEFAULT ''`, Task 1 Step 3 was applied without `.default("")`. Fix the schema and regenerate rather than editing the SQL — the two must agree.

- [ ] **Step 2: Append the backfill**

Add a third statement to the end of the generated file. Every existing row got `''` from the default; this is what gives them their real value.

```sql
--> statement-breakpoint
-- Existing rows took the DEFAULT '' above. Their real value is already in
-- the JSON body, which is where this column was lifted from, so the backfill
-- reads it back out rather than inventing a timestamp.
--
-- Guarded on promoted_at = '' so re-running is a no-op: a lesson ingested
-- after this migration already has the correct value and must not be
-- overwritten by whatever its body says.
UPDATE `lessons` SET `promoted_at` = json_extract(`body`, '$.promoted_at') WHERE `promoted_at` = '';
```

**If `pnpm migrate:prod` fails partway** - the `ALTER TABLE` commits but the `UPDATE` does not - wrangler never inserts the `d1_migrations` row, so a retry replays the file from the top and dies on `duplicate column name: promoted_at`. To recover, drop the index first (SQLite refuses `DROP COLUMN` on an indexed column), then the column, then re-run:

```sql
DROP INDEX IF EXISTS lessons_user_promoted_at_idx;
ALTER TABLE lessons DROP COLUMN promoted_at;
```

D1 has no down-migration mechanism, so anything beyond this recovery is a forward-only `0005`. This is mitigated by `deploy.yml` running the identical migration against staging first, with a schema verify and a smoke test, before production is eligible - so a malformed migration cannot reach production.

- [ ] **Step 3: Write the failing test for the backfill expression**

Create `apps/api/src/db/backfill.test.ts`, colocated beside `lessons.ts` the way every other `apps/api` test is. This runs the same `UPDATE` against a seeded row. It verifies the `json_extract` path, which is the part that can be wrong — it does not re-run migration 0004 itself, because the pool harness has already applied every migration before any test body runs.

```typescript
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "./queries.js";

const db = () => env.DB;

/** The statement appended to migration 0004, verbatim. */
const BACKFILL =
	"UPDATE lessons SET promoted_at = json_extract(body, '$.promoted_at') WHERE promoted_at = ''";

let userId: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM users").run();
	const user = await createUser(
		db(),
		"backfill@example.com",
		"hash",
		"Ada",
	);
	userId = user.id;
});

/** A row shaped the way migration 0004 leaves a pre-existing lesson. */
async function seedUnbackfilled(id: string, promotedAt: string) {
	await db()
		.prepare(
			`INSERT INTO lessons
				(id, user_id, visibility, status, schema_version, body, promoted_at)
			 VALUES (?, ?, 'private', 'active', 2, ?, '')`,
		)
		.bind(id, userId, JSON.stringify({ id, promoted_at: promotedAt }))
		.run();
}

const promotedAtOf = async (id: string) =>
	(
		await db()
			.prepare("SELECT promoted_at FROM lessons WHERE id = ?")
			.bind(id)
			.first<{ promoted_at: string }>()
	)?.promoted_at;

describe("the 0004 backfill", () => {
	it("copies promoted_at out of the body", async () => {
		await seedUnbackfilled("01BACKFILL0000000000000001", "2026-08-20T00:00:00.000Z");

		await db().prepare(BACKFILL).run();

		expect(await promotedAtOf("01BACKFILL0000000000000001")).toBe(
			"2026-08-20T00:00:00.000Z",
		);
	});

	// The guard that makes re-running safe. Without WHERE promoted_at = '',
	// a second run would overwrite a correct column value with whatever the
	// body happened to say.
	it("leaves an already-populated row alone", async () => {
		await seedUnbackfilled("01BACKFILL0000000000000002", "2026-08-20T00:00:00.000Z");
		await db()
			.prepare("UPDATE lessons SET promoted_at = ? WHERE id = ?")
			.bind("2026-08-21T00:00:00.000Z", "01BACKFILL0000000000000002")
			.run();

		await db().prepare(BACKFILL).run();

		expect(await promotedAtOf("01BACKFILL0000000000000002")).toBe(
			"2026-08-21T00:00:00.000Z",
		);
	});
});
```

- [ ] **Step 4: Run the API suite**

```bash
pnpm --filter @onlooker/api test
```

Expected: PASS, including the two new backfill tests. If the migration is malformed, this fails at suite setup with a D1 error before any test runs — that failure mode is the point of running the whole suite here rather than one file.

- [ ] **Step 5: Verify the migration applies to the local database**

```bash
pnpm --filter @onlooker/api exec wrangler d1 migrations apply onlooker-db-local --local --env development
```

Expected: `0004_<name>.sql` reported as applied, with no error.

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations apps/api/src/db/backfill.test.ts
```

Then invoke the `/commit` skill. Suggested message:

```text
feat(db): backfill promoted_at from the body it came out of :arrow_up:

Migration 0004 adds the column with DEFAULT '' - the only form SQLite
accepts for a NOT NULL ADD COLUMN - so every existing row lands empty.
The backfill reads each row's real value back out of its JSON body
rather than inventing one.

Guarded on promoted_at = '' so a re-run cannot overwrite a lesson
ingested after the migration with whatever its body says.

Refs: onlooker-w5o
```

---

### Task 3: Write `promoted_at` at ingest

**Files:**
- Modify: `apps/api/src/db/lessons.ts:143-158`
- Modify: `apps/api/src/db/lessons.test.ts`

**Interfaces:**
- Consumes: the migrated column from Task 2.
- Produces: every lesson written by `createLessonsWithFeed` has `promoted_at` populated from `lesson.promoted_at`. `onlooker-yj5`'s `GET /api/lessons` orders on this.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/db/lessons.test.ts`. The file already has a `lesson()` factory whose `promoted_at` is `"2026-08-22T00:00:00.000Z"`, a `db()` helper, and a `userId` set in `beforeEach` — reuse them.

```typescript
describe("promoted_at", () => {
	it("is stored in the column, not only inside the body", async () => {
		const written = lesson({ promoted_at: "2026-08-14T09:30:00.000Z" });

		await createLessonsWithFeed(db(), userId, [written]);

		const row = await db()
			.prepare("SELECT promoted_at FROM lessons WHERE id = ?")
			.bind(written.id)
			.first<{ promoted_at: string }>();
		expect(row?.promoted_at).toBe("2026-08-14T09:30:00.000Z");
	});

	// The column and the body are two copies of one fact. They are written in
	// the same statement so they cannot diverge, and this is the assertion
	// that would catch it if the INSERT ever stopped binding one of them.
	it("agrees with the copy inside the body", async () => {
		const written = lesson({ promoted_at: "2026-08-14T09:30:00.000Z" });

		await createLessonsWithFeed(db(), userId, [written]);

		const row = await db()
			.prepare("SELECT promoted_at, body FROM lessons WHERE id = ?")
			.bind(written.id)
			.first<{ promoted_at: string; body: string }>();
		expect(row?.promoted_at).toBe(
			(JSON.parse(row?.body ?? "{}") as { promoted_at: string }).promoted_at,
		);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @onlooker/api test src/db/lessons.test.ts
```

Expected: FAIL. `row?.promoted_at` is `""` — the column exists and carries its default because nothing writes it yet. It is **not** an error about an unknown column; if that is what you see, Task 2 did not apply.

- [ ] **Step 3: Bind the column in the INSERT**

In `apps/api/src/db/lessons.ts`, inside `createLessonsWithFeed`, extend the `INSERT INTO lessons` statement and its `.bind(...)`:

```typescript
				db
					.prepare(
						`INSERT INTO lessons
							(id, user_id, visibility, status, schema_version, body, promoted_at, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						lesson.id,
						userId,
						lesson.visibility,
						lesson.status,
						lesson.schema_version,
						canonicalize(lesson),
						// The column and the body carry the same value, written in
						// one statement so they cannot drift. promoted_at is
						// immutable - transitionLesson must never touch it.
						lesson.promoted_at,
						now,
						now,
					),
```

Note the placeholder count: nine columns, nine `?`, nine bound values. A mismatch here surfaces as a D1 error naming neither the column nor the file.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @onlooker/api test src/db/lessons.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full suite**

```bash
pnpm --filter @onlooker/api test
```

Expected: PASS. The push, delta and status route suites all exercise this INSERT; they should be unaffected, because no read names `promoted_at` yet.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/lessons.ts apps/api/src/db/lessons.test.ts
```

Then invoke the `/commit` skill. Suggested message:

```text
feat(api): write promoted_at where a query can reach it :inbox_tray:

Ingest wrote promoted_at only into the canonicalized body, so the new
column stayed at its default for every lesson pushed after migration
0004 - the backfill would have been the only thing that ever populated
it, and only for rows that predated it.

Both copies are now written in the same statement, so they cannot drift.

Refs: onlooker-w5o
```

---

### Task 4: Verify the whole workspace and open the PR

**Files:** none.

- [ ] **Step 1: Run every gate**

```bash
pnpm test && pnpm lint && pnpm typecheck && pnpm build
```

Expected: all pass. Report the actual output — do not claim green without it.

- [ ] **Step 2: Confirm the snapshot is not stale**

```bash
pnpm --filter @onlooker/db build && pnpm --filter @onlooker/db generate:expected-schema
git diff --exit-code packages/db/src/expected-schema.ts
```

Expected: exit 0, no diff. A diff here means the committed snapshot disagrees with the schema and the deploy's verify step would fail after the approval gate — the worst place to find out.

- [ ] **Step 3: Open the PR**

Invoke the `/pr` skill. Flag for reviewers: migration 0004 runs against production on merge, the `DEFAULT ''` is deliberate and load-bearing, and the backfill is guarded so it is idempotent.

- [ ] **Step 4: Re-run the backfill after production deploys**

The deploy order is migrate then deploy the worker (see `deploy.yml`), so the old worker is still serving between the two - any lesson it inserts in that gap binds no `promoted_at` and lands on `DEFAULT ''` forever, since migration 0004 has already run once and will not run again. Running the backfill statement again after the deploy closes that window every time, instead of relying on someone remembering to. It is the same `WHERE promoted_at = ''` guard as the migration's own backfill, so it is a no-op on every row already correct and safe to run unconditionally.

```bash
pnpm --filter @onlooker/api exec wrangler d1 execute DB --env production --remote \
  --command "UPDATE lessons SET promoted_at = json_extract(body, '\$.promoted_at') WHERE promoted_at = ''"
```

- [ ] **Step 5: Close the bead once merged**

```bash
bd close onlooker-w5o --reason "Column, index, backfill and ingest write landed in <PR>."
```

---

## Notes on what this plan deliberately does not do

**No runtime guard against `promoted_at = ''`.** A row can hold `''` only if it was written between migration 0004 committing and the API deploy that followed it - the deploy migrates before it ships code. That window is currently unreachable, because no machine token exists in production and only a machine-authenticated push writes lessons. The backfill is idempotent, so re-running it after a deploy closes the window. Adding a defensive check in the read path would be guarding against a state the write path cannot produce.

**No change to `transitionLesson`.** A status change does not re-promote a lesson, so `promoted_at` is correct to leave alone. This is stated here because "update the timestamp on write" is the reflex, and it would be wrong.

**The backfill test verifies the expression, not the migration run.** The workers pool applies all migrations before any test body executes, so migration 0004's own `UPDATE` cannot be observed from a test. What can be verified is that the `json_extract` path and the idempotence guard are correct, which is where the risk actually is. The migration's execution is verified by the staging deploy, which applies migrations and then checks the live schema against `expected-schema.ts`.
