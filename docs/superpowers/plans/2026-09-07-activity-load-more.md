# Activity Feed Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `/activity` a Load more control so a reader can reach events older than the newest 50.

**Architecture:** Add a `listActivity` client function beside `listLessons`, move `ActivityPage` off `useAuthenticatedFetch` onto it, then add cursor state and an append path. The API, the query, and the contract are unchanged — the endpoint has been cursor-paginated since it shipped and simply had no consumer.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, Biome. Package `apps/web`.

Spec: `docs/superpowers/specs/2026-09-07-activity-load-more-design.md`. Bead: `onlooker-58i`.

## Global Constraints

- **American English** in all comments, identifiers, and copy.
- **Edit tracked files with `Edit`/`Write`, never shell heredocs or `sed -i`.** The `lineage` and `inspector` plugins hook `PostToolUse` on the file tools; a shell edit moves the same bytes invisibly and `/lineage` then answers "no record" for a line that was demonstrably written. See `CLAUDE.md`.
- **Route every commit through the `/commit` skill.** Conventional commits, mood emoji reflecting *this* change, why-focused body.
- `process.env.TZ = "UTC"` must stay pinned at the top of `activity-page.test.tsx`, above every import. The reason is recorded in that file and is unaffected by this work.
- Field names on the wire are the API's and stay snake_case: `has_more`, `lesson_id`.
- Run from the repo root: tests `pnpm --filter @onlooker/web test`, lint `pnpm --filter @onlooker/web lint`, types `pnpm --filter @onlooker/web typecheck`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/web/src/api/lessonsApi.ts` | gains `listActivity`, `ActivityEvent`, `ActivityFeedPage` | 1 |
| `apps/web/src/api/lessonsApi.test.ts` | URL-building tests for `listActivity` | 1 |
| `apps/web/src/pages/ActivityPage.tsx` | drops `useAuthenticatedFetch`, hand-rolls load, then gains load-more | 2, 3 |
| `apps/web/src/__tests__/activity-page.test.tsx` | mock moves from the hook to the api module; gains 4 cases | 2, 3 |
| `docs/superpowers/specs/2026-08-31-lesson-activity-screen-design.md` | Screen section cross-references the new design | 3 |

---

### Task 1: `listActivity` in `lessonsApi.ts`

**Files:**
- Modify: `apps/web/src/api/lessonsApi.ts` (add to `LESSON_ENDPOINTS` at :14; append after `listLessons`, which ends at :78)
- Test: `apps/web/src/api/lessonsApi.test.ts`

**Interfaces:**
- Consumes: `apiClient.get<T>(path)` from `./client`.
- Produces: `LESSON_ENDPOINTS.activity`, `interface ActivityEvent`, `interface ActivityFeedPage`, `interface ListActivityOptions`, `function listActivity(options?: ListActivityOptions): Promise<ActivityFeedPage>`.

- [ ] **Step 1: Write the failing tests**

Add `listActivity` to the existing import destructure at the top of `apps/web/src/api/lessonsApi.test.ts`:

```ts
const { getLesson, listActivity, listLessons, setLessonStatus } = await import(
	"./lessonsApi"
);
```

Append this describe block to the end of the file:

```ts
describe("listActivity", () => {
	const EMPTY_FEED = { events: [], cursor: null, has_more: false };

	it("asks for the bare path when it has no cursor", async () => {
		mocks.get.mockResolvedValue(EMPTY_FEED);
		await listActivity();
		expect(mocks.get).toHaveBeenCalledWith("/api/activity");
	});

	// The activity cursor is base64 of a bare integer - encodeSeqCursor in
	// apps/api/src/db/lessons.ts - so it can carry "=" padding, which changes
	// meaning in a query string unless it is encoded. String concatenation
	// would send a cursor the server minted and then rejects.
	it("encodes a cursor that carries base64 padding", async () => {
		mocks.get.mockResolvedValue(EMPTY_FEED);
		await listActivity({ cursor: "MTIz=" });
		expect(mocks.get).toHaveBeenCalledWith("/api/activity?cursor=MTIz%3D");
	});

	// apps/api guards with `if (cursor)`, treating "" as absent, and mockApi
	// matches that. Sending `?cursor=` would be a request neither side needs
	// to answer.
	it("omits an empty cursor rather than sending a bare one", async () => {
		mocks.get.mockResolvedValue(EMPTY_FEED);
		await listActivity({ cursor: "" });
		expect(mocks.get).toHaveBeenCalledWith("/api/activity");
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @onlooker/web test -- lessonsApi
```

Expected: FAIL. `listActivity is not a function` (the import destructure yields `undefined`).

- [ ] **Step 3: Write the implementation**

In `apps/web/src/api/lessonsApi.ts`, add the activity path to the endpoint map:

```ts
export const LESSON_ENDPOINTS = {
	lessons: "/api/lessons",
	activity: "/api/activity",
} as const;
```

Then append after `listLessons`:

```ts
/** One event in the reader's own feed. Field names are the API's, not camelCased. */
export interface ActivityEvent {
	seq: number;
	kind: string;
	at: string;
	lesson_id: string;
	claim: string;
}

/**
 * One page of the activity feed.
 *
 * Named `ActivityFeedPage` and not `ActivityPage`, which is what the server
 * type in apps/api/src/db/lessons.ts is called: the browser already has a
 * component by that name, and both are imported into ActivityPage.tsx. The
 * server has no such collision, which is why the names diverge here rather
 * than there.
 */
export interface ActivityFeedPage {
	events: ActivityEvent[];
	cursor: string | null;
	has_more: boolean;
}

export interface ListActivityOptions {
	cursor?: string | null;
}

/**
 * The reader's own feed, newest first.
 *
 * Lives beside listLessons rather than in an activityApi.ts because the server
 * made the same choice for the same reason: listActivityPage sits with
 * listLessonsPage in apps/api/src/db/lessons.ts, since this is the second read
 * over the same feed the browse routes already page through.
 */
export function listActivity(
	options: ListActivityOptions = {},
): Promise<ActivityFeedPage> {
	const query = new URLSearchParams();

	// `if (cursor)` and not `!= null`, matching listLessons above and apps/api:
	// both treat "" as absent.
	if (options.cursor) query.set("cursor", options.cursor);

	const search = query.toString();
	return apiClient.get<ActivityFeedPage>(
		search
			? `${LESSON_ENDPOINTS.activity}?${search}`
			: LESSON_ENDPOINTS.activity,
	);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @onlooker/web test -- lessonsApi
pnpm --filter @onlooker/web typecheck
pnpm --filter @onlooker/web lint
```

Expected: all PASS. Confirm the three new `listActivity` cases appear in the output by name — a filter that matched nothing also exits 0.

- [ ] **Step 5: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add apps/web/src/api/lessonsApi.ts apps/web/src/api/lessonsApi.test.ts
```

---

### Task 2: Port `ActivityPage` onto `listActivity`

No behavior change. The screen renders exactly as it does today; only the mechanism moves. A reviewer can accept this and still reject Task 3's control.

**Files:**
- Modify: `apps/web/src/pages/ActivityPage.tsx` (replace the `useAuthenticatedFetch` call at :52 and the render guards that follow)
- Test: `apps/web/src/__tests__/activity-page.test.tsx` (replace the `vi.mock` at :98)

**Interfaces:**
- Consumes: `listActivity`, `ActivityEvent` from Task 1.
- Produces: an `ActivityPage` whose data lifecycle is its own, ready for Task 3's cursor state.

- [ ] **Step 1: Rewire the existing tests to the new seam**

In `apps/web/src/__tests__/activity-page.test.tsx`, delete the `fetchState` object and the `vi.mock("../hooks/useAuthenticatedFetch", ...)` block. Replace with:

```ts
const mocks = vi.hoisted(() => ({ listActivity: vi.fn() }));

// importOriginal rather than a bare factory: App's route table pulls in
// LessonsPage, which imports listLessons from this same module. A factory that
// returned only listActivity would leave that binding undefined at module
// evaluation, breaking a route this file never renders.
vi.mock("../api/lessonsApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/lessonsApi")>()),
	listActivity: mocks.listActivity,
}));

beforeEach(() => {
	mocks.listActivity.mockReset().mockResolvedValue(POPULATED);
});
```

Keep `POPULATED` and `EMPTY` exactly as they are.

Now make the four data-dependent tests await their content. **The page resolves a promise, so a synchronous `getByText` runs before the first page lands.** Replace the bodies:

```ts
	it("shows each event's claim", async () => {
		renderAppAt("/activity");
		expect(await screen.findByText(/pin vitest and vite/i)).toBeDefined();
		expect(screen.getByText(/prefer explicit imports/i)).toBeDefined();
	});

	// Three events, two of them (seq 3 and seq 2) on the same day: if grouping
	// actually merges same-day events, this yields 2 headings, not 3.
	it("groups events under a heading per day", async () => {
		renderAppAt("/activity");
		expect(await screen.findAllByRole("heading", { level: 2 })).toHaveLength(2);
	});

	// A status row names no state on purpose. The await is load-bearing: a
	// queryByText against a page that has not rendered yet returns null and
	// passes vacuously, so this must wait for real content before asserting an
	// absence.
	it("does not label a status event with the lesson's current status", async () => {
		renderAppAt("/activity");
		await screen.findByText(/pin vitest and vite/i);
		expect(screen.queryByText(/retracted/i)).toBeNull();
	});
```

And in the empty-feed describe:

```ts
	it("explains the empty state instead of rendering nothing", async () => {
		mocks.listActivity.mockResolvedValue(EMPTY);
		renderAppAt("/activity");
		expect(await screen.findByText(/nothing has happened yet/i)).toBeDefined();
	});
```

`renders inside the shell` stays synchronous — the shell's nav does not depend on feed data.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @onlooker/web test -- activity-page
```

Expected: FAIL. `ActivityPage` still calls `useAuthenticatedFetch`, which is no longer mocked, so it issues a real request through `apiClient` and renders the loading or error branch instead of the fixture.

- [ ] **Step 3: Write the implementation**

Replace the imports at the top of `apps/web/src/pages/ActivityPage.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type ActivityEvent, listActivity } from "../api/lessonsApi";
import { EmptyState, Panel } from "../components/ui";
import { describeError } from "../lib/apiErrors";
```

Delete the local `ActivityEvent` and `ActivityResponse` interfaces — `ActivityEvent` now comes from the api module and `ActivityResponse` has no remaining use. Keep `dayKey`, `timeOf`, and `describeKind` untouched.

Replace the body's opening (the `useAuthenticatedFetch` call and the three guards) with:

```tsx
export default function ActivityPage() {
	const [events, setEvents] = useState<ActivityEvent[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		// An `active` flag, not a request sequence number. LessonsPage carries a
		// requestSeq (LessonsPage.tsx:119) because a filter change mints a second
		// query, and without one whichever request SETTLES last would win rather
		// than whichever was ASKED last. This screen has no filter, so there is no
		// second query and nothing to order. What does still apply is an unmount
		// mid-flight, which is all this guards.
		let active = true;
		listActivity()
			.then((page) => {
				if (!active) return;
				setEvents(page.events);
			})
			.catch((error: unknown) => {
				if (!active) return;
				setLoadError(describeError(error, "Could not load your activity."));
			});
		return () => {
			active = false;
		};
	}, []);

	if (loadError) {
		return (
			<div style={{ maxWidth: "640px" }}>
				<EmptyState title="Could not load your activity">
					{loadError}
				</EmptyState>
			</div>
		);
	}

	if (events === null) return <p>Loading your activity…</p>;

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
```

Note the guard order changed: `loadError` is checked before the null-events loading branch, because a failed load leaves `events` null forever and the old ordering would show "Loading…" indefinitely.

The rest of the component — the `groups` Map, `days`, and the returned JSX — is unchanged. Replace the former `const events = data?.events ?? [];` line; `events` is now state.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @onlooker/web test -- activity-page
pnpm --filter @onlooker/web typecheck
pnpm --filter @onlooker/web lint
```

Expected: all 5 PASS.

Leave `useAuthenticatedFetch` in place: `ProfilePage.tsx` still uses it, as do its own tests.

**The blast radius of this rewire was checked and is one file.** Two other test files mock `useAuthenticatedFetch` — `shell-headings.test.tsx:27` and `account-routes-in-shell.test.tsx:26` — but neither renders `/activity` (zero case-insensitive references to it in either), and `app-shell.test.tsx` mentions `/activity` only to assert a nav `href`, rendering `<AppShell>` with its own children rather than the real route. So no test outside `activity-page.test.tsx` needs touching. Re-run the full suite in Task 3 Step 6 to confirm rather than trusting this.

- [ ] **Step 5: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add apps/web/src/pages/ActivityPage.tsx apps/web/src/__tests__/activity-page.test.tsx
```

---

### Task 3: The Load more control

**Files:**
- Modify: `apps/web/src/pages/ActivityPage.tsx`
- Test: `apps/web/src/__tests__/activity-page.test.tsx`
- Modify: `docs/superpowers/specs/2026-08-31-lesson-activity-screen-design.md`

**Interfaces:**
- Consumes: `listActivity({ cursor })` from Task 1; the component state from Task 2.
- Produces: no new exports. `ActivityPage` renders a `Load more` button while `cursor` is non-null.

- [ ] **Step 1: Write the failing tests**

Add these fixtures beside `POPULATED` in `apps/web/src/__tests__/activity-page.test.tsx`:

```ts
// Page one ends mid-day on purpose. Its oldest event (seq 2) is 2026-08-31,
// and page two's newest (seq 1) is the SAME day - so a correct implementation
// merges them under one heading and a per-page implementation renders two.
// A fixture whose page boundary fell on a day boundary would pass either way.
const PAGE_ONE = {
	events: [
		{
			seq: 3,
			kind: "create",
			at: "2026-08-31T18:00:00Z",
			lesson_id: "l3",
			claim: "Cache node_modules between CI runs",
		},
		{
			seq: 2,
			kind: "create",
			at: "2026-08-31T14:00:00Z",
			lesson_id: "l2",
			claim: "Pin vitest and vite together",
		},
	],
	cursor: "Mg==",
	has_more: true,
};

const PAGE_TWO = {
	events: [
		{
			seq: 1,
			kind: "create",
			at: "2026-08-31T09:00:00Z",
			lesson_id: "l1",
			claim: "Prefer explicit imports",
		},
	],
	cursor: null,
	has_more: false,
};
```

Add `fireEvent` to the existing Testing Library import at the top of the file:

```ts
import { fireEvent, render, screen } from "@testing-library/react";
```

**Do not reach for `@testing-library/user-event` or `jest-dom` matchers such as
`toHaveTextContent`.** Neither is a dependency of `apps/web` and nothing in the
suite uses them. The established idiom here is `fireEvent` plus
`toBeDefined()` / `toBeNull()` — see `app-shell.test.tsx:105` and
`lessons-page.test.tsx:187`. Adding a dependency is not in this plan's scope.

Then append this describe block:

```ts
describe("/activity pagination", () => {
	it("has no Load more button when the first page is the whole feed", async () => {
		mocks.listActivity.mockResolvedValue(PAGE_TWO);
		renderAppAt("/activity");
		await screen.findByText(/prefer explicit imports/i);
		expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
	});

	it("appends the next page and retires the button when the feed ends", async () => {
		mocks.listActivity
			.mockResolvedValueOnce(PAGE_ONE)
			.mockResolvedValueOnce(PAGE_TWO);
		renderAppAt("/activity");

		fireEvent.click(await screen.findByRole("button", { name: /load more/i }));

		expect(await screen.findByText(/prefer explicit imports/i)).toBeDefined();
		expect(screen.getByText(/cache node_modules/i)).toBeDefined();
		expect(mocks.listActivity).toHaveBeenLastCalledWith({ cursor: "Mg==" });
		expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
	});

	// The assertion this whole change can most plausibly get wrong. Page one
	// ends and page two begins on the SAME day, so grouping that runs per page
	// yields two headings where grouping over the accumulated list yields one.
	it("merges a day that spans the page boundary into one heading", async () => {
		mocks.listActivity
			.mockResolvedValueOnce(PAGE_ONE)
			.mockResolvedValueOnce(PAGE_TWO);
		renderAppAt("/activity");

		fireEvent.click(await screen.findByRole("button", { name: /load more/i }));
		await screen.findByText(/prefer explicit imports/i);

		expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
	});

	// A missing tail is not a reason to blank a feed the reader can still use.
	it("keeps the loaded events when an append fails", async () => {
		mocks.listActivity
			.mockResolvedValueOnce(PAGE_ONE)
			.mockRejectedValueOnce(new Error("Network unreachable"));
		renderAppAt("/activity");

		fireEvent.click(await screen.findByRole("button", { name: /load more/i }));

		expect(await screen.findByRole("alert")).toBeDefined();
		expect(screen.getByText(/network unreachable/i)).toBeDefined();
		expect(screen.getByText(/cache node_modules/i)).toBeDefined();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @onlooker/web test -- activity-page
```

Expected: the four new cases FAIL — no `Load more` button exists, so `findByRole` times out. The five from Task 2 still PASS.

- [ ] **Step 3: Write the implementation**

Add `Button` to the `ui` import and bring in the palette:

```tsx
import { Button, EmptyState, Panel } from "../components/ui";
import { PALETTE } from "../components/palette";
```

Add three pieces of state beside the two from Task 2:

```tsx
	const [cursor, setCursor] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const [moreError, setMoreError] = useState<string | null>(null);
```

In the effect's `.then`, record the cursor alongside the events:

```tsx
			.then((page) => {
				if (!active) return;
				setEvents(page.events);
				// `has_more` and not `cursor !== null`. They agree today, because
				// listActivityPage derives hasMore as `rows.length > limit` and so
				// always has a last row to mint a cursor from - but they are two
				// facts and only one of them is the question being asked. See the
				// same reasoning at LessonsPage's load().
				setCursor(page.has_more ? page.cursor : null);
			})
```

Add `loadMore` after the effect:

```tsx
	const loadMore = async () => {
		// The whole of the concurrency control this screen needs: no filter means
		// no query to supersede, so the only race is a second click while the
		// first append is still out.
		if (!cursor || loadingMore) return;
		setLoadingMore(true);
		setMoreError(null);
		try {
			const page = await listActivity({ cursor });
			setEvents((current) => [...(current ?? []), ...page.events]);
			setCursor(page.has_more ? page.cursor : null);
		} catch (error) {
			// The pages already loaded stay. A failed append is a missing tail.
			setMoreError(describeError(error, "Could not load more activity."));
		} finally {
			setLoadingMore(false);
		}
	};
```

Finally, add the control after the `days.map(...)` block, still inside the outer `div`:

```tsx
			{cursor ? (
				<Button
					loading={loadingMore}
					loadingLabel="Loading…"
					onClick={() => void loadMore()}
				>
					Load more
				</Button>
			) : null}

			{moreError ? (
				<p role="alert" style={{ color: PALETTE.danger }}>
					{moreError}
				</p>
			) : null}
```

It sits below the panels rather than inside the last one: the control belongs to the feed, not to a day.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @onlooker/web test -- activity-page
pnpm --filter @onlooker/web typecheck
pnpm --filter @onlooker/web lint
```

Expected: all 9 PASS.

- [ ] **Step 5: Point the prior spec at this one**

In `docs/superpowers/specs/2026-08-31-lesson-activity-screen-design.md`, append to the end of the `## Screen *(approved)*` section:

```markdown
**Amended 2026-09-07.** This section described a screen with no pagination
control while the API beneath it was cursor-paginated, which left the
Pagination section above with no consumer. A `Load more` control was added in
`2026-09-07-activity-load-more-design.md`; the day grouping described here is
unchanged, because it already merges same-day events regardless of their
position in the array.
```

- [ ] **Step 6: Run the full web suite**

```bash
pnpm --filter @onlooker/web test
```

Expected: PASS. This catches anything the `activity-page` filter missed — in particular that `lessonsApi.test.ts` still passes with the endpoint map changed in Task 1.

- [ ] **Step 7: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add apps/web/src/pages/ActivityPage.tsx \
        apps/web/src/__tests__/activity-page.test.tsx \
        docs/superpowers/specs/2026-08-31-lesson-activity-screen-design.md
```

---

## Verification before opening a PR

- [ ] `pnpm --filter @onlooker/web test` — 9 activity cases plus the `listActivity` trio, all passing.
- [ ] `pnpm --filter @onlooker/web typecheck`
- [ ] `pnpm --filter @onlooker/web lint`
- [ ] Confirm the day-boundary test genuinely fails against a per-page implementation before trusting it: temporarily group inside the `days.map` source instead of over the accumulated list, watch that one test go red, then revert. A test that cannot fail is not covering anything.
- [ ] `bd close onlooker-58i`

**Not verifiable manually.** `mockApi.ts` serves `/api/activity` a permanently empty feed by construction, so `pnpm dev` cannot exercise Load more. This is deliberate — see the spec's "What this deliberately does not do" — and means the tests are the only evidence this works.
