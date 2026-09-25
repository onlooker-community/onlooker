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
