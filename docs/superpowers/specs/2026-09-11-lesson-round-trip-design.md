# Lesson Round Trip — Design

Bead: `onlooker-8zv8`. Touches `apps/cli` only. No API, schema, contract or
web change.

`onlooker sync` gains a second half. It pushes approved lessons as it does
today, then reads the hosted delta and mirrors it to disk, so a lesson approved
on one machine can arrive on another.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-11 and are
decisions rather than proposals. Sections marked *(measured)* were read on this
machine on 2026-09-11 at `470d327`; each carries the file and line it came from
so a later reader can re-check rather than re-derive.

## The gap *(measured)*

The receiving half is already built on the server and has never had a caller.

| Layer | State |
|---|---|
| `readLessonDelta` (`apps/api/src/db/lessons.ts:331`) | `WHERE f.user_id = ? AND f.seq > ?`, `ORDER BY f.seq ASC`, fetches `limit + 1` to decide `hasMore` without a count |
| `handleReadLessons` (`apps/api/src/routes/lessons.ts:425`) | validates `since` and `limit`, returns `lessons: [{seq, lesson}]`, `cursor`, `has_more` |
| `apps/cli` | **calls it once, as `/lessons?since=0&limit=1`, to prove the token works** (`apps/cli/src/api.ts:143`) |

Four commands exist — `link`, `sync`, `status`, `doctor` — and none of them
receives anything. Lessons leave a machine and arrive nowhere, including the
same person's second machine.

## Boundary *(approved)*

**In scope:** a delta client, a durable cursor, a CLI-owned mirror on disk, and
sync's second half.

**Out of scope, each for a reason rather than by omission:**

- **Sharing between people.** `visibility` is stored, but `user_id` is the
  security boundary and the code says so deliberately: *"a caller cannot ask
  for someone else's stream, because there is no parameter that would let
  them"* (`apps/api/src/db/lessons.ts:321`) *(measured)*. Changing that needs a
  consent and promotion model, not a query change. This work is one person's
  own machines.
- **Anything reading the mirror.** Nothing on this machine consumes lessons
  today — librarian writes them, and `waypoint`, the retrieval layer that would
  read them, is not installed *(measured)*. That is stated plainly below rather
  than left for a reader to discover.
- **Deletion.** There is no delete path for a lesson; they retire via status,
  and `transitionLesson` writes the `status` column and the `body` in one batch
  (`apps/api/src/db/lessons.ts:297`) *(measured)*, so a retirement arrives as
  an ordinary body update. The mirror never needs to remove a file.
- **A `--no-pull` escape hatch.** Nothing wants one yet.

## Shape *(approved)*

Push first, then pull, in one command.

One command because a step nobody invokes is a step that silently never runs —
the same argument that made the inventory report sync's first act, where the
alternative would have fired for no machine at all. A separate `pull` would go
stale unwatched.

## Where the mirror lives *(approved)*

`~/.onlooker/pool/<id>.json`, one file per lesson, upserted by id.

Upsert by id because the server expects exactly that client. Its own comment:
*"A lesson changed twice appears twice in one window. That is harmless: the
client upserts by id and the later entry wins"* (`lessons.ts:326`)
*(measured)*.

A file per lesson rather than one document, because it mirrors how librarian
already stores lessons, so anything that learns to read one can read the other,
and because a per-lesson file is greppable and diffable by a person.

The directory is **CLI-owned**. It is not written into librarian's tree. A
received lesson has no project key, and inventing one would put a fiction into
another component's storage; worse, sync reads librarian's `approved/` to
decide what to push, so a mirror written there would feed itself back.

### Nobody reads this yet, and that is not a defect *(approved)*

Stated here so it is not discovered later as a surprise. The mirror is inert by
construction until a consumer exists — `waypoint` is the intended one and is
not installed on this machine. This is accepted knowingly: the alternative is
receiving nothing at all, and a mirror that exists is what lets a consumer be
written against real data.

What this must **not** become is a feature that reports success while achieving
nothing. Sync says how many lessons arrived, every run, so an empty mirror is
visible as an empty mirror rather than as silence.

## The cursor rule *(approved)*

**The cursor advances only after the window it describes is durably on disk.**
Never before it, never in the same step.

Order per window: write every lesson file, then write the cursor. If a run dies
between the two, the next run re-fetches from the old cursor and re-upserts,
which costs one redundant window and is otherwise free — upsert by id is
idempotent.

This is the one rule in this design worth reviewing closely, because getting it
backwards is already a filed bug one layer down. `ecosystem-449.55` is
*"librarian's watermark advances through a configuration outage, so wrongly
dropped artifacts are never re-scanned."* A watermark that moves ahead of the
data it claims to describe converts a recoverable interruption into permanent
silent loss, and the loss is invisible precisely because the watermark says
everything is fine. The same shape is available here and is refused by
construction.

The cursor lives in `~/.onlooker/pool/cursor.json`, beside the data it
describes, rather than in `cli.json`. `cli.json` holds durable config including
the machine token; mixing fast-moving sync state into it means a corrupt write
costs the token too.

## Gaps *(approved)*

**A gap stops the run and leaves the cursor where it was.**

`seq` is dense. It is assigned `COALESCE(MAX(seq), 0) + 1` behind a unique
index, and a collision is retried rather than burning the value
(`lessons.ts:134`, `MAX_SEQ_ATTEMPTS`) *(measured)*; no code path deletes a
feed row. So a hole in a returned window is not an artifact of allocation — it
means a row that should exist did not come back.

Pull therefore refuses to advance, reports the gap with the seq it expected and
the seq it got, and exits non-zero. It does **not** reset to zero and
re-mirror: silently re-downloading everything would paper over the one anomaly
`seq` exists to expose, and would look like a slow but healthy run.

## Paging *(approved)*

Follow `has_more` until it is false, writing each window and advancing the
cursor per window rather than once at the end. A first run on an established
account starts at `since=0` and may take several windows; a partial first run
therefore leaves real progress behind rather than starting over.

## What sync reports, and how it fails *(approved)*

The existing push verdict, plus a received line — how many arrived, how many
were new, how many were unchanged — alongside the inventory note that already
rides along.

- **A pull failure is non-fatal to a push that already succeeded.** The push is
  the operation someone ran the command for, and its result must not be erased
  by a later step.
- **It is never silent.** Same reasoning as the inventory report: exiting 0
  while the mirror quietly stops updating is the successful-looking silence
  this repository keeps rediscovering.
- The exit code reflects the worst outcome across push, pull and inventory.

## Testing *(approved)*

- **The cursor rule**, directly: a run that fails mid-window must leave the
  cursor unmoved, and the next run must re-fetch the same window. This is the
  design's central claim and the one whose failure is silent.
- **Idempotence**: pulling the same window twice leaves one file per id.
- **A gap**: a window whose seqs skip a value stops the run, leaves the cursor,
  and names both seqs.
- **Paging**: `has_more` is followed, and the cursor advances per window rather
  than once at the end.
- **Failure isolation**: a refused pull still reports the push verdict, and the
  exit code still reflects the push.
- **An update**: the same id arriving with a changed body replaces the file
  rather than adding one.

## Rollback

One command's second half, and a directory. Reverting the CLI change leaves
`~/.onlooker/pool/` on disk, harmless and unread. No server or schema change to
undo.

## Open questions

None blocking. The two calls most likely to be revisited are recorded as
decisions rather than questions: push-before-pull, which means a run briefly
pulls back what it just pushed, and the name `pool/` for a directory that is a
local mirror of the pool rather than the pool itself.
