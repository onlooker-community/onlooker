# Browser-Authenticated Lesson Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the browser three session-authenticated routes over the lesson pool — a paginated newest-first list, a single lesson by id, and a retract/un-retract transition — without touching the machine sync contract.

**Architecture:** New handlers in `apps/api/src/routes/lessons-browser.ts`, backed by two new query functions in `apps/api/src/db/lessons.ts`. All three routes use `requireAuth` and scope every query to the caller's `user_id`. The existing machine routes at `/lessons` are not modified. `packages/api-contract` grows cases that both `apps/api` and `apps/web`'s mock must satisfy.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), drizzle-kit for migrations, vitest 4 with `@cloudflare/vitest-pool-workers`, pnpm workspace.

**Bead:** `onlooker-yj5`
**Spec:** [`docs/superpowers/specs/2026-08-23-lesson-pool-surface-design.md`](../specs/2026-08-23-lesson-pool-surface-design.md), Section 3
**Builds on:** `onlooker-w5o` (merged, PR #83) — `lessons.promoted_at` is an indexed column.

## Global Constraints

- **Never modify the machine routes.** `POST /lessons`, `GET /lessons`, and `POST /lessons/:id/status` in `apps/api/src/routes/lessons.ts` stay exactly as they are. The whole reason these are separate routes is that a browsing change must not be able to break a mirror mid-drain.
- **Every query is scoped to the caller's `user_id`.** Another user's lesson returns **404, not 403** — a 403 confirms the id exists.
- **The browser transition accepts `active` and `retracted` only.** `refuted` and `superseded` return 400 naming why. This is enforced in the handler, not by which buttons the UI renders.
- **`promoted_at` is immutable.** No route in this plan writes it.
- **`packages/db/src/expected-schema.ts` is GENERATED.** Regenerate with `pnpm --filter @onlooker/db generate:expected-schema`, and run `pnpm --filter @onlooker/db build` FIRST — the generator imports `../dist/schema.js`.
- **SQLite refuses `ADD COLUMN ... NOT NULL` without a non-NULL default.** Not relevant to this plan (no new columns), noted so nobody rediscovers it.
- Pagination defaults: `limit` 50, maximum 200. Repeatable `?status`.
- American English. Conventional Commits with a mood emoji, subject ≤72 characters including the emoji. Commits go through the `/commit` skill.
- Branch off `main`; everything lands via a PR.

## Two decisions this plan makes, and why

**1. The browser transition is `PATCH`, while the machine one is `POST`.**

The spec says `PATCH /api/lessons/:id/status`. The existing machine route is `POST /lessons/:id/status`. That is a real inconsistency and it is deliberate: these are two separate contracts by design, and `PATCH` is the correct method for a partial state update. The machine route's `POST` is the anomaly, not the convention — it is not worth propagating into a new surface to avoid a cosmetic mismatch, and changing it would modify the machine contract, which the Global Constraints forbid.

**2. Including `id` in the cursor is a correctness requirement. Extending the index is not.**

`onlooker-w5o`'s final review flagged that a keyset cursor on `promoted_at` alone is unstable when two lessons share a timestamp. That is true, and the fix is in the **`WHERE` clause** — `(promoted_at, id) < (?, ?)` — which is correct regardless of what indexes exist. Task 1 additionally extends the index to `(user_id, promoted_at, id)`, and that part is **performance, not correctness**: it lets the tiebreak comparison be answered from the index instead of a row lookup. It is included now only because the production pool is empty (verified `n = 0` at `onlooker-w5o`'s merge), which makes this the cheapest it will ever be. If Task 1 turns out to be a problem, it can be dropped without affecting pagination correctness.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/db/src/schema.ts` | Schema source of truth | Modify: extend the index |
| `packages/db/migrations/0005_*.sql` | The DDL | Create (generated) |
| `packages/db/src/expected-schema.ts` | Deploy-verified snapshot | Regenerate |
| `packages/db/src/__tests__/schema.test.ts` | Declared shape | Modify |
| `apps/api/src/db/lessons.ts` | Pool queries | Modify: add two read functions |
| `apps/api/src/db/lessons-browser.test.ts` | The new queries, at D1 level | Create |
| `apps/api/src/routes/lessons-browser.ts` | The three handlers | Create |
| `apps/api/src/routes/lessons-browser.test.ts` | The routes, over HTTP | Create |
| `apps/api/src/routes/index.ts` | Handler barrel | Modify: export three handlers |
| `apps/api/src/router.ts` | Route table | Modify: register three routes |
| `packages/api-contract/src/index.ts` | The shared contract table | Modify: add cases |
| `apps/web/src/api/mockApi.ts` | The web mock | Modify: add branches |

**Why a new route file rather than growing `routes/lessons.ts`:** that file is already ~430 lines and owns the entire machine sync protocol — batch validation, per-item outcomes, sequence contention. The browser routes share none of that. Keeping them apart is also the mechanical guarantee behind the Global Constraint: a change in `lessons-browser.ts` cannot alter machine behavior.

---

### Task 1: Extend the index for the keyset tiebreak

**Files:**
- Modify: `packages/db/src/schema.ts` (the `lessons` index callback)
- Modify: `packages/db/src/__tests__/schema.test.ts`
- Create: `packages/db/migrations/0005_<generated-name>.sql`
- Regenerate: `packages/db/src/expected-schema.ts`

**Interfaces:**
- Consumes: `lessons_user_promoted_at_idx` on `(user_id, promoted_at)` from `onlooker-w5o`.
- Produces: the same index name, now on `(user_id, promoted_at, id)`. Task 2's list query orders by these three.

- [ ] **Step 1: Write the failing test**

In `packages/db/src/__tests__/schema.test.ts`, update the existing index test inside `describe("lessons", ...)`. Its current name is `"indexes (user_id, promoted_at) so the pool can be ordered"`.

```typescript
	// The third column is the keyset tiebreak. Two lessons promoted in the same
	// millisecond make a cursor on promoted_at alone ambiguous, and a page
	// boundary that lands between them can skip or repeat a row. Ordering by
	// (promoted_at, id) is what makes the cursor stable; carrying id in the
	// index is what keeps that comparison off the table.
	it("indexes (user_id, promoted_at, id) so the cursor is stable", () => {
		const idx = getTableConfig(lessons).indexes.find(
			(i) => i.config.name === "lessons_user_promoted_at_idx",
		);
		expect(indexColumnNames(idx?.config.columns ?? [])).toEqual([
			"user_id",
			"promoted_at",
			"id",
		]);
	});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @onlooker/db test
```

Expected: FAIL — received `["user_id", "promoted_at"]`, expected the three-column array.

- [ ] **Step 3: Extend the index**

In `packages/db/src/schema.ts`, in the `lessons` index callback:

```typescript
		userPromotedAtIdx: index("lessons_user_promoted_at_idx").on(
			table.user_id,
			table.promoted_at,
			table.id,
		),
```

- [ ] **Step 4: Generate the migration**

```bash
pnpm --filter @onlooker/db generate:migrations
```

Open `packages/db/migrations/0005_<name>.sql` and confirm it drops and recreates the index — SQLite cannot alter one in place:

```sql
DROP INDEX `lessons_user_promoted_at_idx`;--> statement-breakpoint
CREATE INDEX `lessons_user_promoted_at_idx` ON `lessons` (`user_id`,`promoted_at`,`id`);
```

If drizzle-kit emits something else, stop and report it rather than hand-editing — the schema and the migration must agree.

- [ ] **Step 5: Rebuild and regenerate the snapshot**

Building first is not optional; the generator reads `dist/schema.js`.

```bash
pnpm --filter @onlooker/db build
pnpm --filter @onlooker/db generate:expected-schema
```

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @onlooker/db test
pnpm --filter @onlooker/api test
```

Expected: both PASS. The API suite applies the migrations, so a malformed 0005 fails there at setup.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/expected-schema.ts \
        packages/db/src/__tests__/schema.test.ts packages/db/migrations
```

Then invoke `/commit`. Suggested message:

```text
perf(db): carry id in the pool index so the cursor can tie-break :link:

Two lessons promoted in the same millisecond make a keyset cursor on
promoted_at alone ambiguous. The stability fix is in the query's WHERE
clause, but the comparison it makes wants id in the index rather than a
row lookup per boundary row.

Done now because the production pool is empty, which makes rebuilding
this index the cheapest it will ever be.

Refs: onlooker-yj5
```

---

### Task 2: The two read queries

**Files:**
- Modify: `apps/api/src/db/lessons.ts` (append; do not alter existing functions)
- Create: `apps/api/src/db/lessons-browser.test.ts`

**Interfaces:**
- Consumes: the `promoted_at` column, the extended index, and the existing `StoredLesson` type and `getLessonById` from `apps/api/src/db/lessons.ts`.
- Produces, for Task 3:
  - `encodeCursor(promotedAt: string, id: string): string`
  - `decodeCursor(cursor: string): { promotedAt: string; id: string } | null`
  - `listLessonsPage(db: D1Database, userId: string, opts: { statuses?: string[]; cursor?: string | null; limit: number }): Promise<{ lessons: unknown[]; cursor: string | null; hasMore: boolean }>`
  - `getLessonForUser(db: D1Database, userId: string, id: string): Promise<unknown | null>` — returns the parsed body, or null when the lesson does not exist **or belongs to someone else**. The caller cannot tell those apart.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/db/lessons-browser.test.ts`:

```typescript
import { env } from "cloudflare:test";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "./queries.js";
import {
	createLessonsWithFeed,
	decodeCursor,
	encodeCursor,
	getLessonForUser,
	listLessonsPage,
} from "./lessons.js";
import { lesson, resetLessonCounter } from "../test-support/lessons.js";

const db = () => env.DB;

let userId: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM users").run();
	const user = await createUser(db(), "pool@example.com", "hash", "Ada");
	userId = user.id;
	resetLessonCounter();
});

/**
 * Write lessons whose promoted_at values are given, oldest first.
 *
 * The cast is because test-support's `lesson()` returns an untyped literal so
 * callers can override any field, including invalid ones. Here every override
 * is valid, so asserting the contract type is honest rather than a workaround.
 */
async function seed(dates: string[]): Promise<TLesson[]> {
	const written = dates.map((d) => lesson({ promoted_at: d }) as TLesson);
	await createLessonsWithFeed(db(), userId, written);
	return written;
}

describe("listLessonsPage", () => {
	it("returns newest first", async () => {
		await seed([
			"2026-08-01T00:00:00.000Z",
			"2026-08-03T00:00:00.000Z",
			"2026-08-02T00:00:00.000Z",
		]);

		const page = await listLessonsPage(db(), userId, { limit: 50 });

		expect(
			(page.lessons as Array<{ promoted_at: string }>).map((l) => l.promoted_at),
		).toEqual([
			"2026-08-03T00:00:00.000Z",
			"2026-08-02T00:00:00.000Z",
			"2026-08-01T00:00:00.000Z",
		]);
		expect(page.hasMore).toBe(false);
		expect(page.cursor).toBeNull();
	});

	it("walks pages without skipping or repeating a lesson", async () => {
		await seed([
			"2026-08-01T00:00:00.000Z",
			"2026-08-02T00:00:00.000Z",
			"2026-08-03T00:00:00.000Z",
			"2026-08-04T00:00:00.000Z",
			"2026-08-05T00:00:00.000Z",
		]);

		const seen: string[] = [];
		let cursor: string | null = null;
		do {
			const page = await listLessonsPage(db(), userId, { limit: 2, cursor });
			seen.push(...(page.lessons as Array<{ id: string }>).map((l) => l.id));
			cursor = page.cursor;
		} while (cursor);

		expect(seen).toHaveLength(5);
		expect(new Set(seen).size).toBe(5);
	});

	// The whole reason id is in the cursor. Without it, a page boundary landing
	// between two lessons sharing a timestamp either skips or repeats one.
	it("is stable when every lesson shares a promoted_at", async () => {
		const same = "2026-08-09T00:00:00.000Z";
		await seed([same, same, same, same]);

		const seen: string[] = [];
		let cursor: string | null = null;
		do {
			const page = await listLessonsPage(db(), userId, { limit: 2, cursor });
			seen.push(...(page.lessons as Array<{ id: string }>).map((l) => l.id));
			cursor = page.cursor;
		} while (cursor);

		expect(seen).toHaveLength(4);
		expect(new Set(seen).size).toBe(4);
	});

	it("filters by status", async () => {
		const [first] = await seed([
			"2026-08-01T00:00:00.000Z",
			"2026-08-02T00:00:00.000Z",
		]);
		await db()
			.prepare("UPDATE lessons SET status = 'retracted' WHERE id = ?")
			.bind(first.id)
			.run();

		const page = await listLessonsPage(db(), userId, {
			limit: 50,
			statuses: ["retracted"],
		});

		expect(page.lessons).toHaveLength(1);
		expect((page.lessons[0] as { id: string }).id).toBe(first.id);
	});

	it("never returns another user's lessons", async () => {
		await seed(["2026-08-01T00:00:00.000Z"]);
		const other = await createUser(db(), "other@example.com", "hash", "Bo");

		const page = await listLessonsPage(db(), other.id, { limit: 50 });

		expect(page.lessons).toEqual([]);
	});

	it("caps the page at the requested limit and reports more", async () => {
		await seed([
			"2026-08-01T00:00:00.000Z",
			"2026-08-02T00:00:00.000Z",
			"2026-08-03T00:00:00.000Z",
		]);

		const page = await listLessonsPage(db(), userId, { limit: 2 });

		expect(page.lessons).toHaveLength(2);
		expect(page.hasMore).toBe(true);
		expect(page.cursor).not.toBeNull();
	});
});

describe("getLessonForUser", () => {
	it("returns the lesson body", async () => {
		const [written] = await seed(["2026-08-01T00:00:00.000Z"]);

		const found = await getLessonForUser(db(), userId, written.id);

		expect((found as { id: string }).id).toBe(written.id);
	});

	// 404, not 403 - a 403 would confirm the id exists.
	it("returns null for another user's lesson", async () => {
		const [written] = await seed(["2026-08-01T00:00:00.000Z"]);
		const other = await createUser(db(), "other@example.com", "hash", "Bo");

		expect(await getLessonForUser(db(), other.id, written.id)).toBeNull();
	});

	it("returns null for an id nobody holds", async () => {
		expect(
			await getLessonForUser(db(), userId, "01NOPE00000000000000000000"),
		).toBeNull();
	});
});

describe("cursor encoding", () => {
	it("round-trips", () => {
		const c = encodeCursor("2026-08-01T00:00:00.000Z", "01ABC");
		expect(decodeCursor(c)).toEqual({
			promotedAt: "2026-08-01T00:00:00.000Z",
			id: "01ABC",
		});
	});

	// A cursor is client-supplied input. Garbage must not throw a 500.
	it("returns null for a cursor that is not ours", () => {
		for (const bad of ["", "!!!!", "bm90LWEtY3Vyc29y"]) {
			expect(decodeCursor(bad)).toBeNull();
		}
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @onlooker/api test src/db/lessons-browser.test.ts
```

Expected: FAIL at import — `listLessonsPage`, `getLessonForUser`, `encodeCursor` and `decodeCursor` are not exported from `./lessons.js`.

- [ ] **Step 3: Implement the queries**

Append to `apps/api/src/db/lessons.ts`:

```typescript
/** Default and ceiling for one browsing page. */
export const BROWSE_DEFAULT_LIMIT = 50;
export const BROWSE_MAX_LIMIT = 200;

/**
 * A keyset cursor carries BOTH sort keys, because promoted_at alone is not
 * unique. Two lessons promoted in the same millisecond would make the boundary
 * ambiguous, and a page break landing between them either skips a lesson or
 * shows it twice.
 *
 * Opaque on purpose: the client echoes it back and never constructs one, so
 * the sort keys can change without becoming a breaking API change.
 */
export function encodeCursor(promotedAt: string, id: string): string {
	return btoa(`${promotedAt} ${id}`);
}

export function decodeCursor(
	cursor: string,
): { promotedAt: string; id: string } | null {
	try {
		const [promotedAt, id, ...rest] = atob(cursor).split(" ");
		if (!promotedAt || !id || rest.length > 0) return null;
		return { promotedAt, id };
	} catch {
		// atob throws on anything that is not base64. A client-supplied cursor
		// is untrusted input, and a malformed one is a 400, not a 500.
		return null;
	}
}

export interface LessonPage {
	lessons: unknown[];
	cursor: string | null;
	hasMore: boolean;
}

/**
 * One page of the pool, newest first.
 *
 * Ordered by (promoted_at, id) rather than promoted_at alone - see
 * encodeCursor. The matching index is lessons_user_promoted_at_idx.
 *
 * Fetches limit + 1 rows to learn whether another page exists without a second
 * COUNT query, then discards the extra.
 */
export async function listLessonsPage(
	db: D1Database,
	userId: string,
	opts: { statuses?: string[]; cursor?: string | null; limit: number },
): Promise<LessonPage> {
	const limit = Math.min(Math.max(1, opts.limit), BROWSE_MAX_LIMIT);
	const binds: unknown[] = [userId];
	let where = "user_id = ?";

	if (opts.statuses && opts.statuses.length > 0) {
		where += ` AND status IN (${opts.statuses.map(() => "?").join(", ")})`;
		binds.push(...opts.statuses);
	}

	if (opts.cursor) {
		const after = decodeCursor(opts.cursor);
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

/** Raised when a client sends a cursor this server did not mint. */
export class InvalidCursorError extends Error {
	constructor() {
		super("Invalid cursor");
		this.name = "InvalidCursorError";
	}
}

/**
 * One lesson, or null when it does not exist OR is not this user's.
 *
 * The caller cannot tell those apart, and that is the point: a 403 on someone
 * else's lesson would confirm the id exists. Same reasoning as transitionLesson.
 */
export async function getLessonForUser(
	db: D1Database,
	userId: string,
	id: string,
): Promise<unknown | null> {
	const stored = await getLessonById(db, id);
	if (!stored || stored.user_id !== userId) return null;
	return JSON.parse(stored.body) as unknown;
}
```

Note: `InvalidCursorError` is referenced above its declaration. Class declarations are hoisted in binding but not initialized — move the class above `listLessonsPage` if the runtime complains, and re-run.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @onlooker/api test src/db/lessons-browser.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Run the full API suite**

```bash
pnpm --filter @onlooker/api test
```

Expected: PASS. Nothing existing reads these functions, so the machine routes must be unaffected.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/lessons.ts apps/api/src/db/lessons-browser.test.ts
```

Then invoke `/commit`. Suggested message:

```text
feat(api): read the pool the way a person does, not a mirror :open_book:

The existing read is delta-shaped - a sequence cursor, every status,
built for a mirror draining a queue. Browsing wants the opposite: newest
first, filtered, paginated.

The cursor carries promoted_at AND id because promoted_at is not unique.
Two lessons promoted in the same millisecond would make a page boundary
ambiguous, and a break landing between them either skips one or shows it
twice.

Refs: onlooker-yj5
```

---

### Task 3: The three routes

**Files:**
- Create: `apps/api/src/routes/lessons-browser.ts`
- Create: `apps/api/src/routes/lessons-browser.test.ts`
- Modify: `apps/api/src/routes/index.ts`
- Modify: `apps/api/src/router.ts`

**Interfaces:**
- Consumes: `listLessonsPage`, `getLessonForUser`, `InvalidCursorError`, `BROWSE_DEFAULT_LIMIT`, `BROWSE_MAX_LIMIT` from Task 2; `transitionLesson` and `SequenceExhaustedError` from `../db/lessons.js`; `requireAuth` from `../middleware/auth.js`; `ApiError` from `../types`.
- Produces, for Task 4: three routes with these exact shapes.
  - `GET /api/lessons` → 200 `{ lessons: [], cursor: string | null, has_more: boolean }`
  - `GET /api/lessons/:id` → 200 the bare lesson body, or 404 `not_found`
  - `PATCH /api/lessons/:id/status` → 200 `{ id, seq }`, or 400 / 404

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/lessons-browser.test.ts`:

```typescript
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	BASE,
	lesson,
	mintMachine,
	push,
	resetLessonCounter,
} from "../test-support/lessons.js";

const db = () => env.DB;
let accessToken: string;
let machineToken: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM machine_tokens").run();
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM users").run();
	const minted = await mintMachine("browser@example.com");
	accessToken = minted.accessToken;
	machineToken = minted.token;
	resetLessonCounter();
});

const browse = (path: string, init: RequestInit = {}) =>
	SELF.fetch(`${BASE}${path}`, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
			...(init.headers ?? {}),
		},
	});

describe("GET /api/lessons", () => {
	it("rejects a request with no session", async () => {
		const response = await SELF.fetch(`${BASE}/api/lessons`);
		expect(response.status).toBe(401);
	});

	// The credential split, asserted. A machine token opens the sync routes and
	// must not open the browsing ones.
	it("rejects a machine token", async () => {
		const response = await SELF.fetch(`${BASE}/api/lessons`, {
			headers: { Authorization: `Bearer ${machineToken}` },
		});
		expect(response.status).toBe(401);
	});

	it("returns an empty pool as an empty list, not a 404", async () => {
		const response = await browse("/api/lessons");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			lessons: [],
			cursor: null,
			has_more: false,
		});
	});

	it("returns pushed lessons newest first", async () => {
		await push(machineToken, [
			lesson({ promoted_at: "2026-08-01T00:00:00.000Z" }),
			lesson({ promoted_at: "2026-08-03T00:00:00.000Z" }),
			lesson({ promoted_at: "2026-08-02T00:00:00.000Z" }),
		]);

		const body = (await (await browse("/api/lessons")).json()) as {
			lessons: Array<{ promoted_at: string }>;
		};

		expect(body.lessons.map((l) => l.promoted_at)).toEqual([
			"2026-08-03T00:00:00.000Z",
			"2026-08-02T00:00:00.000Z",
			"2026-08-01T00:00:00.000Z",
		]);
	});

	it("rejects a cursor it did not mint", async () => {
		const response = await browse("/api/lessons?cursor=not-a-real-cursor");
		expect(response.status).toBe(400);
		expect((await response.json()) as { error: string }).toMatchObject({
			error: "invalid_cursor",
		});
	});

	it("rejects a status nobody could hold", async () => {
		const response = await browse("/api/lessons?status=banana");
		expect(response.status).toBe(400);
	});

	it("clamps limit to the maximum rather than failing", async () => {
		const response = await browse("/api/lessons?limit=99999");
		expect(response.status).toBe(200);
	});
});

describe("GET /api/lessons/:id", () => {
	it("returns one lesson", async () => {
		const written = lesson();
		await push(machineToken, [written]);

		const response = await browse(`/api/lessons/${written.id}`);

		expect(response.status).toBe(200);
		expect((await response.json()) as { id: string }).toMatchObject({
			id: written.id,
		});
	});

	it("404s an id nobody holds", async () => {
		const response = await browse("/api/lessons/01NOPE00000000000000000000");
		expect(response.status).toBe(404);
	});

	// 404 rather than 403, so the response cannot confirm the id exists.
	it("404s another account's lesson", async () => {
		const written = lesson();
		await push(machineToken, [written]);
		const stranger = await mintMachine("stranger@example.com");

		const response = await SELF.fetch(`${BASE}/api/lessons/${written.id}`, {
			headers: { Authorization: `Bearer ${stranger.accessToken}` },
		});

		expect(response.status).toBe(404);
	});
});

describe("PATCH /api/lessons/:id/status", () => {
	const patch = (id: string, status: string) =>
		browse(`/api/lessons/${id}/status`, {
			method: "PATCH",
			body: JSON.stringify({ status }),
		});

	it("retracts a lesson and advances the feed", async () => {
		const written = lesson();
		await push(machineToken, [written]);

		const response = await patch(written.id, "retracted");

		expect(response.status).toBe(200);
		expect((await response.json()) as { seq: number }).toEqual({
			id: written.id,
			seq: 2,
		});
	});

	it("un-retracts a lesson", async () => {
		const written = lesson();
		await push(machineToken, [written]);
		await patch(written.id, "retracted");

		expect((await patch(written.id, "active")).status).toBe(200);
	});

	// The browser cannot assert a verdict the tribunal never reached. Enforced
	// here, not by which buttons the UI renders.
	it("refuses refuted and superseded", async () => {
		const written = lesson();
		await push(machineToken, [written]);

		for (const status of ["refuted", "superseded"]) {
			const response = await patch(written.id, status);
			expect(response.status).toBe(400);
			expect((await response.json()) as { error: string }).toMatchObject({
				error: "status_not_allowed",
			});
		}
	});

	it("404s another account's lesson", async () => {
		const written = lesson();
		await push(machineToken, [written]);
		const stranger = await mintMachine("stranger@example.com");

		const response = await SELF.fetch(
			`${BASE}/api/lessons/${written.id}/status`,
			{
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${stranger.accessToken}`,
				},
				body: JSON.stringify({ status: "retracted" }),
			},
		);

		expect(response.status).toBe(404);
	});

	// A retraction made in the browser must reach every mirror on its next
	// delta pull - that is why it goes through transitionLesson rather than
	// writing the row directly.
	it("is visible to the machine delta read", async () => {
		const written = lesson();
		await push(machineToken, [written]);
		await patch(written.id, "retracted");

		const delta = (await (
			await SELF.fetch(`${BASE}/lessons?since=1`, {
				headers: { Authorization: `Bearer ${machineToken}` },
			})
		).json()) as { lessons: Array<{ status: string }> };

		expect(delta.lessons.at(-1)?.status).toBe("retracted");
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @onlooker/api test src/routes/lessons-browser.test.ts
```

Expected: FAIL — the routes are not registered, so every case gets a 404 from the router rather than its expected status.

- [ ] **Step 3: Write the handlers**

Create `apps/api/src/routes/lessons-browser.ts`:

```typescript
import {
	BROWSE_DEFAULT_LIMIT,
	getLessonForUser,
	InvalidCursorError,
	listLessonsPage,
	SequenceExhaustedError,
	transitionLesson,
} from "../db/lessons.js";
import { requireAuth } from "../middleware/auth.js";
import type { RouteParams, WorkerEnv } from "../types";
import { ApiError } from "../types";

/**
 * Browsing is a separate surface from sync, on purpose.
 *
 * GET /lessons is machine-authenticated and delta-shaped: a sequence cursor,
 * every status, built for a mirror draining a queue. These routes are the
 * opposite read, and they are kept apart so a change made for a person cannot
 * break a mirror mid-drain. See the design's Section 3.
 */

/** Every status a lesson may hold, for validating ?status. */
const KNOWN_STATUSES = new Set([
	"active",
	"refuted",
	"superseded",
	"retracted",
]);

/**
 * What a human may assert from a browser, and nothing else.
 *
 * `refuted` belongs to the counter-observation path that produces it - a click
 * is not evidence. `superseded` must name the lesson that replaced it, and the
 * browser has no authoring, so a human choosing it would be asserting a
 * relationship the tribunal never judged.
 */
const BROWSER_TRANSITIONS = new Set(["active", "retracted"]);

export async function handleBrowseLessons(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const { userId } = await requireAuth(request, env);
	const url = new URL(request.url);

	const statuses = url.searchParams.getAll("status");
	for (const status of statuses) {
		if (!KNOWN_STATUSES.has(status)) {
			throw new ApiError(
				400,
				"invalid_status",
				`status must be one of ${[...KNOWN_STATUSES].join(", ")}`,
			);
		}
	}

	// Clamped rather than rejected: a client asking for more than the ceiling
	// wants as much as it can get, and failing the request serves nobody.
	const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
	const limit = Number.isNaN(requested) ? BROWSE_DEFAULT_LIMIT : requested;

	try {
		const page = await listLessonsPage(env.DB, userId, {
			statuses,
			cursor: url.searchParams.get("cursor"),
			limit,
		});
		return Response.json({
			lessons: page.lessons,
			cursor: page.cursor,
			has_more: page.hasMore,
		});
	} catch (error) {
		if (error instanceof InvalidCursorError) {
			throw new ApiError(
				400,
				"invalid_cursor",
				"That cursor was not issued by this server; start from the first page",
			);
		}
		throw error;
	}
}

export async function handleGetLesson(
	request: Request,
	env: WorkerEnv,
	params: RouteParams,
): Promise<Response> {
	const { userId } = await requireAuth(request, env);
	const found = await getLessonForUser(env.DB, userId, params.id);
	if (!found) throw new ApiError(404, "not_found", "No such lesson");
	return Response.json(found);
}

export async function handleBrowserTransition(
	request: Request,
	env: WorkerEnv,
	params: RouteParams,
): Promise<Response> {
	const { userId } = await requireAuth(request, env);
	const body = (await request.json()) as { status?: unknown };
	const status = typeof body.status === "string" ? body.status : "";

	if (!BROWSER_TRANSITIONS.has(status)) {
		throw new ApiError(
			400,
			"status_not_allowed",
			"A lesson may be retracted or made active again from here. " +
				"'refuted' belongs to the counter-observation that produced it, " +
				"and 'superseded' must name the lesson that replaced it.",
		);
	}

	let seq: number | null;
	try {
		// The same transition the machine route makes, so it appends to
		// lesson_feed and reaches every mirror on its next delta pull.
		seq = await transitionLesson(env.DB, userId, params.id, status, null);
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
	return Response.json({ id: params.id, seq });
}
```

- [ ] **Step 4: Export and register the routes**

In `apps/api/src/routes/index.ts`, add beside the existing lessons export:

```typescript
export {
	handleBrowseLessons,
	handleBrowserTransition,
	handleGetLesson,
} from "./lessons-browser";
```

In `apps/api/src/router.ts`, add the three handlers to the existing import from `./routes`, then add a new section to the route table **after** the machine lessons block:

```typescript
	// =========================================================================
	// Lessons (browsing - session-authenticated, separate from the sync routes
	// above on purpose; see routes/lessons-browser.ts)
	// =========================================================================
	{
		method: "GET",
		path: "/api/lessons",
		handler: handleBrowseLessons,
	},
	{
		method: "GET",
		path: "/api/lessons/:id",
		handler: handleGetLesson,
	},
	{
		method: "PATCH",
		path: "/api/lessons/:id/status",
		handler: handleBrowserTransition,
	},
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @onlooker/api test src/routes/lessons-browser.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the full API suite**

```bash
pnpm --filter @onlooker/api test
```

Expected: PASS. Pay attention to `src/router.test.ts` — adding routes to the table must not change how existing paths match.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/lessons-browser.ts \
        apps/api/src/routes/lessons-browser.test.ts \
        apps/api/src/routes/index.ts apps/api/src/router.ts
```

Then invoke `/commit`. Suggested message:

```text
feat(api): let a person read and retract from the pool :eyes:

Three session-authenticated routes over the lesson pool. The sync routes
are untouched: a mirror draining a queue and a human reading a page want
opposite things, and keeping them apart is what stops a browsing change
from breaking a drain.

A retraction here goes through the same transitionLesson the machine
route uses, so it appends to lesson_feed and reaches every mirror on the
next delta pull. Only active and retracted are accepted, and that is
enforced in the handler rather than by which buttons the UI renders.

Refs: onlooker-yj5
```

---

### Task 4: Contract cases and the web mock

**Files:**
- Modify: `packages/api-contract/src/index.ts`
- Modify: `apps/web/src/api/mockApi.ts`

**Interfaces:**
- Consumes: the three route shapes from Task 3.
- Produces: contract cases that both `apps/api/src/contract.test.ts` and `apps/web/src/api/api-contract.test.ts` run.

**Why these cases are seed-free.** `ContractFixture` describes accounts, not lessons: the mock ships seeded and `apps/api` starts against an empty D1. Neither side can be asked to produce "a lesson that exists" without growing a seeding hook on both. So the contract pins what needs no fixture — the **response envelope** of an empty pool, and the **error shapes** — which is exactly the class of bug it exists to catch. The blanked-dashboard incident was a shape bug at 200, not a status code. Pagination, ordering, filtering and ownership are covered by Task 3's tests against real D1, which can seed.

- [ ] **Step 1: Add the contract cases**

In `packages/api-contract/src/index.ts`, add to the array returned by `authenticatedCases`, before its closing bracket:

```typescript
		{
			name: "lesson pool, empty",
			path: "/api/lessons",
			init: { method: "GET" },
			status: 200,
			// Bare, and `lessons` is an array even when there is nothing in it.
			// An empty pool is not a 404 and not a null - the two-pane UI
			// renders an empty state from this, and a missing key throws.
			body: {
				lessons: expectArray,
				has_more: false,
			},
			forbidden: NO_SECRETS,
		},
		{
			name: "lesson pool, filtered and limited",
			path: "/api/lessons?status=active&limit=10",
			init: { method: "GET" },
			status: 200,
			// The query string is the point of this case, not the filter. The
			// mock matches on a path that still carries `?...`, so an equality
			// check there passes the case above and fails every real call the
			// app makes. One case with parameters is what keeps the two
			// implementations honest about parsing them at all.
			body: {
				lessons: expectArray,
				has_more: false,
			},
			forbidden: NO_SECRETS,
		},
		{
			name: "lesson that nobody holds",
			path: "/api/lessons/01NOPE00000000000000000000",
			init: { method: "GET" },
			status: 404,
			forbidden: NO_SECRETS,
		},
		{
			name: "transition to a status the browser may not assert",
			path: "/api/lessons/01NOPE00000000000000000000/status",
			init: {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "refuted" }),
			},
			// 400 and not 404: the status is rejected before the lesson is
			// looked up, so this holds without either side seeding a lesson.
			status: 400,
			forbidden: NO_SECRETS,
		},
```

- [ ] **Step 2: Run the API contract test to verify it fails on the mock side only**

```bash
pnpm --filter @onlooker/api test src/contract.test.ts
```

Expected: PASS — `apps/api` already implements these from Task 3.

```bash
pnpm --filter @onlooker/web test src/api/api-contract.test.ts
```

Expected: FAIL — the mock has no `/api/lessons` branch, so it does not answer these.

- [ ] **Step 3: Add the mock branches**

In `apps/web/src/api/mockApi.ts`, inside `mockDataApi`, before its final fallthrough:

```typescript
	// The hosted pool, mocked. The mock has no lessons and no way to acquire
	// any - lessons arrive by machine-authenticated push, which a browser
	// cannot make - so this is permanently the empty-pool case. That is enough
	// for the contract, which pins the envelope shape rather than contents.
	//
	// Matched on the pathname alone. `path` here still carries the search
	// string - toHandlerPath returns `pathname + search`, because the
	// reset-link handler reads its token straight out of it - so an equality
	// check against "/api/lessons" would stop matching the moment the app
	// asked for ?limit= or ?status=, which is every real call it makes.
	const poolPath = path.split("?")[0];

	if (poolPath === "/api/lessons" && (options.method ?? "GET") === "GET") {
		requireAuth(options);
		return json({ lessons: [], cursor: null, has_more: false });
	}

	if (
		poolPath.startsWith("/api/lessons/") &&
		poolPath.endsWith("/status") &&
		options.method === "PATCH"
	) {
		requireAuth(options);
		const { status } = JSON.parse(String(options.body ?? "{}")) as {
			status?: unknown;
		};
		if (status !== "active" && status !== "retracted") {
			throw new AuthApiError(
				400,
				"status_not_allowed",
				"A lesson may be retracted or made active again from here.",
			);
		}
		// The pool is always empty here, so any id is one nobody holds.
		throw new AuthApiError(404, "not_found", "No such lesson");
	}

	if (
		poolPath.startsWith("/api/lessons/") &&
		(options.method ?? "GET") === "GET"
	) {
		requireAuth(options);
		throw new AuthApiError(404, "not_found", "No such lesson");
	}
```

`AuthApiError` is already imported at `mockApi.ts:1` from `@onlooker/auth-react`, and `requireAuth` (`mockApi.ts:218`) and `json` (`mockApi.ts:440`) are local to this file — add no imports.

Order matters: the `/status` branch must come before the generic `GET /api/lessons/` branch, or a status PATCH would fall through to the single-lesson handler.

- [ ] **Step 4: Run both contract runners**

```bash
pnpm --filter @onlooker/web test src/api/api-contract.test.ts
pnpm --filter @onlooker/api test src/contract.test.ts
```

Expected: both PASS. This is the point of the exercise — one table, two implementations, neither allowed to drift.

- [ ] **Step 5: Commit**

```bash
git add packages/api-contract/src/index.ts apps/web/src/api/mockApi.ts
```

Then invoke `/commit`. Suggested message:

```text
test(contract): pin the pool's envelope on both implementations :handshake:

The mock and the real API drifted twice before, and both times it was a
shape at 200 rather than a status code - which is why body carries as
much weight as status in this table.

Cases are seed-free by necessity: the fixture describes accounts, not
lessons, and neither side can conjure "a lesson that exists" without a
seeding hook on both. So this pins the empty-pool envelope and the error
shapes; ordering, filtering and ownership are covered against real D1.

Refs: onlooker-yj5
```

---

### Task 5: Verify the workspace and open the PR

**Files:** none.

- [ ] **Step 1: Run every gate**

```bash
pnpm test && pnpm lint && pnpm typecheck && pnpm build
```

Expected: all pass, all exit 0. Report the actual output — do not claim green without it.

Note: `apps/api/src/middleware/auth.ts` emits two `useOptionalChain` **warnings**. They are pre-existing, tracked as `onlooker-xl2`, and do not fail the gate. Do not fix them here.

- [ ] **Step 2: Confirm the snapshot is not stale**

```bash
pnpm --filter @onlooker/db build && pnpm --filter @onlooker/db generate:expected-schema
git diff --exit-code packages/db/src/expected-schema.ts
```

Expected: exit 0, no diff.

- [ ] **Step 3: Confirm the machine routes were not touched**

```bash
git diff main..HEAD -- apps/api/src/routes/lessons.ts
```

Expected: **empty.** This is the Global Constraint, checked mechanically rather than trusted. Task 2 modifies `db/lessons.ts` (appending functions), which is a different file — that one will show a diff, and it should contain only additions.

- [ ] **Step 4: Open the PR**

Invoke the `/pr` skill. Flag for reviewers: migration 0005 rebuilds an index on merge; the `PATCH`/`POST` asymmetry with the machine transition route is deliberate and explained in the plan; and the contract cases are seed-free by necessity, with the reasoning in Task 4.

- [ ] **Step 5: Close the bead once merged**

```bash
bd close onlooker-yj5 --reason "Three browser routes, contract cases and mock branches landed in <PR>."
```

---

## Notes on what this plan deliberately does not do

**No stack filtering.** `applies_to.stack` is an array inside the JSON body; filtering it needs `json_each` and a derived index. Tracked as `onlooker-4bw`. Filtering client-side is not a smaller version of it — it filters one loaded page and calls it the pool.

**No `superseded_by` handling on the browser transition.** `transitionLesson` is called with `null` for it, which is correct: the browser cannot set `superseded`, so it can never have a replacement to name.

**No heartbeat coverage.** `GET /api/lessons` is a safe read to add to the synthetic heartbeat, and it is tracked as `onlooker-mkp` to keep this PR to one concern.

**The mock cannot hold lessons, and that is not a gap to fix here.** Lessons arrive by machine-authenticated push, which a browser cannot make. Giving the mock a seeded pool would mean inventing a shape the real API never produces through the same door. When `onlooker-yfw` needs populated states for the two-pane UI, it should seed through the mock's own state rather than through the contract.
