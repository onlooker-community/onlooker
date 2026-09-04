# Stream Staleness Detection — Design

Bead: `onlooker-jy1`. Applies to `apps/cli`.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-02 and are
decisions rather than proposals. Facts about the current codebase were verified
against `main` at `7af44e2` on that date. Facts about the event streams were
measured against this machine's `~/.onlooker` on that date, by scanning the logs
rather than by reading anyone's description of them — see *Corrections to the
bead* for why that distinction matters here more than usual.

Every number in this document was measured. None was estimated.

## Boundary *(approved)*

**In scope:** a new `onlooker doctor` command, backed by three new modules —
`src/enablement.ts`, `src/eventlog.ts`, `src/streams.ts` — plus
`src/commands/doctor.ts`.

**Out of scope:** `status`, `sync`, `link`, `lessons.ts`, and `pipeline.ts` are
not touched. No label re-padding. Nothing writes to `~/.onlooker`. Nothing
repairs a stopped stream; this command reports and exits. `onlooker-ian`,
`onlooker-33h`, and `onlooker-284` stay open and are not addressed here.

---

## The gap *(approved)*

Six plugin event streams under `~/.onlooker` stopped writing on 2026-08-07.
Nobody noticed for three and a half weeks, and then only because someone went
looking for data to surface in the app.

This is the same defect shape `onlooker-5iy` fixed one level down. `sync` could
not say why the lesson pool was empty; nothing can say whether the arena's
instrumentation is still recording. In both cases the system is quiet, quiet
reads as healthy, and the difference between "nothing happened" and "nothing was
written down" is invisible.

---

## Corrections to the bead *(approved)*

Three of the bead's premises are wrong or incomplete, and each one changes the
design.

### The signals are not just directory listings and mtimes

The bead asserts: *"The counts are directory listings and mtimes; nothing needs a
network call."* The second clause is right. The first is wrong in the direction
that matters — a check built on it would be broken on a healthy machine.

Of the five plugins enabled in this repo, **two write no directory under
`~/.onlooker` at all**:

| Plugin | Directory | Only trace |
|---|---|---|
| `ecosystem` | none | `logs/onlooker-events.jsonl` |
| `inspector` | none | `logs/onlooker-events.jsonl` |
| `lineage` | `lineage/`, `lineage-baselines/` | both |
| `assayer` | `assayer/` | both |
| `bursar` | `bursar/` | both |

A mtime-only check reports 40% of the enabled set as "never ran" while
everything is working. The event log is mandatory, not an enhancement.

### `hook-health.jsonl` is not a stream registry

The prior session's handoff records that the six dead streams were *"verified via
`hook-health.jsonl`: their hooks have not fired once since [2026-08-07]."* That
is true as stated and misleading as used.

Scanning all **199,103 records**, back to the file's first entry on 2026-05-23,
yields **21 distinct hook names**. `archivist`, `scribe`, `counsel`,
`cartographer`, `curator`, and `governance` appear **zero times, ever**. They did
not stop appearing on 2026-08-07. They were never there.

So hook-health cannot enumerate what should be running, and a check that treated
"no failures recorded" as health would give six dead streams a clean bill. It is
useful only as a third axis over a set established elsewhere.

### Archivist is not stopped here — it is not enabled here

The bead names *"`archivist` stopping on 2026-08-07 is cause #1 of the empty
lesson pool."* On this machine archivist is not a fault at all.
`.claude/settings.json` in this repo enables exactly five plugins from
`onlooker-community`: `ecosystem`, `lineage`, `inspector`, `assayer`, `bursar`.
That is precisely the arena set `onlooker-12s` specifies. Archivist and librarian
are deliberately absent.

Reporting archivist as a dead stream would cry wolf about a decision someone made
on purpose. The honest report is the one the handoff's *Risks* section already
reaches for: **the arena's plugin choice is silently a data-collection choice**,
and the empty lesson pool is its consequence rather than a malfunction.

This is why the design reports "not enabled here, but holding data on this
machine" as a distinct, non-fault category.

### Resolved: the bead's open question

The bead asks: *"whether this belongs in the CLI at all, or whether it is a
plugin's job."*

**The CLI.** A monitor that lives inside the thing it monitors dies with it.
Archivist stopped because it was uninstalled; a monitoring plugin is uninstalled
by the same edit to the same file, and then reports nothing forever — which is
indistinguishable from all-healthy. The CLI is the only component installed
outside the marketplace, via Homebrew, so it survives the exact failure mode the
bead exists to catch.

---

## What the machine actually looks like *(measured)*

Three sources, each blind somewhere different.

**`logs/onlooker-events.jsonl`** — 139,299 records, 63 `event_type` values, 2
`adapter_id` values. Namespaced by prefix, so `bursar.*`, `lineage.*`,
`inspector.*` are directly attributable. Full forward scan in Node: **0.25s**.

**`logs/hook-health.jsonl`** — 199,103 records, 21 hooks, with `status`,
`error`, and `duration_ms` per firing. Full forward scan: **0.135s**.

**Directory mtimes** under `~/.onlooker/<stream>/`.

Both logs together cost under half a second. That is cheap enough for an
on-demand diagnostic that no cache, index, or tail-scan heuristic is justified.
The log grows at roughly 21MB/month; at that rate a full scan stays under
1.5 seconds for years, and there is already precedent for archiving.

### Attribution is a join, not a guess

`session.start` payloads carry `working_directory`, `git_branch`, and
`git_commit`. Plugin events carry `project_key` directly:

```json
{"event_type": "lineage.change.recorded",
 "payload": {"project_key": "80523e1cd7d2", "session_id": "a97055a3-...", ...}}
```

So the current project's key is derived by matching `session.start`'s
`working_directory` against the repo root, taking those `session_id`s, and
reading `project_key` off any event they produced. The CLI never reimplements the
hashing scheme, and the join self-verifies: an empty result means "no sessions
recorded for this repo yet," which is a true and useful thing to print.

---

## The staleness rule *(approved)*

**Count trigger firings since the output last moved.**

No wall-clock threshold, no per-plugin cadence vocabulary, no session semantics.

It works because the hook *is* the trigger. If the hook never fires, the output
should not move and there is nothing to report. If the hook fires and the output
does not, something between them is broken. The denominator calibrates itself per
stream, so a bursty plugin cannot false-alarm during a session that never
triggered it — `lineage` writes nothing during a read-only session, but its hook
did not fire either, so the ratio is untouched.

### Validation against the real outage

Bursar's ledgers were frozen from 2026-08-07 until the repair on 2026-09-01
20:41. Measured across that window:

```
bursar-session-end firings:  73   (71 reporting success, 2 failures)
bursar/projects/ writes:      0
```

Every other candidate rule reads bursar as healthy:

| Rule | Verdict during the outage |
|---|---|
| mtime on `bursar/` | healthy — `sessions/` written daily |
| event log only | healthy — `bursar.session.recorded` firing |
| hook-health only | healthy — 71 of 73 successful |
| wall-clock threshold | needs an arbitrary number; false-alarms on vacations |
| session count | 10,218 `session.start` events in the window — useless denominator |
| **firings since output write** | **71 successes, zero output. Caught.** |

### Where the line sits

A single firing with no output movement is not a fault. Every stream in the
table can legitimately lag its trigger by one session — `bursar-session-start`
fires at the top of a session whose output is not written until
`bursar-session-end`. The threshold has to clear that ordering effect without
needing to model it per plugin.

**Five firings.** Five consecutive triggers that produced no output movement is
past any legitimate lag in the current table, and leaves margin for a plugin
that batches its writes. The bursar case clears it by an order of magnitude at
71. The number lives beside the table as a named constant, not scattered through
the verdict logic, so raising it is a one-line change with one place to read.

This is the design's only arbitrary number, and it is recorded as such.

### Degradation

The rule needs both a hook and an output path. Where one is missing it degrades
explicitly rather than silently:

- **No output path** (`inspector`, `ecosystem`): fall back to event recency.
  There is no downstream to compare against, and absence of a directory is
  expected rather than a fault.
- **Output but no hook in hook-health**: report the raw gap, verdict
  **unknown** — never healthy. This follows `status`'s existing rule that a
  thing you could not measure does not get a clean bill.

---

## Architecture *(approved)*

### The table is the design

One entry per known plugin, naming three things:

```ts
{ plugin: "bursar",    output: "bursar/projects", events: "bursar",    hooks: ["bursar-session-start", "bursar-session-end"] }
{ plugin: "inspector", output: null,              events: "inspector", hooks: ["inspector-post-write"] }
```

`bursar.output` is `bursar/projects` — **not** `bursar/sessions`. That one line
is what satisfies the acceptance criterion. The table names each stream's
*analytical output*, never its busiest directory. `bursar/sessions` is input;
it was written daily throughout the outage and is exactly what made the stall
invisible.

`inspector.output` is `null` because it legitimately writes no files.

### Modules

Four new files, matching the existing flat `src/` layout.

| File | One job |
|---|---|
| `src/enablement.ts` | Walk up from cwd for `.claude/settings.json`, merge the user-level settings when present, return the expected plugin set — or `unknown` |

**The user-level path is not `~/.claude/settings.json`.** Claude Code exports
`CLAUDE_CONFIG_DIR` to child processes, and where it is set `$HOME/.claude`
typically does not exist at all — on the machine this design was measured on it
is `~/.claude-personal`. Resolve it in the same order the ecosystem's own
`validate-path.sh:19` does, and that `config-loader.sh` was corrected to use in
`onlooker-community/ecosystem@057a40d` (#237):

```
${CLAUDE_HOME:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}
```

`CLAUDE_HOME` is not exported by Claude Code; `CLAUDE_CONFIG_DIR` is. Mirroring
the chain rather than inventing one keeps the CLI and the plugins from
disagreeing about where a user's settings live. Hardcoding `$HOME/.claude` is
the exact defect #237 fixed across 16 vendored copies: the layer was silently
unreachable, with no error, no warning, and no failing test.
| `src/eventlog.ts` | Stream both JSONL files once each, return last-seen maps and per-hook firing counts |
| `src/streams.ts` | The `STREAMS` table, `surveyStreams()`, verdicts, both renderers |
| `src/commands/doctor.ts` | Thin — survey, render, pick the exit code |

### Verdicts

Three, and two of them are new information:

- **Enabled, no table entry** → reported by name as "no health rule." The
  vocabulary is owned by `onlooker-community/ecosystem` and will grow; a closed
  enum would turn a marketplace release into a hard failure on a healthy
  machine. This mirrors `pipeline.ts`'s `unrecognized` convention exactly.
- **Writing but not enabled here** → present-not-enabled, not a fault. This is
  how archivist reads on this machine. The footer lists **only directories that
  match a `STREAMS` table entry** — not every directory under `~/.onlooker`.
  Without that rule the footer fills with `logs/`, `session-history/`,
  `session-trackers/`, and `compact-trackers/`, which are shared infrastructure
  rather than per-plugin streams, and the one line that matters gets buried in
  a dozen that do not.
- **Enabled, hook succeeding, output stale** → stopped, with the layer named.

### Error handling

`surveyStreams` never throws, the same contract `pipeline.ts` documents: this is
the command someone runs *because* the machine is broken, so a diagnostic that
dies on the state it exists to report is useless at the only moment it matters.
Every failure mode becomes a reported state — an unlistable directory, an
unparseable log line, a missing settings file, a settings file that is not JSON.

A missing expected-set is reported as **unknown**, never guessed. Guessing would
reintroduce the confident-but-wrong sentence this whole line of work exists to
remove.

---

## Output *(approved)*

```
Project:  /Users/meaganwaller/src/github.com/onlooker-community/onlooker
          key 6a7678979e31 · 5 plugins enabled from onlooker-community

  assayer     recording   last event 20h ago
  bursar      STOPPED     bursar-session-end fired 71 times since
                          bursar/projects last changed on 2026-08-07
  ecosystem   recording   last event 2m ago
  inspector   recording   last event 20h ago
  lineage     recording   last event 2m ago

Not enabled here, but holding data on this machine:
  archivist   last wrote 2026-08-07
  scribe      last wrote 2026-08-07
```

Alphabetical, never filesystem order. `pipeline.ts` already establishes why: the
filesystem's listing order is not deterministic across platforms, and a
diagnostic whose output reshuffles between runs on identical disk state is not
one anyone can diff or paste into a bug report with confidence.

## Exit codes *(approved)*

`cli.ts` already documents the convention, and this command reuses it rather
than inventing a third scheme:

- **0** — every enabled stream is recording.
- **1** — a stream has stopped, or a source could not be read. Both are "stop
  and go look." A retry fixes neither.
- **2** — unused here. Nothing in this command is transient.

Exiting non-zero is what makes the command usable from a `SessionStart` hook or
CI, which is the point: detection that depends on a human remembering to look is
the gap that let six streams die unnoticed for three and a half weeks.

## Testing *(approved)*

Tests drive a temp `ONLOOKER_DIR` — already env-injectable through
`config.ts:onlookerDir` — plus an injectable `cwd` for the settings walk, so
nothing reads the developer's real home. Same pattern as `pipeline.test.ts`.

Cases that must be covered, because each is a way the command could lie:

1. The bursar shape — busy input directory, stale output, hook firing
   successfully. Must read **stopped**.
2. A plugin with no output path and recent events. Must read **recording**, not
   "never ran."
3. A plugin enabled with no table entry. Must be **named**, not dropped.
4. A stream writing with no enablement. Must land in the footer as **not a
   fault**.
5. No `.claude/settings.json` anywhere up the tree. Must read **unknown**, not
   an empty expected-set.
6. An unlistable directory, an unparseable log line, and a settings file that is
   not JSON. Must each be reported, and must not throw.
7. A stream with output but no hook in hook-health. Must read **unknown**, never
   healthy.

## Follow-ups not taken here

- **Per-stream event semantics.** `bursar.rollup.skipped` occurs 4,739 times;
  a stall can be spelled as a success-shaped event repeated thousands of times.
  Encoding which event types mean trouble would catch stalls all three axes
  miss, at the cost of the richest vocabulary to maintain and the one most
  likely to go quietly stale. Deferred deliberately; file a bead if the
  three-axis version proves insufficient.
- **`ecosystem-2vo` is fixed upstream as of 2026-09-02.**
  `onlooker-community/ecosystem@887e227` (#233) clamps `stale_after` to
  `timeout`, shipped in **bursar 0.4.3**, installed here the same day. That
  commit independently corroborates this design's central premise: it records
  ten ledgers frozen between Jun 20 and Aug 7 while **all 110 of those hook
  runs logged `status=success` with `error=null`**. A check reading hook
  health alone would have called that machine healthy for seven weeks.
  This command detects the shape; it does not repair it.
- **Repair actions.** `doctor` reports. It does not clear locks, restart
  streams, or edit settings.
