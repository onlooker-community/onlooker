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
		longestMs: null,
		complete: true,
		...over,
	};
}

function dayRow(n: number) {
	return { day: `Day ${n}`, sessions: 1, durationMs: 60_000 };
}

function dayRows(count: number) {
	return [...Array(count)].map((_, i) => dayRow(i + 1));
}

describe("SessionsSummary", () => {
	it("states a total when the rollup is complete", () => {
		render(<SessionsSummary rollup={rollup()} />);
		expect(screen.getByText(/^41 sessions/)).toBeTruthy();
		expect(screen.queryByText(/most recent/)).toBeNull();
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

	it("renders every day without a summary line at 7 or fewer", () => {
		render(<SessionsSummary rollup={rollup({ days: dayRows(7) })} />);
		expect(screen.getAllByText(/^Day \d+$/)).toHaveLength(7);
		expect(screen.queryByText(/more day/)).toBeNull();
	});

	// The cap is presentational only - it must never change the totals line,
	// which keeps describing everything loaded regardless of how many day
	// rows are shown.
	it("caps the day list at 7 and summarizes the rest", () => {
		render(
			<SessionsSummary rollup={rollup({ sessions: 90, days: dayRows(9) })} />,
		);
		expect(screen.getAllByText(/^Day \d+$/)).toHaveLength(7);
		expect(screen.getByText(/2 more days/)).toBeTruthy();
		expect(screen.getByText(/^90 sessions/)).toBeTruthy();
	});

	it("uses singular wording for exactly one hidden day", () => {
		render(<SessionsSummary rollup={rollup({ days: dayRows(8) })} />);
		expect(screen.getByText(/1 more day$/)).toBeTruthy();
		expect(screen.queryByText(/1 more days/)).toBeNull();
	});

	it("uses singular form when there is one session", () => {
		render(
			<SessionsSummary
				rollup={rollup({
					sessions: 1,
					durationMs: 1_800_000,
					days: [
						{
							day: "Wednesday, September 24",
							sessions: 1,
							durationMs: 1_800_000,
						},
					],
					longest: {
						session_id: "s1",
						machine_id: "m1",
						started_at: "2026-09-24T10:00:00Z",
						ended_at: "2026-09-24T10:30:00Z",
						event_count: 10,
						counts_by_prefix: { tool: 10 },
						plugins: [],
						prompts: 1,
						compactions: 1,
					},
					longestMs: 1_800_000,
				})}
			/>,
		);
		expect(screen.queryByText(/1 sessions/)).toBeNull();
		expect(screen.queryAllByText(/1 session/)).not.toHaveLength(0);
		expect(screen.queryByText(/1 prompts/)).toBeNull();
		expect(screen.queryAllByText(/1 prompt/)).not.toHaveLength(0);
		expect(screen.queryByText(/1 compactions/)).toBeNull();
		expect(screen.queryAllByText(/1 compaction/)).not.toHaveLength(0);
	});
});
