# Web Home Dashboard PR 3: Lessons Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the third and last home panel, Lessons: what happened to the reader's lessons in the last 7 days, linking through to `/activity`.

**Architecture:** `HomePage` reads the first `listActivity()` page in parallel with its other reads and cuts it to the same 7-day window as the sessions, using `withinWindow`. A new presentational `HomeLessonsPanel` states what it is given. The wording of an event kind moves out of `ActivityPage` into `lib/lessonActivity.ts`, so the two pages say "Published" and "Status changed" from one function.

**Tech Stack:** React 18, react-router-dom, Vitest + Testing Library, biome. Web only (`apps/web`), with no API change.

**Spec:** `docs/superpowers/specs/2026-11-18-web-home-dashboard-design.md`, section "Panels > Lessons". Linear ONL-298, bead `onlooker-l0njh6.3`. Branch `meagan/onl-298-home-lessons`.

## Global Constraints

- Web only, on endpoints that already exist. No API change.
- The window is today and the six days before it, from local midnight, by `at` for activity. Use `withinWindow` and `windowStart` from `lib/homeWindow.ts`. Don't write a second cutoff.
- When the loaded page doesn't reach back to the window's start and `has_more` is true, the headline says "in your latest N events".
- A failed read never renders as an empty state. Each panel loads and fails on its own.
- An overview, never a copy: the panel ends with a link to `/activity` at its foot, not in its heading.
- American English in code, comments and copy.
- Edit tracked files with the Edit/Write tools, never a shell edit or a shell formatter (`biome check --write`, `lint:fix`). If biome reports formatting, fix it with Edit.
- One test file: `pnpm --filter @onlooker/web test <name>`, with **no `--`**. `test -- <name>` runs the whole suite.
- Commit through `/git-workflow:commit`, never an ad hoc `git commit -m`.

## Decisions this plan makes beyond the spec

- **The latest 3 events come from the window, not the whole page.** The panel describes the week, and listing an event from three weeks ago under a "last 7 days" headline would contradict it.
- **Two empty cases.** If the feed holds nothing at all, the panel says "No lesson activity yet." and points at `onlooker sync`, which is what pushes approved lessons (`apps/cli/src/cli.ts:29`). If the feed has older events but none in the window, it says "No lesson activity in the last 7 days.", because "yet" would be false.
- **Headline parts with a zero are left out.** "1 status change in the last 7 days", not "0 published · 1 status change". If neither kind has a count, which only a kind newer than this build could cause, it falls back to "N events".
- **An event shows its day, not its time.** The window spans seven days, so `dayKey(at)` (for example "Wednesday, November 18") says when. `ActivityPage` shows `timeOf` only because each of its panels is already a single day.

## File Structure

- Create `apps/web/src/lib/lessonActivity.ts`: `describeKind` (moved from `ActivityPage`), `tallyActivity` and `describeLessonWeek`. Pure.
- Create `apps/web/src/__tests__/lesson-activity.test.ts`.
- Modify `apps/web/src/pages/ActivityPage.tsx`: delete the local `describeKind` and import it from the lib.
- Create `apps/web/src/components/HomeLessonsPanel.tsx`: presentational, deciding nothing, like `HomePluginsPanel`.
- Create `apps/web/src/__tests__/home-lessons-panel.test.tsx`.
- Modify `apps/web/src/pages/HomePage.tsx`: add the activity read, its window and the third `PanelFor`.
- Modify `apps/web/src/__tests__/home-page.test.tsx`: mock `listActivity` and add the Lessons cases.

---

### Task 1: The wording and tally of lesson activity

**Files:**
- Create: `apps/web/src/lib/lessonActivity.ts`
- Create: `apps/web/src/__tests__/lesson-activity.test.ts`
- Modify: `apps/web/src/pages/ActivityPage.tsx` (delete lines 10–22, the `describeKind` function and its comment, and add an import)

**Interfaces:**
- Consumes: `ActivityEvent` from `apps/web/src/api/lessonsApi.ts` (`{ seq: number; kind: string; at: string; lesson_id: string; claim: string }`), and `plural(n: number, singular: string): string` from `apps/web/src/lib/sessionRollup.ts`.
- Produces:
  - `describeKind(kind: string): string`
  - `interface ActivityTally { published: number; statusChanges: number; total: number }`
  - `tallyActivity(events: ActivityEvent[]): ActivityTally`
  - `describeLessonWeek(tally: ActivityTally, complete: boolean): string`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/lesson-activity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../api/lessonsApi";
import {
	describeKind,
	describeLessonWeek,
	tallyActivity,
} from "../lib/lessonActivity";

function event(kind: string, seq = 1): ActivityEvent {
	return {
		seq,
		kind,
		at: "2026-11-18T10:00:00Z",
		lesson_id: `l${seq}`,
		claim: `claim ${seq}`,
	};
}

describe("describeKind", () => {
	it("uses the feed's words for the two kinds it knows", () => {
		expect(describeKind("create")).toBe("Published");
		expect(describeKind("status")).toBe("Status changed");
	});

	// A kind newer than this build is shown as it is, not hidden.
	it("passes an unknown kind through", () => {
		expect(describeKind("merged")).toBe("merged");
	});
});

describe("tallyActivity", () => {
	it("counts each kind and the total", () => {
		expect(
			tallyActivity([
				event("create", 1),
				event("status", 2),
				event("create", 3),
				event("merged", 4),
			]),
		).toEqual({ published: 2, statusChanges: 1, total: 4 });
	});

	it("counts nothing in an empty feed", () => {
		expect(tallyActivity([])).toEqual({
			published: 0,
			statusChanges: 0,
			total: 0,
		});
	});
});

describe("describeLessonWeek", () => {
	it("names both kinds over a complete week", () => {
		expect(
			describeLessonWeek({ published: 2, statusChanges: 1, total: 3 }, true),
		).toBe("2 published · 1 status change in the last 7 days");
	});

	it("pluralizes status changes", () => {
		expect(
			describeLessonWeek({ published: 1, statusChanges: 2, total: 3 }, true),
		).toBe("1 published · 2 status changes in the last 7 days");
	});

	it("leaves out a kind with no events", () => {
		expect(
			describeLessonWeek({ published: 0, statusChanges: 1, total: 1 }, true),
		).toBe("1 status change in the last 7 days");
		expect(
			describeLessonWeek({ published: 3, statusChanges: 0, total: 3 }, true),
		).toBe("3 published in the last 7 days");
	});

	// The loaded page stops short of the window's start, so a count for the
	// week would claim rows nobody read.
	it("says latest N events when the week is capped", () => {
		expect(
			describeLessonWeek({ published: 1, statusChanges: 1, total: 2 }, false),
		).toBe("1 published · 1 status change in your latest 2 events");
		expect(
			describeLessonWeek({ published: 1, statusChanges: 0, total: 1 }, false),
		).toBe("1 published in your latest 1 event");
	});

	it("falls back to an event count when only unknown kinds are present", () => {
		expect(
			describeLessonWeek({ published: 0, statusChanges: 0, total: 1 }, true),
		).toBe("1 event in the last 7 days");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @onlooker/web test lesson-activity`
Expected: FAIL, because `../lib/lessonActivity` can't be resolved.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/lessonActivity.ts`:

```ts
/**
 * What the lesson feed says happened, in the words both ActivityPage and the
 * home page's Lessons panel use (ONL-298), so the two cannot word one event
 * differently.
 *
 * Pure, like the other home rollups.
 */

import type { ActivityEvent } from "../api/lessonsApi";
import { plural } from "./sessionRollup";

/**
 * What happened, in the order the feed recorded it.
 *
 * A `status` row says only that the status changed. lesson_feed has no from/to
 * columns, and naming the lesson's CURRENT status on a past event would be
 * wrong for anything that changed twice - a lesson retracted in March and
 * reinstated in April would show both events as "active". See the design spec.
 */
export function describeKind(kind: string): string {
	if (kind === "create") return "Published";
	if (kind === "status") return "Status changed";
	return kind;
}

export interface ActivityTally {
	published: number;
	statusChanges: number;
	/** Every event, including kinds newer than this build. */
	total: number;
}

export function tallyActivity(events: ActivityEvent[]): ActivityTally {
	let published = 0;
	let statusChanges = 0;
	for (const event of events) {
		if (event.kind === "create") published += 1;
		else if (event.kind === "status") statusChanges += 1;
	}
	return { published, statusChanges, total: events.length };
}

/**
 * "2 published · 1 status change in the last 7 days". Capped, it says "in
 * your latest N events" instead, for the reason the sessions headline says
 * "most recent": the rows loaded are not the whole window.
 */
export function describeLessonWeek(
	tally: ActivityTally,
	complete: boolean,
): string {
	const parts: string[] = [];
	if (tally.published > 0)
		parts.push(`${tally.published.toLocaleString()} published`);
	if (tally.statusChanges > 0)
		parts.push(plural(tally.statusChanges, "status change"));
	// Only a kind newer than this build leaves both at zero.
	if (parts.length === 0) parts.push(plural(tally.total, "event"));
	const counted = parts.join(" · ");
	return complete
		? `${counted} in the last 7 days`
		: `${counted} in your latest ${plural(tally.total, "event")}`;
}
```

Then in `apps/web/src/pages/ActivityPage.tsx`, use Edit to delete the `describeKind` doc comment and function (lines 10–22; the comment now lives in the lib), and add this import beside the other `../lib/` imports:

```ts
import { describeKind } from "../lib/lessonActivity";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @onlooker/web test lesson-activity`
Expected: PASS, 9 tests.

Run: `pnpm --filter @onlooker/web test activity-page`
Expected: PASS, unchanged. The page's wording came from the same function before the move.

- [ ] **Step 5: Commit**

Through `/git-workflow:commit`, with these files: `apps/web/src/lib/lessonActivity.ts`, `apps/web/src/__tests__/lesson-activity.test.ts`, `apps/web/src/pages/ActivityPage.tsx`. Suggested subject: `refactor(web): word lesson activity in one place`.

---

### Task 2: The Lessons panel

**Files:**
- Create: `apps/web/src/components/HomeLessonsPanel.tsx`
- Create: `apps/web/src/__tests__/home-lessons-panel.test.tsx`

**Interfaces:**
- Consumes: from Task 1, `describeKind`, `tallyActivity` and `describeLessonWeek` in `../lib/lessonActivity`. Also `dayKey` in `../lib/dayKey`, `Panel` in `./ui`, and `PALETTE` in `./palette`.
- Produces:
  - `export const LATEST_EVENTS = 3`
  - `export default function HomeLessonsPanel(props: { events: ActivityEvent[]; complete: boolean; feedEmpty: boolean })`
    - `events`: already filtered to the window, newest first.
    - `complete`: false when more pages remain that may hold events in the window.
    - `feedEmpty`: true when the page loaded held no events at all, in or out of the window.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/home-lessons-panel.test.tsx`:

```tsx
process.env.TZ = "UTC";

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../api/lessonsApi";
import HomeLessonsPanel from "../components/HomeLessonsPanel";

function event(over: Partial<ActivityEvent>): ActivityEvent {
	return {
		seq: 1,
		kind: "create",
		at: "2026-11-18T10:00:00Z",
		lesson_id: "l1",
		claim: "claim",
		...over,
	};
}

// Newest first, as /api/activity returns them.
const week = [
	event({ seq: 4, lesson_id: "l4", claim: "Fourth", at: "2026-11-18T12:00:00Z" }),
	event({
		seq: 3,
		kind: "status",
		lesson_id: "l3",
		claim: "Third",
		at: "2026-11-17T12:00:00Z",
	}),
	event({ seq: 2, lesson_id: "l2", claim: "Second", at: "2026-11-16T12:00:00Z" }),
	event({ seq: 1, lesson_id: "l1", claim: "First", at: "2026-11-15T12:00:00Z" }),
];

function renderPanel(
	events: ActivityEvent[],
	{ complete = true, feedEmpty = false } = {},
) {
	return render(
		<MemoryRouter>
			<HomeLessonsPanel
				events={events}
				complete={complete}
				feedEmpty={feedEmpty}
			/>
		</MemoryRouter>,
	);
}

const headline = () =>
	screen.getByTestId("home-lessons-headline").textContent;

describe("HomeLessonsPanel", () => {
	it("counts the week's events in its headline", () => {
		renderPanel(week);
		expect(headline()).toBe("3 published · 1 status change in the last 7 days");
	});

	it("says latest N events when the week is capped", () => {
		renderPanel(week.slice(0, 2), { complete: false });
		expect(headline()).toBe(
			"1 published · 1 status change in your latest 2 events",
		);
	});

	it("lists the latest 3 events, newest first, each linking to its lesson", () => {
		renderPanel(week);
		const items = screen
			.getByRole("list", { name: "Latest lesson activity" })
			.querySelectorAll("li");
		expect(items).toHaveLength(3);
		const links = Array.from(items).map((li) => li.querySelector("a"));
		expect(links.map((a) => a?.textContent)).toEqual([
			"Fourth",
			"Third",
			"Second",
		]);
		expect(links.map((a) => a?.getAttribute("href"))).toEqual([
			"/lessons/l4",
			"/lessons/l3",
			"/lessons/l2",
		]);
	});

	it("says what happened and on which day", () => {
		renderPanel(week);
		const items = screen
			.getByRole("list", { name: "Latest lesson activity" })
			.querySelectorAll("li");
		expect(items[0].textContent).toMatch(/Published · /);
		expect(items[1].textContent).toMatch(/Status changed · /);
		// The instant survives as an attribute, so this doesn't depend on the
		// runner's locale.
		expect(items[1].querySelector("time")?.getAttribute("dateTime")).toBe(
			"2026-11-17T12:00:00Z",
		);
	});

	it("points at onlooker sync when the feed holds nothing yet", () => {
		renderPanel([], { feedEmpty: true });
		expect(screen.getByText(/No lesson activity yet\./)).toBeDefined();
		expect(screen.getByText("onlooker sync")).toBeDefined();
		expect(screen.queryByTestId("home-lessons-headline")).toBeNull();
	});

	// "Yet" would be false: the feed has events, just none this week.
	it("says the week was quiet when only older events exist", () => {
		renderPanel([], { feedEmpty: false });
		expect(
			screen.getByText("No lesson activity in the last 7 days."),
		).toBeDefined();
		expect(screen.queryByText(/yet/)).toBeNull();
	});

	it("links to the full feed, loaded or empty", () => {
		const { unmount } = renderPanel(week);
		expect(
			screen.getByRole("link", { name: "All lesson activity" }).getAttribute(
				"href",
			),
		).toBe("/activity");
		unmount();
		renderPanel([], { feedEmpty: true });
		expect(
			screen.getByRole("link", { name: "All lesson activity" }).getAttribute(
				"href",
			),
		).toBe("/activity");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @onlooker/web test home-lessons-panel`
Expected: FAIL, because `../components/HomeLessonsPanel` can't be resolved.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/HomeLessonsPanel.tsx`:

```tsx
/**
 * The home page's Lessons panel: what happened to the reader's lessons in the
 * last 7 days (ONL-298).
 *
 * Presentational, like HomePluginsPanel. HomePage hands it the window's
 * events and whether they are all of them; the words for each event come
 * from lib/lessonActivity, which ActivityPage uses too.
 */

import { Link } from "react-router-dom";
import type { ActivityEvent } from "../api/lessonsApi";
import { dayKey } from "../lib/dayKey";
import {
	describeKind,
	describeLessonWeek,
	tallyActivity,
} from "../lib/lessonActivity";
import { PALETTE } from "./palette";
import { Panel } from "./ui";

/** How many of the week's events the panel names. */
export const LATEST_EVENTS = 3;

export default function HomeLessonsPanel({
	events,
	complete,
	feedEmpty,
}: {
	/** Already filtered to the window, newest first. */
	events: ActivityEvent[];
	/** False when more pages remain that may hold events in the window. */
	complete: boolean;
	/** True when the page read held no events at all, in or out of the window. */
	feedEmpty: boolean;
}) {
	const footer = (
		<p style={{ margin: "var(--space-3) 0 0" }}>
			<Link to="/activity" style={{ color: PALETTE.accent }}>
				All lesson activity
			</Link>
		</p>
	);

	if (events.length === 0) {
		return (
			<Panel title="Lessons" icon="Book">
				<p style={{ margin: 0, color: PALETTE.muted }}>
					{feedEmpty ? (
						<>
							No lesson activity yet. A machine publishes its approved lessons
							when it runs <code>onlooker sync</code>.
						</>
					) : (
						"No lesson activity in the last 7 days."
					)}
				</p>
				{footer}
			</Panel>
		);
	}

	// From the window, not the whole page: an event from weeks ago under a
	// "last 7 days" headline would contradict it.
	const latest = events.slice(0, LATEST_EVENTS);

	return (
		<Panel title="Lessons" icon="Book">
			<p data-testid="home-lessons-headline" style={{ margin: 0 }}>
				{describeLessonWeek(tallyActivity(events), complete)}
			</p>
			<ul
				data-testid="home-lessons"
				aria-label="Latest lesson activity"
				style={{
					margin: "var(--space-3) 0 0",
					padding: 0,
					listStyle: "none",
					borderTop: `2px solid ${PALETTE.border}`,
				}}
			>
				{latest.map((event) => (
					<li
						key={event.seq}
						style={{
							padding: "var(--space-3) 0",
							borderBottom: `2px solid ${PALETTE.border}`,
						}}
					>
						<Link to={`/lessons/${event.lesson_id}`}>{event.claim}</Link>
						{/* The day, not the time: the window spans seven of them. */}
						<div
							style={{
								marginTop: "0.15rem",
								color: PALETTE.muted,
								fontSize: "0.9em",
							}}
						>
							{describeKind(event.kind)} ·{" "}
							<time dateTime={event.at}>{dayKey(event.at)}</time>
						</div>
					</li>
				))}
			</ul>
			{footer}
		</Panel>
	);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @onlooker/web test home-lessons-panel`
Expected: PASS, 7 tests.

Run: `pnpm --filter @onlooker/web test panel-icons`
Expected: PASS. `Book` is already in `UNPLATED_ICONS`, since `ActivityPage` uses it.

- [ ] **Step 5: Commit**

Through `/git-workflow:commit`, with these files: `apps/web/src/components/HomeLessonsPanel.tsx`, `apps/web/src/__tests__/home-lessons-panel.test.tsx`. Suggested subject: `feat(web): add the home Lessons panel`.

---

### Task 3: Load the activity feed on Home

**Files:**
- Modify: `apps/web/src/pages/HomePage.tsx`
- Modify: `apps/web/src/__tests__/home-page.test.tsx`

**Interfaces:**
- Consumes: from Task 2, `HomeLessonsPanel` (default export, with props `events`, `complete` and `feedEmpty`). Also `listActivity(): Promise<ActivityFeedPage>`, `ActivityEvent` and `ActivityFeedPage` from `../api/lessonsApi`, plus the existing `withinWindow`, `Windowed`, `Load`, `PanelFor` and `describeError`.
- Produces: nothing later tasks consume.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/__tests__/home-page.test.tsx`, make these changes with Edit:

1. Add `listActivity: vi.fn(),` to the `vi.hoisted` mocks object.
2. After the `labelsApi` mock, add:

```ts
// importOriginal so the types and endpoints stay real; only the read is faked.
vi.mock("../api/lessonsApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/lessonsApi")>()),
	listActivity: mocks.listActivity,
}));
```

3. Add `ActivityEvent` to the type imports: `import type { ActivityEvent } from "../api/lessonsApi";`
4. After the `inventory` helper, add:

```ts
function activity(over: Partial<ActivityEvent> = {}): ActivityEvent {
	return {
		seq: 1,
		kind: "create",
		at: "2026-11-18T09:00:00Z",
		lesson_id: "l1",
		claim: "A lesson",
		...over,
	};
}
```

5. In `beforeEach`, add:

```ts
		mocks.listActivity.mockReset();
		mocks.listActivity.mockResolvedValue({
			events: [],
			cursor: null,
			has_more: false,
		});
```

6. In "shows loading until the sessions arrive", change the comment `// Two panels now load at once; the sessions panel is first.` to `// Several panels load at once; the sessions panel is first.`
7. At the end of the `describe` block, add:

```ts
	it("asks for the first page of lesson activity", async () => {
		mocks.listSessions.mockResolvedValue({ sessions: [], has_more: false });
		renderPage();
		await screen.findByText(/no lesson activity yet/i);
		expect(mocks.listActivity).toHaveBeenCalledWith();
	});

	it("counts only the lesson activity inside the window", async () => {
		mocks.listSessions.mockResolvedValue({ sessions: [], has_more: false });
		mocks.listActivity.mockResolvedValue({
			events: [
				activity({ seq: 2 }),
				activity({ seq: 1, at: "2026-11-05T09:00:00Z" }),
			],
			cursor: "next",
			has_more: true,
		});
		renderPage();
		expect(
			(await screen.findByTestId("home-lessons-headline")).textContent,
		).toBe("1 published in the last 7 days");
	});

	it("says latest N events when the page doesn't reach back to the window's start", async () => {
		mocks.listSessions.mockResolvedValue({ sessions: [], has_more: false });
		mocks.listActivity.mockResolvedValue({
			events: [activity()],
			cursor: "next",
			has_more: true,
		});
		renderPage();
		expect(
			(await screen.findByTestId("home-lessons-headline")).textContent,
		).toBe("1 published in your latest 1 event");
	});

	// Older events exist, so the feed is not empty and "yet" would be false.
	it("says the week was quiet when the feed's events are all older", async () => {
		mocks.listSessions.mockResolvedValue({ sessions: [], has_more: false });
		mocks.listActivity.mockResolvedValue({
			events: [activity({ at: "2026-11-01T09:00:00Z" })],
			cursor: null,
			has_more: false,
		});
		renderPage();
		expect(
			await screen.findByText("No lesson activity in the last 7 days."),
		).toBeDefined();
	});

	// A failed read is not a quiet week, and it blanks only its own panel.
	it("says it could not load lesson activity, and never shows the empty state", async () => {
		mocks.listSessions.mockResolvedValue({ sessions: [], has_more: false });
		mocks.listActivity.mockRejectedValue(new Error("Server unreachable"));
		renderPage();
		const alerts = await screen.findAllByRole("alert");
		expect(alerts).toHaveLength(1);
		expect(alerts[0].textContent).toBe(
			"Could not load your lesson activity. Server unreachable",
		);
		expect(screen.queryByText(/no lesson activity/i)).toBeNull();
		expect(
			await screen.findByText(/no sessions in the last 7 days/i),
		).toBeDefined();
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @onlooker/web test home-page`
Expected: the five new tests FAIL, because there's no Lessons panel to find. The existing tests still PASS.

- [ ] **Step 3: Write the implementation**

In `apps/web/src/pages/HomePage.tsx`, make these changes with Edit:

1. Add these imports:

```ts
import {
	type ActivityEvent,
	type ActivityFeedPage,
	listActivity,
} from "../api/lessonsApi";
import HomeLessonsPanel from "../components/HomeLessonsPanel";
```

2. After the `installed` state, add:

```ts
	const [activity, setActivity] = useState<Load<ActivityFeedPage>>({
		kind: "loading",
	});
```

3. Inside the effect, after the `listMachines()` chain and before `return () => {`, add:

```ts
		listActivity()
			.then((page) => {
				if (active) setActivity({ kind: "loaded", value: page });
			})
			.catch((error: unknown) => {
				if (active) {
					// No fallback sentence, for the reason the sessions read gives.
					setActivity({ kind: "failed", message: describeError(error, "") });
				}
			});
```

4. After the `week` memo, add:

```ts
	// The same window, cut by `at`. Whether the page held anything at all is
	// kept apart, so a quiet week is not mistaken for an empty feed.
	const lessons = useMemo<
		Load<{ week: Windowed<ActivityEvent>; feedEmpty: boolean }>
	>(
		() =>
			activity.kind === "loaded"
				? {
						kind: "loaded",
						value: {
							week: withinWindow(
								activity.value.events,
								(event) => event.at,
								now,
								activity.value.has_more,
							),
							feedEmpty: activity.value.events.length === 0,
						},
					}
				: activity,
		[activity, now],
	);
```

5. After the Plugins `PanelFor`, before the closing `</div>`, add:

```tsx
			<PanelFor
				load={lessons}
				title="Lessons"
				icon="Book"
				loading="Loading your lesson activity…"
				failed={(message) => (
					<p role="alert" style={{ margin: 0 }}>
						{`Could not load your lesson activity. ${message}`.trim()}
					</p>
				)}
			>
				{({ week: lessonWeek, feedEmpty }) => (
					<HomeLessonsPanel
						events={lessonWeek.rows}
						complete={lessonWeek.complete}
						feedEmpty={feedEmpty}
					/>
				)}
			</PanelFor>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @onlooker/web test home-page`
Expected: PASS, every test, old and new.

- [ ] **Step 5: Run the web quality gates**

Run each of these from the repo root:
- `pnpm --filter @onlooker/web test`. Expected: PASS. The last count was 873, and this PR adds 21.
- `pnpm --filter @onlooker/web typecheck`. Expected: clean.
- `pnpm --filter @onlooker/web lint`. Expected: no new findings in the files this PR touches. The known `noExplicitAny` errors in `src/api/mockApi.test.ts` predate this PR. If biome reports formatting, fix it with Edit. Don't run `--write`.

- [ ] **Step 6: Commit**

Through `/git-workflow:commit`, with these files: `apps/web/src/pages/HomePage.tsx`, `apps/web/src/__tests__/home-page.test.tsx`. Suggested subject: `feat(web): show the week's lesson activity on home`.

---

### Task 4: Check it in the browser, then open the PR

No code. This task produces the evidence for the PR.

- [ ] **Step 1: Run the app with seeded data**

From the repo root, run `pnpm dev`, then `pnpm seed:dev` in a second shell. The seed's feed events are stamped when the seed pushes them, so all of them land today and the panel shows its loaded state. If the seed fails with "This lesson could not be stored", apply migrations first: `pnpm --filter @onlooker/api exec wrangler d1 migrations apply onlooker-db-local --local --env development`.

- [ ] **Step 2: Look at `/home`**

Use the claude-in-chrome tools, signed in as a seed account. Check:
- The Lessons panel sits below Plugins, with a headline, three events and an "All lesson activity" link to `/activity`.
- Each event's claim opens `/lessons/:id`.
- Light and dark themes.
- Phone width (390px): no horizontal scroll, and long claims wrap.

Take a screenshot of each.

- [ ] **Step 3: Open the PR**

Through `/git-workflow:pr`. Base `main`, branch `meagan/onl-298-home-lessons`. The body says this is PR 3 of 3 for ONL-298, and that Linear moves to Done only after the production check. So write `Refs ONL-298`, not `Closes`. Attach the screenshots.

- [ ] **Step 4: Update the bead**

`bd update onlooker-l0njh6.3 --append-notes "<PR URL, test counts, browser check results>"`. Close it, and the epic `onlooker-l0njh6`, only after the deploy succeeds and the panel is checked in production.
