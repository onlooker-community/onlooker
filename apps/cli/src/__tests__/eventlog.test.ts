import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { byteAtOffsetIsNewline, scanEvents, scanHooks } from "../eventlog";

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

/**
 * A temp `$ONLOOKER_DIR` holding `logs/onlooker-events.jsonl` with exactly
 * `content` - no trailing newline appended, unlike `withEvents`. Simulates
 * a hook catching this scan mid-append: the file's last byte is not `\n`.
 */
function withRawEventsFile(content: string): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(tmpdir(), "onlooker-events-raw-"));
	mkdirSync(join(dir, "logs"), { recursive: true });
	writeFileSync(join(dir, "logs", "onlooker-events.jsonl"), content);
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

	// The test above only ever feeds `bursar` events in ascending order, so
	// a comparison that was deleted (unconditional overwrite) or inverted
	// (keeps the oldest) would still pass it - the last record processed
	// happens to be the newest one either way. Feeding the newest one first
	// is what actually pins the comparison: the log is not well-ordered (see
	// "collects a project_key event that precedes its session.start" below),
	// so a real newest-record-first sequence is not a hypothetical.
	it("keeps the newest timestamp when it arrives before an older one", async () => {
		const env = withEvents([
			event("bursar.session.recorded", "2026-09-02T00:00:00Z"),
			event("bursar.rollup.surfaced", "2026-08-01T00:00:00Z"),
		]);
		const scan = await scanEvents({ root: null, env });
		expect(scan.lastByPrefix.bursar).toBe("2026-09-02T00:00:00Z");
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
				payload: { working_directory: join(root, "apps", "cli") },
			},
			{
				event_type: "session.start",
				timestamp: "2026-09-01T00:00:00Z",
				session_id: "theirs",
				payload: { working_directory: join(sep, "repo", "elsewhere") },
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
		expect(scan.sessionIds).toEqual(["mine"]);
	});

	// The only "foreign" fixture above is `/repo/elsewhere`, which even a
	// naive `dir.startsWith(root)` with no separator logic at all would
	// already reject - so the `+ sep` boundary itself, the subtlest line in
	// `within()`, has never been exercised. A sibling directory that shares
	// the root's prefix is what actually pins it: without the boundary
	// check, `onlooker-legacy` satisfies `startsWith("onlooker")` and would
	// leak in.
	it("excludes a sibling directory that shares the root's prefix", async () => {
		const root = join(sep, "repo", "onlooker");
		const env = withEvents([
			{
				event_type: "session.start",
				timestamp: "2026-09-01T00:00:00Z",
				session_id: "sibling",
				payload: { working_directory: `${root}-legacy` },
			},
			{
				event_type: "bursar.session.recorded",
				timestamp: "2026-09-01T00:01:00Z",
				session_id: "sibling",
				payload: { project_key: "6a7678979e31" },
			},
		]);
		const scan = await scanEvents({ root, env });
		expect(scan.projectKeys).toEqual([]);
		expect(scan.sessionIds).toEqual([]);
	});

	// Regression: `within()` used to build `root + sep` unconditionally, so
	// for `root === sep` (a repository checked out at the filesystem root -
	// what `dirname(findUp(cwd, ".git"))` produces there) the check became
	// `dir.startsWith(sep + sep)`, which only the literal string `sep`
	// itself satisfies. Every real session was then classified as foreign
	// with no fault reported - indistinguishable from "no sessions here
	// yet."
	it("derives project keys when the project root is the filesystem root", async () => {
		const root = sep;
		const env = withEvents([
			{
				event_type: "session.start",
				timestamp: "2026-09-01T00:00:00Z",
				session_id: "mine",
				payload: { working_directory: join(root, "apps", "cli") },
			},
			{
				event_type: "bursar.session.recorded",
				timestamp: "2026-09-01T00:01:00Z",
				session_id: "mine",
				payload: { project_key: "6a7678979e31" },
			},
		]);
		const scan = await scanEvents({ root, env });
		expect(scan.projectKeys).toEqual(["6a7678979e31"]);
		expect(scan.sessionIds).toEqual(["mine"]);
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
				payload: { working_directory: join(root, "apps", "cli") },
			},
		]);
		const scan = await scanEvents({ root, env });
		expect(scan.projectKeys).toEqual(["6a7678979e31"]);
		expect(scan.sessionIds).toEqual(["mine"]);
	});

	// The mirror image of the bug `perProjectFreshness` fixed, on the event
	// axis instead of the output walk: `lastByPrefix` was updated from
	// every record on the machine, with no session filter, so a single
	// event from an unrelated repo's session could read as "recent" for
	// this repo's stream. Scoped the same way project keys already are -
	// against `mine`, the sessions rooted at `root` - once `root` is
	// non-null.
	it("scopes lastByPrefix to sessions rooted at the given directory", async () => {
		const root = "/repo/onlooker";
		const env = withEvents([
			{
				event_type: "session.start",
				timestamp: "2026-08-01T00:00:00Z",
				session_id: "mine",
				payload: { working_directory: join(root, "apps", "cli") },
			},
			{
				event_type: "session.start",
				timestamp: "2026-08-01T00:00:00Z",
				session_id: "theirs",
				payload: { working_directory: "/repo/elsewhere" },
			},
			{
				event_type: "lineage.change.recorded",
				timestamp: "2026-08-01T00:00:01Z",
				session_id: "mine",
				payload: {},
			},
			// A different repo's session, far more recent - must not win.
			{
				event_type: "lineage.change.recorded",
				timestamp: "2026-09-02T00:00:00Z",
				session_id: "theirs",
				payload: {},
			},
		]);
		const scan = await scanEvents({ root, env });
		expect(scan.lastByPrefix.lineage).toBe("2026-08-01T00:00:01Z");
	});

	it("records the newest timestamp per full event type, not only per prefix", async () => {
		const root = "/repo/onlooker";
		const env = withEvents([
			{
				event_type: "session.start",
				timestamp: "2026-09-01T00:00:00.000Z",
				session_id: "s",
				payload: { working_directory: root },
			},
			{
				event_type: "lineage.change.recorded",
				timestamp: "2026-09-01T01:00:00.000Z",
				session_id: "s",
				payload: {},
			},
			{
				event_type: "lineage.scan.skipped",
				timestamp: "2026-09-01T02:00:00.000Z",
				session_id: "s",
				payload: {},
			},
		]);

		const scan = await scanEvents({ root, env });

		// The prefix keeps taking the newest across the whole family...
		expect(scan.lastByPrefix.lineage).toBe("2026-09-01T02:00:00.000Z");
		// ...while each type keeps its own, which is what a write signal needs:
		// `lineage.change.recorded` implies a write, `lineage.scan.skipped` does not.
		expect(scan.lastByType["lineage.change.recorded"]).toBe(
			"2026-09-01T01:00:00.000Z",
		);
		expect(scan.lastByType["lineage.scan.skipped"]).toBe(
			"2026-09-01T02:00:00.000Z",
		);
	});

	// `root === null` means the caller never asked for scoping at all (most
	// of this file's own tests use it that way) - `lastByPrefix` stays
	// machine-wide in that case, exactly as before this fix.
	it("keeps lastByPrefix machine-wide when no root is given to scope by", async () => {
		const env = withEvents([
			{
				event_type: "session.start",
				timestamp: "2026-08-01T00:00:00Z",
				session_id: "theirs",
				payload: { working_directory: "/repo/elsewhere" },
			},
			{
				event_type: "lineage.change.recorded",
				timestamp: "2026-09-02T00:00:00Z",
				session_id: "theirs",
				payload: {},
			},
		]);
		const scan = await scanEvents({ root: null, env });
		expect(scan.lastByPrefix.lineage).toBe("2026-09-02T00:00:00Z");
	});

	// `scanHooks` needs the actual set of session ids, not just how many
	// there were, to scope its own firings to the same sessions this join
	// already trusts.
	it("returns the session ids rooted at the given directory", async () => {
		const root = "/repo/onlooker";
		const env = withEvents([
			{
				event_type: "session.start",
				timestamp: "2026-08-01T00:00:00Z",
				session_id: "mine",
				payload: { working_directory: join(root, "apps", "cli") },
			},
			{
				event_type: "session.start",
				timestamp: "2026-08-01T00:00:00Z",
				session_id: "theirs",
				payload: { working_directory: "/repo/elsewhere" },
			},
		]);
		const scan = await scanEvents({ root, env });
		expect(scan.sessionIds).toEqual(["mine"]);
	});

	it("records when each of this repo's own sessions started, and no one else's", async () => {
		const root = "/repo/onlooker";
		const env = withEvents([
			{
				event_type: "session.start",
				timestamp: "2026-09-01T00:00:00.000Z",
				session_id: "ours",
				payload: { working_directory: root },
			},
			{
				event_type: "session.start",
				timestamp: "2026-09-02T00:00:00.000Z",
				session_id: "theirs",
				payload: { working_directory: "/somewhere/else" },
			},
			// A resumed session logs a second start; the opportunity is the
			// session, not each record of it, so the earliest wins.
			{
				event_type: "session.start",
				timestamp: "2026-09-01T06:00:00.000Z",
				session_id: "ours",
				payload: { working_directory: root },
			},
		]);

		const scan = await scanEvents({ root, env });

		expect(scan.sessionStarts).toEqual({ ours: "2026-09-01T00:00:00.000Z" });
		expect(scan.sessionIds).toEqual(["ours"]);
	});

	// `project_key` comes from `payload`, written by any of sixteen
	// independent shell plugins, and flows straight into a path join
	// downstream (`streams.ts`'s `walkKeys`) once it becomes a project key.
	// A real key is always 12 lowercase hex characters; anything else -
	// `"../busy"`, the reproduction that made `join(root, key)` escape
	// `root` entirely - must never become one in the first place.
	it("rejects a project_key that is not 12 lowercase hex characters", async () => {
		const root = "/repo/onlooker";
		const env = withEvents([
			{
				event_type: "session.start",
				timestamp: "2026-09-01T00:00:00Z",
				session_id: "mine",
				payload: { working_directory: join(root, "apps", "cli") },
			},
			{
				event_type: "bursar.session.recorded",
				timestamp: "2026-09-01T00:01:00Z",
				session_id: "mine",
				payload: { project_key: "../busy" },
			},
		]);
		const scan = await scanEvents({ root, env });
		expect(scan.projectKeys).toEqual([]);
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

	// A string that is not a real date sorts lexically like any other string
	// - "zzz" sorts above every genuine ISO timestamp and would win
	// `lastByPrefix`'s max forever, poisoning every downstream comparison
	// that trusts the field it won (streams.ts's judge() reads it as "the
	// newest event ever" and never stops believing the stream is live).
	// `typeof timestamp === "string"` alone does not catch this.
	it("counts a record with an unparseable timestamp as unreadable", async () => {
		const env = withEvents([
			event("bursar.session.recorded", "2026-09-01T00:00:00Z"),
			event("bursar.rollup.surfaced", "zzz"),
		]);
		const scan = await scanEvents({ root: null, env });
		expect(scan.unreadable).toBe(1);
		expect(scan.lastByPrefix.bursar).toBe("2026-09-01T00:00:00Z");
	});

	// `Date.parse` accepts far looser input than either log ever writes -
	// "Sep 2 2020" is not `NaN`, so parseability alone does not catch it,
	// and it sorts lexically ABOVE every genuine "2026-..." record.
	it("counts a record with a non-ISO but Date-parseable timestamp as unreadable", async () => {
		const env = withEvents([
			event("bursar.session.recorded", "2026-09-01T00:00:00Z"),
			event("bursar.rollup.surfaced", "Sep 2 2020"),
		]);
		const scan = await scanEvents({ root: null, env });
		expect(scan.unreadable).toBe(1);
		expect(scan.lastByPrefix.bursar).toBe("2026-09-01T00:00:00Z");
	});

	// A mixed-offset ISO string parses fine too - it is not what either log
	// ever writes, and breaks the same lexical-sort assumption more quietly
	// than an obviously malformed string.
	it("counts a record with a non-UTC-offset timestamp as unreadable", async () => {
		const env = withEvents([
			event("bursar.session.recorded", "2026-09-01T00:00:00Z"),
			event("bursar.rollup.surfaced", "2026-09-02T10:00:00+02:00"),
		]);
		const scan = await scanEvents({ root: null, env });
		expect(scan.unreadable).toBe(1);
		expect(scan.lastByPrefix.bursar).toBe("2026-09-01T00:00:00Z");
	});

	// The log is appended continuously, including while a scan runs -
	// reaching EOF mid-append reads a torn final line, not a corrupt one.
	// The file's last byte is not `\n` in that case, unlike an ordinary
	// malformed line that arrived complete.
	it("does not count a malformed final line as unreadable when the file does not end in a newline", async () => {
		const env = withRawEventsFile(
			`${JSON.stringify({
				event_type: "bursar.session.recorded",
				timestamp: "2026-09-01T00:00:00Z",
				session_id: "s1",
				payload: {},
			})}\n{"event_type": "bursar.rollup.surfaced", "timestamp": "2026-09-02T00:`,
		);
		const scan = await scanEvents({ root: null, env });
		expect(scan.unreadable).toBe(0);
		expect(scan.lastByPrefix.bursar).toBe("2026-09-01T00:00:00Z");
		expect(scan.missing).toBe(false);
	});

	// The counterpart: a malformed line is never forgiven just for being
	// last if the file DOES end in a newline - that is an ordinary
	// malformed record, not a concurrent-append race.
	it("still counts a malformed final line as unreadable when the file does end in a newline", async () => {
		const env = withRawEventsFile(
			`${JSON.stringify({
				event_type: "bursar.session.recorded",
				timestamp: "2026-09-01T00:00:00Z",
				session_id: "s1",
				payload: {},
			})}\nnot json at all\n`,
		);
		const scan = await scanEvents({ root: null, env });
		expect(scan.unreadable).toBe(1);
		expect(scan.lastByPrefix.bursar).toBe("2026-09-01T00:00:00Z");
	});

	// A malformed line mid-file must still count, even when the file's own
	// final line is torn - forgiveness applies only to the actual last line.
	it("still counts a malformed line mid-file as unreadable even when the final line is also torn", async () => {
		const env = withRawEventsFile(
			`not json\n${JSON.stringify({
				event_type: "bursar.session.recorded",
				timestamp: "2026-09-01T00:00:00Z",
				session_id: "s1",
				payload: {},
			})}\n{"event_type": "bursar.rollup.surfaced", "timestamp": "2026-09-02T00:`,
		);
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

	// The test above never reads a single line - EISDIR fails on the first
	// read attempt - so `lastByPrefix` starts and stays empty regardless of
	// whether the reset in the catch actually runs; reverting that line
	// would not fail it. This test forces a genuine mid-read failure
	// instead: a non-string `root` reaches `within()`'s `root.endsWith(sep)`
	// and throws, but only after the first line has already updated
	// `lastByPrefix` - which is what makes the reset provable. It leans on
	// the same broad-catch behavior the deferred "a programming error
	// surfaces as 'log could not be read'" concern names; here that is
	// exactly the lever this test needs.
	it("discards a partial lastByPrefix rather than reporting it as complete", async () => {
		const env = withEvents([
			{
				event_type: "session.start",
				timestamp: "2026-09-01T00:00:00Z",
				session_id: "s1",
				payload: { working_directory: "/anything" },
			},
		]);
		const scan = await scanEvents({ root: 42 as unknown as string, env });
		expect(scan.missing).toBe(true);
		expect(scan.lastByPrefix).toEqual({});
	});

	// Regression: `lastByPrefix` used to be a plain object literal, so an
	// event-type prefix of `__proto__` read and wrote through
	// `Object.prototype` instead of getting its own entry - the recency for
	// that prefix was silently lost (the assignment landed on the shared
	// prototype, not on `scan.lastByPrefix`) rather than recorded.
	it("tracks an event-type prefix literally named __proto__ without polluting Object.prototype", async () => {
		const env = withEvents([
			event("__proto__.rollup.surfaced", "2026-09-01T00:00:00Z"),
		]);
		const scan = await scanEvents({ root: null, env });
		// `Reflect.get`, not `scan.lastByPrefix["__proto__"]`: bracket or dot
		// access on the literal name `__proto__` is the deprecated accessor
		// syntax itself (flagged by biome's noProto rule) - the point of this
		// test is to read back the plain data property the fix created.
		expect(Reflect.get(scan.lastByPrefix, "__proto__")).toBe(
			"2026-09-01T00:00:00Z",
		);
		expect(Object.getPrototypeOf(scan.lastByPrefix)).toBeNull();
	});
});

/** A temp `$ONLOOKER_DIR` holding a `logs/hook-health.jsonl` of `lines`. */
function withHooks(lines: unknown[]): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(tmpdir(), "onlooker-hooks-"));
	mkdirSync(join(dir, "logs"), { recursive: true });
	writeFileSync(
		join(dir, "logs", "hook-health.jsonl"),
		`${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`,
	);
	return { ONLOOKER_DIR: dir };
}

/**
 * A temp `$ONLOOKER_DIR` holding `logs/hook-health.jsonl` with exactly
 * `content` - no trailing newline appended, unlike `withHooks`. Written by
 * hooks the same way `onlooker-events.jsonl` is - continuously, including
 * while a scan runs - so the same torn-final-line race applies here too.
 */
function withRawHooksFile(content: string): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(tmpdir(), "onlooker-hooks-raw-"));
	mkdirSync(join(dir, "logs"), { recursive: true });
	writeFileSync(join(dir, "logs", "hook-health.jsonl"), content);
	return { ONLOOKER_DIR: dir };
}

const firing = (
	hook: string,
	ts: string,
	status = "success",
	sessionId?: string,
) => ({
	hook,
	timestamp: ts,
	status,
	error: null,
	...(sessionId === undefined ? {} : { session_id: sessionId }),
});

describe("scanHooks", () => {
	// This is the bursar shape and the reason the command exists: a hook that
	// fired and succeeded the whole time its output was frozen. Measured on
	// the real machine as 73 firings, 71 successful, against zero writes.
	it("counts only firings after the given threshold", async () => {
		const env = withHooks([
			firing("bursar-session-end", "2026-08-01T00:00:00Z"),
			firing("bursar-session-end", "2026-08-20T00:00:00Z"),
			firing("bursar-session-end", "2026-08-21T00:00:00Z"),
		]);
		const scan = await scanHooks({
			since: { "bursar-session-end": "2026-08-07T00:00:00Z" },
			env,
		});
		expect(scan.hooks["bursar-session-end"].firedSince).toBe(2);
		expect(scan.hooks["bursar-session-end"].okSince).toBe(2);
		expect(scan.hooks["bursar-session-end"].last).toBe("2026-08-21T00:00:00Z");
	});

	// The reviewer's reproduction: repo A's key is frozen since June, but a
	// single unrelated repo's session firing this hook 90 times since would
	// push `firedSince` past the threshold with no session filter at all.
	// `sessionIds` is the fix - only firings from OUR repo's own sessions
	// (from `scanEvents`'s `sessionIds`) count.
	it("counts only firings from the given session ids", async () => {
		const env = withHooks([
			firing("bursar-session-end", "2026-06-10T00:00:00Z", "success", "mine"),
			firing("bursar-session-end", "2026-09-01T00:00:00Z", "success", "theirs"),
		]);
		const scan = await scanHooks({
			since: {},
			sessionIds: ["mine"],
			env,
		});
		expect(scan.hooks["bursar-session-end"].firedSince).toBe(1);
		expect(scan.hooks["bursar-session-end"].last).toBe("2026-06-10T00:00:00Z");
	});

	// Omitting `sessionIds` entirely - not passing an empty array - means
	// "no scoping requested," so every firing on the machine still counts.
	// Every existing call site in this file that predates session scoping
	// relies on this default.
	it("counts every firing when sessionIds is not provided", async () => {
		const env = withHooks([
			firing("bursar-session-end", "2026-06-10T00:00:00Z", "success", "mine"),
			firing("bursar-session-end", "2026-09-01T00:00:00Z", "success", "theirs"),
		]);
		const scan = await scanHooks({ since: {}, env });
		expect(scan.hooks["bursar-session-end"].firedSince).toBe(2);
	});

	// The opportunity denominator: a session only counts as one if it
	// demonstrably ran hooks, scoped the same way firings themselves are. An
	// unattributable firing (no session_id) proves a hook ran but not where,
	// so it cannot make anyone an opportunity.
	it("records which sessions ran hooks at all, scoped the same way firings are", async () => {
		const env = withHooks([
			firing(
				"lineage-post-tool-use",
				"2026-09-01T00:00:00Z",
				"success",
				"ours",
			),
			firing("bursar-session-end", "2026-09-01T01:00:00Z", "success", "ours"),
			firing(
				"lineage-post-tool-use",
				"2026-09-01T02:00:00Z",
				"success",
				"theirs",
			),
			firing("lineage-post-tool-use", "2026-09-01T03:00:00Z"),
		]);

		const scoped = await scanHooks({ since: {}, sessionIds: ["ours"], env });
		expect(scoped.sessionsWithRecords).toEqual(["ours"]);

		// Unscoped keeps its machine-wide contract, minus the unattributable one.
		const all = await scanHooks({ since: {}, env });
		expect(all.sessionsWithRecords).toEqual(["ours", "theirs"]);
	});

	// The union answers "was this session a chance for ANY plugin to act,"
	// which is the wrong question for the write axis: a session in which
	// lineage's own hook never fired was never a chance for lineage's ledger
	// to move, and charging it for one is the false positive that put a
	// healthy lineage at `STOPPED` on the real machine. Both sessions below ran
	// the hook machinery; only one of them was lineage's.
	it("records which sessions each hook fired in, not only which ran hooks at all", async () => {
		const env = withHooks([
			firing(
				"lineage-post-tool-use",
				"2026-09-01T00:00:00Z",
				"success",
				"edited",
			),
			firing(
				"bursar-session-end",
				"2026-09-02T00:00:00Z",
				"success",
				"read-only",
			),
			// Scoped out, like every other count here: another repo's session
			// firing this hook says nothing about ours.
			firing(
				"lineage-post-tool-use",
				"2026-09-03T00:00:00Z",
				"success",
				"theirs",
			),
			// Unattributable, so it cannot make any session anything.
			firing("lineage-post-tool-use", "2026-09-04T00:00:00Z"),
		]);
		const scan = await scanHooks({
			since: {},
			sessionIds: ["edited", "read-only"],
			env,
		});
		expect(scan.sessionsWithRecords).toEqual(["edited", "read-only"]);
		expect(scan.sessionsByHook["lineage-post-tool-use"]).toEqual(["edited"]);
		expect(scan.sessionsByHook["bursar-session-end"]).toEqual(["read-only"]);
	});

	// Attribution is recorded before the `since` filter, and has to be: a
	// firing that predates the output's own mtime is still a firing, and
	// `sessionsByHook` means "the sessions this hook fired in" with no
	// threshold folded into it. The caller measures its own window from its
	// own cutoff (see `opportunitiesSince`); a set already narrowed by a
	// different one would silently intersect two windows.
	it("attributes a session even when the firing predates the hook's threshold", async () => {
		const env = withHooks([
			firing("assayer-stop", "2026-08-01T00:00:00Z", "success", "early"),
		]);
		const scan = await scanHooks({
			since: { "assayer-stop": "2026-08-07T00:00:00Z" },
			env,
		});
		expect(scan.hooks["assayer-stop"].firedSince).toBe(0);
		expect(scan.sessionsByHook["assayer-stop"]).toEqual(["early"]);
	});

	// `since[hook]` carries millisecond precision (`mtimeToIso`, always via
	// `Date#toISOString()`); hook-health.jsonl writes second precision.
	// Lexically "...:45Z" sorts ABOVE "...:45.123Z" ('Z' is 0x5A, '.' is
	// 0x2E), so a firing at or before the threshold's own instant - the run
	// that produced the output itself, say - would count as "since" under a
	// naive string compare even though it happened first. A systematic +1
	// against a threshold of 5.
	it("does not count a firing at or before a millisecond-precision threshold, under second precision", async () => {
		const env = withHooks([
			firing("bursar-session-end", "2026-08-07T00:30:45Z"),
		]);
		const scan = await scanHooks({
			since: { "bursar-session-end": "2026-08-07T00:30:45.123Z" },
			env,
		});
		expect(scan.hooks["bursar-session-end"].firedSince).toBe(0);
	});

	// Same hole as scanEvents's "keeps the newest timestamp..." test above:
	// the threshold test only ever feeds firings in ascending order, so
	// `last` tracking the newest could be deleted or inverted and still
	// pass it.
	it("keeps the newest firing time when it arrives before an older one", async () => {
		const env = withHooks([
			firing("assayer-stop", "2026-09-01T01:00:00Z"),
			firing("assayer-stop", "2026-09-01T00:00:00Z"),
		]);
		const scan = await scanHooks({ since: {}, env });
		expect(scan.hooks["assayer-stop"].last).toBe("2026-09-01T01:00:00Z");
	});

	it("separates failures from successes", async () => {
		const env = withHooks([
			firing("assayer-stop", "2026-09-01T00:00:00Z"),
			firing("assayer-stop", "2026-09-01T01:00:00Z", "failure"),
		]);
		const scan = await scanHooks({ since: {}, env });
		expect(scan.hooks["assayer-stop"].firedSince).toBe(2);
		expect(scan.hooks["assayer-stop"].okSince).toBe(1);
	});

	// A hook absent from the threshold map has no output to lag behind, so
	// every firing counts. Defaulting to "count nothing" would silently zero
	// out every stream whose table entry has no output path.
	it("counts every firing for a hook with no threshold", async () => {
		const env = withHooks([
			firing("lineage-post-tool-use", "2026-09-01T00:00:00Z"),
		]);
		const scan = await scanHooks({ since: {}, env });
		expect(scan.hooks["lineage-post-tool-use"].firedSince).toBe(1);
	});

	it("reports a missing log rather than throwing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "onlooker-nohooks-"));
		const scan = await scanHooks({ since: {}, env: { ONLOOKER_DIR: dir } });
		expect(scan.missing).toBe(true);
		expect(scan.hooks).toEqual({});
	});

	// A directory in place of the file, not `chmod 000`: permission bits
	// don't stop root, and CI often runs as root. `createReadStream` does not
	// throw synchronously for EISDIR - the failure surfaces only once the
	// read is attempted, so this is the case that actually exercises the
	// open-failure path rather than the earlier `existsSync` check.
	it("reports a log that exists but cannot be opened as missing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "onlooker-hooks-unopenable-"));
		mkdirSync(join(dir, "logs", "hook-health.jsonl"), {
			recursive: true,
		});
		const scan = await scanHooks({ since: {}, env: { ONLOOKER_DIR: dir } });
		expect(scan.missing).toBe(true);
	});

	// Same reasoning as scanEvents's "discards a partial lastByPrefix..."
	// test: the test above never reads a single line, so `hooks` starts and
	// stays empty regardless of whether the reset in the catch actually
	// runs. This forces a genuine mid-read failure instead - `since: null`
	// reaches `Object.hasOwn(opts.since, hook)` and throws, but only after
	// the first firing has already created a `hooks` entry.
	it("discards a partial hooks table rather than reporting it as complete", async () => {
		const env = withHooks([firing("assayer-stop", "2026-09-01T00:00:00Z")]);
		const scan = await scanHooks({
			since: null as unknown as Record<string, string>,
			env,
		});
		expect(scan.missing).toBe(true);
		expect(scan.hooks).toEqual({});
		// Both session sets are assigned only after the read loop finishes, so
		// a truncated pass yields empty rather than a partial attribution a
		// caller would read as a complete one.
		expect(scan.sessionsByHook).toEqual({});
		expect(scan.sessionsWithRecords).toEqual([]);
	});

	it("counts a line that will not parse instead of throwing", async () => {
		const env = withHooks([
			firing("assayer-stop", "2026-09-01T00:00:00Z"),
			"nope",
		]);
		const scan = await scanHooks({ since: {}, env });
		expect(scan.unreadable).toBe(1);
	});

	// Same torn-write race as scanEvents: hook-health.jsonl is appended
	// continuously too, and a scan can catch it mid-write.
	it("does not count a malformed final line as unreadable when the file does not end in a newline", async () => {
		const env = withRawHooksFile(
			`${JSON.stringify(firing("assayer-stop", "2026-09-01T00:00:00Z"))}\n{"hook": "assayer-stop", "timestamp": "2026-09-02T00:`,
		);
		const scan = await scanHooks({ since: {}, env });
		expect(scan.unreadable).toBe(0);
		expect(scan.hooks["assayer-stop"].firedSince).toBe(1);
	});

	it("still counts a malformed final line as unreadable when the file does end in a newline", async () => {
		const env = withRawHooksFile(
			`${JSON.stringify(firing("assayer-stop", "2026-09-01T00:00:00Z"))}\nnot json at all\n`,
		);
		const scan = await scanHooks({ since: {}, env });
		expect(scan.unreadable).toBe(1);
		expect(scan.hooks["assayer-stop"].firedSince).toBe(1);
	});

	// Same poisoning risk as scanEvents: a hook firing with an unparseable
	// timestamp must not win `last`, and must not silently count toward
	// `firedSince` either.
	it("counts a firing with an unparseable timestamp as unreadable", async () => {
		const env = withHooks([
			firing("assayer-stop", "2026-09-01T00:00:00Z"),
			firing("assayer-stop", "zzz"),
		]);
		const scan = await scanHooks({ since: {}, env });
		expect(scan.unreadable).toBe(1);
		expect(scan.hooks["assayer-stop"].firedSince).toBe(1);
		expect(scan.hooks["assayer-stop"].last).toBe("2026-09-01T00:00:00Z");
	});

	// Regression: `scan.hooks` used to be a plain object literal, so a hook
	// literally named `__proto__` resolved through `Object.prototype`
	// instead of getting its own entry - `!scan.hooks[hook]` was false
	// (Object.prototype is truthy), so the counters below wrote straight
	// onto the shared prototype instead of a fresh record.
	it("tracks a hook literally named __proto__ without polluting Object.prototype", async () => {
		const env = withHooks([firing("__proto__", "2026-09-01T00:00:00Z")]);
		const scan = await scanHooks({ since: {}, env });
		// `Reflect.get`, not `scan.hooks["__proto__"]`: bracket or dot access
		// on the literal name `__proto__` is the deprecated accessor syntax
		// itself (flagged by biome's noProto rule) - the point of this test
		// is to read back the plain data property the fix created.
		expect(Reflect.get(scan.hooks, "__proto__").firedSince).toBe(1);
		expect(Object.getPrototypeOf(scan.hooks)).toBeNull();
		expect("firedSince" in Object.prototype).toBe(false);
	});

	// Regression: `opts.since[hook]` for `hook === "constructor"` used to
	// resolve to `Object.prototype.constructor` (a function) rather than
	// `undefined`, so the old `threshold !== undefined` guard treated the
	// hook as thresholded and a string-vs-function comparison silently
	// zeroed out its count even though `since` names no such hook.
	it("counts a hook literally named constructor as having no threshold", async () => {
		const env = withHooks([firing("constructor", "2026-09-01T00:00:00Z")]);
		const scan = await scanHooks({ since: {}, env });
		// `Reflect.get`, not `scan.hooks.constructor`: dot access on a
		// well-known `Object.prototype` member name types as that member
		// (`Function`) rather than the record shape, regardless of the
		// index signature.
		expect(Reflect.get(scan.hooks, "constructor").firedSince).toBe(1);
	});
});

describe("byteAtOffsetIsNewline", () => {
	// Exported for direct testing, the same reason `mtimeToIso` is: the real
	// race this function exists to survive - a hook completing a torn
	// line's write, or starting an unrelated new one, between when
	// scanEvents/scanHooks finished reading and when an after-the-fact
	// check of "does the file end in a newline" would run - cannot be
	// constructed through this suite's usual synchronous fixtures. This
	// proves the property that makes it race-free instead: a byte at a
	// FIXED offset, once written, is immutable even as the file keeps
	// growing past it - unlike checking "the file's current last byte,"
	// which moves every time something is appended. That moving target was
	// this function's own first cut (`endsWithNewline`, queried the file
	// fresh after the read loop finished) and exactly what let a
	// concurrent append change the answer in either direction from what
	// the read actually saw.
	it("reads the byte at a fixed offset, unaffected by content appended after it", () => {
		const dir = mkdtempSync(join(tmpdir(), "onlooker-offset-"));
		const path = join(dir, "log.jsonl");
		writeFileSync(path, "first line\n");
		const offset = statSync(path).size - 1; // the '\n' itself.
		expect(byteAtOffsetIsNewline(path, offset)).toBe(true);
		// A write races in after the offset was captured - exactly the
		// scenario the file's-current-end approach got wrong.
		appendFileSync(path, "second line, no newline yet");
		expect(byteAtOffsetIsNewline(path, offset)).toBe(true); // unchanged.
	});

	it("reads false for an offset that was not a newline, unaffected by a later completing write", () => {
		const dir = mkdtempSync(join(tmpdir(), "onlooker-offset-"));
		const path = join(dir, "log.jsonl");
		writeFileSync(path, "torn line, no newline yet");
		const offset = statSync(path).size - 1; // the last byte written, not '\n'.
		expect(byteAtOffsetIsNewline(path, offset)).toBe(false);
		// The write completes moments later - a naive re-check of "the
		// file's current last byte" would now say true, masking the tear
		// this offset actually captured.
		appendFileSync(path, "\nmore data after the completion");
		expect(byteAtOffsetIsNewline(path, offset)).toBe(false); // still false.
	});

	it("treats an empty read (offset < 0) as complete rather than torn", () => {
		expect(byteAtOffsetIsNewline("/does/not/matter", -1)).toBe(true);
	});
});
