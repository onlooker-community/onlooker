import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import DayBar from "../components/DayBar";

function fill(container: HTMLElement): HTMLElement {
	const el = container.querySelector<HTMLElement>(
		"[data-testid='day-bar-fill']",
	);
	if (!el) throw new Error("no fill");
	return el;
}

describe("DayBar", () => {
	it("fills relative to the busiest day", () => {
		const { container } = render(
			<DayBar
				label="Monday"
				sessions={2}
				durationMs={1_800_000}
				busiestMs={3_600_000}
			/>,
		);
		expect(fill(container).style.width).toBe("50%");
		expect(screen.getByText("2 sessions · 30m")).toBeTruthy();
	});

	// SessionsSummary only ever drew days that had sessions, so a 2% floor
	// kept a short day visible. The home panel draws all seven, and a sliver
	// on an empty day would claim work that did not happen.
	it("draws an empty track for a day with no sessions", () => {
		const { container } = render(
			<DayBar
				label="Sunday"
				sessions={0}
				durationMs={0}
				busiestMs={3_600_000}
			/>,
		);
		expect(fill(container).style.width).toBe("0%");
		expect(screen.getByText("0 sessions")).toBeTruthy();
	});

	it("keeps a 2% sliver for a day with sessions but no ended duration", () => {
		const { container } = render(
			<DayBar
				label="Saturday"
				sessions={1}
				durationMs={0}
				busiestMs={3_600_000}
			/>,
		);
		expect(fill(container).style.width).toBe("2%");
	});
});
