import { describe, expect, it } from "vitest";
import {
	DEFAULT_THRESHOLD,
	type EventEnvelope,
	MAX_TYPES_PER_SESSION,
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

describe("summarizeSessions / counts_by_project", () => {
	/** `run`, with a project key and basis stamped on every event. */
	function inProject(
		events: EventEnvelope[],
		project: string,
		basis: "remote" | "root" = "remote",
	): EventEnvelope[] {
		return events.map((event) => ({ ...event, project, project_basis: basis }));
	}

	it("counts a single-project session under its one key", async () => {
		const events = inProject(
			run("s1", ["session.start", ...filler(20), "session.end"]),
			"ee2cfbe428c7",
		);

		const [summary] = await summarizeSessions(events);

		expect(summary.counts_by_project).toEqual({
			ee2cfbe428c7: { basis: "remote", event_count: 22 },
		});
	});

	// THE REASON THIS COLUMN IS A MAP. Measured against lineage's ledger, 20 of
	// 115 sessions (17.4%) touched more than one project, and one touched
	// three. A scalar column - first-seen or modal - is silently wrong for a
	// sixth of sessions in exactly the "which repo burns the most" number the
	// feature exists to produce.
	it("splits a session that spans two projects", async () => {
		const events = [
			...inProject(run("s1", filler(12)), "ee2cfbe428c7"),
			...inProject(run("s1", filler(8), 20), "bc046590dad9", "root"),
		];

		const [summary] = await summarizeSessions(events);

		expect(summary.event_count).toBe(20);
		expect(summary.counts_by_project).toEqual({
			ee2cfbe428c7: { basis: "remote", event_count: 12 },
			bc046590dad9: { basis: "root", event_count: 8 },
		});
	});

	// An empty map, never null. Every event in the log predating ecosystem
	// 0.71.0 lands here, so this is the common case for a while yet, and a
	// consumer should not have to branch on two kinds of nothing.
	it("gives a session with no project dimension an empty map", async () => {
		const events = run("s1", ["session.start", ...filler(20), "session.end"]);

		const [summary] = await summarizeSessions(events);

		expect(summary.counts_by_project).toEqual({});
		expect(summary.counts_by_project).not.toBeNull();
	});

	// A session that gained the dimension partway through - the realistic shape
	// of the release itself, where a running session's hooks are swapped under
	// it. Only the attributable events are counted, and event_count still
	// covers them all, so the two numbers deliberately disagree.
	it("counts only the attributable events of a partially-stamped session", async () => {
		const events = [
			...run("s1", filler(10)),
			...inProject(run("s1", filler(10), 20), "ee2cfbe428c7"),
		];

		const [summary] = await summarizeSessions(events);

		expect(summary.event_count).toBe(20);
		expect(summary.counts_by_project).toEqual({
			ee2cfbe428c7: { basis: "remote", event_count: 10 },
		});
	});

	// A key with no basis is not attributable: the ecosystem emitter refuses to
	// send one (both fields or neither), so a line carrying only `project` came
	// from something that is not the canonical emitter and should not seed a
	// row whose basis we would have to invent.
	it("ignores a project with no basis", async () => {
		const events = run("s1", filler(25)).map((event) => ({
			...event,
			project: "ee2cfbe428c7",
		}));

		const [summary] = await summarizeSessions(events);

		expect(summary.counts_by_project).toEqual({});
	});

	// Same guard `counts_by_prefix` carries, and for the same reason: this
	// summarizer does not validate the 12-hex pattern, it folds whatever the
	// log says. A `__proto__` key on a plain object literal reads back through
	// Object.prototype instead of returning undefined, and assigning through it
	// pollutes every object in the process for the life of the CLI run.
	it("folds a __proto__ project key as plain data", async () => {
		const events = inProject(run("s1", filler(25)), "__proto__");

		const [summary] = await summarizeSessions(events);

		expect(Object.getPrototypeOf(summary.counts_by_project)).toBeNull();
		expect(Reflect.get(summary.counts_by_project, "__proto__")).toEqual({
			basis: "remote",
			event_count: 25,
		});
	});

	it("keeps each session's projects separate", async () => {
		const events = [
			...inProject(run("s1", filler(25)), "ee2cfbe428c7"),
			...inProject(run("s2", filler(25)), "bc046590dad9", "root"),
		];

		const summaries = await summarizeSessions(events);
		const byId = new Map(summaries.map((s) => [s.session_id, s]));

		expect(byId.get("s1")?.counts_by_project).toEqual({
			ee2cfbe428c7: { basis: "remote", event_count: 25 },
		});
		expect(byId.get("s2")?.counts_by_project).toEqual({
			bc046590dad9: { basis: "root", event_count: 25 },
		});
	});
});

// ONL-128. `curator: 15027` read as a busy, healthy plugin while curator
// scanned 8,225 times and emitted zero findings. The prefix is where that
// signal died, so the full type has to survive the fold.
describe("summarizeSessions / counts_by_type", () => {
	it("keys every event by its full type", async () => {
		const events = run("s1", [
			"session.start",
			...filler(20),
			"curator.scan.started",
			"curator.scan.complete",
			"curator.scan.started",
			"session.end",
		]);

		const [summary] = await summarizeSessions(events);

		expect(summary.counts_by_type).toEqual({
			"session.start": 1,
			"tool.shell.exec": 20,
			"curator.scan.started": 2,
			"curator.scan.complete": 1,
			"session.end": 1,
		});
	});

	// The issue's promise: existing views keep working because the prefix
	// counts are derivable from the type counts.
	it("rolls up to exactly counts_by_prefix", async () => {
		const events = run("s1", [
			...filler(20),
			"tool.file.edit",
			"lineage.change.recorded",
			"librarian.candidate.dropped",
		]);

		const [summary] = await summarizeSessions(events);

		const rolled: Record<string, number> = {};
		for (const [type, count] of Object.entries(summary.counts_by_type)) {
			const prefix = type.split(".")[0];
			rolled[prefix] = (rolled[prefix] ?? 0) + count;
		}
		expect(rolled).toEqual({ ...summary.counts_by_prefix });
	});

	// A type is envelope, not payload, but only while it is a registered name.
	// The log is appended by many independent writers and the fold does not
	// check the schema's list, so a type that does not look like one stays
	// out of the map rather than carrying whatever text a writer put there.
	it("leaves a type that is not shaped like a registered name out of the map", async () => {
		const events = run("s1", [
			...filler(20),
			"Tool.Shell.Exec",
			"has space.in.it",
			"nodot",
			`plugin.${"x".repeat(64)}`,
		]);

		const [summary] = await summarizeSessions(events);

		expect(summary.counts_by_type).toEqual({ "tool.shell.exec": 20 });
		// Still counted everywhere else: the event happened.
		expect(summary.event_count).toBe(24);
		expect(summary.counts_by_prefix.nodot).toBe(1);
	});

	// `constructor.trap` is a well-shaped name, so it is keyed - and has to be
	// keyed as plain data, for the reason counts_by_prefix carries the guard.
	it("keys a constructor-named type as plain data", async () => {
		const events = run("s1", [...filler(20), "constructor.trap"]);

		const [summary] = await summarizeSessions(events);

		expect(Object.getPrototypeOf(summary.counts_by_type)).toBeNull();
		expect(Reflect.get(summary.counts_by_type, "constructor.trap")).toBe(1);
	});

	// The busiest session on the measuring machine had 41 distinct types. The
	// cap is for the writer that mints a new type per event, which would
	// otherwise grow one row past the API's body limit on its own.
	it("keys at most MAX_TYPES_PER_SESSION distinct types, first seen first", async () => {
		const types = Array.from(
			{ length: MAX_TYPES_PER_SESSION + 10 },
			(_, i) => `plugin.type${i}`,
		);
		const events = run("s1", [...types, "plugin.type0"]);

		const [summary] = await summarizeSessions(events);

		const keys = Object.keys(summary.counts_by_type);
		expect(keys).toHaveLength(MAX_TYPES_PER_SESSION);
		expect(keys).not.toContain(`plugin.type${MAX_TYPES_PER_SESSION}`);
		// A type already keyed keeps counting after the cap is reached.
		expect(summary.counts_by_type["plugin.type0"]).toBe(2);
	});
});
