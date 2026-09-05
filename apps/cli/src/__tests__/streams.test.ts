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
	doctorLines,
	exitCodeFor,
	mtimeToIso,
	opportunitiesSince,
	outputFreshness,
	outputLabel,
	SESSION_STALL_THRESHOLD,
	STALL_THRESHOLD,
	STREAMS,
	surveyStreams,
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

	// writeHooks pins which hooks a firing-count stall check may trust.
	// bursar-session-start fires without implying a write; lineage has no
	// reliable write hook at all, since its one hook name covers Bash as
	// well as Edit/Write/MultiEdit.
	//
	// archivist-extract, assayer-stop, and librarian-session-end were all
	// pinned as reliable once (a source read that stopped at "this hook
	// writes something on its intended path" without checking how often it
	// bails before reaching it). Fix round 2 read each script in full and
	// found each one bails without writing at several ordinary sites - see
	// each entry's own table comment for the file:line list - so all three
	// are undefined here now. historian-session-end is the one entry that
	// survived the same re-read: its only plausible ordinary bail
	// (too_short) is a single condition, not several stacked ones, and
	// nothing downstream of a real write can silently drop it the way
	// librarian's classifier/durability funnel can.
	it("pins which hooks are reliable write triggers versus mere firings", () => {
		expect(entryFor("bursar").writeHooks).toEqual(["bursar-session-end"]);
		expect(entryFor("historian").writeHooks).toEqual(["historian-session-end"]);
		expect(entryFor("archivist").writeHooks).toBeUndefined();
		expect(entryFor("assayer").writeHooks).toBeUndefined();
		expect(entryFor("librarian").writeHooks).toBeUndefined();
		expect(entryFor("lineage").writeHooks).toBeUndefined();
	});

	// `output: null` entries have no separate write axis - `writeHooks` here
	// means "reliably implies an EVENT was emitted" instead (see its own
	// docstring). Fix round 2 read all four `output: null` scripts in full:
	// inspector's one hook always emits on the only tool calls its matcher
	// ever lets through, so it is trusted; compass's other three hooks never
	// emit at all, leaving only its Bash write-pattern gate; ecosystem's
	// fourteen split five ways once each was actually read, not inferred
	// from its tracker-sounding name (see its own table comment for the
	// full account); warden's three hooks all fire far more often than they
	// ever emit, leaving nothing to trust at all.
	it("pins which output:null entries have a hook that reliably implies an emission", () => {
		expect(entryFor("inspector").writeHooks).toEqual(["inspector-post-write"]);
		expect(entryFor("compass").writeHooks).toEqual(["compass-bash-gate"]);
		expect(entryFor("ecosystem").writeHooks).toEqual([
			"session-start-tracker",
			"session-end-tracker",
			"turn-tracker",
			"tool-history-tracker",
			"skill-usage-tracker",
			"agent-spawn-tracker",
			"task-tracker",
			"context-compact-tracker",
			"worktree-tracker",
		]);
		expect(entryFor("warden").writeHooks).toBeUndefined();
	});

	it("declares no writeEvents naming an event type its own entry does not emit", () => {
		for (const entry of STREAMS) {
			for (const type of entry.writeEvents ?? []) {
				// A write event must belong to a prefix this entry already
				// tracks, or the rule would look it up in a map that is scoped
				// to different prefixes and silently never find it.
				expect(
					entry.events.some((prefix) => type.startsWith(`${prefix}.`)),
					`${entry.plugin}: writeEvents entry ${type} matches none of its events prefixes`,
				).toBe(true);
			}
		}
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

	// The test above catches `.DS_Store` sitting where a KEY belongs -
	// already skipped by the project-key classification. One dropped
	// INSIDE a key's own directory (Finder browsing that specific folder,
	// not just the plugin root) is real content by every check the walk
	// already has, and `newestMtime` counts it like any other file. Global
	// filesystem noise, not a per-entry `ignore` concern: no plugin ever
	// wrote it, and no table entry should need to know its name to skip it.
	it("ignores OS metadata files anywhere in the walk, not just at the key level", () => {
		const env = emptyDir();
		fileAt(
			env,
			join("bursar", "projects", "a", "sessions.jsonl"),
			"2026-07-01T00:00:00Z",
		);
		// Written today by Finder browsing the key's own directory - newer
		// than the real output, and must not count.
		fileAt(
			env,
			join("bursar", "projects", "a", ".DS_Store"),
			"2026-09-02T00:00:00Z",
		);
		const fresh = outputFreshness(entryFor("bursar"), env);
		expect(fresh.mtime?.slice(0, 10)).toBe("2026-07-01");
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
		expect(outputLabel(entryFor("librarian"))).toBe(
			join("librarian", "*", "lessons"),
		);
	});

	// bursar is perProject but has no subpath of its own - the walk still
	// only ever covers <output>/<this repo's own keys>, not the whole
	// output root, and the label must say so. Before this fix it read
	// "bursar/projects" unqualified, overstating what was actually
	// measured: a user who then listed that directory and found a sibling
	// repo's key written yesterday would have every reason to think the
	// tool was simply wrong.
	it("renders a perProject entry with no subpath of its own with a wildcard key segment too", () => {
		expect(outputLabel(entryFor("bursar"))).toBe(
			join("bursar", "projects", "*"),
		);
	});

	// governor is flat and genuinely machine-wide (see its own table
	// comment) - its label must not claim a per-key scope it was never
	// given.
	it("renders a flat, non-per-project entry with no wildcard at all", () => {
		expect(outputLabel(entryFor("governor"))).toBe("governance");
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

describe("SESSION_STALL_THRESHOLD", () => {
	it("sets a session stall threshold above the measured noise floor", () => {
		// Floor is 1: over the six opportunities this repo had between
		// 2026-08-30 and 2026-09-05, bursar fired in 6, and lineage, inspector
		// and assayer each in 5 - a longest healthy silent run of 1. Ceiling is
		// those same 6. See onlooker-run for the recheck.
		expect(SESSION_STALL_THRESHOLD).toBeGreaterThan(1);
		expect(SESSION_STALL_THRESHOLD).toBeLessThanOrEqual(6);
	});
});

/**
 * Session id `machine()`'s own `projectKeys` option ties its
 * synthetic `session.start` (and each `project_key`-tagged event) to -
 * exposed so a test that needs to add MORE events for "this repo's own
 * session," rather than a foreign one, can reuse it instead of duplicating
 * the literal.
 */
const MACHINE_SESSION_ID = "machine-project-keys";

/**
 * Build a machine: a temp `$ONLOOKER_DIR` with both logs, plus a project tree
 * whose `.claude/settings.json` enables `plugins`.
 */
function machine(opts: {
	plugins: string[];
	events?: unknown[];
	hooks?: unknown[];
	files?: Array<[string, string]>;
	/** Skip writing `logs/onlooker-events.jsonl` at all, so scanEvents reports `missing`. */
	skipEventsLog?: boolean;
	/** Skip writing `.claude/settings.json`, so enablement reads `unknown`. */
	noSettings?: boolean;
	/**
	 * This repo's own project keys - established the real way `scanEvents`
	 * derives them, not a test-only bypass: a `.git` marker under `cwd` so
	 * `repoRoot(cwd)` resolves to it, plus a synthetic `session.start`
	 * event rooted there and one `project_key`-tagged event per key, tied
	 * to the same session. Required by any test exercising a per-project
	 * entry (see `StreamEntry.perProject`) - without it, `events.projectKeys`
	 * stays empty and `judge()` reports `unknown` before looking at
	 * anything else.
	 *
	 * Event type `onlooker.project_key.sync` and a fixed 1970 timestamp: no
	 * table entry tracks the `onlooker` prefix, and the timestamp never
	 * wins any real entry's `lastEvent` computation against a 2026 fixture.
	 */
	projectKeys?: string[];
}): { cwd: string; home: string; configDir: string; env: NodeJS.ProcessEnv } {
	const dir = mkdtempSync(join(tmpdir(), "onlooker-survey-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, "logs"), { recursive: true });

	const home = mkdtempSync(join(tmpdir(), "onlooker-survey-home-"));
	onTestFinished(() => rmSync(home, { recursive: true, force: true }));
	const cwd = mkdtempSync(join(tmpdir(), "onlooker-survey-proj-"));
	onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));

	const events = [...(opts.events ?? [])];
	if (opts.projectKeys !== undefined) {
		mkdirSync(join(cwd, ".git"), { recursive: true });
		const sessionId = MACHINE_SESSION_ID;
		events.push({
			event_type: "session.start",
			timestamp: "1970-01-01T00:00:00Z",
			session_id: sessionId,
			payload: { working_directory: cwd },
		});
		for (const key of opts.projectKeys) {
			events.push({
				event_type: "onlooker.project_key.sync",
				timestamp: "1970-01-01T00:00:00Z",
				session_id: sessionId,
				payload: { project_key: key },
			});
		}
	}

	const write = (name: string, lines: unknown[]) =>
		writeFileSync(
			join(dir, "logs", name),
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
		);
	if (!opts.skipEventsLog) write("onlooker-events.jsonl", events);
	write("hook-health.jsonl", opts.hooks ?? []);
	for (const [rel, iso] of opts.files ?? [])
		fileAt({ ONLOOKER_DIR: dir }, rel, iso);

	if (!opts.noSettings) {
		mkdirSync(join(cwd, ".claude"), { recursive: true });
		writeFileSync(
			join(cwd, ".claude", "settings.json"),
			JSON.stringify({
				enabledPlugins: Object.fromEntries(
					opts.plugins.map((p) => [`${p}@onlooker-community`, true]),
				),
			}),
		);
	}
	// An empty config dir, never the developer's real one. Without this every
	// test below reads whatever CLAUDE_CONFIG_DIR points at on this machine.
	const configDir = mkdtempSync(join(tmpdir(), "onlooker-survey-cfg-"));
	onTestFinished(() => rmSync(configDir, { recursive: true, force: true }));
	return { cwd, home, configDir, env: { ONLOOKER_DIR: dir } };
}

const verdictFor = (
	survey: Awaited<ReturnType<typeof surveyStreams>>,
	plugin: string,
) => survey.verdicts.find((v) => v.plugin === plugin)?.verdict;

describe("surveyStreams", () => {
	// The bursar trap a third time, one level down: a per-project entry's
	// freshness walk must be scoped to THIS repo's own project keys, not
	// every key discovered under the output root. Two repos on one machine
	// - ours frozen for months, a sibling's writing daily - must not let a
	// busy sibling key mask our own frozen one, the same way `bursar/
	// sessions` once masked a frozen `bursar/projects`.
	it("scopes a per-project stream's freshness to this repo's own project keys, not a sibling's", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["bursar"],
			projectKeys: ["aaaaaaaaaaaa"],
			files: [
				[
					join("bursar", "projects", "aaaaaaaaaaaa", "sessions.jsonl"),
					"2026-06-01T00:00:00Z",
				],
				// A sibling repo's key, busy and fresh - must never be
				// consulted when computing OUR verdict.
				[
					join("bursar", "projects", "bbbbbbbbbbbb", "sessions.jsonl"),
					"2026-09-02T00:00:00Z",
				],
			],
			hooks: Array.from({ length: 20 }, (_, i) => ({
				hook: "bursar-session-end",
				timestamp: `2026-06-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
				status: "success",
				session_id: MACHINE_SESSION_ID,
			})),
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(verdictFor(survey, "bursar")?.kind).toBe("stopped");
	});

	// The case the acceptance criterion names. Busy input, stale output, hook
	// firing successfully throughout.
	it("reports a stream as stopped when its hook fires and its output does not move", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["bursar"],
			projectKeys: ["aaaaaaaaaaaa"],
			files: [
				[
					join("bursar", "projects", "aaaaaaaaaaaa", "sessions.jsonl"),
					"2026-08-07T00:00:00Z",
				],
				[join("bursar", "sessions", "today.jsonl"), "2026-09-02T00:00:00Z"],
			],
			hooks: Array.from({ length: 20 }, (_, i) => ({
				hook: "bursar-session-end",
				timestamp: `2026-08-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
				status: "success",
				session_id: MACHINE_SESSION_ID,
			})),
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		const verdict = verdictFor(survey, "bursar");
		expect(verdict?.kind).toBe("stopped");
		expect(verdict?.kind === "stopped" && verdict.detail).toContain(
			"bursar-session-end",
		);
	});

	// NOT events alone: an output:null stream's only remaining axis is the
	// event stream itself, and the event stream needs its own trigger to
	// corroborate it, exactly like every other branch in this design (see
	// the `entry.output === null` block below for why). A hook firing
	// close behind the event is what makes this "recording" rather than
	// "unknown" - without it, this fixture would have no hook records to
	// compare against at all.
	it("reports a stream with no output path as recording when its events and hooks are both recent", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["inspector"],
			events: [
				{
					event_type: "inspector.check.passed",
					timestamp: "2026-09-02T00:00:00Z",
					session_id: "s",
					payload: {},
				},
			],
			hooks: [
				{
					hook: "inspector-post-write",
					timestamp: "2026-09-02T00:00:05Z",
					status: "success",
				},
			],
		});
		// Pinned close to the evidence rather than left to the real clock:
		// once RECORDING_FRESHNESS_LIMIT_MS exists, a `recording` verdict is
		// genuinely time-dependent here, not just theoretically so.
		const now = new Date("2026-09-03T00:00:00Z");
		expect(
			verdictFor(
				await surveyStreams({ cwd, home, configDir, env, now }),
				"inspector",
			)?.kind,
		).toBe("recording");
	});

	// ecosystem's real shape, and the failure this whole feature exists to
	// prevent: its trackers died 2026-08-07 (the real outage date), and the
	// event log still holds session.*/tool.* records up to that day. With
	// no output path to compare against, the trigger (its hooks) is the
	// only remaining axis - if the hooks keep firing and the events do not
	// follow, the events have stopped even though the trigger has not.
	it("reports an output:null stream stopped when its hooks keep firing but its events have stopped landing", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["ecosystem"],
			events: [
				{
					event_type: "session.start",
					timestamp: "2026-08-07T00:00:00Z",
					session_id: "s",
					payload: {},
				},
			],
			hooks: [
				{
					hook: "session-start-tracker",
					timestamp: "2026-09-02T00:00:00Z",
					status: "success",
				},
			],
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(verdictFor(survey, "ecosystem")?.kind).toBe("stopped");
	});

	it("reports an output:null stream recording when its hooks and events move together", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["ecosystem"],
			events: [
				{
					event_type: "session.start",
					timestamp: "2026-09-02T00:00:00Z",
					session_id: "s",
					payload: {},
				},
			],
			hooks: [
				{
					hook: "session-start-tracker",
					timestamp: "2026-09-02T00:00:05Z",
					status: "success",
				},
			],
		});
		// Pinned close to the evidence - see the inspector test above.
		const now = new Date("2026-09-03T00:00:00Z");
		const survey = await surveyStreams({ cwd, home, configDir, env, now });
		expect(verdictFor(survey, "ecosystem")?.kind).toBe("recording");
	});

	// Events exist, but nothing in hook-health can corroborate them - a
	// thing this rule could not measure does not get a clean bill, same as
	// everywhere else in this design.
	it("reports an output:null stream unknown when it has events but no hook records to compare", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["ecosystem"],
			events: [
				{
					event_type: "session.start",
					timestamp: "2026-09-02T00:00:00Z",
					session_id: "s",
					payload: {},
				},
			],
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(verdictFor(survey, "ecosystem")?.kind).toBe("unknown");
	});

	// warden's real shape, and fix round 3's own flagship case: warden-pre-
	// tool-use fires on every Write/Edit/MultiEdit/Bash but only emits
	// warden.gate.blocked once the gate is already closed; warden-post-
	// tool-use fires on every WebFetch/Read but only emits
	// warden.threat.detected on a positive scan hit. Before this fix,
	// judge() trusted every one of these hooks' raw `.last` timestamps as
	// the trigger axis, so ordinary tool activity outrunning a rare
	// detection read as `stopped` - permanently, on any machine that has
	// not been blocked recently, which is most of them. warden has no
	// hook this table trusts as emission evidence at all (see its own
	// table entry), so this now reads `unknown` - not a clean bill, but not
	// a false alarm either.
	it("reads warden as unknown, not permanently stopped, when its hooks fire constantly but rarely emit", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["warden"],
			events: [
				{
					event_type: "warden.threat.detected",
					timestamp: "2026-08-01T21:13:33Z",
					session_id: "s",
					payload: {},
				},
			],
			hooks: Array.from({ length: 200 }, (_, i) => ({
				hook: "warden-pre-tool-use",
				timestamp: `2026-09-${String(1 + (i % 2)).padStart(2, "0")}T00:00:00Z`,
				status: "success",
			})),
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(verdictFor(survey, "warden")?.kind).toBe("unknown");
	});

	// The vocabulary is owned by another repo. A plugin we have no rule for
	// must be named, never silently dropped and never assumed healthy.
	it("names an enabled plugin that has no table entry", async () => {
		const { cwd, home, configDir, env } = machine({ plugins: ["brandnew"] });
		expect(
			verdictFor(await surveyStreams({ cwd, home, configDir, env }), "brandnew")
				?.kind,
		).toBe("no-rule");
	});

	// Archivist on the real machine: holding data, deliberately not enabled.
	// Reporting it as a fault would cry wolf about a decision made on purpose.
	it("puts a stream that is writing but not enabled in the footer, not the verdicts", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["bursar"],
			files: [[join("archivist", "note.json"), "2026-08-07T00:00:00Z"]],
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(survey.footer.map((f) => f.plugin)).toContain("archivist");
		expect(survey.verdicts.map((v) => v.plugin)).not.toContain("archivist");
	});

	// A stream we could not measure does not get a clean bill. NOT
	// `librarian/k/x.json` (a plain file outside `lessons/`) - that resolves
	// `outputFreshness` to `{ mtime: null }` and exercises the `outputAt ===
	// null` branch instead, leaving the `measurable.length === 0` branch
	// this test names with zero coverage. `librarian/k/lessons/note.json` is
	// real subpath output, so this only passes if that specific branch -
	// output present, no matching hook-health record - is the one reached.
	it("reports unknown when a stream has output but no hook to compare against", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["librarian"],
			projectKeys: ["aaaaaaaaaaaa"],
			files: [
				[
					join("librarian", "aaaaaaaaaaaa", "lessons", "note.json"),
					"2026-07-01T00:00:00Z",
				],
			],
		});
		expect(
			verdictFor(
				await surveyStreams({ cwd, home, configDir, env }),
				"librarian",
			)?.kind,
		).toBe("unknown");
	});

	it("carries the unknown enablement through rather than inventing an empty set", async () => {
		const bare = mkdtempSync(join(tmpdir(), "onlooker-noconf-"));
		onTestFinished(() => rmSync(bare, { recursive: true, force: true }));
		const home = mkdtempSync(join(tmpdir(), "onlooker-nohome-"));
		onTestFinished(() => rmSync(home, { recursive: true, force: true }));
		const configDir = mkdtempSync(join(tmpdir(), "onlooker-nocfg-"));
		onTestFinished(() => rmSync(configDir, { recursive: true, force: true }));
		const logDir = mkdtempSync(join(tmpdir(), "onlooker-nodir-"));
		onTestFinished(() => rmSync(logDir, { recursive: true, force: true }));
		const survey = await surveyStreams({
			cwd: bare,
			home,
			// Without an empty configDir this reads the developer's real
			// settings.json and comes back "found", not "unknown".
			configDir,
			env: { ONLOOKER_DIR: logDir },
		});
		expect(survey.enablement.kind).toBe("unknown");
		expect(survey.verdicts).toEqual([]);
	});

	it("reports a missing event log as a fault instead of throwing", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "onlooker-nolog-"));
		onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
		const home = mkdtempSync(join(tmpdir(), "onlooker-nolog-home-"));
		onTestFinished(() => rmSync(home, { recursive: true, force: true }));
		const configDir = mkdtempSync(join(tmpdir(), "onlooker-nolog-cfg-"));
		onTestFinished(() => rmSync(configDir, { recursive: true, force: true }));
		const logDir = mkdtempSync(join(tmpdir(), "onlooker-nolog-dir-"));
		onTestFinished(() => rmSync(logDir, { recursive: true, force: true }));
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env: { ONLOOKER_DIR: logDir },
		});
		expect(survey.faults.join(" ")).toContain("onlooker-events.jsonl");
	});

	// bursar-session-start fires a whole session before bursar-session-end
	// performs the real write - the exact ordering lag STALL_THRESHOLD was
	// built to tolerate. Counting session-start's own firings anyway would
	// flag a healthy bursar the moment new sessions keep opening, regardless
	// of whether session-end is writing just fine. writeHooks is what keeps
	// a non-write hook's firing from being read as evidence either way.
	it("does not report a stream stopped from a non-write hook's firing alone", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["bursar"],
			projectKeys: ["aaaaaaaaaaaa"],
			files: [
				[
					join("bursar", "projects", "aaaaaaaaaaaa", "sessions.jsonl"),
					"2026-08-07T00:00:00Z",
				],
			],
			hooks: [
				...Array.from({ length: 20 }, (_, i) => ({
					hook: "bursar-session-start",
					timestamp: `2026-08-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
					status: "success",
					session_id: MACHINE_SESSION_ID,
				})),
				{
					hook: "bursar-session-end",
					timestamp: "2026-08-10T00:00:00Z",
					status: "success",
					session_id: MACHINE_SESSION_ID,
				},
			],
		});
		// Pinned close to the evidence rather than left to the real clock:
		// once the firing-count branch is bound by RECORDING_FRESHNESS_LIMIT_MS
		// too, a `recording` verdict is genuinely time-dependent here.
		const now = new Date("2026-08-11T00:00:00Z");
		const survey = await surveyStreams({ cwd, home, configDir, env, now });
		expect(verdictFor(survey, "bursar")?.kind).toBe("recording");
	});

	// lineage's real shape, and the regression that started this fix round:
	// lineage-post-tool-use serves Edit, Write, MultiEdit, AND Bash under one
	// hook name, and Bash outruns Edit roughly 30:1 (lineage's own
	// hooks.json). A firing-count check built from it reads a perfectly
	// healthy lineage as stalled after about five Bash calls with no edit.
	// lineage has no writeHooks, so judge() must fall back to comparing
	// event recency against output recency instead - and that comparison
	// must not be swayed by however many times the hook itself fired.
	it("reads a stream with no writeHooks as recording when events track its output, regardless of hook firings", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["lineage"],
			projectKeys: ["aaaaaaaaaaaa"],
			files: [
				[
					join("lineage", "aaaaaaaaaaaa", "changes.jsonl"),
					"2026-09-02T12:00:00Z",
				],
			],
			events: [
				{
					event_type: "lineage.change.recorded",
					timestamp: "2026-09-02T12:00:05Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
			// session_id set: without it, session scoping (see scanHooks's own
			// sessionIds option) drops every one of these firings before
			// judge() ever sees them, and the test would keep passing even if
			// a regression made the no-writeHooks path start counting hook
			// firings again - the exact false confidence a fixture in this
			// suite must never produce.
			hooks: Array.from({ length: 200 }, (_, i) => ({
				hook: "lineage-post-tool-use",
				timestamp: `2026-09-02T${String(i % 24).padStart(2, "0")}:00:00Z`,
				status: "success",
				session_id: MACHINE_SESSION_ID,
			})),
		});
		// Pinned close to the evidence - see the inspector test above.
		const now = new Date("2026-09-03T00:00:00Z");
		const survey = await surveyStreams({ cwd, home, configDir, env, now });
		expect(verdictFor(survey, "lineage")?.kind).toBe("recording");
	});

	// Same entry, but events keep arriving long after the file stopped
	// moving - the gap the event-vs-output fallback exists to catch. If
	// lineage genuinely broke, this is what that looks like.
	it("reads a stream with no writeHooks as stopped when events outrun its output by more than the tolerance", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["lineage"],
			projectKeys: ["aaaaaaaaaaaa"],
			files: [
				[
					join("lineage", "aaaaaaaaaaaa", "changes.jsonl"),
					"2026-08-01T00:00:00Z",
				],
			],
			events: [
				{
					event_type: "lineage.change.recorded",
					timestamp: "2026-09-02T00:00:00Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(verdictFor(survey, "lineage")?.kind).toBe("stopped");
	});

	// assayer's real shape, and fix round 2's own reproduction: assayer-
	// stop.sh bails without writing an audit at seven ordinary sites (no
	// repo root, no project key, no claude/jq on PATH, no transcript, empty
	// final message, empty claude -p response), measured on a live machine
	// at roughly 10 firings per audit. Before this fix, assayer's writeHooks
	// trusted every one of those 200 firings as evidence of a write, and
	// STALL_THRESHOLD = 5 crossed within hours of any quiet stretch even
	// while assayer was healthy. With writeHooks removed, judge() falls
	// back to the same event-vs-output comparison lineage above uses -
	// assayer's own events are real and uniquely prefixed
	// (`assayer.audit.*`, `assayer.claim.*`), so that fallback still works.
	it("reads assayer as recording via the event-vs-output fallback, not a heavy stop-hook firing count", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["assayer"],
			projectKeys: ["aaaaaaaaaaaa"],
			files: [
				[
					join("assayer", "aaaaaaaaaaaa", "audit-1.json"),
					"2026-09-02T12:00:00Z",
				],
			],
			events: [
				{
					event_type: "assayer.audit.complete",
					timestamp: "2026-09-02T12:00:05Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
			hooks: Array.from({ length: 200 }, (_, i) => ({
				hook: "assayer-stop",
				timestamp: `2026-09-02T${String(i % 24).padStart(2, "0")}:00:00Z`,
				status: "success",
				session_id: MACHINE_SESSION_ID,
			})),
		});
		// Pinned close to the evidence - see the inspector test above.
		const now = new Date("2026-09-03T00:00:00Z");
		const survey = await surveyStreams({ cwd, home, configDir, env, now });
		expect(verdictFor(survey, "assayer")?.kind).toBe("recording");
	});

	// cartographer's real shape, and the cry-wolf bug fix round 1 quietly
	// reintroduced: floorCleared was computed but never consulted in the
	// no-writeHooks fallback, and cartographer/counsel are exactly the two
	// entries that both set writeGateHours AND land in that fallback (their
	// own writeHooks are omitted). A completed audit followed by an
	// ordinary 26h gap before the next one - well inside cartographer's own
	// 24h cadence, and within its 2x floor - must not read as a stall just
	// because 26h is more than EVENT_OUTPUT_TOLERANCE_MS's one hour.
	it("does not report a gated writer with no writeHooks stopped inside its own cadence floor", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["cartographer"],
			projectKeys: ["aaaaaaaaaaaa"],
			files: [
				[
					join("cartographer", "aaaaaaaaaaaa", "runs", "audit-1.json"),
					"2026-08-01T00:00:00Z",
				],
			],
			events: [
				{
					event_type: "cartographer.audit.complete",
					// 26h after the output's mtime: past the 1h event tolerance,
					// but well inside cartographer's own 2 * 24h = 48h floor.
					timestamp: "2026-08-02T02:00:00Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
		});
		// Pinned close to the evidence - see the inspector test above. This
		// one MUST be pinned, not merely for future stability: the evidence
		// is already weeks old relative to the real clock, so it would fail
		// immediately without this once RECORDING_FRESHNESS_LIMIT_MS exists.
		const now = new Date("2026-08-03T00:00:00Z");
		const survey = await surveyStreams({ cwd, home, configDir, env, now });
		expect(verdictFor(survey, "cartographer")?.kind).toBe("recording");
	});

	it("reports a gated writer with no writeHooks stopped once its cadence floor has cleared", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["cartographer"],
			projectKeys: ["aaaaaaaaaaaa"],
			files: [
				[
					join("cartographer", "aaaaaaaaaaaa", "runs", "audit-1.json"),
					"2026-08-01T00:00:00Z",
				],
			],
			events: [
				{
					event_type: "cartographer.audit.complete",
					// 51h after the output's mtime: past the 48h floor.
					timestamp: "2026-08-03T03:00:00Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(verdictFor(survey, "cartographer")?.kind).toBe("stopped");
	});

	// A gated writer (writeGateHours set) that has never produced output
	// cannot be told apart from "hasn't reached its first gate yet" -
	// clearsCadenceFloor needs an mtime to measure elapsed time against, and
	// there is none here. Asserting `stopped` would flag every brand-new
	// counsel install before its first brief is even due.
	it("reports a gated writer with no output as unknown rather than stopped", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["counsel"],
			projectKeys: ["aaaaaaaaaaaa"],
			events: [
				{
					event_type: "counsel.something",
					timestamp: "2026-09-02T00:00:00Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(verdictFor(survey, "counsel")?.kind).toBe("unknown");
	});

	// Generalizes the counsel case above beyond gated writers: curator has
	// no writeGateHours at all, but its scan is conditional (a session with
	// no memory store found writes only the manifest heartbeat, never
	// findings/), and its writeHooks is empty for exactly that reason. A
	// perfectly healthy curator that simply never had a finding must not
	// read as `stopped` any more than a gated one does.
	it("reports an ungated conditional writer with no output as unknown rather than stopped", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["curator"],
			projectKeys: ["aaaaaaaaaaaa"],
			events: [
				{
					event_type: "curator.scan.complete",
					timestamp: "2026-09-02T00:00:00Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(verdictFor(survey, "curator")?.kind).toBe("unknown");
	});

	// The counterpart: historian HAS a writeHook (historian-session-end IS
	// the writer), so a write hook that has genuinely fired past
	// STALL_THRESHOLD with no session ever indexed is exactly what "stopped"
	// means - that is the whole feature. This must stay stopped, not soften
	// into unknown alongside the conditional writers above. NOT a single
	// firing - see the next test for why one event is not enough evidence.
	//
	// Previously used librarian for this pair. A closer read of librarian-
	// session-end.sh (fix round 2) found it is not a reliable write signal
	// either - a multi-stage pipeline with its own session-level bail sites
	// plus a downstream classifier/durability/tombstone funnel any of which
	// can decline without writing - so librarian's `writeHooks` was removed
	// (see its table entry) and this pair moved to historian, the one
	// remaining subpath-based entry a source read confirmed still qualifies.
	it("still reports a stream with a writeHook stopped once its write hook has fired past the threshold with no output", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["historian"],
			projectKeys: ["aaaaaaaaaaaa"],
			events: [
				{
					event_type: "historian.indexing.started",
					timestamp: "2026-09-02T00:00:00Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
			hooks: Array.from({ length: 6 }, (_, i) => ({
				hook: "historian-session-end",
				timestamp: `2026-08-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
				status: "success",
				session_id: MACHINE_SESSION_ID,
			})),
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(verdictFor(survey, "historian")?.kind).toBe("stopped");
	});

	// historian's own too_short/transcript_unavailable skip paths still emit
	// historian.indexing.complete and still fire historian-session-end. A
	// single firing must not read `stopped` on a fresh checkout -
	// STALL_THRESHOLD exists to prevent exactly this everywhere else in this
	// function, and this branch was the one place it was not applied.
	it("does not report a stream stopped from a single write-hook firing with no output yet", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["historian"],
			projectKeys: ["aaaaaaaaaaaa"],
			events: [
				{
					event_type: "historian.indexing.started",
					timestamp: "2026-09-02T00:00:00Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
			hooks: [
				{
					hook: "historian-session-end",
					timestamp: "2026-09-02T00:00:00Z",
					status: "success",
					session_id: MACHINE_SESSION_ID,
				},
			],
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(verdictFor(survey, "historian")?.kind).toBe("unknown");
	});

	// librarian's own new shape, after fix round 2 removed its writeHooks:
	// events present, output never written, and - unlike historian just
	// above - no amount of firing ever reads `stopped` anymore, because
	// there is no longer a hook this table trusts as write evidence for it.
	// This is the same "cannot tell nothing-to-write-yet from broken"
	// fallback curator already takes, now shared by librarian too.
	it("reports librarian unknown rather than stopped now that its write hook is no longer trusted", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["librarian"],
			projectKeys: ["aaaaaaaaaaaa"],
			events: [
				{
					event_type: "librarian.scan.complete",
					timestamp: "2026-09-02T00:00:00Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
			hooks: Array.from({ length: 20 }, (_, i) => ({
				hook: "librarian-session-end",
				timestamp: `2026-08-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
				status: "success",
				session_id: MACHINE_SESSION_ID,
			})),
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(verdictFor(survey, "librarian")?.kind).toBe("unknown");
	});

	// A fully-read log where the prefix never appears is not evidence the
	// stream is healthy - "recording" with nothing to corroborate it
	// contradicts the very next check this function makes for a truncated
	// log.
	it("reports unknown, not recording, when the event log is readable but the stream's prefix never appears", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["lineage"],
			projectKeys: ["aaaaaaaaaaaa"],
			files: [
				[
					join("lineage", "aaaaaaaaaaaa", "changes.jsonl"),
					"2026-08-01T00:00:00Z",
				],
			],
			// events (beyond the projectKeys-establishing ones machine()
			// itself adds) are empty - the log is fully read, just empty for
			// this prefix, not missing.
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(verdictFor(survey, "lineage")?.kind).toBe("unknown");
	});

	// A truncated or unreadable event scan clears lastByPrefix (scanEvents's
	// own contract), so `lastEvent` reads exactly like "no events fired" and
	// the no-writeHooks fallback would otherwise default to `recording` on a
	// source it could not actually read - the writeHooks path already
	// refuses to do this (`measurable.length === 0` reads `unknown` when
	// hook-health itself is unreadable); this is the same promise for the
	// event axis. NOT a per-project entry (lineage): `skipEventsLog` means
	// `machine()`'s own projectKeys-establishing events never get written
	// either, so a per-project entry would hit the "keys could not be
	// determined" guard first and never reach the branch this test names.
	// governor is flat (see its table comment), so it reaches this branch
	// with no per-project interference.
	it("reports unknown, not recording, when the event log is missing for a stream with no writeHooks", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["governor"],
			skipEventsLog: true,
			files: [
				[join("governance", "ledgers", "some.jsonl"), "2026-09-02T00:00:00Z"],
			],
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(verdictFor(survey, "governor")?.kind).toBe("unknown");
	});

	// archivist's only emission is shared with counsel and scribe, so no
	// event prefix can identify it - `lastEvent` is permanently "". This
	// entry used to have a hook-only fallback here that read a genuine
	// outage as `stopped` once archivist-extract's own firings crossed
	// STALL_THRESHOLD with nothing ever written. Fix round 2 removed
	// archivist's `writeHooks` (see its table entry: six ordinary bail
	// sites, plus a seventh "nothing extraction-worthy this session" no-op
	// past all six) - since that hook-only fallback also only trusts
	// `writeHooks`-filtered hooks, archivist lost that detection along with
	// the false positive it was causing. A firing count this high, this
	// consistently, with zero output ever written IS suspicious - but this
	// design's own rule is that an unmeasured thing does not get a verdict
	// asserted about it, and archivist genuinely has no axis left to measure
	// with once its only hook cannot be trusted. `unknown` is the honest
	// answer, not a downgrade applied by accident.
	it("reports archivist unknown, not stopped, from heavy hook firing alone now that the hook is not trusted", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["archivist"],
			projectKeys: ["aaaaaaaaaaaa"],
			hooks: Array.from({ length: 10 }, (_, i) => ({
				hook: "archivist-extract",
				timestamp: `2026-08-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
				status: "success",
				session_id: MACHINE_SESSION_ID,
			})),
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(verdictFor(survey, "archivist")?.kind).toBe("unknown");
	});

	// Same shape below STALL_THRESHOLD - was already `unknown` before fix
	// round 2 for a different reason (too few firings to call it stopped);
	// stays `unknown` after for the same reason as the test just above (no
	// hook this table trusts as write evidence for archivist at all).
	it("still reports archivist unknown when hooks have not crossed the threshold", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["archivist"],
			projectKeys: ["aaaaaaaaaaaa"],
			hooks: [
				{
					hook: "archivist-extract",
					timestamp: "2026-08-10T00:00:00Z",
					status: "success",
					session_id: MACHINE_SESSION_ID,
				},
				{
					hook: "archivist-extract",
					timestamp: "2026-08-11T00:00:00Z",
					status: "success",
					session_id: MACHINE_SESSION_ID,
				},
			],
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(verdictFor(survey, "archivist")?.kind).toBe("unknown");
	});

	// librarian's real output sits at `<key>/lessons`; a key that has only
	// ever written its `manifest.json` heartbeat resolves to a null
	// `outputFreshness` - by design, so a stall check never mistakes the
	// heartbeat for real activity. The footer asks a different question
	// ("is there any data here at all, that this project does not enable"),
	// and a manifest is data a user would want surfaced, not silently
	// dropped because it happens to be a heartbeat rather than an analytical
	// artifact.
	it("puts a stream that has only ever written its heartbeat in the footer", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["bursar"],
			files: [
				[join("librarian", "k1", "manifest.json"), "2026-08-07T00:00:00Z"],
			],
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(survey.footer.map((f) => f.plugin)).toContain("librarian");
	});

	// `enabled` is `[]` whenever enablement itself is unknown - not because
	// this project enables nothing, but because this run could not tell.
	// Building the footer from `enabled` in that state would list every
	// stream holding data as "this project does not enable it," a claim the
	// unknown enablement explicitly does not support. readEnablement keeps
	// "unknown" distinct from "found, empty" on purpose; the footer must not
	// discard that distinction.
	it("does not populate the footer when enablement itself is unknown", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["bursar"],
			noSettings: true,
			files: [[join("archivist", "note.json"), "2026-08-07T00:00:00Z"]],
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(survey.enablement.kind).toBe("unknown");
		expect(survey.footer).toEqual([]);
	});

	// A stale symlink - a relocated checkout leaving `<old-key> ->
	// <moved checkout>` behind, say - makes part of the walk unreadable,
	// but the walk still found a real mtime and the write hook has fired
	// well past the threshold since. `unknown` here would suppress exactly
	// the alarm this feature exists to raise; `stopped` must survive, with
	// the partial listing noted rather than hidden.
	it("keeps a stopped verdict when a stale symlink leaves the walk partial, with a caveat", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["bursar"],
			projectKeys: ["aaaaaaaaaaaa"],
			files: [
				[
					join("bursar", "projects", "aaaaaaaaaaaa", "sessions.jsonl"),
					"2026-06-01T00:00:00Z",
				],
			],
			hooks: Array.from({ length: 20 }, (_, i) => ({
				hook: "bursar-session-end",
				timestamp: `2026-06-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
				status: "success",
				session_id: MACHINE_SESSION_ID,
			})),
		});
		const base = env.ONLOOKER_DIR as string;
		mkdirSync(join(base, "elsewhere-target"), { recursive: true });
		symlinkSync(
			join(base, "elsewhere-target"),
			join(base, "bursar", "projects", "aaaaaaaaaaaa", "stale-link"),
		);
		const survey = await surveyStreams({ cwd, home, configDir, env });
		const verdict = verdictFor(survey, "bursar");
		expect(verdict?.kind).toBe("stopped");
		expect(verdict?.kind === "stopped" && verdict.detail).toContain(
			"bursar-session-end",
		);
		expect(verdict?.kind === "stopped" && verdict.detail).toContain(
			"could not be fully listed",
		);
	});

	// The other direction: when the unreadable path IS the reason there is
	// no mtime at all - nothing else in the walk found any real data -
	// `unknown` is still the right call. Only a well-supported `stopped`
	// survives an unreadable path; a stall this walk genuinely could not
	// measure does not get asserted either.
	it("reports unknown when an unreadable path is the only reason there is no mtime at all", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["bursar"],
			projectKeys: ["aaaaaaaaaaaa"],
			// session_id set for consistency with every other session-scoped
			// fixture in this suite - here it is not load-bearing (the key
			// itself is entirely a symlink below, so outputAt is null and the
			// unreadable-walk degrade is reached before any hook record would
			// matter either way), but an unscoped fixture next to scoped ones
			// is a trap for the next person who copies it into a test where it
			// would matter.
			hooks: Array.from({ length: 20 }, (_, i) => ({
				hook: "bursar-session-end",
				timestamp: `2026-06-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
				status: "success",
				session_id: MACHINE_SESSION_ID,
			})),
		});
		const base = env.ONLOOKER_DIR as string;
		mkdirSync(join(base, "elsewhere-target"), { recursive: true });
		mkdirSync(join(base, "bursar", "projects"), { recursive: true });
		// The key itself is a stale symlink - nothing readable behind it.
		symlinkSync(
			join(base, "elsewhere-target"),
			join(base, "bursar", "projects", "aaaaaaaaaaaa"),
		);
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(verdictFor(survey, "bursar")?.kind).toBe("unknown");
	});

	// The mirror image of the bug project-scoping the output walk fixed,
	// running the other way: our own key sits frozen since 2026-08-01, but
	// a single event from a DIFFERENT repo's session - never rooted here -
	// landing 2026-09-02 must not read as evidence of OUR stream's
	// recency. Our own session's own event, close behind the output's own
	// mtime, is what makes this "recording."
	it("does not let a different repo's session's recent event mask this repo's own frozen stream", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["lineage"],
			projectKeys: ["aaaaaaaaaaaa"],
			files: [
				[
					join("lineage", "aaaaaaaaaaaa", "changes.jsonl"),
					"2026-08-01T00:00:00Z",
				],
			],
			events: [
				{
					event_type: "lineage.change.recorded",
					timestamp: "2026-08-01T00:00:05Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
				// A different repo's session - never rooted at `cwd` - firing
				// much more recently. Must not count toward OUR verdict.
				{
					event_type: "lineage.change.recorded",
					timestamp: "2026-09-02T00:00:00Z",
					session_id: "a-different-repos-session",
					payload: {},
				},
			],
		});
		// Pinned close to OUR OWN session's evidence (2026-08-01), not the
		// excluded foreign session's (2026-09-02) - this must be pinned, not
		// merely for stability, once RECORDING_FRESHNESS_LIMIT_MS exists.
		const now = new Date("2026-08-02T00:00:00Z");
		const survey = await surveyStreams({ cwd, home, configDir, env, now });
		expect(verdictFor(survey, "lineage")?.kind).toBe("recording");
	});

	// Same shape on the firing-count axis: 90 daily firings from a
	// different repo's session, all after our own key's frozen mtime,
	// would push firedSince well past STALL_THRESHOLD under no scoping at
	// all - the reviewer's exact reproduction. Scoped to our own sessions,
	// none of those firings are ours, so bursar-session-end has no records
	// attributable to us at all.
	it("does not let a different repo's session's firings push a stall past the threshold", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["bursar"],
			projectKeys: ["aaaaaaaaaaaa"],
			files: [
				[
					join("bursar", "projects", "aaaaaaaaaaaa", "sessions.jsonl"),
					"2026-06-01T00:00:00Z",
				],
			],
			hooks: Array.from({ length: 90 }, (_, i) => {
				const when = new Date("2026-06-02T00:00:00Z");
				when.setUTCDate(when.getUTCDate() + i);
				return {
					hook: "bursar-session-end",
					timestamp: when.toISOString(),
					status: "success",
					session_id: "a-different-repos-session",
				};
			}),
		});
		const survey = await surveyStreams({ cwd, home, configDir, env });
		expect(verdictFor(survey, "bursar")?.kind).toBe("unknown");
	});

	// The final review's high-severity finding, reproduced directly: a
	// plugin that stops entirely - no more output, no more events - has
	// both timestamps freeze together, so the GAP between them stays small
	// even as the evidence itself goes stale. Neither fallback branch was
	// ever bounded by wall time before this fix - `now` reached judge() and
	// was only ever consulted by clearsCadenceFloor, which returns `true` on
	// every path that reaches it. counsel/governor/tribunal on the real
	// machine hit exactly this: silent for a month, reported `recording`,
	// `doctor` exiting 0.
	it("reports the writeHooks-less output fallback unknown, not recording, when its freshest evidence is stale even though the gap is small", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["lineage"],
			projectKeys: ["aaaaaaaaaaaa"],
			files: [
				[
					join("lineage", "aaaaaaaaaaaa", "changes.jsonl"),
					"2026-08-01T00:00:00Z",
				],
			],
			events: [
				{
					event_type: "lineage.change.recorded",
					// 5 seconds after the output - well inside
					// EVENT_OUTPUT_TOLERANCE_MS - but both are now a month old.
					timestamp: "2026-08-01T00:00:05Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
		});
		const now = new Date("2026-08-31T00:00:00Z");
		const survey = await surveyStreams({ cwd, home, configDir, env, now });
		const verdict = verdictFor(survey, "lineage");
		expect(verdict?.kind).toBe("unknown");
		expect(verdict?.kind === "unknown" && verdict.detail).toContain(
			"2026-08-01",
		);
	});

	// The same bound, applied to the output:null branch (finding 2): if a
	// plugin is removed from hooks.json or its directory disappears, its
	// hook's `.last` and its newest event freeze together at the same
	// instant, `gapMs` stays near zero, and it would read `recording`
	// forever while printing an increasingly stale date. inspector and
	// ecosystem sit on exactly this shape today - nothing in the branch
	// would change if either died tomorrow, without this bound.
	it("reports the output:null branch unknown, not recording, when its freshest evidence is stale even though the gap is small", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["ecosystem"],
			events: [
				{
					event_type: "session.start",
					timestamp: "2026-08-01T00:00:00Z",
					session_id: "s",
					payload: {},
				},
			],
			hooks: [
				{
					hook: "session-start-tracker",
					timestamp: "2026-08-01T00:00:05Z",
					status: "success",
				},
			],
		});
		const now = new Date("2026-08-31T00:00:00Z");
		const survey = await surveyStreams({ cwd, home, configDir, env, now });
		const verdict = verdictFor(survey, "ecosystem");
		expect(verdict?.kind).toBe("unknown");
		expect(verdict?.kind === "unknown" && verdict.detail).toContain(
			"2026-08-01",
		);
	});

	// The bound must never soften an alarm: stale evidence plus a large gap
	// is still `stopped`, not downgraded to `unknown`. This is already true
	// by construction (the freshness check sits after the gap check, never
	// before it), but it is worth locking in explicitly given how easy it
	// would be to place the new check first by accident.
	it("still reports stopped, not unknown, when stale evidence also shows a large gap", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["lineage"],
			projectKeys: ["aaaaaaaaaaaa"],
			files: [
				[
					join("lineage", "aaaaaaaaaaaa", "changes.jsonl"),
					"2026-08-01T00:00:00Z",
				],
			],
			events: [
				{
					event_type: "lineage.change.recorded",
					// Both stale AND a large gap from the output.
					timestamp: "2026-08-20T00:00:00Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
		});
		const now = new Date("2026-08-31T00:00:00Z");
		const survey = await surveyStreams({ cwd, home, configDir, env, now });
		expect(verdictFor(survey, "lineage")?.kind).toBe("stopped");
	});

	// The same bound, applied to the third branch: an entry WITH a trusted
	// writeHooks list (bursar) whose firing count never crosses
	// STALL_THRESHOLD falls through to `recording` on `outputAt` alone, with
	// no comparison against `now` at all - this branch was left out of the
	// first pass on this bound because the finding that prompted it only
	// reproduced the other two. It matters here specifically because bursar,
	// which this repo enables, takes this branch: output frozen months ago
	// plus routine, below-threshold session-end firings reads a clean
	// `recording` off arbitrarily old evidence forever.
	it("reports the firing-count branch unknown, not recording, when output is stale even though the firing count stays below threshold", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["bursar"],
			projectKeys: ["aaaaaaaaaaaa"],
			files: [
				[
					join("bursar", "projects", "aaaaaaaaaaaa", "sessions.jsonl"),
					"2026-08-01T00:00:00Z",
				],
			],
			hooks: [
				{
					hook: "bursar-session-end",
					// One firing, well below STALL_THRESHOLD (5).
					timestamp: "2026-08-01T01:00:00Z",
					status: "success",
					session_id: MACHINE_SESSION_ID,
				},
			],
		});
		const now = new Date("2026-08-31T00:00:00Z");
		const survey = await surveyStreams({ cwd, home, configDir, env, now });
		const verdict = verdictFor(survey, "bursar");
		expect(verdict?.kind).toBe("unknown");
		expect(verdict?.kind === "unknown" && verdict.detail).toContain(
			"2026-08-01",
		);
	});

	// The bound must not weaken `stopped` on this branch either: a firing
	// count that DOES cross STALL_THRESHOLD is `stopped` regardless of how
	// stale the output is - the stopped-loop runs, and returns, before the
	// new freshness check is ever reached.
	it("still reports stopped, not unknown, on the firing-count branch when stale output also shows enough firings to stall", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["bursar"],
			projectKeys: ["aaaaaaaaaaaa"],
			files: [
				[
					join("bursar", "projects", "aaaaaaaaaaaa", "sessions.jsonl"),
					"2026-08-01T00:00:00Z",
				],
			],
			hooks: Array.from({ length: 6 }, (_, i) => ({
				hook: "bursar-session-end",
				timestamp: `2026-08-${String(2 + i).padStart(2, "0")}T00:00:00Z`,
				status: "success",
				session_id: MACHINE_SESSION_ID,
			})),
		});
		const now = new Date("2026-08-31T00:00:00Z");
		const survey = await surveyStreams({ cwd, home, configDir, env, now });
		expect(verdictFor(survey, "bursar")?.kind).toBe("stopped");
	});
});

/** A minimal, valid `StreamSurvey`, overridable field by field. */
const surveyOf = (
	over: Partial<Awaited<ReturnType<typeof surveyStreams>>> = {},
): Awaited<ReturnType<typeof surveyStreams>> => ({
	enablement: {
		kind: "found" as const,
		plugins: [],
		source: "/x/.claude/settings.json",
	},
	projectKeys: [],
	verdicts: [],
	footer: [],
	faults: [],
	...over,
});

describe("doctorLines", () => {
	it("lists streams alphabetically regardless of input order", () => {
		const lines = doctorLines(
			surveyOf({
				verdicts: [
					{ plugin: "lineage", verdict: { kind: "recording", detail: "x" } },
					{ plugin: "assayer", verdict: { kind: "recording", detail: "y" } },
				],
			}),
		);
		const body = lines.filter(
			(l) => l.includes("assayer") || l.includes("lineage"),
		);
		expect(body[0]).toContain("assayer");
		expect(body[1]).toContain("lineage");
	});

	it("shouts about a stopped stream and names the layer", () => {
		const lines = doctorLines(
			surveyOf({
				verdicts: [
					{
						plugin: "bursar",
						verdict: {
							kind: "stopped",
							detail: "bursar-session-end fired 71 times",
						},
					},
				],
			}),
		).join("\n");
		expect(lines).toContain("STOPPED");
		expect(lines).toContain("bursar-session-end fired 71 times");
	});

	it("says it does not know rather than reporting nothing enabled", () => {
		const lines = doctorLines(
			surveyOf({
				enablement: { kind: "unknown", reason: "no .claude/settings.json" },
			}),
		).join("\n");
		expect(lines).toContain("unknown");
		expect(lines).not.toContain("0 plugins enabled");
	});

	it("puts unenabled streams under their own heading", () => {
		const lines = doctorLines(
			surveyOf({
				footer: [{ plugin: "archivist", detail: "last wrote 2026-08-07" }],
			}),
		).join("\n");
		expect(lines).toContain("Not enabled here");
		expect(lines).toContain("archivist");
	});

	// cartographer is exactly as long as the column padding was, so a naive
	// `padEnd` leaves it running straight into its label with no separating
	// space at all - "  cartographerlast wrote 2026-08-07" on a real
	// machine's footer. Pinned on this specific name rather than a
	// hypothetical one, so the next plugin name that reaches the column
	// width fails this test loudly instead of silently running together.
	it("leaves a gap after the longest real plugin name, cartographer", () => {
		const verdictLines = doctorLines(
			surveyOf({
				verdicts: [
					{
						plugin: "cartographer",
						verdict: { kind: "recording", detail: "audited" },
					},
				],
			}),
		);
		const verdictLine = verdictLines.find((l) => l.includes("cartographer"));
		expect(verdictLine).toMatch(/cartographer\s+recording/);

		const footerLines = doctorLines(
			surveyOf({
				footer: [{ plugin: "cartographer", detail: "last wrote 2026-08-07" }],
			}),
		);
		const footerLine = footerLines.find((l) => l.includes("cartographer"));
		expect(footerLine).toMatch(/cartographer\s+last wrote/);
	});

	// The test above pins today's longest name, cartographer, by its
	// literal 12 characters - it says nothing about a FUTURE plugin whose
	// name reaches a NEW longest length, which is the actual promise the
	// column's docstring makes ("the next plugin name that reaches this
	// width fails loudly instead of silently running together"). Deriving
	// the synthetic name's length from STREAMS itself, rather than
	// hardcoding a number, keeps this test honest as the table grows: it
	// exercises the real current boundary on every run, not a boundary
	// that happened to be true once.
	it("leaves a gap after any name as long as the current longest name in STREAMS", () => {
		const maxLen = Math.max(...STREAMS.map((s) => s.plugin.length));
		const syntheticName = "x".repeat(maxLen);
		const lines = doctorLines(
			surveyOf({
				verdicts: [
					{
						plugin: syntheticName,
						verdict: { kind: "recording", detail: "audited" },
					},
				],
			}),
		);
		const line = lines.find((l) => l.includes(syntheticName));
		expect(line).toMatch(new RegExp(`${syntheticName}\\s+recording`));
	});

	// This machine's own footer is routinely two project keys, both
	// legitimate (one partly historical) - "key 6a7678979e31, 80523e1cd7d2"
	// reads as though the second one is a typo. Pluralizes exactly like the
	// plugin count on the same line.
	it("pluralizes the header's key count to match the plugin count's own pluralization", () => {
		const two = doctorLines(
			surveyOf({ projectKeys: ["6a7678979e31", "80523e1cd7d2"] }),
		)[0];
		expect(two).toContain("keys 6a7678979e31, 80523e1cd7d2");
		expect(two).not.toContain("key 6a7678979e31");

		const one = doctorLines(surveyOf({ projectKeys: ["6a7678979e31"] }))[0];
		expect(one).toContain("key 6a7678979e31");
		expect(one).not.toContain("keys 6a7678979e31");
	});
});

describe("exitCodeFor", () => {
	it("exits 0 when every enabled stream is recording", () => {
		expect(
			exitCodeFor(
				surveyOf({
					verdicts: [
						{ plugin: "lineage", verdict: { kind: "recording", detail: "x" } },
					],
				}),
			),
		).toBe(0);
	});

	it("exits 1 when a stream has stopped", () => {
		expect(
			exitCodeFor(
				surveyOf({
					verdicts: [
						{ plugin: "bursar", verdict: { kind: "stopped", detail: "x" } },
					],
				}),
			),
		).toBe(1);
	});

	// Not knowing is not the same as fine, and a retry fixes neither. Same
	// reasoning sync uses when it exits 1 on an unlistable directory.
	it("exits 1 when a source could not be read", () => {
		expect(
			exitCodeFor(
				surveyOf({ faults: ["logs/hook-health.jsonl could not be read"] }),
			),
		).toBe(1);
	});

	it("exits 1 when the expected set is unknown", () => {
		expect(
			exitCodeFor(
				surveyOf({ enablement: { kind: "unknown", reason: "none" } }),
			),
		).toBe(1);
	});

	// "Unknown" is never "healthy" - an unrecognized verdict must not exit 0
	// just because nothing was flagged "stopped." Not knowing is precisely
	// the state this command exists to surface.
	it("exits 1 when a verdict itself is unknown", () => {
		expect(
			exitCodeFor(
				surveyOf({
					verdicts: [
						{
							plugin: "librarian",
							verdict: { kind: "unknown", detail: "no hook records" },
						},
					],
				}),
			),
		).toBe(1);
	});

	// A plugin missing from STREAMS gets no health rule at all - `STREAMS`'s
	// own docstring calls this the expected steady state after a marketplace
	// addition, not an edge case. Exiting 0 here would let a repo that just
	// enabled a brand-new plugin read as fully healthy with zero health
	// information about the one thing that changed.
	it("exits 1 when an enabled plugin has no health rule", () => {
		expect(
			exitCodeFor(
				surveyOf({
					verdicts: [{ plugin: "brandnew", verdict: { kind: "no-rule" } }],
				}),
			),
		).toBe(1);
	});
});

describe("opportunitiesSince", () => {
	const events = {
		sessionStarts: {
			a: "2026-09-01T00:00:00.000Z",
			b: "2026-09-02T00:00:00.000Z",
			c: "2026-09-03T00:00:00.000Z",
			subagent: "2026-09-04T00:00:00.000Z",
		},
	};
	// `subagent` started but ran no hooks, so it was never an opportunity.
	const hooks = { sessionsWithRecords: ["a", "b", "c"] };

	it("counts only sessions that ran hooks, after the cutoff", () => {
		expect(opportunitiesSince(events, hooks, "2026-09-01T12:00:00.000Z")).toBe(
			2,
		);
	});

	it("does not count a subagent session that ran no hooks", () => {
		// Everything after 2026-09-03 is `subagent` alone.
		expect(opportunitiesSince(events, hooks, "2026-09-03T12:00:00.000Z")).toBe(
			0,
		);
	});

	it("counts nothing when no session ran a hook", () => {
		expect(
			opportunitiesSince(
				events,
				{ sessionsWithRecords: [] },
				"2026-01-01T00:00:00.000Z",
			),
		).toBe(0);
	});

	// The precision trap: hook-health writes second precision, the event log
	// writes milliseconds, and `'Z'` (0x5A) sorts above `'.'` (0x2E) - so a
	// lexical compare reads this cutoff as LATER than the session start and
	// returns 0. It is earlier by 500ms and the session counts.
	it("compares instants, not strings, across the two logs' formats", () => {
		expect(
			opportunitiesSince(
				{ sessionStarts: { a: "2026-09-01T00:00:00.500Z" } },
				{ sessionsWithRecords: ["a"] },
				"2026-09-01T00:00:00Z",
			),
		).toBe(1);
	});
});
