# Stream Verdict Conditionality — Design

Bead: `onlooker-ac5`. Applies to `apps/cli`. Successor to
`2026-09-02-stream-staleness-detection-design.md`, which this document amends
rather than replaces.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-05 and are
decisions rather than proposals. Facts about the current codebase were verified
against `main` at `11ca076` on that date. Facts about the event streams were
measured against this machine's `~/.onlooker` on that date, by scanning
`logs/onlooker-events.jsonl` and `logs/hook-health.jsonl` directly.

Every number in this document was measured. None was estimated.

## The bead is half stale, and that matters *(measured)*

`onlooker-ac5` names two failure directions. Only one of them is still real.

Every comment on the bead was written between 01:19 and 02:22 on 2026-09-04.
`280248b` — which added `RECORDING_FRESHNESS_LIMIT_MS` — was committed later
that morning. The bead's evidence therefore predates its own partial fix, and
anyone picking this up from the bead text alone would rebuild something that
already exists.

**The false negative is closed.** All seventeen table entries were run through
the current judge against the real `~/.onlooker`, with every entry
force-enabled through an isolated `configDir`:

```
counsel    unknown  no evidence newer than 2026-08-02 - too old to certify as recording
governor   unknown  no evidence newer than 2026-08-08 - too old to certify as recording
tribunal   unknown  no evidence newer than 2026-08-08 - too old to certify as recording
```

Those three are the bead's own named live casualties. None of them reads
`recording`. No stream on this machine now receives a wrong clean bill.

**The false positive is open.** It cannot be reproduced against this machine —
the affected streams are all dead here, so they never reach the suspect branch
— so it was reproduced on synthetic fixtures against the real `surveyStreams`.
All three fire:

| Fixture | Verdict |
| --- | --- |
| scribe: healthy, nothing worth distilling for a week | `stopped` — `events since 2026-09-05, but scribe/* last changed on 2026-08-29` |
| curator: clean repo, findings last written in June | `stopped` — `events since 2026-09-05, but curator/*/findings last changed on 2026-06-01` |
| compass: one hour of read-only Bash | `stopped` — `compass-bash-gate fired 2026-09-05, but the last event was 2026-09-05` |

**A third problem, not in the bead.** `unknown` now carries twelve of the
seventeen verdicts. counsel, governor and tribunal stopped on a known date and
have produced nothing since, yet the command answers "I cannot tell." The
14-day bound converted false confidence into honest abstention, which is
strictly better and still is not the diagnosis this command exists to give.

## What the event data actually shows *(measured)*

Two measurements drove the design more than anything else.

### Conditionality is per event type, not per plugin

```
governor.session.complete   2774      tribunal.session.start   145
governor.gate.checked         84      tribunal.gate.blocked     43
curator.scan.complete       4894      warden.gate.blocked        8
counsel.brief.generated       32      warden.threat.detected     1
```

`governor.session.complete` fires on every session and implies nothing about
whether governor wrote anything. `governor.gate.checked` fires only when a gate
is checked. The `STREAMS` table keys events by prefix — `events: ["governor"]`
— and `lastByPrefix` takes the newest across the whole prefix, so the
unconditional type masks the conditional ones.

That masking is harmless for a liveness question ("did this plugin run?") and
fatal for a write question ("should its output have moved?"). Any field that
answers the write question must therefore name **full event types, not
prefixes**.

### Several entries have no unconditional event at all

counsel emits only `counsel.brief.generated`, and only when it writes the
brief. warden emits only on a blocked gate or a detected threat. compass emits
only on a write-pattern match. For these, events cannot be the liveness axis.

Hook firings can be, for every entry: `hook_health_register` runs before a
hook's bail paths, and hook-health's `EXIT` trap logs the firing
unconditionally. Measured against this repo's own sessions since 2026-08-08 —
`lineage-post-tool-use` 2678 firings, `bursar-session-end` 165, every
not-enabled plugin `(never)`. For an *enabled* plugin, hooks firing means it is
loaded and running; zero firings across many sessions means it is not.

## Root cause *(approved)*

`writeHooks` answers one question: *does this hook firing imply a write was
due?* When it is absent, `computeVerdict` falls back to comparing event recency
against output mtime — which silently substitutes a different question, *does
this event imply a write was due?*, that the table never asked and that is
false for most of the entries it is applied to.

The bead says "eight of the fifteen table entries." Both numbers have moved.
Counted against `main` at `11ca076`, **twelve of seventeen** entries declare no
`writeHooks` — archivist, assayer, cartographer, counsel, curator, echo,
governor, librarian, lineage, scribe, tribunal, warden. Only bursar, compass,
ecosystem, historian and inspector have one. The exposure is wider than the
bead records, not narrower.

The `output: null` branch makes the mirror-image substitution one level up:
*does this hook firing imply an emission was due?* That is false for compass,
whose `compass-bash-gate` fires on every Bash call and emits only on a
write-pattern match.

Both are the same defect. An implication is assumed where the table records
none.

## The fix *(approved)*

### One new field

```ts
/** Event types whose emission implies the analytical output was written. */
writeEvents?: readonly string[];
```

The exact mirror of `writeHooks`, one level down, and populated the same way —
per entry, from the plugin source, with the reasoning recorded in the entry's
own comment.

Known assignments, verified against the plugin sources:

- `lineage`: `["lineage.change.recorded"]`. Emitted at the ledger write site
  (`lineage-post-tool-use.sh:261`, `:340`) — the event and the write are the
  same code path.
- `counsel`: `["counsel.brief.generated"]`. Emitted when the brief is written.
- `scribe`, `curator`, `echo`, `tribunal`: none. `scribe-stop.sh` has four bail
  paths before it writes; `curator.scan.complete` fires on every scan whether
  or not findings change.

The remaining entries are settled by the verification pass below.

### The rule

The current branches ask two different questions with two different counters —
hook firings on one path, a timestamp gap on the other. This design collapses
them into one question asked of every entry, with the table deciding only
whether the second half of it is answerable.

Two quantities per entry:

- **`alive`** — did this plugin run recently? True if any hook in `entry.hooks`
  fired, or any `entry.events` prefix landed, within the window. Available for
  every entry, because hook-health registers a firing unconditionally.
- **`lastWrite`** — when did the analytical output last actually move? The
  newest of the output mtime and any `writeEvents` timestamp. **Defined only
  when `writeSignals = writeHooks ∪ writeEvents` is non-empty.** When the set
  is empty, there is no signal in this table that distinguishes "wrote
  nothing" from "had nothing to write," and `lastWrite` does not exist —
  output mtime alone is not a substitute for it.

The verdict:

| `alive` | `lastWrite` | Verdict |
| --- | --- | --- |
| no | — | `stopped`, naming the opportunity count it was silent across |
| yes | undefined | `recording` — the plugin runs; whether it writes is its own business |
| yes | recent | `recording` |
| yes | stale past the window | `stopped`, naming the opportunity count since the last write |

Both `stopped` rows use the same denominator — opportunities, defined below —
and neither consults wall time.

This is what restores full detection for lineage: `lineage.change.recorded` is
a `writeEvent`, so `lastWrite` is defined, and writes stopping while
`lineage-post-tool-use` fires 2678 times lands on the last row rather than
reading `recording`. It is also what fixes scribe and curator: no
`writeSignals`, so `lastWrite` is undefined, so a week-old `.md` reaches the
second row instead of `stopped`.

Note the inversion this makes explicit. Today the firing count is keyed on
`writeHooks` — the trigger — and compared against output. Here the count is of
*opportunities*, the liveness axis is the plugin's whole hook and event set, and
`writeSignals` only decides whether the write question gets asked at all. That
removes the need for `writeHooks` and `writeEvents` to be counted differently
from one another, which is what made an event-shaped write signal awkward to
express under the old rule.

`RECORDING_FRESHNESS_LIMIT_MS` disappears from both paths, replaced by the
window rather than merely deleted — bursar reaches that line today. The
reasoning it encodes survives intact: a count that never crosses its threshold
is not evidence of health, because a plugin that stopped entirely never crosses
it either. Only the unit changes, from wall-clock days to opportunities.

### The window: opportunities, not sessions *(amended 2026-09-05)*

An earlier draft of this section counted **this repo's own sessions**. That
does not work, and the correction is the most important measurement in this
document.

`session.start` events include subagent sessions. This repo logged 246 of them
since the 2026-08-07 outage, but 240 were subagent sessions in which the hook
set never ran at all — they were never an opportunity for any plugin to act.
The proof is a single block of **91 consecutive sessions, spanning 27 hours on
2026-09-03 and 2026-09-04, in which not one hook fired**: the subagent burst
from this feature's predecessor being implemented. Every plugin measured shows
a longest-silent-run of exactly 91, ecosystem across all 11,422 sessions
included, because 91 is a property of the session stream rather than of any
plugin.

That sets a noise floor no threshold can clear. A value must exceed 91 to
avoid false alarms, and only 35 sessions elapsed across the three and a half
weeks the outage went unnoticed. **No value satisfies both.** A raw session
count is the wrong unit.

**The window is counted in opportunities**: sessions in which the hook
machinery demonstrably ran, evidenced by a hook-health record for that
session. A subagent session that runs no hooks contributes nothing to any
denominator, which is correct — nothing was asked of any plugin during it.

Recalibrated on that denominator, for the four plugins with hook-health
history in this repo:

| plugin | opportunities since 2026-08-30 | fired in | longest silent run |
| --- | --- | --- | --- |
| bursar | 6 | 6 | 0 |
| lineage | 6 | 5 | 1 |
| inspector | 6 | 5 | 1 |
| assayer | 6 | 5 | 1 |

The noise floor drops from 91 to **1**, and **6** opportunities have elapsed
since the outage. Floor and ceiling now separate.

### `SESSION_STALL_THRESHOLD` = 5

This design's one new arbitrary number, recorded as such exactly like
`STALL_THRESHOLD` and `CADENCE_FLOOR_MULTIPLIER` before it — but chosen from
the table above rather than picked and justified afterward, which is the
failure mode the 14-day constant represents.

Five sits above the measured floor of 1 with margin, and at or below the 6
opportunities that have elapsed since the outage, so counsel would be reported
`stopped` now rather than `unknown`. It is also the same value as
`STALL_THRESHOLD`, for the same underlying reason: every stream may
legitimately lag its trigger by about one opportunity, and five clears that
with room.

**The sample is thin, and that is recorded rather than hidden.** Every enabled
plugin's hook-health history begins on 2026-08-30, so the floor of 1 rests on
six opportunities. Rechecking it once the enabled set has roughly a month of
history is filed as `onlooker-run`. The number is correct on the evidence
available and is not claimed to be more than that.

### When the rule refuses to judge

**If fewer than `SESSION_STALL_THRESHOLD` opportunities have elapsed, no
`stopped` verdict is reachable and the verdict is `unknown`.** This is the
case that matters most and the one a wall clock gets backwards. A plugin
enabled an hour ago, or a repo nobody has opened in a month, has not had the
opportunities that would make its silence mean anything. `unknown` there is
not a weaker answer than `stopped` — it is the only true one.

This is why the window **replaces** `RECORDING_FRESHNESS_LIMIT_MS` rather than
sitting beside it. This repo ran no sessions at all between 2026-08-08 and
2026-08-29. A 14-day clock calls every stream dead across that three-week
hole, when in truth nothing was asked of any of them; an opportunity count
abstains there correctly, and then reports counsel `stopped` once real
opportunities resume and it produces nothing across them.

### The reference-hook circularity, and its bound

An opportunity is established by *any* hook-health record for the session, not
by a nominated reference hook. That matters because nominating one — an
ecosystem tracker, say — would make ecosystem's own verdict circular, judging
it against a denominator it alone defines.

Using any record leaves a narrower, acknowledged limitation: if the entire
hook system stops, every denominator goes to zero and every verdict degrades
to `unknown` rather than `stopped`. That is the correct failure direction —
the survey cannot measure anything, so it certifies nothing — and it is the
same promise `events.missing` and `measurable.length === 0` already make.

It also resolves compass without a special case: `compass-bash-gate` is in
`hooks`, so it counts toward liveness, and is not in `writeEvents`, so an hour
of read-only Bash can no longer produce `stopped`.

### The same circularity exists one level down, on the event side *(amended 2026-09-05)*

The bound above was written about hook records and is incomplete. Found during
implementation, confirmed twice by running the built code.

An opportunity requires a `session.start` event, because that is what
`sessionStarts` is built from. `session` is one of ecosystem's own tracked
prefixes (`events: ["session", "tool", "skill", "memory", "task"]`). For an
`output: null` entry the downstream axis is the newest event across those
prefixes — so ecosystem's `lastWrite` is always at least as new as the newest
opportunity, `opportunitiesSince(…, lastWrite)` is pinned at **0** by
construction, and ecosystem can never reach `stopped` on its write axis.

The cost is specific and bad: ecosystem's trackers dying on 2026-08-07 while
its hooks kept firing is the incident this entire feature was built to catch,
and it is exactly the shape this axis exists for. Liveness still catches it if
the hooks stop too, but the hooks did not stop.

**Resolution: for an `output: null` entry the downstream axis is
`writeEvents`, not every prefix in `events`.** ecosystem names its
non-`session` types there; the denominator's own event type is simply not one
of the signals it is judged against. The circularity disappears because the
table can now say which events mean real work, which is the same thing
`writeEvents` already does for every other entry — no new concept, and no
special case buried in the scan.

This tightens the rule rather than loosening it: an entry that names no
`writeEvents` has no downstream axis at all and is judged on liveness alone,
which is the conservative direction already chosen everywhere else in this
document.

### Detail strings must survive a sub-day gap

`compass-bash-gate fired 2026-09-05, but the last event was 2026-09-05` is a
verdict that contradicts its own explanation. The real gap is 2h55m; the
detail renders dates only. Any detail comparing two timestamps less than a day
apart must include the time.

## Architecture *(approved)*

No new modules. The change is contained to:

- `apps/cli/src/streams.ts` — the `StreamEntry.writeEvents` field, its
  per-entry values and comments, the restructured `computeVerdict`, the new
  threshold, and the removal of `RECORDING_FRESHNESS_LIMIT_MS`.
- `apps/cli/src/eventlog.ts` — both scans gain what the opportunity count
  needs, which neither currently retains:
  - `scanEvents` already parses `session.start` events with
    `working_directory` to build `sessionIds`, and discards the timestamps.
    `EventScan` gains those timestamps so this repo's sessions can be ordered
    and counted from a given moment.
  - `scanHooks` aggregates by hook name and does not retain which sessions it
    saw at all. `HookScan` gains the set of sessions in which any hook fired,
    which is what turns a session into an opportunity.

An opportunity is the intersection: a session of this repo's that also appears
in the hook scan. Neither source can produce it alone, which is why both
change.

`RECORDING_FRESHNESS_LIMIT_MS` is exported and referenced by name in
`streams.test.ts`. Removing it is a deliberate, breaking change to this
module's surface, not an oversight.

### Error handling

Unchanged in kind: a source that cannot be read yields `unknown`, never
`recording`. The existing `events.missing` and `measurable.length === 0` guards
keep their current behavior. The new denominator inherits the same rule — if
the opportunity count cannot be established, the verdict is `unknown`.

## Verification pass *(approved)*

Every one of the seventeen entries gets `writeEvents` set from its plugin
source, the same way the original heartbeat audit was done. For each entry,
record in its table comment: which event types it emits, which of them are
emitted only when the output is written, and the file and line that shows it.

An entry whose sources do not clearly settle the question gets no
`writeEvents` — the conservative direction, since an empty `writeSignals` set
routes to liveness rather than to a wrong `stopped`.

## Testing *(approved)*

Existing pattern: `machine()` fixtures, temp `ONLOOKER_DIR`, injected `now`.

Regression tests for the three reproduced false positives — scribe with a
week-old `.md`, curator with June findings, compass after read-only Bash — each
asserting the verdict is not `stopped`.

The one this design must not lose: lineage with `lineage-post-tool-use` firing
and `lineage.change.recorded` stopped must read `stopped`. Under today's code
that case is a false negative; under the new rule `writeEvents` catches it. A
test that passes both before and after is not exercising the change.

The idle-machine case: a stream silent across a period with too few
opportunities reads `unknown`, not `stopped`. This is the case
`RECORDING_FRESHNESS_LIMIT_MS` gets wrong and is the reason it is being
removed, so it needs a test that would fail against the old constant.

The subagent case, which is the measurement that changed this design and so
must not regress: a fixture with many sessions of this repo's but hook-health
records for only a few of them must count only the few. Build it at the shape
that was measured — on the order of ninety sessions, no hook records for any
of them — and assert the stream reads `unknown` rather than `stopped`. Against
a raw `session.start` denominator this test fails; that is the point of it.

## Follow-ups not taken here

- **Per-event-type liveness.** `lastByPrefix` collapses all of a plugin's event
  types into one timestamp. Correct for liveness, and this design relies on
  that; a future write question at finer granularity would need the scan to
  retain more.
- **`onlooker-7fr`** (archivist emits `onlooker.artifact.ready`, so no prefix
  identifies it) is untouched. archivist has no distinguishing event and
  reaches liveness through its hooks alone.
- The remaining doctor beads — `onlooker-325`, `onlooker-hnf`, `onlooker-mx5`,
  `onlooker-cbk`, `onlooker-a3y`, `onlooker-d7g` — are unaffected by this
  change and stay open.
