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
			[
				session({ session_id: "a", ended_at: null }),
				session({ session_id: "b" }),
			],
			false,
		);
		expect(result.sessions).toBe(2);
		expect(result.durationMs).toBe(30 * 60_000);
	});

	it("buckets by day, newest first", () => {
		const result = rollupSessions(
			[
				session({
					session_id: "a",
					started_at: "2026-09-24T10:00:00Z",
					ended_at: "2026-09-24T10:30:00Z",
				}),
				session({
					session_id: "b",
					started_at: "2026-09-22T10:00:00Z",
					ended_at: "2026-09-22T11:00:00Z",
				}),
				session({
					session_id: "c",
					started_at: "2026-09-22T14:00:00Z",
					ended_at: "2026-09-22T14:30:00Z",
				}),
			],
			false,
		);
		expect(result.days.map((d) => d.sessions)).toEqual([1, 2]);
		expect(result.days[1].durationMs).toBe(90 * 60_000);
	});

	it("orders days newest-first regardless of input order", () => {
		const result = rollupSessions(
			[
				session({
					session_id: "older",
					started_at: "2026-09-22T10:00:00Z",
					ended_at: "2026-09-22T11:00:00Z",
				}),
				session({
					session_id: "newer",
					started_at: "2026-09-24T10:00:00Z",
					ended_at: "2026-09-24T10:30:00Z",
				}),
			],
			false,
		);
		// Despite Sep 22 session appearing first in input, Sep 24 should be
		// first in days output.
		const days = result.days.map((d) => d.day);
		expect(days[0]).toBe("Thursday, September 24");
		expect(days[1]).toBe("Tuesday, September 22");
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
