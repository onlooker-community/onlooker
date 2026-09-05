import { lstatSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { onlookerDir } from "./config";
import { type Enablement, findUp, readEnablement } from "./enablement";
import type { EventScan, HookScan } from "./eventlog";
import { scanEvents, scanHooks } from "./eventlog";

/**
 * How many opportunities - sessions of this repo's that ran the hook
 * machinery, see `opportunitiesSince` - may pass with no sign of life from a
 * stream before its silence reads as a stall rather than as quiet.
 *
 * The design's only arbitrary number, and now recorded as arbitrary in a
 * stronger sense than before: **there is no measured floor above it.** The
 * value is not justified by a healthy stream's longest silence. It is
 * justified by `firesEverySession`, which bounds WHO liveness may accuse so
 * that a wrong count cannot reach a healthy entry in the first place.
 *
 * What the first measurement said, and why it was wrong. This docstring
 * used to read "Floor 1, ceiling 6. Over the six opportunities this repo had
 * between 2026-08-30 and 2026-09-05: bursar fired in 6 of 6, and lineage,
 * inspector and assayer in 5 of 6." Re-measured over the SAME window after
 * the implementation sessions ran: **31 opportunities**, in which bursar
 * fired in 13, lineage in 6, inspector in 6 and assayer in 5. The numerators
 * barely moved; the denominator grew fivefold, because parallel-agent waves
 * manufacture opportunities in which most triggers have no reason to fire.
 * The longest healthy silent run in that window is therefore **8**, not 1 -
 * above this threshold, not below it.
 *
 * Raising the value to clear 8 would buy time rather than correctness, which
 * is why it was not raised. 8 is not a property of any plugin: it is the size
 * of the largest parallel-agent wave, and in an agent-driven repo that has no
 * ceiling. The fix taken instead is `firesEverySession` - an entry may reach
 * `stopped` on liveness only where the table records that its hooks fire in
 * every session, which makes it immune to a wave by construction.
 *
 * What five still buys, and this part survived the re-measurement: it absorbs
 * the ordering effect the retired firing-count threshold was set for. Every
 * stream can legitimately lag its own trigger by about one opportunity -
 * `bursar-session-start` fires at the top of a session whose output is not
 * written until `bursar-session-end` - and five clears that without modeling
 * it per plugin, leaving margin for a plugin that batches writes. Detection
 * is untouched by the margin; the real bursar outage reached 71 firings.
 *
 * The ceiling used to be argued by naming counsel - "five reports counsel
 * `stopped` today rather than `unknown`" - and that is no longer true.
 * counsel carries no `writeEvents`, because nothing consumes
 * `writeGateHours` since the rule was unified and a seven-day gate judged
 * against a five-opportunity window reads `stopped` on a healthy stream
 * (see the entry's own comment, and `onlooker-1vt`). It therefore has no
 * write axis to reach `stopped` on.
 *
 * `onlooker-run` tracks rechecking this once the enabled set has roughly a
 * month of history - now as a recheck of the write axis, since liveness no
 * longer rests on the count alone. Its own description was written from the
 * six-opportunity sample and is superseded by the numbers above.
 */
export const SESSION_STALL_THRESHOLD = 5;

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
	 * `SESSION_STALL_THRESHOLD` alone is the whole rule. Set only for a
	 * stream whose trigger fires far more often than its writer actually
	 * runs: counsel's brief generation is gated to once per
	 * `synthesis_interval_days` (7 days = 168 hours, counsel's
	 * config.json:3) while `counsel-session-start` fires every session;
	 * cartographer's audit is gated to once per `audit_interval_hours` (24,
	 * cartographer's config.json:5) while `cartographer-post-write` fires on
	 * every Write.
	 *
	 * RETAINED UNREAD, pending `onlooker-1vt`. Nothing consumes this field:
	 * the two functions that did - `clearsCadenceFloor` and `toleranceFor` -
	 * measured a gap in wall-clock milliseconds, which is exactly what the
	 * unified rule replaced with a count of opportunities, so restoring them
	 * would reintroduce the wall clock rather than fix anything. The field
	 * is kept because it is the measurement, not the mechanism: 168 and 24
	 * were read out of those two plugins' own config files, and the fix
	 * `onlooker-1vt` describes - scaling the opportunity threshold by an
	 * entry's own gate - needs exactly these numbers. Deleting them would
	 * mean re-deriving them from another repository's source.
	 *
	 * The margin that fix wants is two gate intervals, and the reasoning is
	 * the retired `CADENCE_FLOOR_MULTIPLIER`'s, preserved here because the
	 * constant went with its readers: a gated writer - counsel's brief,
	 * cartographer's audit - can legitimately be one full interval late, and
	 * two clears that with the same kind of margin `SESSION_STALL_THRESHOLD`
	 * leaves an ungated stream.
	 *
	 * Until then, neither entry names any `writeEvents`, so neither is
	 * judged on a write axis at all and the missing allowance cannot produce
	 * a false `stopped`. See both entries' own comments in `STREAMS`.
	 */
	writeGateHours?: number;
	/**
	 * The subset of `hooks` whose firing is reliable evidence that this
	 * entry's real, analytical work happened - not merely that its trigger
	 * ran. Two different things count as "real work" depending on `output`:
	 *
	 * For an entry with a real `output` path, this means the firing implies
	 * output should have been WRITTEN. Together with `writeEvents` it decides
	 * whether `computeVerdict` asks the write question of this entry at all.
	 * Undefined or empty when no hook on the entry is a reliable write
	 * signal, whether because one hook name serves several matchers and only
	 * some of them write (lineage), or because the writer itself is gated or
	 * conditional so its hook fires far more than it writes (counsel,
	 * cartographer, curator, governor, echo, tribunal). Those entries are
	 * judged on liveness alone unless `writeEvents` supplies an axis - the
	 * output's own age is NOT a substitute, which is the false alarm this
	 * whole design removed.
	 *
	 * For an `output: null` entry this field is now RECORD ONLY: it gates
	 * nothing, because `writeEvents` is that branch's whole downstream axis
	 * (see `eventsAreTheWriteAxis`). It is kept because the reading behind it
	 * - which of a plugin's hooks reliably reach an emission, established by
	 * reading each script rather than inferring from its name - is real work
	 * that would otherwise be lost, and because it stays the natural place to
	 * record it. compass's was emptied when the claim turned out to be false
	 * rather than merely unused; warden's was already empty for the same
	 * reason.
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
	 * Undefined or empty means this entry has no event whose silence is
	 * evidence, and the write question is not asked of it at all - for an
	 * `output: null` entry, `writeEvents` IS the whole downstream axis (see
	 * `eventsAreTheWriteAxis`); for every other entry it is half of the gate
	 * `writeHooks` shares. Empty is the conservative direction and the common
	 * one, because a stream judged on liveness alone cannot produce a false
	 * `stopped`.
	 *
	 * Two things must both hold before a type belongs here, and the
	 * verification pass found entries that satisfy the first and fail the
	 * second:
	 *
	 * 1. The emit and the write are ONE code path with no bail between them,
	 *    so the emission really did mean a write. `bursar.session.recorded`
	 *    is emitted inside the `if` that tested the ledger upsert
	 *    (`bursar-session-end.sh:164`); `historian.indexing.complete` is
	 *    emitted by `_emit_skip` on two bail paths as well as on the real one
	 *    (`historian-session-end.sh:102` against `:235`), so the same type
	 *    means both things and cannot mean either.
	 * 2. A HEALTHY stream is expected to emit it within the window, so its
	 *    silence is evidence rather than ordinary quiet. This is the half
	 *    that keeps curator, echo and scribe empty even though each has an
	 *    emit sitting right at its write site: a clean memory store, an
	 *    untouched agent prompt and a session with nothing worth distilling
	 *    are all ordinary, and treating their quiet as a stall is the exact
	 *    false alarm this design was built to remove.
	 *
	 * Full `event_type` values throughout, so an entry can name the types
	 * that mean work and leave out the ones that do not.
	 *
	 * Every value here was read out of the plugin's source, not inferred
	 * from its name. Each entry below records the file and line.
	 */
	writeEvents?: readonly string[];
	/**
	 * Whether EVERY hook in `hooks` fires in every session, so that this
	 * entry's last sign of life cannot go stale while sessions are running.
	 *
	 * The permission slip for the liveness half of `computeVerdict`, and the
	 * only thing that lets an entry reach `stopped` on it. Silence is evidence
	 * of a stall only if something was due; for an entry whose hooks fire on a
	 * trigger the session may simply never hit, silence is the ordinary shape
	 * of an ordinary session, and the verdict degrades to `unknown`.
	 *
	 * The false positive that put this here: `inspector` read
	 * `STOPPED - last sign of life 2026-09-05 21:30, 8 sessions ago` seven
	 * minutes after `inspector-post-write` last fired, on a healthy inspector.
	 * Eight subagent sessions started in those seven minutes; every one of
	 * them counts as an opportunity, because every one of them ran
	 * ecosystem's trackers, and not one of them was a Write - so inspector's
	 * trigger COULD not fire, and eight opportunities were charged against it
	 * for sessions that never asked it for anything. An entry whose hooks are
	 * session-level is immune to that wave by construction: its hooks fire in
	 * subagent sessions too, so each of the eight refreshes its last-seen
	 * instant rather than aging it.
	 *
	 * Raising `SESSION_STALL_THRESHOLD` does not fix this. The wave's size is
	 * the number of agents dispatched at once, which in an agent-driven repo
	 * has no ceiling - the same window that once held six opportunities held
	 * 31 after a few implementation sessions. Bounding WHO may be accused is
	 * the fix; bounding HOW MANY only buys time. `onlooker-run` tracks the
	 * threshold recheck this displaced.
	 *
	 * The write axis asks the same question and answers it differently, by
	 * narrowing its denominator to the sessions the entry's own hooks fired
	 * in. That narrowing keys on all of `hooks` too, and `onlooker-kqc4`
	 * records where doing so is wrong for a conditional WRITER - librarian,
	 * whose session-level hooks fire every session while its lessons are
	 * written rarely and legitimately. The two fields are mirrors of each
	 * other and neither substitutes for the other: this one says the trigger
	 * was due, kqc4 asks whether a WRITE was.
	 *
	 * This is the same question the write axis already asks - was this
	 * session a real chance for this entry? - answered for liveness the only
	 * non-circular way available. Not by counting the entry's own firings,
	 * which would compare a signal against itself, but by recording ahead of
	 * time whether they were due.
	 *
	 * Set from the hook's TRIGGER, read out of each plugin's `hooks.json`,
	 * never inferred from the hook's name. Exactly one shape qualifies:
	 * `SessionStart`, `SessionEnd` or `Stop`, matched `*`. Those fire once per
	 * session whatever the session does, including a subagent session that
	 * runs no tools at all.
	 *
	 * Nothing else does. `PreToolUse`/`PostToolUse` on any matcher is
	 * conditional on that tool being used; `PreCompact` is conditional on a
	 * compaction; `UserPromptSubmit` is conditional on a human prompt, which a
	 * subagent session driven by the Task tool never submits.
	 *
	 * ALL of `hooks`, not merely one of them, and undefined is the answer
	 * wherever that cannot be established. Abstaining is the direction taken
	 * everywhere in this design: a `stopped` withheld from a dead stream is a
	 * missed alarm, and a `stopped` handed to a live one is the false alarm
	 * this whole module exists to remove. The cost is real and is recorded
	 * per entry - archivist, historian, scribe and governor each carry a
	 * session-level hook that would in fact keep their liveness fresh, and
	 * each is held back by one conditional sibling in the same list.
	 *
	 * See each entry below for its hooks' trigger types and why they do or do
	 * not settle the question.
	 */
	firesEverySession?: boolean;
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
		// No firesEverySession, and archivist is the cleanest example of what
		// the all-of-`hooks` rule costs. archivist-inject IS session-level
		// (SessionStart `*`, archivist's hooks.json), so archivist's liveness
		// would in fact stay fresh through an agent wave - but
		// archivist-extract is PreCompact, matched `manual` and `auto`, and a
		// session that never fills its context never compacts. One
		// conditional sibling is enough to withhold the flag, which is the
		// direction the field's docstring commits to.

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
		// With no writeHooks, archivist is judged on liveness alone.
		//
		// No writeEvents either, and it is the one entry where that is forced
		// rather than chosen. `onlooker.artifact.ready` (archivist-
		// extract.sh:292) is archivist's only emission and IS gated on the
		// aggregate write - the `WRITE_COUNT -gt 0` guard at :269 covers both
		// - so it satisfies the first half of `writeEvents`'s test. It fails
		// the identification test that comes before either half: counsel
		// (counsel-brief.sh:336), scribe (scribe-distill.sh:252) and
		// librarian (librarian-session-end.sh:425) emit the same type, so a
		// timestamp for it is not evidence about archivist. `events: []`
		// records the same fact one level up, and the guard test that every
		// `writeEvents` value match one of its entry's `events` prefixes
		// rejects the assignment outright for that reason.
		//
		// So archivist has no axis but liveness, and reads `recording` or
		// `unknown` and never `stopped`. A real loss of signal, not a bug -
		// archivist genuinely has nothing this design can measure, and
		// `unknown` is the honest answer rather than a fabricated one.
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
		// assayer-stop is Stop `*` (assayer's hooks.json) - one hook, and it
		// runs at the end of every session including a subagent's. Nothing
		// here is conditional on a tool, a prompt or a compaction, so a run of
		// opportunities with no assayer firing in any of them really is
		// assayer having stopped, not the sessions having had no use for it.
		firesEverySession: true,
		// NOT writeHooks: ["assayer-stop"], despite being its only hook.
		// assayer-stop.sh registers hook health at line 35, then has SEVEN
		// bail sites before it ever writes an audit - no repo root (:94), no
		// project key (:99), no `claude` on PATH (:101), no `jq` on PATH
		// (:102), no transcript (:104), empty final assistant message
		// (:112), empty `claude -p` response (:140) - all ordinary, not
		// exceptional. Measured on a live machine: 395 assayer-stop firings
		// against 39 audit files, roughly 10:1. At a stall threshold of 5,
		// assayer crossed into `stopped` within hours of any quiet stretch -
		// the lineage false positive again, on a plugin this repo enables.
		//
		// The write question is answered by `writeEvents` instead. Of the
		// four types assayer emits, `assayer.audit.complete` is the one at
		// the write site: emitted at assayer-audit.sh:230, with the audit file
		// written at :239-251 and nothing between the two but the
		// `SAFE_SESSION_ID` assignment on :238. `assayer.audit.started` (:137)
		// sits before the whole claim loop and `assayer.claim.contradicted`/
		// `.unverified` (:185, :199) fire per claim inside it, all three too
		// early to mean anything about the file.
		//
		// Adjacency, not a gate, and worth stating precisely rather than
		// implying more. The emit PRECEDES the write, and the write itself
		// ends `2>/dev/null || true`, so a failed write leaves the event
		// standing - structurally what tribunal was rejected for below, minus
		// tribunal's actual bail between the two. Kept anyway on two grounds:
		// the error direction is a false `recording`, which is inside this
		// design's conservative bias rather than against it, and every audit
		// that starts reaches this point - 534 `assayer.audit.complete`
		// against 534 `assayer.audit.started`, never one without the other.
		//
		// The second half of the test is what separates assayer from curator
		// and echo below: every audit that runs writes a file, so a healthy
		// assayer produces one per audit rather than only when it has
		// something worth reporting. Its silence is therefore evidence, and
		// theirs is not.
		writeEvents: ["assayer.audit.complete"],
		// `assayer/<key>/` per project - verified on disk.
		perProject: true,
	},
	{
		plugin: "bursar",
		// NOT `bursar/sessions`. See the interface docstring.
		output: join("bursar", "projects"),
		events: ["bursar"],
		hooks: ["bursar-session-start", "bursar-session-end"],
		// SessionStart `*` and SessionEnd `*` (bursar's hooks.json): both ends
		// of every session, neither conditional on anything the session does.
		// This is the entry the liveness axis was calibrated on - bursar fired
		// in more opportunities than any other plugin in the measured window -
		// and it is the shape the axis must keep accusing, since the
		// 2026-08-07 outage this module was built for was bursar's.
		firesEverySession: true,
		// NOT bursar-session-start, which fires a whole session before the
		// write bursar-session-end performs - the "one session of lag"
		// `SESSION_STALL_THRESHOLD` leaves room for. Counting
		// session-start's own firings would flag a healthy bursar the
		// moment new sessions keep opening, regardless of whether
		// session-end is writing just fine.
		writeHooks: ["bursar-session-end"],
		// The cleanest case in the table, and the one to read first when
		// deciding a new entry. `bursar.session.recorded` is emitted INSIDE
		// the branch that tested the ledger upsert - `if bursar_ledger_record
		// ...; then` at bursar-session-end.sh:164, emit on :165 - and the
		// script's own comment above it (:150-153) says why: "Only claim the
		// session was recorded ... once the ledger upsert actually succeeds."
		// A failed write takes the `else` and emits nothing. The ledger it
		// gates on is this entry's `output` exactly, `bursar/projects/<key>/
		// sessions.jsonl` (bursar-ledger.sh:33, :75), not some sibling.
		//
		// NOT `bursar.rollup.surfaced`/`.skipped` (bursar-session-start.sh
		// :128, :83), which report what the session-start rollup showed the
		// user and write nothing - and outnumber the real one 16,080 to
		// 1,199 on this machine.
		writeEvents: ["bursar.session.recorded"],
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
		// elapsed-time gate. Without an allowance for that gate, a stall
		// threshold can be crossed within a single busy day on a perfectly
		// healthy stream. Retained unread pending `onlooker-1vt` - see the
		// field's own docstring.
		writeGateHours: 24,
		events: ["cartographer"],
		// No writeHooks: cartographer-post-write fires on every Write, but
		// the audit it triggers is itself gated (writeGateHours above), so
		// neither hook's firing reliably implies a write.
		//
		// No writeEvents either, on the closest call in the table.
		// `cartographer.audit.complete` does sit next to the write - the run
		// record lands at run-audit.sh:371-382 and the emit is :384 - but it
		// is not gated on it: the write is `> "${run_file}.tmp" && mv -f`,
		// and a failure there still falls through to the emit, unlike
		// bursar's, which is inside the `if`. That alone would be a thin
		// reason to decline.
		//
		// The deciding one is the gate, and it applies to counsel below
		// identically - these two are the only entries with `writeGateHours`
		// set at all. Nothing enforces that gate against the window anymore:
		// the two functions that read the field went with the wall clock when
		// the rule was unified, so the window counts opportunities with no
		// idea that this writer only tries once a day. Five opportunities
		// inside one 24-hour interval - a single busy day - would read
		// `stopped` on a stream that is exactly on schedule, and naming a
		// write event here is precisely what switches that branch on.
		// Liveness is the honest axis until a gated writer has a denominator
		// that respects its gate. Tracked as `onlooker-1vt`.
		hooks: ["cartographer-post-write", "cartographer-session-start"],
		// No firesEverySession. cartographer-session-start is SessionStart
		// `*`, but cartographer-post-write is PostToolUse matched Write, Edit
		// and MultiEdit (cartographer's hooks.json) - the same trigger shape
		// as inspector's, and the one that produced the false `stopped`. A
		// read-only session fires it zero times, so it cannot be treated as
		// due. cartographer keeps no write axis either, so with the flag
		// withheld it cannot reach `stopped` at all - see `onlooker-1vt`,
		// which is what would give a gated writer its axis back.
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
		// No firesEverySession. Only compass-session-start is session-level
		// (SessionStart `*`); the other three are tool-scoped in compass's
		// hooks.json - compass-bash-gate on PreToolUse Bash,
		// compass-pre-tool-use on PreToolUse Write/Edit/MultiEdit,
		// compass-record-write on PostToolUse Write/Edit/MultiEdit. The same
		// conditionality that emptied this entry's writeHooks and writeEvents
		// withholds the flag, one axis up.

		// No writeHooks, reversing an earlier call on this entry. It used to
		// read `["compass-bash-gate"]`, justified as "a write-pattern match
		// reliably emits" - true, and not the claim the field makes. The
		// claim is that THE HOOK'S FIRING implies an emission was due, and
		// compass-bash-gate fires on every Bash call: it registers with
		// hook-health on :29, decides the command is read-only on :98, and
		// exits on :99 having emitted nothing, while hook-health's EXIT trap
		// (hook-health.sh:97) logs the firing exactly as it logs a real one.
		// Read-only Bash outnumbers write Bash heavily, so the firing count
		// and the emission count are not the same measurement, and the bead
		// records the consequence as a live false positive: an hour of
		// read-only Bash after the last file-modifying command read
		// `stopped`.
		//
		// Of the four hooks only compass-bash-gate can emit at all -
		// compass-session-start, compass-pre-tool-use and compass-record-
		// write each read straight through to their per-session gate state
		// with no `compass_emit_event` call anywhere in any of the three - so
		// emptying this leaves nothing to put in its place. All four stay in
		// `hooks`, where they count toward liveness.
		//
		// No writeEvents either, and for the same underlying fact seen from
		// the other side. compass.check.passed/failed/skipped (compass-
		// gate.sh:438, :451, and eight `.skipped` sites) are emitted only
		// once _is_write_command (compass-bash-gate.sh:60-96) has matched, so
		// a session that ran no rm/mv/cp/redirect/git commit/sed -i emits
		// nothing - which is an ordinary session, not a stall. Five such
		// sessions is a quiet week, and the design rules this out by name:
		// compass-bash-gate "is in `hooks`, so it counts toward liveness, and
		// is not in `writeEvents`, so an hour of read-only Bash can no longer
		// produce `stopped`."
	},
	{
		plugin: "counsel",
		output: "counsel",
		// `counsel-session-start` fires every session, but real brief
		// generation is gated by `counsel_brief_is_stale`
		// (counsel-brief.sh:89) to once per `synthesis_interval_days` - 7
		// days, 168 hours, by default (config.json:3). Without an allowance
		// for that gate, a normal week of 6+ sessions crosses a stall
		// threshold with zero output movement on a perfectly healthy,
		// on-schedule stream. Retained unread pending `onlooker-1vt` - see
		// the field's own docstring.
		writeGateHours: 168,
		events: ["counsel"],
		// No writeHooks: its only hook fires every session while the brief
		// it triggers is gated (writeGateHours above), so firing does not
		// imply a write.
		//
		// No writeEvents, and this one departs from the design, which lists
		// `["counsel.brief.generated"]` among its known assignments. The
		// source half of that holds: the brief JSON is written at
		// counsel-brief.sh:305 and the event is emitted at :322, guarded only
		// on the period bounds parsing. What does not hold is the second half
		// of the test, for the same reason as cartographer above -
		// `writeGateHours: 168` says a healthy counsel writes once a WEEK,
		// and the window has no idea, because the field's only two readers
		// were wall-clock ones and went when the rule was unified.
		//
		// Measured against this repo's own denominator that is not a
		// hypothetical: six opportunities in the six days to 2026-09-05, so
		// about one a day, so five elapse on day five of every seven-day
		// gate interval. A perfectly on-schedule counsel would read `stopped`
		// for two days out of every seven. That is the class of false alarm
		// this whole design exists to remove, so the assignment waits for the
		// gate to be honored rather than shipping ahead of it.
		//
		// The cost is real and worth naming rather than burying: an enabled
		// counsel whose brief generation breaks while counsel-session-start
		// keeps firing reads `recording`, and the month of silence since
		// 2026-08-07 would go unreported. That is a false negative traded for
		// a recurring false positive, the same direction taken everywhere
		// else here, and it reverses the moment `writeGateHours` has a
		// consumer again. Tracked as `onlooker-1vt`.
		hooks: ["counsel-session-start"],
		// counsel-session-start is SessionStart `*` (counsel's hooks.json) -
		// its only hook, and unconditional. Note what this does and does not
		// say: the HOOK is due every session, which is what liveness asks.
		// Whether the brief gets WRITTEN is gated to once per seven days, and
		// that is the separate question the entry declines to answer by naming
		// no writeEvents (see this entry's comment above, and `onlooker-1vt`).
		firesEverySession: true,
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
		//
		// No writeEvents, and curator is the entry that shows why the test
		// has two halves rather than one. `curator.scan.complete` is the
		// obvious candidate and fails on the first: it is emitted on every
		// scan, including `outcome: "skipped", skip_reason: "over_budget"`
		// (curator-session-start.sh:289) and the disabled-tier path (:106),
		// so it says nothing about findings.
		//
		// `curator.finding.<kind>` - date_decayed, path_broken,
		// broken_index, orphaned_memory (:272-275) - passes the first half
		// cleanly and is not in the design's write-up, which considered only
		// scan.complete. It is emitted at :255, three lines after
		// curator_storage_write_finding returns success at :247, and that
		// write goes to `findings/`, this entry's `subpath` exactly.
		//
		// It fails the second half, which is what settles it. A finding is
		// written only when a NEW problem turns up and survives the
		// deduped_hash check at :231; a clean memory store legitimately
		// produces none for months. Naming these types would switch the write
		// branch on and judge curator against `findings/`'s own mtime, which
		// is the June-era false positive the design reproduced and the
		// regression test pins. Zero `curator.finding.*` records exist in
		// this machine's 139k-entry log, against 4,894 `curator.scan.
		// complete` - the ratio is the same fact stated in numbers.
		hooks: ["curator-session-start"],
		// curator-session-start is SessionStart `*` (curator's hooks.json) -
		// its only hook, and unconditional. As with counsel, this is a claim
		// about the trigger only: curator writes findings only when the memory
		// store has a problem, which is why it names no writeEvents.
		firesEverySession: true,
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
		// touches an agent prompt is ordinary, not a stall.
		//
		// No writeEvents, on the same shape as curator above.
		// `echo.suite.complete` passes the first half - emitted at
		// echo-stop-gate.sh:364, advisory file written at :372-384, only the
		// `SAFE_SESSION_ID` assignment between them - and fails the second
		// for the reason the header already gives: the whole script bails
		// before reaching :364 unless a watched agent file changed this
		// session, so a healthy echo emits nothing across an ordinary week.
		// The live counts say how ordinary - four `echo.suite.started` and
		// two `echo.suite.complete` in this machine's entire history, last
		// written 2026-05-24. `echo.improvement.detected`/`.regression.
		// detected` (:277, :292) are rarer still and fire per finding, not
		// per write.
		hooks: ["echo-stop-gate"],
		// echo-stop-gate is Stop `*` (echo's hooks.json) - its only hook, and
		// it runs at the end of every session. Its analytical work is
		// conditional on there being an agent prompt worth revising, which is
		// why it names no writeEvents; the firing itself is not.
		firesEverySession: true,
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
		// No firesEverySession, and the fourteen are not close to unanimous.
		// Only three are session-level in ecosystem's hooks.json -
		// session-start-tracker and memory-recall-tracker on SessionStart `*`,
		// session-end-tracker on SessionEnd `*`. The rest are conditional on
		// something the session may never do: tool-sequence-tracker on
		// PreToolUse `*`, agent-spawn-tracker on PreToolUse Agent,
		// skill-usage-tracker on PreToolUse Skill and UserPromptExpansion,
		// tool-history-tracker on PostToolUse `*` and PostToolUseFailure `*`,
		// turn-tracker / session-duration-tracker / prompt-rule-injector on
		// UserPromptSubmit, pre-compact-tracker on PreCompact,
		// context-compact-tracker on PostCompact, task-tracker on
		// TaskCreated/TaskCompleted, worktree-tracker on
		// WorktreeCreate/WorktreeRemove.
		//
		// Detection of the 2026-08-07 outage does not depend on this flag and
		// must not be read as depending on it. That shape is trackers dead
		// while hooks keep firing, which is a WRITE-axis verdict off
		// `writeEvents` below - liveness reads fresh throughout, by
		// construction, which is exactly why the write axis exists here.

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
		//
		// That reading is now RECORD ONLY: `writeEvents` below is what gates
		// this entry's downstream axis. Kept because reading fourteen scripts
		// in full is the evidence behind it, and this is where it belongs.
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
		// The entry the event-side circularity was found on, and the reason
		// this branch judges named types rather than whole prefixes.
		//
		// Every type here is one of ecosystem's own canonical emissions, and
		// for an `output: null` entry the emission IS the write - there is no
		// file downstream of it to check. The seven tool types come out of
		// tool-history-tracker.sh:32, which appends whatever the mapper's
		// switch on tool name returns - six cases at onlooker-event.mjs:431-506
		// (Read/Write/Edit/Bash/WebFetch/Agent) producing seven types, because
		// the Agent case splits on PreToolUse for spawn and anything else for
		// complete;
		// `tool.agent.spawn` has a second, dedicated site at
		// agent-spawn-tracker.sh:158 through common.sh:39. `skill.invoked`
		// comes from skill-usage-tracker.sh:42, `task.start`/`task.complete`
		// from task-tracker.sh:53, `memory.recalled` from
		// memory-recall-tracker.sh:215. All eleven are live on this machine,
		// which is the cross-check that no site listed here never actually
		// fires.
		//
		// NOT `session.start`, and that omission is the entire point. An
		// opportunity requires a `session.start` event, so a `lastWrite` that
		// includes one is always at least as new as the newest opportunity
		// and `opportunitiesSince` returns 0 by construction - ecosystem
		// could never read `stopped` on the axis built to catch it. Its
		// trackers dying on 2026-08-07 while its hooks kept firing is the
		// incident this feature exists for and the exact shape this axis
		// answers. Confirmed twice against the built code before the branch
		// was changed.
		//
		// The other three `session.*` types are left out too. They do not pin
		// the count the way `session.start` does, but they come from the same
		// three trackers whose liveness the denominator already depends on,
		// and the axis is cleaner for asking only about the work: if every
		// tool, skill, memory and task tracker has gone silent while sessions
		// keep opening and closing, that is a stall, and saying so is what
		// this entry is for.
		writeEvents: [
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
		// actually decides, not guaranteed on any one firing.
		//
		// No writeEvents, and unusually the source settles all five types
		// against it rather than leaving any of them arguable.
		// `governor.call.recorded` is the near miss: governor_ledger_append
		// runs at governor-post-tool-use.sh:128 and the emit is :162, but the
		// append is written `|| true`, so a failed ledger write falls
		// straight through to an event claiming the call was recorded - the
		// opposite of bursar's `if`, and the same three lines of code arranged
		// to mean the other thing. `governor.gate.checked`
		// (governor-pre-tool-use.sh:205) reports a gate decision with no
		// ledger write anywhere near it, `governor.session.complete`
		// (governor-stop.sh:120) fires on every session - 2,774 of them here
		// - and `governor.ledger.write_failed` (governor-ledger.sh:124) means
		// the write did NOT happen. `governor.lock.stale_cleared` is
		// housekeeping.
		hooks: [
			"governor-post-tool-use",
			"governor-pre-tool-use",
			"governor-session-start",
			"governor-stop",
		],
		// No firesEverySession, and this one is held back by a narrow matcher
		// rather than a broad one. governor-session-start (SessionStart `*`)
		// and governor-stop (Stop `*`) are session-level, but
		// governor-pre-tool-use and governor-post-tool-use are matched Task
		// alone in governor's hooks.json - so they fire only in a session that
		// dispatches a subagent, which most sessions never do.

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
		// No firesEverySession, withheld on the UserPromptSubmit half.
		// historian-session-end is SessionEnd `*` and would carry liveness on
		// its own; historian-prompt-submit is UserPromptSubmit (historian's
		// hooks.json), and a subagent session driven by the Task tool submits
		// no user prompt at all - which is precisely the session shape that
		// manufactured the wave. Recorded as a cost of the all-of-`hooks`
		// rule, not as a claim that historian is fragile.

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
		// No writeEvents: historian's completion event is emitted from the
		// bail paths AND the success path, under one type. `_emit_skip`
		// (historian-session-end.sh:96-107) emits `historian.indexing.
		// complete` with `outcome: "skipped"` for `transcript_unavailable`
		// (:110) and `too_short` (:127); the real path emits the same type
		// with `outcome: "ok"` at :235. A type that means both "indexed" and
		// "did not index" cannot mean either, and `events.lastByType` keys on
		// the type alone - the payload's `outcome` is not something this
		// table can read. `historian.indexing.started` (:121) is emitted
		// before the chunker runs at all, and the whole `historian.retrieval.
		// *` family belongs to historian-prompt-submit, which reads and never
		// writes.
		//
		// Little is lost by this: `writeHooks` above already makes
		// historian's write question askable, and `writeEvents` would only
		// have sharpened `lastWrite` past the output's own mtime.
	},
	{
		// Writes no directory of its own; its trace is the shared event log.
		plugin: "inspector",
		output: null,
		events: ["inspector"],
		hooks: ["inspector-post-write"],
		// No firesEverySession, and this is the entry the field was added for.
		// inspector-post-write is PostToolUse matched Write, Edit and
		// MultiEdit (inspector's hooks.json) and nothing else, so a session
		// that edits no file never triggers inspector at all. Eight such
		// sessions in seven minutes read `STOPPED - last sign of life
		// 2026-09-05 21:30, 8 sessions ago` on a healthy inspector; with the
		// flag withheld the same evidence reads `unknown`, which is the true
		// answer. inspector keeps its write axis, so a session that DID write
		// and produced no `inspector.*` event still counts against it.

		// Its matcher already scopes it to Write/Edit/MultiEdit only
		// (inspector's hooks.json), so the tool-name/missing-target guards
		// inside the script are dead code, not a routine skip. Past those,
		// every path emits: not-in-repo, an excluded path, and no-
		// extension-match each call inspector_emit_whole_file_skipped
		// (inspector-run.sh:308), and a matched check set runs through
		// inspector_run, whose own loop emits per check and always finishes
		// with inspector.run.completed. Its only firing is inspector-post-
		// write, so it is both its only hook and its only reliable one.
		//
		// Record only now, like ecosystem's - `writeEvents` below is what
		// gates the downstream axis for an `output: null` entry.
		writeHooks: ["inspector-post-write"],
		// All four types inspector emits, which is the whole `inspector.`
		// prefix and so preserves exactly what this entry was judged on
		// before the axis moved from prefixes to named types. Nothing about
		// inspector needed the change; naming them is what keeps it out of
		// the `writeEvents`-is-empty case, where it would lose its downstream
		// and start certifying itself off its own event stream.
		//
		// Listed rather than reasoned away one by one because inspector is
		// the entry where every path emits. `inspector.check.skipped` has two
		// separate emitters and they cover different halves of that claim:
		// inspector_emit_whole_file_skipped (inspector-run.sh:308, emitting at
		// :318) takes not-in-repo, an excluded path and no-extension-match,
		// while _inspector_emit_skipped (:293, emitting at :305) takes the
		// per-check bails - total_budget_exhausted, tool_missing and timeout,
		// called from :169, :193 and :200. Past those the loop emits passed or
		// failed per check (:262, :290) and a completed run always finishes
		// with inspector.run.completed (:335). There is no path through
		// inspector-post-write that writes without emitting, which is the
		// same fact `writeHooks` above records from the other end.
		writeEvents: [
			"inspector.check.passed",
			"inspector.check.failed",
			"inspector.check.skipped",
			"inspector.run.completed",
		],
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
		// SessionEnd `*` and SessionStart `*` (librarian's hooks.json), both
		// unconditional. librarian is the entry `doctor` currently reports as
		// `unknown ... has never been written` on this machine, and that
		// verdict comes from the never-written-output branch rather than from
		// liveness - the flag does not change it either way.
		firesEverySession: true,
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
		// assayer and archivist, one layer deeper.
		//
		// No writeEvents either, and here the reason is simpler than
		// anywhere else in the table: librarian emits nothing about
		// `lessons/`. Its types name three other things - the scan
		// (`librarian.scan.started`/`.complete`, librarian-session-end.sh:135
		// and :506, the latter emitted on every scan including `outcome:
		// "empty"`), the proposal store (`librarian.candidate.proposed` at
		// :434, `librarian.candidate.dropped` at seven sites, and
		// `librarian.proposal.accepted`/`.rejected` and `.tombstone.created`
		// from librarian-cli.sh, all writing `proposals/` rather than
		// `lessons/`), and the artifact browser (`onlooker.artifact.ready` at
		// :425, pointing at `artifacts/`, and shared with three other plugins
		// besides). The `lessons/` writers themselves - librarian-lesson-
		// storage.sh, -transform.sh, -promote.sh - contain no `librarian_emit`
		// call at all. There is no event to name, not a doubtful one.
		//
		// So librarian's own headline case, the empty lesson pool this table
		// exists to catch, is `unknown`-grade detection rather than
		// `stopped`-grade: a session firing with `lessons/` never created
		// reads `unknown` ("cannot tell 'nothing to write yet' from
		// 'broken'"), never a confident `stopped`. Still surfaced - `unknown`
		// exits 1, same as `stopped` does - just without evidence that would
		// let this table say so with certainty. A real, accepted trade, not a
		// silent regression, and the fix is upstream: a lesson-write event
		// would settle it in one line.
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
		// No firesEverySession. lineage-post-tool-use is PostToolUse matched
		// Write, Edit, MultiEdit and Bash (lineage's hooks.json) - broader
		// than inspector's, and still conditional: a session that reads and
		// answers without touching a tool fires it zero times. lineage reached
		// four of the 31 opportunities in the measured window without firing,
		// one short of the threshold, so this is the same latent false
		// positive as inspector's rather than a different case.

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
		// writes.
		//
		// No writeEvents, on the curator/echo shape a third time.
		// `scribe.distill.complete` passes the first half - it is emitted at
		// scribe-distill.sh:241, after both the markdown at the top of that
		// function and the structured JSON at :231 - and fails the second on
		// the clause already above it: scribe distills only when a session
		// had something worth distilling, so the weeks it writes nothing are
		// weeks it was working correctly. That is the reproduced false
		// positive the design names by hand ("a week-old scribe `.md` means
		// nothing was worth distilling"), and the regression test pins it.
		// `onlooker.artifact.ready` (:252) is out on identification anyway -
		// archivist, counsel and librarian emit it too.
		hooks: ["scribe-capture", "scribe-session-start", "scribe-stop"],
		// No firesEverySession, withheld on scribe-capture alone.
		// scribe-session-start (SessionStart `*`) and scribe-stop (Stop `*`)
		// are session-level; scribe-capture is UserPromptSubmit (scribe's
		// hooks.json), which a subagent session never fires. Same shape as
		// historian, and the same recorded cost.

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
		// ordinary, not a stall.
		//
		// No writeEvents, and tribunal is the one entry where the first half
		// fails on ORDERING rather than on conditionality. All six types are
		// emitted in one block at tribunal-stop-gate.sh:261-266, BEFORE the
		// advisory file is written at :274 - and there is a real bail in
		// between, `mkdir -p "$STOP_DIR" 2>/dev/null || _done` on :270, which
		// exits after every event has already landed. Even
		// `tribunal.session.complete`, the last of the six, is emitted while
		// the output directory may not exist yet. The second half fails too,
		// for the reason above.
		hooks: ["tribunal-stop-gate"],
		// tribunal-stop-gate is Stop `*` (tribunal's hooks.json) - its only
		// hook, unconditional, and the same shape as echo's.
		firesEverySession: true,
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
		// No firesEverySession. warden-session-start is SessionStart `*`, but
		// warden-pre-tool-use is PreToolUse on Write/Edit/MultiEdit/Bash and
		// warden-post-tool-use is PostToolUse on WebFetch/Read (warden's
		// hooks.json) - both conditional on the session using those tools.
		// warden's write axis is already empty, so with the flag withheld it
		// can no longer reach `stopped` on either axis. That is the intended
		// reading of an entry whose every signal is rare by design: on a
		// machine nobody has attacked, warden's silence is health.

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
		// (2026-08-01T21:13:33Z).
		//
		// No writeEvents either, which is now what actually decides this, and
		// the three types say it as plainly as the three hooks do.
		// `warden.gate.blocked` and `warden.threat.detected` are the two
		// emissions the hooks above are described by - eight and one
		// occurrence respectively in this machine's entire 139k-entry log -
		// and `warden.threat.cleared` reports the absence of a finding. None
		// of the three is due on a healthy machine; all three going quiet for
		// five opportunities is the ordinary state of a machine nobody has
		// tried to attack.
		//
		// With no writeEvents, warden's events are not treated as a
		// downstream to judge - so `computeVerdict` never asks the write
		// question of it, and its verdict rests on liveness alone. That makes
		// warden the one `output: null` entry whose events still count as
		// proof of life; see `eventsAreTheWriteAxis`, which exists to keep the
		// axis split from stripping them.
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
 * `restrictTo` narrows that further, to sessions the caller has some reason
 * to count - `computeVerdict` passes the sessions an entry's own hooks fired
 * in when it asks the WRITE question, because a session in which the entry's
 * trigger never fired was never a chance for it to write. It narrows rather
 * than replaces: a session named there that ran no hook at all is still not
 * an opportunity. A `ReadonlySet` or an array, so a caller that already holds
 * a set is not made to flatten one this function would rebuild. Omitted means
 * no narrowing, which is what the liveness
 * question wants and must keep wanting - narrowing that one would be
 * circular, since an entry whose hooks never fire would generate none of its
 * own opportunities and could never be judged silent, the exact
 * enabled-but-never-runs case liveness exists to catch.
 *
 * Epoch comparison, not lexical: `iso` can arrive from either log, and the
 * two write different precision. See `scanHooks`'s `since` comment for the
 * full trap.
 */
export function opportunitiesSince(
	events: Pick<EventScan, "sessionStarts">,
	hooks: Pick<HookScan, "sessionsWithRecords">,
	iso: string,
	// A `ReadonlySet` as well as an array, so `computeVerdict` - which builds
	// its narrowing as a `Set` already - can hand it straight over instead of
	// spreading into an array this function would immediately re-wrap.
	restrictTo?: ReadonlySet<string> | readonly string[],
): number {
	const ran = new Set(hooks.sessionsWithRecords);
	// `undefined` means "no narrowing requested"; a real collection, even an
	// empty one, means "exactly these" - the same distinction `scanHooks`'s
	// `sessionIds` draws, and for the same reason.
	const only =
		restrictTo === undefined
			? null
			: restrictTo instanceof Set
				? restrictTo
				: new Set(restrictTo);
	const cutoff = new Date(iso).getTime();
	let count = 0;
	for (const session of Object.keys(events.sessionStarts)) {
		if (!ran.has(session)) continue;
		if (only !== null && !only.has(session)) continue;
		if (new Date(events.sessionStarts[session]).getTime() > cutoff) count++;
	}
	return count;
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
	 * Injectable clock. No verdict decision consults it - the rule counts
	 * opportunities, not elapsed time, and the wall-clock freshness limit it
	 * replaced is gone - but detail-string formatting does: `stampFor` needs
	 * a reference instant to decide whether a timestamp must carry the time
	 * as well as the date, so a sub-day gap does not render as two identical
	 * dates. Defaults to the real clock at the edge, the same way `env` and
	 * `configDir` are threaded rather than reached for throughout this file.
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
	//
	// The `since` map is the cutoff for `HookScan`'s `firedSince`/`okSince`,
	// and no verdict reads either one anymore - the unified rule counts
	// opportunities from a last-seen instant instead. Both counters, and
	// therefore this map, are held pending `onlooker-d7g`, which owns the
	// choice between surfacing them in a `stopped` verdict's detail ("fired
	// 73 times, 71 succeeded, produced no output" forecloses the reader's
	// first guess, that the hook was erroring) and dropping them from
	// `HookScan`. Nothing else in the scan depends on the cutoff: a hook's
	// `last` is recorded before the `since` filter runs, so liveness is
	// unaffected either way.
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
	// without it, a single unrelated repo's session firing a hook makes that
	// hook's `last` a sign of life here, and a stream this repo's own
	// sessions never touched reads alive on another repo's activity.
	// Passed only when `root` is non-null, mirroring `scanEvents`'s own
	// scoping condition exactly: no root means no repo context to scope by
	// at all, so `scanHooks` keeps its unscoped default rather than being
	// handed an empty set that would scope every hook to nothing.
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

/**
 * How a timestamp reads inside a verdict's detail.
 *
 * Date alone for anything a day or more old, which is every ordinary stall.
 * Date and time when the gap is under a day, because a date-only rendering
 * of a sub-day gap produces a detail that refutes itself - the real verdict
 * this fixes read `compass-bash-gate fired 2026-09-05, but the last event
 * was 2026-09-05`, presenting two identical strings as a discrepancy, on a
 * gap of 2h55m.
 *
 * `reference` is passed rather than read from a clock so callers stay
 * testable - see `surveyStreams`'s `now`.
 */
export function stampFor(iso: string, reference: Date): string {
	const gap = reference.getTime() - new Date(iso).getTime();
	if (gap >= 24 * 60 * 60 * 1000) return iso.slice(0, 10);
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
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
	now: Date,
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

	/**
	 * Whether this entry's own EVENTS are the downstream being judged, rather
	 * than a file on disk.
	 *
	 * Tracked as a flag rather than re-derived from `entry.output === null`
	 * further down, because the two are not the same question and reading one
	 * for the other is a real bug: warden is `output: null` and names no
	 * `writeEvents`, so its events are NOT its downstream, and stripping them
	 * from liveness on the strength of `output` alone leaves it with no axis
	 * at all - a warden that emitted this morning reads as never having run.
	 */
	let eventsAreTheWriteAxis = false;

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
		// it is recomputed to exclude events), and events play output's part
		// here.
		//
		// The axis is `writeEvents` - the named types - and NOT every prefix
		// in `events`, which is what this branch read until the circularity
		// on the event side was found. An opportunity requires a
		// `session.start` event, because that is what `sessionStarts` is
		// built from, and `session` is one of ecosystem's own tracked
		// prefixes. A prefix-wide `lastWrite` is therefore always at least as
		// new as the newest opportunity, `opportunitiesSince` is pinned at 0
		// by construction, and ecosystem can never reach `stopped` on the one
		// axis that exists to catch its 2026-08-07 tracker outage - the
		// incident this whole rule was built for. Naming the types instead
		// lets the table leave the denominator's own signal out of the set it
		// is judged against.
		//
		// `writeHooks` no longer gates this. It asserted "this hook's firing
		// implies an emission was due," which is a claim about the trigger,
		// not about the downstream - and compass's was simply false
		// (`compass-bash-gate` fires on every Bash call, emits only on a
		// write-pattern match, and hook-health's EXIT trap logs the firing
		// either way). An entry that names no `writeEvents` now has no
		// downstream axis at all and rests on liveness, which is the
		// conservative direction taken everywhere else here: liveness cannot
		// produce a false `stopped`, and a wrong write axis can.
		if (writeEvents.length > 0) {
			eventsAreTheWriteAxis = true;
			lastWrite = "";
			for (const type of writeEvents) {
				lastWrite = newerOf(lastWrite, events.lastByType[type] ?? "");
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

	// Where the events are the downstream being judged, they cannot also serve
	// as proof of life - that would compare a signal against itself and never
	// report anything. Only there: see `eventsAreTheWriteAxis` for the entry
	// this narrower condition exists to protect.
	if (eventsAreTheWriteAxis) {
		lastLife = "";
		for (const hook of entry.hooks) {
			lastLife = newerOf(lastLife, hooks.hooks[hook]?.last ?? "");
		}
	}

	// --- the denominator ------------------------------------------------
	// Opportunities this repo has had at all, and the width of the window
	// every count below is read against. Two different things can make that
	// width unusable, and they are checked separately below: the entry having
	// no last-seen instant to measure from, and the window itself being
	// narrower than the rule's own threshold.
	//
	// The epoch as a cutoff, so this counts every opportunity ever seen.
	const window = opportunitiesSince(events, hooks, "1970-01-01T00:00:00.000Z");

	// Never seen alive here at all, which is not the same as having gone
	// quiet. A stall is a count of opportunities measured FROM some last-seen
	// instant, and this entry has none - so however wide the window, there is
	// nothing for its width to be measured against. A plugin enabled an hour
	// ago and one that died before this log began present identically: every
	// opportunity behind them, nothing of their own in front.
	//
	// Reporting `stopped` off the window alone therefore fires on every fresh
	// enable on any active machine - this repo has 11,422 sessions behind it -
	// which is the same false positive the rest of this rule exists to
	// remove. The design settles it by name: a plugin enabled an hour ago
	// "has not had the opportunities that would make its silence mean
	// anything", and `unknown` there "is not a weaker answer than `stopped` -
	// it is the only true one."
	if (lastLife === "") {
		return {
			kind: "unknown",
			detail: `no sign of life yet across ${window} sessions - a fresh enable looks the same`,
		};
	}

	// Alive at some point, but against too thin a window for the counts below
	// to carry weight: a repo nobody has opened in a month, or a machine whose
	// whole hook system has stopped. This is the guard that REPLACES the wall
	// clock rather than merely deleting it - a 14-day limit called every
	// stream dead across the three weeks this repo ran no sessions at all,
	// when in truth nothing had been asked of any of them.
	if (window < SESSION_STALL_THRESHOLD) {
		return {
			kind: "unknown",
			detail: `last sign of life ${stampFor(lastLife, now)}, and only ${window} sessions to judge from`,
		};
	}

	const sinceLife = opportunitiesSince(events, hooks, lastLife);
	if (sinceLife >= SESSION_STALL_THRESHOLD) {
		// The count is met; whether it MEANS anything depends on the entry.
		// Liveness counts every opportunity this repo had, and an opportunity
		// is any session that ran the hook machinery at all - so for an entry
		// whose hooks fire only on a trigger, the count is largely made of
		// sessions that never asked it for anything. Eight subagent sessions
		// in seven minutes, none of them a Write, put a healthy inspector at
		// eight. See `firesEverySession`, which records the entries the table
		// can say this of and why each one does or does not qualify.
		//
		// Deliberately a return rather than a fall-through to the write axis.
		// The two axes move together here: an entry silent on liveness had few
		// triggered sessions by definition, so its narrowed `sinceWrite` is
		// small and would read `recording` - a clean bill handed out on the
		// strength of evidence we just declined to trust. `unknown` says the
		// true thing and accuses no one.
		if (entry.firesEverySession !== true) {
			return {
				kind: "unknown",
				detail: `last sign of life ${stampFor(lastLife, now)}, ${sinceLife} sessions ago, none of which had to trigger it`,
			};
		}
		return {
			kind: "stopped",
			detail: `last sign of life ${stampFor(lastLife, now)}, ${sinceLife} sessions ago`,
		};
	}

	// Alive. Whether it should also have WRITTEN is a separate question, and
	// only askable where the table records a signal for it.
	if (lastWrite === undefined) {
		// One thing is knowable even with no write signal at all: whether the
		// output ever appeared. An entry that names a path which has never
		// been written does not get a clean bill, because there is no history
		// for its quiet to be ordinary against.
		//
		// Deliberately NOT the same test as "the output is old". Age is not
		// evidence - a week-old scribe `.md` means nothing was worth
		// distilling, which is the false alarm the whole write-signal design
		// removes. Absence is different: nothing has ever come out of here,
		// and this table holds no signal saying whether that is expected.
		// `unknown` states exactly that and accuses no one, so it cannot
		// reintroduce a false `stopped`.
		//
		// The case that forced it: all seven enabled plugins read `recording`
		// and `doctor` exited 0 on the real machine, librarian included -
		// whose `lessons/` has never existed here, and whose empty pool is
		// what `onlooker-01x` was opened about. Certifying a machine whose
		// output is known to be missing is the successful-looking silence this
		// command exists to remove.
		//
		// `mtime === null` AND not `unreadable`: a path that could not be
		// listed is unmeasured, not absent, and `judge()` already turns that
		// into its own `unknown` after this returns. Reporting it as "never
		// written" would state more than the walk found.
		if (
			entry.output !== null &&
			fresh !== undefined &&
			fresh.mtime === null &&
			!fresh.unreadable
		) {
			return {
				kind: "unknown",
				detail: `alive since ${stampFor(lastLife, now)}, but ${outputLabel(entry)} has never been written`,
			};
		}
		return {
			kind: "recording",
			detail: `last sign of life ${stampFor(lastLife, now)}`,
		};
	}

	if (lastWrite === "") {
		// Same split `moved` makes below, and for the same reason: on the
		// `output: null` branch the downstream IS the event stream, so "no
		// output written yet" names a file for a stream that writes none.
		// The `(none) last changed` bug one branch down, missed here.
		return {
			kind: "unknown",
			detail: eventsAreTheWriteAxis
				? `alive since ${stampFor(lastLife, now)}, but no ${entry.plugin} event has landed yet`
				: `alive since ${stampFor(lastLife, now)}, but no output written yet`,
		};
	}

	// The write window, and the one place the denominator narrows. Liveness
	// above counts every opportunity this repo had; this counts only the ones
	// in which THIS entry's own trigger fired, because a session that never
	// invoked the entry was never a chance for it to write. lineage measured
	// the difference: six opportunities since its ledger last moved, no file
	// edited in any of them, `lineage-post-tool-use` fired in none of them,
	// and the broad denominator charged it for all six and called a healthy
	// stream `STOPPED` - this document's own false positive, reintroduced by
	// its own denominator. Detection is untouched: five opportunities in which
	// the trigger DID fire with nothing recorded is still the frozen-ledger
	// shape, and still `stopped`.
	//
	// An entry naming no hooks would produce an empty set and could never
	// reach `stopped` on this axis. No table entry has that shape, and if one
	// ever does, resting on liveness alone is the conservative direction taken
	// everywhere else here.
	const triggeredIn = new Set<string>();
	for (const hook of entry.hooks) {
		for (const session of hooks.sessionsByHook[hook] ?? []) {
			triggeredIn.add(session);
		}
	}
	const sinceWrite = opportunitiesSince(events, hooks, lastWrite, triggeredIn);
	// Name the axis that actually moved, which is not always a path.
	// `outputLabel` renders "(none)" for an `output: null` entry, so building
	// this from it alone reports "(none) last changed 2026-08-07" on the one
	// branch where the downstream IS the event stream - a verdict naming a
	// path that does not exist, and less specific than the branch it replaced
	// ("the last event was 2026-08-07").
	const moved = eventsAreTheWriteAxis
		? `the last ${entry.plugin} event landed ${stampFor(lastWrite, now)}`
		: `${outputLabel(entry)} last changed ${stampFor(lastWrite, now)}`;

	if (sinceWrite >= SESSION_STALL_THRESHOLD) {
		return {
			kind: "stopped",
			detail: `${moved}, ${sinceWrite} sessions ago, while the stream kept running`,
		};
	}

	return { kind: "recording", detail: moved };
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
