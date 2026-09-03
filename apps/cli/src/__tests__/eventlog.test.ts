import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanEvents } from "../eventlog";

/** A temp `$ONLOOKER_DIR` holding a `logs/onlooker-events.jsonl` of `lines`. */
function withEvents(lines: unknown[]): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(tmpdir(), "onlooker-events-"));
	mkdirSync(join(dir, "logs"), { recursive: true });
	writeFileSync(
		join(dir, "logs", "onlooker-events.jsonl"),
		`${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`,
	);
	return { ONLOOKER_DIR: dir };
}

const event = (type: string, ts: string, payload: unknown = {}) => ({
	event_type: type,
	timestamp: ts,
	session_id: "s1",
	payload,
});

describe("scanEvents", () => {
	it("records the newest timestamp for each event-type prefix", async () => {
		const env = withEvents([
			event("bursar.session.recorded", "2026-08-01T00:00:00Z"),
			event("bursar.rollup.surfaced", "2026-09-02T00:00:00Z"),
			event("lineage.change.recorded", "2026-08-15T00:00:00Z"),
		]);
		const scan = await scanEvents({ root: null, env });
		expect(scan.lastByPrefix.bursar).toBe("2026-09-02T00:00:00Z");
		expect(scan.lastByPrefix.lineage).toBe("2026-08-15T00:00:00Z");
		expect(scan.missing).toBe(false);
	});

	// The project key is a join, never a guess: match session.start's
	// working_directory to the repo root, then read project_key off any event
	// those sessions produced. This is what lets the CLI stay ignorant of the
	// hashing scheme the plugins use.
	it("derives project keys from sessions rooted at the given directory", async () => {
		const root = "/repo/onlooker";
		const env = withEvents([
			{
				event_type: "session.start",
				timestamp: "2026-09-01T00:00:00Z",
				session_id: "mine",
				payload: { working_directory: `${root}/apps/cli` },
			},
			{
				event_type: "session.start",
				timestamp: "2026-09-01T00:00:00Z",
				session_id: "theirs",
				payload: { working_directory: "/repo/elsewhere" },
			},
			{
				event_type: "bursar.session.recorded",
				timestamp: "2026-09-01T00:01:00Z",
				session_id: "mine",
				payload: { project_key: "6a7678979e31" },
			},
			{
				event_type: "bursar.session.recorded",
				timestamp: "2026-09-01T00:01:00Z",
				session_id: "theirs",
				payload: { project_key: "ffffffffffff" },
			},
		]);
		const scan = await scanEvents({ root, env });
		expect(scan.projectKeys).toEqual(["6a7678979e31"]);
		expect(scan.sessions).toBe(1);
	});

	// Append-only does not mean well-ordered: a hook that fires from
	// SessionStart can log its own `project_key` event ahead of onlooker's
	// `session.start`. The join must not depend on which one the log saw
	// first.
	it("collects a project_key event that precedes its session.start", async () => {
		const root = "/repo/onlooker";
		const env = withEvents([
			{
				event_type: "bursar.rollup.surfaced",
				timestamp: "2026-09-01T00:00:00Z",
				session_id: "mine",
				payload: { project_key: "6a7678979e31" },
			},
			{
				event_type: "session.start",
				timestamp: "2026-09-01T00:00:01Z",
				session_id: "mine",
				payload: { working_directory: `${root}/apps/cli` },
			},
		]);
		const scan = await scanEvents({ root, env });
		expect(scan.projectKeys).toEqual(["6a7678979e31"]);
		expect(scan.sessions).toBe(1);
	});

	it("counts a line that will not parse instead of throwing", async () => {
		const env = withEvents([
			event("bursar.session.recorded", "2026-09-01T00:00:00Z"),
			"{ not json",
		]);
		const scan = await scanEvents({ root: null, env });
		expect(scan.unreadable).toBe(1);
		expect(scan.lastByPrefix.bursar).toBe("2026-09-01T00:00:00Z");
	});

	// Syntactically valid JSON that isn't an object - a bare number, `null` -
	// parses without throwing, so this exercises the explicit "not an
	// object" check rather than the JSON.parse failure above.
	it("counts a syntactically valid but non-object line as unreadable", async () => {
		const env = withEvents([
			event("bursar.session.recorded", "2026-09-01T00:00:00Z"),
			"123",
		]);
		const scan = await scanEvents({ root: null, env });
		expect(scan.unreadable).toBe(1);
		expect(scan.lastByPrefix.bursar).toBe("2026-09-01T00:00:00Z");
	});

	it("counts a record with a missing timestamp as unreadable", async () => {
		const env = withEvents([
			event("bursar.session.recorded", "2026-09-01T00:00:00Z"),
			{ event_type: "bursar.rollup.surfaced", session_id: "s1", payload: {} },
		]);
		const scan = await scanEvents({ root: null, env });
		expect(scan.unreadable).toBe(1);
		expect(scan.lastByPrefix.bursar).toBe("2026-09-01T00:00:00Z");
	});

	it("reports a missing log rather than throwing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "onlooker-noevents-"));
		const scan = await scanEvents({ root: null, env: { ONLOOKER_DIR: dir } });
		expect(scan.missing).toBe(true);
		expect(scan.lastByPrefix).toEqual({});
	});

	// A directory in place of the file, not `chmod 000`: permission bits
	// don't stop root, and CI often runs as root. `createReadStream` does not
	// throw synchronously for EISDIR - the failure surfaces only once the
	// read is attempted, so this is the case that actually exercises the
	// open-failure path rather than the earlier `existsSync` check.
	it("reports a log that exists but cannot be opened as missing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "onlooker-unopenable-"));
		mkdirSync(join(dir, "logs", "onlooker-events.jsonl"), {
			recursive: true,
		});
		const scan = await scanEvents({ root: null, env: { ONLOOKER_DIR: dir } });
		expect(scan.missing).toBe(true);
	});
});
