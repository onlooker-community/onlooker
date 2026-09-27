# Shared Lesson Read Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the read authorization seam, declarative route auth, and
moderation controls that the org (ONL-12) and public (ONL-13) lesson visibility
tiers both need, shipping inert until ONL-12 fills the org resolver.

**Architecture:** Every read that returns lesson content funnels through one
`readPool`/`readPoolLesson` pair that builds the visibility predicate itself, so
a caller cannot express a read without one. Feed reads (`readLessonDelta`,
`listActivityPage`) are untouched — they enter through `lesson_feed`, keyed
`(user_id, seq)`, which only ever holds a user's own lessons. Route auth moves
from a call inside each handler to a required field on the route table, resolved
centrally. Moderation acts on a new indexed `author_key` column.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Drizzle ORM + drizzle-kit for
migrations, Zod (lesson contract), Vitest with `@cloudflare/vitest-pool-workers`,
Biome.

**Spec:** `docs/superpowers/specs/2026-09-27-shared-lesson-read-path-design.md`
**Bead:** `onlooker-wi9ftq.1` · **Branch:** `meagan/onl-12-shared-read-path`

## Global Constraints

- **Three CI gates, all must pass:** `pnpm --filter <pkg> test` (vitest),
  `tsc --noEmit`, and `pnpm --filter <pkg> lint` (Biome). Biome failures do not
  show up in vitest or tsc — run all three before every commit.
- **American English** in all comments, identifiers, and commit messages.
- **Edit tracked files with the Edit/Write tools, never shell heredocs or
  `sed -i`.** The `lineage` and `inspector` plugins hook `PostToolUse` on
  `Edit`/`Write`/`MultiEdit`; a shell edit moves the same bytes invisibly and
  `/lineage` then answers "no record" for a line that was demonstrably written.
- **Never write a credential literal into a test or a document.** A pre-commit
  hook scans for them and blocks the write — it blocked this plan twice while it
  was being drafted. Import the shared constant instead (Task 6 Step 0).
- **Migrations are generated, not hand-written.** Edit
  `packages/db/src/schema.ts`, then run
  `pnpm --filter @onlooker/db generate:migrations`. Custom SQL (backfills) is
  appended to the generated file by hand afterward.
- **`expected-schema.ts` is generated too**, and the generator reads
  `dist/schema.js` rather than `src/schema.ts`, so it must be preceded by
  `pnpm --filter @onlooker/db build` or it silently regenerates the old shape.
  Never hand-edit it.
- **Never open the push tier gate.** `apps/api/src/routes/lessons.ts:104` must
  keep rejecting non-private lessons for the whole of this plan. Tests seed
  non-private lessons with `createLessonsWithFeed`, which writes to the DB
  directly and bypasses push entirely.
- **Commit through `/git-workflow:commit`**, never an ad hoc `git commit -m`.
  Format: `<type>(<scope>): <subject> :emoji:`, subject ≤72 chars including the
  emoji, body lines ≤80, body explains *why*.
- **Fail closed.** Any resolver or lookup that cannot answer must narrow access,
  never widen it.

---

## File Structure

**New files:**

| File | Responsibility |
|---|---|
| `apps/api/src/db/pool.ts` | The chokepoint: `readPool`, `readPoolLesson`, the visibility predicate, the `OrgMembers` contract and its inert stub. |
| `apps/api/src/db/pool.test.ts` | DB-layer predicate tests, including the ablation-proven leak tests. |
| `apps/api/src/db/author-blocks.ts` | Read and write the `lesson_author_blocks` table. |
| `apps/api/src/routes/lessons-public.ts` | The one anonymous handler. Can only ever call `readPoolLesson` with `null`. |
| `apps/api/src/routes/lessons-public.test.ts` | Route-level leak tests. |
| `apps/api/src/routes/admin-moderation.ts` | Operator retract-any, block, unblock. |
| `apps/api/src/routes/admin-moderation.test.ts` | Operator control tests. |
| `apps/api/src/middleware/principal.ts` | Resolve a route's declared `auth` into a `Principal \| null`. |
| `apps/api/src/db/author-key-backfill.test.ts` | Pins the backfill and its idempotency guard. Lives here, not in `packages/db`, because this is the package with a D1 binding. |

**Modified:**

| File | Change |
|---|---|
| `packages/db/src/schema.ts` | `author_key` column + index on `lessons`; new `lesson_author_blocks` table. |
| `apps/api/src/db/lessons.ts` | `listLessonsPage`/`getLessonForUser` become thin callers of `pool.ts`; `getLessonsByIds` → `probeLessonIds`; add `retractAnyLesson`. |
| `apps/api/src/router.ts` | `Route` gains required `auth` and `cors`; `dispatch` resolves the principal; `ROUTES` exported. |
| `apps/api/src/router.test.ts` | Contract tests pinning the `auth: "none"` and `cors: "any"` sets. |
| `apps/api/src/middleware/cors.ts` | Honor a route's `cors: "any"`. |
| `apps/api/src/test-support/lessons.ts` | Export the shared test password constant. |
| every file in `apps/api/src/routes/` | Drop in-handler `requireAuth`/`requireMachineToken`; read the principal from context. |

---

## Task 1: The schema moderation needs

**Files:**
- Modify: `packages/db/src/schema.ts` (the `lessons` table, ~line 172-200)
- Create: `packages/db/migrations/0008_<drizzle-generated-name>.sql`
- Create: `apps/api/src/db/author-key-backfill.test.ts`
- Regenerate: `packages/db/src/expected-schema.ts`
- Modify: `packages/db/src/__tests__/schema.test.ts` — it hand-pins a table count
  and per-table column lists, so a new table and column mean updating those
  assertions. Mechanical, and the test working as intended.

**Where the test lives, and why not in `packages/db`.** That package's three
suites (`src/__tests__/`) are pure drizzle introspection — they compare the
schema object to `expected-schema.ts` and never open a database. Its vitest is
plain vitest with no `cloudflare:test` module, so a test importing `env.DB` there
cannot even resolve its import.

`apps/api` is the package with a D1 binding, and its `vitest.config.ts` calls
`readD1Migrations("../../packages/db/migrations")` at config time — so the
migration written in Step 3 is applied to the test database automatically, which
is exactly what makes a backfill test meaningful rather than a re-implementation
of it.

**Interfaces:**
- Consumes: nothing.
- Produces: an `author_key` column on `lessons` (text, `DEFAULT ''`, `NOT NULL`,
  indexed as `lessons_author_key_idx`), and a `lesson_author_blocks` table with
  columns `author_key` (text, primary key), `reason` (text, not null),
  `blocked_by` (text, not null), `blocked_at` (text, not null, default
  `CURRENT_TIMESTAMP`).

**Why this is one task:** both changes are schema, both are needed before any
predicate can reference them, and a reviewer would accept or reject them
together.

- [ ] **Step 1: Add the column and table to the Drizzle schema**

In `packages/db/src/schema.ts`, add to the `lessons` table definition, after
`promoted_at`:

```ts
		// Lifted out of `body` because the blocklist filters on it. Same
		// reasoning as promoted_at above, and the same SQLite constraint: a
		// NOT NULL column added to an existing table needs a default, so the
		// migration backfills from the JSON it was lifted from.
		//
		// This is what public blocking acts on. See ZAuthorKey in
		// packages/lesson-contract/src/primitives.ts for why it is 128 bits:
		// a collision would block an innocent author alongside a bad actor.
		author_key: text("author_key").notNull().default(""),
```

Add to the table's index block:

```ts
		authorKeyIdx: index("lessons_author_key_idx").on(table.author_key),
```

Then add the new table after `lesson_feed`:

```ts
/**
 * Author keys whose lessons are served to nobody.
 *
 * Keyed on author_key rather than user_id because author_key is what the
 * contract says blocking acts on, and it is derived per visibility scope - so
 * blocking a public-scope key does not reach the same person's org-scope
 * lessons, which is the unlinkability the contract promises.
 */
export const lesson_author_blocks = sqliteTable("lesson_author_blocks", {
	author_key: text("author_key").primaryKey(),
	reason: text("reason").notNull(),
	// The operator who acted, so a block is attributable.
	blocked_by: text("blocked_by").notNull(),
	blocked_at: text("blocked_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @onlooker/db generate:migrations`
Expected: a new `packages/db/migrations/0008_*.sql` plus a `meta/_journal.json`
entry with `"idx": 8`.

- [ ] **Step 3: Append the backfill to the generated migration**

The generator cannot know about the JSON body. Open the generated `0008_*.sql`
and append, modeled exactly on `0004_chunky_toro.sql`:

```sql
--> statement-breakpoint
-- Existing rows took the DEFAULT '' above. Their real value is already in the
-- JSON body, which is where this column was lifted from, so the backfill reads
-- it back out rather than inventing one.
--
-- Guarded on author_key = '' so re-running is a no-op: a lesson ingested after
-- this migration already has the correct value and must not be overwritten by
-- whatever its body says.
UPDATE `lessons` SET `author_key` = json_extract(`body`, '$.author_key') WHERE `author_key` = '';
```

- [ ] **Step 4: Regenerate the expected schema**

```bash
pnpm --filter @onlooker/db build
pnpm --filter @onlooker/db generate:expected-schema
```

**The `build` first is not optional.** `generate:expected-schema` reads
`dist/schema.js`, not `src/schema.ts`, so without it the generator silently
regenerates the *old* shape and the mismatch surfaces later as a confusing test
failure in a file you did not touch.

Expected afterward: the `lessons` entry in `expected-schema.ts` lists
`author_key`, and `lesson_author_blocks` appears as a new table.

**Do NOT run `verify:schema` here.** It takes `<database> <env>` arguments and
compares `expected-schema.ts` against a *live deployed* D1 over
`wrangler --remote` — `deploy.yml:608` and `:766` are the only places it runs,
after a deploy. Locally it either errors on the missing arguments or, given real
staging arguments, reports false drift for a migration that has not been deployed
anywhere yet.

The local check is the next step's test run: `packages/db`'s three suites in
`src/__tests__/` compare the schema object against `expected-schema.ts` directly,
with no database involved, which is exactly the agreement this step can break.

Note that `src/__tests__/schema.test.ts` hand-pins a table count and per-table
column lists, so adding a table and a column means updating those assertions.
That is expected, and it is the test doing its job rather than an obstacle.

- [ ] **Step 5: Write a test that the backfill actually ran**

Create `apps/api/src/db/author-key-backfill.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "./queries.js";

const db = () => env.DB;

const BACKFILL = `UPDATE lessons SET author_key = json_extract(body, '$.author_key')
	 WHERE author_key = ''`;

describe("author_key backfill", () => {
	beforeEach(async () => {
		await db().prepare("DELETE FROM lessons").run();
		await db().prepare("DELETE FROM users").run();
	});

	it("reads author_key back out of the body for a pre-migration row", async () => {
		// Simulates a row written before 0008: the column takes its DEFAULT ''
		// and the real value exists only inside the JSON.
		const body = JSON.stringify({ author_key: "b".repeat(32) });
		// A real user, because D1 enforces the foreign key on lessons.user_id -
		// a literal id fails with SQLITE_CONSTRAINT_FOREIGNKEY. Same shape as
		// the sibling apps/api/src/db/backfill.test.ts.
		const user = await createUser(db(), "backfill@example.com", "hash", "Ada");
		await db()
			.prepare(
				`INSERT INTO lessons
				   (id, user_id, visibility, status, schema_version, body, author_key)
				 VALUES (?, ?, 'private', 'active', 2, ?, '')`,
			)
			.bind("01KZ45MKAM734ZS7JK24D2DK01", user.id, body)
			.run();

		await db().prepare(BACKFILL).run();

		const row = await db()
			.prepare("SELECT author_key FROM lessons WHERE id = ?")
			.bind("01KZ45MKAM734ZS7JK24D2DK01")
			.first<{ author_key: string }>();

		expect(row?.author_key).toBe("b".repeat(32));
	});

	it("leaves a post-migration row alone", async () => {
		const body = JSON.stringify({ author_key: "b".repeat(32) });
		const user = await createUser(db(), "guarded@example.com", "hash", "Ada");
		await db()
			.prepare(
				`INSERT INTO lessons
				   (id, user_id, visibility, status, schema_version, body, author_key)
				 VALUES (?, ?, 'private', 'active', 2, ?, ?)`,
			)
			.bind("01KZ45MKAM734ZS7JK24D2DK02", user.id, body, "c".repeat(32))
			.run();

		await db().prepare(BACKFILL).run();

		const row = await db()
			.prepare("SELECT author_key FROM lessons WHERE id = ?")
			.bind("01KZ45MKAM734ZS7JK24D2DK02")
			.first<{ author_key: string }>();

		// The guard held: the column wins over the body.
		expect(row?.author_key).toBe("c".repeat(32));
	});
});
```

- [ ] **Step 6: Run it**

Run: `pnpm --filter @onlooker/api test src/db/author-key-backfill.test.ts`
Expected: both PASS. If the second fails, the `WHERE author_key = ''` guard is
missing from the migration.

- [ ] **Step 7: Run the gates for both packages**

The change spans two packages, so both are gated. `packages/db`'s three schema
suites are what catch a `schema.ts` that disagrees with `expected-schema.ts`, and
`apps/api` is where the migration actually runs.

```bash
pnpm --filter @onlooker/db test
pnpm --filter @onlooker/db typecheck
pnpm --filter @onlooker/db lint
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
```
Expected: all PASS. `apps/api`'s full suite matters here even though this task
adds one test to it: every existing suite now runs against a migrated schema with
a new column, and a mistake in the migration surfaces as an unrelated suite
breaking.

- [ ] **Step 8: Commit via `/git-workflow:commit`**

Stage: `packages/db/src/schema.ts`, the new migration, `meta/_journal.json`,
`packages/db/src/expected-schema.ts`, and
`apps/api/src/db/author-key-backfill.test.ts`.
Message shape: `feat(db): give author_key a column so blocking can act on it`
plus a mood emoji. Body: it was only ever inside `body`, so nothing could filter
on the one field the contract says blocking acts on.

---

## Task 2: The chokepoint

**Files:**
- Create: `apps/api/src/db/pool-page.ts`
- Create: `apps/api/src/db/pool.ts`
- Create: `apps/api/src/db/pool.test.ts`
- Create: `apps/api/src/db/author-blocks.ts`
- Modify: `apps/api/src/db/lessons.ts` (`listLessonsPage` ~555,
  `getLessonForUser` ~628, `getLessonsByIds` ~228, and
  **`createLessonsWithFeed`'s INSERT ~157-174**)
- Modify: `apps/api/src/routes/lessons.ts` (imports 5-6, calls ~190, ~258)
- Modify: `apps/api/src/db/lessons.test.ts` (imports 6-7, use at 141,
  describe block 231-251, and a new `describe("author_key")` beside
  `describe("promoted_at")` at ~318)

**A gap in the task breakdown, found while implementing this task.** Task 1 gave
`author_key` a column; nothing gave it a *writer*. `createLessonsWithFeed`'s
INSERT binds nine columns and `author_key` is not among them, so every lesson
written after migration 0008 stores `''` — which would make Task 6's blocking
match nothing in production, and makes `0008_stiff_swordsman.sql:15`'s claim that
"a lesson ingested after this migration already has the correct value" false
until it is fixed.

This is a decomposition error, not a defect in either task's brief on its own
terms: Task 1 was scoped "Consumes: nothing", and no task's file list named
`createLessonsWithFeed`. The backfill handles pre-migration rows; the INSERT
handles post-migration rows; both are needed. It is folded into this task because
this task's own blocked-author leak test is false without it.

**Interfaces:**
- Consumes: Task 1's `author_key` column and `lesson_author_blocks` table.
- Produces:
  - `interface Principal { userId: string }`
  - `type OrgMembers = (db: D1Database, userId: string) => Promise<string[]>`
  - `const noOrgMembers: OrgMembers` — the inert stub, returns `[]`
  - `readPool(db, principal: Principal | null, filters: PoolFilters, orgMembers?: OrgMembers): Promise<LessonPage>`
  - `readPoolLesson(db, principal: Principal | null, id: string, orgMembers?: OrgMembers): Promise<unknown | null>`
  - `interface PoolFilters { statuses?: string[]; cursor?: string | null; limit: number }`
  - `probeLessonIds(db, ids: string[]): Promise<Map<string, StoredLesson>>` and
    `probeLessonId(db, id): Promise<StoredLesson | null>` — the renames
  - `isAuthorBlocked(db, authorKey: string): Promise<boolean>` in
    `author-blocks.ts`

- [ ] **Step 1: Write the failing predicate tests**

Create `apps/api/src/db/pool.test.ts`:

```ts
import { env } from "cloudflare:test";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { lesson, resetLessonCounter } from "../test-support/lessons.js";
import { createLessonsWithFeed } from "./lessons.js";
import { readPool, readPoolLesson } from "./pool.js";
import { createUser } from "./queries.js";

const db = () => env.DB;

let mine: string;
let theirs: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_author_blocks").run();
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM users").run();
	mine = (await createUser(db(), "mine@example.com", "hash", "Ada")).id;
	theirs = (await createUser(db(), "theirs@example.com", "hash", "Bob")).id;
	resetLessonCounter();
});

/**
 * Seed one lesson owned by `owner`.
 *
 * Bypasses push, which still rejects every non-private tier - that gate is
 * deliberately untouched by this plan, so the read path has to be testable
 * without it.
 */
async function seedFor(
	owner: string,
	overrides: Record<string, unknown>,
): Promise<TLesson> {
	const written = lesson(overrides) as TLesson;
	await createLessonsWithFeed(db(), owner, [written]);
	return written;
}

async function block(authorKey: string): Promise<void> {
	await db()
		.prepare(
			`INSERT INTO lesson_author_blocks (author_key, reason, blocked_by)
			 VALUES (?, 'injection', 'operator-1')`,
		)
		.bind(authorKey)
		.run();
}

const idsIn = (page: { lessons: unknown[] }) =>
	(page.lessons as Array<{ id: string }>).map((l) => l.id);

describe("readPool, anonymous", () => {
	it("returns a public lesson", async () => {
		const pub = await seedFor(theirs, { visibility: "public" });
		const page = await readPool(db(), null, { limit: 50 });
		expect(idsIn(page)).toEqual([pub.id]);
	});

	// THE LEAK TESTS. Each must be proven by ablation - see Step 5.
	it("does not return a private lesson", async () => {
		await seedFor(theirs, { visibility: "private" });
		const page = await readPool(db(), null, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("does not return an org lesson", async () => {
		await seedFor(theirs, { visibility: "org" });
		const page = await readPool(db(), null, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("does not return a retracted public lesson", async () => {
		await seedFor(theirs, { visibility: "public", status: "retracted" });
		const page = await readPool(db(), null, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("does not return a public lesson from a blocked author", async () => {
		await seedFor(theirs, { visibility: "public", author_key: "d".repeat(32) });
		await block("d".repeat(32));

		const page = await readPool(db(), null, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});
});

describe("readPool, authenticated", () => {
	it("returns my own lesson at any status", async () => {
		const retracted = await seedFor(mine, { status: "retracted" });
		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([retracted.id]);
	});

	it("returns my own lesson even when my author_key is blocked", async () => {
		// A block stops a lesson reaching OTHER people. It is not a punishment
		// that hides your own writing from you.
		const own = await seedFor(mine, { author_key: "e".repeat(32) });
		await block("e".repeat(32));

		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([own.id]);
	});

	it("does not return another user's private lesson", async () => {
		await seedFor(theirs, { visibility: "private" });
		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("does not return another user's org lesson while OrgMembers is inert", async () => {
		await seedFor(theirs, { visibility: "org" });
		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("returns another user's public lesson", async () => {
		const pub = await seedFor(theirs, { visibility: "public" });
		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([pub.id]);
	});

	it("returns an org lesson once a resolver names the owner a member", async () => {
		// Proves the hole is wired without deciding what an org is - that is
		// ONL-12's. A resolver that names `theirs` is enough.
		const org = await seedFor(theirs, { visibility: "org" });

		const page = await readPool(db(), { userId: mine }, { limit: 50 }, async () => [
			theirs,
		]);

		expect(idsIn(page)).toEqual([org.id]);
	});

	it("still hides a private lesson from an org member", async () => {
		// Org membership widens `org`, never `private`.
		await seedFor(theirs, { visibility: "private" });

		const page = await readPool(db(), { userId: mine }, { limit: 50 }, async () => [
			theirs,
		]);

		expect(idsIn(page)).toEqual([]);
	});
});

describe("readPoolLesson", () => {
	it("returns a public lesson to an anonymous caller", async () => {
		const pub = await seedFor(theirs, { visibility: "public" });
		const found = await readPoolLesson(db(), null, pub.id);
		expect((found as { id: string }).id).toBe(pub.id);
	});

	it("returns null for a private lesson to an anonymous caller", async () => {
		const priv = await seedFor(theirs, { visibility: "private" });
		expect(await readPoolLesson(db(), null, priv.id)).toBeNull();
	});

	it("returns null for a missing id, indistinguishably", async () => {
		expect(
			await readPoolLesson(db(), null, "01NOPE00000000000000000000"),
		).toBeNull();
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @onlooker/api test src/db/pool.test.ts`
Expected: FAIL — cannot resolve `./pool.js`.

- [ ] **Step 3: Break the import cycle before writing the chokepoint**

`pool.ts` needs five things that live in `lessons.ts` today — `LessonPage`,
`BROWSE_MAX_LIMIT`, `BROWSE_DEFAULT_LIMIT`, the cursor codecs, and
`InvalidCursorError` — while `lessons.ts` is about to import `readPool` from
`pool.ts`. Importing both ways is a cycle: ESM tolerates it for values only read
inside function bodies, but it is fragile and the next addition breaks it.

Move those five into a new leaf module, `apps/api/src/db/pool-page.ts`, with no
imports of its own. Then re-export them from `lessons.ts` so every existing
importer (`routes/lessons-browser.ts`, `routes/lessons.ts`, and the test files)
is unchanged:

```ts
// In apps/api/src/db/lessons.ts, replacing their definitions:
export {
	BROWSE_DEFAULT_LIMIT,
	BROWSE_MAX_LIMIT,
	decodeCursor,
	encodeCursor,
	InvalidCursorError,
	type LessonPage,
} from "./pool-page.js";
```

The dependency direction is then one-way throughout: `pool-page.ts` ←
`pool.ts` ← `lessons.ts`.

Run: `pnpm --filter @onlooker/api test && pnpm --filter @onlooker/api typecheck`
Expected: unchanged results. This step moves code and adds no behavior, so a
failure here means an importer was missed.

- [ ] **Step 4: Write the blocklist reader and the chokepoint**

Create `apps/api/src/db/author-blocks.ts`:

```ts
/**
 * The blocklist, read by the pool predicate and written by the operator routes.
 *
 * A read that cannot resolve the blocklist must fail rather than serve
 * unfiltered, so nothing here catches its own errors.
 */
export async function isAuthorBlocked(
	db: D1Database,
	authorKey: string,
): Promise<boolean> {
	const row = await db
		.prepare("SELECT 1 AS hit FROM lesson_author_blocks WHERE author_key = ?")
		.bind(authorKey)
		.first<{ hit: number }>();
	return row !== null;
}
```

Create `apps/api/src/db/pool.ts`:

```ts
import {
	BROWSE_MAX_LIMIT,
	decodeCursor,
	encodeCursor,
	InvalidCursorError,
	type LessonPage,
} from "./pool-page.js";

/**
 * Who is asking. Resolved by the router from the route's declared `auth`, never
 * from a request parameter.
 *
 * Operator authority is deliberately absent. Moderation is authorized by a
 * route's `auth: "operator"` and acts through its own functions, so no read
 * predicate has an operator branch that could widen what a read returns.
 */
export interface Principal {
	userId: string;
}

/**
 * The org-membership hole. ONL-12 fills this.
 *
 * Contract: return the user_ids sharing an org with `userId`. Never include a
 * non-member. NEVER THROW - an org that cannot be resolved returns [], so a
 * membership outage narrows access instead of widening it.
 */
export type OrgMembers = (db: D1Database, userId: string) => Promise<string[]>;

/**
 * The inert stub, and the reason this whole seam can ship before ONL-12.
 *
 * With the org set empty, every read returns exactly what it returned before
 * this file existed. The unchanged existing test suite is the evidence.
 */
export const noOrgMembers: OrgMembers = async () => [];

export interface PoolFilters {
	statuses?: string[];
	cursor?: string | null;
	limit: number;
}

/**
 * The only place a visibility predicate is constructed.
 *
 * Two parts, ANDed. First, what this principal may see at all. Second, the
 * ownership-boundary rule: your own lessons you see at any status, but across an
 * ownership boundary nothing retracted and nothing from a blocked author_key is
 * ever served. For an anonymous caller `own` is the literal 0, so every row is
 * across the boundary and both restrictions always apply.
 *
 * Note that org membership widens `org` only. A member of your org still cannot
 * read your `private` lessons, which is why the org branch tests visibility
 * rather than only ownership.
 */
function visibilityPredicate(
	principal: Principal | null,
	orgMemberIds: string[],
): { sql: string; binds: unknown[] } {
	const binds: unknown[] = [];
	const visible: string[] = ["visibility = 'public'"];

	if (principal) {
		visible.push("user_id = ?");
		binds.push(principal.userId);

		if (orgMemberIds.length > 0) {
			visible.push(
				`(visibility = 'org' AND user_id IN (${orgMemberIds
					.map(() => "?")
					.join(", ")}))`,
			);
			binds.push(...orgMemberIds);
		}
	}

	const own = principal ? "user_id = ?" : "0";
	if (principal) binds.push(principal.userId);

	const sql =
		`(${visible.join(" OR ")})` +
		` AND (${own} OR (status != 'retracted'` +
		` AND NOT EXISTS (SELECT 1 FROM lesson_author_blocks b` +
		` WHERE b.author_key = lessons.author_key)))`;

	return { sql, binds };
}

/**
 * One page of the pool this principal may read, newest first.
 *
 * Callers pass filters, never SQL. There is no other path from a route to a
 * lesson body, which is what stops a read from being written without a
 * visibility predicate at all.
 */
export async function readPool(
	db: D1Database,
	principal: Principal | null,
	filters: PoolFilters,
	orgMembers: OrgMembers = noOrgMembers,
): Promise<LessonPage> {
	const limit = Math.min(Math.max(1, filters.limit), BROWSE_MAX_LIMIT);
	const orgMemberIds = principal ? await orgMembers(db, principal.userId) : [];
	const predicate = visibilityPredicate(principal, orgMemberIds);

	const binds: unknown[] = [...predicate.binds];
	let where = predicate.sql;

	if (filters.statuses && filters.statuses.length > 0) {
		where += ` AND status IN (${filters.statuses.map(() => "?").join(", ")})`;
		binds.push(...filters.statuses);
	}

	if (filters.cursor) {
		const after = decodeCursor(filters.cursor);
		if (!after) throw new InvalidCursorError();
		// Row-value comparison, which SQLite supports: strictly "older than the
		// boundary lesson", with id breaking a promoted_at tie.
		where += " AND (promoted_at, id) < (?, ?)";
		binds.push(after.promotedAt, after.id);
	}

	binds.push(limit + 1);

	const { results } = await db
		.prepare(
			`SELECT body FROM lessons
			 WHERE ${where}
			 ORDER BY promoted_at DESC, id DESC
			 LIMIT ?`,
		)
		.bind(...binds)
		.all<{ body: string }>();

	const rows = results ?? [];
	const hasMore = rows.length > limit;
	const page = (hasMore ? rows.slice(0, limit) : rows).map(
		(r) => JSON.parse(r.body) as { id: string; promoted_at: string },
	);
	const last = page.at(-1);

	return {
		lessons: page,
		cursor: hasMore && last ? encodeCursor(last.promoted_at, last.id) : null,
		hasMore,
	};
}

/**
 * One lesson by id, or null.
 *
 * Null covers both "does not exist" and "exists but you may not read it", and
 * the caller cannot tell them apart. A distinguishable answer would confirm
 * another user's lesson id - the same reasoning transitionLesson already
 * records.
 */
export async function readPoolLesson(
	db: D1Database,
	principal: Principal | null,
	id: string,
	orgMembers: OrgMembers = noOrgMembers,
): Promise<unknown | null> {
	const orgMemberIds = principal ? await orgMembers(db, principal.userId) : [];
	const predicate = visibilityPredicate(principal, orgMemberIds);

	const row = await db
		.prepare(
			`SELECT body FROM lessons
			 WHERE id = ? AND ${predicate.sql}`,
		)
		.bind(id, ...predicate.binds)
		.first<{ body: string }>();

	return row ? (JSON.parse(row.body) as unknown) : null;
}
```

- [ ] **Step 5: Run the tests, then PROVE THE LEAK TESTS BY ABLATION**

Run: `pnpm --filter @onlooker/api test src/db/pool.test.ts`
Expected: all PASS.

Now the part that is not optional. A leak test passes trivially if the fixture
happens to hold no private lessons, so each one must be *observed* to fail:

1. In `visibilityPredicate`, temporarily replace the returned object with
   `{ sql: "1 = 1", binds: [] }`.
2. Re-run. **Expected FAILURES:** the four anonymous leak tests ("does not
   return a private lesson", "does not return an org lesson", "does not return a
   retracted public lesson", "does not return a public lesson from a blocked
   author"), both authenticated "does not return another user's …" tests, "still
   hides a private lesson from an org member", and `readPoolLesson`'s "returns
   null for a private lesson".
3. Restore the predicate. Re-run. Expected: all PASS.

If any leak test passed while the predicate was ablated, that test proves
nothing — fix its fixture so it genuinely depends on the predicate before
continuing.

- [ ] **Step 6: Move the existing pool reads onto the chokepoint**

In `apps/api/src/db/lessons.ts`, add the import:

```ts
import { readPool, readPoolLesson } from "./pool.js";
```

Replace the body of `listLessonsPage`, keeping its exported signature so no
caller changes:

```ts
/**
 * One page of this user's pool, newest first.
 *
 * Kept as a named function rather than inlined at the route because its
 * signature is what the browse route and apps/web's contract tests already use.
 * The authorization now lives in readPool, which is the only place that builds
 * a visibility predicate.
 */
export async function listLessonsPage(
	db: D1Database,
	userId: string,
	opts: { statuses?: string[]; cursor?: string | null; limit: number },
): Promise<LessonPage> {
	return readPool(db, { userId }, opts);
}
```

And `getLessonForUser`:

```ts
/**
 * One lesson this user may read, or null.
 *
 * Previously fetched unfiltered and compared user_id in TypeScript afterward.
 * That was a second authorization mechanism alongside listLessonsPage's SQL
 * filter, and it could not express org or public without duplicating the
 * predicate. Both now go through readPool's.
 */
export async function getLessonForUser(
	db: D1Database,
	userId: string,
	id: string,
): Promise<unknown | null> {
	return readPoolLesson(db, { userId }, id);
}
```

- [ ] **Step 6b: Give `author_key` a writer**

`createLessonsWithFeed` (`apps/api/src/db/lessons.ts:157-174`) never binds
`author_key`, so the column Task 1 added is `''` on every row this function
writes — and it is the only writer. Add `author_key` to the column list and bind
`lesson.author_key`, beside `promoted_at`, extending that column's existing
comment to cover both rather than adding a competing one:

> The column and the body carry the same value, written in one statement so they
> cannot drift.

One difference deserves a clause: `promoted_at` is immutable and
`transitionLesson` must never touch it, whereas `author_key` is simply never
rewritten, because a lesson's author does not change.

**Mirror `promoted_at`'s two regression tests.** `apps/api/src/db/lessons.test.ts`
already has a `describe("promoted_at")` at ~318 whose second case carries the
comment "this is the assertion that would catch it if the INSERT ever stopped
binding one of them" — the exact bug this step fixes, on the column that had the
test. Add `describe("author_key")` beside it:

1. `it("is stored in the column, not only inside the body")` — write via
   `createLessonsWithFeed` with a known `author_key`, `SELECT author_key`, assert
   it matches.
2. `it("agrees with the copy inside the body")` — `SELECT author_key, body`,
   assert the column equals `JSON.parse(body).author_key`.

Scope is the INSERT's columns and binds plus those two tests. Nothing else in
`createLessonsWithFeed` — not the feed insert, not the sequence logic, not
`canonicalize`. Do not change the migration.

- [ ] **Step 7: Rename the probe**

Rename `getLessonsByIds` → `probeLessonIds` and `getLessonById` →
`probeLessonId`, and extend the doc comment with the rule the new name carries:

```ts
/**
 * Does this id exist, for any owner?
 *
 * DELIBERATELY UNAUTHORIZED, and named to say so. Push decides idempotency for
 * a whole batch and has to know that an id is taken even when it belongs to
 * someone else - while being careful never to reveal that fact.
 *
 * ITS RESULTS MUST NEVER BE SERIALIZED INTO A RESPONSE. Adding a user_id filter
 * here to "fix" the missing authorization would silently break push idempotency
 * across accounts; returning a row from it would leak another user's lesson.
 * Reads that answer a caller go through readPool.
 *
 * Plural because push decides a whole batch at once. Answering one id per
 * round-trip cost up to a hundred sequential D1 calls inside one request.
 */
export async function probeLessonIds(
```

Update the call sites in `apps/api/src/routes/lessons.ts` and
`apps/api/src/db/lessons.test.ts`.

- [ ] **Step 8: Add the test that pins the probe's cross-owner behavior**

Append inside the `probeLessonIds` describe block in
`apps/api/src/db/lessons.test.ts`:

```ts
	it("finds a lesson owned by someone else, which push depends on", async () => {
		// If a user_id filter is ever added here, push stops detecting that an
		// id is taken by another account and mints a duplicate. This test is the
		// tripwire for that.
		const other = await createUser(db(), "other@example.com", "hash", "Bob");
		const written = lesson() as TLesson;
		await createLessonsWithFeed(db(), other.id, [written]);

		const found = await probeLessonIds(db(), [written.id]);

		expect(found.get(written.id)?.user_id).toBe(other.id);
	});
```

Add `createUser` and the `TLesson` type to that file's imports if absent.

- [ ] **Step 9: Run the whole API suite**

Run: `pnpm --filter @onlooker/api test`
Expected: ALL PASS, including every pre-existing lessons, activity, and
lessons-browser test **unchanged**. That is the evidence the seam ships inert —
with `noOrgMembers` returning `[]`, no existing read changed its answer.

If a pre-existing test needed editing to pass, stop: the seam is not inert and
something about the predicate is wrong.

- [ ] **Step 10: Three gates, then commit**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
```
Commit via `/git-workflow:commit`. Message shape:
`refactor(api): put every pool read behind one predicate`. Body: two
authorization mechanisms existed (a SQL filter and a TypeScript comparison after
an unfiltered fetch); neither extended to org or public; the probe keeps its
deliberate lack of one and gets a name that says so.

---

## Task 3: Declarative route auth

**Files:**
- Create: `apps/api/src/middleware/principal.ts`
- Modify: `apps/api/src/router.ts` (`Route` interface ~42-54, every `ROUTES`
  entry ~55-250, `dispatch` ~343-362)
- Modify: `apps/api/src/middleware/cors.ts` (`withCors` ~76)
- Modify: `apps/api/src/types` (add `OPERATOR_USER_IDS` to `WorkerEnv`)
- Modify: `apps/api/wrangler.toml`
- Modify: `apps/api/src/router.test.ts`

**Interfaces:**
- Consumes: `Principal` from Task 2's `pool.ts`.
- Produces:
  - `type RouteAuth = "none" | "session" | "machine" | "operator"`

**`"session-or-machine"` appears below in this task's code and was removed during
it**, as unreachable. No route used it, and it existed nowhere but in
enumerations — this plan, a brief's interface list, and one spec line naming the
union without giving that member a rationale or a route. It was a mode written
down while listing possibilities, not one anything needed, and its bare `catch`
would have reported an infrastructure fault inside `requireAuth` to the caller as
"Missing machine token". Treat the snippets below as superseded on that point.

`"operator"` is also unused until Task 6 and **stays**, because it has a consumer
in the design rather than only in an enumeration: `db/pool.ts` explains that
operator authority is absent from `Principal` precisely so no read predicate can
grow a branch that widens what a read returns. Delete the mode and that argument
is orphaned.
  - `type RouteCors = "app" | "any"`
  - `Route` with required `auth: RouteAuth` and `cors: RouteCors`, exported
  - `ROUTES`, exported
  - `resolvePrincipal(request, env, auth: RouteAuth): Promise<Principal | null>`
  - handlers receive a 4th argument: `principal: Principal | null`

**Transitional note for the reviewer:** this task leaves the existing
`requireAuth` calls inside handlers in place, so a request is verified twice
until Task 4 removes them. Correct but wasteful; Task 4 follows immediately. The
safety property — a route cannot omit auth — is achieved here.

- [ ] **Step 1: Write the failing contract tests**

Add to `apps/api/src/router.test.ts`:

```ts
import { ROUTES } from "./router.js";

/**
 * The routes that answer without any credential. This list is the point: an
 * unauthenticated endpoint becomes an edit somebody reviews, rather than a
 * function call somebody forgot.
 */
const EXPECTED_UNAUTHENTICATED = [
	"POST /auth/signup",
	"POST /auth/login",
	"POST /auth/refresh",
	"POST /auth/logout",
	"POST /auth/forgot-password",
	"GET /auth/reset-password/verify",
	"POST /auth/reset-password",
	"POST /auth/verify-email",
	"POST /api/client-errors",
	// Task 5 adds "GET /api/public/lessons/:id" here when the route exists.
	// Listing it before then would commit a red test, and every commit on this
	// branch is green.
];

/**
 * The routes any origin may read. Kept separate from auth deliberately: login
 * and signup are also unauthenticated and must stay locked to one origin,
 * because a hostile page reading their responses is what made credential
 * stuffing from arbitrary origins cheap.
 *
 * Empty until Task 5. That is the correct expectation right now: no route today
 * should answer an arbitrary origin.
 */
const EXPECTED_ANY_ORIGIN: string[] = [];

const label = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe("route table declarations", () => {
	it("every route declares an auth mode", () => {
		expect(ROUTES.filter((r) => !r.auth).map(label)).toEqual([]);
	});

	it("every route declares a cors posture", () => {
		expect(ROUTES.filter((r) => !r.cors).map(label)).toEqual([]);
	});

	it("only the expected routes are unauthenticated", () => {
		const actual = ROUTES.filter((r) => r.auth === "none").map(label).sort();
		expect(actual).toEqual([...EXPECTED_UNAUTHENTICATED].sort());
	});

	it("only the expected routes are readable from any origin", () => {
		const actual = ROUTES.filter((r) => r.cors === "any").map(label).sort();
		expect(actual).toEqual([...EXPECTED_ANY_ORIGIN].sort());
	});

	it("no credential-taking route is readable from any origin", () => {
		const both = ROUTES.filter((r) => r.cors === "any" && r.auth !== "none");
		expect(both.map(label)).toEqual([]);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @onlooker/api test src/router.test.ts`
Expected: FAIL — `ROUTES` is not exported and `r.auth` does not exist.

- [ ] **Step 3: Add the types and the resolver**

Create `apps/api/src/middleware/principal.ts`:

```ts
import type { Principal } from "../db/pool.js";
import type { WorkerEnv } from "../types";
import { ApiError } from "../types";
import { requireAuth } from "./auth.js";
import { requireMachineToken } from "./machine-auth.js";

/**
 * How a route authenticates, declared at the route table rather than called
 * inside the handler.
 *
 * The old arrangement made this invisible: whether a route checked a credential
 * was discoverable only by reading its handler, so a forgotten call was an open
 * endpoint and nothing said so.
 */
export type RouteAuth =
	| "none"
	| "session"
	| "machine"
	| "session-or-machine"
	| "operator";

/**
 * Which origins may read a route's response.
 *
 * Separate from RouteAuth on purpose. "none" cannot drive the wildcard, because
 * login and signup are unauthenticated too and must stay origin-locked.
 */
export type RouteCors = "app" | "any";

/**
 * Who is calling, per the route's declaration.
 *
 * Returns null only for `auth: "none"`. Every other mode either produces a
 * principal or throws, so a handler never has to decide whether an absent
 * principal was allowed.
 */
export async function resolvePrincipal(
	request: Request,
	env: WorkerEnv,
	auth: RouteAuth,
): Promise<Principal | null> {
	switch (auth) {
		case "none":
			return null;

		case "session":
			return { userId: (await requireAuth(request, env)).userId };

		case "machine":
			return { userId: (await requireMachineToken(request, env)).userId };

		case "session-or-machine": {
			try {
				return { userId: (await requireAuth(request, env)).userId };
			} catch {
				return { userId: (await requireMachineToken(request, env)).userId };
			}
		}

		case "operator": {
			const { userId } = await requireAuth(request, env);
			if (!operatorIds(env).includes(userId)) {
				// 404-shaped on purpose: an operator route should not confirm
				// its own existence to a signed-in non-operator.
				throw new ApiError(404, "not_found", "Route not found");
			}
			return { userId };
		}
	}
}

/**
 * The accounts that may moderate, from the environment rather than the
 * database, so granting it is a deploy somebody reviews.
 *
 * Empty means nobody, which is the shipping default.
 */
function operatorIds(env: WorkerEnv): string[] {
	return (env.OPERATOR_USER_IDS ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0);
}
```

Add `OPERATOR_USER_IDS?: string` to `WorkerEnv`, and declare it empty in every
environment in `apps/api/wrangler.toml`.

- [ ] **Step 4: Make the fields required on `Route`, and fill in every entry**

In `apps/api/src/router.ts`:

```ts
export interface Route {
	method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
	path: string;
	/**
	 * How this route authenticates. Required, so a new route cannot be added
	 * without the author choosing - which is the whole point of the field.
	 */
	auth: RouteAuth;
	/** Which origins may read the response. The default posture is "app". */
	cors: RouteCors;
	handler: (
		request: Request,
		env: WorkerEnv,
		params: RouteParams,
		principal: Principal | null,
	) => Promise<Response>;
}
```

Export `ROUTES`, then add `auth` and `cors` to every entry. The mapping, derived
from what each handler calls today:

**This table is intent, not fact. The route table and the handlers are fact.**
Where they disagree, follow the code and say so — an earlier run of this plan
found that `POST /api/telemetry/error` below was a path I invented from the
filename `telemetry.ts` (the real route is `POST /api/client-errors`), and that
`/api/account/*`, `/api/profile` and `/api/data/*` were informal groupings, the
last of which names no route at all. The real paths in that group include
`/auth/profile`, `/auth/change-password`, `/auth/account`,
`/auth/resend-verification` and `/api/users/me`.

| Routes | `auth` | `cors` |
|---|---|---|
| `/auth/signup`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/reset-password/verify`, `/auth/verify-email` | `"none"` | `"app"` |
| `POST /api/client-errors` | `"none"` | `"app"` |
| `GET /auth/me`, the `/auth/*` account routes, `/api/users/me`, `/api/machines*`, `/api/lessons*`, `/api/activity`, `/api/sessions` | `"session"` | `"app"` |
| `GET /lessons`, `POST /lessons`, `POST /lessons/:id/status`, `PUT /machine/inventory`, `POST /machine/sessions` | `"machine"` | `"app"` |

Verify each against its handler before writing it down — the handler's own
`requireAuth` or `requireMachineToken` call is the source of truth, and a
handler that calls neither is `"none"`. `handleClientError` is the one that
calls neither *for a stated reason*: `routes/telemetry.ts:56` says
"Unauthenticated by design", because the failures most worth hearing about are
the ones that stop a client authenticating.

Record the finished list — real paths, assigned `auth` and `cors`, and the
handler evidence for each — in the task report. That list supersedes this table.

- [ ] **Step 5: Resolve the principal in `dispatch`**

```ts
export async function dispatch(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const url = new URL(request.url);
	const matched = findRoute(request.method, url.pathname);

	if (!matched) {
		return errorHandler(new ApiError(404, "not_found", "Route not found"));
	}

	try {
		// Before the handler, so a handler cannot run unauthenticated even if it
		// forgets to check. This is what the required `auth` field buys.
		const principal = await resolvePrincipal(request, env, matched.route.auth);
		return await matched.route.handler(
			request,
			env,
			matched.params,
			principal,
		);
	} catch (error) {
		return errorHandler(error);
	}
}
```

- [ ] **Step 6: Honor `cors: "any"`**

In `apps/api/src/middleware/cors.ts`, give `withCors` an optional `RouteCors`
argument. When it is `"any"`, answer `Access-Control-Allow-Origin: *`; otherwise
keep today's allowlist behavior exactly. Thread the matched route's `cors` from
wherever `withCors` is called in `apps/api/src/index.ts`.

Do NOT set `Access-Control-Allow-Credentials` on an `"any"` response — a
wildcard origin plus credentials is what the existing lock exists to prevent.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @onlooker/api test`
Expected: ALL PASS, the five new contract tests included. The expectation lists
describe the route table as it is after this task, not as it will be after Task
5, so nothing here is red.

If "only the expected routes are unauthenticated" fails, read the diff it
prints carefully rather than editing the list to match: a route that authenticates
today and appears in that failure is a route whose `auth` you wrote down wrong,
which is the exact mistake this test exists to catch.

- [ ] **Step 8: Three gates, then commit**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
```
Expected: all PASS. Commit via `/git-workflow:commit`. Message shape:
`refactor(api): declare route auth at the route table`. Body: whether a route
checked a credential was invisible outside its handler, so a forgotten call was
an open endpoint; the field is required so the choice cannot be skipped; cors is
a separate field because login and signup are unauthenticated and must stay
origin-locked.

---

## Task 4: Remove the redundant in-handler auth

**Files:**
- Modify: every file in `apps/api/src/routes/` that calls `requireAuth` or
  `requireMachineToken`

**Interfaces:**
- Consumes: Task 3's 4th handler argument, `principal: Principal | null`.
- Produces: no new interfaces. Removes the double verification.

- [ ] **Step 1: Convert one handler and run its tests**

Start with `apps/api/src/routes/lessons-browser.ts`:

```ts
export async function handleBrowseLessons(
	request: Request,
	env: WorkerEnv,
	_params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	// The router resolved this from the route's `auth: "session"`, which throws
	// rather than returning null, so it cannot be null here.
	const { userId } = principal as Principal;
	const url = new URL(request.url);
	// ... the rest of the handler is unchanged
```

Do the same for `handleGetLesson` and `handleBrowserTransition`, then drop the
now-unused `requireAuth` import.

Run: `pnpm --filter @onlooker/api test src/routes/lessons-browser.test.ts`
Expected: PASS, unchanged — the 401 cases still 401 because `dispatch` throws
before the handler runs.

- [ ] **Step 2: Convert the rest, one file per run**

For each of `account.ts`, `activity.ts`, `auth.ts`, `data.ts`, `lessons.ts`,
`machine-inventory.ts`, `machines.ts`, `sessions.ts`, `telemetry.ts`: replace the
auth call with the `principal` argument, then run that file's tests before moving
on. The `auth.ts` login/signup handlers are `"none"` and ignore the argument.

**Three handlers need more than `Principal` carries — and an earlier version of
this plan named the wrong three.** `Principal` is `{ userId: string }` and
deliberately nothing else. The list that the code actually requires:

- `handlePutInventory` (`routes/machine-inventory.ts`) and `handlePostSessions`
  (`routes/sessions.ts`) both consume `machineId` from `requireMachineToken`.
- `handleGetUserProfile` (`routes/data.ts`) puts `auth.email` into a required
  `UserProfile.email` field. It is a stub — `TODO: WS1 will implement`, with a
  hardcoded name — which is a further reason not to reshape a type for it.

**`handleMe` is NOT an exception, though this plan previously said it was.** It
reads only `auth.userId`; the `email` in its response comes from `getUserById`'s
row, and `auth.email` appears nowhere in `routes/auth.ts`. That claim was written
from inference about what a `/me` endpoint would plausibly do. Had it been
followed, it would have preserved the exact redundancy this task exists to remove
*and* attached a comment asserting a false reason for it — which is worse than a
missing exception, because the comment would assert a need the code does not have
and no reader could tell.

Do not reach for a DB lookup to avoid an exception. `requireAuth` is a local HMAC
verify with no I/O, while `getUserById` is a round trip at roughly 43 ms at p50 by
this repo's own measurement — so keeping a session-auth duplicate is *cheaper*
than fetching the field.

**Keep the credential call in all three**, each with a comment naming the field
it needs. Widening `Principal` for them would put a value on every request that
almost no handler reads, and `Principal` is deliberately narrow — `db/pool.ts`
explains that operator authority is absent from it so no read predicate can grow
a branch that widens what a read returns. The same reasoning keeps `machineId`
and `email` out.

**Removing the duplication on the machine routes is worth more than it looks.**
`verifyMachineToken` **writes** `last_used_at` (`db/machine-tokens.ts:94-97`), so
while Task 3's transitional state stands, each of the five machine routes does
two SELECTs *and two UPDATEs* per request — an extra D1 round trip plus a write
on the `onlooker sync` hot path, at roughly 43 ms per D1 call at p50 by this
repo's own measurement. So the three handlers above keep their call, and the
other two machine routes must genuinely lose theirs.

- [ ] **Step 3: Confirm no accidental double verification remains**

Run: `grep -rn "requireAuth\|requireMachineToken" apps/api/src/routes/`
Expected: only `handleMe`'s deliberate call, with its explaining comment.

- [ ] **Step 4: Full suite and three gates**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
```
Expected: all PASS.

- [ ] **Step 5: Commit via `/git-workflow:commit`**

Message shape: `refactor(api): verify a credential once per request`. Body: Task
3 moved auth into dispatch and left the handler calls in place, so every request
verified twice; this removes the duplicate and names `handleMe` as the one
deliberate exception.

---

## Task 5: The anonymous read

**Files:**
- Create: `apps/api/src/routes/lessons-public.ts`
- Create: `apps/api/src/routes/lessons-public.test.ts`
- Modify: `apps/api/src/router.ts`, `apps/api/src/routes/index.ts`

**Interfaces:**
- Consumes: `readPoolLesson` (Task 2), `Route.auth`/`Route.cors` (Task 3).
- Produces: `handlePublicLesson(request, env, params)`, and the one deliberate
  edit this plan makes to Task 3's two route-expectation lists.

- [ ] **Step 1: Write the failing route tests**

Create `apps/api/src/routes/lessons-public.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createLessonsWithFeed } from "../db/lessons.js";
import { createUser } from "../db/queries.js";
import { BASE, lesson, resetLessonCounter } from "../test-support/lessons.js";

const db = () => env.DB;
let owner: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_author_blocks").run();
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM users").run();
	owner = (await createUser(db(), "owner@example.com", "hash", "Ada")).id;
	resetLessonCounter();
});

/** Seeded directly: push still rejects every non-private tier, deliberately. */
async function seed(overrides: Record<string, unknown>): Promise<TLesson> {
	const written = lesson(overrides) as TLesson;
	await createLessonsWithFeed(db(), owner, [written]);
	return written;
}

const get = (id: string) => SELF.fetch(`${BASE}/api/public/lessons/${id}`);

describe("GET /api/public/lessons/:id", () => {
	it("serves a public lesson with no credential at all", async () => {
		const pub = await seed({ visibility: "public" });

		const response = await get(pub.id);

		expect(response.status).toBe(200);
		expect(((await response.json()) as { id: string }).id).toBe(pub.id);
	});

	// THE LEAK TESTS, at the route. Proven by ablation in Step 4.
	it("404s a private lesson", async () => {
		const priv = await seed({ visibility: "private" });
		expect((await get(priv.id)).status).toBe(404);
	});

	it("404s an org lesson", async () => {
		const org = await seed({ visibility: "org" });
		expect((await get(org.id)).status).toBe(404);
	});

	it("404s a retracted public lesson", async () => {
		const gone = await seed({ visibility: "public", status: "retracted" });
		expect((await get(gone.id)).status).toBe(404);
	});

	it("404s a public lesson from a blocked author", async () => {
		const pub = await seed({
			visibility: "public",
			author_key: "f".repeat(32),
		});
		await db()
			.prepare(
				`INSERT INTO lesson_author_blocks (author_key, reason, blocked_by)
				 VALUES (?, 'injection', 'operator-1')`,
			)
			.bind("f".repeat(32))
			.run();

		expect((await get(pub.id)).status).toBe(404);
	});

	it("404s a missing id the same way, so a 404 confirms nothing", async () => {
		const priv = await seed({ visibility: "private" });

		const missing = await get("01NOPE00000000000000000000");
		const hidden = await get(priv.id);

		expect(missing.status).toBe(hidden.status);
		expect(await missing.text()).toBe(await hidden.text());
	});

	it("caps cache lifetime, because the TTL is the takedown floor", async () => {
		const pub = await seed({ visibility: "public" });

		const header = (await get(pub.id)).headers.get("Cache-Control");

		const maxAge = Number(/max-age=(\d+)/.exec(header ?? "")?.[1] ?? -1);
		expect(maxAge).toBeGreaterThanOrEqual(0);
		expect(maxAge).toBeLessThanOrEqual(60);
	});

	it("allows any origin to read it, without credentials", async () => {
		const pub = await seed({ visibility: "public" });

		const response = await SELF.fetch(`${BASE}/api/public/lessons/${pub.id}`, {
			headers: { Origin: "https://somebody-elses-site.example" },
		});

		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		// A wildcard origin plus credentials is exactly what cors.ts exists to
		// prevent, so it must not appear even here.
		expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @onlooker/api test src/routes/lessons-public.test.ts`
Expected: FAIL — every case 404s with "Route not found".

- [ ] **Step 3: Write the handler and register it**

Create `apps/api/src/routes/lessons-public.ts`:

```ts
import { readPoolLesson } from "../db/pool.js";
import type { RouteParams, WorkerEnv } from "../types";
import { ApiError } from "../types";

/**
 * How long a public lesson may sit in a cache.
 *
 * THIS NUMBER IS THE FLOOR ON TAKEDOWN LATENCY. A retracted or newly blocked
 * lesson keeps being served until every cached copy expires, and a fast pull is
 * the control the whole moderation story rests on. Raising it lengthens the
 * window in which a lesson nobody can withdraw is still reaching readers.
 */
const MAX_AGE_SECONDS = 60;

/**
 * One public lesson, to anybody, with no credential.
 *
 * This handler exists separately from the browse routes for one reason: it may
 * only ever call readPoolLesson with a null principal. A predicate bug on an
 * authenticated route leaks to one signed-in user; the same bug here leaks to
 * the internet, so there must be no code path where a caller-supplied value
 * could widen what this sees.
 */
export async function handlePublicLesson(
	_request: Request,
	env: WorkerEnv,
	params: RouteParams,
): Promise<Response> {
	// Literal null, never a variable. See the note above.
	const found = await readPoolLesson(env.DB, null, params.id);

	// 404 and not 403: a 403 would confirm the id exists, which is the same
	// reasoning getLessonForUser and transitionLesson already follow.
	if (!found) throw new ApiError(404, "not_found", "No such lesson");

	return Response.json(found, {
		headers: { "Cache-Control": `public, max-age=${MAX_AGE_SECONDS}` },
	});
}
```

Export it from `apps/api/src/routes/index.ts`, and add to `ROUTES`:

```ts
	// =========================================================================
	// Public lessons (anonymous, one by id)
	//
	// Inside /api/ despite taking no credential: outside that prefix a route
	// cannot be mocked by createMockFetch and cannot be reached by an
	// api-contract case, which is how the machine-token surface spent three PRs
	// as the only one outside the drift gate. The `public` segment is the marker
	// for a human; auth: "none" is the marker for a machine.
	// =========================================================================
	{
		method: "GET",
		path: "/api/public/lessons/:id",
		auth: "none",
		cors: "any",
		handler: handlePublicLesson,
	},
```

- [ ] **Step 4: Declare the new route in the contract tests**

The route table now has an unauthenticated, any-origin route, so Task 3's two
expectation lists in `apps/api/src/router.test.ts` must name it — otherwise
those tests fail, and they are the guard that makes an open endpoint a reviewed
decision rather than an oversight. Add to `EXPECTED_UNAUTHENTICATED`:

```ts
	"GET /api/public/lessons/:id",
```

And replace the empty `EXPECTED_ANY_ORIGIN` with:

```ts
const EXPECTED_ANY_ORIGIN = ["GET /api/public/lessons/:id"];
```

This is the one edit to those lists this plan makes. Adding a route to them is
meant to feel deliberate.

**Also remove the two plan references those lists carry.** `router.test.ts:19`
says "Task 5 adds `GET /api/public/lessons/:id` here when the route exists" and
`:30` says "Empty until Task 5" — both written into this plan's own Task 3
snippets, and both stale the moment you complete this step. A plan task number in
permanent code dates itself to a document the repository does not ship, which is
exactly how a comment becomes misleading; Task 4 had to strip two of these out of
`router.ts` for the same reason. Replace them with what is true of the code: the
route is here because it is deliberately unauthenticated and deliberately
readable from any origin, and adding to either list is meant to be a reviewed
decision. Say that, without dating it.

- [ ] **Step 5: Run the tests, then PROVE THE LEAK TESTS BY ABLATION**

Run: `pnpm --filter @onlooker/api test`
Expected: all PASS, including the two route-table contract tests you just
updated.

Then ablate, at the route this time:

1. In `handlePublicLesson`, temporarily change the call to
   `readPoolLesson(env.DB, { userId: "any-user" }, params.id)`.
2. Re-run. **Expected: "404s a private lesson" and "404s an org lesson" FAIL** —
   a non-null principal widens the predicate, which is precisely the bug the
   separate handler exists to make impossible.
3. Restore the literal `null`. Re-run. Expected: all PASS.

- [ ] **Step 5b: Make the preflight honor `cors: "any"` — it does not today**

`preflightResponse` (`middleware/cors.ts:118-130`) takes no `RouteCors` and is
called at `index.ts:34` *ahead of* dispatch, so OPTIONS is always answered from
the origin allowlist. Left alone, this route answers `Access-Control-Allow-Origin:
*` on the response while **refusing the preflight** for any request that triggers
one.

How narrow that is, precisely, because it decides what to test. A cross-origin
GET is a *simple* request when its only headers are CORS-safelisted, so no
preflight fires and the wildcard on the response is sufficient by itself — an
anonymous `fetch()` from a third-party page works today. The breakage is confined
to a caller that adds `Authorization`, a JSON `Content-Type`, or a trace header.
Separately, a caller using `credentials: "include"` fails against a wildcard by
design, since the browser then demands an echoed origin and
`Access-Control-Allow-Credentials`. That is the intended posture — a public read
takes no credential — so "readable from any origin" means precisely "readable
*anonymously* from any origin."

**Why this lands here and not in Task 3:** an OPTIONS request cannot be matched
against the route table at all. `Route.method` is
`"GET" | "POST" | "PATCH" | "DELETE" | "PUT"` and no route declares OPTIONS, so
`resolveRoute(ROUTES, "OPTIONS", path)` returns undefined for every path. The
lookup has to read the preflight's own `Access-Control-Request-Method` to find the
route being asked about — which introduces a failure mode of its own. Doing that
in Task 3 would have meant writing a branch no route could exercise.

So: give `preflightResponse` the matched route's `RouteCors`, resolved by looking
the route up via `Access-Control-Request-Method`, and **fail closed to `"app"`**
when that header is missing, unparseable, or matches no route. A preflight that
cannot identify its route must get the allowlist, never the wildcard.

Two tests, in the same file:
1. An OPTIONS preflight from a foreign origin for `GET /api/public/lessons/:id`
   returns `Access-Control-Allow-Origin: *`.
2. An OPTIONS preflight from that *same* foreign origin for a `cors: "app"` route
   still gets no CORS headers back.

The second is the one that matters — it proves the wildcard did not leak to every
route.

**Two things in `cors.test.ts` need attention, both verified against the file.**
Every existing test calls `withCors` with three arguments, so `cors` defaults to
`"app"` and nothing exercises the wildcard branch at all:

1. `cors.test.ts:41` is named **"never answers with a wildcard"**. It is true of
   the `"app"` posture and will keep passing, but once an `"any"` route exists the
   name claims a property of the module that the module no longer has. Rename it
   to scope it to the default posture — the same correction the Task 2 review
   forced on `lessons-browser.test.ts`, for the same reason: a test whose name
   outruns its assertion misleads the next reader more than a missing test does.
2. `cors.test.ts:163` — "does not enable credentials" — also covers only `"app"`.
   Add the same assertion for the `"any"` branch. **This is the
   security-critical one:** a wildcard origin together with
   `Access-Control-Allow-Credentials` is the combination that must never occur,
   and right now nothing would catch it appearing.

Note that the `"any"` branch deliberately omits `Vary: Origin`, which is correct
— the response is identical for every origin, so varying on it would only defeat
caching. Do not "fix" that.

Without this step the route will pass every hand test that does not set a header,
which is why it is written down rather than left to notice.

- [ ] **Step 6: Add the edge rate limit, outside the worker**

This route has no principal to key a limit on, so the limit belongs at
Cloudflare's edge rather than in application code that would have to invent a
request identity.

In the Cloudflare dashboard for the API zone, add a rate-limiting rule matching
`http.request.uri.path matches "^/api/public/lessons/"`, keyed on the client IP,
at a ceiling that a human browsing could never reach — start at 60 requests per
minute per IP and revisit once there is real traffic.

Record it in `DEPLOYMENT.md` under the API section, because it is the one control
in this plan that lives outside the repository and therefore outside CI:

```markdown
### Public lesson reads

`GET /api/public/lessons/:id` takes no credential, so its rate limit is a
Cloudflare edge rule (path prefix `/api/public/lessons/`, keyed on client IP),
not worker code. Nothing in CI can verify it — if it is ever removed, the route
keeps working and only the cost signal changes.
```

This step is configuration and documentation, not code, so it has no test. Say
so in the commit body rather than leaving a reader to wonder.

- [ ] **Step 7: Three gates, then commit**

Commit via `/git-workflow:commit`. Message shape:
`feat(api): serve one public lesson to anybody`. Body: the shareable-link half of
a public gist; inside /api/ so the drift gate reaches it; 404 rather than 403 so
a response confirms nothing; the cache TTL is the floor on takedown latency,
which is why it is capped rather than tuned. Note that the rate limit is a
Cloudflare edge rule recorded in DEPLOYMENT.md, unverifiable by CI.

---

## Task 6: The operator controls

**Files:**
- Modify: `apps/api/src/test-support/lessons.ts` (export the password constant)
- Create: `apps/api/src/routes/admin-moderation.ts`
- Create: `apps/api/src/routes/admin-moderation.test.ts`
- Modify: `apps/api/src/db/author-blocks.ts` (add the writes)
- Modify: `apps/api/src/db/lessons.ts` (add `retractAnyLesson`)
- Modify: `apps/api/src/router.ts`, `apps/api/src/routes/index.ts`

**Interfaces:**
- Consumes: `auth: "operator"` (Task 3), the blocklist table (Task 1).
- Produces:
  - `blockAuthor(db, authorKey, reason, blockedBy): Promise<void>`
  - `unblockAuthor(db, authorKey): Promise<boolean>`
  - `retractAnyLesson(db, id): Promise<number | null>`
  - `POST /api/admin/lessons/:id/retract`, `POST /api/admin/author-blocks`,
    `DELETE /api/admin/author-blocks/:authorKey`
  - `TEST_PASSWORD` exported from `test-support/lessons.ts`

**Note on scope:** the spec names two controls (retract-any, block). This task
also adds **unblock**, because a block with no undo is a trap — one typo in a
32-hex key permanently silences an author with no route to reverse it. Flagged
rather than assumed; drop it if you disagree.

- [ ] **Step 0: Export the test password that already exists**

`apps/api/src/test-support/lessons.ts` holds a module-private `PASSWORD` constant
with the shared test account password. Rename it to `TEST_PASSWORD`, add
`export`, and update its existing internal use in `mintMachine`.

**Do not retype its value** — anywhere, including in this repository's docs. A
pre-commit hook scans for credential literals and will block the write; it
blocked this plan file twice during drafting. Move the existing string, do not
copy it.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/admin-moderation.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createLessonsWithFeed } from "../db/lessons.js";
import { createUser } from "../db/queries.js";
import {
	BASE,
	lesson,
	resetLessonCounter,
	TEST_PASSWORD,
} from "../test-support/lessons.js";

const db = () => env.DB;
let owner: string;
let operatorToken: string;
let ordinaryToken: string;

async function signup(email: string): Promise<{ id: string; token: string }> {
	const response = await SELF.fetch(`${BASE}/auth/signup`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password: TEST_PASSWORD, name: "Ada" }),
	});
	const body = (await response.json()) as {
		token: string;
		user: { id: string };
	};
	return { id: body.user.id, token: body.token };
}

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_author_blocks").run();
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM users").run();
	resetLessonCounter();

	const operator = await signup("operator@example.com");
	const ordinary = await signup("ordinary@example.com");
	operatorToken = operator.token;
	ordinaryToken = ordinary.token;
	owner = (await createUser(db(), "owner@example.com", "hash", "Bob")).id;

	// The env var the operator check reads. Operator authority is env-driven
	// rather than a DB column so granting it is a deploy somebody reviews.
	(env as { OPERATOR_USER_IDS?: string }).OPERATOR_USER_IDS = operator.id;
});

async function seed(overrides: Record<string, unknown>): Promise<TLesson> {
	const written = lesson(overrides) as TLesson;
	await createLessonsWithFeed(db(), owner, [written]);
	return written;
}

const authed = (token: string) => ({ Authorization: `Bearer ${token}` });
const asJson = (token: string) => ({
	...authed(token),
	"Content-Type": "application/json",
});

const retract = (id: string, token: string) =>
	SELF.fetch(`${BASE}/api/admin/lessons/${id}/retract`, {
		method: "POST",
		headers: authed(token),
	});

describe("POST /api/admin/lessons/:id/retract", () => {
	it("retracts a lesson the operator does not own", async () => {
		const pub = await seed({ visibility: "public" });

		const response = await retract(pub.id, operatorToken);

		expect(response.status).toBe(200);
		const row = await db()
			.prepare("SELECT status FROM lessons WHERE id = ?")
			.bind(pub.id)
			.first<{ status: string }>();
		expect(row?.status).toBe("retracted");
	});

	it("stops serving it anonymously", async () => {
		const pub = await seed({ visibility: "public" });
		await retract(pub.id, operatorToken);

		const read = await SELF.fetch(`${BASE}/api/public/lessons/${pub.id}`);

		expect(read.status).toBe(404);
	});

	it("404s for a signed-in non-operator, confirming nothing", async () => {
		const pub = await seed({ visibility: "public" });

		expect((await retract(pub.id, ordinaryToken)).status).toBe(404);
	});

	it("401s with no credential", async () => {
		const pub = await seed({ visibility: "public" });

		const response = await SELF.fetch(
			`${BASE}/api/admin/lessons/${pub.id}/retract`,
			{ method: "POST" },
		);

		expect(response.status).toBe(401);
	});
});

describe("author blocks", () => {
	const KEY = "9".repeat(32);

	const blockRequest = (body: unknown, token: string) =>
		SELF.fetch(`${BASE}/api/admin/author-blocks`, {
			method: "POST",
			headers: asJson(token),
			body: JSON.stringify(body),
		});

	const unblockRequest = (key: string, token: string) =>
		SELF.fetch(`${BASE}/api/admin/author-blocks/${key}`, {
			method: "DELETE",
			headers: authed(token),
		});

	it("stops serving every public lesson from a blocked key", async () => {
		const pub = await seed({ visibility: "public", author_key: KEY });

		const blocked = await blockRequest(
			{ author_key: KEY, reason: "injection" },
			operatorToken,
		);

		expect(blocked.status).toBe(200);
		expect(
			(await SELF.fetch(`${BASE}/api/public/lessons/${pub.id}`)).status,
		).toBe(404);
	});

	it("serves it again after an unblock", async () => {
		const pub = await seed({ visibility: "public", author_key: KEY });
		await blockRequest({ author_key: KEY, reason: "mistake" }, operatorToken);

		const unblocked = await unblockRequest(KEY, operatorToken);

		expect(unblocked.status).toBe(200);
		expect(
			(await SELF.fetch(`${BASE}/api/public/lessons/${pub.id}`)).status,
		).toBe(200);
	});

	it("rejects a key that is not 32 hex characters", async () => {
		const response = await blockRequest(
			{ author_key: "nope", reason: "typo" },
			operatorToken,
		);

		expect(response.status).toBe(400);
	});

	it("requires a reason, so a block can be reviewed later", async () => {
		const response = await blockRequest(
			{ author_key: KEY, reason: "   " },
			operatorToken,
		);

		expect(response.status).toBe(400);
	});

	it("records who blocked and why", async () => {
		await blockRequest({ author_key: KEY, reason: "injection" }, operatorToken);

		const row = await db()
			.prepare(
				"SELECT reason, blocked_by FROM lesson_author_blocks WHERE author_key = ?",
			)
			.bind(KEY)
			.first<{ reason: string; blocked_by: string }>();

		expect(row?.reason).toBe("injection");
		expect(row?.blocked_by).not.toBe("");
	});

	it("404s an unblock of a key that was never blocked", async () => {
		expect((await unblockRequest(KEY, operatorToken)).status).toBe(404);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @onlooker/api test src/routes/admin-moderation.test.ts`
Expected: FAIL — the routes do not exist, so every case 404s.

- [ ] **Step 3: Add the DB writes**

Append to `apps/api/src/db/author-blocks.ts`:

```ts
/**
 * Block an author key. Idempotent: blocking twice is not an error, because an
 * operator acting on a report should not have to check first.
 */
export async function blockAuthor(
	db: D1Database,
	authorKey: string,
	reason: string,
	blockedBy: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO lesson_author_blocks (author_key, reason, blocked_by)
			 VALUES (?, ?, ?)
			 ON CONFLICT(author_key) DO UPDATE SET
			   reason = excluded.reason,
			   blocked_by = excluded.blocked_by,
			   blocked_at = CURRENT_TIMESTAMP`,
		)
		.bind(authorKey, reason, blockedBy)
		.run();
}

/** Lift a block. Returns whether there was one, so a typo'd key reads as 404. */
export async function unblockAuthor(
	db: D1Database,
	authorKey: string,
): Promise<boolean> {
	const result = await db
		.prepare("DELETE FROM lesson_author_blocks WHERE author_key = ?")
		.bind(authorKey)
		.run();
	return (result.meta.changes ?? 0) > 0;
}
```

Add to `apps/api/src/db/lessons.ts`, beside `transitionLesson`:

```ts
/**
 * Retract a lesson whoever owns it.
 *
 * A SEPARATE FUNCTION from transitionLesson on purpose. That one's
 * `WHERE id = ? AND user_id = ?` is the user-facing guarantee that a caller
 * cannot touch somebody else's lesson, and widening it with an optional
 * "skip the owner check" flag would put a cross-owner write one wrong argument
 * away from every ordinary transition. Two functions cannot be confused.
 *
 * Appends to the owner's feed like any other transition, so their mirror learns
 * about it on the next delta pull.
 */
export async function retractAnyLesson(
	db: D1Database,
	id: string,
): Promise<number | null> {
	const stored = await probeLessonId(db, id);
	if (!stored) return null;
	return transitionLesson(db, stored.user_id, id, "retracted", null);
}
```

- [ ] **Step 4: Write the routes**

Create `apps/api/src/routes/admin-moderation.ts`:

```ts
import { blockAuthor, unblockAuthor } from "../db/author-blocks.js";
import { retractAnyLesson, SequenceExhaustedError } from "../db/lessons.js";
import type { Principal } from "../db/pool.js";
import type { RouteParams, WorkerEnv } from "../types";
import { ApiError } from "../types";

/** The contract's own shape for an author key. See ZAuthorKey. */
const AUTHOR_KEY = /^[0-9a-f]{32}$/;

/**
 * Operator moderation.
 *
 * Every route here declares auth: "operator", which 404s a signed-in
 * non-operator rather than 403ing - an operator surface should not confirm its
 * own existence to someone who may not use it.
 */
export async function handleOperatorRetract(
	_request: Request,
	env: WorkerEnv,
	params: RouteParams,
): Promise<Response> {
	let seq: number | null;
	try {
		seq = await retractAnyLesson(env.DB, params.id);
	} catch (error) {
		if (error instanceof SequenceExhaustedError) {
			throw new ApiError(
				503,
				"sequence_contention",
				"Could not assign a lesson sequence; nothing was written, so retry",
			);
		}
		throw error;
	}

	if (seq === null) throw new ApiError(404, "not_found", "No such lesson");
	return Response.json({ id: params.id, seq, status: "retracted" });
}

export async function handleBlockAuthor(
	request: Request,
	env: WorkerEnv,
	_params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	const body = (await request.json()) as {
		author_key?: unknown;
		reason?: unknown;
	};
	const authorKey = typeof body.author_key === "string" ? body.author_key : "";
	const reason = typeof body.reason === "string" ? body.reason.trim() : "";

	if (!AUTHOR_KEY.test(authorKey)) {
		throw new ApiError(
			400,
			"invalid_author_key",
			"author_key must be 32 lowercase hex characters",
		);
	}
	// Required, because a block nobody explained cannot be reviewed later.
	if (reason.length === 0) {
		throw new ApiError(400, "reason_required", "Say why this key is blocked");
	}

	await blockAuthor(env.DB, authorKey, reason, (principal as Principal).userId);
	return Response.json({ author_key: authorKey, blocked: true });
}

export async function handleUnblockAuthor(
	_request: Request,
	env: WorkerEnv,
	params: RouteParams,
): Promise<Response> {
	const lifted = await unblockAuthor(env.DB, params.authorKey);
	if (!lifted) throw new ApiError(404, "not_found", "That key is not blocked");
	return Response.json({ author_key: params.authorKey, blocked: false });
}
```

Export from `routes/index.ts` and register in `ROUTES`:

```ts
	// =========================================================================
	// Operator moderation
	//
	// auth: "operator" 404s a signed-in non-operator, so this surface does not
	// confirm its own existence. OPERATOR_USER_IDS is empty in every
	// environment until somebody is deliberately granted it.
	// =========================================================================
	{
		method: "POST",
		path: "/api/admin/lessons/:id/retract",
		auth: "operator",
		cors: "app",
		handler: handleOperatorRetract,
	},
	{
		method: "POST",
		path: "/api/admin/author-blocks",
		auth: "operator",
		cors: "app",
		handler: handleBlockAuthor,
	},
	{
		method: "DELETE",
		path: "/api/admin/author-blocks/:authorKey",
		auth: "operator",
		cors: "app",
		handler: handleUnblockAuthor,
	},
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @onlooker/api test src/routes/admin-moderation.test.ts`
Expected: all PASS.

- [ ] **Step 5b: Write down where a report goes**

The spec says reports arrive out of band and are documented rather than built.
Nothing in the product currently tells anyone where to send one, which makes the
whole moderation path unreachable from outside.

Add to `README.md`, near the top-level project description:

```markdown
## Reporting a public lesson

Public lessons are readable by anyone and are read by other people's agents. To
report one that carries an injected instruction, a secret, or a claim engineered
to mislead, email <meagan@meaganwaller.com> with the lesson's id. There is no
in-product report queue yet — a lesson can be withdrawn within minutes of a
report, and the id is all that is needed to do it.
```

- [ ] **Step 6: Full suite and three gates**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
pnpm --filter @onlooker/db test
```
Expected: all PASS. This is the last task, so this is the full branch green.

- [ ] **Step 7: Commit via `/git-workflow:commit`**

Message shape: `feat(api): let an operator pull a lesson and block a key`. Body:
retract-any is a separate function from transitionLesson so a cross-owner write
is not one wrong argument away; the operator surface 404s rather than 403s;
unblock is included because a block with no undo is a trap.

---

## Definition of done

- [ ] All six tasks committed on `meagan/onl-12-shared-read-path`.
- [ ] `pnpm --filter @onlooker/api test`, `typecheck`, and `lint` green; same for
      `@onlooker/db`.
- [ ] Every pre-existing lessons, activity, and lessons-browser test passes
      **unedited** — the evidence that the seam shipped inert.
- [ ] Each leak test observed to fail under ablation and then restored, at both
      the DB layer (Task 2 Step 5) and the route (Task 5 Step 4).
- [ ] `apps/api/src/routes/lessons.ts:104` still rejects non-private lessons, and
      `routes/lessons.test.ts:184` still passes unchanged. The push gate does not
      open in this plan.
- [ ] `grep -rn "requireAuth\|requireMachineToken" apps/api/src/routes/` returns
      only `handleMe`'s documented exception.
- [ ] `OPERATOR_USER_IDS` present and empty in every environment in
      `wrangler.toml`.
- [ ] The Cloudflare edge rate-limiting rule for `/api/public/lessons/` exists
      and is recorded in `DEPLOYMENT.md`. Nothing in CI checks this, which is
      exactly why it is on this list.
- [ ] `README.md` says where to email a report about a public lesson.
- [ ] No import cycle: `pool-page.ts` imports nothing from this directory,
      `pool.ts` imports only from `pool-page.ts`, and `lessons.ts` imports from
      both.

## Not in this plan

- **ONL-12's org membership.** `noOrgMembers` returns `[]`; ONL-12 replaces it
  and threads the real resolver through `readPool`'s optional 4th argument,
  which Task 2's two org tests already exercise.
- **ONL-13's unanimity decision.** A design question, not code.
- **Opening the push tier gate.** The last step, after both tiers land.
- **Foreign lessons in the CLI mirror**, anonymous listing, reader-side mute, an
  in-product report path, and surfacing `asserted_by` to public readers. Each
  deferred to its own issue by the spec.
