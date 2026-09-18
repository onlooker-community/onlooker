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
	it("folds one session into one row", async () => {
		const events = run("s1", [
			"session.start",
			...filler(20),
			"session.prompt",
			"session.end",
		]);

		const [summary] = await summarizeSessions(events);

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
	it("counts by the first dotted segment", async () => {
		const events = run("s1", [
			...filler(21),
			"tool.file.edit",
			"lineage.change.recorded",
		]);

		const [summary] = await summarizeSessions(events);

		expect(summary.counts_by_prefix).toEqual({ tool: 22, lineage: 1 });
	});

	// The event log is untrusted input. An event_type prefix of `__proto__` or
	// `constructor` on a plain object literal reads back through Object.prototype
	// and pollutes every object in the process. Object.create(null) guards against
	// this, matching the guard in eventlog.ts:179-185.
	it("safely counts __proto__ and constructor prefixes without prototype pollution", async () => {
		const events = run("s1", [
			"__proto__.evil",
			"constructor.trap",
			...filler(19),
		]);

		const [summary] = await summarizeSessions(events);

		// Safely store as typed record to check string keys (not prototype pollution)
		const counts = summary.counts_by_prefix as Record<string, number>;
		// biome-ignore lint/suspicious/noProto lint/complexity/useLiteralKeys: __proto__ is a string key in Object.create(null)
		expect(counts["__proto__"]).toBe(1);
		// biome-ignore lint/complexity/useLiteralKeys: constructor is a string key in Object.create(null)
		expect(counts["constructor"]).toBe(1);
		expect(counts.tool).toBe(19);

		// Verify the object has the expected keys (no prototype pollution)
		const keys = Object.getOwnPropertyNames(summary.counts_by_prefix);
		expect(keys).toContain("__proto__");
		expect(keys).toContain("constructor");
		expect(keys).toContain("tool");
	});

	// The measured shape of the log: 11,186 session ids, median 3 events, and a
	// typical short one is a start, an end, and one plugin event having done
	// nothing. Without a threshold the feed is eleven thousand rows of that.
	it("drops sessions below the threshold", async () => {
		const events = [
			...run("busy", filler(25)),
			...run("idle", ["session.start", "bursar.tick", "session.end"]),
		];

		const ids = (await summarizeSessions(events)).map((s) => s.session_id);

		expect(ids).toEqual(["busy"]);
	});

	it("keeps a session exactly at the threshold", async () => {
		const events = run("edge", filler(DEFAULT_THRESHOLD));

		await expect(summarizeSessions(events)).resolves.toHaveLength(1);
	});

	it("drops a session one below the threshold", async () => {
		const events = run("edge", filler(DEFAULT_THRESHOLD - 1));

		await expect(summarizeSessions(events)).resolves.toHaveLength(0);
	});

	it("honors a caller's threshold over the default", async () => {
		const events = run("small", filler(5));

		await expect(
			summarizeSessions(events, { threshold: 5 }),
		).resolves.toHaveLength(1);
	});

	// A session still running has no session.end. Reporting it with a null
	// ended_at lets the next sync update the same row rather than freezing it
	// at whatever it looked like the first time it was seen.
	it("reports a session with no end as in progress", async () => {
		const events = run("live", ["session.start", ...filler(25)]);

		const [summary] = await summarizeSessions(events);

		expect(summary.ended_at).toBeNull();
		expect(summary.started_at).toBe("2026-09-17T12:00:00.000Z");
	});

	it("takes ended_at from the session.end event", async () => {
		const events = run("done", [...filler(25), "session.end"]);

		const [summary] = await summarizeSessions(events);

		expect(summary.ended_at).toBe("2026-09-17T12:25:00.000Z");
	});

	it("lists each contributing plugin once, sorted", async () => {
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

		const [summary] = await summarizeSessions(events);

		expect(summary.plugins).toEqual(["archivist", "lineage", "tool"]);
	});

	// The window is a property of the data, not of how often somebody ran the
	// command: a machine that has not synced in a while still reports its
	// recent work, and a session older than the window is simply not re-sent.
	// The cutoff is the LAST event, not the first: a long session that started
	// before the window but remains active must not be dropped.
	it("drops sessions whose last event predates `since`", async () => {
		const events = [
			...run("old", filler(25), 0), // entirely before cutoff (12:00-12:25)
			...run("recent", filler(25), 600), // entirely after cutoff (22:00-22:25)
			// straddles the cutoff: first event at 14:50, last at 15:14
			...run("straddling", filler(25), 170),
		];

		const summaries = await summarizeSessions(events, {
			since: "2026-09-17T15:00:00.000Z",
		});
		const ids = summaries.map((s) => s.session_id);

		// old is entirely before cutoff → dropped
		// straddling starts before but ends after → kept
		// recent is entirely after → kept (insertion order)
		expect(ids).toEqual(["recent", "straddling"]);
	});

	// THE SAFETY PROPERTY. Envelope-only is the whole reason this feature can
	// ship without solving redaction first, and it is worth a test that fails
	// loudly the moment someone adds a payload read - including a read that
	// looks harmless, like spreading the event into a new object.
	it("never reads an event's payload", async () => {
		const events = run("s1", filler(25)).map((event) =>
			Object.defineProperty({ ...event }, "payload", {
				enumerable: true,
				get() {
					throw new Error("payload was read");
				},
			}),
		);

		// If anything in the fold touched `.payload`, the getter above throws
		// and this promise rejects - `.resolves` is what makes that rejection
		// fail the test, the async equivalent of the old `.not.toThrow()`.
		await expect(summarizeSessions(events)).resolves.toBeDefined();
	});

	it("returns nothing for no events", async () => {
		await expect(summarizeSessions([])).resolves.toEqual([]);
	});
});
