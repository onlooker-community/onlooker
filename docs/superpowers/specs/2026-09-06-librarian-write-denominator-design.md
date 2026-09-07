# Librarian's Write Denominator — Design

Bead: `onlooker-kqc4`. Spans three repositories: `onlooker-community/schema`,
`onlooker-community/ecosystem`, and this one. Successor in subject to
`2026-09-05-stream-verdict-conditionality-design.md`, whose `triggeredIn`
narrowing this document extends rather than replaces.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-06 and are
decisions rather than proposals.

Facts about this repository were verified against `main` at `f357132`. Facts
about librarian were read out of
`ecosystem/plugins/librarian/scripts/hooks/librarian-session-end.sh` at
`37bdbe5`, and facts about the event contract out of
`schema/schemas/payload/plugins-memory.json` at `0c4672c`, both on 2026-09-06.

Every line number in this document was read rather than recalled.

## The problem the bead states

`onlooker-ac5` narrowed the write denominator to opportunities in which the
entry's own hooks fired, which fixed lineage's false positive. The narrowing
keys on `entry.hooks` — the whole list — and several entries list a hook the
table itself documents as *not* a write trigger.

The bead records where that is inert (bursar, historian, ecosystem: their
listed hooks fire in essentially every session, so `triggeredIn` is
approximately `sessionsWithRecords` and the narrowing changes nothing) and
where it will bite (librarian: `librarian-session-start` alongside
`librarian-session-end`, no `writeHooks`, and a conditional writer).

The bead also records why it was not fixed in place: the obvious refinement,
`writeHooks ?? hooks`, fixes bursar and historian and does nothing for
librarian, which declares no `writeHooks` at all.

## Why `writeHooks` cannot be the answer *(measured)*

`writeHooks` means, per its own docstring, "the subset of `hooks` whose firing
is reliable evidence that this entry's real, analytical work happened." It is
undefined or empty precisely when the writer is gated or conditional.

Librarian is the conditional case, so its `writeHooks` is empty *by
construction*. The denominator needs a different predicate:

- `writeHooks`: firing implies a write **should have happened**.
- The denominator: firing means the plugin **had a chance** to write and may
  legitimately have declined.

Those are different claims about the same firing, and no rearrangement of the
existing fields expresses the second one.

## Why a per-entry hook list is also not the answer *(measured)*

The bead's own first suggestion — a per-entry "which hooks represent a chance
to write" list — would name `librarian-session-end` for librarian. Reading the
script shows that is still wrong.

`librarian-session-end.sh` is 515 lines with four session-level bail sites
before any candidate is considered. Two of them precede the scan entirely:

| Line | Bail |
|------|------|
| before `:94` | no project key resolved |
| `:94` | `librarian_storage_init ... \|\| exit 0` |
| `:135`–`:147` | zero new archivist artifacts since the watermark |
| `:178`–`:198` | 1.5s SessionEnd budget exceeded before classification |

`librarian-session-end` fires on every session. Most of those firings bail
before the write path is reachable. Counting them as chances to write
reproduces lineage's false positive one entry over, which is exactly what this
bead exists to prevent.

## What the events already say *(measured)*

Librarian emits `librarian.scan.started` at `:124`, after the two pre-scan
bails, and `librarian.scan.complete` on all three terminal paths:

| Site | `outcome` | Classification ran? |
|------|-----------|---------------------|
| `:137` | `empty` | no — archivist had nothing new |
| `:188` | `budget_exceeded` | no — never reached it |
| `:495` | `ok` (`PROPOSED_COUNT > 0`) | yes |
| `:495` | `empty` (`PROPOSED_COUNT == 0`, set at `:491`–`:492`) | yes |

**`outcome: "empty"` is emitted by two paths that mean opposite things** — the
bail that never had a chance, and the full scan that had one and legitimately
declined. Those are the two cases the denominator most needs to separate.

They can be told apart by a second field today: `:137` hard-codes
`artifact_count_in_window: 0` while `:495` passes the real count. Reconstructing
a control-flow fact from two payload fields that were not designed to carry it
is the kind of inference this table's comments refuse to make elsewhere, and it
breaks silently if librarian's payload changes.

So the distinction belongs in the emitter. *(approved)*

## The vocabulary already exists *(measured)*

`schema/schemas/payload/plugins-memory.json:289`–`:316` defines
`librarian.scan.complete`:

- `outcome` enum: `["ok", "empty", "skipped", "budget_exceeded"]`
- `skip_reason` enum: `["archivist_not_present", "memory_path_unresolved",
  "disabled"]`

Librarian emits neither `outcome: "skipped"` nor `skip_reason` anywhere. The
slot for "we did not do the work, and here is why" is present and unused.

This supersedes the first shape considered in conversation, which was to add
`no_new_artifacts` to the `outcome` enum. Reusing `skipped` is strictly
smaller: `outcome` gains no member, its four values stay a clean partition, and
the change is one member on the companion field designed for this.

## Decisions

### 1. Schema: one new `skip_reason` *(approved)*

Add `no_new_artifacts` to `skip_reason`'s enum in
`schemas/payload/plugins-memory.json`, and to librarian's `skip_reason` union at
`src/types.ts:910`, directly below the `outcome` union at `:909`.

`outcome` is untouched.

### 2. Ecosystem: librarian says which case it is *(approved)*

`librarian-session-end.sh:137` emits `outcome: "skipped"` with
`skip_reason: "no_new_artifacts"`, replacing `outcome: "empty"`.

`:188` and `:495` are untouched. After this, `outcome: "empty"` means exactly
one thing: classification ran and proposed nothing.

The payload already carries `candidates_proposed`, `candidates_dropped` and
`artifact_count_in_window`, all permitted by the schema, and the schema's
`additionalProperties: false` allows `skip_reason`.

Two test artifacts name this event type, and neither branches on its `outcome`:
`test/bus-coverage.json:52` lists the type among those an emission test must
cover, and `test/node/check-bus-coverage.test.mjs:65` uses the string as a
sample in a fixture for the coverage gate itself. The bus-coverage gate will
therefore require the changed `:137` emission to still validate, which is that
gate working rather than an obstacle. No code anywhere in the ecosystem tree
reads the `outcome` value to make a decision, so the only consumer of the new
distinction is the one being built in decision 3.

### 3. Onlooker: the denominator counts scans, not firings *(approved)*

For an entry that declares it, the write denominator counts matching events
rather than hook firings. For librarian, a chance to write is a
`librarian.scan.complete` whose `outcome` is `ok` or `empty`.

This requires `StreamEntry` to express "count events of this type whose payload
field is in this set." The table names event *types* today (`events`,
`writeEvents`) and says nothing about payloads, so this is a new field shape
rather than a new value in an existing field. Its design is deferred to the
implementation plan, with one constraint fixed here: it must be a positive set
of accepted values, not a list of excluded ones, so a future `outcome` member
is excluded by default rather than silently counted.

### 4. bursar, historian and ecosystem stay as they are *(approved)*

The bead records the narrowing as inert for all three, because their listed
hooks fire in essentially every session. Applying `writeHooks ?? hooks` to them
would be churn with no behavior change. The reason they are exempt should be
recorded in the table so the next reader does not rediscover it.

## Sequencing

Schema, then ecosystem, then this repository. Each step needs the previous one
released, not merely merged.

The three plugins that share the emit library — librarian, curator, historian —
have emitted nothing since 2026-08-03 (`onlooker-ujtf`). Decision 2 changes an
event that currently never fires, so it cannot be verified end to end until
`ujtf` is resolved and a librarian scan runs on a real session.

### The window between the P1 and this landing

Once `ujtf` is fixed, librarian resumes scanning before this chain completes,
and in principle could read `STOPPED` on the write axis.

Judged not urgent, and deliberately not mitigated *(approved)*: librarian's
verdict comes from the never-written-output branch while `librarian/<key>/
lessons` does not exist, and that directory is not created until a candidate is
actually promoted. An interim measure — making librarian liveness-only — would
be a change made only to be undone.

## Out of scope

- `onlooker-ujtf` itself. This design depends on it being fixed; it does not fix
  it.
- The overloading of `outcome: "empty"` for any plugin other than librarian.
  Curator emits its own `scan.complete` with a `skip_reason` branch
  (`curator-session-start.sh:123`–`:126`) and was not examined.
- Whether `librarian.scan.started` should also be part of the rule. It fires
  after the two pre-scan bails and would be a better denominator than the hook,
  but a worse one than `scan.complete`, which additionally excludes the
  budget-exceeded path.

## Verification

Decisions 1 and 2 are verifiable in their own repositories: the schema package
validates payloads against the JSON Schema, and ecosystem's bats suite and
bus-coverage check exercise emission.

Decision 3 is verifiable here with a fixture, in the manner
`streams.test.ts` already uses: seed `logs/onlooker-events.jsonl` with
`librarian.scan.complete` records carrying each of the four outcomes, and
assert the denominator counts two of them.

The end-to-end claim — that a real librarian scan produces a countable chance —
is only verifiable after `ujtf`, on a machine running the released plugin.
