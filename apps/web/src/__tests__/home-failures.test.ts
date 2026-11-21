import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../api/sessionsApi";
import { failuresIn } from "../lib/homeFailures";

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

describe("failuresIn", () => {
	it("is empty for no sessions and for sessions with no failures", () => {
		expect(failuresIn([])).toEqual({ total: 0, sessions: 0, notes: [] });
		expect(failuresIn([session()]).total).toBe(0);
	});

	// A CLI older than 2.12.0 sends no per-type counts. That is not a clean
	// bill of health, but it is also not a failure to invent.
	it("counts nothing for a session with no per-type counts", () => {
		expect(failuresIn([session({ counts_by_type: {} })]).notes).toEqual([]);
	});

	it("totals every failure and keeps one note per plugin per session", () => {
		const a = session({
			session_id: "a",
			counts_by_type: {
				"historian.embedder.failed": 2,
				"governor.ledger.write_failed": 1,
			},
		});
		const result = failuresIn([a]);
		expect(result.total).toBe(3);
		// Two plugins failed, but in one session.
		expect(result.sessions).toBe(1);
		expect(result.notes.map((n) => [n.plugin, n.count])).toEqual([
			["historian", 2],
			["governor", 1],
		]);
	});

	it("orders the worst first, then the most recent", () => {
		const old = session({
			session_id: "old",
			started_at: "2026-11-15T10:00:00Z",
			counts_by_type: { "historian.embedder.failed": 1 },
		});
		const recent = session({
			session_id: "recent",
			started_at: "2026-11-18T10:00:00Z",
			counts_by_type: { "historian.embedder.failed": 1 },
		});
		const worst = session({
			session_id: "worst",
			started_at: "2026-11-16T10:00:00Z",
			counts_by_type: { "historian.embedder.failed": 4 },
		});
		expect(
			failuresIn([old, recent, worst]).notes.map((n) => n.session.session_id),
		).toEqual(["worst", "recent", "old"]);
	});
});
