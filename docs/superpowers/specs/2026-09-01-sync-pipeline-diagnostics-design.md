# Sync Pipeline Diagnostics — Design

Bead: `onlooker-5iy`. Applies to `apps/cli`.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-01 and are
decisions rather than proposals. Facts about the current codebase were verified
against `main` at `d34639f` on that date. Facts about librarian's on-disk layout
were verified against `onlooker-community/ecosystem` at `35c2729`, by reading
the shipped scripts rather than its documentation — see *Corrections to the
bead* for why that distinction matters.

## Boundary *(approved)*

**In scope:** a new `apps/cli/src/pipeline.ts` that counts what sits at each
stage of the lesson pipeline on disk, a clause appended to `sync`'s empty-pool
message, and a `Pipeline:` block in `status`.

**Out of scope:** `discoverApproved` and `lessons.ts` are not touched. Nothing
reads `~/.claude`. `onlooker-ian` (status reads every approved lesson to count
them) stays open and is not addressed here.

---

## The gap *(approved)*

`onlooker sync` reports `Nothing to sync: no approved lessons yet.` That
sentence is true in at least four different situations that call for four
different responses, and the CLI cannot say which one you are in.

`sync` already draws two distinctions well. `no-onlooker-dir` says no plugin has
run here; `no-librarian-dir` says librarian specifically has not. The gap opens
after that: once `librarian/<key>/` exists, everything downstream collapses into
one sentence.

This is the failure shape this repo keeps finding in its own code. The command
exits 0, says something accurate, and hides which of several things is wrong.

---

## Corrections to the bead *(approved)*

The bead was written before anyone had read librarian's storage layer. Three of
its premises are wrong, and each one changes the design.

### The counts are not all directory listings

The bead asserts "The counts are all directory listings; nothing needs a network
call." The second clause is right and the first is not.
`librarian-lesson-storage.sh:4-8` gives the authoritative layout:

```
<project_dir>/lessons/proposals/<ulid>.json   awaiting human confirmation
<project_dir>/lessons/approved/<ulid>.json    jury passed
<project_dir>/lessons/declined.jsonl          append-only, never re-judged
```

Every stage between "a proposal exists" and "a lesson is approved" is a `status`
field *inside* each JSON file. The two states the bead most wants to separate —
unconfirmed, and confirmed-awaiting-jury — are both `lessons/proposals/*.json`.
No directory listing can split them. The survey must open each file.

### There are five statuses, not three

From `librarian-lesson-review.sh` and `librarian-lesson-promote.sh:64-74`:

| status | meaning | the response it calls for |
|---|---|---|
| `pending` | awaiting human review | run `/librarian review` |
| `confirmed` | awaiting the jury | investigate the gate |
| `approved`, no `promoted_at` | judged, awaiting promotion | run promote |
| `rejected`, no `promoted_at` | judged, awaiting promotion | run promote → declined |
| `passed` | a human passed on it | nothing; it has its own durable record |

`approved`-or-`rejected`-but-unpromoted is a real stall the bead has no slot
for, and it is precisely the shape a version skew leaves behind: judged by
machinery that existed, awaiting machinery that did not.

### `librarian/<key>/proposals/` is not part of this pipeline

Fifteen of the sixteen project keys on this machine have a `proposals/`
directory directly under the key. That is librarian's **memory** proposal queue,
held apart from lessons deliberately — `librarian-lesson-storage.sh:8` says so
in as many words. Counting it here would report memory candidates as lesson
candidates. Only `<key>/lessons/` is in scope.

### A note on the source

`ecosystem/docs/lesson-promotion-pipeline.md` still reads **"Status: Not
started."** It is stale by roughly three weeks; `librarian-lesson-transform.sh`,
`-review.sh`, `-judge.sh`, `-promote.sh` and `-storage.sh` are all shipped. The
scripts are the contract. The doc is not.

---

## What it does *(approved)*

### One module, one reader, two renderers

`sync` and `status` must never describe the same disk state in different words,
so the vocabulary lives in exactly one place:

```ts
export interface PipelineSurvey {
  lessonDirs: number;                    // project keys with a lessons/ dir
  pendingReview: number;                 // status: pending
  awaitingJury: number;                  // status: confirmed
  awaitingPromotion: number;             // status: approved|rejected, no promoted_at
  passed: number;                        // status: passed
  declined: number;                      // non-empty lines in declined.jsonl
  unrecognized: Record<string, number>;  // status -> count, named not dropped
  unreadable: number;                    // files that would not parse
}

export function surveyPipeline(env?: NodeJS.ProcessEnv): PipelineSurvey;
export function pipelineClause(survey: PipelineSurvey): string;   // sync's tail
export function pipelineLines(survey: PipelineSurvey): string[];  // status's block
```

It walks the same `librarian/<key>` keys `discoverApproved` walks, reading
`<key>/lessons/proposals/*.json` and `<key>/lessons/declined.jsonl`, and
aggregates across keys the way `discoverApproved` does.

### Why a new module rather than extending `lessons.ts`

`lessons.ts` owns the `ZLesson` pool: what `sync` can send, held to the schema
`apps/api` enforces. A proposal is a different shape, from a different repo,
with a status vocabulary `ZLesson` does not share — `ZLesson`'s statuses are
`active | refuted | superseded | retracted`, and a proposal is never any of
them. Putting both in one file would weld two contracts together and would put
every existing `discoverApproved` test on a surface it does not test.

Keeping them apart also means `sync`'s existing path is untouched by this
change, which is the safest place for a diagnostic feature to sit.

### Promoted proposals are excluded from every bucket

A promoted proposal keeps its file in `proposals/` forever.
`librarian-lesson-storage.sh:184` is unusually loud about why: "proposals/ IS
THE SOLE DEDUP SOURCE FOR AN APPROVED LESSON. PRUNING proposals/ SILENTLY BREAKS
DEDUP." So `promoted_at` being present means the proposal is spent — its outcome
is already counted downstream, in `approved/` or in `declined.jsonl`. Counting
it again as a stall would report finished work as stuck, and the count would
grow forever.

### Unknown statuses are named, not dropped *(approved)*

The CLI reads a vocabulary another repo owns and can extend without telling it.
A survey that silently ignored an unfamiliar status would under-report a real
stall and print a confident total — the exact defect this bead exists to fix,
reintroduced one layer down. So unrecognized statuses are counted by name and
rendered as their own line. Drift becomes visible instead of becoming wrong.

The alternative, a strict closed enum that errors on anything unfamiliar, was
rejected: a librarian release that adds a status would turn `sync` and `status`
into hard failures on a machine that is otherwise healthy.

### Four zero-states *(approved)*

The disk draws a distinction the bead did not have. All fifteen genuine project
keys have no `lessons/` directory at all — only the fixture key does. So an
empty pool is not one condition:

| condition | what it means |
|---|---|
| no `librarian/` | existing `no-librarian-dir` sentence, unchanged |
| `librarian/` exists, `lessonDirs === 0` | librarian has run here, but its lesson pipeline never has |
| `lessonDirs > 0`, every count zero | the lesson pipeline has run and proposed nothing |
| any count non-zero | name the stages that are holding something |

The third case names archivist and librarian as the thing to check without
asserting anything about them. The CLI cannot see whether a plugin is enabled —
that state lives in `~/.claude`, at project and user scope, in a layout this
repo does not own. Probing it was considered and rejected; a confident claim the
CLI cannot verify is worse than a pointer it can.

### Output *(approved)*

`sync` keeps its single-sentence contract and appends the counts inline. It is
run non-interactively and in CI, where a taller message is a cost.

```
$ onlooker sync
Nothing to sync: no approved lessons yet - 0 pending review, 2 confirmed and
awaiting a jury, 0 judged and awaiting promotion.
```

#### Which counts appear

The three **stall stages** — pending review, awaiting a jury, awaiting
promotion — are always named, in pipeline order, including at zero. A zero is
information here: `2 confirmed and awaiting a jury, 0 pending review` says the
stall is not being fed, which is the difference between a backlog and a
blockage. Listing all three unconditionally also means there is no rule to
remember and one output to test.

The **exceptional counts** — `unreadable`, and each entry in `unrecognized` —
append only when non-zero, because they describe a fault rather than a stage.
`passed` and `declined` are terminal human and jury decisions rather than
stalls: `declined` appears in `status` always (a jury declining everything is
the thing you would want to see), `passed` only when non-zero.

This is a small divergence from the mockup approved in conversation, which
showed two clauses ordered non-zero-first. Pipeline order with no omissions is
deterministic and testable; the approved wording of each clause is unchanged.

At the third zero-state:

```
$ onlooker sync
Nothing to sync: no approved lessons yet, and nothing at any earlier stage
either - librarian has run here but has proposed no lessons. Check that
archivist and librarian are enabled.
```

`status` is the command you run to find out what is broken, so it always shows
the full breakdown:

```
$ onlooker status
API:      https://api.onlooker.dev
Config:   /Users/you/.onlooker/cli.json
Token:    accepted
Lessons:  0 approved lessons ready to sync
Pipeline: 0 pending review
          2 confirmed, awaiting a jury
          0 judged, awaiting promotion
          0 declined
```

`status` pads every label to the longest, which is currently `Lessons:`.
`Pipeline:` is one character wider, so every label re-pads by one column. The
comment above that block already explains the rule; it needs updating to name
the new longest label.

---

## Error handling *(approved)*

The survey never throws. `status` is the command you reach for *because*
something is wrong, and a diagnostic that dies on the state it was built to
report is useless at the only moment it matters.

- A proposal that will not parse is counted into `unreadable` and reported. It
  is never silently skipped — an unreadable file is itself a finding.
- A project key with no `lessons/` directory is skipped. That is the normal
  case, not an error.
- A missing `declined.jsonl` counts zero.
- An unfamiliar status goes into `unrecognized` under its own name.

`declined.jsonl` is counted by non-empty lines rather than by parsing each one.
It is append-only and never re-read by librarian, so a torn final write should
not be able to break a count, and the count does not depend on the entry shape.

---

## Testing *(approved)*

Unit tests for `surveyPipeline` over temp directories, following the
`ONLOOKER_DIR` pattern `sync.test.ts` already uses:

- each status counted into its own bucket
- statuses mixed across several project keys, aggregating correctly
- `promoted_at` present excludes a proposal from every bucket
- a malformed proposal counts as `unreadable` rather than aborting the survey
- a project key with no `lessons/` directory is skipped
- `declined.jsonl` line counting, including a file with no trailing newline
- an unrecognized status reaches `unrecognized` under its own name

Then the message assertions: `sync.test.ts`'s existing "succeeds with nothing to
do when no lesson is approved" case changes, plus a case for each zero-state;
and a `Pipeline:` block case in `status.test.ts`, including the re-padding.

---

## What this does not fix

The pool on this machine will still be empty after this ships. That is the
point: the change makes the reason legible, it does not produce lessons. The
three causes recorded in `onlooker-12s` are unaffected — archivist and librarian
are installed nowhere, and the tribunal jury was measured blocking 9 of 10
verdicts at a 0.75 threshold (`ecosystem-449.17`).

One correction to the record while it is in view: the two proposals under
`74a96f183d5e` that `ecosystem-e7n` tracks are fixtures, not stranded lessons.
Real proposals are ULID-named (`librarian-lesson-storage.sh:58`) and `js01` is
not a ULID; the key carries none of the `manifest.json`, `last_scan.json` or
`tombstones/` that all fifteen genuine keys have; and the directory and both
files share one mtime equal to the `confirmed_at` they carry. Evidence is
recorded on that bead. It does not change this design — the survey counts what
is on disk, and a fixture in `lessons/proposals/` is a proposal in
`lessons/proposals/` as far as a diagnostic is concerned.
