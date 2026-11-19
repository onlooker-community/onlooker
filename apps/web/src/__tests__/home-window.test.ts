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
		const rows = [
			{ at: "2026-11-18T10:00:00Z" },
			{ at: "2026-11-01T10:00:00Z" },
		];
		expect(withinWindow(rows, at, NOW, true).complete).toBe(true);
	});

	// The case the panel's "most recent N" wording exists for.
	it("is incomplete when every loaded row is inside the window and more pages remain", () => {
		const rows = [
			{ at: "2026-11-18T10:00:00Z" },
			{ at: "2026-11-13T10:00:00Z" },
		];
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
