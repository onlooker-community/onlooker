# Sessions Feed, Over Time — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `/sessions` a summary header that says what the reader actually loaded, and surface the two per-session fields the page already fetches and never shows.

**Architecture:** A pure rollup module (`lib/sessionRollup.ts`) turns a loaded
`SessionSummary[]` plus `has_more` into totals, per-day buckets and a
completeness flag. A presentational component (`components/SessionsSummary.tsx`)
renders it. `SessionsPage` requests 200 rows instead of 50 and renders the
header above its existing day panels. No API, route or DB change.

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react, Biome.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-24-sessions-feed-over-time-design.md`. Read it before Task 1.
- **Edit tracked files with `Edit`/`Write`, never `sed -i` or heredocs.** The `lineage` and `inspector` plugins hook `PostToolUse` on the file tools; a shell edit moves the same bytes invisibly and `/lineage` then answers "no record" for a line that was demonstrably written. See the repo `CLAUDE.md`.
- **American English** in comments, identifiers and copy: `behavior`, `canceled`, `gray`.
- Indentation is **tabs**, line width 80, enforced by Biome (`biome.json`).
- API field names stay **snake_case** (`started_at`, `has_more`) — they are the API's names, matching `ActivityEvent` and `Lesson`.
- Every test file that renders `SessionsPage` must keep `process.env.TZ = "UTC"` as its first statement, before imports. Day grouping uses `toLocaleDateString`, so an unpinned zone makes grouping assertions machine-dependent.
- Run tests from `apps/web`: `pnpm test` (alias for `vitest run`). Single file: `pnpm vitest run src/__tests__/<file> `.
- Commit through `/git-workflow:commit`. Do not hand-write `git commit -m`.
- Branch: `meagan/onl-18-sessions-feed-over-time`, already created, spec already committed there as `36ce081`.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/src/lib/sessionRollup.ts` | **Create.** Pure functions: roll sessions into totals/days, format a duration, format a date range. No React. |
| `apps/web/src/__tests__/session-rollup.test.ts` | **Create.** Unit tests for the above, no rendering. |
| `apps/web/src/components/SessionsSummary.tsx` | **Create.** Renders a `Rollup`. Presentational only — takes the computed object, decides nothing. |
| `apps/web/src/api/sessionsApi.ts` | **Modify.** `ListSessionsOptions` gains `limit`; `listSessions` forwards it. |
| `apps/web/src/pages/SessionsPage.tsx` | **Modify.** Request `limit: 200`; render the header; change the row; delegate duration formatting to the lib. |
| `apps/web/src/__tests__/sessions-page.test.tsx` | **Modify.** Integration assertions for header, row fields, and incompleteness. |

The rollup is a separate module rather than a helper inside `SessionsPage`
for the reason `dayKey.ts` was pulled out of `ActivityPage`: two pages already
group by day, the arithmetic here is the part most worth testing directly, and
testing it through a render would mean asserting totals through the DOM.

---

### Task 1: `limit` reaches the API client

**Files:**
- Modify: `apps/web/src/api/sessionsApi.ts:63-86`
- Test: `apps/web/src/__tests__/sessions-api.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `listSessions(options?: { cursor?: string | null; limit?: number })`. Task 4 calls it with `{ limit: 200 }`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/sessions-api.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("../api/client", () => ({
	apiClient: { get: mocks.get },
}));

import { listSessions } from "../api/sessionsApi";

describe("listSessions", () => {
	beforeEach(() => {
		mocks.get.mockReset();
		mocks.get.mockResolvedValue({ sessions: [], cursor: null, has_more: false });
	});

	it("asks for no limit when none is given", async () => {
		await listSessions();
		expect(mocks.get).toHaveBeenCalledWith("/api/sessions");
	});

	it("forwards a limit", async () => {
		await listSessions({ limit: 200 });
		expect(mocks.get).toHaveBeenCalledWith("/api/sessions?limit=200");
	});

	// The route clamps at BROWSE_MAX_LIMIT rather than rejecting, so sending a
	// cursor and a limit together has to keep both - a page 2 that silently
	// dropped the limit would return 50 rows into a 200-row rollup and make the
	// header under-report without any error to notice.
	it("keeps both when paging", async () => {
		await listSessions({ cursor: "c1", limit: 200 });
		expect(mocks.get).toHaveBeenCalledWith("/api/sessions?cursor=c1&limit=200");
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && pnpm vitest run src/__tests__/sessions-api.test.ts`
Expected: the two `limit` tests FAIL — the URL has no `limit` parameter. The first test passes already; that is fine, it pins existing behavior.

- [ ] **Step 3: Add `limit`**

In `apps/web/src/api/sessionsApi.ts`, extend the options interface:

```ts
export interface ListSessionsOptions {
	cursor?: string | null;
	/**
	 * How many summaries to ask for. The route clamps this at
	 * BROWSE_MAX_LIMIT (200) rather than rejecting an over-large value, so a
	 * caller asking for more simply gets the ceiling.
	 *
	 * SessionsPage asks for 200 so its summary header covers the whole
	 * history in one request. The header stops claiming a total when
	 * `has_more` comes back true - see components/SessionsSummary.tsx.
	 */
	limit?: number;
}
```

and forward it, keeping the existing falsy-guard style:

```ts
	const query = new URLSearchParams();
	if (options.cursor) query.set("cursor", options.cursor);
	if (options.limit) query.set("limit", String(options.limit));
```

- [ ] **Step 4: Run tests**

Run: `cd apps/web && pnpm vitest run src/__tests__/sessions-api.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

Use `/git-workflow:commit`. Stage exactly `apps/web/src/api/sessionsApi.ts` and `apps/web/src/__tests__/sessions-api.test.ts`.

---

### Task 2: The rollup

**Files:**
- Create: `apps/web/src/lib/sessionRollup.ts`
- Test: `apps/web/src/__tests__/session-rollup.test.ts` (create)

**Interfaces:**
- Consumes: `SessionSummary` from `../api/sessionsApi`; `dayKey` from `./dayKey`.
- Produces:
  - `formatDurationMs(ms: number): string` — `"18h 20m"`, `"45m"`, `"<1m"`, `""` for non-finite or negative.
  - `formatRange(firstIso: string, lastIso: string): string` — `"Sep 3 – Sep 24"`, or `"Sep 24"` when both fall on one day.
  - `interface DayRollup { day: string; sessions: number; durationMs: number }`
  - `interface Rollup { sessions: number; durationMs: number; days: DayRollup[]; range: string; longest: SessionSummary | null; complete: boolean }`
  - `rollupSessions(sessions: SessionSummary[], hasMore: boolean): Rollup`

Task 3 renders `Rollup`. Task 4 calls `rollupSessions` and `formatDurationMs`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/__tests__/session-rollup.test.ts`:

```ts
process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../api/sessionsApi";
import {
	formatDurationMs,
	formatRange,
	rollupSessions,
} from "../lib/sessionRollup";

function session(over: Partial<SessionSummary> = {}): SessionSummary {
	return {
		session_id: "s1",
		machine_id: "m1",
		started_at: "2026-09-24T10:00:00Z",
		ended_at: "2026-09-24T10:30:00Z",
		event_count: 100,
		counts_by_prefix: { tool: 100 },
		plugins: [],
		prompts: 3,
		compactions: 0,
		...over,
	};
}

describe("formatDurationMs", () => {
	it("renders hours and minutes", () => {
		expect(formatDurationMs(66_000_000)).toBe("18h 20m");
	});

	it("renders minutes alone under an hour", () => {
		expect(formatDurationMs(45 * 60_000)).toBe("45m");
	});

	it("renders under a minute rather than 0m", () => {
		expect(formatDurationMs(20_000)).toBe("<1m");
	});

	// A negative or NaN duration means clocks disagreed or a timestamp was
	// malformed. Rendering "-3m" states something false with confidence; the
	// empty string lets the caller omit it.
	it("renders nothing for a negative or non-finite duration", () => {
		expect(formatDurationMs(-1)).toBe("");
		expect(formatDurationMs(Number.NaN)).toBe("");
	});
});

describe("formatRange", () => {
	it("renders two dates", () => {
		expect(formatRange("2026-09-03T10:00:00Z", "2026-09-24T10:00:00Z")).toBe(
			"Sep 3 – Sep 24",
		);
	});

	it("renders one date when the range is a single day", () => {
		expect(formatRange("2026-09-24T01:00:00Z", "2026-09-24T23:00:00Z")).toBe(
			"Sep 24",
		);
	});
});

describe("rollupSessions", () => {
	it("counts sessions and sums their durations", () => {
		const result = rollupSessions(
			[
				session({ session_id: "a" }),
				session({
					session_id: "b",
					started_at: "2026-09-24T12:00:00Z",
					ended_at: "2026-09-24T13:00:00Z",
				}),
			],
			false,
		);
		expect(result.sessions).toBe(2);
		expect(result.durationMs).toBe(90 * 60_000);
	});

	// The spec's test 4. A running session is real and belongs in the count,
	// but it has no duration yet. Treating `ended_at: null` as an end time of
	// zero would subtract decades from the total.
	it("counts a still-running session but adds no duration for it", () => {
		const result = rollupSessions(
			[session({ session_id: "a", ended_at: null }), session({ session_id: "b" })],
			false,
		);
		expect(result.sessions).toBe(2);
		expect(result.durationMs).toBe(30 * 60_000);
	});

	it("buckets by day, newest first", () => {
		const result = rollupSessions(
			[
				session({ session_id: "a", started_at: "2026-09-24T10:00:00Z", ended_at: "2026-09-24T10:30:00Z" }),
				session({ session_id: "b", started_at: "2026-09-22T10:00:00Z", ended_at: "2026-09-22T11:00:00Z" }),
				session({ session_id: "c", started_at: "2026-09-22T14:00:00Z", ended_at: "2026-09-22T14:30:00Z" }),
			],
			false,
		);
		expect(result.days.map((d) => d.sessions)).toEqual([1, 2]);
		expect(result.days[1].durationMs).toBe(90 * 60_000);
	});

	it("names the longest ended session", () => {
		const result = rollupSessions(
			[
				session({ session_id: "short" }),
				session({
					session_id: "long",
					started_at: "2026-09-24T12:00:00Z",
					ended_at: "2026-09-24T14:00:00Z",
				}),
			],
			false,
		);
		expect(result.longest?.session_id).toBe("long");
	});

	it("is incomplete when more pages remain", () => {
		expect(rollupSessions([session()], true).complete).toBe(false);
		expect(rollupSessions([session()], false).complete).toBe(true);
	});

	it("survives an empty list without inventing a range", () => {
		const result = rollupSessions([], false);
		expect(result.sessions).toBe(0);
		expect(result.range).toBe("");
		expect(result.longest).toBeNull();
		expect(result.days).toEqual([]);
	});
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd apps/web && pnpm vitest run src/__tests__/session-rollup.test.ts`
Expected: FAIL — `Cannot find module '../lib/sessionRollup'`.

- [ ] **Step 3: Write the module**

Create `apps/web/src/lib/sessionRollup.ts`:

```ts
/**
 * Turns the session summaries a page has actually loaded into the totals its
 * header states.
 *
 * Pure and React-free so the arithmetic can be tested directly. Asserting a
 * total through a render means a failure tells you the number on screen is
 * wrong without telling you whether the sum or the markup produced it.
 *
 * Every field here describes THE LOADED ROWS, never the account's whole
 * history. `complete` carries that distinction to the view - see
 * components/SessionsSummary.tsx, which changes its wording rather than its
 * numbers when it is false.
 */

import type { SessionSummary } from "../api/sessionsApi";
import { dayKey } from "./dayKey";

export interface DayRollup {
	day: string;
	sessions: number;
	durationMs: number;
}

export interface Rollup {
	sessions: number;
	durationMs: number;
	/** Newest day first, matching the order the page renders panels in. */
	days: DayRollup[];
	/** "Sep 3 – Sep 24", or "" when there are no sessions. */
	range: string;
	longest: SessionSummary | null;
	/** False when the API reported more pages than were loaded. */
	complete: boolean;
}

/** How long a session ran, in ms, or null while it is still running. */
function durationMsOf(session: SessionSummary): number | null {
	if (!session.ended_at) return null;
	const ms =
		new Date(session.ended_at).getTime() -
		new Date(session.started_at).getTime();
	return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * "18h 20m". Empty for a negative or non-finite input rather than "-3m":
 * clocks disagree and timestamps arrive malformed, and a confident wrong
 * duration is worse than an absent one.
 */
export function formatDurationMs(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return "<1m";
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

/** "Sep 3 – Sep 24", collapsing to one date when the range is a single day. */
export function formatRange(firstIso: string, lastIso: string): string {
	const shape: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
	const first = new Date(firstIso);
	const last = new Date(lastIso);
	if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return "";
	const a = first.toLocaleDateString(undefined, shape);
	const b = last.toLocaleDateString(undefined, shape);
	return a === b ? a : `${a} – ${b}`;
}

export function rollupSessions(
	sessions: SessionSummary[],
	hasMore: boolean,
): Rollup {
	const days = new Map<string, DayRollup>();
	let durationMs = 0;
	let longest: SessionSummary | null = null;
	let longestMs = -1;
	let earliest: string | null = null;
	let latest: string | null = null;

	for (const session of sessions) {
		const day = dayKey(session.started_at);
		const bucket = days.get(day) ?? { day, sessions: 0, durationMs: 0 };
		bucket.sessions += 1;

		const ms = durationMsOf(session);
		if (ms !== null) {
			durationMs += ms;
			bucket.durationMs += ms;
			if (ms > longestMs) {
				longestMs = ms;
				longest = session;
			}
		}
		days.set(day, bucket);

		if (earliest === null || session.started_at < earliest) {
			earliest = session.started_at;
		}
		if (latest === null || session.started_at > latest) {
			latest = session.started_at;
		}
	}

	return {
		sessions: sessions.length,
		durationMs,
		// Insertion order is the order rows arrived, which the API returns
		// newest first - the same assumption SessionsPage's own grouping makes.
		days: [...days.values()],
		range: earliest && latest ? formatRange(earliest, latest) : "",
		longest,
		complete: !hasMore,
	};
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/web && pnpm vitest run src/__tests__/session-rollup.test.ts`
Expected: PASS, 12/12.

- [ ] **Step 5: Commit**

Use `/git-workflow:commit`. Stage `apps/web/src/lib/sessionRollup.ts` and `apps/web/src/__tests__/session-rollup.test.ts`.

---

### Task 3: The header component

**Files:**
- Create: `apps/web/src/components/SessionsSummary.tsx`
- Test: extend `apps/web/src/__tests__/session-rollup.test.ts`? **No** — create `apps/web/src/__tests__/sessions-summary.test.tsx`

**Interfaces:**
- Consumes: `Rollup`, `formatDurationMs` from `../lib/sessionRollup`; `Panel` from `./ui`; `PALETTE` from `./palette`.
- Produces: `export default function SessionsSummary({ rollup }: { rollup: Rollup })`. Task 4 renders it.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/sessions-summary.test.tsx`:

```tsx
process.env.TZ = "UTC";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SessionsSummary from "../components/SessionsSummary";
import type { Rollup } from "../lib/sessionRollup";

function rollup(over: Partial<Rollup> = {}): Rollup {
	return {
		sessions: 41,
		durationMs: 66_000_000,
		days: [
			{ day: "Wednesday, September 24", sessions: 7, durationMs: 31_200_000 },
			{ day: "Tuesday, September 23", sessions: 2, durationMs: 3_900_000 },
		],
		range: "Sep 3 – Sep 24",
		longest: null,
		complete: true,
		...over,
	};
}

describe("SessionsSummary", () => {
	it("states a total when the rollup is complete", () => {
		render(<SessionsSummary rollup={rollup()} />);
		expect(screen.getByText(/41 sessions/)).toBeTruthy();
		expect(screen.getByText(/18h 20m/)).toBeTruthy();
		expect(screen.getByText(/Sep 3 – Sep 24/)).toBeTruthy();
	});

	// The whole reason this component takes `complete`. With more pages
	// unread, "41 sessions" is a count of what was fetched being read as a
	// count of what exists.
	it("says what it loaded, not a total, when incomplete", () => {
		render(<SessionsSummary rollup={rollup({ complete: false })} />);
		expect(screen.getByText(/most recent 41 sessions/)).toBeTruthy();
	});

	it("lists a row per day", () => {
		render(<SessionsSummary rollup={rollup()} />);
		expect(screen.getByText("Wednesday, September 24")).toBeTruthy();
		expect(screen.getByText("Tuesday, September 23")).toBeTruthy();
	});

	it("renders nothing at all when there are no sessions", () => {
		const { container } = render(
			<SessionsSummary
				rollup={rollup({ sessions: 0, days: [], range: "", durationMs: 0 })}
			/>,
		);
		expect(container.firstChild).toBeNull();
	});
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd apps/web && pnpm vitest run src/__tests__/sessions-summary.test.tsx`
Expected: FAIL — `Cannot find module '../components/SessionsSummary'`.

- [ ] **Step 3: Write the component**

Create `apps/web/src/components/SessionsSummary.tsx`:

```tsx
/**
 * What the sessions page loaded, summarized.
 *
 * This component states only what the rollup counted. When `complete` is
 * false the wording changes from a total to "the most recent N" - the numbers
 * are the same either way, and the difference is whether the page is claiming
 * they describe the account's whole history. The fetch is newest-first across
 * all time rather than a calendar query, so "this week" is a claim the data
 * cannot back; the range says which dates the loaded rows actually span.
 *
 * Presentational: it decides nothing. lib/sessionRollup.ts does the
 * arithmetic, and SessionsPage decides whether this renders at all.
 */

import { PALETTE } from "./palette";
import { type Rollup, formatDurationMs } from "../lib/sessionRollup";
import { Panel } from "./ui";

export default function SessionsSummary({ rollup }: { rollup: Rollup }) {
	// Not an empty state - SessionsPage owns those, and its three variants say
	// different true things about machines. Rendering nothing lets them speak.
	if (rollup.sessions === 0) return null;

	const total = formatDurationMs(rollup.durationMs);
	const headline = rollup.complete
		? `${rollup.sessions.toLocaleString()} sessions`
		: `most recent ${rollup.sessions.toLocaleString()} sessions`;

	// Bars are relative to the busiest loaded day, so the tallest is always
	// full width. An absolute scale would render every bar as a sliver on a
	// quiet week.
	const busiest = Math.max(...rollup.days.map((d) => d.durationMs), 1);

	return (
		<Panel title="What you loaded" icon="Monitor">
			<div style={{ marginBottom: "var(--space-3)" }}>
				{headline}
				{total ? ` · ${total}` : ""}
				{rollup.range ? ` · ${rollup.range}` : ""}
			</div>

			{rollup.days.map((day) => (
				<div
					key={day.day}
					style={{
						display: "flex",
						alignItems: "center",
						gap: "var(--space-3)",
						padding: "0.2rem 0",
					}}
				>
					<span style={{ flex: "none", minWidth: "12rem" }}>{day.day}</span>
					<span
						aria-hidden="true"
						style={{
							flex: "none",
							height: "0.5rem",
							width: `${Math.max(2, (day.durationMs / busiest) * 100)}%`,
							maxWidth: "8rem",
							background: PALETTE.accent,
							borderRadius: "2px",
						}}
					/>
					<span style={{ color: PALETTE.muted }}>
						{day.sessions} {day.sessions === 1 ? "session" : "sessions"}
						{day.durationMs ? ` · ${formatDurationMs(day.durationMs)}` : ""}
					</span>
				</div>
			))}

			{rollup.longest ? (
				<div style={{ marginTop: "var(--space-3)", color: PALETTE.muted }}>
					Longest {formatDurationMs(
						new Date(rollup.longest.ended_at ?? rollup.longest.started_at).getTime() -
							new Date(rollup.longest.started_at).getTime(),
					)}
					{" · "}
					{rollup.longest.prompts.toLocaleString()} prompts
					{rollup.longest.compactions
						? ` · ${rollup.longest.compactions} compactions`
						: ""}
				</div>
			) : null}
		</Panel>
	);
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/web && pnpm vitest run src/__tests__/sessions-summary.test.tsx`
Expected: PASS, 4/4.

If `Panel` rejects the `icon` value or `PALETTE.accent`/`PALETTE.muted` do not exist, read `apps/web/src/components/ui.tsx` and `palette.ts` and use the names they actually export — do not invent them.

- [ ] **Step 5: Commit**

Use `/git-workflow:commit`. Stage `apps/web/src/components/SessionsSummary.tsx` and `apps/web/src/__tests__/sessions-summary.test.tsx`.

---

### Task 4: Wire it into the page

**Files:**
- Modify: `apps/web/src/pages/SessionsPage.tsx` — the `durationOf` helper (~:17-26), the initial load, the render (~:245-277)
- Modify: `apps/web/src/__tests__/sessions-page.test.tsx`

**Interfaces:**
- Consumes: `listSessions({ limit: 200 })` (Task 1), `rollupSessions`/`formatDurationMs` (Task 2), `SessionsSummary` (Task 3).
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/__tests__/sessions-page.test.tsx`, inside the existing top-level `describe`:

```tsx
	it("asks for a full page so the header can cover the history", async () => {
		mocks.listSessions.mockResolvedValue(ONE_SESSION);
		mocks.listMachines.mockResolvedValue(ONE_MACHINE);
		await act(async () => {
			render(
				<MemoryRouter>
					<SessionsPage />
				</MemoryRouter>,
			);
		});
		expect(mocks.listSessions).toHaveBeenCalledWith({ limit: 200 });
	});

	// The load-bearing assertion. The header's numbers are derived, and the
	// failure this guards is a rollup that drifts from the rows beside it -
	// which looks authoritative and reads as fact.
	it("header totals match the rows rendered", async () => {
		mocks.listSessions.mockResolvedValue(TWO_DAYS);
		mocks.listMachines.mockResolvedValue(ONE_MACHINE);
		await act(async () => {
			render(
				<MemoryRouter>
					<SessionsPage />
				</MemoryRouter>,
			);
		});
		const expected = TWO_DAYS.sessions.length;
		expect(screen.getByText(new RegExp(`${expected} sessions`))).toBeTruthy();
	});

	it("says most recent rather than a total when more pages remain", async () => {
		mocks.listSessions.mockResolvedValue({
			...ONE_SESSION,
			cursor: "c1",
			has_more: true,
		});
		mocks.listMachines.mockResolvedValue(ONE_MACHINE);
		await act(async () => {
			render(
				<MemoryRouter>
					<SessionsPage />
				</MemoryRouter>,
			);
		});
		expect(screen.getByText(/most recent 1 sessions/)).toBeTruthy();
	});

	it("shows prompts and compactions on a row", async () => {
		mocks.listSessions.mockResolvedValue(ONE_SESSION);
		mocks.listMachines.mockResolvedValue(ONE_MACHINE);
		await act(async () => {
			render(
				<MemoryRouter>
					<SessionsPage />
				</MemoryRouter>,
			);
		});
		expect(screen.getByText(/5 prompts/)).toBeTruthy();
		expect(screen.getByText(/1 compaction/)).toBeTruthy();
	});

	it("renders no header when there are no sessions", async () => {
		mocks.listSessions.mockResolvedValue(EMPTY);
		mocks.listMachines.mockResolvedValue(ONE_MACHINE);
		await act(async () => {
			render(
				<MemoryRouter>
					<SessionsPage />
				</MemoryRouter>,
			);
		});
		expect(screen.queryByText(/sessions ·/)).toBeNull();
	});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/web && pnpm vitest run src/__tests__/sessions-page.test.tsx`
Expected: the five new tests FAIL. The existing tests must still PASS — if one broke, stop and fix before continuing.

- [ ] **Step 3: Wire the page**

Three edits in `apps/web/src/pages/SessionsPage.tsx`.

(a) Add imports and delegate the existing `durationOf` to the shared formatter, so the row and the header cannot format a duration two different ways:

```tsx
import SessionsSummary from "../components/SessionsSummary";
import { formatDurationMs, rollupSessions } from "../lib/sessionRollup";
```

```tsx
/** How long a session ran, or that it is still running. */
function durationOf(startedAt: string, endedAt: string | null): string {
	if (!endedAt) return "Still running";
	return formatDurationMs(
		new Date(endedAt).getTime() - new Date(startedAt).getTime(),
	);
}
```

(b) Request a full page on the initial load. Find the `listSessions()` call in the first-load effect and give it the limit:

```tsx
			const page = await listSessions({ limit: 200 });
```

Leave the `loadMore` call as it is — it pages with a cursor and the header re-derives from whatever is loaded.

(c) Track `has_more` and render the header. Add beside the other state:

```tsx
	const [hasMore, setHasMore] = useState(false);
```

Set it wherever `setCursor`/`setEnded` are set from a page (both the first load and `loadMore`): `setHasMore(page.has_more);`

Then, in the final `return`, put the header above the day panels:

```tsx
	return (
		<div style={{ maxWidth: "640px", display: "grid", gap: "var(--space-4)" }}>
			<SessionsSummary rollup={rollupSessions(sessions, hasMore)} />

			{days.map((group) => (
```

(d) Change the row. Replace the `event_count` span with prompts and compactions:

```tsx
							<span style={{ flex: "none" }}>
								{session.prompts.toLocaleString()}{" "}
								{session.prompts === 1 ? "prompt" : "prompts"}
							</span>
							{session.compactions ? (
								<span style={{ flex: "none" }}>
									{session.compactions}{" "}
									{session.compactions === 1 ? "compaction" : "compactions"}
								</span>
							) : null}
```

`event_count` comes out: `shapeOf(session.counts_by_prefix)` already renders the same total broken down by prefix, immediately to its right.

- [ ] **Step 4: Run the whole suite**

Run: `cd apps/web && pnpm test`
Expected: PASS, all files. Then `pnpm typecheck` and `pnpm lint` — both clean.

- [ ] **Step 5: Commit**

Use `/git-workflow:commit`. Stage `apps/web/src/pages/SessionsPage.tsx` and `apps/web/src/__tests__/sessions-page.test.tsx`.

---

### Task 5: See it running

**Files:** none.

- [ ] **Step 1: Run the app against real data**

Use the `run` skill, or `cd apps/web && pnpm dev`, and open `/sessions` signed in.

- [ ] **Step 2: Check the four things a test cannot**

1. The header's session count equals the number of rows you can scroll past.
2. The bars are legible — the busiest day is full width, quiet days are visible rather than invisible slivers.
3. `prompts` on the rows matches your memory of those sessions. If a two-hour session reads "1 prompt", the field is not what the spec claims and that is worth stopping for.
4. The header does **not** say "most recent" — at ~130 sessions, one 200-row request should cover everything. If it does say it, either the limit is not reaching the API or the account has more history than expected.

- [ ] **Step 3: Close the bead**

`bd close onlooker-quhvq4`, with a note recording what the header showed on real data. The milestone's done-when is "a written answer exists, and the feed shows it" — the spec is the written answer and this task is the second half.

---

## Self-Review

**Spec coverage.** Header stating only what it loaded → Task 3 + Task 4. Rows surfacing `prompts`/`compactions` and dropping `event_count` → Task 4(d). Fetch change → Task 1. Loading/empty-state discipline → Task 3 (`return null` at zero) and Task 4's no-header test; `MachinesCheck` is untouched, so the existing guards still gate rendering. All four spec tests map: totals-match-rows → Task 4 test 2; most-recent wording → Task 3 test 2 and Task 4 test 3; no header at zero → Task 3 test 4 and Task 4 test 5; still-running contributes no duration → Task 2 test 2.

**Deferred items are deferred, not dropped.** Server-side aggregate, machine attribution (`onlooker-kipn.1`) and the session-concept spike (`onlooker-kipn.4`) are named in the spec and have no task here, deliberately.

**Type consistency.** `Rollup`/`DayRollup` defined in Task 2 are consumed with those names in Tasks 3 and 4. `formatDurationMs` has one definition and three call sites. `rollupSessions(sessions, hasMore)` — argument order matches every call.

**Component API verified**, not assumed. `PALETTE` exports `plateTeal`, `plateRed`, `plateInk`, `accent`, `danger`, `border`, `borderError`, `muted`, `track` — Task 3 uses `accent` and `muted`. `Panel` takes `title?: string`, `icon?: IconName`, `variant?`, `children`, and `SessionsPage.tsx:248` already passes `icon="Monitor"`, so Task 3's usage matches the page it sits above. `PALETTE.track` is the idiomatic choice if the bar ever wants a background behind it.
