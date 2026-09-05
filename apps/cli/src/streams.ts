import { lstatSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { onlookerDir } from "./config";
import { type Enablement, findUp, readEnablement } from "./enablement";
import type { EventScan, HookScan } from "./eventlog";
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
 * How many opportunities - sessions of this repo's that ran the hook
 * machinery, see `opportunitiesSince` - may pass with no sign of life from a
 * stream before its silence reads as a stall rather than as quiet.
 *
 * The design's one new arbitrary number, recorded as such exactly like
 * `STALL_THRESHOLD` and `CADENCE_FLOOR_MULTIPLIER` - but read off measured
 * data rather than picked and justified afterward, which is what went wrong
 * with the wall-clock constant it replaces.
 *
 * Floor 1, ceiling 6. Over the six opportunities this repo had between
 * 2026-08-30 and 2026-09-05: bursar fired in 6 of 6, and lineage, inspector
 * and assayer in 5 of 6 - so a healthy stream's longest silence was one
 * opportunity. Six opportunities have elapsed since the 2026-08-07 outage,
 * so five reports counsel `stopped` today rather than `unknown`. Five also
 * matches `STALL_THRESHOLD` for the same underlying reason: any stream may
 * lag its trigger by about one opportunity, and five clears that with room.
 *
 * The sample is six opportunities wide, because every enabled plugin's
 * hook-health history begins 2026-08-30. `onlooker-run` tracks rechecking
 * this once the enabled set has roughly a month of history.
 */
export const SESSION_STALL_THRESHOLD = 5;

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
	 * The subset of `hooks` whose firing is reliable evidence that this
	 * entry's real, analytical work happened - not merely that its trigger
	 * ran. Two different things count as "real work" depending on `output`:
	 *
	 * For an entry with a real `output` path, this means the firing implies
	 * output should have been WRITTEN - the only hooks `judge()`'s
	 * firing-count stall check counts from. Undefined or empty when no hook
	 * on the entry is a reliable write signal, whether because one hook name
	 * serves several matchers and only some of them write (lineage), or
	 * because the writer itself is gated or conditional so its hook fires far
	 * more than it writes (counsel, cartographer, curator, governor, echo,
	 * tribunal). `judge()` falls back to comparing event recency against
	 * output recency for those entries instead of counting firings - see
	 * `EVENT_OUTPUT_TOLERANCE_MS`.
	 *
	 * For an `output: null` entry, there is no output path to fall back to
	 * comparing against - events are the only downstream signal such an
	 * entry has at all - so this means the firing implies an event should
	 * have been EMITTED. Undefined or empty means this entry's own review
	 * found no hook that qualifies (warden: `warden-pre-tool-use` only fires
	 * when the content gate is already closed, `warden-post-tool-use` only
	 * fires on a positive threat detection, both far rarer than the hook
	 * itself running), and `judge()` reports `unknown` rather than trusting
	 * every hook's raw firing the way an unreviewed entry once did - see the
	 * `entry.output === null` branch of `computeVerdict`.
	 *
	 * Present, and a strict subset of `hooks`, everywhere a hook genuinely
	 * implies real work by either definition. See each entry below for which
	 * hook and why - and, for a hook whose script was actually read rather
	 * than inferred from its name, the bail sites that justified the call.
	 */
	writeHooks?: readonly string[];
	/**
	 * The event types whose emission is reliable evidence that this entry's
	 * analytical output was WRITTEN - the exact mirror of `writeHooks`, one
	 * level down.
	 *
	 * Full `event_type` values, never prefixes, because conditionality is a
	 * property of the type rather than of the plugin:
	 * `governor.session.complete` fires on every session and implies nothing
	 * about output, while `governor.gate.checked` fires only when a gate is
	 * checked. `events` above stays prefix-keyed, because it answers the
	 * different question of whether the plugin ran at all, and there the
	 * masking is exactly what you want.
	 *
	 * Undefined or empty means no event this entry emits implies a write.
	 * That is the conservative direction and the common one: scribe emits
	 * per prompt from `scribe-capture` while `scribe-stop` writes only when
	 * there is something to distill, and `curator.scan.complete` fires on
	 * every scan whether or not any finding changed. Together with
	 * `writeHooks` this decides whether `computeVerdict` may ask the write
	 * question at all - see its `lastWrite`.
	 *
	 * Every value here was read out of the plugin's source, not inferred
	 * from its name. Each entry below records the file and line.
	 */
	writeEvents?: readonly string[];
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
		// NOT archivist-inject, which runs at SessionStart and only reads -
		// that part still holds. But archivist-extract itself is NOT a
		// reliable write signal either, on a closer read than the original
		// `writeHooks` call: after hook_health_register (archivist-
		// extract.sh:39) it bails without writing at SIX ordinary, ROUTINE
		// sites - no git context (:103-106), no transcript (:108-111), no
		// `claude` CLI (:113-116), empty transcript tail (:135-138), empty
		// LLM response (:195-198), extraction output not valid JSON
		// (:203-206) - and even past all six, a session with nothing
		// extraction-worthy produces zero decisions/dead_ends/open_questions
		// and reaches the end having written nothing (WRITE_COUNT stays 0,
		// so the `WRITE_COUNT -gt 0` guard at :269 skips the aggregate write
		// and the `onlooker.artifact.ready` emission both). None of these
		// are exceptional - most sessions do not produce durable memory.
		// With no writeHooks, judge() falls back to comparing event recency
		// against output recency instead - which for archivist means it can
		// only ever read `unknown`, never `recording` or `stopped`: its
		// `events: []` above (shared-event-prefix problem) leaves no event
		// axis to compare output against once firing counts are untrusted.
		// That is a real loss of signal, not a bug - archivist genuinely has
		// no remaining axis this design can measure, and `unknown` is the
		// honest answer rather than a fabricated one.
		//
		// `archivist/<key>/` per project - verified on disk (first-level
		// children are 12-hex project keys). See `perProject`'s docstring.
		perProject: true,
	},
	{
		plugin: "assayer",
		output: "assayer",
		events: ["assayer"],
		hooks: ["assayer-stop"],
		// NOT writeHooks: ["assayer-stop"], despite being its only hook.
		// assayer-stop.sh registers hook health at line 35, then has SEVEN
		// bail sites before it ever writes an audit - no repo root (:94), no
		// project key (:99), no `claude` on PATH (:101), no `jq` on PATH
		// (:102), no transcript (:104), empty final assistant message
		// (:112), empty `claude -p` response (:140) - all ordinary, not
		// exceptional. Measured on a live machine: 395 assayer-stop firings
		// against 39 audit files, roughly 10:1. At STALL_THRESHOLD = 5,
		// assayer crossed into `stopped` within hours of any quiet stretch -
		// the lineage false positive again, on a plugin this repo enables.
		// judge() falls back to comparing event recency against output
		// recency instead: assayer emits real, uniquely-prefixed events per
		// audit (`assayer.audit.*`, `assayer.claim.*`), so - unlike
		// archivist below - that fallback still has a working event axis.
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
		// Of the four, only compass-bash-gate can ever emit a `compass.*`
		// event - compass-session-start, compass-pre-tool-use, and compass-
		// record-write each read straight through to their per-session gate
		// state with no `compass_emit_event` call anywhere in any of the
		// three. compass-bash-gate fires on every Bash call but exits
		// immediately (compass-bash-gate.sh:94) unless the command matches a
		// write pattern (rm/mv/cp/redirect/git commit/sed -i/etc.,
		// compass-bash-gate.sh:58-93); once it decides a command IS a write,
		// compass_run_gate emits on every path through it, including its own
		// skip branches (compass-gate.sh's `compass.check.skipped` calls) -
		// so a write-pattern match reliably emits, even though most Bash
		// calls are read-only and never reach that far. The coarsest signal
		// this table has for an `output: null` entry, but the only one
		// compass has at all.
		writeHooks: ["compass-bash-gate"],
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
		// Four of the fourteen never call an emit function that touches any
		// of the five prefixes above, for any input, ever - read in full,
		// not inferred:
		//   - tool-sequence-tracker (every tool call): pure turn-state
		//     bookkeeping, no onlooker_append_event/session_tracker_emit call
		//     anywhere in the script.
		//   - session-duration-tracker (every prompt): only builds
		//     UserPromptSubmit additionalContext; same absence.
		//   - pre-compact-tracker (every PreCompact): only records local
		//     pre-compact state and approves; same absence.
		//   - prompt-rule-injector (every prompt): emits real events, but
		//     only `prompt_rule.matched`/`prompt_rule.applied` - neither is
		//     one of this entry's five tracked prefixes, so its firing is
		//     irrelevant signal here regardless of how often it emits.
		// A fifth, memory-recall-tracker (every SessionStart), has a real
		// `memory.recalled` emit path but skips it on FOUR routine
		// conditions, not one: `source == "compact"` (compaction reloads the
		// same memories, so re-emitting would double-count), no resolvable
		// project key, no per-project memory store directory at all (the
		// default state for most repos, which never accumulate typed
		// memory), or a memory store with zero validly-typed `.md` files.
		// The remaining nine each have at most one narrow, structurally-
		// guarded skip (a matcher already scopes out the mismatched-tool-
		// name case for agent-spawn-tracker and skill-usage-tracker; a
		// missing session_id is the only bail for the rest) and were kept.
		writeHooks: [
			"session-start-tracker",
			"session-end-tracker",
			"turn-tracker",
			"tool-history-tracker",
			"skill-usage-tracker",
			"agent-spawn-tracker",
			"task-tracker",
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
		//
		// A known, accepted consequence of that: governor's two axes are
		// scoped differently. `outputAt` comes from the machine-wide walk
		// above; `lastEvent` and the write-hook firing count both come from
		// THIS repo's own sessions only, the same session scoping every
		// other entry gets (see `scanEvents`'s `sessionIds` and
		// `surveyStreams`'s `scanHooks` call). Two repos on one machine, one
		// with governor silent for months and the other writing to the
		// shared ledger daily, would let the busy sibling's writes read as
		// evidence for the silent repo - the exact busy-sibling masking
		// `perProjectFreshness` exists to prevent elsewhere, left open here
		// on purpose because there is no key to scope the ledger walk by at
		// all. Not fixable by having governor abstain either: its event and
		// hook axes ARE correctly scoped and ARE real evidence for this
		// repo specifically, so reporting `unknown` unconditionally would
		// throw away signal this table can actually measure. Documented
		// rather than papered over - a future entry with the same shape
		// should make the same call, deliberately, not by accident.
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
		//
		// historian-session-end.sh itself was read in full for the same
		// bail-after-registration risk assayer/archivist/librarian turned
		// out to have. It bails without indexing at: no project key
		// (:79), storage init failure (:81), no transcript (:109-112,
		// emits a real `historian.indexing.complete{outcome:skipped}`
		// first), and transcript shorter than
		// `min_transcript_chars_to_index` - 1200 chars by default
		// (:126-129, same emit-then-skip shape). Kept, not removed: unlike
		// assayer/archivist/librarian, there is exactly one plausibly-
		// routine bail (`too_short`), not several stacked ones, and once
		// `historian_storage_append_chunk` actually runs it appends
		// directly - no further LLM-classifier or durability-filter stage
		// downstream that could silently drop everything the way
		// librarian's does. No firing-count/output ratio measured on this
		// machine (zero historian-session-end firings recorded), so this
		// is a source-only read, not an empirical confirmation - worth
		// revisiting if a live ratio ever surfaces a real problem.
		writeHooks: ["historian-session-end"],
	},
	{
		// Writes no directory of its own; its trace is the shared event log.
		plugin: "inspector",
		output: null,
		events: ["inspector"],
		hooks: ["inspector-post-write"],
		// Its matcher already scopes it to Write/Edit/MultiEdit only
		// (inspector's hooks.json), so the tool-name/missing-target guards
		// inside the script are dead code, not a routine skip. Past those,
		// every path emits: not-in-repo, an excluded path, and no-
		// extension-match each call inspector_emit_whole_file_skipped
		// (inspector-run.sh:308), and a matched check set runs through
		// inspector_run, whose own loop emits per check and always finishes
		// with inspector.run.completed. Its only firing is inspector-post-
		// write, so it is both its only hook and its only reliable one.
		writeHooks: ["inspector-post-write"],
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
		// NOT librarian-session-start, which writes nothing - that part
		// still holds. But librarian-session-end is not reliable either: it
		// is a multi-stage pipeline with FOUR session-level bail sites
		// before any candidate is even considered - no project key
		// (:102), storage init failure (:105), zero new archivist artifacts
		// since the last scan (:145-159, common precisely because archivist
		// itself frequently produces nothing per its own entry above), and
		// a 1-second SessionEnd time budget exceeded before classification
		// starts (:196-210) - and even a session that clears all four still
		// runs each surviving artifact through a durability filter, an LLM
		// classifier, a tombstone/duplicate check, and (separately) a lesson
		// transform with its own pregate and LLM call, any of which can
		// decline without writing to `lessons/`. This is the same shape as
		// assayer and archivist, one layer deeper. With no writeHooks,
		// judge() falls back to comparing event recency against output
		// recency instead - which means librarian's own headline case, the
		// empty lesson pool this table exists to catch, is now
		// `unknown`-grade detection, not `stopped`-grade: a session firing
		// with `lessons/` never created reads `unknown` ("cannot tell
		// 'nothing to write yet' from 'broken'"), never a confident
		// `stopped`. Still surfaced - `unknown` exits 1, same as `stopped`
		// does - just without the specific write-hook evidence that would
		// let this table say so with certainty. A real, accepted trade, not
		// a silent regression.
	},
	{
		plugin: "lineage",
		output: "lineage",
		events: ["lineage"],
		// One hook name, four matchers - Edit, Write, MultiEdit, and Bash
		// (lineage's own hooks.json). "Bash outruns Edit roughly 30:1"
		// (hooks.json:147), so this hook's firing count alone reads a
		// perfectly healthy lineage as stalled after about five Bash calls
		// with no edit. No writeHooks: this hook's firing is evidence the
		// plugin ran, nothing more, and the write question is answered by
		// `writeEvents` below instead.
		hooks: ["lineage-post-tool-use"],
		// `lineage.change.recorded` is emitted at the ledger write site
		// itself (`lineage-post-tool-use.sh:261` and `:340`, both immediately
		// after the record is appended), so the emission and the write are
		// one code path with no bail between them - its silence IS the writes
		// stopping. This is what lets a frozen lineage be caught while
		// `lineage-post-tool-use` keeps firing: 2678 firings in this repo's
		// sessions since 2026-08-30, against a ledger that had not moved.
		//
		// Set here rather than with the rest of the table's `writeEvents`
		// because `computeVerdict`'s own regression test - the false negative
		// this design must not lose - is unsatisfiable without it. The value
		// is the design's one pre-verified assignment, not a guess.
		writeEvents: ["lineage.change.recorded"],
		// `lineage/<key>/` per project - verified on disk.
		perProject: true,
	},
	{
		plugin: "scribe",
		output: "scribe",
		// `sessions/<session_id>.json` (scribe-capture.sh) is a heartbeat
		// written on the first prompt of every session; the real output is
		// `<key>/<date>-<session>.md`, written only by scribe-stop. Both are
		// direct children of `scribe/`, so `subpath` cannot separate them.
		//
		// `ignore` is unreachable for scribe's own VERDICT. scribe is
		// `perProject` with no `subpath` of its own, so `judge()` walks it
		// through `perProjectFreshness`, which iterates `projectKeys`
		// directly (`walkKeys`) rather than `readdirSync`-ing `scribe/` and
		// filtering the results afterward - `scribe/sessions` is a SIBLING
		// of the per-key directories, never itself a project key (and could
		// not be even by accident: `scanEvents` only accepts 12-hex project
		// keys), so it is never enumerated as a candidate key on that path,
		// `ignore` or not. Also unreachable on the footer's path -
		// `anyDataFreshness` walks the raw root with no `ignore` argument at
		// all, by design (see its own comment). The one place this actually
		// applies is `outputFreshness`'s flat branch, called directly in
		// this file's own unit tests but never by anything in the survey's
		// real flow for a `perProject` entry like this one. Kept as
		// documentation of scribe's real layout, and because
		// `outputFreshness` is an exported, independently-used primitive -
		// but do not assume it does anything for scribe's verdict.
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
		// No writeHooks, deliberately: none of the three ever reliably
		// emits. warden-session-start (every SessionStart) only creates the
		// gate directory - no warden_emit_event call anywhere in the
		// script. warden-pre-tool-use (every Write/Edit/MultiEdit/Bash)
		// only emits warden.gate.blocked when the gate is ALREADY closed
		// (warden-pre-tool-use.sh:50-52), which requires a threat to have
		// been detected first - rare relative to how often the hook itself
		// runs. warden-post-tool-use (every WebFetch/Read) only emits
		// warden.threat.detected on a POSITIVE scan hit (warden-post-tool-
		// use.sh:138-140) - most fetched or read content is benign. On a
		// machine that has not been blocked recently, this is not a
		// hypothetical gap: this repo's own event log holds tool activity
		// continuing well past the last recorded `warden.*` event
		// (2026-08-01T21:13:33Z). With no hook reliably implying an
		// emission, judge() reports `unknown` rather than trusting every
		// hook's raw firing - see `computeVerdict`'s `entry.output === null`
		// branch.
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
 * How many opportunities this repo has had since `iso` - sessions of its own
 * that also ran the hook machinery.
 *
 * The denominator every stall verdict is measured against, and deliberately
 * NOT a count of `session.start` events. `session.start` includes subagent
 * sessions, which run no hooks and so were never a chance for any plugin to
 * act: 240 of this repo's 246 sessions in the measured window were exactly
 * that, including one block of 91 consecutive sessions across 27 hours in
 * which no hook fired anywhere. Counted raw, every plugin on the machine -
 * ecosystem across all 11,422 sessions included - shows a longest silent run
 * of exactly 91, because 91 belongs to the session stream rather than to any
 * plugin. A threshold would have to sit above 91 to avoid false alarms while
 * only 35 sessions elapsed across the three and a half weeks the real outage
 * went unnoticed; no value satisfies both. Counting opportunities instead
 * drops that floor to 1.
 *
 * Epoch comparison, not lexical: `iso` can arrive from either log, and the
 * two write different precision. See `scanHooks`'s `since` comment for the
 * full trap.
 */
export function opportunitiesSince(
	events: Pick<EventScan, "sessionStarts">,
	hooks: Pick<HookScan, "sessionsWithRecords">,
	iso: string,
): number {
	const ran = new Set(hooks.sessionsWithRecords);
	const cutoff = new Date(iso).getTime();
	let count = 0;
	for (const session of Object.keys(events.sessionStarts)) {
		if (!ran.has(session)) continue;
		if (new Date(events.sessionStarts[session]).getTime() > cutoff) count++;
	}
	return count;
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
	 * Injectable clock. No verdict consults it today - the rule counts
	 * opportunities, not elapsed time, and the wall-clock freshness limit it
	 * replaced is gone - but the option stays: detail-string formatting needs
	 * a reference instant to decide whether a stamp must carry the time as
	 * well as the date, and every caller in the suite already threads one.
	 * Removing it would churn every fixture for a field about to be read
	 * again.
	 */
	now?: Date;
}): Promise<StreamSurvey> {
	const env = opts.env ?? process.env;
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
		verdict: judge(known.get(plugin), freshness.get(plugin), events, hooks),
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
 * The gap the old rule allowed between two triggers' timestamps before it
 * read as a stall, given `entry`'s own write gate (if any).
 *
 * Both callers are gone. The two branches this served - the `output: null`
 * one comparing a hook's `last` firing against the newest event, and the
 * no-`writeHooks` fallback comparing the newest event against the output's
 * own mtime - were the timestamp-gap half of the pair of questions the
 * unified rule replaced with an opportunity count. Nothing in this file
 * measures a gap in milliseconds anymore.
 *
 * Retained, unreferenced, pending the decision on whether
 * `StreamEntry.writeGateHours` still has a consumer at all: this and
 * `clearsCadenceFloor` are its only two readers, and both are now idle.
 * Exported only so it survives `noUnusedLocals` while that decision is
 * outstanding - not because anything outside this module should call it.
 */
export function toleranceFor(entry: StreamEntry): number {
	return entry.writeGateHours === undefined
		? EVENT_OUTPUT_TOLERANCE_MS
		: Math.max(
				EVENT_OUTPUT_TOLERANCE_MS,
				CADENCE_FLOOR_MULTIPLIER * entry.writeGateHours * 60 * 60 * 1000,
			);
}

/**
 * The newer of two ISO timestamps, `""` meaning absent.
 *
 * Epoch-compared rather than lexical, because callers mix timestamps from
 * both logs and the two write different precision - see `scanHooks`'s `since`
 * comment for the full trap.
 */
function newerOf(a: string, b: string): string {
	if (a === "") return b;
	if (b === "") return a;
	return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

/** Date for a detail string. Task 8 widens this to include the time when the gap is under a day. */
function stamp(iso: string): string {
	return iso.slice(0, 10);
}

function judge(
	entry: StreamEntry | undefined,
	fresh: ReturnType<typeof outputFreshness> | undefined,
	events: Awaited<ReturnType<typeof scanEvents>>,
	hooks: Awaited<ReturnType<typeof scanHooks>>,
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

	const verdict = computeVerdict(entry, fresh, events, hooks);

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

/**
 * The whole rule, as two quantities and one denominator.
 *
 * `alive` asks whether the plugin ran at all; `lastWrite` asks whether its
 * analytical output moved, and exists only where this table records a signal
 * that could answer it. Everything is counted in opportunities - see
 * `opportunitiesSince` - and nothing consults wall time. The four branches
 * this replaced were four answers to those same two questions, each with its
 * own counter, and they disagreed: a conditional writer's quiet week read
 * `stopped` while lineage's ledger frozen since January read `recording`.
 */
function computeVerdict(
	entry: StreamEntry,
	fresh: ReturnType<typeof outputFreshness> | undefined,
	events: Awaited<ReturnType<typeof scanEvents>>,
	hooks: Awaited<ReturnType<typeof scanHooks>>,
): Verdict {
	// Unreadable sources never yield a clean bill - the promise this module
	// makes everywhere. Checked before anything else so no branch below can
	// certify a stream off evidence we could not actually read.
	if (events.missing) {
		return {
			kind: "unknown",
			detail: "the event log could not be read",
		};
	}

	// --- alive: did this plugin run at all? -----------------------------
	// Both axes, because neither alone covers the table. Several entries
	// have no unconditional event (counsel emits only when it writes the
	// brief; warden only on a blocked gate or a detected threat), and
	// archivist has no distinguishing prefix at all - its only emission,
	// onlooker.artifact.ready, is shared. Hooks cover all of them, because
	// hook-health's EXIT trap registers a firing before any bail path.
	let lastLife = "";
	for (const prefix of entry.events) {
		lastLife = newerOf(lastLife, events.lastByPrefix[prefix] ?? "");
	}
	for (const hook of entry.hooks) {
		lastLife = newerOf(lastLife, hooks.hooks[hook]?.last ?? "");
	}

	// --- lastWrite: did the downstream move, where that is even askable? -
	// Defined only where a write signal exists. Where none does, output
	// mtime is NOT a substitute: a week-old scribe `.md` means nothing was
	// worth distilling, and treating its age as evidence is the false alarm
	// this whole change exists to remove.
	const writeHooks = entry.writeHooks ?? [];
	const writeEvents = entry.writeEvents ?? [];

	let lastWrite: string | undefined;
	if (entry.output === null) {
		// An `output: null` stream writes no files by design, so its EVENTS
		// are its downstream - the substitution the old `output === null`
		// branch made, preserved here rather than lost to the unified rule.
		// Without it ecosystem's real failure shape goes undetected: its
		// trackers died on the outage date while its hooks kept firing, and
		// a liveness axis that counted those hooks would read `recording`
		// forever.
		//
		// So for these entries the axes SPLIT: `alive` is hooks only (below
		// it is recomputed to exclude events), and events play output's
		// part here. `writeHooks` gates it for the same reason it always
		// did - warden's hooks fire on every tool call and emit only on a
		// blocked gate or a detected threat, so without the gate a healthy
		// warden reads stopped the moment routine activity outruns its rare
		// emissions.
		if (writeHooks.length > 0) {
			lastWrite = "";
			for (const prefix of entry.events) {
				lastWrite = newerOf(lastWrite, events.lastByPrefix[prefix] ?? "");
			}
		}
	} else if (writeHooks.length > 0 || writeEvents.length > 0) {
		lastWrite = fresh?.mtime ?? "";
		for (const type of writeEvents) {
			lastWrite = newerOf(lastWrite, events.lastByType[type] ?? "");
		}
		// A write hook's own last firing is not a write - only how many
		// opportunities have passed since the last known write is evidence,
		// and that is what the stall check below consumes. Deliberately not
		// folded in here.
	}

	// For an `output: null` entry the event axis is the downstream being
	// judged, so it cannot also serve as proof of life - that would compare
	// a signal against itself and never report anything.
	if (entry.output === null) {
		lastLife = "";
		for (const hook of entry.hooks) {
			lastLife = newerOf(lastLife, hooks.hooks[hook]?.last ?? "");
		}
	}

	// --- the denominator ------------------------------------------------
	// Opportunities this repo has had at all, and the width of the window
	// every count below is read against. Nothing can be judged against a
	// window narrower than the rule's own threshold: a plugin enabled an
	// hour ago, a repo nobody has opened in a month, and a machine whose
	// whole hook system has stopped all arrive here with too few chances for
	// any silence to mean anything, and `unknown` is the only true answer to
	// each. This is the guard that REPLACES the wall clock rather than
	// merely deleting it - a 14-day limit called every stream dead across
	// the three weeks this repo ran no sessions at all, when in truth
	// nothing had been asked of any of them.
	//
	// The epoch as a cutoff, so this counts every opportunity ever seen.
	const window = opportunitiesSince(events, hooks, "1970-01-01T00:00:00.000Z");
	if (window < SESSION_STALL_THRESHOLD) {
		return {
			kind: "unknown",
			detail:
				lastLife === ""
					? `no sign of life yet, and only ${window} sessions to judge from`
					: `last sign of life ${stamp(lastLife)}, and only ${window} sessions to judge from`,
		};
	}

	if (lastLife === "") {
		// Opportunities have passed - enough of them - with no event and no
		// hook firing at all. Nothing distinguishes a fresh enable from a
		// broken one except that count, and it has been met.
		return {
			kind: "stopped",
			detail: `no events and no hook firings across ${window} sessions`,
		};
	}

	const sinceLife = opportunitiesSince(events, hooks, lastLife);
	if (sinceLife >= SESSION_STALL_THRESHOLD) {
		return {
			kind: "stopped",
			detail: `last sign of life ${stamp(lastLife)}, ${sinceLife} sessions ago`,
		};
	}

	// Alive. Whether it should also have WRITTEN is a separate question, and
	// only askable where the table records a signal for it.
	if (lastWrite === undefined) {
		return {
			kind: "recording",
			detail: `last sign of life ${stamp(lastLife)}`,
		};
	}

	if (lastWrite === "") {
		return {
			kind: "unknown",
			detail: `alive since ${stamp(lastLife)}, but no output written yet`,
		};
	}

	const sinceWrite = opportunitiesSince(events, hooks, lastWrite);
	if (sinceWrite >= SESSION_STALL_THRESHOLD) {
		return {
			kind: "stopped",
			detail: `${outputLabel(entry)} last changed ${stamp(lastWrite)}, ${sinceWrite} sessions ago, while the stream kept running`,
		};
	}

	return {
		kind: "recording",
		detail: `${outputLabel(entry)} last changed ${stamp(lastWrite)}`,
	};
}

/**
 * Column the detail text starts in, so every verdict reads down one edge.
 *
 * Wide enough that the longest real plugin name in `STREAMS` -
 * `cartographer`, 12 characters - still leaves a separating space before its
 * label. A tighter column left `cartographer` and its label running
 * together with none at all: `padEnd`'s target and the string's own length
 * matched exactly, so `padEnd` had nothing to add. The `doctorLines`
 * `describe` block pins this on `cartographer` by name, so the next plugin
 * name that reaches this width fails loudly instead of silently regressing.
 */
const DETAIL_COLUMN = 15;

function label(verdict: Verdict): string {
	switch (verdict.kind) {
		case "recording":
			return "recording";
		// Upper case earns its shout: this is the one line someone scanning
		// the output has to catch, and it is surrounded by lower-case rows.
		case "stopped":
			return "STOPPED";
		case "unknown":
			return "unknown";
		case "no-rule":
			return "no rule";
	}
}

function detail(verdict: Verdict): string {
	return verdict.kind === "no-rule"
		? "this CLI has no health rule for it"
		: verdict.detail;
}

export function doctorLines(survey: StreamSurvey): string[] {
	const lines: string[] = [];

	if (survey.enablement.kind === "unknown") {
		lines.push(`Expected: unknown - ${survey.enablement.reason}`);
	} else {
		const count = survey.enablement.plugins.length;
		// This machine's own footer is routinely two keys, not one - one
		// current, one partly historical, both legitimate - so this pluralizes
		// exactly like the plugin count just above it rather than assuming a
		// single key.
		const keys =
			survey.projectKeys.length > 0
				? ` - key${survey.projectKeys.length === 1 ? "" : "s"} ${survey.projectKeys.join(", ")}`
				: "";
		lines.push(
			`Expected: ${count} plugin${count === 1 ? "" : "s"} enabled from onlooker-community${keys}`,
		);
	}

	// Sorted here as well as in readEnablement: this renderer is exported and
	// a caller may hand it verdicts assembled some other way.
	const sorted = [...survey.verdicts].sort((a, b) =>
		a.plugin.localeCompare(b.plugin),
	);
	if (sorted.length > 0) lines.push("");
	for (const { plugin, verdict } of sorted) {
		const left = `  ${plugin.padEnd(DETAIL_COLUMN - 2)}${label(verdict).padEnd(11)}`;
		lines.push(`${left}${detail(verdict)}`);
	}

	if (survey.footer.length > 0) {
		lines.push("");
		lines.push("Not enabled here, but holding data on this machine:");
		for (const { plugin, detail: text } of [...survey.footer].sort((a, b) =>
			a.plugin.localeCompare(b.plugin),
		)) {
			lines.push(`  ${plugin.padEnd(DETAIL_COLUMN - 2)}${text}`);
		}
	}

	if (survey.faults.length > 0) {
		lines.push("");
		for (const fault of survey.faults) lines.push(`Fault:    ${fault}`);
	}

	return lines;
}

/**
 * 0 when everything enabled is recording, 1 otherwise.
 *
 * `cli.ts`'s existing convention: 1 means stop and go look, 2 means a retry
 * may fix it. Nothing here is transient - a stopped stream and an unreadable
 * log both need a person - so 2 is never returned.
 *
 * An unknown expected-set is also 1, and so is any individual `unknown` or
 * `no-rule` verdict. Not knowing what should be running, not knowing
 * whether a given stream is healthy, and having no health rule for an
 * enabled plugin at all are each precisely the state this command exists to
 * surface - exiting 0 on any of them would let a hook or CI job treat an
 * unconfigured, unmeasurable, or unrecognized-plugin machine as a healthy
 * one. `STREAMS`'s own docstring anticipates the vocabulary growing without
 * notice, which makes `no-rule` the expected steady state after any
 * marketplace addition, not a rare edge case worth softening.
 */
export function exitCodeFor(survey: StreamSurvey): number {
	if (survey.enablement.kind === "unknown") return 1;
	if (survey.faults.length > 0) return 1;
	return survey.verdicts.some(
		(v) =>
			v.verdict.kind === "stopped" ||
			v.verdict.kind === "unknown" ||
			v.verdict.kind === "no-rule",
	)
		? 1
		: 0;
}
