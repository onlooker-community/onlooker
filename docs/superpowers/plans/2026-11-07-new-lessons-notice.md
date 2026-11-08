# New Lessons Notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the Lessons tab regains focus, tell the reader how many lessons
page 1 now holds that the list does not, and let them start the list over.

**Architecture:** `useLessonPool` gains a `fresh` state and a
`visibilitychange` check that re-asks for page 1 under the existing
`requestSeq` guard. `LessonsPage` renders a notice button from `fresh`, wires
its click to the existing `reload`, extends the status region's text, and
moves focus to the first row once the new page lands.

**Tech Stack:** React 18, react-router 6, Vitest + Testing Library (jsdom).

Spec: `docs/superpowers/specs/2026-11-07-new-lessons-notice-design.md`.
Linear: ONL-262. Bead: `onlooker-5be62p`.

## Global Constraints

- Every write to pool state stays in `apps/web/src/hooks/useLessonPool.ts`
  (ONL-75). The page only renders what the hook returns.
- Trigger: `visibilitychange` to `visible` only. No timer.
- Click: the existing `reload`. Pages loaded past page 1 are dropped.
- Detail pane: untouched.
- A failed check sets nothing and shows nothing.
- Copy: "1 new lesson, show it", "N new lessons, show them",
  "N+ new lessons, show them". The status region appends " · N new" or
  " · N+ new".
- Edit tracked files with Edit/Write, never the shell (repo CLAUDE.md).
- Run one test file with `pnpm --filter @onlooker/web test lessons-page`,
  with no `--` (repo CLAUDE.md).
- Every new test is proven by ablation: remove the code it covers, watch it
  fail, restore.
- Commits go through `/git-workflow:commit`.

## File Structure

- Modify `apps/web/src/hooks/useLessonPool.ts`: `fresh` state, the check,
  the `load()` reset, the return value.
- Modify `apps/web/src/pages/LessonsPage.tsx`: the notice, the status text,
  the focus handoff.
- Modify `apps/web/src/__tests__/lessons-page.test.tsx`: a `FRESH` fixture,
  a `tabBecomes` helper, a new `describe("lessons that arrive while you
  read")` block.

---

### Task 1: The check and the notice

**Files:**
- Modify: `apps/web/src/hooks/useLessonPool.ts`
- Modify: `apps/web/src/pages/LessonsPage.tsx` (the `useLessonPool`
  destructure near line 160, and above `<nav aria-label="Lessons">` near
  line 386)
- Test: `apps/web/src/__tests__/lessons-page.test.tsx`

**Interfaces:**
- Produces: `LessonPool.fresh: { count: number; more: boolean } | null`,
  read by Task 2. `FRESH`, `tabBecomes` and the new `describe` block in the
  test file, extended by Task 2.

- [ ] **Step 1: Add the fixture, the helper and the first test**

In `lessons-page.test.tsx`, add `afterEach` to the vitest import:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
```

After the `STALE` fixture, add:

```ts
// A lesson that reaches the pool after the page has loaded, sorting above
// everything shown. Load more never returns it, because each page asks for
// rows older than the last one shown.
const FRESH = {
	...VITE,
	id: "01KZ45MKAM734ZS7JK24D2DK0W",
	claim: "This lesson arrived while the page was open",
	promoted_at: "2026-08-25T10:00:00.000Z",
};
```

After `detailPane`, add:

```ts
// jsdom never changes visibility on its own. Shadowing the getter on the
// document instance, and deleting it after, leaves the prototype's alone.
function tabBecomes(state: "visible" | "hidden") {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => state,
	});
	document.dispatchEvent(new Event("visibilitychange"));
}
```

At the end of the file, add:

```ts
describe("lessons that arrive while you read", () => {
	afterEach(() => {
		Reflect.deleteProperty(document, "visibilityState");
	});

	it("says how many new lessons page 1 holds when the tab comes back", async () => {
		withPool([VITE, D1]);
		await at("/lessons");
		await screen.findByText(VITE.claim);

		withPool([FRESH, VITE, D1]);
		await act(async () => tabBecomes("visible"));

		expect(
			await screen.findByRole("button", { name: "1 new lesson, show it" }),
		).toBeDefined();
		// The rows on screen stay until the reader asks for the new page.
		expect(screen.queryByText(FRESH.claim)).toBeNull();
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @onlooker/web test lessons-page`
Expected: FAIL in "says how many new lessons..." with
`Unable to find role="button" and name "1 new lesson, show it"`.

- [ ] **Step 3: Add `fresh` and the check to the hook**

In `useLessonPool.ts`, add to `LessonPool` after `ended`:

```ts
	/**
	 * Lessons on a fresh read of page 1 that no loaded page holds, or null.
	 * `more` is set when every row on that read was new and the server had
	 * more, so the count is a floor and not the total.
	 */
	fresh: { count: number; more: boolean } | null;
```

After the `ended` state, add:

```ts
	// Set by the visibility check below, cleared by `load()`. A lesson that
	// reaches the pool above the last row shown never comes back through
	// Load more, which asks for rows older than that one (ONL-262).
	const [fresh, setFresh] = useState<{ count: number; more: boolean } | null>(
		null,
	);
```

After `moreInFlight`, add:

```ts
	// Which query, by its `requestSeq`, has a `load()` outstanding, or null. A
	// check while one is out would compare a page against a list that is about
	// to be replaced.
	const loadInFlight = useRef<number | null>(null);
	// One visibility check at a time. Switching tabs back and forth inside a
	// round-trip would otherwise send one request per switch.
	const checkInFlight = useRef(false);
```

In `load()`, after `const seq = ++requestSeq.current;`, add:

```ts
		loadInFlight.current = seq;
```

After `setEnded(false);` in `load()`, add:

```ts
		// And the notice: whatever it counted was measured against the list
		// this query is replacing.
		setFresh(null);
```

In `load()`'s `finally`, after the `setPoolSettled` line, add:

```ts
			if (loadInFlight.current === seq) loadInFlight.current = null;
```

After the `useEffect` that calls `load()`, add:

```ts
	// Re-ask for page 1 when the tab comes back, and count what the list does
	// not hold. Only once the current query's page 1 is showing: before then
	// there is nothing to compare against, and after a failure the error
	// state's Retry is already the way forward.
	useEffect(() => {
		if (lessons === null || loadError) return;
		const held = new Set(lessons.map((lesson) => lesson.id));
		const onVisibilityChange = async () => {
			if (document.visibilityState !== "visible") return;
			if (loadInFlight.current !== null || checkInFlight.current) return;
			// Read, not minted, the way loadMore reads it: the check belongs to
			// the query on screen, and a new query moving the counter discards it.
			const seq = requestSeq.current;
			checkInFlight.current = true;
			try {
				const page = await listLessons(query());
				if (seq !== requestSeq.current) return;
				const count = page.lessons.filter(
					(lesson) => !held.has(lesson.id),
				).length;
				setFresh(
					count === 0
						? null
						: { count, more: count === page.lessons.length && page.has_more },
				);
			} catch {
				// Deliberately quiet. This is a background check, and the list on
				// screen is still a true answer to the question it was asked.
			} finally {
				checkInFlight.current = false;
			}
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", onVisibilityChange);
	}, [lessons, loadError, query]);
```

Add `fresh,` to the returned object after `ended,`.

- [ ] **Step 4: Render the notice**

In `LessonsPage.tsx`, import `Button` with the other `../components/ui`
names (alphabetical, before `Chip`), and add `fresh,` to the
`useLessonPool` destructure after `ended,`.

Directly above `const emptyTitle`, so `resultSummary` can read it in Task 2,
add:

```ts
	// "N+" when every row on the fresh read was new and there were more: the
	// count is then a floor, and saying exactly N would be a guess.
	const freshCount = fresh ? `${fresh.count}${fresh.more ? "+" : ""}` : null;
	const freshLabel = fresh
		? fresh.count === 1 && !fresh.more
			? "1 new lesson, show it"
			: `${freshCount} new lessons, show them`
		: null;
```

Inside `<Panel title="The pool">`, directly before `<nav aria-label="Lessons">`,
add:

```tsx
						{freshLabel ? (
							<div style={{ marginBottom: "var(--space-2)" }}>
								<Button variant="ghost" onClick={reload}>
									{freshLabel}
								</Button>
							</div>
						) : null}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `pnpm --filter @onlooker/web test lessons-page`
Expected: all pass.

- [ ] **Step 6: Add the guard tests**

Inside the new `describe`, after the first test, add:

```ts
	it("shows nothing when page 1 holds nothing new", async () => {
		withPool([VITE, D1]);
		await at("/lessons");
		await screen.findByText(VITE.claim);

		await act(async () => tabBecomes("visible"));

		await waitFor(() => expect(mocks.listLessons).toHaveBeenCalledTimes(2));
		expect(screen.queryByRole("button", { name: /new lesson/i })).toBeNull();
	});

	it("asks nothing when the tab is hidden", async () => {
		withPool([VITE, D1]);
		await at("/lessons");
		await screen.findByText(VITE.claim);

		await act(async () => tabBecomes("hidden"));

		expect(mocks.listLessons).toHaveBeenCalledTimes(1);
	});

	it("drops a check that lands after the filter has moved on", async () => {
		withPool([VITE, D1]);
		await at("/lessons");
		await screen.findByText(VITE.claim);

		let resolve: (value: unknown) => void = () => {};
		mocks.listLessons.mockImplementationOnce(
			() =>
				new Promise((res) => {
					resolve = res;
				}),
		);
		await act(async () => tabBecomes("visible"));

		withPool([VITE]);
		fireEvent.change(screen.getByLabelText(/status/i), {
			target: { value: "active" },
		});
		await waitFor(() => expect(mocks.listLessons).toHaveBeenCalledTimes(3));

		await act(async () => {
			resolve({
				lessons: [FRESH, VITE, D1],
				cursor: null,
				has_more: false,
				owned_ids: [FRESH.id, VITE.id, D1.id],
			});
		});

		expect(screen.queryByRole("button", { name: /new lesson/i })).toBeNull();
	});

	it("shows nothing when the check fails, and keeps the list", async () => {
		withPool([VITE, D1]);
		await at("/lessons");
		await screen.findByText(VITE.claim);

		mocks.listLessons.mockRejectedValueOnce(new Error("Something went wrong"));
		await act(async () => tabBecomes("visible"));

		await waitFor(() => expect(mocks.listLessons).toHaveBeenCalledTimes(2));
		expect(screen.queryByText(/something went wrong/i)).toBeNull();
		expect(screen.queryByRole("button", { name: /new lesson/i })).toBeNull();
		expect(screen.getByText(VITE.claim)).toBeDefined();
	});

	it("calls the count a floor when every row is new and there are more", async () => {
		withPool([VITE]);
		await at("/lessons");
		await screen.findByText(VITE.claim);

		withPool([FRESH, D1], { cursor: "Y3Vyc29yLTE=", has_more: true });
		await act(async () => tabBecomes("visible"));

		expect(
			await screen.findByRole("button", { name: "2+ new lessons, show them" }),
		).toBeDefined();
	});
```

- [ ] **Step 7: Run them and watch them pass**

Run: `pnpm --filter @onlooker/web test lessons-page`
Expected: all pass.

- [ ] **Step 8: Prove each test by ablation**

Make each change alone, run the file, confirm the named test fails, restore:

| Ablation in `useLessonPool.ts` | Must fail |
|---|---|
| Drop `count === 0 ? null :` (always set `{ count, more }`) | "shows nothing when page 1 holds nothing new" |
| Drop the `visibilityState !== "visible"` return | "asks nothing when the tab is hidden" |
| Drop `if (seq !== requestSeq.current) return;` in the check | "drops a check that lands after the filter has moved on" |
| Replace the empty `catch` body with `setFresh({ count: 1, more: false });` | "shows nothing when the check fails" |
| Set `more: false` unconditionally | "calls the count a floor..." |

The `setFresh(null)` reset in `load()` is proven in Task 2, by the click test.

Then run `git diff apps/web/src/hooks` to confirm the hook matches Steps 3
and 4 exactly.

- [ ] **Step 9: Commit**

Through `/git-workflow:commit`, staging the three files. Body should say the
check re-asks for page 1 on focus and why the seq guard covers it.
`Refs ONL-262`.

---

### Task 2: Showing them, and what the page says

**Files:**
- Modify: `apps/web/src/pages/LessonsPage.tsx`
- Test: `apps/web/src/__tests__/lessons-page.test.tsx`

**Interfaces:**
- Consumes: `fresh` from Task 1; `reload` (existing); `FRESH`, `tabBecomes`
  and the `describe("lessons that arrive while you read")` block.

- [ ] **Step 1: Write the click, status and focus tests**

Inside the `describe`, add:

```ts
	it("shows the new lesson and drops the notice when asked", async () => {
		withPool([VITE, D1]);
		await at("/lessons");
		await screen.findByText(VITE.claim);

		withPool([FRESH, VITE, D1]);
		await act(async () => tabBecomes("visible"));
		fireEvent.click(
			await screen.findByRole("button", { name: "1 new lesson, show it" }),
		);

		expect(await screen.findByText(FRESH.claim)).toBeDefined();
		expect(screen.queryByRole("button", { name: /new lesson/i })).toBeNull();
	});

	it("puts the new count in the status region", async () => {
		withPool([VITE, D1]);
		await at("/lessons");
		await screen.findByText(VITE.claim);

		withPool([FRESH, VITE, D1]);
		await act(async () => tabBecomes("visible"));

		expect(await screen.findByText("2 lessons · 1 new")).toBeDefined();
	});

	it("moves focus to the first row once the new page lands", async () => {
		withPool([VITE, D1]);
		await at("/lessons");
		await screen.findByText(VITE.claim);

		withPool([FRESH, VITE, D1]);
		await act(async () => tabBecomes("visible"));
		const notice = await screen.findByRole("button", {
			name: "1 new lesson, show it",
		});
		notice.focus();
		fireEvent.click(notice);

		await screen.findByText(FRESH.claim);
		await waitFor(() =>
			expect(document.activeElement).toBe(rowFor(FRESH)),
		);
	});

	// The likeliest reader of an empty pool is waiting for their first
	// machine's first lesson.
	it("offers the new lesson over an empty list too", async () => {
		withPool([]);
		await at("/lessons");
		await screen.findByRole("heading", { name: /nothing has synced yet/i });

		withPool([FRESH]);
		await act(async () => tabBecomes("visible"));
		fireEvent.click(
			await screen.findByRole("button", { name: "1 new lesson, show it" }),
		);

		expect(await screen.findByText(FRESH.claim)).toBeDefined();
	});
```

The empty-list test was added after Task 1's review, with the human's
approval. It FAILS too: Task 1 put the notice inside the rows' `Panel`,
which an empty list never renders.

- [ ] **Step 2: Run them and watch two fail**

Run: `pnpm --filter @onlooker/web test lessons-page`
Expected: "shows the new lesson..." PASSES already (Task 1 wired `reload`);
note that and prove it by ablation in Step 6. "puts the new count..." FAILS
(no element with text "2 lessons · 1 new"). "moves focus..." FAILS
(activeElement is `<body>`).

- [ ] **Step 3: Extend the status text**

In `LessonsPage.tsx`, change the last branch of `resultSummary` from:

```ts
				: `${lessons.length} lesson${lessons.length === 1 ? "" : "s"}`;
```

to:

```ts
				: `${lessons.length} lesson${lessons.length === 1 ? "" : "s"}${
						freshCount ? ` · ${freshCount} new` : ""
					}`;
```

`freshCount` is already declared above it, from Task 1.

- [ ] **Step 3b: Move the notice above every branch**

Cut the `{freshLabel ? (...) : null}` block Task 1 put inside
`<Panel title="The pool">`, and paste it directly after the closing `</p>`
of the `role="status"` region, before `{loadError ? (`. Keep its markup.
Add a comment on it: it sits above every branch so an empty list shows it
too, and the hook only sets `fresh` once page 1 is showing without an
error, so it cannot appear over the loading or error states.

- [ ] **Step 4: Hand focus to the first row**

Add `useRef` to the `react` import. Next to the other state near the top of
`LessonsPage`, add:

```ts
	// Set when the notice is pressed, read once the new page lands. The press
	// unmounts the button, which leaves focus on <body>; the first row is where
	// the reader was headed. Same rule as LoadMore: only when focus really was
	// lost, so a reader who moved on is left where they went.
	const focusFirstRow = useRef(false);
	const navRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (!focusFirstRow.current || lessons === null) return;
		focusFirstRow.current = false;
		if (document.activeElement !== document.body) return;
		navRef.current?.querySelector("a")?.focus();
	}, [lessons]);
```

Change the notice's `onClick` from `reload` to:

```tsx
onClick={() => {
	focusFirstRow.current = true;
	reload();
}}
```

and add `ref={navRef}` to `<nav aria-label="Lessons">`.

- [ ] **Step 5: Run them and watch them pass**

Run: `pnpm --filter @onlooker/web test lessons-page`
Expected: all pass.

- [ ] **Step 6: Prove each test by ablation**

| Ablation | Must fail |
|---|---|
| Notice `onClick` does only `focusFirstRow.current = true;` (no `reload()`) | "shows the new lesson and drops the notice" |
| Drop `setFresh(null);` from `load()` in the hook | "shows the new lesson and drops the notice" |
| Drop the `freshCount ? ... : ""` suffix | "puts the new count in the status region" |
| Drop `navRef.current?.querySelector("a")?.focus();` | "moves focus to the first row" |
| Move the notice back inside `<Panel title="The pool">` | "offers the new lesson over an empty list too" |

- [ ] **Step 7: Run the gates**

```bash
pnpm --filter @onlooker/web test
pnpm --filter @onlooker/web typecheck
pnpm exec biome check apps/web/src/hooks/useLessonPool.ts apps/web/src/pages/LessonsPage.tsx apps/web/src/__tests__/lessons-page.test.tsx
```

Expected: all pass, no biome errors.

- [ ] **Step 8: Commit**

Through `/git-workflow:commit`. `Fixes ONL-262`.

---

### Task 3: Close out

- [ ] **Step 1:** Append the ablation results to the bead:
  `bd update onlooker-5be62p --append-notes "..."`.
- [ ] **Step 2:** Add a comment on ONL-262 that the late-pushed case (an old
  `promoted_at` that sorts past page 1) stays open, and that it needs the
  pool ordered by arrival (the issue's option 3).
- [ ] **Step 3:** Open the PR through `/git-workflow:pr`.
