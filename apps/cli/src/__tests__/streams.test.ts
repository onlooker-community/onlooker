import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
	clearsCadenceFloor,
	mtimeToIso,
	outputFreshness,
	outputLabel,
	STALL_THRESHOLD,
	STREAMS,
} from "../streams";

/**
 * A fresh `$ONLOOKER_DIR`, cleaned up automatically at the end of whichever
 * test called this. Every test in this file uses it, so registering the
 * cleanup here - rather than expecting every call site to remember an
 * `afterEach` - is what keeps a `vitest run` from leaving a fresh
 * `onlooker-streams-*` directory in `tmpdir()` on every single run.
 */
function emptyDir(): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(tmpdir(), "onlooker-streams-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	return { ONLOOKER_DIR: dir };
}

/** Write a file at `rel` under `$ONLOOKER_DIR` with a fixed mtime. */
function fileAt(env: NodeJS.ProcessEnv, rel: string, iso: string): void {
	const path = join(env.ONLOOKER_DIR as string, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "x");
	const when = new Date(iso);
	utimesSync(path, when, when);
}

const entryFor = (plugin: string) => {
	const found = STREAMS.find((s) => s.plugin === plugin);
	if (found === undefined) throw new Error(`no table entry for ${plugin}`);
	return found;
};

describe("STREAMS", () => {
	// The single most load-bearing line in the design. bursar/sessions is
	// input and was written daily throughout the outage; bursar/projects is
	// the analytical output and was frozen for a month. Pointing this entry at
	// the busy directory silently restores the bug the command exists to find.
	it("points bursar at its analytical output, not its busiest directory", () => {
		expect(entryFor("bursar").output).toBe(join("bursar", "projects"));
	});

	// Both write no directory at all. Treating absence as a fault would report
	// two of five enabled plugins as broken on a healthy machine.
	it("expects no directory from the plugins that write none", () => {
		expect(entryFor("ecosystem").output).toBeNull();
		expect(entryFor("inspector").output).toBeNull();
	});

	// Three names for one thing: the plugin is `governor` (and that is the
	// enabledPlugins key, so keying this entry by anything else makes the
	// lookup miss), its directory is `governance/`, its events are
	// `governor.*`. Verified against the marketplace checkout at 589ac6c.
	it("keys governor by its plugin name, not its directory name", () => {
		const entry = entryFor("governor");
		expect(entry.output).toBe("governance");
		expect(entry.events).toContain("governor");
	});

	// Hook names are pinned from plugins/*/scripts/hooks/*.sh in the
	// marketplace checkout. If a plugin renames a hook this table goes quietly
	// wrong - the stream reads `unknown` rather than reporting a stall - so
	// re-verify this list after a marketplace update.
	it("pins the hook names the staleness rule counts", () => {
		expect(entryFor("bursar").hooks).toEqual([
			"bursar-session-start",
			"bursar-session-end",
		]);
		expect(entryFor("librarian").hooks).toContain("librarian-session-end");
		expect(entryFor("archivist").hooks).toContain("archivist-extract");
	});

	it("names every plugin exactly once", () => {
		const names = STREAMS.map((s) => s.plugin);
		expect(new Set(names).size).toBe(names.length);
	});

	// archivist-events.sh's header comment claims "archivist.* event
	// emission," but the only event it ever emits is "onlooker.artifact.ready"
	// - a prefix that counsel and scribe also emit, so no prefix can identify
	// archivist alone. `["archivist"]` would assert a prefix that does not
	// exist; `["onlooker"]` would make archivist look alive whenever counsel
	// or scribe fire. An empty list is the only honest option.
	it("claims no event prefix for archivist, which shares its only event", () => {
		expect(entryFor("archivist").events).toEqual([]);
	});

	// `findings/<hash>.json` is written only when a NEW problem turns up
	// (run-audit.sh:306); `runs/audit-<id>.json` is written on every
	// COMPLETED audit (run-audit.sh:370). A clean repo audited daily
	// advances `runs/` while `findings/` stays frozen at its last issue -
	// every one of 20 keys on a live machine reads `runs=1, findings=0`.
	// `runs/` is "the analytical pass actually happened," which is what
	// this table's stall check asks; `findings/` answers a different
	// question this table does not track.
	it("resolves cartographer against completed audits, not open findings", () => {
		expect(entryFor("cartographer").subpath).toBe("runs");
	});
});

describe("outputFreshness", () => {
	it("returns the newest mtime beneath the output path", () => {
		const env = emptyDir();
		fileAt(
			env,
			join("bursar", "projects", "a", "sessions.jsonl"),
			"2026-08-07T00:00:00Z",
		);
		fileAt(
			env,
			join("bursar", "projects", "b", "sessions.jsonl"),
			"2026-07-01T00:00:00Z",
		);
		const fresh = outputFreshness(entryFor("bursar"), env);
		expect(fresh.mtime?.slice(0, 10)).toBe("2026-08-07");
		expect(fresh.unreadable).toBe(false);
	});

	// A busy sibling must not count. This is the bursar trap in miniature.
	it("ignores files outside the declared output path", () => {
		const env = emptyDir();
		fileAt(
			env,
			join("bursar", "sessions", "today.jsonl"),
			"2026-09-02T00:00:00Z",
		);
		expect(outputFreshness(entryFor("bursar"), env).mtime).toBeNull();
	});

	it("returns null for an entry that declares no output", () => {
		expect(outputFreshness(entryFor("inspector"), emptyDir()).mtime).toBeNull();
	});

	// A file where a directory belongs makes readdirSync throw ENOTDIR. This
	// is the portable way to produce an unlistable path - chmod 000 does not
	// stop root, and CI often runs as root. The walk must flag it and keep
	// going rather than take the whole command down with it.
	it("flags an output path that cannot be listed instead of throwing", () => {
		const env = emptyDir();
		// `bursar/projects` itself is the file, so listing it fails.
		fileAt(env, join("bursar", "projects"), "2026-08-07T00:00:00Z");
		const fresh = outputFreshness(entryFor("bursar"), env);
		expect(fresh.unreadable).toBe(true);
		expect(fresh.mtime).toBeNull();
	});

	// Four plugins (librarian, cartographer, curator, historian) write a
	// per-project-key heartbeat - manifest.json, last_scan.json,
	// last_audit_at - on every session regardless of whether anything
	// analytical was produced that session. Without `subpath`, that
	// heartbeat's mtime masks a stalled or never-run stream exactly the way
	// `bursar/sessions` masked a frozen `bursar/projects`. This is that trap
	// for the per-key layout, and the most important test in this file.
	it("ignores a per-key heartbeat and reports the subpath's own mtime", () => {
		const env = emptyDir();
		// key1 has only ever produced a heartbeat - no lessons yet. It must
		// not count, and must not be flagged unreadable either.
		fileAt(
			env,
			join("librarian", "key1", "manifest.json"),
			"2026-09-02T00:00:00Z",
		);
		// key2's heartbeat is stale, but its lessons output is recent.
		fileAt(
			env,
			join("librarian", "key2", "manifest.json"),
			"2026-01-01T00:00:00Z",
		);
		fileAt(
			env,
			join("librarian", "key2", "lessons", "note.json"),
			"2026-08-07T00:00:00Z",
		);
		const fresh = outputFreshness(entryFor("librarian"), env);
		expect(fresh.mtime?.slice(0, 10)).toBe("2026-08-07");
		expect(fresh.unreadable).toBe(false);
	});

	// macOS drops `.DS_Store` into any directory it has browsed, including
	// plugin output roots - this machine's own `~/.onlooker/historian/` has
	// one sitting right next to a real project key. Treating it as a project
	// key makes `<key>/<subpath>` resolve to `.DS_Store/sessions`, which
	// throws ENOTDIR (not ENOENT), and `classifyRoot` reads any such error as
	// a fault - permanently marking a healthy stream unreadable over a stray
	// metadata file no plugin wrote.
	it("skips a regular file alongside the project-key directories", () => {
		const env = emptyDir();
		const base = env.ONLOOKER_DIR as string;
		fileAt(
			env,
			join("historian", "key1", "sessions", "note.json"),
			"2026-08-07T00:00:00Z",
		);
		writeFileSync(join(base, "historian", ".DS_Store"), "x");
		const fresh = outputFreshness(entryFor("historian"), env);
		expect(fresh.mtime?.slice(0, 10)).toBe("2026-08-07");
		expect(fresh.unreadable).toBe(false);
	});

	// A symlink to a busy sibling must not be followed - that would silently
	// restore the exact trap this table exists to prevent. Following it would
	// also let a symlink cycle regrow the walk's queue forever and hang
	// `onlooker doctor` on a machine that is already misbehaving. Its target
	// IS a directory, so - same as a symlinked root - we cannot verify it
	// points at real output rather than something else entirely, and it
	// counts `unreadable` rather than a silent, incidental skip.
	it("does not follow a symlink into a sibling output tree", () => {
		const env = emptyDir();
		fileAt(
			env,
			join("bursar", "projects", "a", "sessions.jsonl"),
			"2026-07-01T00:00:00Z",
		);
		fileAt(
			env,
			join("bursar", "sessions", "today.jsonl"),
			"2026-09-02T00:00:00Z",
		);
		symlinkSync(
			join(env.ONLOOKER_DIR as string, "bursar", "sessions"),
			join(env.ONLOOKER_DIR as string, "bursar", "projects", "link"),
		);
		const fresh = outputFreshness(entryFor("bursar"), env);
		expect(fresh.mtime?.slice(0, 10)).toBe("2026-07-01");
		expect(fresh.unreadable).toBe(true);
	});

	// Same shape as the mid-walk case above, one level down: a project KEY
	// (not a subpath root) that is itself a symlink resolving to a directory
	// with real output. Plain entries and `subpath` entries must agree -
	// that equivalence is the whole point of this fix.
	it("flags unreadable for a project-key symlink whose target holds real output", () => {
		const env = emptyDir();
		const base = env.ONLOOKER_DIR as string;
		fileAt(
			env,
			join("elsewhere", "lessons", "note.json"),
			"2026-08-07T00:00:00Z",
		);
		mkdirSync(join(base, "librarian"), { recursive: true });
		symlinkSync(join(base, "elsewhere"), join(base, "librarian", "linked-key"));
		const fresh = outputFreshness(entryFor("librarian"), env);
		expect(fresh.unreadable).toBe(true);
		expect(fresh.mtime).toBeNull();
	});

	// A symlinked "key" whose target is a regular file - not a directory -
	// was never a project key and cannot be masking a busy sibling, same
	// reasoning as the `.DS_Store` case above. It must not cost the stream
	// its unreadable-free reading, and a real key's output must still count.
	it("does not flag unreadable for a project-key symlink to a regular file", () => {
		const env = emptyDir();
		const base = env.ONLOOKER_DIR as string;
		fileAt(
			env,
			join("librarian", "key1", "lessons", "note.json"),
			"2026-08-07T00:00:00Z",
		);
		writeFileSync(join(base, "README.md"), "x");
		symlinkSync(
			join(base, "README.md"),
			join(base, "librarian", "readme-link"),
		);
		const fresh = outputFreshness(entryFor("librarian"), env);
		expect(fresh.unreadable).toBe(false);
		expect(fresh.mtime?.slice(0, 10)).toBe("2026-08-07");
	});

	// The queue-based walk must survive something bad NESTED several levels
	// in, not just at the level the caller passed in - a refactor that
	// early-returned on the first bad item would still pass a suite where
	// the bad item is the only thing the walk ever sees.
	it("keeps a good nested timestamp when a different nested item is unreadable", () => {
		const env = emptyDir();
		const base = env.ONLOOKER_DIR as string;
		fileAt(
			env,
			join("bursar", "projects", "good", "deep", "sessions.jsonl"),
			"2026-08-07T00:00:00Z",
		);
		fileAt(env, join("elsewhere", "busy.jsonl"), "2026-09-02T00:00:00Z");
		mkdirSync(join(base, "bursar", "projects", "bad"), { recursive: true });
		symlinkSync(
			join(base, "elsewhere"),
			join(base, "bursar", "projects", "bad", "link"),
		);
		const fresh = outputFreshness(entryFor("bursar"), env);
		expect(fresh.mtime?.slice(0, 10)).toBe("2026-08-07");
		expect(fresh.unreadable).toBe(true);
	});

	// Same partial-failure promise, via the subpath branch's own mechanism:
	// a key whose `<subpath>` is a plain file, not a directory, must not
	// cost a sibling key its real, listable output.
	it("keeps a good key's timestamp when a different key's subpath is a file, not a directory", () => {
		const env = emptyDir();
		fileAt(
			env,
			join("librarian", "good-key", "lessons", "note.json"),
			"2026-08-07T00:00:00Z",
		);
		fileAt(
			env,
			join("librarian", "bad-key", "lessons"),
			"2026-01-01T00:00:00Z",
		);
		const fresh = outputFreshness(entryFor("librarian"), env);
		expect(fresh.mtime?.slice(0, 10)).toBe("2026-08-07");
		expect(fresh.unreadable).toBe(true);
	});

	// lstatSync never follows the link, so a target that does not exist must
	// not throw and must not flag the stream unreadable.
	it("does not flag unreadable for a dangling symlink", () => {
		const env = emptyDir();
		fileAt(
			env,
			join("bursar", "projects", "a", "sessions.jsonl"),
			"2026-07-01T00:00:00Z",
		);
		symlinkSync(
			join(env.ONLOOKER_DIR as string, "bursar", "projects", "does-not-exist"),
			join(env.ONLOOKER_DIR as string, "bursar", "projects", "dangling"),
		);
		const fresh = outputFreshness(entryFor("bursar"), env);
		expect(fresh.unreadable).toBe(false);
		expect(fresh.mtime?.slice(0, 10)).toBe("2026-07-01");
	});

	// The entry-level symlink guard only covers symlinks discovered *inside*
	// the walk. `readdirSync` follows a symlinked directory without
	// complaint, so if the declared output path itself is a symlink to a
	// busy sibling, the walk would enumerate the sibling's contents and
	// report a frozen stream as fresh - the exact bug this table exists to
	// prevent, restored through the one door the entry-level guard does not
	// cover. A symlinked root cannot be verified as the real output, so it
	// must read as unreadable, not as a clean pass.
	it("does not follow a symlinked output root", () => {
		const env = emptyDir();
		const base = env.ONLOOKER_DIR as string;
		fileAt(
			env,
			join("bursar", "sessions", "today.jsonl"),
			"2026-09-02T00:00:00Z",
		);
		symlinkSync(
			join(base, "bursar", "sessions"),
			join(base, "bursar", "projects"),
		);
		const fresh = outputFreshness(entryFor("bursar"), env);
		expect(fresh.unreadable).toBe(true);
		expect(fresh.mtime).toBeNull();
	});

	// Same trap, one level down: a per-key `<subpath>` can itself be a
	// symlink to a busy directory under a different key.
	it("does not follow a symlinked per-key subpath root", () => {
		const env = emptyDir();
		const base = env.ONLOOKER_DIR as string;
		fileAt(
			env,
			join("librarian", "decoy", "note.json"),
			"2026-09-02T00:00:00Z",
		);
		mkdirSync(join(base, "librarian", "key1"), { recursive: true });
		symlinkSync(
			join(base, "librarian", "decoy"),
			join(base, "librarian", "key1", "lessons"),
		);
		const fresh = outputFreshness(entryFor("librarian"), env);
		expect(fresh.unreadable).toBe(true);
		expect(fresh.mtime).toBeNull();
	});

	// scribe's real shape: a session-start heartbeat (`sessions/`) and the
	// real per-key output (`<key>/<date>-<session>.md`) are SIBLINGS under
	// `scribe/`, not nested one inside the other, so `subpath` cannot
	// separate them. `ignore` must remove the heartbeat from contention even
	// though it is the newer of the two - this is the bursar trap in
	// miniature, and the most important test in this file.
	it("ignores a sibling directory named in `ignore`", () => {
		const env = emptyDir();
		fileAt(
			env,
			join("scribe", "a-project", "2026-08-07-abc123.md"),
			"2026-08-07T00:00:00Z",
		);
		fileAt(
			env,
			join("scribe", "sessions", "abc123.json"),
			"2026-09-02T00:00:00Z",
		);
		const fresh = outputFreshness(entryFor("scribe"), env);
		expect(fresh.mtime?.slice(0, 10)).toBe("2026-08-07");
		expect(fresh.unreadable).toBe(false);
	});

	// A dangling symlink's target does not exist, so - unlike a symlinked key
	// that resolves - it cannot be masking a busy sibling directory. It must
	// read the same as an absent key, not as a fault, matching the
	// file-level symlink policy this file already uses.
	it("does not flag unreadable for a dangling symlink at the project-key level", () => {
		const env = emptyDir();
		const base = env.ONLOOKER_DIR as string;
		fileAt(
			env,
			join("librarian", "key1", "lessons", "note.json"),
			"2026-08-07T00:00:00Z",
		);
		symlinkSync(
			join(base, "librarian", "does-not-exist"),
			join(base, "librarian", "old-key"),
		);
		const fresh = outputFreshness(entryFor("librarian"), env);
		expect(fresh.unreadable).toBe(false);
		expect(fresh.mtime?.slice(0, 10)).toBe("2026-08-07");
	});

	// `newest` must distinguish "nothing found" from "found, mtime 0" - a file
	// restored with a zeroed timestamp is real output, and collapsing it into
	// the same sentinel used for "no files exist here" would report a
	// directory full of files as having produced nothing at all.
	it("reports an epoch mtime as real output, not as absent", () => {
		const env = emptyDir();
		fileAt(
			env,
			join("bursar", "projects", "a", "sessions.jsonl"),
			"1970-01-01T00:00:00.000Z",
		);
		const fresh = outputFreshness(entryFor("bursar"), env);
		expect(fresh.mtime).toBe(new Date(0).toISOString());
		expect(fresh.unreadable).toBe(false);
	});

	// A clean repo audited daily writes `runs/` every time and `findings/`
	// never - `subpath: "runs"` must see that as real, ongoing activity, not
	// as a stall.
	it("reports a real mtime from a populated runs/ beside an empty findings/", () => {
		const env = emptyDir();
		const base = env.ONLOOKER_DIR as string;
		fileAt(
			env,
			join("cartographer", "key1", "runs", "audit-1.json"),
			"2026-08-07T00:00:00Z",
		);
		mkdirSync(join(base, "cartographer", "key1", "findings"), {
			recursive: true,
		});
		const fresh = outputFreshness(entryFor("cartographer"), env);
		expect(fresh.mtime?.slice(0, 10)).toBe("2026-08-07");
		expect(fresh.unreadable).toBe(false);
	});
});

describe("mtimeToIso", () => {
	// `Date#toISOString` throws `RangeError: Invalid time value` for
	// anything beyond +-8.64e15ms from the epoch, or for NaN - a bad clock
	// write or a botched archive extraction is enough to produce either.
	// `outputFreshness` documents "never throws," so this must report
	// rather than propagate the exception.
	it("reports null instead of throwing for an out-of-range mtime", () => {
		expect(mtimeToIso(8_640_000_000_000_001)).toBeNull();
		expect(mtimeToIso(-8_640_000_000_000_001)).toBeNull();
		expect(mtimeToIso(Number.NaN)).toBeNull();
	});

	it("converts an in-range mtime normally", () => {
		expect(mtimeToIso(0)).toBe(new Date(0).toISOString());
	});
});

describe("clearsCadenceFloor", () => {
	// counsel's brief is gated to once per 168 hours (synthesis_interval_
	// days: 7). A stall verdict must not fire just because STALL_THRESHOLD's
	// firing count was crossed inside that window - the writer legitimately
	// has not run yet. This is the most important test in this block.
	it("does not clear the floor while inside the gate window", () => {
		const mtime = "2026-09-01T00:00:00Z";
		const now = new Date("2026-09-03T00:00:00Z"); // 48h later; gate is 168h.
		expect(clearsCadenceFloor(entryFor("counsel"), mtime, now)).toBe(false);
	});

	// Twice the gate (336h here) clears margin the same way STALL_THRESHOLD
	// clears one session's worth of legitimate lag.
	it("clears the floor once twice the gate has elapsed", () => {
		const mtime = "2026-08-01T00:00:00Z";
		const now = new Date("2026-08-15T01:00:00Z"); // 337h later; floor is 336h.
		expect(clearsCadenceFloor(entryFor("counsel"), mtime, now)).toBe(true);
	});

	// A plain entry's trigger IS its writer - STALL_THRESHOLD was already
	// the whole rule for it, and this field's absence must not add a floor
	// that was never asked for.
	it("always clears the floor for an entry with no write gate", () => {
		const mtime = "2026-09-02T23:59:00Z";
		const now = new Date("2026-09-03T00:00:00Z"); // 1 minute later.
		expect(clearsCadenceFloor(entryFor("bursar"), mtime, now)).toBe(true);
	});

	it("clears the floor when there is no mtime to measure elapsed time against", () => {
		expect(clearsCadenceFloor(entryFor("counsel"), null, new Date())).toBe(
			true,
		);
	});
});

describe("outputLabel", () => {
	it("renders a subpath entry with a wildcard key segment", () => {
		expect(outputLabel(entryFor("bursar"))).toBe(join("bursar", "projects"));
		expect(outputLabel(entryFor("librarian"))).toBe(
			join("librarian", "*", "lessons"),
		);
	});
});

describe("STALL_THRESHOLD", () => {
	// Every stream in the table can legitimately lag its trigger by one
	// session; bursar-session-start fires before bursar-session-end writes.
	// Five clears that with margin. The real outage hit 71.
	it("sits above one session of legitimate lag", () => {
		expect(STALL_THRESHOLD).toBe(5);
	});
});
