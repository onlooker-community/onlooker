# Web home page, PR 1: route and Recent sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user lands on a new `/home` page whose first panel summarizes their sessions over the last 7 days.

**Architecture:** Web only. `HomePage` reads `/api/sessions` (one page of 200) and the user's project labels, filters the rows to a 7-calendar-day window with a pure `lib/homeWindow.ts`, and hands them to a presentational `HomeSessionsPanel` that reuses `lib/sessionRollup.ts`. The day bar row is pulled out of `SessionsSummary` into `DayBar` so both pages draw days the same way.

**Tech Stack:** React 18, react-router-dom 6, Vitest + Testing Library (jsdom), Biome.

Spec: `docs/superpowers/specs/2026-11-18-web-home-dashboard-design.md`. Linear: ONL-298. Bead: `onlooker-l0njh6`.

PRs 2 (Plugins panel) and 3 (Lessons panel) get their own plans after this one merges.

## Global Constraints

- Work in the worktree `/Users/meaganwaller/src/github.com/onlooker-community/onlooker-onl-298`, branch `meagan/onl-298-home-dashboard`.
- Edit tracked files with the Edit/Write tools, never `sed -i` or heredocs (CLAUDE.md, lineage).
- Never run a formatter that writes (`biome check --write`, `pnpm lint:fix`). Run `pnpm --filter @onlooker/web lint` to check, and fix what it reports with Edit.
- Run one test file with `pnpm --filter @onlooker/web test <name>` — the name straight after `test`, **no `--`**. `test -- <name>` runs the whole suite.
- Commit through `/git-workflow:commit` only. American English everywhere.
- Every test file that renders dates starts with `process.env.TZ = "UTC";` before any import, as `sessions-summary.test.tsx` does.
- The window is today and the six days before it, from local midnight. Not 168 hours.
- A failed request renders an error, never an empty state.
- No change under `apps/cli` or `apps/api`.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `apps/web/src/lib/homeWindow.ts` | create | The 7-day window: its start, its day labels, which rows fall in it, whether the loaded rows cover it |
| `apps/web/src/__tests__/home-window.test.ts` | create | Unit tests for the above |
| `apps/web/src/components/DayBar.tsx` | create | One day's label, bar and counts |
| `apps/web/src/__tests__/day-bar.test.tsx` | create | The zero-session case |
| `apps/web/src/components/SessionsSummary.tsx` | modify | Render days through `DayBar` |
| `apps/web/src/components/HomeSessionsPanel.tsx` | create | Recent sessions panel, presentational |
| `apps/web/src/__tests__/home-sessions-panel.test.tsx` | create | Panel states |
| `apps/web/src/pages/HomePage.tsx` | create | Loading and per-panel state |
| `apps/web/src/__tests__/home-page.test.tsx` | create | Page states against mocked APIs |
| `apps/web/src/components/sections.ts` | modify | Home first in `SECTIONS` |
| `packages/brand/index.ts` | modify | `Sun` in `UNPLATED_ICONS` |
| `apps/web/src/App.tsx` | modify | `/home` route; `RootRedirect` to `/home` |
| `apps/web/src/__tests__/root-redirect.test.tsx` | modify | Signed-in lands on Home |

---

### Task 1: `lib/homeWindow.ts`

**Files:**
- Create: `apps/web/src/lib/homeWindow.ts`
- Test: `apps/web/src/__tests__/home-window.test.ts`

**Interfaces:**
- Consumes: `dayKey(iso: string): string` from `apps/web/src/lib/dayKey.ts`.
- Produces:
  - `WINDOW_DAYS: 7`
  - `windowStart(now: Date): Date`
  - `windowDays(now: Date): string[]` — `dayKey` labels, today first, length 7
  - `interface Windowed<T> { rows: T[]; complete: boolean }`
  - `withinWindow<T>(rows: T[], at: (row: T) => string, now: Date, hasMore: boolean): Windowed<T>`

- [ ] **Step 1: Write the failing test**

```ts
process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import {
	WINDOW_DAYS,
	windowDays,
	windowStart,
	withinWindow,
} from "../lib/homeWindow";

// 2026-11-18 is a Wednesday, so the window opens on Thursday the 12th.
const NOW = new Date("2026-11-18T15:00:00Z");

const at = (row: { at: string }) => row.at;

describe("windowStart", () => {
	it("is local midnight six days before today", () => {
		expect(windowStart(NOW).toISOString()).toBe("2026-11-12T00:00:00.000Z");
	});
});

describe("windowDays", () => {
	it("names seven days, today first", () => {
		const days = windowDays(NOW);
		expect(days).toHaveLength(WINDOW_DAYS);
		expect(days[0]).toBe("Wednesday, November 18");
		expect(days[6]).toBe("Thursday, November 12");
	});
});

describe("withinWindow", () => {
	it("keeps rows from the window's first midnight on, and drops older ones", () => {
		const rows = [
			{ at: "2026-11-18T10:00:00Z" },
			{ at: "2026-11-12T00:00:00Z" },
			{ at: "2026-11-11T23:59:59Z" },
		];
		const { rows: inside } = withinWindow(rows, at, NOW, false);
		expect(inside.map((r) => r.at)).toEqual([
			"2026-11-18T10:00:00Z",
			"2026-11-12T00:00:00Z",
		]);
	});

	// The pages not loaded are older than a row already outside the window,
	// so nothing in the window is missing.
	it("is complete when a loaded row falls before the window, even with more pages", () => {
		const rows = [{ at: "2026-11-18T10:00:00Z" }, { at: "2026-11-01T10:00:00Z" }];
		expect(withinWindow(rows, at, NOW, true).complete).toBe(true);
	});

	// The case the panel's "most recent N" wording exists for.
	it("is incomplete when every loaded row is inside the window and more pages remain", () => {
		const rows = [{ at: "2026-11-18T10:00:00Z" }, { at: "2026-11-13T10:00:00Z" }];
		expect(withinWindow(rows, at, NOW, true).complete).toBe(false);
	});

	it("is complete when the API has no more pages", () => {
		const rows = [{ at: "2026-11-18T10:00:00Z" }];
		expect(withinWindow(rows, at, NOW, false).complete).toBe(true);
	});

	it("is complete and empty for no rows and no more pages", () => {
		expect(withinWindow([], at, NOW, false)).toEqual({
			rows: [],
			complete: true,
		});
	});

	// A malformed timestamp is in no window. Counting it would put a row in
	// the headline that no day bar contains.
	it("skips a row whose timestamp does not parse", () => {
		const rows = [{ at: "not a date" }, { at: "2026-11-18T10:00:00Z" }];
		expect(withinWindow(rows, at, NOW, false).rows).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @onlooker/web test home-window`
Expected: FAIL, "Failed to resolve import "../lib/homeWindow"".

- [ ] **Step 3: Write the implementation**

```ts
/**
 * The home page's window: today and the six days before it, in the reader's
 * own timezone (ONL-298).
 *
 * Calendar days rather than 168 hours, so the seven day bars and the headline
 * count describe the same rows. A 168-hour window would count a session from
 * seven days ago this afternoon that no bar shows.
 *
 * Pure, with `now` passed in, so tests pin the clock without faking timers.
 */

import { dayKey } from "./dayKey";

export const WINDOW_DAYS = 7;

/** Local midnight at the start of the window. */
export function windowStart(now: Date): Date {
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	start.setDate(start.getDate() - (WINDOW_DAYS - 1));
	return start;
}

/**
 * The window's days, today first, labeled the way `dayKey` labels a row - so
 * they match `rollupSessions`'s `days[].day` exactly.
 */
export function windowDays(now: Date): string[] {
	const start = windowStart(now);
	return Array.from({ length: WINDOW_DAYS }, (_, i) => {
		const day = new Date(start);
		day.setDate(start.getDate() + (WINDOW_DAYS - 1 - i));
		return dayKey(day.toISOString());
	});
}

export interface Windowed<T> {
	/** The rows inside the window, in their input order. */
	rows: T[];
	/**
	 * True when `rows` is every row the window holds: the API has no more
	 * pages, or a loaded row already falls before the window's start, so the
	 * unloaded pages are older still. Relies on newest-first input, which is
	 * what /api/sessions and /api/activity both return.
	 */
	complete: boolean;
}

export function withinWindow<T>(
	rows: T[],
	at: (row: T) => string,
	now: Date,
	hasMore: boolean,
): Windowed<T> {
	const start = windowStart(now).getTime();
	const inside: T[] = [];
	let reachedBefore = false;
	for (const row of rows) {
		const time = new Date(at(row)).getTime();
		// In no window, and in no day bar either.
		if (Number.isNaN(time)) continue;
		if (time >= start) inside.push(row);
		else reachedBefore = true;
	}
	return { rows: inside, complete: !hasMore || reachedBefore };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @onlooker/web test home-window`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

Through `/git-workflow:commit`, files `apps/web/src/lib/homeWindow.ts` and `apps/web/src/__tests__/home-window.test.ts`. Suggested subject: `feat(web): define the home page's seven-day window`. Body: why calendar days, not 168 hours. `Refs ONL-298`.

---

### Task 2: Pull `DayBar` out of `SessionsSummary`

**Files:**
- Create: `apps/web/src/components/DayBar.tsx`
- Modify: `apps/web/src/components/SessionsSummary.tsx` (the `visibleDays.map(...)` block)
- Test: `apps/web/src/__tests__/day-bar.test.tsx`; `apps/web/src/__tests__/sessions-summary.test.tsx` must stay green unchanged

**Interfaces:**
- Consumes: `plural`, `formatDurationMs` from `lib/sessionRollup.ts`; `PALETTE` from `components/palette.ts`.
- Produces: `default function DayBar(props: { label: string; sessions: number; durationMs: number; busiestMs: number }): JSX.Element`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import DayBar from "../components/DayBar";

function fill(container: HTMLElement): HTMLElement {
	const el = container.querySelector<HTMLElement>("[data-testid='day-bar-fill']");
	if (!el) throw new Error("no fill");
	return el;
}

describe("DayBar", () => {
	it("fills relative to the busiest day", () => {
		const { container } = render(
			<DayBar label="Monday" sessions={2} durationMs={1_800_000} busiestMs={3_600_000} />,
		);
		expect(fill(container).style.width).toBe("50%");
		expect(screen.getByText("2 sessions · 30m")).toBeTruthy();
	});

	// SessionsSummary only ever drew days that had sessions, so a 2% floor
	// kept a short day visible. The home panel draws all seven, and a sliver
	// on an empty day would claim work that did not happen.
	it("draws an empty track for a day with no sessions", () => {
		const { container } = render(
			<DayBar label="Sunday" sessions={0} durationMs={0} busiestMs={3_600_000} />,
		);
		expect(fill(container).style.width).toBe("0%");
		expect(screen.getByText("0 sessions")).toBeTruthy();
	});

	it("keeps a 2% sliver for a day with sessions but no ended duration", () => {
		const { container } = render(
			<DayBar label="Saturday" sessions={1} durationMs={0} busiestMs={3_600_000} />,
		);
		expect(fill(container).style.width).toBe("2%");
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @onlooker/web test day-bar`
Expected: FAIL, "Failed to resolve import "../components/DayBar"".

- [ ] **Step 3: Create `DayBar.tsx`**

Move the row JSX and its comments out of `SessionsSummary.tsx` unchanged, except the fill width and a `data-testid`:

```tsx
/**
 * One day's row: its label, a bar for its time, and its counts.
 *
 * Pulled out of SessionsSummary so the home page draws days the same way the
 * Sessions page does (ONL-298). The comments below came with it.
 */

import { formatDurationMs, plural } from "../lib/sessionRollup";
import { PALETTE } from "./palette";

export default function DayBar({
	label,
	sessions,
	durationMs,
	busiestMs,
}: {
	label: string;
	sessions: number;
	durationMs: number;
	/** The longest day on screen, so the busiest bar is full width. */
	busiestMs: number;
}) {
	// A 2% floor keeps a day that had sessions visible, however short. A day
	// with none gets an empty track instead: the home panel draws every day of
	// its window, and a sliver there would claim work that did not happen.
	const width =
		sessions === 0 ? 0 : Math.max(2, (durationMs / Math.max(busiestMs, 1)) * 100);

	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: "var(--space-3)",
				padding: "0.2rem 0",
				// [move the existing flexWrap comment from SessionsSummary here verbatim]
				flexWrap: "wrap",
			}}
		>
			{/* [move the existing `0 1 12rem` comment here verbatim] */}
			<span style={{ flex: "0 1 12rem" }}>{label}</span>
			<span
				aria-hidden="true"
				style={{
					// [move the existing track comments here verbatim]
					flex: "0 1 8rem",
					height: "0.5rem",
					border: "2px solid var(--ink-dim)",
					borderRadius: "2px",
				}}
			>
				<span
					data-testid="day-bar-fill"
					style={{
						display: "block",
						height: "100%",
						width: `${width}%`,
						background: PALETTE.accent,
						borderRadius: "2px",
					}}
				/>
			</span>
			<span style={{ color: PALETTE.muted }}>
				{plural(sessions, "session")}
				{durationMs ? ` · ${formatDurationMs(durationMs)}` : ""}
			</span>
		</div>
	);
}
```

The bracketed lines are not placeholders for new prose: they mark where the three existing comment blocks in `SessionsSummary.tsx` (about `flexWrap` and ONL-174, about `0 1 12rem`, and about the track having no background) move to, word for word.

- [ ] **Step 4: Use it in `SessionsSummary.tsx`**

Replace the whole `{visibleDays.map((day) => ( <div key={day.day} ...> ... </div> ))}` block with:

```tsx
			{visibleDays.map((day) => (
				<DayBar
					key={day.day}
					label={day.day}
					sessions={day.sessions}
					durationMs={day.durationMs}
					busiestMs={busiest}
				/>
			))}
```

Add `import DayBar from "./DayBar";`, and drop `formatDurationMs` from the `../lib/sessionRollup` import only if the longest-session line no longer uses it. It still does, so keep it. `busiest` keeps its existing computation and comment.

- [ ] **Step 5: Run both test files**

Run: `pnpm --filter @onlooker/web test day-bar` then `pnpm --filter @onlooker/web test sessions-summary`
Expected: PASS for both. `sessions-summary` must pass with no edits to it — that is the check that the move changed nothing.

- [ ] **Step 6: Commit**

Through `/git-workflow:commit`, files `apps/web/src/components/DayBar.tsx`, `apps/web/src/components/SessionsSummary.tsx`, `apps/web/src/__tests__/day-bar.test.tsx`. Suggested subject: `refactor(web): draw a session day through one DayBar`. `Refs ONL-298`.

---

### Task 3: `HomeSessionsPanel`

**Files:**
- Create: `apps/web/src/components/HomeSessionsPanel.tsx`
- Test: `apps/web/src/__tests__/home-sessions-panel.test.tsx`

**Interfaces:**
- Consumes: `DayBar` (Task 2); `rollupSessions`, `rollupProjects`, `plural`, `formatDurationMs` from `lib/sessionRollup.ts`; `projectName(key, machineId, labels): string` from `lib/projectEntries.ts`; `type LabelMap` from `api/labelsApi.ts`; `type SessionSummary` from `api/sessionsApi.ts`; `Panel` from `components/ui.tsx`.
- Produces: `default function HomeSessionsPanel(props: { sessions: SessionSummary[]; complete: boolean; days: string[]; labels: LabelMap }): JSX.Element` and `export const TOP_REPOSITORIES = 3`.

- [ ] **Step 1: Write the failing test**

```tsx
process.env.TZ = "UTC";

import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { labelIdentity } from "../api/labelsApi";
import type { SessionSummary } from "../api/sessionsApi";
import HomeSessionsPanel from "../components/HomeSessionsPanel";

const DAYS = [
	"Wednesday, November 18",
	"Tuesday, November 17",
	"Monday, November 16",
	"Sunday, November 15",
	"Saturday, November 14",
	"Friday, November 13",
	"Thursday, November 12",
];

function session(over: Partial<SessionSummary> = {}): SessionSummary {
	return {
		session_id: "s1",
		machine_id: "m1",
		started_at: "2026-11-18T10:00:00Z",
		ended_at: "2026-11-18T11:00:00Z",
		event_count: 40,
		counts_by_prefix: {},
		counts_by_type: {},
		counts_by_project: {},
		plugins: [],
		prompts: 3,
		compactions: 0,
		...over,
	};
}

function renderPanel(props: Partial<Parameters<typeof HomeSessionsPanel>[0]> = {}) {
	return render(
		<MemoryRouter>
			<HomeSessionsPanel
				sessions={[]}
				complete={true}
				days={DAYS}
				labels={new Map()}
				{...props}
			/>
		</MemoryRouter>,
	);
}

describe("HomeSessionsPanel", () => {
	it("states the window's total when complete", () => {
		renderPanel({
			sessions: [
				session({ session_id: "a" }),
				session({
					session_id: "b",
					started_at: "2026-11-16T09:00:00Z",
					ended_at: "2026-11-16T10:00:00Z",
				}),
			],
		});
		expect(screen.getByTestId("home-sessions-headline").textContent).toBe(
			"2 sessions · 2h 0m in the last 7 days",
		);
	});

	it("says what it loaded, not a total, when capped", () => {
		renderPanel({ sessions: [session()], complete: false });
		expect(screen.getByTestId("home-sessions-headline").textContent).toBe(
			"most recent 1 session · 1h 0m",
		);
	});

	// Seven bars whatever the data, so a quiet day reads as quiet rather than
	// as missing.
	it("draws a bar for every day in the window, empty days included", () => {
		renderPanel({ sessions: [session()] });
		for (const day of DAYS) expect(screen.getByText(day)).toBeTruthy();
		expect(screen.getAllByText("0 sessions")).toHaveLength(6);
	});

	it("names the top three repositories, by the user's label where there is one", () => {
		const project = (event_count: number) => ({
			basis: "remote" as const,
			event_count,
		});
		renderPanel({
			sessions: [
				session({
					counts_by_project: {
						aaaaaaaaaaaa: project(30),
						bbbbbbbbbbbb: project(20),
						cccccccccccc: project(10),
						dddddddddddd: project(5),
					},
				}),
			],
			labels: new Map([[labelIdentity("aaaaaaaaaaaa", null), "onlooker"]]),
		});
		const list = screen.getByTestId("home-repositories");
		const rows = within(list).getAllByRole("listitem");
		expect(rows.map((row) => row.textContent)).toEqual([
			"onlooker · 30 events",
			"bbbbbbbbbbbb · 20 events",
			"cccccccccccc · 10 events",
		]);
	});

	it("leaves out the repository list when no session carried a repository", () => {
		renderPanel({ sessions: [session()] });
		expect(screen.queryByTestId("home-repositories")).toBeNull();
	});

	it("says so when the window holds no sessions", () => {
		renderPanel({ sessions: [] });
		expect(screen.getByText(/no sessions in the last 7 days/i)).toBeTruthy();
		expect(screen.queryByTestId("home-sessions-headline")).toBeNull();
	});

	it("links to the full feed", () => {
		renderPanel({ sessions: [session()] });
		expect(
			screen.getByRole("link", { name: /all sessions/i }).getAttribute("href"),
		).toBe("/sessions");
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @onlooker/web test home-sessions-panel`
Expected: FAIL, "Failed to resolve import "../components/HomeSessionsPanel"".

- [ ] **Step 3: Write the implementation**

```tsx
/**
 * The home page's first panel: the last 7 days of sessions (ONL-298).
 *
 * Presentational, like SessionsSummary. HomePage decides which rows are in
 * the window and whether they are all of them; this states what it is given,
 * through the same rollups the Sessions page uses, so the two pages cannot
 * disagree about a number.
 */

import { Link } from "react-router-dom";
import type { LabelMap } from "../api/labelsApi";
import type { SessionSummary } from "../api/sessionsApi";
import { projectName } from "../lib/projectEntries";
import {
	formatDurationMs,
	plural,
	rollupProjects,
	rollupSessions,
} from "../lib/sessionRollup";
import DayBar from "./DayBar";
import { PALETTE } from "./palette";
import { Panel } from "./ui";

export const TOP_REPOSITORIES = 3;

export default function HomeSessionsPanel({
	sessions,
	complete,
	days,
	labels,
}: {
	/** Already filtered to the window. */
	sessions: SessionSummary[];
	/** False when more pages remain that may hold sessions in the window. */
	complete: boolean;
	/** The window's day labels, today first - see windowDays. */
	days: string[];
	labels: LabelMap;
}) {
	const footer = (
		<p style={{ margin: "var(--space-3) 0 0" }}>
			<Link to="/sessions" style={{ color: PALETTE.accent }}>
				All sessions
			</Link>
		</p>
	);

	if (sessions.length === 0) {
		return (
			<Panel title="Recent sessions" icon="Monitor">
				<p style={{ margin: 0, color: PALETTE.muted }}>
					No sessions in the last 7 days. A machine reports its sessions when
					it runs <code>onlooker sync</code>.
				</p>
				{footer}
			</Panel>
		);
	}

	const rollup = rollupSessions(sessions, !complete);
	const byDay = new Map(rollup.days.map((day) => [day.day, day]));
	const busiest = Math.max(...days.map((day) => byDay.get(day)?.durationMs ?? 0));
	const total = formatDurationMs(rollup.durationMs);
	const top = rollupProjects(sessions).projects.slice(0, TOP_REPOSITORIES);

	const counted = plural(rollup.sessions, "session");
	const headline = complete
		? `${counted}${total ? ` · ${total}` : ""} in the last 7 days`
		: `most recent ${counted}${total ? ` · ${total}` : ""}`;

	return (
		<Panel title="Recent sessions" icon="Monitor">
			<div
				data-testid="home-sessions-headline"
				style={{ marginBottom: "var(--space-3)" }}
			>
				{headline}
			</div>

			{days.map((day) => (
				<DayBar
					key={day}
					label={day}
					sessions={byDay.get(day)?.sessions ?? 0}
					durationMs={byDay.get(day)?.durationMs ?? 0}
					busiestMs={busiest}
				/>
			))}

			{top.length > 0 ? (
				<ul
					data-testid="home-repositories"
					style={{ margin: "var(--space-3) 0 0", padding: 0, listStyle: "none" }}
				>
					{top.map((project) => (
						<li key={`${project.machineId ?? ""}:${project.key}`}>
							{projectName(project.key, project.machineId, labels)} ·{" "}
							{plural(project.events, "event")}
						</li>
					))}
				</ul>
			) : null}

			{footer}
		</Panel>
	);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @onlooker/web test home-sessions-panel`
Expected: PASS, 7 tests. Then `pnpm --filter @onlooker/web test panel-icons` — PASS, since `Monitor` is already in `UNPLATED_ICONS`.

- [ ] **Step 5: Commit**

Through `/git-workflow:commit`, files `apps/web/src/components/HomeSessionsPanel.tsx` and `apps/web/src/__tests__/home-sessions-panel.test.tsx`. Suggested subject: `feat(web): summarize the week's sessions in one panel`. `Refs ONL-298`.

---

### Task 4: `HomePage`, the route, the nav entry and the redirect

**Files:**
- Create: `apps/web/src/pages/HomePage.tsx`
- Create: `apps/web/src/__tests__/home-page.test.tsx`
- Modify: `apps/web/src/components/sections.ts` (top of `SECTIONS`)
- Modify: `packages/brand/index.ts` (`UNPLATED_ICONS`)
- Modify: `apps/web/src/App.tsx` (import, `RootRedirect` and its comment, a `/home` route)
- Modify: `apps/web/src/__tests__/root-redirect.test.tsx`

**Interfaces:**
- Consumes: `withinWindow`, `windowDays` (Task 1); `HomeSessionsPanel` (Task 3); `listSessions(options?: { limit?: number }): Promise<SessionsPage>` and `type SessionsPage`, `type SessionSummary` from `api/sessionsApi.ts`; `listLabels(): Promise<LabelMap>` from `api/labelsApi.ts`; `describeError(error, fallback)` from `lib/apiErrors.ts`; `Loading`, `Panel` from `components/ui.tsx`.
- Produces: `default function HomePage(): JSX.Element`; `export const SESSIONS_LIMIT = 200`.

- [ ] **Step 1: Write the failing page test**

```tsx
process.env.TZ = "UTC";

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../api/sessionsApi";
import HomePage from "../pages/HomePage";

const mocks = vi.hoisted(() => ({
	listSessions: vi.fn(),
	listLabels: vi.fn(),
}));

vi.mock("../api/sessionsApi", () => ({
	SESSION_ENDPOINTS: { sessions: "/api/sessions" },
	listSessions: mocks.listSessions,
}));

// importOriginal so labelIdentity stays real, as sessions-page.test.tsx does.
vi.mock("../api/labelsApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/labelsApi")>()),
	listLabels: mocks.listLabels,
}));

function session(over: Partial<SessionSummary> = {}): SessionSummary {
	return {
		session_id: "s1",
		machine_id: "m1",
		started_at: "2026-11-18T10:00:00Z",
		ended_at: "2026-11-18T11:00:00Z",
		event_count: 40,
		counts_by_prefix: {},
		counts_by_type: {},
		counts_by_project: {},
		plugins: [],
		prompts: 3,
		compactions: 0,
		...over,
	};
}

function renderPage() {
	return render(
		<MemoryRouter>
			<HomePage />
		</MemoryRouter>,
	);
}

describe("HomePage", () => {
	beforeEach(() => {
		// Date only, so promises and Testing Library's polling still run.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-18T15:00:00Z"));
		mocks.listSessions.mockReset();
		mocks.listLabels.mockReset();
		mocks.listLabels.mockResolvedValue(new Map());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("asks for one page of 200", async () => {
		mocks.listSessions.mockResolvedValue({ sessions: [], cursor: null, has_more: false });
		renderPage();
		await screen.findByText(/no sessions in the last 7 days/i);
		expect(mocks.listSessions).toHaveBeenCalledWith({ limit: 200 });
	});

	it("shows loading until the sessions arrive", () => {
		mocks.listSessions.mockReturnValue(new Promise(() => {}));
		renderPage();
		expect(screen.getByRole("status").textContent).toMatch(/loading your sessions/i);
	});

	it("counts only the sessions inside the window", async () => {
		mocks.listSessions.mockResolvedValue({
			sessions: [
				session({ session_id: "in" }),
				session({
					session_id: "out",
					started_at: "2026-11-10T10:00:00Z",
					ended_at: "2026-11-10T11:00:00Z",
				}),
			],
			cursor: "next",
			has_more: true,
		});
		renderPage();
		expect((await screen.findByTestId("home-sessions-headline")).textContent).toBe(
			"1 session · 1h 0m in the last 7 days",
		);
	});

	it("says most recent when 200 rows don't reach back to the window's start", async () => {
		mocks.listSessions.mockResolvedValue({
			sessions: [session()],
			cursor: "next",
			has_more: true,
		});
		renderPage();
		expect((await screen.findByTestId("home-sessions-headline")).textContent).toMatch(
			/^most recent 1 session/,
		);
	});

	// A failed read is not an empty week.
	it("says it could not load, and never shows the empty state, when the read fails", async () => {
		mocks.listSessions.mockRejectedValue(new Error("Server unreachable"));
		renderPage();
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toMatch(/could not load your sessions/i);
		expect(alert.textContent).toMatch(/server unreachable/i);
		expect(screen.queryByText(/no sessions in the last 7 days/i)).toBeNull();
	});

	// Labels only rename keys. Without them every repository shows its key,
	// which is what the Sessions page does too.
	it("still renders the panel when the labels read fails", async () => {
		mocks.listLabels.mockRejectedValue(new Error("nope"));
		mocks.listSessions.mockResolvedValue({ sessions: [session()], cursor: null, has_more: false });
		renderPage();
		expect(await screen.findByTestId("home-sessions-headline")).toBeTruthy();
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @onlooker/web test home-page`
Expected: FAIL, "Failed to resolve import "../pages/HomePage"".

- [ ] **Step 3: Write `HomePage.tsx`**

```tsx
import { useEffect, useState } from "react";
import { type LabelMap, listLabels } from "../api/labelsApi";
import { listSessions, type SessionsPage } from "../api/sessionsApi";
import HomeSessionsPanel from "../components/HomeSessionsPanel";
import { Loading, Panel } from "../components/ui";
import { describeError } from "../lib/apiErrors";
import { windowDays, withinWindow } from "../lib/homeWindow";

// The landing page for a signed-in person (ONL-298): a summary of the last 7
// days, each panel linking through to its section. Every panel loads and
// fails on its own, so one failed read blanks one panel rather than the page.

/** One page of 200, as SessionsPage asks for, so the two read the same rows. */
export const SESSIONS_LIMIT = 200;

/**
 * A read in three states. "Failed" is kept apart from "loaded and empty" so a
 * panel can never render an empty week for a read that did not succeed.
 */
type Load<T> =
	| { kind: "loading" }
	| { kind: "loaded"; value: T }
	| { kind: "failed"; message: string };

export default function HomePage() {
	// Fixed at mount: the window must not move under rows already loaded.
	const [now] = useState(() => new Date());
	const [sessions, setSessions] = useState<Load<SessionsPage>>({
		kind: "loading",
	});
	// Empty until read, and empty if the read fails: every repository then
	// shows its key, as on the Sessions page.
	const [labels, setLabels] = useState<LabelMap>(new Map());

	useEffect(() => {
		let active = true;
		listSessions({ limit: SESSIONS_LIMIT })
			.then((page) => {
				if (active) setSessions({ kind: "loaded", value: page });
			})
			.catch((error: unknown) => {
				if (active) {
					setSessions({
						kind: "failed",
						// No fallback sentence: the alert already opens with one, and
						// a non-Error rejection would otherwise read it twice.
						message: describeError(error, ""),
					});
				}
			});
		listLabels()
			.then((loaded) => {
				if (active) setLabels(loaded);
			})
			.catch(() => {
				// Deliberately quiet; see the state's own comment.
			});
		return () => {
			active = false;
		};
	}, []);

	return (
		<div style={{ display: "grid", gap: "var(--space-5)", maxWidth: "720px" }}>
			{sessions.kind === "loading" ? (
				<Panel title="Recent sessions" icon="Monitor">
					<Loading label="Loading your sessions…" />
				</Panel>
			) : sessions.kind === "failed" ? (
				<Panel title="Recent sessions" icon="Monitor">
					<p role="alert" style={{ margin: 0 }}>
						{`Could not load your sessions. ${sessions.message}`.trim()}
					</p>
				</Panel>
			) : (
				(() => {
					const windowed = withinWindow(
						sessions.value.sessions,
						(session) => session.started_at,
						now,
						sessions.value.has_more,
					);
					return (
						<HomeSessionsPanel
							sessions={windowed.rows}
							complete={windowed.complete}
							days={windowDays(now)}
							labels={labels}
						/>
					);
				})()
			)}
		</div>
	);
}
```

- [ ] **Step 4: Run the page test**

Run: `pnpm --filter @onlooker/web test home-page`
Expected: PASS, 6 tests.

- [ ] **Step 5: Change the root-redirect test first**

In `apps/web/src/__tests__/root-redirect.test.tsx`:

Add these two mocks after the existing `vi.mock("../api/lessonsApi", ...)`:

```tsx
// The signed-in case lands on /home now, which reads sessions and labels on
// mount (ONL-298).
vi.mock("../api/sessionsApi", () => ({
	SESSION_ENDPOINTS: { sessions: "/api/sessions" },
	listSessions: () =>
		Promise.resolve({ sessions: [], cursor: null, has_more: false }),
}));
vi.mock("../api/labelsApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/labelsApi")>()),
	listLabels: () => Promise.resolve(new Map()),
}));
```

Replace the `"sends a signed-in person to the pool"` test with:

```tsx
	it("sends a signed-in person home", async () => {
		authState.user = { id: "u1", email: "someone@example.com" };

		render(
			<MemoryRouter initialEntries={["/"]}>
				<App />
			</MemoryRouter>,
		);

		expect(
			await screen.findByRole("heading", { level: 1, name: "Home" }),
		).toBeDefined();
	});
```

Run: `pnpm --filter @onlooker/web test root-redirect`
Expected: FAIL on "sends a signed-in person home" — the h1 still says "Lessons".

- [ ] **Step 6: Add the nav entry, the icon, the route and the redirect**

`apps/web/src/components/sections.ts`, first entry of `SECTIONS`:

```ts
	// Sun: the week at a glance. Home is Orgs' already, and Sun clears the
	// coverage floor in packages/brand/assets.test.ts on every moving ground
	// (probed 2026-11-18, with Briefcase failing at 5% to prove the probe
	// measured). See ONL-298.
	{ to: "/home", label: "Home", icon: "Sun" },
```

`packages/brand/index.ts`, in `UNPLATED_ICONS` after `"Home",`:

```ts
	// The Home nav link (ONL-298).
	"Sun",
```

`apps/web/src/App.tsx`:
- `import HomePage from "./pages/HomePage";` in alphabetical order, after `ForgotPasswordPage`.
- In `RootRedirect`: `return <Navigate to={user ? "/home" : "/login"} replace />;`
- In its doc comment, replace the paragraph beginning "onlooker-yfw deleted the placeholder dashboard" with:

```tsx
 * onlooker-yfw deleted the placeholder dashboard and landed signed-in people
 * on /lessons. ONL-298 gave them a real one: /home summarizes the week and
 * links into each section.
```

- A route, before `/settings`:

```tsx
						<Route
							path="/home"
							element={
								<Protected>
									<HomePage />
								</Protected>
							}
						/>
```

- [ ] **Step 7: Run the affected tests**

Run each, expecting PASS:
- `pnpm --filter @onlooker/web test root-redirect`
- `pnpm --filter @onlooker/web test shell-headings` — now also renders `/home` and checks its h1 is "Home"
- `pnpm --filter @onlooker/web test titles`
- `pnpm --filter @onlooker/web test app-shell`
- `pnpm --filter @onlooker/web test home-page`
- `pnpm --filter @onlooker/brand test` — `Sun stays legible on every moving ground` passes

If `shell-headings` fails on an unmocked call from `HomePage`, add a `listLabels` stub to its `labelsApi` mock (or add a `labelsApi` mock with `importOriginal`, as above). Don't skip the route.

- [ ] **Step 8: Commit**

Through `/git-workflow:commit`, files `apps/web/src/pages/HomePage.tsx`, `apps/web/src/__tests__/home-page.test.tsx`, `apps/web/src/components/sections.ts`, `packages/brand/index.ts`, `apps/web/src/App.tsx`, `apps/web/src/__tests__/root-redirect.test.tsx`, and `shell-headings.test.tsx` if Step 7 needed it. Suggested subject: `feat(web): land signed-in people on a home page`. `Refs ONL-298`.

---

### Task 5: Whole-suite gates, the browser, and the PR

**Files:** none new. The spec edits from planning (`docs/superpowers/specs/2026-11-18-web-home-dashboard-design.md`) and this plan get committed here if not already.

- [ ] **Step 1: Run the gates**

- `pnpm --filter @onlooker/web test` — every file passes.
- `pnpm --filter @onlooker/brand test` — passes.
- `pnpm typecheck` — clean.
- `pnpm --filter @onlooker/web lint` — clean. Fix anything it reports with Edit; never `--write`.

- [ ] **Step 2: Look at it in the browser**

Start `pnpm --filter @onlooker/web dev` in the background (the mock API is the default with no base URL). Sign up in the mock, then check, with screenshots:
- `/` lands on `/home`, the nav shows Home first with the Sun icon, and the tab title is "Home · Onlooker".
- The Recent sessions panel shows the empty state ("No sessions in the last 7 days…") and the All sessions link. The mock never holds sessions, so this is the only state reachable locally.
- Light and dark theme.
- 390px wide: no horizontal scroll (`document.documentElement.scrollWidth <= 390`).

Stop the dev server afterwards.

- [ ] **Step 3: Commit the spec and plan updates**

Through `/git-workflow:commit`, files `docs/superpowers/specs/2026-11-18-web-home-dashboard-design.md` and `docs/superpowers/plans/2026-11-18-web-home-dashboard-pr1.md`. Suggested subject: `docs(web): plan the home page's first panel`. `Refs ONL-298`.

- [ ] **Step 4: Open the PR**

Through `/git-workflow:pr`, without the conversation-log gist. The body says what PR 2 and PR 3 add, and that the loaded state is checked in production after deploy because the mock holds no sessions.

- [ ] **Step 5: After merge and deploy**

Open `https://app.onlooker.dev/` signed in: it lands on Home, and the panel shows this week's real sessions. The count must match the Sessions page's sessions for the same days. Add the result to the bead with `bd update onlooker-l0njh6 --append-notes "..."`. ONL-298 stays In Progress until PR 3.
