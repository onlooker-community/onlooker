# Lesson Activity Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface `lesson_feed` — written on every lesson create and status change, read today only by the CLI's delta sync — as a read-only `/activity` screen showing what happened, newest first, grouped by day.

**Architecture:** Four tasks, bottom-up. The paginated query lands first with its own tests, then the HTTP route over it, then the contract entry that pins the response shape, then the screen. Each task ends green and committable.

**Tech Stack:** Cloudflare Workers + D1 (`apps/api`), React 19 + React Router 7 (`apps/web`), Vitest, Biome, Drizzle schema in `packages/db`.

**Spec:** `docs/superpowers/specs/2026-08-31-lesson-activity-screen-design.md`
**Bead:** `onlooker-6w8`

## Global Constraints

- **Edit tracked files with `Edit`/`Write`/`MultiEdit`, never the shell.** Required by `CLAUDE.md`; `lineage` and `inspector` observe tool calls, not filesystem changes, so a `sed`/heredoc edit is invisible to them.
- **American English** in all comments, identifiers, and copy.
- Commands run from the workspace they touch. API: `cd apps/api && ../../node_modules/.bin/vitest run`. Web: `cd apps/web && ../../node_modules/.bin/vitest run`. Whole repo: `pnpm test`, `pnpm typecheck`, `pnpm lint` from the root.
- CI now runs `pnpm lint` and `pnpm typecheck` over **every** workspace (11 typecheck tasks, 12 lint). A type error anywhere fails the build.
- `biome check` reports 9 pre-existing warnings, all in `apps/web/src/api/mockApi.test.ts`. Not yours. Do not fix them; do not add new ones.
- Commit per task through the `/commit` skill. Conventional format `<type>(<scope>): <subject> :emoji:`, subject ≤72 chars including the emoji, WHY-focused body, ending with exactly:
  `Claude-Session: https://claude.ai/code/session_01F3rzr7tFciRRT3xK2qqXAo`
- Do NOT push, open PRs, or close beads. The controller handles those.
- **Never widen what the query returns.** `lesson_feed` is per-user. Every query in this plan filters on `user_id`, and the user-isolation test is the one that must not be weakened.

---

### Task 1: The paginated activity query

`lesson_feed` has no reader outside the CLI's delta path. This adds a browser-shaped read of it, beside the browse query it mirrors.

**Files:**
- Modify: `apps/api/src/db/lessons.ts` (add beside `listLessonsPage`, around line 413)
- Test: `apps/api/src/db/activity.test.ts` (create)

**Interfaces:**
- Consumes: `BROWSE_DEFAULT_LIMIT` (50) and `BROWSE_MAX_LIMIT`, both already exported from `apps/api/src/db/lessons.ts`; `InvalidCursorError`, already exported from the same file.
- Produces, relied on by Tasks 2 and 4:
  - `encodeSeqCursor(seq: number): string`
  - `decodeSeqCursor(cursor: string): number | null`
  - `interface ActivityEvent { seq: number; kind: string; at: string; lesson_id: string; claim: string; applies_to: unknown; status: string }`
  - `interface ActivityPage { events: ActivityEvent[]; cursor: string | null; hasMore: boolean }`
  - `listActivityPage(db: D1Database, userId: string, opts: { cursor?: string | null; limit: number }): Promise<ActivityPage>`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/db/activity.test.ts`. Read the top 20 lines of `apps/api/src/db/lessons.test.ts` first and copy its imports and its D1 test-harness setup verbatim — the same `db()` helper and the same `beforeEach` truncation, adding `DELETE FROM lesson_feed`.

```ts
import { describe, expect, it } from "vitest";
import {
	decodeSeqCursor,
	encodeSeqCursor,
	listActivityPage,
} from "./lessons.js";

// A lesson row plus a feed row, so the join has something to join to. The feed
// stores no claim - it lives in the lesson's body - which is why every one of
// these seeds both.
async function seed(
	userId: string,
	lessonId: string,
	seq: number,
	kind: string,
	at: string,
	claim: string,
) {
	await db()
		.prepare(
			`INSERT OR IGNORE INTO lessons
			 (id, user_id, visibility, status, schema_version, body, promoted_at, created_at, updated_at)
			 VALUES (?, ?, 'private', 'active', 1, ?, ?, ?, ?)`,
		)
		.bind(
			lessonId,
			userId,
			JSON.stringify({ id: lessonId, claim, applies_to: { stack: [] } }),
			at,
			at,
			at,
		)
		.run();
	await db()
		.prepare(
			`INSERT INTO lesson_feed (seq, user_id, lesson_id, kind, at)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(seq, userId, lessonId, kind, at)
		.run();
}

describe("listActivityPage", () => {
	// The reason this orders by seq and not at. `at` defaults to
	// CURRENT_TIMESTAMP, so two events written in the same second carry the
	// same timestamp - and a tie in the sort key is how cursor pagination
	// silently drops or repeats a row across a page boundary.
	it("orders by seq when two events share a timestamp", async () => {
		const t = "2026-08-31T10:00:00Z";
		await seed("u1", "l1", 1, "create", t, "first");
		await seed("u1", "l2", 2, "create", t, "second");
		await seed("u1", "l3", 3, "status", t, "third");

		const page = await listActivityPage(db(), "u1", { limit: 50 });
		expect(page.events.map((e) => e.seq)).toEqual([3, 2, 1]);
	});

	// The security boundary. lesson_feed is per-user and the join is where a
	// missing predicate would hand one account another account's claims.
	it("never returns another user's events", async () => {
		await seed("u1", "l1", 1, "create", "2026-08-31T10:00:00Z", "mine");
		await seed("u2", "l2", 1, "create", "2026-08-31T10:00:00Z", "theirs");

		const page = await listActivityPage(db(), "u1", { limit: 50 });
		expect(page.events).toHaveLength(1);
		expect(page.events[0].claim).toBe("mine");
	});

	it("pages through with a cursor without dropping or repeating a row", async () => {
		for (let i = 1; i <= 5; i++) {
			await seed("u1", `l${i}`, i, "create", "2026-08-31T10:00:00Z", `c${i}`);
		}

		const first = await listActivityPage(db(), "u1", { limit: 2 });
		expect(first.events.map((e) => e.seq)).toEqual([5, 4]);
		expect(first.hasMore).toBe(true);

		const second = await listActivityPage(db(), "u1", {
			cursor: first.cursor,
			limit: 2,
		});
		expect(second.events.map((e) => e.seq)).toEqual([3, 2]);

		const third = await listActivityPage(db(), "u1", {
			cursor: second.cursor,
			limit: 2,
		});
		expect(third.events.map((e) => e.seq)).toEqual([1]);
		expect(third.hasMore).toBe(false);
		expect(third.cursor).toBeNull();
	});

	it("carries the lesson's claim and status onto the event", async () => {
		await seed("u1", "l1", 1, "status", "2026-08-31T10:00:00Z", "a claim");
		const page = await listActivityPage(db(), "u1", { limit: 50 });
		expect(page.events[0].claim).toBe("a claim");
		expect(page.events[0].kind).toBe("status");
		expect(page.events[0].lesson_id).toBe("l1");
	});
});

describe("seq cursors", () => {
	it("round-trips a sequence", () => {
		expect(decodeSeqCursor(encodeSeqCursor(42))).toBe(42);
	});

	// A client-supplied cursor is untrusted input. Malformed is a 400 upstream,
	// which needs null here rather than a throw.
	it("returns null for anything it did not issue", () => {
		expect(decodeSeqCursor("not-base64!!")).toBeNull();
		expect(decodeSeqCursor(btoa("not a number"))).toBeNull();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && ../../node_modules/.bin/vitest run src/db/activity.test.ts`

Expected: FAIL — the import of `listActivityPage`, `encodeSeqCursor` and `decodeSeqCursor` cannot resolve, because none exist yet.

- [ ] **Step 3: Implement the cursor helpers and the query**

Add to `apps/api/src/db/lessons.ts`, directly after `decodeCursor` (which ends around line 390). Mirror the existing helpers' base64 style so a cursor stays opaque to clients:

```ts
/**
 * Activity cursors carry a sequence, not a (timestamp, id) pair.
 *
 * `lesson_feed.seq` is unique per user by index — `lesson_feed_user_seq_idx`
 * on (user_id, seq) — so one value totally orders a user's feed and needs no
 * tiebreaker. Base64 for the same reason the lesson cursor uses it: a client
 * should not read a cursor as a number and start doing arithmetic on it.
 */
export function encodeSeqCursor(seq: number): string {
	return btoa(String(seq));
}

export function decodeSeqCursor(cursor: string): number | null {
	try {
		const seq = Number.parseInt(atob(cursor), 10);
		return Number.isFinite(seq) ? seq : null;
	} catch {
		// atob throws on anything that is not base64. A client-supplied cursor
		// is untrusted input, and a malformed one is a 400, not a 500.
		return null;
	}
}

/** One lesson event, joined to the lesson it happened to. */
export interface ActivityEvent {
	seq: number;
	kind: string;
	at: string;
	lesson_id: string;
	claim: string;
	applies_to: unknown;
	status: string;
}

export interface ActivityPage {
	events: ActivityEvent[];
	cursor: string | null;
	hasMore: boolean;
}

/**
 * One page of a user's lesson activity, newest first.
 *
 * Ordered by seq DESC rather than at DESC. `at` defaults to CURRENT_TIMESTAMP,
 * so two events written in the same second tie — and a tie in the sort key is
 * how cursor pagination drops or repeats rows across a page boundary.
 *
 * The claim lives in the lesson's body rather than a column, so this joins and
 * parses rather than selecting a title that does not exist.
 */
export async function listActivityPage(
	db: D1Database,
	userId: string,
	opts: { cursor?: string | null; limit: number },
): Promise<ActivityPage> {
	const limit = Math.min(Math.max(1, opts.limit), BROWSE_MAX_LIMIT);
	const binds: unknown[] = [userId];
	let where = "f.user_id = ?";

	if (opts.cursor) {
		const after = decodeSeqCursor(opts.cursor);
		if (after === null) throw new InvalidCursorError();
		where += " AND f.seq < ?";
		binds.push(after);
	}

	binds.push(limit + 1);

	const { results } = await db
		.prepare(
			`SELECT f.seq, f.kind, f.at, f.lesson_id, l.body, l.status
			 FROM lesson_feed f
			 JOIN lessons l ON l.id = f.lesson_id
			 WHERE ${where}
			 ORDER BY f.seq DESC
			 LIMIT ?`,
		)
		.bind(...binds)
		.all<{
			seq: number;
			kind: string;
			at: string;
			lesson_id: string;
			body: string;
			status: string;
		}>();

	const rows = results ?? [];
	const hasMore = rows.length > limit;
	const events = (hasMore ? rows.slice(0, limit) : rows).map((r) => {
		const body = JSON.parse(r.body) as {
			claim?: string;
			applies_to?: unknown;
		};
		return {
			seq: r.seq,
			kind: r.kind,
			at: r.at,
			lesson_id: r.lesson_id,
			claim: body.claim ?? "",
			applies_to: body.applies_to ?? null,
			status: r.status,
		};
	});

	const last = events.at(-1);
	const cursor = hasMore && last ? encodeSeqCursor(last.seq) : null;

	// Asserted rather than trusted, for the same reason listLessonsPage asserts
	// it: hasMore, the clamped limit and the cursor are three separate facts,
	// and a change to any one of them would silently hide the tail of the feed.
	if (hasMore && cursor === null) {
		throw new Error(
			"listActivityPage: has_more is true with no cursor; the tail would be unreachable",
		);
	}

	return { events, cursor, hasMore };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && ../../node_modules/.bin/vitest run src/db/activity.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Run the API suite, typecheck and lint**

```bash
cd apps/api && ../../node_modules/.bin/vitest run
cd ../.. && pnpm typecheck && pnpm lint
```
Expected: all pass. `listLessonsPage`'s own tests must be unchanged — the new code is additive to the same file.

- [ ] **Step 6: Commit**

`/commit` with `apps/api/src/db/lessons.ts` and `apps/api/src/db/activity.test.ts`. The body should say why the order key is `seq` and not `at`.

---

### Task 2: The HTTP route

**Files:**
- Create: `apps/api/src/routes/activity.ts`
- Modify: `apps/api/src/router.ts` (the data-routes section, near the `/api/lessons` entries around line 198)
- Test: `apps/api/src/routes/activity.test.ts`

**Interfaces:**
- Consumes from Task 1: `listActivityPage`, `InvalidCursorError`, `BROWSE_DEFAULT_LIMIT` from `../db/lessons.js`.
- Produces, relied on by Tasks 3 and 4: `GET /api/activity`, responding `200` with `{ events: ActivityEvent[], cursor: string | null, has_more: boolean }`. Note `has_more` is snake_case in the response body while `hasMore` is camelCase inside `ActivityPage` — that split already exists in `handleBrowseLessons` and this matches it.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/activity.test.ts`. Read the first 25 lines of `apps/api/src/routes/lessons-browser.test.ts` and copy its request/auth harness verbatim — how it builds an authenticated `Request` and how it truncates tables in `beforeEach`, adding `DELETE FROM lesson_feed`.

```ts
import { describe, expect, it } from "vitest";
import { handleActivity } from "./activity.js";

describe("GET /api/activity", () => {
	it("rejects an unauthenticated request", async () => {
		await expect(
			handleActivity(new Request("https://x/api/activity"), env()),
		).rejects.toMatchObject({ status: 401 });
	});

	it("returns the caller's events newest first", async () => {
		await seedFeed("u1", "l1", 1, "create", "a claim");
		await seedFeed("u1", "l2", 2, "status", "another");

		const res = await handleActivity(authed("u1", "/api/activity"), env());
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			events: { seq: number }[];
			cursor: string | null;
			has_more: boolean;
		};
		expect(body.events.map((e) => e.seq)).toEqual([2, 1]);
		expect(body.has_more).toBe(false);
		expect(body.cursor).toBeNull();
	});

	// A cursor this server did not issue is client error, not server error.
	// Without this it surfaces as a 500 and reads like an outage.
	it("answers 400 for a cursor it did not issue", async () => {
		await expect(
			handleActivity(authed("u1", "/api/activity?cursor=nonsense!!"), env()),
		).rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && ../../node_modules/.bin/vitest run src/routes/activity.test.ts`
Expected: FAIL — `./activity.js` does not exist.

- [ ] **Step 3: Write the handler**

Create `apps/api/src/routes/activity.ts`:

```ts
import {
	BROWSE_DEFAULT_LIMIT,
	InvalidCursorError,
	listActivityPage,
} from "../db/lessons.js";
import { requireAuth } from "../middleware/auth.js";
import type { WorkerEnv } from "../types";
import { ApiError } from "../types";

/**
 * GET /api/activity
 *
 * Session-authenticated, under /api with the other browser reads — not beside
 * the machine-authenticated /lessons sync routes, which read the same feed for
 * a different consumer. Keeping them apart is what stops a change made for a
 * person breaking a mirror mid-drain.
 */
export async function handleActivity(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const { userId } = await requireAuth(request, env);
	const url = new URL(request.url);

	// Clamped rather than rejected, matching handleBrowseLessons: a client
	// asking for more than the ceiling wants as much as it can get, and failing
	// the request serves nobody.
	const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
	const limit = Number.isNaN(requested) ? BROWSE_DEFAULT_LIMIT : requested;

	try {
		const page = await listActivityPage(env.DB, userId, {
			cursor: url.searchParams.get("cursor"),
			limit,
		});
		return Response.json({
			events: page.events,
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
```

- [ ] **Step 4: Register the route**

In `apps/api/src/router.ts`, add beside the other `/api/lessons` browsing entries (around line 198). Match the surrounding entries' exact field order and import style — read lines 190–215 before editing:

```ts
	{
		method: "GET",
		path: "/api/activity",
		handler: handleActivity,
	},
```

Add the import at the top with the other route imports.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && ../../node_modules/.bin/vitest run src/routes/activity.test.ts`
Expected: PASS, all three.

- [ ] **Step 6: Run the API suite, typecheck and lint**

```bash
cd apps/api && ../../node_modules/.bin/vitest run
cd ../.. && pnpm typecheck && pnpm lint
```
Expected: all pass. Router tests that assert the route table's contents may need the new entry added — if one fails counting routes, update the count; do not delete the assertion.

- [ ] **Step 7: Commit**

`/commit` with `apps/api/src/routes/activity.ts`, `apps/api/src/routes/activity.test.ts`, `apps/api/src/router.ts`.

---

### Task 3: The contract cases

`packages/api-contract` is how a response-shape change fails a test instead of surprising the browser. The new endpoint should be pinned there like every other one.

**There is no version to bump, and no release gate here.** An earlier draft of this plan said CI's `contract-version` job required one. It does not: that job guards `packages/lesson-contract/schema/` and compares `packages/lesson-contract/package.json`'s version — the published package describing a *lesson's* shape. `packages/api-contract` is an internal test-fixture library with no version field. This task adds test coverage, nothing more.

**This task is not red-green, and pretending otherwise would be dishonest.** The endpoint already works — Task 2 built and tested it. Registering a contract case adds regression coverage for existing behavior, so it passes on first run. That is the same shape as a characterization test, and the honest RED here is different: it is confirming the runners do **not** currently exercise `/api/activity`, then confirming they do.

**Where the coverage actually comes from.** `packages/api-contract/src/index.test.ts` tests only `shapeFailures` — the matcher machinery — and is not where cases are asserted. The cases are consumed by two runners that execute every one of them against a live handler: `apps/api/src/contract.test.ts:75,128` and `apps/web/src/api/api-contract.test.ts`. Adding a case to `anonymousCases()` or `authenticatedCases()` makes both runners cover the endpoint automatically. **Do not add a meta-test asserting the case exists in the array** — that tests a literal, and the runner is the real gate.

**Files:**
- Modify: `packages/api-contract/src/index.ts` — `anonymousCases()` (starts line 109) and `authenticatedCases()` (starts line 360)

**Interfaces:**
- Consumes from Task 2: `GET /api/activity`, `200` with `{ events, cursor, has_more }`, and `401` when unauthenticated.
- Produces: nothing later tasks import.

- [ ] **Step 1: Confirm the runners do not cover the endpoint yet**

Run: `cd apps/api && ../../node_modules/.bin/vitest run src/contract.test.ts 2>&1 | grep -c activity`

Expected: `0`. No test name mentions activity, because no case names that path. This is your baseline — the two cases you add should make this number rise.

- [ ] **Step 2: Add the unauthenticated case**

In `anonymousCases()`, beside the existing `"users/me, no token"` case (around line 156), which is the closest analogue:

```ts
		{
			name: "activity, no token",
			path: "/api/activity",
			init: { method: "GET" },
			status: 401,
		},
```

- [ ] **Step 3: Add the authenticated case**

In `authenticatedCases()`, modeled on the `/api/lessons` GET case (around line 395). Read that case in full first and mirror its use of `expectObject` / `expectArray` / `expectString`. The shape to pin: `events` is an array that is present even when empty, `cursor` is nullable, `has_more` is a boolean.

Give it a comment saying why `events` must be an array rather than absent — the screen renders an empty state from an empty array, and a missing key throws. That is the same reason the `/api/lessons` case gives.

- [ ] **Step 4: Confirm the runners now cover it**

Run: `cd apps/api && ../../node_modules/.bin/vitest run src/contract.test.ts 2>&1 | grep -c activity`

Expected: greater than 0, where Step 1 gave 0. The runner names each case in its test title, so the new cases appear by name — that is the coverage this task exists to add, and it is now demonstrable rather than assumed.

- [ ] **Step 5: Run the whole repo**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Expected: all pass. Both runners — `apps/api/src/contract.test.ts` and `apps/web/src/api/api-contract.test.ts` — now execute your cases against real handlers. **If either fails, the endpoint disagrees with the case you wrote.** Check the endpoint first: the case describes what Task 2 promised, and a mismatch means one of them is wrong. Do not loosen the case to make it pass without establishing which.

- [ ] **Step 6: Commit**

`/commit` with `packages/api-contract/src/index.ts`.

---

### Task 4: The screen

**Files:**
- Create: `apps/web/src/pages/ActivityPage.tsx`
- Modify: `apps/web/src/App.tsx` (add the `/activity` route)
- Modify: `apps/web/src/components/AppShell.tsx` (the `SECTIONS` array, around line 26)
- Test: `apps/web/src/__tests__/activity-page.test.tsx`

**Interfaces:**
- Consumes from Task 2: `GET /api/activity` returning `{ events, cursor, has_more }`, each event `{ seq, kind, at, lesson_id, claim, applies_to, status }`.
- Consumes existing: `useAuthenticatedFetch` from `../hooks/useAuthenticatedFetch`; `Panel` and `EmptyState` from `../components/ui`; `AppShell` from `../components/AppShell`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/__tests__/activity-page.test.tsx`. Read `apps/web/src/__tests__/account-routes-in-shell.test.tsx` first and copy its `../auth` mock and `renderAppAt` helper verbatim — it already renders the real `App` at a route with auth stubbed.

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({
			user: { id: "u1", email: "someone@example.com", name: "Someone" },
			loading: false,
			logout: vi.fn(),
			refresh: vi.fn(),
			sessionExpiresAt: null,
			sessionExpiringSoon: false,
		}),
		RequireAuth: ({ children }: { children: React.ReactNode }) => children,
	},
}));

const fetchState = {
	data: {
		events: [
			{
				seq: 2,
				kind: "status",
				at: "2026-08-31T14:00:00Z",
				lesson_id: "l2",
				claim: "Pin vitest and vite to compatible majors",
				applies_to: null,
				status: "retracted",
			},
			{
				seq: 1,
				kind: "create",
				at: "2026-08-30T09:00:00Z",
				lesson_id: "l1",
				claim: "Prefer explicit imports",
				applies_to: null,
				status: "active",
			},
		],
		cursor: null,
		has_more: false,
	} as unknown,
	loading: false,
	error: null as string | null,
};

vi.mock("../hooks/useAuthenticatedFetch", () => ({
	useAuthenticatedFetch: () => ({ ...fetchState, refetch: vi.fn() }),
}));

const { default: App } = await import("../App");

function renderAppAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<App />
		</MemoryRouter>,
	);
}

describe("/activity", () => {
	it("renders inside the shell", () => {
		renderAppAt("/activity");
		expect(
			screen.getByRole("link", { name: /lessons/i }).getAttribute("href"),
		).toBe("/lessons");
	});

	it("shows each event's claim", () => {
		renderAppAt("/activity");
		expect(screen.getByText(/pin vitest and vite/i)).toBeDefined();
		expect(screen.getByText(/prefer explicit imports/i)).toBeDefined();
	});

	// Two events on different days must not collapse into one heading. The
	// grouping is the screen's whole organizing idea.
	it("groups events under a heading per day", () => {
		renderAppAt("/activity");
		expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
	});

	// A status row names no state on purpose: lesson_feed records THAT a status
	// changed, not to what, so labeling an old event with the lesson's current
	// status would be wrong for anything that changed twice.
	it("does not label a status event with the lesson's current status", () => {
		renderAppAt("/activity");
		expect(screen.queryByText(/retracted/i)).toBeNull();
	});
});

describe("/activity when the feed is empty", () => {
	it("explains the empty state instead of rendering nothing", () => {
		fetchState.data = { events: [], cursor: null, has_more: false };
		renderAppAt("/activity");
		expect(screen.getByText(/nothing has happened yet/i)).toBeDefined();
		fetchState.data = { events: [], cursor: null, has_more: false };
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && ../../node_modules/.bin/vitest run src/__tests__/activity-page.test.tsx`
Expected: FAIL — `/activity` is not a route, so `App` renders its `*` 404 element and no nav appears.

- [ ] **Step 3: Write the page**

Create `apps/web/src/pages/ActivityPage.tsx`. It renders a plain page; the shell is applied in the route, matching `/lessons`, `/machines`, `/settings` and `/profile`.

```tsx
import { Link } from "react-router-dom";
import { EmptyState, Panel } from "../components/ui";
import { useAuthenticatedFetch } from "../hooks/useAuthenticatedFetch";

interface ActivityEvent {
	seq: number;
	kind: string;
	at: string;
	lesson_id: string;
	claim: string;
	status: string;
}

interface ActivityResponse {
	events: ActivityEvent[];
	cursor: string | null;
	has_more: boolean;
}

/** The day an event belongs to, in the reader's own timezone. */
function dayKey(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString(undefined, {
		weekday: "long",
		month: "long",
		day: "numeric",
	});
}

function timeOf(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleTimeString(undefined, { timeStyle: "short" });
}

/**
 * What happened, in the order the feed recorded it.
 *
 * A `status` row says only that the status changed. lesson_feed has no from/to
 * columns, and naming the lesson's CURRENT status on a past event would be
 * wrong for anything that changed twice - a lesson retracted in March and
 * reinstated in April would show both events as "active". See the design spec.
 */
function describeKind(kind: string): string {
	if (kind === "create") return "Published";
	if (kind === "status") return "Status changed";
	return kind;
}

export default function ActivityPage() {
	const { data, loading, error } =
		useAuthenticatedFetch<ActivityResponse>("/api/activity");

	if (loading) return <p>Loading your activity…</p>;

	if (error) {
		return (
			<div style={{ maxWidth: "640px" }}>
				<EmptyState title="Could not load your activity">{error}</EmptyState>
			</div>
		);
	}

	const events = data?.events ?? [];

	if (events.length === 0) {
		return (
			<div style={{ maxWidth: "640px" }}>
				<EmptyState title="Nothing has happened yet">
					Lessons you publish and statuses you change will show up here, newest
					first.
				</EmptyState>
			</div>
		);
	}

	const days: { day: string; events: ActivityEvent[] }[] = [];
	for (const event of events) {
		const day = dayKey(event.at);
		const current = days.at(-1);
		if (current && current.day === day) current.events.push(event);
		else days.push({ day, events: [event] });
	}

	return (
		<div style={{ maxWidth: "640px", display: "grid", gap: "var(--space-4)" }}>
			{days.map((group) => (
				<Panel key={group.day} title={group.day} icon="Book">
					{group.events.map((event) => (
						<div
							key={event.seq}
							style={{ display: "flex", gap: "var(--space-3)", padding: "0.35rem 0" }}
						>
							<span style={{ color: "var(--ink-dim)", flex: "none" }}>
								{timeOf(event.at)}
							</span>
							<span style={{ flex: "none" }}>{describeKind(event.kind)}</span>
							<Link to={`/lessons/${event.lesson_id}`}>{event.claim}</Link>
						</div>
					))}
				</Panel>
			))}
		</div>
	);
}
```

- [ ] **Step 4: Add the route and the nav entry**

In `apps/web/src/App.tsx`, add beside the other authenticated routes, matching their exact shape:

```tsx
					<Route
						path="/activity"
						element={
							<auth.RequireAuth>
								<AppShell>
									<ActivityPage />
								</AppShell>
							</auth.RequireAuth>
						}
					/>
```

Import `ActivityPage` with the other page imports.

In `apps/web/src/components/AppShell.tsx`, add to `SECTIONS` after the `/machines` entry:

```tsx
	// Book: the log-shaped icon in the brand set, and the one not already
	// spoken for by lessons, machines, settings or profile.
	{ to: "/activity", label: "Activity", icon: "Book" },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && ../../node_modules/.bin/vitest run src/__tests__/activity-page.test.tsx`
Expected: PASS, all five.

- [ ] **Step 6: Run the full suite, typecheck and lint**

```bash
cd apps/web && ../../node_modules/.bin/vitest run
cd ../.. && pnpm test && pnpm typecheck && pnpm lint
```

Expected: all pass. **`app-shell.test.tsx` asserts the nav links and will need the new one added** — it currently checks four hrefs. Add `/activity`; do not weaken the existing assertions.

- [ ] **Step 7: Commit**

`/commit` with `apps/web/src/pages/ActivityPage.tsx`, `apps/web/src/App.tsx`, `apps/web/src/components/AppShell.tsx`, `apps/web/src/__tests__/activity-page.test.tsx`, and `app-shell.test.tsx` if it changed.

---

## Self-Review

**Spec coverage.** Every section maps to a task. The `seq`-not-`at` ordering, cursor pagination and user isolation are Task 1. The session-authenticated endpoint and its 400-on-bad-cursor are Task 2. The contract cases are Task 3. The `/activity` route, `AppShell` slot, `Book` icon, day grouping and empty state are Task 4. The spec's testing section named six checks; all six appear.

**The `status`-row limitation has a test, not just a comment.** Task 4's fourth test asserts the word "retracted" does not appear even though the fixture event carries `status: "retracted"`. That is the spec's central constraint, and a comment alone would let a later change quietly start labeling events.

**Placeholder scan.** No TBDs. Three steps deliberately say "read the existing file first" — Task 1 Step 1 for the D1 harness, Task 2 Step 1 for the request harness, Task 3 Step 1 for the contract's real export names. Those are instructions to match existing conventions the plan should not guess at, not deferred decisions; each names exactly what to look for and where.

**Type consistency.** `ActivityEvent` and `ActivityPage` are defined in Task 1 and used with the same field names in Tasks 2 and 4. The `hasMore` (internal, camelCase) versus `has_more` (response, snake_case) split is called out explicitly in Task 2's Interfaces block, because it looks like an inconsistency and is in fact the existing convention `handleBrowseLessons` uses.

**One thing this review changed.** Task 4's web page originally declared `applies_to` on its local `ActivityEvent` interface, copying the API type. Nothing in the page renders it, so it is dropped from the web-side interface — the API still returns it, and a later screen that wants it can add it back. Carrying an unused field would have failed a reviewer's YAGNI check for no benefit.

**The review caught a wrong premise, and it came from the spec.** Task 3 originally required bumping a version constant in `packages/api-contract`, because the spec said CI's `contract-version` job demanded it. Reading the job showed it guards `packages/lesson-contract/schema/` and compares that package's `package.json` version — a different package, describing a lesson's shape rather than the HTTP surface. `packages/api-contract` has no version field at all, and its cases are returned by `anonymousCases()` and `authenticatedCases()` rather than held in a flat exported array, so the test in Step 1 would not have compiled either.

Both documents are corrected. The spec's Contract section now says plainly that the earlier draft was wrong and why, rather than being quietly rewritten — a reader who saw the first version should be able to tell what changed.

**A residual unknown, deliberately left to the implementer.** Task 3 Step 1 says to reuse whatever the existing tests use to build a `ContractFixture`. That helper's name is not in this plan because I did not read the test file, only the source. It is a one-line lookup at the top of the file the task is already editing.

**Spec coverage, re-checked after that correction.** The contract section still maps to Task 3; only its content changed. No other task depended on the version bump, so nothing else moved.
