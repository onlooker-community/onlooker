import { describe, expect, it } from "vitest";
import {
	DEFAULT_THRESHOLD,
	type EventEnvelope,
	summarizeSessions,
} from "../sessions";

/** n events in one session, oldest first, one minute apart. */
function run(
	session_id: string,
	types: string[],
	startMinute = 0,
): EventEnvelope[] {
	return types.map((event_type, i) => ({
		event_type,
		session_id,
		machine_id: "m1",
		plugin: event_type.split(".")[0],
		timestamp: new Date(
			Date.UTC(2026, 8, 17, 12, startMinute + i),
		).toISOString(),
	}));
}

function filler(n: number): string[] {
	return Array.from({ length: n }, () => "tool.shell.exec");
}

describe("summarizeSessions", () => {
	it("folds one session into one row", () => {
		const events = run("s1", [
			"session.start",
			...filler(20),
			"session.prompt",
			"session.end",
		]);

		const [summary] = summarizeSessions(events);

		expect(summary.session_id).toBe("s1");
		expect(summary.machine_id).toBe("m1");
		expect(summary.event_count).toBe(23);
		expect(summary.counts_by_prefix).toEqual({ session: 3, tool: 20 });
		expect(summary.prompts).toBe(1);
		expect(summary.compactions).toBe(0);
	});

	// The prefix is the part before the FIRST dot, matching what eventlog.ts
	// already means by prefix in its lastByPrefix scan. Two modules disagreeing
	// about what "tool" counts would be a bug nobody could see from either one.
	it("counts by the first dotted segment", () => {
		const events = run("s1", [
			...filler(21),
			"tool.file.edit",
			"lineage.change.recorded",
		]);

		const [summary] = summarizeSessions(events);

		expect(summary.counts_by_prefix).toEqual({ tool: 22, lineage: 1 });
	});

	// The measured shape of the log: 11,186 session ids, median 3 events, and a
	// typical short one is a start, an end, and one plugin event having done
	// nothing. Without a threshold the feed is eleven thousand rows of that.
	it("drops sessions below the threshold", () => {
		const events = [
			...run("busy", filler(25)),
			...run("idle", ["session.start", "bursar.tick", "session.end"]),
		];

		const ids = summarizeSessions(events).map((s) => s.session_id);

		expect(ids).toEqual(["busy"]);
	});

	it("keeps a session exactly at the threshold", () => {
		const events = run("edge", filler(DEFAULT_THRESHOLD));

		expect(summarizeSessions(events)).toHaveLength(1);
	});

	it("drops a session one below the threshold", () => {
		const events = run("edge", filler(DEFAULT_THRESHOLD - 1));

		expect(summarizeSessions(events)).toHaveLength(0);
	});

	it("honors a caller's threshold over the default", () => {
		const events = run("small", filler(5));

		expect(summarizeSessions(events, { threshold: 5 })).toHaveLength(1);
	});

	// A session still running has no session.end. Reporting it with a null
	// ended_at lets the next sync update the same row rather than freezing it
	// at whatever it looked like the first time it was seen.
	it("reports a session with no end as in progress", () => {
		const events = run("live", ["session.start", ...filler(25)]);

		const [summary] = summarizeSessions(events);

		expect(summary.ended_at).toBeNull();
		expect(summary.started_at).toBe("2026-09-17T12:00:00.000Z");
	});

	it("takes ended_at from the session.end event", () => {
		const events = run("done", [...filler(25), "session.end"]);

		const [summary] = summarizeSessions(events);

		expect(summary.ended_at).toBe("2026-09-17T12:25:00.000Z");
	});

	it("lists each contributing plugin once, sorted", () => {
		const events: EventEnvelope[] = [
			...run("s1", filler(20)),
			{
				event_type: "lineage.change.recorded",
				session_id: "s1",
				machine_id: "m1",
				plugin: "lineage",
				timestamp: "2026-09-17T12:30:00.000Z",
			},
			{
				event_type: "archivist.artifact.ready",
				session_id: "s1",
				machine_id: "m1",
				plugin: "archivist",
				timestamp: "2026-09-17T12:31:00.000Z",
			},
		];

		const [summary] = summarizeSessions(events);

		expect(summary.plugins).toEqual(["archivist", "lineage", "tool"]);
	});

	// The window is a property of the data, not of how often somebody ran the
	// command: a machine that has not synced in a while still reports its
	// recent work, and a session older than the window is simply not re-sent.
	it("drops sessions whose last event predates `since`", () => {
		const events = [
			...run("old", filler(25), 0),
			...run("recent", filler(25), 600),
		];

		const ids = summarizeSessions(events, {
			since: "2026-09-17T15:00:00.000Z",
		}).map((s) => s.session_id);

		expect(ids).toEqual(["recent"]);
	});

	// THE SAFETY PROPERTY. Envelope-only is the whole reason this feature can
	// ship without solving redaction first, and it is worth a test that fails
	// loudly the moment someone adds a payload read - including a read that
	// looks harmless, like spreading the event into a new object.
	it("never reads an event's payload", () => {
		const events = run("s1", filler(25)).map((event) =>
			Object.defineProperty({ ...event }, "payload", {
				enumerable: true,
				get() {
					throw new Error("payload was read");
				},
			}),
		);

		expect(() => summarizeSessions(events)).not.toThrow();
	});

	it("returns nothing for no events", () => {
		expect(summarizeSessions([])).toEqual([]);
	});
});
