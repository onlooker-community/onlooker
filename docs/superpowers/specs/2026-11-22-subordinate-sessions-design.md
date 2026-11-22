# Subordinate Sessions In The Hosted Feed — Design

Bead: `onlooker-kipn.5` (ONL-221). Follows
`2026-09-26-what-counts-as-a-session-design.md`, whose decision was "mint them,
but tag them subordinate".

## Where this starts

The emitter half shipped in the **ecosystem** repo, not marketplace:
`6fab8985` (#576, 2026-11-08). `session.start` now carries, when known:

- `source`: Claude Code's `startup` / `resume` / `clear` / `compact`, from the
  hook's stdin `.source`.
- `attended`: from `CLAUDE_CODE_SESSION_ATTENDED`.
- `parent_session_id`: the spawning session's `CLAUDE_CODE_SESSION_ID`, read
  from the launch environment of `$CLAUDE_PID`.

All three are omitted when unknown, so every record from before #576 lacks
them. On the dogfood machine (2026-11-22), 31 of 36,775 `session.start` records
carry them: 25 attended with no parent, 4 resumes, and 2 with a parent.

Nothing in this repo reads them. The consumer the done-when names, "sessions
per day", is `rollupSessions` (`apps/web/src/lib/sessionRollup.ts`), which home's
Sessions panel and the Sessions page share. It reads hosted summaries, and
those are built by `summarizeSessions` (`apps/cli/src/sessions.ts`), which is
envelope-only on purpose.

## The decision

**The machine derives one bit, `subordinate`, and only that bit leaves it.**

```
subordinate = true   when session.start has parent_session_id,
                     or has attended === false
subordinate = false  when session.start has attended === true and no parent
subordinate = null   when session.start has neither (pre-#576, or no start seen)
```

It's called `subordinate`, not `spawned`, because an unattended start with no
parent (a `claude -p` from cron or a script) wasn't spawned by a session, and it
still isn't a person sitting down to work. The 2026-09-26 spec's own word
covers both cases.

`null` is not `false`. Old rows and sessions whose start fell outside the read
mean "we don't know", and every consumer counts them as it does today.

### What stays on the machine

`parent_session_id`, `source` and the raw `attended` never leave. The hosted
feed can't reconstruct session trees, and that's intended. Questions like
"which mechanism mints these" get answered locally from the event log, which
already has the full fields.

## Layers

### CLI (`apps/cli`)

- `streamEnvelopes` already reads `payload.working_directory` on
  `session.start`, through a callback that only the label code passes. The new
  read follows the same pattern: an optional `onSubordinate(session_id,
  boolean)` callback. The payload reads are type-checked (`typeof
  parent_session_id === "string"`, `attended === true | false`), and nothing
  else is read.
- `summarizeSessions` stays payload-blind. The caller collects the map from the
  callback and attaches `subordinate` to each summary after the fold, with
  `null` for any session not in the map.
- The `EventEnvelope` and `SessionStart` docstrings get one more listed
  exception.

### API (`apps/api`, `packages/db`)

- A migration adds a nullable `subordinate` integer column to
  `session_summaries`, with no default and no backfill.
- `isValidSummary` accepts the field absent, `null`, or boolean. Absent is
  stored as `null`, the same way older CLIs omitting `counts_by_type` are
  handled. `schema_version` stays at 1.
- The upsert writes the field and `listSessionSummaries` returns it.

### Web (`apps/web`)

- `SessionSummary` gains `subordinate: boolean | null`.
- `rollupSessions` leaves `subordinate === true` out of its per-day session
  count and duration. Both the home panel and the Sessions page read it, so
  they still can't disagree.
- The Sessions page list still shows subordinate sessions: the decision says
  they are real work.

## What this does not change

- **The 20-event threshold.** It already keeps nearly every subordinate
  session out of the feed (the 2026-09-26 scan found 0 zero-prompt sessions
  clearing it). Expect the visible change to be small. The bit exists so the
  count is right by construction, not by a threshold happening to catch it.
- **Marketplace's `session-start-tracker.sh`.** It isn't the installed path,
  and it's left alone.

## Delivery

Two PRs, each deployable on its own because every field is optional: API,
migration and CLI together (as ONL-128's #226 did), then web. The plan is
`docs/superpowers/plans/2026-11-22-subordinate-sessions.md`.
