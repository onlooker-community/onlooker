import { lstatSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { onlookerDir } from "./config";
import { type Enablement, findUp, readEnablement } from "./enablement";
import { scanEvents, scanHooks } from "./eventlog";

/**
 * How many trigger firings with no output movement count as stopped.
 *
 * The design's only arbitrary number, and recorded as such. Every stream in
 * the table can legitimately lag its trigger by one session -
 * `bursar-session-start` fires at the top of a session whose output is not
 * written until `bursar-session-end`. Five clears that ordering effect without
 * modeling it per plugin, and leaves margin for a plugin that batches writes.
 * The real bursar outage reached 71.
 */
export const STALL_THRESHOLD = 5;

/**
 * How many write-gate intervals must elapse, past a gated writer's own
 * cadence, before its output's silence is trusted as a real stall rather
 * than an ordinary gap between scheduled writes. See `StreamEntry.
 * writeGateHours` and `clearsCadenceFloor`.
 *
 * Mirrors `STALL_THRESHOLD`'s own reasoning: every stream can legitimately
 * lag its trigger by one session, and five clears that with margin. A
 * gated writer - counsel's brief, cartographer's audit - can legitimately
 * lag by one full `writeGateHours` interval, and two clears that with the
 * same kind of margin.
 */
export const CADENCE_FLOOR_MULTIPLIER = 2;

/**
 * How much newer the latest event can be than the output's own mtime before
 * that gap reads as a stall, for an entry with no `writeHooks` - see
 * `StreamEntry.writeHooks` and `judge()`'s fallback for why some entries
 * cannot use a firing-count check at all.
 *
 * Arbitrary, like `STALL_THRESHOLD` and `CADENCE_FLOOR_MULTIPLIER`, and
 * recorded as such. A plugin writes its output file and emits its event
 * inside the same hook run, so ordinarily the two move together within
 * seconds; an hour is generous margin for that ordinary jitter (a slow
 * write, clock skew between the two) without hiding a real stall, which
 * opens a gap measured in days.
 */
export const EVENT_OUTPUT_TOLERANCE_MS = 60 * 60 * 1000;

/**
 * Filesystem noise an OS can drop into any directory it has browsed,
 * skipped unconditionally by `newestMtime`'s walk - everywhere in the walk,
 * not only where a project key would belong (`classifyPath` already skips
 * a stray file sitting AT the key level; this is for one sitting INSIDE a
 * key's own directory, or anywhere else `newestMtime` descends).
 *
 * Deliberately not folded into `StreamEntry.ignore`: `ignore` is per-entry
 * and names a heartbeat this table knows about (`manifest.json`,
 * `sessions`); this is generic noise no plugin ever wrote and no table
 * entry should need to name to skip. Verified present on this machine:
 * `.DS_Store` turns up inside `~/.onlooker/historian/<key>/` and
 * `~/.onlooker/lineage/` alike, the moment Finder browses either, and its
 * mtime is always "whenever Finder last looked," never the stream's own
 * activity - left uncaught, it reports a frozen stream as fresh forever.
 */
const OS_METADATA_FILES: readonly string[] = [".DS_Store", "Thumbs.db"];

/**
 * One known stream: where its output lands, what it calls its events, and
 * which hooks trigger it.
 *
 * `output` is the stream's ANALYTICAL OUTPUT, never its busiest directory.
 * That distinction is the whole design. `bursar/sessions` was written daily
 * throughout the month `bursar/projects` was frozen, and every check that
 * looked at the busy directory reported a healthy machine.
 *
 * `output: null` means the stream legitimately writes no files, so absence of
 * a directory is expected rather than a fault.
 */
export interface StreamEntry {
	plugin: string;
	output: string | null;
	/**
	 * Per-project-key analytical output, relative to a first-level child of
	 * `output`: the true output path is `<output>/<any key>/<subpath>`, not
	 * `<output>/<subpath>` and not `<output>` itself.
	 *
	 * Undefined for streams whose output sits directly under `output`. Set
	 * only for streams that ALSO write a heartbeat file at the key level on
	 * every session - `manifest.json`, `last_scan.json`, `last_audit_at` -
	 * regardless of whether anything analytical was produced that session.
	 * Without this field, that heartbeat's mtime masks a stalled stream
	 * exactly the way `bursar/sessions` masked a frozen `bursar/projects`:
	 * the key-level directory always looks fresh even when the one
	 * subdirectory that matters has stopped moving, or was never created.
	 */
	subpath?: string;
	/**
	 * Child names to skip anywhere in the walk beneath `output` (or beneath
	 * each `<output>/<key>/<subpath>`, if `subpath` is set) - matched by
	 * basename, at whatever depth they turn up.
	 *
	 * Exists for streams whose real output and a per-session heartbeat are
	 * SIBLINGS rather than nested one inside the other, so `subpath` cannot
	 * separate them. scribe writes its real intent documents at
	 * `scribe/<key>/<date>-<session>.md` and its heartbeat at
	 * `scribe/sessions/<session_id>.json` - both direct children of
	 * `scribe/`, with the heartbeat winning "most recent" on every session
	 * regardless of whether scribe wrote anything real. `ignore:
	 * ["sessions"]` removes that heartbeat from contention without this
	 * table needing to know which child names are real project keys.
	 */
	ignore?: readonly string[];
	/**
	 * How many hours can elapse between the writer's own attempts to write,
	 * for a stream whose real writer is rate-gated behind the hooks in
	 * `hooks` rather than writing on every firing.
	 *
	 * Undefined for the common case, where the hook IS the writer and
	 * `STALL_THRESHOLD` alone is the whole rule. Set only for a stream whose
	 * trigger fires far more often than its writer actually runs: counsel's
	 * brief generation is gated to once per `synthesis_interval_days` (7
	 * days = 168 hours, counsel's config.json:3) while `counsel-session-
	 * start` fires every session; cartographer's audit is gated to once per
	 * `audit_interval_hours` (24, cartographer's config.json:5) while
	 * `cartographer-post-write` fires on every Write. Without this,
	 * `STALL_THRESHOLD` alone reports a perfectly healthy, on-schedule gate
	 * as a stall. See `clearsCadenceFloor`.
	 */
	writeGateHours?: number;
	/**
	 * The subset of `hooks` whose firing implies output should have been
	 * written - the only hooks `judge()`'s stall check counts firings from.
	 *
	 * Undefined or empty when no hook on this entry is a reliable write
	 * signal, whether because one hook name serves several matchers and only
	 * some of them write (lineage), or because the writer itself is gated or
	 * conditional so its hook fires far more than it writes (counsel,
	 * cartographer, curator, governor, echo, tribunal). `judge()` falls back
	 * to comparing event recency against output recency for those entries
	 * instead of counting firings - see `EVENT_OUTPUT_TOLERANCE_MS`.
	 *
	 * Present, and a strict subset of `hooks`, everywhere a hook genuinely
	 * implies a write. See each entry below for which hook and why.
	 */
	writeHooks?: readonly string[];
	/**
	 * Whether this entry's output is organized as `<output>/<key>[/<subpath>]`
	 * - one subtree per project this machine has ever touched - rather than
	 * as one flat tree beneath `output`.
	 *
	 * `subpath` implies it: every `subpath` entry is per-project by
	 * construction, since `<output>/<key>/<subpath>` IS that layout. Set
	 * `perProject` directly for an entry that shares the layout without a
	 * `subpath` of its own - the whole key subtree IS the output, not a
	 * child of it (bursar's own `sessions.jsonl` sits directly under
	 * `<output>/<key>/`, say).
	 *
	 * Matters because a machine-wide walk of a per-project entry's output
	 * root is the bursar trap one level down: two repos sharing one
	 * machine, one with a stream frozen for months and the other writing
	 * daily, would let the busy sibling's key mask the frozen one's -
	 * `judge()` scopes the walk to this repo's own `projectKeys` for any
	 * entry this is true for, and reports `unknown` rather than falling
	 * back to machine-wide when those keys could not be determined at all.
	 * `governor` is the one entry checked and found NOT per-project: its
	 * real layout is a single flat `governance/ledgers/<uuid>.jsonl`, no
	 * key segmentation at any depth.
	 */
	perProject?: boolean;
	events: readonly string[];
	hooks: readonly string[];
}

/**
 * Every stream this CLI knows a health rule for.
 *
 * Not exhaustive, and deliberately not a closed enum. The vocabulary is owned
 * by `onlooker-community/ecosystem` and can grow without telling us; a plugin
 * missing from this table is reported by name as having no health rule, never
 * dropped and never assumed healthy.
 */
export const STREAMS: readonly StreamEntry[] = [
	{
		plugin: "archivist",
		output: "archivist",
		// NOT ["archivist"]. archivist-events.sh's own header comment claims
		// "archivist.* event emission," but the only event it ever emits is
		// "onlooker.artifact.ready" (archivist-extract.sh:292) - zero
		// `archivist.*` records exist in a live event log with 139,299
		// entries. Worse, `onlooker.artifact.ready` is not archivist's alone:
		// counsel and scribe emit it too, so no prefix can identify archivist
		// by itself. An empty list is honest about that; ["onlooker"] would
		// make archivist look alive whenever counsel or scribe fire instead.
		events: [],
		// `manifest.json` is a heartbeat written at the key level by
		// archivist_storage_write_manifest (archivist-storage.sh:52, called
		// from archivist-extract.sh:213), sitting beside four real analytical
		// directories - `extracts/`, `decisions/`, `dead_ends/`,
		// `open_questions/`. It is a SIBLING of those directories, not a
		// parent of them, so `subpath` cannot separate it out; `ignore` can.
		ignore: ["manifest.json"],
		hooks: ["archivist-extract", "archivist-inject"],
		// NOT archivist-inject, which runs at SessionStart and only reads.
		// Extraction - the only write - happens in archivist-extract alone.
		writeHooks: ["archivist-extract"],
		// `archivist/<key>/` per project - verified on disk (first-level
		// children are 12-hex project keys). See `perProject`'s docstring.
		perProject: true,
	},
	{
		plugin: "assayer",
		output: "assayer",
		events: ["assayer"],
		hooks: ["assayer-stop"],
		// Its only hook, and it writes an audit on every stop.
		writeHooks: ["assayer-stop"],
		// `assayer/<key>/` per project - verified on disk.
		perProject: true,
	},
	{
		plugin: "bursar",
		// NOT `bursar/sessions`. See the interface docstring.
		output: join("bursar", "projects"),
		events: ["bursar"],
		hooks: ["bursar-session-start", "bursar-session-end"],
		// NOT bursar-session-start, which fires a whole session before the
		// write bursar-session-end performs - the "one session of lag"
		// STALL_THRESHOLD was originally papering over. Counting
		// session-start's own firings would flag a healthy bursar the
		// moment new sessions keep opening, regardless of whether
		// session-end is writing just fine.
		writeHooks: ["bursar-session-end"],
		// `bursar/projects/<key>/` per project - verified on disk. No
		// `subpath` of its own: the whole key subtree (`sessions.jsonl` and
		// whatever else) IS the output, unlike librarian/historian/etc.,
		// which have a heartbeat sibling `subpath` needs to separate out.
		perProject: true,
	},
	{
		plugin: "cartographer",
		output: "cartographer",
		// `audit.log` and `last_audit_at` are heartbeats written at the key
		// level by cartographer-session-start.sh and cartographer-post-write.sh
		// on every session. See `subpath`'s docstring.
		//
		// NOT `findings`. `findings/<hash>.json` is written only when a NEW
		// problem turns up (run-audit.sh:306); `runs/audit-<id>.json` is
		// written on every COMPLETED audit (run-audit.sh:370). A clean repo
		// audited daily advances `runs/` while `findings/` stays frozen at
		// its last issue - every one of 20 keys on a live machine reads
		// `runs=1, findings=0`. `runs/` is "the analytical pass actually
		// happened," which is what this table's stall check asks.
		subpath: "runs",
		// `cartographer-post-write` fires on every Write, but an audit only
		// runs once per `audit_interval_hours` - 24 by default
		// (config.json:5) - via cartographer-session-start.sh:45-57's own
		// elapsed-time gate. Without this, `STALL_THRESHOLD` can be crossed
		// within a single busy day on a perfectly healthy stream. See
		// `clearsCadenceFloor`.
		writeGateHours: 24,
		events: ["cartographer"],
		// No writeHooks: cartographer-post-write fires on every Write, but
		// the audit it triggers is itself gated (writeGateHours above), so
		// neither hook's firing reliably implies a write. judge() falls back
		// to comparing event recency against output recency instead.
		hooks: ["cartographer-post-write", "cartographer-session-start"],
	},
	{
		plugin: "compass",
		// `compass/sessions/<id>.json` (written at session start, updated on
		// every tracked write - compass-session-start.sh:42, compass-record-
		// write.sh:52) is the ONLY thing this plugin writes anywhere under
		// $ONLOOKER_DIR. There is no separate analytical output to point at -
		// every byte compass writes is per-session state - so `output: null`
		// is the honest answer, not a subpath or an ignore list standing in
		// for output that does not exist.
		output: null,
		events: ["compass"],
		hooks: [
			"compass-bash-gate",
			"compass-pre-tool-use",
			"compass-record-write",
			"compass-session-start",
		],
	},
	{
		plugin: "counsel",
		output: "counsel",
		// `counsel-session-start` fires every session, but real brief
		// generation is gated by `counsel_brief_is_stale`
		// (counsel-brief.sh:89) to once per `synthesis_interval_days` - 7
		// days, 168 hours, by default (config.json:3). Without this, a
		// normal week of 6+ sessions crosses `STALL_THRESHOLD` with zero
		// output movement on a perfectly healthy, on-schedule stream. See
		// `clearsCadenceFloor`.
		writeGateHours: 168,
		events: ["counsel"],
		// No writeHooks: its only hook fires every session while the brief
		// it triggers is gated (writeGateHours above), so firing does not
		// imply a write. judge() falls back to comparing event recency
		// against output recency instead.
		hooks: ["counsel-session-start"],
		// `counsel/<key>/` per project - verified on disk.
		perProject: true,
	},
	{
		plugin: "curator",
		output: "curator",
		// `manifest.json` is a heartbeat written at the key level by
		// curator-session-start.sh on every session, including both early-exit
		// paths where no memory store was found; `findings/` is the
		// analytical output. See `subpath`'s docstring.
		subpath: "findings",
		events: ["curator"],
		// No writeHooks: its only hook fires on SessionStart while the scan
		// it triggers is conditional, not guaranteed on every firing.
		// judge() falls back to comparing event recency against output
		// recency instead.
		hooks: ["curator-session-start"],
	},
	{
		plugin: "echo",
		output: "echo",
		events: ["echo"],
		// No writeHooks: echo-stop-gate fires on every Stop regardless of
		// outcome (hook-health.sh's EXIT trap logs unconditionally) but
		// writes only when a watched agent file changed this session -
		// echo-stop-gate.sh's own header: "Skips silently if disabled, no
		// git context, or no watched files changed." A session that never
		// touches an agent prompt is ordinary, not a stall. judge() falls
		// back to comparing event recency against output recency instead.
		hooks: ["echo-stop-gate"],
		// `echo/<key>/` per project - verified on disk.
		perProject: true,
	},
	{
		// Its root hooks DO write files under $ONLOOKER_DIR -
		// `session-history/<session_id>.jsonl` and
		// `agent-spawn-trackers.json` both exist on a live machine - so
		// "writes nothing" would be wrong. Both are per-session heartbeats
		// though, not an analytical artifact a stall check could point at,
		// so `output: null` still stands: there is no output path whose
		// freshness would mean anything here. Its trace is the shared event
		// log instead.
		plugin: "ecosystem",
		output: null,
		events: ["session", "tool", "skill", "memory", "task"],
		hooks: [
			"session-start-tracker",
			"session-end-tracker",
			"session-duration-tracker",
			"turn-tracker",
			"tool-history-tracker",
			"tool-sequence-tracker",
			"skill-usage-tracker",
			"memory-recall-tracker",
			"prompt-rule-injector",
			"agent-spawn-tracker",
			"task-tracker",
			"pre-compact-tracker",
			"context-compact-tracker",
			"worktree-tracker",
		],
	},
	{
		// Three different names for one thing, and this table is the only
		// place they are reconciled. The PLUGIN is `governor` - that is the
		// key in enabledPlugins, so keying this entry by anything else makes
		// the lookup miss and report "no rule" on an enabled plugin. Its
		// output directory is `governance/`, and its events are `governor.*`.
		plugin: "governor",
		output: "governance",
		events: ["governor"],
		// No writeHooks: governor's hooks fire on every tool call and every
		// session; governance/ writes are conditional on what governor
		// actually decides, not guaranteed on any one firing. judge() falls
		// back to comparing event recency against output recency instead.
		hooks: [
			"governor-post-tool-use",
			"governor-pre-tool-use",
			"governor-session-start",
			"governor-stop",
		],
		// NOT perProject, checked directly (not inferred): `~/.onlooker/
		// governance/` holds one flat `ledgers/` directory
		// (governor-ledger.sh:29 - `${ONLOOKER_DIR}/governance/ledgers`),
		// its files named by UUID, not project key, at no depth. A machine-
		// wide walk is the correct - and only - reading for this entry.
	},
	{
		plugin: "historian",
		output: "historian",
		// `manifest.json` is a heartbeat written at the key level by
		// historian-session-end.sh on every session, including the
		// `transcript_unavailable` skip path; `sessions/` is the analytical
		// output. See `subpath`'s docstring.
		subpath: "sessions",
		events: ["historian"],
		hooks: ["historian-prompt-submit", "historian-session-end"],
		// NOT historian-prompt-submit, which fires on every prompt and
		// writes nothing analytical by itself.
		writeHooks: ["historian-session-end"],
	},
	{
		// Writes no directory of its own; its trace is the shared event log.
		plugin: "inspector",
		output: null,
		events: ["inspector"],
		hooks: ["inspector-post-write"],
	},
	{
		plugin: "librarian",
		output: "librarian",
		// `manifest.json` and `last_scan.json` are heartbeats written at the
		// key level by librarian-session-end.sh on every session, including
		// the zero-candidate bail - so `librarian/<key>/` always looks fresh.
		// `lessons/` is the actual analytical output, and an empty lesson
		// pool - no `lessons/` directory at all - is precisely the failure
		// this table exists to catch. See `subpath`'s docstring.
		subpath: "lessons",
		events: ["librarian"],
		hooks: ["librarian-session-end", "librarian-session-start"],
		// NOT librarian-session-start, which writes nothing.
		writeHooks: ["librarian-session-end"],
	},
	{
		plugin: "lineage",
		output: "lineage",
		events: ["lineage"],
		// One hook name, four matchers - Edit, Write, MultiEdit, and Bash
		// (lineage's own hooks.json). "Bash outruns Edit roughly 30:1"
		// (hooks.json:147), so this hook's firing count alone reads a
		// perfectly healthy lineage as stalled after about five Bash calls
		// with no edit. No writeHooks: judge() falls back to comparing
		// event recency against output recency for this entry instead.
		hooks: ["lineage-post-tool-use"],
		// `lineage/<key>/` per project - verified on disk.
		perProject: true,
	},
	{
		plugin: "scribe",
		output: "scribe",
		// `sessions/<session_id>.json` (scribe-capture.sh) is a heartbeat
		// written on the first prompt of every session; the real output is
		// `<key>/<date>-<session>.md`, written only by scribe-stop. Both are
		// direct children of `scribe/`, so `subpath` cannot separate them -
		// `ignore` removes the heartbeat directory from contention instead.
		ignore: ["sessions"],
		events: ["scribe"],
		// No writeHooks: scribe-capture and scribe-session-start are
		// heartbeats; scribe-stop writes, but only when there is something
		// to distill, so even the real write hook fires more often than it
		// writes. judge() falls back to comparing event recency against
		// output recency instead.
		hooks: ["scribe-capture", "scribe-session-start", "scribe-stop"],
		// `scribe/<key>/` per project - its own table comment above already
		// documents the `<key>/<date>-<session>.md` layout.
		perProject: true,
	},
	{
		plugin: "tribunal",
		output: "tribunal",
		events: ["tribunal"],
		// No writeHooks: tribunal-stop-gate fires on every Stop but skips
		// writing whenever skip_if_no_file_changes (tribunal's config.json,
		// true by default) finds a clean working tree - tribunal-stop-
		// gate.sh's own header: "Skips silently if disabled, no git
		// context, no transcript, or skip_if_no_file_changes is true and
		// the last turn did not modify files." A read-only session is
		// ordinary, not a stall. judge() falls back to comparing event
		// recency against output recency instead.
		hooks: ["tribunal-stop-gate"],
		// `tribunal/<key>/` per project - verified on disk.
		perProject: true,
	},
	{
		// `warden/sessions/<session_id>/gate.json` (warden-session-
		// start.sh:46) is the only thing this plugin writes anywhere under
		// $ONLOOKER_DIR - a per-session content gate, not an analytical
		// artifact. `output: null` is the honest answer; there is nothing
		// here for `subpath` or `ignore` to separate real output from.
		plugin: "warden",
		output: null,
		events: ["warden"],
		hooks: [
			"warden-post-tool-use",
			"warden-pre-tool-use",
			"warden-session-start",
		],
	},
];

/**
 * What a path means to this walk, resolving exactly one symlink hop and no
 * further. The single place this file decides what a filesystem error or a
 * symlink is worth - three separate reviews reported two call sites
 * disagreeing about that question, because there used to be four places
 * answering it independently. Now there is one.
 *
 * `"absent"`: the path does not exist (`lstatSync` failed with `ENOENT`),
 * or it is a symlink whose target does not exist or is not a directory.
 * None of these are a fault. A stream may simply never have written here,
 * and a symlink pointing at a file - or at nothing - was never a project
 * key or an output directory and cannot be masking a busy sibling, the same
 * reasoning that lets a `.DS_Store` sitting where a key belongs get skipped
 * rather than flagged.
 *
 * `"unreadable"`: `lstatSync` failed for any other reason (a permissions
 * error, say), or the path is a symlink whose target DOES resolve to a
 * directory. Both are things this process could not fully measure - a
 * symlinked directory's contents cannot be verified as the stream's real
 * output rather than some other directory entirely, `readdirSync` follows
 * it without complaint, and something this walk could not measure does not
 * get a clean bill.
 *
 * `"directory"` / `"file"`: a real, non-symlinked directory or file. Safe
 * to walk, or to read `mtimeMs` from, respectively - `mtimeMs` is present
 * only for `"file"`, since a directory's own mtime is never what this walk
 * is measuring.
 */
function classifyPath(
	path: string,
):
	| { kind: "absent" | "unreadable" | "directory" }
	| { kind: "file"; mtimeMs: number } {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch (error) {
		return {
			kind:
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? "absent"
					: "unreadable",
		};
	}
	if (!stat.isSymbolicLink()) {
		return stat.isDirectory()
			? { kind: "directory" }
			: { kind: "file", mtimeMs: stat.mtimeMs };
	}
	// A symlink: resolve exactly one hop to see what it points at, but never
	// descend through it. See the docstring above for why a directory target
	// is `"unreadable"` rather than walked, and why anything else - a
	// dangling target, or one that resolves to a plain file - is `"absent"`.
	try {
		return statSync(path).isDirectory()
			? { kind: "unreadable" }
			: { kind: "absent" };
	} catch {
		return { kind: "absent" }; // Dangling - cannot be masking a busy sibling.
	}
}

/**
 * `classifyPath`, collapsed to three states for a path this walk expects to
 * be a directory: the top-level `output` root, a `<key>/<subpath>` root, or
 * a directory popped off `newestMtime`'s queue.
 *
 * `"file"` is folded into `"unreadable"` here, not `"absent"`: unlike a
 * symlink that resolves to a file (per `classifyPath`, never a directory to
 * begin with, so never a real output path), a plain file sitting where a
 * directory was configured - `bursar/projects` created as a file instead of
 * a directory, say - is a genuine problem this walk cannot proceed past, not
 * an ordinary absence.
 */
function classifyRoot(path: string): "absent" | "unreadable" | "ok" {
	const result = classifyPath(path);
	if (result.kind === "directory") return "ok";
	if (result.kind === "file") return "unreadable";
	return result.kind;
}

/**
 * Newest mtime (in ms since epoch) anywhere beneath `root`, or `null` if
 * nothing was found. Never throws.
 *
 * `ignore` skips any child whose basename matches, at whatever depth it
 * turns up - see `StreamEntry.ignore`'s docstring for why a name match,
 * rather than a depth limit, is what a heartbeat sibling needs.
 *
 * `null` rather than `0` for "nothing found": a file restored with a zeroed
 * or epoch mtime is real output at ms `0`, and collapsing that into the same
 * sentinel used for "no files exist here" would report a directory full of
 * files as having no output at all.
 *
 * Iterative rather than recursive: a stream directory's depth is not bounded
 * by anything this CLI controls, and a diagnostic must not be the thing that
 * blows the stack on a machine that is already misbehaving.
 */
function newestMtime(
	root: string,
	ignore: readonly string[] = [],
): {
	newestMs: number | null;
	unreadable: boolean;
} {
	let newestMs: number | null = null;
	let unreadable = false;

	const queue = [root];
	while (queue.length > 0) {
		const dir = queue.pop() as string;

		// `classifyRoot`, not a plain `readdirSync`: `dir` is the walk's own
		// seed on the first iteration, and the seed is exactly what a
		// symlinked output path would reach here as. See `classifyRoot`'s
		// docstring for why that must never be walked, whether `dir` is the
		// caller's original root or one this walk found partway through.
		const status = classifyRoot(dir);
		if (status === "absent") continue;
		if (status === "unreadable") {
			unreadable = true;
			continue;
		}

		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			// Same contract as pipeline.ts: a directory that exists but cannot
			// be listed is a finding, not something to swallow. Keep walking so
			// one bad directory does not cost the others their timestamps.
			unreadable = true;
			continue;
		}
		for (const name of entries) {
			if (ignore.includes(name) || OS_METADATA_FILES.includes(name)) continue;
			const path = join(dir, name);
			const result = classifyPath(path);
			switch (result.kind) {
				case "absent":
					// Either a benign race - `readdirSync` snapshots names,
					// and `classifyPath` runs a moment later, so a file the
					// walk just enumerated can vanish before it gets here,
					// librarian pruning a proposal while `doctor` walks past
					// it, say - or a symlink that was never real output. See
					// `classifyPath`'s docstring for both cases.
					continue;
				case "unreadable":
					unreadable = true;
					continue;
				case "directory":
					// A symlink cycle must never regrow `queue`: `classifyPath`
					// never returns `"directory"` for a symlink, so nothing
					// pushed here is anything but a real, non-symlinked
					// directory.
					queue.push(path);
					continue;
				case "file":
					if (newestMs === null || result.mtimeMs > newestMs) {
						newestMs = result.mtimeMs;
					}
			}
		}
	}

	return { newestMs, unreadable };
}

/**
 * `mtimeMs` as an ISO timestamp, or `null` if it falls outside `Date`'s
 * representable range (roughly ±285,616 years from the epoch), or is not a
 * finite number at all.
 *
 * `Date#toISOString` throws `RangeError: Invalid time value` for either
 * case - a bad clock write, or a botched archive extraction, is enough to
 * produce one. `outputFreshness` documents "never throws," and this is the
 * diagnostic meant to survive an already-misbehaving machine, so a corrupt
 * timestamp must become a reported state, not an exception that takes the
 * whole `doctor` run down. Exported for direct testing: a genuinely
 * out-of-range mtime cannot be constructed through this suite's usual
 * `utimesSync`-based fixtures, since `Date` itself cannot represent the
 * value needed to set one.
 */
export function mtimeToIso(mtimeMs: number): string | null {
	if (!Number.isFinite(mtimeMs) || Math.abs(mtimeMs) > 8_640_000_000_000_000) {
		return null;
	}
	return new Date(mtimeMs).toISOString();
}

/**
 * The `{ mtime, unreadable }` shape `outputFreshness` returns, from the raw
 * `newestMs`/`unreadable` pair a walk produced.
 *
 * A `newestMs` that fails to convert - see `mtimeToIso` - sets `unreadable`
 * rather than staying `false`: `null` alone means "nothing was found," and
 * a corrupt timestamp means the opposite happened - something WAS found,
 * and could not be trusted, the same verdict this module already gives a
 * directory it could not read.
 */
function finalize(
	newestMs: number | null,
	unreadable: boolean,
): { mtime: string | null; unreadable: boolean } {
	if (newestMs === null) return { mtime: null, unreadable };
	const mtime = mtimeToIso(newestMs);
	return { mtime, unreadable: unreadable || mtime === null };
}

/**
 * The per-key walk shared by `outputFreshness`'s per-key branch and
 * `perProjectFreshness`: for each of `keys`, resolves `<root>/<key>` (or
 * `<root>/<key>/<entry.subpath>` when set) and folds its newest mtime into
 * a running max.
 *
 * `outputFreshness` calls this with every key `readdirSync(root)` finds -
 * machine-wide, correct for a raw "what does this output root hold"
 * reading. `perProjectFreshness` calls it with only this repo's own
 * `projectKeys` instead, so a sibling repo's key is never probed at all -
 * not filtered out after listing, never listed to begin with.
 */
function walkKeys(
	root: string,
	keys: readonly string[],
	entry: StreamEntry,
): { newestMs: number | null; unreadable: boolean } {
	let newestMs: number | null = null;
	let unreadable = false;
	for (const key of keys) {
		const keyPath = join(root, key);
		// A project key must be a real, non-symlinked directory. A plain file
		// sitting alongside the key directories - macOS's `.DS_Store` is the
		// constant offender - is not a key at all; neither is a symlink whose
		// target is a file or does not exist (a stale `<old-key> -> <moved
		// checkout>` left behind by a relocated repo, say). Treating any of
		// those as a key would turn `<key>/<subpath>` into e.g.
		// `.DS_Store/sessions`, which throws ENOTDIR rather than ENOENT and
		// would flag the whole stream unreadable over a name that was never a
		// key to begin with. `classifyPath`'s `"absent"` and `"file"` outcomes
		// both mean exactly that, so both are skipped the same way; only a
		// symlinked key that DOES resolve to a directory counts unreadable,
		// same as everywhere else in this file - its contents cannot be
		// verified as real output.
		const keyResult = classifyPath(keyPath);
		if (keyResult.kind === "absent" || keyResult.kind === "file") continue;
		if (keyResult.kind === "unreadable") {
			unreadable = true;
			continue;
		}

		// No `subpath`: the whole key subtree IS the output (bursar, say) -
		// walk `keyPath` itself rather than a child of it.
		const dir =
			entry.subpath === undefined ? keyPath : join(keyPath, entry.subpath);
		// A key that has no `<subpath>` yet has simply produced nothing - that
		// is absence, not a fault. `classifyRoot`, not `existsSync`: see its
		// docstring for why `existsSync` cannot be trusted to tell that apart
		// from a directory this process cannot read.
		const status = classifyRoot(dir);
		if (status === "absent") continue;
		if (status === "unreadable") {
			unreadable = true;
			continue;
		}
		const result = newestMtime(dir, entry.ignore);
		if (result.unreadable) unreadable = true;
		if (
			result.newestMs !== null &&
			(newestMs === null || result.newestMs > newestMs)
		) {
			newestMs = result.newestMs;
		}
	}
	return { newestMs, unreadable };
}

/**
 * Newest mtime anywhere beneath a stream's declared output path,
 * machine-wide - every project key this output root has ever held data
 * for, not just this repo's own.
 *
 * Correct for a raw "what does this hold" reading - `anyDataFreshness`'s
 * footer, or a `perProject: undefined` entry, where there is no "this
 * repo's keys" concept to begin with. Wrong for a per-project entry's
 * VERDICT: see `perProjectFreshness`, which `surveyStreams` calls instead
 * for any entry `isPerProject` is true for.
 */
export function outputFreshness(
	entry: StreamEntry,
	env: NodeJS.ProcessEnv = process.env,
): { mtime: string | null; unreadable: boolean } {
	if (entry.output === null) return { mtime: null, unreadable: false };

	const root = join(onlookerDir(env), entry.output);

	if (entry.subpath === undefined) {
		const { newestMs, unreadable } = newestMtime(root, entry.ignore);
		return finalize(newestMs, unreadable);
	}

	// Per-project-key layout: the analytical output sits at
	// `<output>/<key>/<subpath>` for each project key this stream has ever
	// touched, never at `<output>/<subpath>` and never at `<output>` itself.
	const rootStatus = classifyRoot(root);
	if (rootStatus === "absent") return { mtime: null, unreadable: false };
	if (rootStatus === "unreadable") return { mtime: null, unreadable: true };

	let keys: string[];
	try {
		keys = readdirSync(root);
	} catch {
		return { mtime: null, unreadable: true };
	}

	const { newestMs, unreadable } = walkKeys(root, keys, entry);
	return finalize(newestMs, unreadable);
}

/**
 * Newest mtime anywhere beneath a per-project stream's output path,
 * restricted to `projectKeys` - this repo's own project keys, never every
 * key discovered on disk.
 *
 * The bursar trap one level down: two repos sharing one machine, one with
 * a stream frozen for months and the other writing daily, must not let the
 * busy sibling's key mask the frozen one's - `outputFreshness`'s per-key
 * branch, walked machine-wide, would do exactly that. Iterates
 * `projectKeys` directly rather than `readdirSync(root)` filtered
 * afterward: a key this repo never touched is never probed at all, on disk
 * or in the verdict. `judge()` never calls this with an empty
 * `projectKeys` - see its own "keys could not be determined" guard.
 */
function perProjectFreshness(
	entry: StreamEntry,
	env: NodeJS.ProcessEnv,
	projectKeys: readonly string[],
): { mtime: string | null; unreadable: boolean } {
	// `entry.output` is guaranteed non-null by every caller: `isPerProject`
	// only means anything once there is an output path for keys to sit
	// beneath, and no entry sets both `output: null` and `perProject: true`.
	const root = join(onlookerDir(env), entry.output as string);
	const rootStatus = classifyRoot(root);
	if (rootStatus === "absent") return { mtime: null, unreadable: false };
	if (rootStatus === "unreadable") return { mtime: null, unreadable: true };

	const { newestMs, unreadable } = walkKeys(root, projectKeys, entry);
	return finalize(newestMs, unreadable);
}

/**
 * Whether `entry`'s output is per-project - `subpath` implies it (every
 * `subpath` entry's layout is `<output>/<key>/<subpath>` by construction);
 * see `StreamEntry.perProject` for the entries that set it directly.
 */
function isPerProject(entry: StreamEntry): boolean {
	return entry.perProject === true || entry.subpath !== undefined;
}

/**
 * The output path as a user-facing string, for `doctor`'s detail lines.
 *
 * `entry.output` alone is misleading once the walk is scoped to a single
 * key rather than the whole output root - true both when `subpath` is set
 * (`librarian` is not `librarian/lessons`, it is `librarian/<any project
 * key>/lessons`) and, just as much, for a `perProject` entry with no
 * `subpath` of its own (`bursar` is not `bursar/projects`, it is
 * `bursar/projects/<this repo's own keys>` - the walk never covers a
 * sibling repo's key, so the label must not claim it does). `*` stands in
 * for "whichever key," the same wildcard a user would type at a shell
 * prompt to glob it. Omitted only for an entry that is genuinely neither -
 * `governor`'s machine-wide `governance/`, say - where `entry.output` alone
 * already describes everything the walk covered.
 */
export function outputLabel(entry: StreamEntry): string {
	if (entry.output === null) return "(none)";
	if (entry.subpath !== undefined)
		return join(entry.output, "*", entry.subpath);
	if (isPerProject(entry)) return join(entry.output, "*");
	return entry.output;
}

/**
 * Whether enough time has passed since `mtime` for a firing-count stall
 * verdict to be trusted, given `entry`'s own write gate (if any). Exported
 * for Task 5's `judge()`, which is expected to require BOTH this AND its
 * own firing-count-past-`STALL_THRESHOLD` check before calling a gated
 * stream stopped - this function answers only the elapsed-time half.
 *
 * Exists because `STALL_THRESHOLD` alone assumes every trigger firing
 * should move output - true when the hook IS the writer, false when the
 * writer is rate-gated behind it. See `StreamEntry.writeGateHours` for the
 * concrete counsel/cartographer cases this covers.
 *
 * Entries without `writeGateHours` always clear this - their trigger IS
 * their writer, so `STALL_THRESHOLD` was already the whole rule and this
 * adds nothing for them. An entry with no `mtime` also always clears it -
 * there is no gate interval to measure elapsed time against, and "never
 * produced anything" is a distinct verdict from "stopped producing," not
 * this function's concern.
 *
 * `now` is injectable, defaulting to the real clock at the edge, so this -
 * and anything Task 5 builds on it - stays testable without depending on
 * wall time, the same `env`-threading pattern used throughout this file.
 */
export function clearsCadenceFloor(
	entry: StreamEntry,
	mtime: string | null,
	now: Date = new Date(),
): boolean {
	if (entry.writeGateHours === undefined || mtime === null) return true;
	const elapsedMs = now.getTime() - new Date(mtime).getTime();
	const floorMs =
		entry.writeGateHours * CADENCE_FLOOR_MULTIPLIER * 60 * 60 * 1000;
	return elapsedMs >= floorMs;
}

/**
 * What one stream's three sources add up to.
 *
 * `unknown` is deliberately distinct from `recording`. A stream we could not
 * measure has not earned a clean bill, and saying otherwise is the exact
 * failure this command exists to remove.
 */
export type Verdict =
	| { kind: "recording"; detail: string }
	| { kind: "stopped"; detail: string }
	| { kind: "unknown"; detail: string }
	| { kind: "no-rule" };

export interface StreamSurvey {
	enablement: Enablement;
	/** Project keys this repo's sessions produced, sorted. */
	projectKeys: string[];
	/** One entry per enabled plugin, alphabetical. */
	verdicts: Array<{ plugin: string; verdict: Verdict }>;
	/** Streams holding data on this machine that this project does not enable. */
	footer: Array<{ plugin: string; detail: string }>;
	/** Problems reading the sources themselves, as opposed to any one stream. */
	faults: string[];
}

/** Repo root for the session join: nearest ancestor holding a `.git`. */
function repoRoot(cwd: string): string | null {
	const dotGit = findUp(cwd, ".git");
	return dotGit === null ? null : dirname(dotGit);
}

/**
 * Newest mtime anywhere under a stream's raw output root, ignoring `subpath`
 * and `ignore` entirely.
 *
 * Used only by the footer, which asks a different question than
 * `outputFreshness`: not "did the analytical output move" but "is there any
 * data here at all." A heartbeat `outputFreshness` deliberately excludes from
 * a stall verdict - a manifest, a proposal, a tombstone - is still real data
 * a user would want surfaced if this project does not enable the plugin that
 * wrote it. See `surveyStreams`'s footer-construction comment for the
 * reasoning behind that choice.
 */
function anyDataFreshness(
	entry: StreamEntry,
	env: NodeJS.ProcessEnv,
): { mtime: string | null; unreadable: boolean } {
	if (entry.output === null) return { mtime: null, unreadable: false };
	const root = join(onlookerDir(env), entry.output);
	const { newestMs, unreadable } = newestMtime(root);
	return finalize(newestMs, unreadable);
}

export async function surveyStreams(opts: {
	cwd: string;
	home?: string;
	configDir?: string;
	env?: NodeJS.ProcessEnv;
	/**
	 * Injectable clock, defaulted to the real one only here at the edge - see
	 * `clearsCadenceFloor`. Every verdict downstream of a gated writer is
	 * time-dependent, and a test that depends on wall time is a test that
	 * fails at midnight.
	 */
	now?: Date;
}): Promise<StreamSurvey> {
	const env = opts.env ?? process.env;
	const now = opts.now ?? new Date();
	// `configDir` and `env` are threaded rather than defaulted inside
	// readEnablement: without them a test inherits the developer's real
	// CLAUDE_CONFIG_DIR and reads their actual settings.json.
	const enablement = readEnablement({
		cwd: opts.cwd,
		home: opts.home,
		configDir: opts.configDir,
		env,
	});
	const faults: string[] = [];

	const root = repoRoot(opts.cwd);
	const events = await scanEvents({ root, env });
	if (events.missing)
		faults.push("logs/onlooker-events.jsonl could not be read");
	if (events.unreadable > 0) {
		faults.push(`${events.unreadable} event log line(s) could not be parsed`);
	}

	const enabled = enablement.kind === "found" ? enablement.plugins : [];
	const known = new Map(STREAMS.map((s) => [s.plugin, s]));

	// Mtimes first, so the hook scan can count firings *since* each output
	// last moved in one pass rather than retaining every timestamp.
	const freshness = new Map<string, ReturnType<typeof outputFreshness>>();
	const since: Record<string, string> = {};
	for (const plugin of enabled) {
		const entry = known.get(plugin);
		if (entry === undefined) continue;
		// A per-project entry with no known project keys has nothing to
		// scope the walk to - skip freshness entirely rather than fall back
		// to `outputFreshness`'s machine-wide walk, which is exactly the
		// masking `perProjectFreshness` exists to prevent. `judge()`'s own
		// guard reports `unknown` for this case without ever consulting
		// `freshness`, so leaving no entry here is safe.
		if (isPerProject(entry) && events.projectKeys.length === 0) continue;
		const fresh = isPerProject(entry)
			? perProjectFreshness(entry, env, events.projectKeys)
			: outputFreshness(entry, env);
		freshness.set(plugin, fresh);
		if (fresh.mtime === null) continue;
		for (const hook of entry.hooks) since[hook] = fresh.mtime;
	}

	// `sessionIds` scopes hook firings to this repo's own sessions, the same
	// way `events.lastByPrefix` was already scoped inside `scanEvents` -
	// without it, a single unrelated repo's session firing a write hook 90
	// times pushes `firedSince` past `STALL_THRESHOLD` on a stream this
	// repo's own sessions never touched. Passed only when `root` is
	// non-null, mirroring `scanEvents`'s own scoping condition exactly: no
	// root means no repo context to scope by at all, so `scanHooks` keeps
	// its unscoped default rather than being handed an empty set that would
	// scope every hook to nothing.
	const hooks = await scanHooks({
		since,
		sessionIds: root === null ? undefined : events.sessionIds,
		env,
	});
	if (hooks.missing) faults.push("logs/hook-health.jsonl could not be read");
	if (hooks.unreadable > 0) {
		faults.push(`${hooks.unreadable} hook-health line(s) could not be parsed`);
	}

	// `enabled` is already alphabetical (readEnablement sorts it), so mapping
	// straight over it keeps verdicts alphabetical without a second sort.
	const verdicts = enabled.map((plugin) => ({
		plugin,
		verdict: judge(
			known.get(plugin),
			freshness.get(plugin),
			events,
			hooks,
			now,
		),
	}));

	// Footer: streams holding ANY data - not just analytical output - that
	// this project does not enable.
	//
	// Deliberately broader than `outputFreshness`. After the `subpath`/
	// `ignore` corrections, several table entries resolve `outputFreshness`
	// to null whenever the only thing on disk is a heartbeat rather than
	// real analytical output - librarian's `manifest.json` with no
	// `lessons/` yet, cartographer's `audit.log` with no completed `runs/`,
	// and so on. That is exactly the right behavior for a stall verdict:
	// the heartbeat must not mask a stopped stream. But the footer is not a
	// stall verdict - it exists so a user poking around $ONLOOKER_DIR is not
	// surprised to find a directory `doctor` never mentioned. A manifest is
	// still real data. `anyDataFreshness` answers that broader question by
	// walking the raw output root, ignoring both restrictions.
	//
	// This still cannot see `compass` or `warden`'s per-session state:
	// both declare `output: null`, and there is no path this table
	// validates to walk instead. Guessing `<plugin name>` as a directory
	// would be wrong on its own - `governor` writes to `governance/`, and
	// this table exists precisely because plugin name and directory name
	// are not reliably the same thing - so that gap is left open rather
	// than papered over with an assumption this table does not make
	// anywhere else.
	//
	// Restricted to table entries on purpose - without that rule the footer
	// fills with logs/, session-history/, and session-trackers/, which are
	// shared infrastructure rather than per-plugin streams, and the one line
	// that matters gets buried in a dozen that do not.
	//
	// Built only when enablement itself is `"found"`. `enabled` is `[]`
	// whenever enablement is `"unknown"` - not because this project enables
	// nothing, but because this run could not tell - so looping over
	// `STREAMS` in that state would list every stream holding data as "this
	// project does not enable it," a claim the unknown enablement explicitly
	// does not support. `readEnablement` keeps that distinction on purpose;
	// this is the one place downstream that would otherwise discard it.
	const footer: Array<{ plugin: string; detail: string }> = [];
	if (enablement.kind === "found") {
		for (const entry of STREAMS) {
			if (enabled.includes(entry.plugin)) continue;
			const fresh = anyDataFreshness(entry, env);
			if (fresh.mtime === null) continue;
			footer.push({
				plugin: entry.plugin,
				detail: `last wrote ${fresh.mtime.slice(0, 10)}`,
			});
		}
	}

	return {
		enablement,
		projectKeys: events.projectKeys,
		verdicts,
		footer,
		faults,
	};
}

/**
 * The gap `judge()` allows between two triggers' timestamps before it reads
 * as a stall, given `entry`'s own write gate (if any).
 *
 * Shared by the `output: null` branch (a hook's `last` firing vs. the
 * newest event) and the no-`writeHooks` fallback (the newest event vs. the
 * output's own mtime): both compare one axis this function trusts against
 * another it cannot directly measure a write from, and both need the same
 * margin for a gated writer's own trigger to legitimately lag by up to its
 * own write-gate interval - `counsel`'s `writeGateHours: 168` and
 * `cartographer`'s `writeGateHours: 24` are the concrete cases, the same
 * reasoning `clearsCadenceFloor` applies on the firing-count path.
 */
function toleranceFor(entry: StreamEntry): number {
	return entry.writeGateHours === undefined
		? EVENT_OUTPUT_TOLERANCE_MS
		: Math.max(
				EVENT_OUTPUT_TOLERANCE_MS,
				CADENCE_FLOOR_MULTIPLIER * entry.writeGateHours * 60 * 60 * 1000,
			);
}

function judge(
	entry: StreamEntry | undefined,
	fresh: ReturnType<typeof outputFreshness> | undefined,
	events: Awaited<ReturnType<typeof scanEvents>>,
	hooks: Awaited<ReturnType<typeof scanHooks>>,
	now: Date,
): Verdict {
	if (entry === undefined) return { kind: "no-rule" };

	// A per-project entry with no known project keys cannot be measured at
	// all - `surveyStreams` skips computing `fresh` for exactly this case
	// (see its freshness loop), so `fresh` is `undefined` here, and there is
	// no walk this function could fall back to without silently reverting
	// to the machine-wide masking `perProjectFreshness` exists to prevent.
	// Checked before anything else: an entry this is true for has nothing
	// else worth consulting yet.
	if (isPerProject(entry) && events.projectKeys.length === 0) {
		return {
			kind: "unknown",
			detail: "this repo's project keys could not be determined",
		};
	}

	const verdict = computeVerdict(entry, fresh, events, hooks, now);

	// A stale symlink - a relocated checkout leaving `<old-key> -> <moved
	// checkout>` behind, say - makes `unreadable` true without changing
	// what the rest of the walk actually found. `unknown` is the safe
	// default against a false positive, but suppressing a `stopped` this
	// well-supported would hide exactly the alarm this feature exists to
	// raise - so a `stopped` survives, with the partial listing appended
	// rather than hidden. Anything else computed from a partial walk (an
	// unmeasured `stopped` is inherently conservative; `recording` or
	// `unknown` are not) still degrades to `unknown`, unchanged from before.
	if (fresh?.unreadable !== true) return verdict;
	if (verdict.kind === "stopped") {
		return {
			...verdict,
			detail: `${verdict.detail} (${outputLabel(entry)} could not be fully listed - the real gap may be worse)`,
		};
	}
	return {
		kind: "unknown",
		detail: `${outputLabel(entry)} could not be fully listed`,
	};
}

function computeVerdict(
	entry: StreamEntry,
	fresh: ReturnType<typeof outputFreshness> | undefined,
	events: Awaited<ReturnType<typeof scanEvents>>,
	hooks: Awaited<ReturnType<typeof scanHooks>>,
	now: Date,
): Verdict {
	const lastEvent = entry.events
		.map((prefix) => events.lastByPrefix[prefix] ?? "")
		.reduce((a, b) => (a > b ? a : b), "");

	// No output path: there is no downstream to compare against, so the rule
	// degrades to event recency compared against the trigger. Absence of a
	// directory is expected here.
	//
	// Checked before looking at freshness on purpose: outputFreshness
	// collapses "this stream writes no files by design" and "its output root
	// exists but is empty" into the same `{ mtime: null, unreadable: false }`,
	// and only `entry.output` tells those two states apart. That invariant
	// lives here, in the one caller that needs it, rather than in
	// `outputFreshness`'s return type.
	if (entry.output === null) {
		if (lastEvent === "") {
			return { kind: "unknown", detail: "no events recorded yet" };
		}
		// Events exist, but recency alone is not a rule - a real event from
		// months ago reads exactly like a healthy one from seconds ago with
		// no bound at all, and `now` is never consulted. ecosystem's real
		// failure shape: its trackers died on a real outage date, and the
		// event log still holds records up to that day months later.
		//
		// With no output to compare against, the trigger (this entry's own
		// hooks) is the only remaining axis - the same self-calibrating
		// shape as everywhere else in this design, with the event stream
		// standing in for output. If a hook has fired materially more
		// recently than the newest event landed, the trigger still runs but
		// events have stopped - the archivist/bursar failure shape again,
		// just with the event log playing output's part. No wall-clock
		// threshold, for the same reason the rest of this design rejects
		// one: see `toleranceFor`.
		let newestHook = "";
		let hookLast = "";
		for (const hook of entry.hooks) {
			const last = hooks.hooks[hook]?.last ?? "";
			if (last > hookLast) {
				hookLast = last;
				newestHook = hook;
			}
		}
		if (hookLast === "") {
			return {
				kind: "unknown",
				detail: "no hook records to compare against the event log",
			};
		}
		const gapMs = new Date(hookLast).getTime() - new Date(lastEvent).getTime();
		if (gapMs > toleranceFor(entry)) {
			return {
				kind: "stopped",
				detail: `${newestHook} fired ${hookLast.slice(0, 10)}, but the last event was ${lastEvent.slice(0, 10)}`,
			};
		}
		return {
			kind: "recording",
			detail: `last event ${lastEvent.slice(0, 10)}`,
		};
	}

	const outputAt = fresh?.mtime ?? null;
	// Only `writeHooks` counts as evidence of a write. A hook whose firing
	// does not reliably imply one - see `StreamEntry.writeHooks` - is not
	// evidence either way and must be excluded rather than merely
	// outnumbered: lineage's post-tool-use hook alone fires past
	// `STALL_THRESHOLD` within a handful of Bash calls, and bursar's own
	// session-start hook does the same across a handful of sessions, in
	// both cases while the real writer is healthy.
	const writeHooks = entry.writeHooks ?? [];
	const measurable = writeHooks.filter((h) => hooks.hooks[h] !== undefined);
	// See `clearsCadenceFloor`'s own docstring for the general contract.
	// Every `firedSince >= STALL_THRESHOLD && floorCleared` check below is
	// dead against the CURRENT `STREAMS` table: reaching any of them
	// requires `measurable.length > 0`, which requires `writeHooks`, and
	// the only two entries that set `writeGateHours` (`counsel`,
	// `cartographer`) are deliberately `writeHooks`-empty - so
	// `floorCleared` evaluates `true` on every path that actually consults
	// it today. Retained rather than removed: it is correct, and ready for
	// an entry that combines both fields. The live cadence protection today
	// is `toleranceFor`'s `writeGateHours` term instead, used by the two
	// fallback branches that do NOT go through this variable.
	const floorCleared = clearsCadenceFloor(entry, outputAt, now);

	if (outputAt === null) {
		if (lastEvent !== "") {
			// An entry with no reliable write hook cannot tell "its
			// conditional writer simply has not had anything to write yet"
			// from a genuine outage: curator with no memory store found,
			// echo with no watched file ever changed, counsel or
			// cartographer before their first gate elapses - in every one
			// of those cases the trigger firing is not evidence the writer
			// should have run. `writeHooks` being empty is exactly the
			// signal that this entry's trigger does not bound how long
			// "nothing yet" may legitimately last, the same reasoning
			// `writeHooks` already carries everywhere else in this
			// function. An entry WITH a write hook has no such excuse -
			// librarian-session-end IS the writer, so events firing with no
			// lesson ever produced is exactly what "stopped" means, and
			// softening that would hide the case this feature exists to
			// catch.
			if (writeHooks.length === 0) {
				return {
					kind: "unknown",
					detail: `events since ${lastEvent.slice(0, 10)}, but no output yet - cannot tell "nothing to write yet" from "broken"`,
				};
			}
			// A single firing is not evidence of a stall, gated on
			// `STALL_THRESHOLD` exactly like the archivist-shaped branch
			// just below - librarian's documented zero-candidate bail runs
			// librarian-session-end once, writes only its manifest
			// heartbeat, and still emits one `librarian.*` event; historian's
			// `transcript_unavailable` skip is the same shape. No `since`
			// threshold was ever seeded for this entry (`fresh.mtime` was
			// null, so the loop in `surveyStreams` that builds `since` skips
			// it), so `firedSince` counts every firing since inception - the
			// write hook must have fired past `STALL_THRESHOLD` with
			// nothing EVER produced before this reads `stopped`.
			for (const hook of measurable) {
				const record = hooks.hooks[hook];
				// See the `floorCleared` note above - dead on this path today.
				if (record.firedSince >= STALL_THRESHOLD && floorCleared) {
					return {
						kind: "stopped",
						detail: `${hook} fired ${record.firedSince} times with no output ever written to ${outputLabel(entry)}`,
					};
				}
			}
			return {
				kind: "unknown",
				detail: `events since ${lastEvent.slice(0, 10)}, but output not yet written and not enough hook firings yet to call it stopped`,
			};
		}
		// No output, and no event ever seen. Ordinarily that is a fresh
		// install and stays unknown - but an entry with no distinguishing
		// event prefix at all (archivist: its only emission,
		// onlooker.artifact.ready, is shared with counsel and scribe, so no
		// prefix can identify it alone) can never clear the branch above,
		// first run or genuine outage alike. Hook firings are the only
		// evidence left for that case, and firing well past the threshold is
		// real evidence of a stall rather than a default clean bill.
		if (entry.events.length === 0) {
			for (const hook of measurable) {
				const record = hooks.hooks[hook];
				// See the `floorCleared` note above - dead on this path today.
				if (record.firedSince >= STALL_THRESHOLD && floorCleared) {
					return {
						kind: "stopped",
						detail: `${hook} fired ${record.firedSince} times with no output ever written to ${outputLabel(entry)} and no event prefix to check instead`,
					};
				}
			}
		}
		return { kind: "unknown", detail: "no output and no events recorded yet" };
	}

	// Real output exists. An entry with no reliable write hook cannot use a
	// firing-count check at all - see `StreamEntry.writeHooks` - so judge on
	// whether events are outrunning the output instead: the two move
	// together within seconds when the writer is healthy, so a gap past
	// tolerance means events keep firing while the real output sits frozen.
	if (writeHooks.length === 0) {
		// A truncated or unreadable event scan clears `lastByPrefix` (see
		// `scanEvents`), so `lastEvent` reads exactly like "no events fired"
		// and falling through below would default to `recording` on a
		// source this module could not actually read. The firing-count path
		// already refuses to do this - `measurable.length === 0` reads
		// `unknown` when hook-health itself is unreadable, just below - this
		// is the same promise for the event axis.
		if (events.missing) {
			return {
				kind: "unknown",
				detail: `output last changed ${outputAt.slice(0, 10)}, but the event log could not be read to compare`,
			};
		}
		if (lastEvent === "") {
			// The log was read fine - `events.missing` is already false by
			// this point - and the prefix simply never appeared in it. That
			// is not evidence the stream is healthy, any more than a
			// truncated log is: `recording` here would contradict the
			// `events.missing` check two lines above for the exact same
			// reason. lineage stopping both its writes and its emissions in
			// January, with the log since rotated past that point, is this
			// shape: `outputAt` still holds January's mtime, but nothing is
			// left to compare it against.
			return {
				kind: "unknown",
				detail: `output last changed ${outputAt.slice(0, 10)}, no events recorded to compare`,
			};
		}
		// A gated writer's events legitimately outrun its output by up to
		// its own write-gate interval - see `toleranceFor`. Without this,
		// cartographer reads `stopped` after every ordinary 24h gap between
		// audits, and counsel roughly 167 hours out of every 168.
		const gapMs = new Date(lastEvent).getTime() - new Date(outputAt).getTime();
		if (gapMs > toleranceFor(entry)) {
			return {
				kind: "stopped",
				detail: `events since ${lastEvent.slice(0, 10)}, but ${outputLabel(entry)} last changed on ${outputAt.slice(0, 10)}`,
			};
		}
		return {
			kind: "recording",
			detail: `output last changed ${outputAt.slice(0, 10)}`,
		};
	}

	// Output but no write hook in hook-health: report the gap, verdict
	// unknown. Never healthy - a thing we could not measure does not get a
	// clean bill.
	if (measurable.length === 0) {
		return {
			kind: "unknown",
			detail: `output last changed ${outputAt.slice(0, 10)}, no hook records to compare`,
		};
	}

	for (const hook of measurable) {
		const record = hooks.hooks[hook];
		// See the `floorCleared` note above - dead on this path today.
		if (record.firedSince >= STALL_THRESHOLD && floorCleared) {
			return {
				kind: "stopped",
				detail: `${hook} fired ${record.firedSince} times since ${outputLabel(entry)} last changed on ${outputAt.slice(0, 10)}`,
			};
		}
	}

	return {
		kind: "recording",
		detail: `output last changed ${outputAt.slice(0, 10)}`,
	};
}
