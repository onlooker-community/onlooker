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
	// ever lets through, so it is trusted; ecosystem's fourteen split five
	// ways once each was actually read, not inferred from its
	// tracker-sounding name (see its own table comment for the full account);
	// warden's three hooks all fire far more often than they ever emit,
	// leaving nothing to trust at all.
	//
	// compass moved from the trusted column to the empty one in the
	// verification pass. Its `["compass-bash-gate"]` was justified as "a
	// write-pattern match reliably emits", which is true and is not the claim
	// - the hook fires on EVERY Bash call, registers with hook-health before
	// deciding the command is read-only (compass-bash-gate.sh:29 against
	// :98), and the EXIT trap logs that firing exactly as it logs a real one.
	// The bead records the consequence as a live false positive.
	//
	// Nothing in `computeVerdict` reads this field for an `output: null`
	// entry anymore - `writeEvents` is that branch's axis - so it is pinned
	// as recorded research rather than as behavior.
	it("pins which output:null entries have a hook that reliably implies an emission", () => {
		expect(entryFor("inspector").writeHooks).toEqual(["inspector-post-write"]);
		expect(entryFor("compass").writeHooks).toBeUndefined();
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

	// The verification pass's result, pinned so a later edit has to argue with
	// it. Five entries name write events and twelve do not, and the twelve are
	// the load-bearing half: an entry with no `writeEvents` and no
	// `writeHooks` has no downstream axis at all and rests on liveness, which
	// cannot produce a false `stopped`. Each entry's own comment carries the
	// file and line; this only fixes the shape of the answer.
	it("pins which entries have an event whose silence is evidence", () => {
		const named = Object.fromEntries(
			STREAMS.filter((e) => (e.writeEvents ?? []).length > 0).map((e) => [
				e.plugin,
				e.writeEvents,
			]),
		);
		expect(named).toEqual({
			assayer: ["assayer.audit.complete"],
			bursar: ["bursar.session.recorded"],
			lineage: ["lineage.change.recorded"],
			inspector: [
				"inspector.check.passed",
				"inspector.check.failed",
				"inspector.check.skipped",
				"inspector.run.completed",
			],
			ecosystem: [
				"tool.shell.exec",
				"tool.file.read",
				"tool.file.write",
				"tool.file.edit",
				"tool.web.fetch",
				"tool.agent.spawn",
				"tool.agent.complete",
				"skill.invoked",
				"memory.recalled",
				"task.start",
				"task.complete",
			],
		});
	});

	// The circularity that changed this design, stated as an invariant rather
	// than left to the fixture below to catch. An opportunity is established
	// by a `session.start` event, so a `writeEvents` set containing one is
	// always at least as new as the newest opportunity and
	// `opportunitiesSince` returns 0 against it by construction - the entry
	// can never reach `stopped` on its own write axis. ecosystem is the entry
	// this bites, because `session` is one of its tracked prefixes.
	it("names no write event that would pin its own opportunity count", () => {
		for (const entry of STREAMS) {
			expect(
				entry.writeEvents ?? [],
				`${entry.plugin}: a session.* write event pins opportunitiesSince at 0`,
			).not.toContain("session.start");
		}
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

/** The day `machine()`'s generated opportunities end on unless a test moves them. */
const LAST_OPPORTUNITY = "2026-09-05";

/**
 * `count` opportunities: sessions of this repo's, each carrying a hook
 * record, on consecutive days ending on `endingOn`.
 *
 * A helper called from INSIDE `machine()` rather than rows a test assembles
 * for itself, because an opportunity is a session of THIS repo's - which
 * means `working_directory` has to be the real temp `cwd`, and `machine()` is
 * what creates that. There is no path a caller could fill in beforehand.
 *
 * Dates run backward from `endingOn` so they land at or before the tests' own
 * `NOW`: a fixture session in the future would still be counted by
 * `opportunitiesSince` for a cutoff that has not happened yet.
 */
function opportunityRows(
	cwd: string,
	count: number,
	endingOn: string,
): { events: unknown[]; hooks: unknown[] } {
	const events: unknown[] = [];
	const hooks: unknown[] = [];
	for (let i = 0; i < count; i++) {
		const day = new Date(`${endingOn}T00:00:00.000Z`);
		day.setUTCDate(day.getUTCDate() - (count - 1 - i));
		const date = day.toISOString().slice(0, 10);
		const id = `opp-${i}`;
		events.push({
			event_type: "session.start",
			timestamp: `${date}T00:00:00.000Z`,
			session_id: id,
			payload: { working_directory: cwd },
		});
		// Any hook record at all is what makes a session an opportunity - the
		// denominator is deliberately not keyed on a nominated reference hook,
		// so this one's name is arbitrary and belongs to no entry under test
		// except ecosystem's.
		hooks.push({
			hook: "session-start-tracker",
			timestamp: `${date}T00:00:01Z`,
			status: "success",
			session_id: id,
		});
	}
	return { events, hooks };
}

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
	/**
	 * How many opportunities this repo has had - see `opportunityRows`. Every
	 * verdict is now measured against this denominator, so a fixture with
	 * none of them can only ever read `unknown`.
	 */
	opportunities?: number;
	/**
	 * The day the generated opportunities end on, defaulting to
	 * `LAST_OPPORTUNITY`. Set it when a fixture's own evidence predates that
	 * default and the test needs the opportunities placed around the evidence
	 * rather than a week after it.
	 */
	opportunitiesEndingOn?: string;
	/**
	 * Sessions of this repo's that ran no hook at all - the subagent shape
	 * that made a raw `session.start` count unusable as a denominator. These
	 * generate `session.start` rows and nothing else, so they must never
	 * count as opportunities.
	 */
	subagentSessions?: number;
}): { cwd: string; home: string; configDir: string; env: NodeJS.ProcessEnv } {
	const dir = mkdtempSync(join(tmpdir(), "onlooker-survey-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, "logs"), { recursive: true });

	const home = mkdtempSync(join(tmpdir(), "onlooker-survey-home-"));
	onTestFinished(() => rmSync(home, { recursive: true, force: true }));
	const cwd = mkdtempSync(join(tmpdir(), "onlooker-survey-proj-"));
	onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));

	const events = [...(opts.events ?? [])];
	const hooks = [...(opts.hooks ?? [])];
	// A `.git` marker is what makes `repoRoot(cwd)` resolve, and without a
	// root `scanEvents` populates neither `sessionIds` nor `sessionStarts` -
	// so every option below that depends on "sessions of THIS repo's" needs
	// it, not just `projectKeys`.
	if (
		opts.projectKeys !== undefined ||
		opts.opportunities !== undefined ||
		opts.subagentSessions !== undefined
	) {
		mkdirSync(join(cwd, ".git"), { recursive: true });
	}
	if (opts.opportunities !== undefined) {
		const rows = opportunityRows(
			cwd,
			opts.opportunities,
			opts.opportunitiesEndingOn ?? LAST_OPPORTUNITY,
		);
		events.push(...rows.events);
		hooks.push(...rows.hooks);
	}
	for (let i = 0; i < (opts.subagentSessions ?? 0); i++) {
		events.push({
			event_type: "session.start",
			timestamp: `2026-09-03T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
			session_id: `subagent-${i}`,
			payload: { working_directory: cwd },
		});
	}
	if (opts.projectKeys !== undefined) {
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
	write("hook-health.jsonl", hooks);
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

/**
 * The clock the conditionality cases run against, sitting just after the last
 * day `opportunityRows` generates.
 */
const NOW = new Date("2026-09-05T12:00:00Z");

describe("stream conditionality", () => {
	// The pair that fixes the boundary between "old" and "never". Both entries
	// are alive, both have no write signal, and the ONLY difference is whether
	// their output has ever existed - so run together they pin that absence is
	// what changes the verdict, not age and not the missing signal.
	//
	// The case that forced this: the finished table put all seven enabled
	// plugins at `recording` and `doctor` at exit 0 on the real machine,
	// librarian included, whose `lessons/` has never existed there. That is
	// the successful-looking silence this command exists to remove.
	it("does not certify a stream whose output has never been written", async () => {
		// librarian's headline case. Its hook fires every session, it emits
		// nothing at its lesson-write site so it has no `writeEvents` to name,
		// and `lessons/` has never appeared. `recording` would be a clean bill
		// on a machine whose output is known to be missing.
		const { cwd, home, configDir, env } = machine({
			plugins: ["librarian"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			events: [
				{
					event_type: "librarian.scan.complete",
					timestamp: "2026-09-05T09:00:00.000Z",
					session_id: "opp-5",
					payload: {},
				},
			],
		});
		const v = verdictFor(
			await surveyStreams({ cwd, home, configDir, env, now: NOW }),
			"librarian",
		);
		expect(v?.kind).toBe("unknown");
		expect(v?.kind === "unknown" && v.detail).toContain("never been written");
	});

	it("still certifies a stream whose output exists but is merely old", async () => {
		// The other side, and the reason the test above is keyed on absence
		// rather than on age. Identical shape - alive, no write signal - except
		// that one lesson file exists and is four weeks stale. Age is not
		// evidence: with nothing in the table saying librarian owed a lesson
		// this month, its quiet is ordinary. Keyed on age instead, this reads
		// `stopped` and is the exact false alarm the design removed.
		const { cwd, home, configDir, env } = machine({
			plugins: ["librarian"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			files: [
				[
					join("librarian", "aaaaaaaaaaaa", "lessons", "l.json"),
					"2026-08-07T00:00:00Z",
				],
			],
			events: [
				{
					event_type: "librarian.scan.complete",
					timestamp: "2026-09-05T09:00:00.000Z",
					session_id: "opp-5",
					payload: {},
				},
			],
		});
		const v = verdictFor(
			await surveyStreams({ cwd, home, configDir, env, now: NOW }),
			"librarian",
		);
		expect(v?.kind).toBe("recording");
	});

	it("does not call a conditional writer stopped just because its output is older than its events", async () => {
		// scribe, healthy: sessions every day, nothing worth distilling for a
		// week. No writeHooks and no writeEvents, so `lastWrite` is undefined
		// and the output's age is not evidence about anything.
		const { cwd, home, configDir, env } = machine({
			plugins: ["scribe"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			files: [
				[
					join("scribe", "aaaaaaaaaaaa", "2026-08-29-s.md"),
					"2026-08-29T00:00:00Z",
				],
			],
			events: [
				{
					event_type: "scribe.captured",
					timestamp: "2026-09-05T09:00:00.000Z",
					session_id: "opp-5",
					payload: {},
				},
			],
		});
		const v = verdictFor(
			await surveyStreams({ cwd, home, configDir, env, now: NOW }),
			"scribe",
		);
		expect(v?.kind).toBe("recording");
	});

	it("does not call a clean repo's curator stopped over months-old findings", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["curator"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			files: [
				[
					join("curator", "aaaaaaaaaaaa", "findings", "f.json"),
					"2026-06-01T00:00:00Z",
				],
			],
			events: [
				{
					event_type: "curator.scan.complete",
					timestamp: "2026-09-05T09:00:00.000Z",
					session_id: "opp-5",
					payload: {},
				},
			],
		});
		const v = verdictFor(
			await surveyStreams({ cwd, home, configDir, env, now: NOW }),
			"curator",
		);
		expect(v?.kind).toBe("recording");
	});

	it("does not call compass stopped after an hour of read-only Bash", async () => {
		// compass-bash-gate fires on every Bash; compass.* is emitted only on a
		// write-pattern match. The gap between them is not evidence.
		const { cwd, home, configDir, env } = machine({
			plugins: ["compass"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			events: [
				{
					event_type: "compass.gate.checked",
					timestamp: "2026-09-05T09:00:00.000Z",
					session_id: "opp-5",
					payload: {},
				},
			],
			hooks: [
				{
					hook: "compass-bash-gate",
					timestamp: "2026-09-05T11:55:00Z",
					status: "success",
					session_id: "opp-5",
				},
			],
		});
		const v = verdictFor(
			await surveyStreams({ cwd, home, configDir, env, now: NOW }),
			"compass",
		);
		expect(v?.kind).not.toBe("stopped");
	});

	it("calls lineage stopped when its hook keeps firing but its write event has stopped", async () => {
		// The false negative this design must not lose. lineage-post-tool-use
		// fires constantly; `lineage.change.recorded` is emitted at the ledger
		// write site, so its silence IS the writes stopping.
		const { cwd, home, configDir, env } = machine({
			plugins: ["lineage"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			files: [
				[
					join("lineage", "aaaaaaaaaaaa", "changes.jsonl"),
					"2026-01-15T00:00:00Z",
				],
			],
			events: [
				{
					event_type: "lineage.change.recorded",
					timestamp: "2026-01-15T00:00:00.000Z",
					session_id: "opp-0",
					payload: {},
				},
			],
			hooks: [
				{
					hook: "lineage-post-tool-use",
					timestamp: "2026-09-05T11:00:00Z",
					status: "success",
					session_id: "opp-5",
				},
			],
		});
		const v = verdictFor(
			await surveyStreams({ cwd, home, configDir, env, now: NOW }),
			"lineage",
		);
		expect(v?.kind).toBe("stopped");
	});

	it("reports unknown, not stopped, when too few opportunities have elapsed to judge", async () => {
		// The idle-machine case, and the one the wall clock got backwards: a
		// stream silent for months on a repo nobody has opened has not had the
		// chances that would make its silence mean anything.
		//
		// The liveness event and the write event are deliberately DIFFERENT
		// types. The design's own acceptance criterion is that this case must
		// fail against the old constant, and a fixture whose only event is the
		// frozen `lineage.change.recorded` does not: the old rule read the gap
		// between events and output as zero and reached `unknown` through the
		// wall clock instead - the same answer for the opposite reason, and a
		// test that passes before and after is not exercising anything. With a
		// recent `lineage.tool.observed` the old rule sees events outrunning a
		// January output and reads `stopped`, which is exactly the false alarm
		// the opportunity denominator exists to withhold.
		const { cwd, home, configDir, env } = machine({
			plugins: ["lineage"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 2,
			files: [
				[
					join("lineage", "aaaaaaaaaaaa", "changes.jsonl"),
					"2026-01-15T00:00:00Z",
				],
			],
			events: [
				{
					event_type: "lineage.change.recorded",
					timestamp: "2026-01-15T00:00:00.000Z",
					session_id: "opp-0",
					payload: {},
				},
				// Alive, on the newest of the two opportunities - but not a
				// write event, so it says nothing about the frozen ledger.
				{
					event_type: "lineage.tool.observed",
					timestamp: "2026-09-05T09:00:00.000Z",
					session_id: "opp-1",
					payload: {},
				},
			],
		});
		const v = verdictFor(
			await surveyStreams({ cwd, home, configDir, env, now: NOW }),
			"lineage",
		);
		expect(v?.kind).toBe("unknown");
	});

	it("does not count subagent sessions as opportunities", async () => {
		// 91 sessions of ours, none of which ran a hook - the measured shape
		// that made a raw session count unusable. Against a `session.start`
		// denominator this reads `stopped`; it must read `unknown`.
		//
		// `session_id` is one of the 91, not a foreign one: an out-of-scope id
		// leaves `lastByPrefix` empty, and the verdict then falls out of "no
		// events to compare" without the denominator ever being consulted -
		// the test would keep passing with the subagent filter removed
		// entirely, which is the one thing it exists to pin.
		const { cwd, home, configDir, env } = machine({
			plugins: ["lineage"],
			projectKeys: ["aaaaaaaaaaaa"],
			subagentSessions: 91,
			files: [
				[
					join("lineage", "aaaaaaaaaaaa", "changes.jsonl"),
					"2026-01-15T00:00:00Z",
				],
			],
			events: [
				{
					event_type: "lineage.change.recorded",
					timestamp: "2026-01-15T00:00:00.000Z",
					session_id: "subagent-0",
					payload: {},
				},
			],
		});
		const v = verdictFor(
			await surveyStreams({ cwd, home, configDir, env, now: NOW }),
			"lineage",
		);
		expect(v?.kind).toBe("unknown");
	});

	it("keeps an output:null stream's events as proof of life when they are not its write axis", async () => {
		// The axis split exists so an entry's events cannot be compared against
		// themselves - but it applies only where the events ARE the downstream
		// being judged, which is `output: null` AND a non-empty `writeEvents`.
		// warden is `output: null` and names none: its three types are the
		// rare ones its own entry documents, so they are not its downstream
		// and must go on counting as liveness. Keyed on `output: null` alone,
		// the split strips warden's only axis and reads a plugin that emitted
		// today as never having run at all.
		//
		// compass now has the same shape - `output: null`, no write axis - so
		// warden is no longer the only entry this protects, but it stays the
		// vehicle here because it is the one with events to lose.
		const { cwd, home, configDir, env } = machine({
			plugins: ["warden"],
			opportunities: 6,
			events: [
				{
					event_type: "warden.threat.detected",
					timestamp: "2026-09-05T09:00:00.000Z",
					session_id: "opp-5",
					payload: {},
				},
			],
		});
		const v = verdictFor(
			await surveyStreams({ cwd, home, configDir, env, now: NOW }),
			"warden",
		);
		expect(v?.kind).toBe("recording");
	});

	it("does not let an output:null stream's own events certify that same event stream", async () => {
		// The other half of the axis split, and the half that actually bites.
		// inspector's events ARE its downstream here, so they cannot also be
		// its proof of life - that would compare a signal against itself and
		// answer "the events are recent, therefore the events are recent."
		// With its hook absent from hook-health there is no independent
		// liveness axis left, and `unknown` is the honest reading.
		//
		// This is the case that distinguishes the split from its absence.
		// Where the hook is NEWER than the events - the ecosystem outage shape
		// - including events in liveness changes nothing, because the newest
		// wins either way; both the fixtures above pass with the split removed
		// entirely. Only a fresh event over a stale-or-missing hook separates
		// them: without the split this reads `recording`, off nothing but the
		// event stream vouching for itself.
		const { cwd, home, configDir, env } = machine({
			plugins: ["inspector"],
			opportunities: 6,
			events: [
				{
					event_type: "inspector.check.passed",
					timestamp: "2026-09-05T09:00:00.000Z",
					session_id: "opp-5",
					payload: {},
				},
			],
		});
		const v = verdictFor(
			await surveyStreams({ cwd, home, configDir, env, now: NOW }),
			"inspector",
		);
		expect(v?.kind).toBe("unknown");
	});

	it("reports unknown, not stopped, for a plugin newly enabled on a repo with a long history", async () => {
		// Forty opportunities, none of them compass's. The window is wide, but
		// compass has no last-seen instant for that width to be measured
		// against: a plugin enabled an hour ago and one that died before this
		// log began present identically, both with every opportunity behind
		// them and nothing of their own in front.
		//
		// A `stopped` keyed on the window alone therefore fires on every fresh
		// enable on any active machine - this repo has 11,422 sessions behind
		// it - which is the same class of false positive the whole rule exists
		// to remove, and the design rules it out by name.
		const { cwd, home, configDir, env } = machine({
			plugins: ["compass"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 40,
		});
		const v = verdictFor(
			await surveyStreams({ cwd, home, configDir, env, now: NOW }),
			"compass",
		);
		expect(v?.kind).toBe("unknown");
	});
});

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
			// Placed to end on the write hook's own last firing, so bursar is
			// unambiguously ALIVE and the only thing that can stall it is its
			// output: all six opportunities postdate our key's frozen mtime,
			// none of them postdate the hook. If the sibling's key leaked into
			// the walk, `lastWrite` would jump to 2026-09-02 and this would
			// read `recording` instead.
			opportunities: 6,
			opportunitiesEndingOn: "2026-06-29",
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
	//
	// The detail assertion moved from the hook's name to the output's label.
	// The old rule reached `stopped` by counting one nominated hook's firings,
	// so naming that hook was the evidence; the new one counts opportunities
	// elapsed since the output last moved, and the hook that happened to fire
	// during them is not part of the finding. What the verdict must still name
	// is WHICH path stopped moving, which is what `outputLabel` renders.
	it("reports a stream as stopped when its hook fires and its output does not move", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["bursar"],
			projectKeys: ["aaaaaaaaaaaa"],
			// Six opportunities, all after the frozen output and none after the
			// last hook firing: alive, and not writing.
			opportunities: 6,
			opportunitiesEndingOn: "2026-08-29",
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
			join("bursar", "projects"),
		);
		expect(verdict?.kind === "stopped" && verdict.detail).toContain(
			"2026-08-07",
		);
	});

	// NOT events alone: for an `output: null` entry that names `writeEvents`
	// the axes SPLIT - those events are the downstream being judged, and its
	// hooks are the only proof of life left. A hook firing close behind the
	// event is what makes this "recording"; without it there would be no
	// liveness axis at all.
	//
	// `session_id` is now load-bearing on both rows. Any option that makes
	// this repo's sessions countable also creates the `.git` marker, and once
	// `repoRoot` resolves, both scans scope to sessions rooted here - an
	// unattributed hook record and a foreign session's event are both dropped
	// before the verdict sees them.
	it("reports a stream with no output path as recording when its events and hooks are both recent", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["inspector"],
			opportunities: 6,
			opportunitiesEndingOn: "2026-09-02",
			events: [
				{
					event_type: "inspector.check.passed",
					timestamp: "2026-09-02T00:00:00Z",
					session_id: "opp-5",
					payload: {},
				},
			],
			hooks: [
				{
					hook: "inspector-post-write",
					timestamp: "2026-09-02T00:00:05Z",
					status: "success",
					session_id: "opp-5",
				},
			],
		});
		// No verdict reads the clock anymore, but every caller still threads
		// one - see `surveyStreams`'s `now`.
		const now = new Date("2026-09-03T00:00:00Z");
		expect(
			verdictFor(
				await surveyStreams({ cwd, home, configDir, env, now }),
				"inspector",
			)?.kind,
		).toBe("recording");
	});

	// The failure this whole feature exists to prevent: a stream whose hooks
	// keep firing while its events stop landing. With no output path to
	// compare against, the events ARE the downstream and the hooks are the
	// only proof of life, so hooks running past a frozen event stream means
	// the emissions have stopped even though the trigger has not.
	//
	// Moved from ecosystem to inspector when ecosystem could not reach this
	// verdict at all: `session` is one of its tracked prefixes and
	// `session.start` is the single event type that establishes an
	// opportunity (`scanEvents`, and see `opportunitiesSince`), so with the
	// axis built from every prefix in `events`, ecosystem's event axis could
	// never be older than the newest opportunity and the count since it was
	// pinned at zero by construction. That was the reference-hook circularity
	// the design bounds for hook records, reappearing one level down on the
	// event side where it was not anticipated.
	//
	// It is fixed - the axis is `writeEvents` now, and ecosystem's set leaves
	// `session.start` out - and the case it blocked is the test two below
	// this one. inspector stays the vehicle here anyway: it has the identical
	// entry shape and its four types are its whole prefix, so the rule is
	// pinned on the simpler of the two.
	it("reports an output:null stream stopped when its hooks keep firing but its events have stopped landing", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["inspector"],
			opportunities: 6,
			events: [
				{
					event_type: "inspector.check.passed",
					timestamp: "2026-08-07T00:00:00Z",
					session_id: "opp-0",
					payload: {},
				},
			],
			hooks: [
				{
					hook: "inspector-post-write",
					timestamp: "2026-09-05T06:00:00Z",
					status: "success",
					session_id: "opp-5",
				},
			],
		});
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		const verdict = verdictFor(survey, "inspector");
		expect(verdict?.kind).toBe("stopped");
		// The detail has to name the axis that actually stalled. For an
		// `output: null` entry that is the event stream, and `outputLabel`
		// renders "(none)" for one - so a detail built from it reports
		// "(none) last changed 2026-08-07", naming a path that does not exist.
		// The branch this replaced said "the last event was 2026-08-07", and
		// the replacement must not be less specific than what it removed.
		expect(verdict?.kind === "stopped" && verdict.detail).not.toContain(
			"(none)",
		);
		expect(verdict?.kind === "stopped" && verdict.detail).toContain(
			"inspector event",
		);
	});

	// ecosystem stays the vehicle here, but the fixture had to gain a tracker
	// event to stay honest. It used to carry nothing but what `opportunities`
	// generates, and passed on the strength of those `session.start` rows
	// alone - which is the circularity itself, the denominator's own signal
	// certifying the stream that emits it. With the axis narrowed to
	// `writeEvents`, ecosystem now correctly reads `unknown` off that fixture:
	// its trackers produced nothing, so nothing says they are working.
	//
	// One `tool.file.edit`, the type tool-history-tracker appends on every
	// Edit, is what "its events move together with its hooks" actually means
	// for this entry.
	it("reports an output:null stream recording when its hooks and events move together", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["ecosystem"],
			opportunities: 6,
			opportunitiesEndingOn: "2026-09-02",
			events: [
				{
					event_type: "tool.file.edit",
					timestamp: "2026-09-02T12:00:00.000Z",
					session_id: "opp-5",
					payload: {},
				},
			],
		});
		// No verdict reads the clock anymore - see `surveyStreams`'s `now`.
		const now = new Date("2026-09-03T00:00:00Z");
		const survey = await surveyStreams({ cwd, home, configDir, env, now });
		expect(verdictFor(survey, "ecosystem")?.kind).toBe("recording");
	});

	// The incident this whole feature was built for, reachable for the first
	// time. ecosystem's trackers died on 2026-08-07 while its hooks went on
	// firing - so liveness says it is fine, and only the write axis can catch
	// it. Under the previous rule it could not: the axis was every prefix in
	// `events`, `session` is one of them, and the opportunities' own
	// `session.start` rows kept `lastWrite` pinned to the newest opportunity
	// forever.
	//
	// Run this fixture against the prefix-wide axis and it reads `recording`,
	// which is the point of it - a test that passes before the change is not
	// exercising the change.
	//
	// The last tracker output lands in the FIRST of the six opportunities and
	// nothing follows it, so five opportunities have gone by with the hooks
	// firing into them and no tracker emitting. It has to sit in one of
	// those sessions rather than in an older invented one: `scanEvents`
	// attributes an event to this repo only through a `session.start` whose
	// `working_directory` is the temp `cwd`, which `machine()` alone can fill
	// in, so an event in an unknown session is dropped rather than counted
	// old.
	it("reports ecosystem stopped when its trackers stop while its hooks keep firing", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["ecosystem"],
			opportunities: 6,
			events: [
				{
					event_type: "tool.file.edit",
					timestamp: "2026-08-31T00:00:02.000Z",
					session_id: "opp-0",
					payload: {},
				},
			],
		});
		const verdict = verdictFor(
			await surveyStreams({ cwd, home, configDir, env, now: NOW }),
			"ecosystem",
		);
		expect(verdict?.kind).toBe("stopped");
		expect(verdict?.kind === "stopped" && verdict.detail).toContain(
			"ecosystem event",
		);
	});

	// Events exist, but hook-health holds nothing at all - so there are no
	// opportunities, the denominator every count is read against cannot be
	// established, and no verdict is reachable. This is also the shape a
	// wholly unreadable hook log takes, which is why the window guard rather
	// than a `hooks.missing` check is what covers it: both arrive here as an
	// empty `sessionsWithRecords`, and both mean the same thing.
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

	// warden's real shape: warden-pre-tool-use fires on every
	// Write/Edit/MultiEdit/Bash but only emits warden.gate.blocked once the
	// gate is already closed; warden-post-tool-use fires on every
	// WebFetch/Read but only emits warden.threat.detected on a positive scan
	// hit. The old rule trusted these hooks' raw `.last` timestamps as an
	// emission axis, so ordinary tool activity outrunning a rare detection
	// read `stopped` - permanently, on any machine not blocked recently.
	//
	// `recording` now, where it was `unknown`. warden declares no write
	// signal of either kind, so the write question is not asked of it and
	// there is nothing left to be uncertain about: its hooks are firing, and
	// that is the entire claim the verdict makes. The design is explicit that
	// an alive stream with no askable write question is `recording` - whether
	// it writes "is its own business."
	//
	// This does change what `doctor` exits with for warden, from 1 to 0, and
	// the same loosening applies to every entry that declares no write signal
	// yet. Narrowing it back is what populating `writeEvents` across the
	// table is for; until then these entries are judged on liveness alone.
	it("reads warden as recording, not permanently stopped, when its hooks fire constantly but rarely emit", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["warden"],
			opportunities: 6,
			events: [
				{
					event_type: "warden.threat.detected",
					timestamp: "2026-08-01T21:13:33Z",
					session_id: "opp-0",
					payload: {},
				},
			],
			hooks: Array.from({ length: 200 }, (_, i) => ({
				hook: "warden-pre-tool-use",
				timestamp: `2026-09-${String(4 + (i % 2)).padStart(2, "0")}T00:00:00Z`,
				status: "success",
				session_id: `opp-${4 + (i % 2)}`,
			})),
		});
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		expect(verdictFor(survey, "warden")?.kind).toBe("recording");
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

	// Real output on disk is not, by itself, a sign the stream is running -
	// the file is there, and nothing has emitted or fired in six chances.
	//
	// `unknown`, as before this change, but no longer for the reason the old
	// rule gave (output present, no hook record to compare it against). The
	// output's mtime is not consulted at all now, since librarian declares no
	// write signal; what settles it is that librarian has never been seen
	// alive here, so the six opportunities have no last-seen instant to be
	// counted from. NOT `librarian/k/x.json`: a plain file outside `lessons/`
	// resolves `outputFreshness` to `{ mtime: null }`, so the fixture would
	// no longer be about a stream that HAS output.
	it("reports unknown when a stream has output on disk but was never seen running", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["librarian"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			files: [
				[
					join("librarian", "aaaaaaaaaaaa", "lessons", "note.json"),
					"2026-07-01T00:00:00Z",
				],
			],
		});
		expect(
			verdictFor(
				await surveyStreams({ cwd, home, configDir, env, now: NOW }),
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
			// Six opportunities, of which four postdate the output's mtime -
			// one short of the threshold, so the write axis is deliberately
			// just inside the line while twenty session-start firings sit on
			// top of it. If a firing count ever came back, this is where it
			// would show.
			opportunities: 6,
			opportunitiesEndingOn: "2026-08-11",
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
		// No verdict reads the clock anymore - see `surveyStreams`'s `now`.
		const now = new Date("2026-08-11T00:00:00Z");
		const survey = await surveyStreams({ cwd, home, configDir, env, now });
		expect(verdictFor(survey, "bursar")?.kind).toBe("recording");
	});

	// lineage's real shape, and the regression that started this fix round:
	// lineage-post-tool-use serves Edit, Write, MultiEdit, AND Bash under one
	// hook name, and Bash outruns Edit roughly 30:1 (lineage's own
	// hooks.json). A firing-count check built from it reads a perfectly
	// healthy lineage as stalled after about five Bash calls with no edit.
	// lineage has no writeHooks, so its hook is a liveness signal only - and
	// the verdict must not be swayed by however many times it fired.
	it("reads a stream with no writeHooks as recording when its write event tracks its output, regardless of hook firings", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["lineage"],
			projectKeys: ["aaaaaaaaaaaa"],
			// Every opportunity predates the write, so nothing has been asked
			// of lineage since it last recorded a change.
			opportunities: 6,
			opportunitiesEndingOn: "2026-09-02",
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
		// No verdict reads the clock anymore - see `surveyStreams`'s `now`.
		const now = new Date("2026-09-03T00:00:00Z");
		const survey = await surveyStreams({ cwd, home, configDir, env, now });
		expect(verdictFor(survey, "lineage")?.kind).toBe("recording");
	});

	// Same entry, still alive, but nothing has been written across a full
	// window of opportunities. If lineage genuinely broke, this is what that
	// looks like.
	//
	// The fixture's two events used to be one. Under the old rule any
	// `lineage.*` event outrunning the output's mtime by more than an hour
	// read `stopped`, so a single recent `lineage.change.recorded` was the
	// whole test - but that type is now a WRITE signal, and its arrival is
	// proof the write happened rather than evidence against it. The stall
	// this test names still exists; expressing it just needs the two axes
	// separated, a liveness event that keeps arriving and a write event that
	// does not.
	it("reads a stream with no writeHooks as stopped when it stays alive while its write signal goes quiet", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["lineage"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			opportunitiesEndingOn: "2026-09-02",
			files: [
				[
					join("lineage", "aaaaaaaaaaaa", "changes.jsonl"),
					"2026-08-01T00:00:00Z",
				],
			],
			events: [
				{
					event_type: "lineage.change.recorded",
					timestamp: "2026-08-01T00:00:00.000Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
				{
					event_type: "lineage.tool.observed",
					timestamp: "2026-09-02T06:00:00.000Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
		});
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		expect(verdictFor(survey, "lineage")?.kind).toBe("stopped");
	});

	// assayer's real shape, and fix round 2's own reproduction: assayer-
	// stop.sh bails without writing an audit at seven ordinary sites (no
	// repo root, no project key, no claude/jq on PATH, no transcript, empty
	// final message, empty claude -p response), measured on a live machine
	// at roughly 10 firings per audit. Before this fix, assayer's writeHooks
	// trusted every one of those 200 firings as evidence of a write, and
	// STALL_THRESHOLD = 5 crossed within hours of any quiet stretch even
	// while assayer was healthy.
	//
	// assayer now has neither a write hook nor a write event, so the write
	// question is not asked of it at all: its verdict rests on liveness
	// alone, and 200 firings are 200 pieces of evidence that it is alive.
	// The audit file's own age is not consulted, which is the point - it was
	// the other half of the comparison that used to produce the false alarm.
	it("reads assayer as recording from liveness alone, not from a heavy stop-hook firing count", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["assayer"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			opportunitiesEndingOn: "2026-09-02",
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
		// No verdict reads the clock anymore - see `surveyStreams`'s `now`.
		const now = new Date("2026-09-03T00:00:00Z");
		const survey = await surveyStreams({ cwd, home, configDir, env, now });
		expect(verdictFor(survey, "assayer")?.kind).toBe("recording");
	});

	// cartographer's real shape: an audit runs at most once per 24h
	// (`writeGateHours`), so a completed audit followed by an ordinary 26h
	// gap before the next one is a healthy stream, not a stall.
	//
	// The mechanism that protects it has changed underneath the test. It used
	// to be `toleranceFor`'s cadence term widening the permitted gap between
	// events and output mtime from one hour to 48. There is no such gap
	// measurement anymore: cartographer declares no write signal of either
	// kind, so the write question is not asked of it at all and the age of
	// `runs/audit-1.json` is never consulted. The protection now comes from
	// the entry's own silence about writes rather than from a tolerance
	// tuned per plugin - which is why `writeGateHours` may turn out to have
	// no consumer left. The behavior this test pins is unchanged.
	it("does not report a gated writer with no write signal stopped over an ordinary gap between its runs", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["cartographer"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			opportunitiesEndingOn: "2026-08-02",
			files: [
				[
					join("cartographer", "aaaaaaaaaaaa", "runs", "audit-1.json"),
					"2026-08-01T00:00:00Z",
				],
			],
			events: [
				{
					event_type: "cartographer.audit.complete",
					// 26h after the output's mtime, and the newest opportunity
					// is older still - so cartographer is alive and nothing has
					// been asked of it since.
					timestamp: "2026-08-02T02:00:00Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
		});
		// No verdict reads the clock anymore - see `surveyStreams`'s `now`.
		const now = new Date("2026-08-03T00:00:00Z");
		const survey = await surveyStreams({ cwd, home, configDir, env, now });
		expect(verdictFor(survey, "cartographer")?.kind).toBe("recording");
	});

	// The counterpart, and the one whose mechanism the design deliberately
	// replaced. A gated writer with no write signal can no longer be called
	// stopped by a timestamp gap of any size - 51h past a 48h floor produced
	// `stopped` under the old rule, and produces nothing now, because the
	// comparison it rested on was between an event and an output mtime that
	// were never evidence about each other for an entry like this.
	//
	// What can still stop cartographer is going quiet: no event and no hook
	// firing across a full window of opportunities. That is the same alarm,
	// raised off the axis that actually supports it, and it is what this
	// test now pins - the point being that `stopped` remains REACHABLE for a
	// gated writer, so removing the false alarm did not cost the real one.
	it("reports a gated writer stopped once it has gone silent across a window of opportunities", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["cartographer"],
			projectKeys: ["aaaaaaaaaaaa"],
			// All six postdate cartographer's last sign of life.
			opportunities: 6,
			files: [
				[
					join("cartographer", "aaaaaaaaaaaa", "runs", "audit-1.json"),
					"2026-08-01T00:00:00Z",
				],
			],
			events: [
				{
					event_type: "cartographer.audit.complete",
					timestamp: "2026-08-03T03:00:00Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
		});
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		expect(verdictFor(survey, "cartographer")?.kind).toBe("stopped");
	});

	// A gated writer (writeGateHours set) that has never produced output must
	// not be flagged: asserting `stopped` would condemn every brand-new
	// counsel install before its first brief is even due. That is what this
	// test exists to prevent and it has never changed.
	//
	// The verdict has moved twice. It was `unknown` because the old rule could
	// not tell "hasn't reached its first gate" from "broken"; it became
	// `recording` when a missing output stopped being evidence about anything;
	// and it is `unknown` again now for a third and narrower reason - counsel
	// names an `output` path that has never been written, and absence is not
	// something this table will certify even where it has no write signal.
	// Age would still read `recording`; see the librarian pair at the top of
	// `stream conditionality` for the two halves side by side.
	it("reports a gated writer with no output unknown rather than stopped", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["counsel"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			opportunitiesEndingOn: "2026-09-02",
			events: [
				{
					event_type: "counsel.something",
					timestamp: "2026-09-02T00:00:00Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
		});
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		expect(verdictFor(survey, "counsel")?.kind).toBe("unknown");
	});

	// Generalizes the counsel case above beyond gated writers: curator has
	// no writeGateHours at all, but its scan is conditional (a session with
	// no memory store found writes only the manifest heartbeat, never
	// findings/), and it declares no write signal for exactly that reason. A
	// perfectly healthy curator that simply never had a finding must not
	// read as `stopped` any more than a gated one does.
	//
	// `unknown` rather than `recording` for the same reason counsel is:
	// `findings/` has never appeared here. Both halves of the claim hold at
	// once - nothing accuses curator of stalling, and nothing certifies it
	// either, which is what `unknown` means.
	it("reports an ungated conditional writer with no output unknown rather than stopped", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["curator"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			opportunitiesEndingOn: "2026-09-02",
			events: [
				{
					event_type: "curator.scan.complete",
					timestamp: "2026-09-02T00:00:00Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
		});
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		expect(verdictFor(survey, "curator")?.kind).toBe("unknown");
	});

	// historian HAS a writeHook (historian-session-end IS the writer), and
	// this used to assert `stopped` for a write hook that had fired past
	// STALL_THRESHOLD with no session ever indexed.
	//
	// It is `unknown` now, and that is a deliberate, load-bearing softening
	// rather than an accident of the rewrite - the single largest loss of
	// detection in this change, recorded here rather than buried. The new
	// rule measures a write stall as opportunities elapsed SINCE THE LAST
	// WRITE, and an entry that has never written has no such instant to
	// count from. A write hook's own firing count is explicitly not a
	// substitute: counting firings is the mechanism that produced every
	// false positive this change removes, and reinstating it for this one
	// case would reinstate them with it.
	//
	// So "has a write signal, has been alive, and has produced nothing ever"
	// reads `unknown` - honest about being unmeasurable rather than
	// asserting a stall the denominator cannot support. `unknown` still
	// exits 1 (see `exitCodeFor`), so the machine-facing behavior for this
	// case is unchanged; what is lost is the confident `stopped` label and
	// the specific evidence behind it.
	it("reports a stream with a writeHook that has never written as unknown, not stopped", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["historian"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
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
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		const verdict = verdictFor(survey, "historian");
		expect(verdict?.kind).toBe("unknown");
		expect(verdict?.kind === "unknown" && verdict.detail).toContain(
			"no output written yet",
		);
	});

	// historian's own too_short/transcript_unavailable skip paths still emit
	// historian.indexing.complete and still fire historian-session-end. A
	// single firing must not read `stopped` on a fresh checkout.
	//
	// The pair with the test above still holds, just at the same verdict from
	// both ends now: an entry with a write signal that has never written is
	// `unknown` whether its hook fired once or six times, because there is no
	// last-write instant to count opportunities from either way.
	it("does not report a stream stopped from a single write-hook firing with no output yet", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["historian"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			opportunitiesEndingOn: "2026-09-02",
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
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		expect(verdictFor(survey, "historian")?.kind).toBe("unknown");
	});

	// librarian's own shape: events present, output never written, and no
	// amount of firing reads `stopped`, because no hook and no event this
	// table records is write evidence for it - the verification pass confirmed
	// there is nothing to name, since its lesson writers emit nothing at all.
	//
	// It reaches `unknown` by a different route than historian just above.
	// historian HAS a write signal that has never fired; librarian has none to
	// ask about, and lands on the absent-output rule instead - `lessons/` never
	// existed, so no clean bill. Same verdict, two distinct reasons, and worth
	// keeping both tests because a change could break one without the other.
	//
	// This is as close as the table gets to the empty-lesson-pool case
	// librarian's entry describes: surfaced (`unknown` exits 1) but never a
	// confident `stopped`. A lesson-write event upstream is what would change
	// that.
	it("reports librarian unknown rather than stopped now that its write hook is no longer trusted", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["librarian"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			opportunitiesEndingOn: "2026-09-02",
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
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		expect(verdictFor(survey, "librarian")?.kind).toBe("unknown");
	});

	// A fully-read log where the prefix never appears is not evidence the
	// stream is healthy - "recording" with nothing to corroborate it
	// contradicts the check this function makes for a truncated log.
	//
	// Still `unknown`, and deliberately not the `stopped` that six silent
	// opportunities might seem to support. Nothing here distinguishes lineage
	// having died from lineage having been enabled a moment ago on a repo with
	// six sessions of history, because it has never been seen alive either
	// way. What the assertion pins is the other edge: not `recording`.
	it("reports unknown, not recording, when the event log is readable but the stream's prefix never appears", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["lineage"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			files: [
				[
					join("lineage", "aaaaaaaaaaaa", "changes.jsonl"),
					"2026-08-01T00:00:00Z",
				],
			],
			// events (beyond the projectKeys- and opportunity-establishing ones
			// machine() itself adds) are empty - the log is fully read, just
			// empty for this prefix, not missing.
		});
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		const verdict = verdictFor(survey, "lineage");
		expect(verdict?.kind).toBe("unknown");
		expect(verdict?.kind === "unknown" && verdict.detail).toContain(
			"no sign of life yet",
		);
	});

	// A truncated or unreadable event scan clears lastByPrefix (scanEvents's
	// own contract), so a silent prefix reads exactly like "no events fired"
	// and the rule would otherwise judge a source it could not read - and,
	// with the window guard also blind to a log it cannot see, judge it as
	// dead rather than merely unmeasured. `events.missing` is checked first
	// in `computeVerdict` for exactly that reason, ahead of every other
	// branch including the denominator.
	//
	// NOT a per-project entry (lineage): `skipEventsLog` means `machine()`'s
	// own projectKeys-establishing events never get written either, so a
	// per-project entry would hit the "keys could not be determined" guard
	// first and never reach the check this test names. governor is flat (see
	// its table comment), so it reaches it with no interference.
	it("reports unknown, not recording, when the event log is missing", async () => {
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
	// event prefix can identify it - its `events` list is empty, and its
	// hooks are the only axis it has at all. It also declares no write signal
	// of either kind (see its table entry: six ordinary bail sites, plus a
	// seventh "nothing extraction-worthy this session" no-op past all six).
	//
	// Alive on its hooks and unaskable about writes - but `unknown`, not
	// `recording`, because `archivist/` has never been written here. Ten
	// firings with zero output ever produced IS suspicious, and this rule
	// still cannot say `stopped`; what it can now refuse to do is call that a
	// clean bill. archivist is plainly running, its output has never appeared,
	// and this table holds no signal saying whether that is expected - which
	// is `unknown`'s exact meaning.
	//
	// The assertion this test has always protected is the other edge, and it
	// is unchanged: not `stopped` off hook firings alone.
	it("reports archivist unknown, not stopped, from hook firing alone now that the hook is not trusted", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["archivist"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			opportunitiesEndingOn: "2026-08-19",
			hooks: Array.from({ length: 10 }, (_, i) => ({
				hook: "archivist-extract",
				timestamp: `2026-08-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
				status: "success",
				session_id: MACHINE_SESSION_ID,
			})),
		});
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		expect(verdictFor(survey, "archivist")?.kind).toBe("unknown");
	});

	// The same entry gone quiet, which is the half archivist CAN still be
	// judged on: two firings, both well before the six opportunities, and no
	// event prefix to corroborate either way. Silence across a full window is
	// the one finding its hooks can support, and it is a real one - archivist
	// is not undetectable, it is only undetectable in the specific way the
	// test above describes.
	it("reports archivist stopped once its hooks have gone quiet across the window", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["archivist"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
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
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		expect(verdictFor(survey, "archivist")?.kind).toBe("stopped");
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
			// Alive throughout, output frozen across all six - the same
			// well-supported `stopped` as before, reached by the new rule.
			opportunities: 6,
			opportunitiesEndingOn: "2026-06-29",
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
		// The stall's own evidence, still named: which path stopped moving.
		// It was the write hook's name before the rule stopped counting hook
		// firings - see the acceptance-criterion test above.
		expect(verdict?.kind === "stopped" && verdict.detail).toContain(
			join("bursar", "projects"),
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
			// Ending on the last firing, so bursar is alive and `computeVerdict`
			// returns `unknown` ("no output written yet") rather than a
			// `stopped` - which `judge()` would deliberately let survive the
			// unreadable walk, leaving the degrade this test names unexercised.
			opportunities: 6,
			opportunitiesEndingOn: "2026-06-29",
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
	// landing 2026-09-02 must not read as evidence of OUR stream's recency.
	//
	// The expectation flipped from `recording` to `stopped`, and the flip is
	// what makes the test worth keeping. Asserting `recording` only ever
	// proved that the foreign event did not HELP; under a rule where the
	// newest write signal wins, a leaked foreign event lands on the healthy
	// side of every threshold and the test passes whether the scoping works
	// or not. Placed after our own frozen evidence, the six opportunities
	// make the scoped answer `stopped` and the leaked one `recording` - so
	// the assertion now fails if, and only if, the foreign session's event
	// is counted as ours.
	it("does not let a different repo's session's recent event mask this repo's own frozen stream", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["lineage"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
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
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		expect(verdictFor(survey, "lineage")?.kind).toBe("stopped");
	});

	// Same shape on the hook axis: 90 daily firings from a different repo's
	// session, all after our own key's frozen mtime. Scoped to our own
	// sessions, none of them are ours, so bursar-session-end has no records
	// attributable to us at all and bursar has shown no sign of life here.
	//
	// The verdict is `unknown` either way you might first expect, so the
	// fixture is what carries this test: the opportunities sit BEFORE the
	// output's own mtime, which makes the two outcomes differ. Scoped
	// correctly, bursar has no record of its own and was never seen alive, so
	// `unknown`. With the scoping removed, the foreign firings become
	// bursar's liveness, nothing has been asked of it since, and it reads
	// `recording`.
	//
	// Both halves of that had to be arranged deliberately. Under the new rule
	// a leaked foreign firing supplies liveness rather than a stall - the
	// danger runs the opposite way from the reviewer's original reproduction -
	// and with no opportunities at all every verdict is `unknown` regardless,
	// so the original fixture would have passed with the session scoping
	// deleted outright.
	it("does not let a different repo's session's firings stand in for this repo's own liveness", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["bursar"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			opportunitiesEndingOn: "2026-05-31",
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
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		const verdict = verdictFor(survey, "bursar");
		expect(verdict?.kind).toBe("unknown");
		// Specifically "never seen alive", not "too thin a window" - the six
		// opportunities clear the threshold, so only the first of the two
		// abstentions can be the one reached.
		expect(verdict?.kind === "unknown" && verdict.detail).toContain(
			"no sign of life yet",
		);
	});

	// The final review's high-severity finding, reproduced directly: a
	// plugin that stops entirely - no more output, no more events - has both
	// timestamps freeze together, so the GAP between them stays small even as
	// the evidence itself goes stale, and the old rule read that agreement as
	// health. counsel/governor/tribunal on the real machine hit exactly this:
	// silent for a month, reported `recording`, `doctor` exiting 0.
	//
	// The finding stands; the answer got stronger. A 14-day clock could only
	// ever downgrade this to `unknown`, because elapsed time cannot tell a
	// dead stream from an untouched repo. Opportunities can: six of them have
	// passed and lineage showed no sign of life in any, which is a positive
	// finding rather than an absence of one. `stopped`, not `unknown`, is the
	// design's own claim for this case - see the spec's note that counsel
	// would now be reported stopped rather than unknown.
	it("reports stopped, not recording, when a stream's two axes agree only because both froze", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["lineage"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			files: [
				[
					join("lineage", "aaaaaaaaaaaa", "changes.jsonl"),
					"2026-08-01T00:00:00Z",
				],
			],
			events: [
				{
					event_type: "lineage.change.recorded",
					// 5 seconds after the output: the two agree, and agreed a
					// month before the first of the six opportunities.
					timestamp: "2026-08-01T00:00:05Z",
					session_id: MACHINE_SESSION_ID,
					payload: {},
				},
			],
		});
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		const verdict = verdictFor(survey, "lineage");
		expect(verdict?.kind).toBe("stopped");
		expect(verdict?.kind === "stopped" && verdict.detail).toContain(
			"2026-08-01",
		);
	});

	// The same shape on an `output: null` entry (finding 2): if a plugin is
	// removed from hooks.json or its directory disappears, its hook's `.last`
	// and its newest event freeze together at the same instant and it would
	// read `recording` forever while printing an increasingly stale date.
	//
	// inspector rather than ecosystem, for the structural reason recorded on
	// the hooks-outrunning-events test above: ecosystem's own events are the
	// denominator, so it cannot be shown frozen against a populated window.
	it("reports an output:null stream stopped, not recording, when both its axes froze together", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["inspector"],
			opportunities: 6,
			events: [
				{
					event_type: "inspector.check.passed",
					timestamp: "2026-08-01T00:00:00Z",
					session_id: "opp-0",
					payload: {},
				},
			],
			hooks: [
				{
					hook: "inspector-post-write",
					timestamp: "2026-08-01T00:00:05Z",
					status: "success",
					session_id: "opp-0",
				},
			],
		});
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		const verdict = verdictFor(survey, "inspector");
		expect(verdict?.kind).toBe("stopped");
		expect(verdict?.kind === "stopped" && verdict.detail).toContain(
			"2026-08-01",
		);
	});

	// An alarm must never be softened by the window guard: this stream's
	// evidence is stale AND its two axes disagree, and the answer is still
	// `stopped`. Worth keeping explicit now that the guard returns `unknown`
	// for a thin window - placing that check where it could see a stream with
	// a full window behind it would turn every real alarm into an abstention.
	it("still reports stopped, not unknown, when stale evidence also shows a large gap", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["lineage"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
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
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		expect(verdictFor(survey, "lineage")?.kind).toBe("stopped");
	});

	// bursar, which this repo enables, and the case that used to fall through
	// to a clean `recording` off arbitrarily old evidence: output frozen
	// months ago plus routine, below-threshold session-end firings.
	//
	// Now `stopped` rather than the `unknown` the 14-day clock could manage.
	// The reason the firing count no longer rescues it is the point of the
	// whole change: one firing or a hundred, a hook's firings were never a
	// measure of anything: the six opportunities that passed with no sign of
	// life are.
	it("reports stopped, not recording, when a stream froze despite a below-threshold firing count", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["bursar"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			files: [
				[
					join("bursar", "projects", "aaaaaaaaaaaa", "sessions.jsonl"),
					"2026-08-01T00:00:00Z",
				],
			],
			hooks: [
				{
					hook: "bursar-session-end",
					// One firing, and the last sign of life this entry has.
					timestamp: "2026-08-01T01:00:00Z",
					status: "success",
					session_id: MACHINE_SESSION_ID,
				},
			],
		});
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		const verdict = verdictFor(survey, "bursar");
		expect(verdict?.kind).toBe("stopped");
		expect(verdict?.kind === "stopped" && verdict.detail).toContain(
			"2026-08-01",
		);
	});

	// The write axis in isolation, and the only test here that reaches
	// `stopped` through it rather than through liveness: the opportunities
	// are placed to end on the last hook firing, so bursar is demonstrably
	// alive across all six and the sole thing that has not moved is the
	// output. Six firings sit on top of it - once enough to cross
	// STALL_THRESHOLD by themselves - and contribute nothing to the finding.
	it("reports stopped from opportunities elapsed since the last write, not from the write hook's firing count", async () => {
		const { cwd, home, configDir, env } = machine({
			plugins: ["bursar"],
			projectKeys: ["aaaaaaaaaaaa"],
			opportunities: 6,
			opportunitiesEndingOn: "2026-08-07",
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
		const survey = await surveyStreams({
			cwd,
			home,
			configDir,
			env,
			now: NOW,
		});
		const verdict = verdictFor(survey, "bursar");
		expect(verdict?.kind).toBe("stopped");
		expect(verdict?.kind === "stopped" && verdict.detail).toContain(
			"while the stream kept running",
		);
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
