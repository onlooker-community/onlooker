import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { scanEvents, scanHooks } from "../eventlog";

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
		expect(scan.sessions).toBe(1);
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
		expect(scan.sessions).toBe(0);
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
				payload: { working_directory: join(root, "apps", "cli") },
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

const firing = (hook: string, ts: string, status = "success") => ({
	hook,
	timestamp: ts,
	status,
	error: null,
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
	});

	it("counts a line that will not parse instead of throwing", async () => {
		const env = withHooks([
			firing("assayer-stop", "2026-09-01T00:00:00Z"),
			"nope",
		]);
		const scan = await scanHooks({ since: {}, env });
		expect(scan.unreadable).toBe(1);
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
