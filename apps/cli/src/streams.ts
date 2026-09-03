import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlookerDir } from "./config";

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
	},
	{
		plugin: "assayer",
		output: "assayer",
		events: ["assayer"],
		hooks: ["assayer-stop"],
	},
	{
		plugin: "bursar",
		// NOT `bursar/sessions`. See the interface docstring.
		output: join("bursar", "projects"),
		events: ["bursar"],
		hooks: ["bursar-session-start", "bursar-session-end"],
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
		hooks: ["counsel-session-start"],
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
		hooks: ["curator-session-start"],
	},
	{
		plugin: "echo",
		output: "echo",
		events: ["echo"],
		hooks: ["echo-stop-gate"],
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
		hooks: [
			"governor-post-tool-use",
			"governor-pre-tool-use",
			"governor-session-start",
			"governor-stop",
		],
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
	},
	{
		plugin: "lineage",
		output: "lineage",
		events: ["lineage"],
		hooks: ["lineage-post-tool-use"],
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
		hooks: ["scribe-capture", "scribe-session-start", "scribe-stop"],
	},
	{
		plugin: "tribunal",
		output: "tribunal",
		events: ["tribunal"],
		hooks: ["tribunal-stop-gate"],
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
			if (ignore.includes(name)) continue;
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

/** Newest mtime anywhere beneath a stream's declared output path. */
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

		const dir = join(keyPath, entry.subpath);
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

	return finalize(newestMs, unreadable);
}

/**
 * The output path as a user-facing string, for `doctor`'s detail lines.
 *
 * `entry.output` alone is misleading once `subpath` is set: `librarian` is
 * not `librarian/lessons`, it is `librarian/<any project key>/lessons`. `*`
 * stands in for "whichever key," the same wildcard a user would type at a
 * shell prompt to glob it.
 */
export function outputLabel(entry: StreamEntry): string {
	if (entry.output === null) return "(none)";
	if (entry.subpath === undefined) return entry.output;
	return join(entry.output, "*", entry.subpath);
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
