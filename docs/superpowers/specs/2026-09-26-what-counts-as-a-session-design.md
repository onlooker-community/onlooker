# What Counts As A Session — Decision

Bead: `onlooker-kipn.4`, a spike under `onlooker-kipn`. This is the written
answer its done-when asks for, plus the work filed from it.

## Reading this document

Everything under *(measured)* was counted on the dogfood machine on
2026-09-26 by full scan of `~/.onlooker/session-history`, not sampled. The
*(decided)* section was settled with the user on the same day.

## The shape of the problem *(measured)*

35,690 `.jsonl` files, one per session id, averaging 3 events each.

| | |
|---|---|
| sessions with 0 human prompts | 24,916 (70%) |
| sessions with exactly 1 | 10,643 (30%) |
| sessions with 2 or more | 131 (0.4%) |

So 0.4% of what the storage layer calls a session involved more than one human
turn.

**These are machine-minted, and the clustering proves it.** Sorting every
session's first timestamp and measuring the gaps:

| gap to previous start | share |
|---|---|
| ≤ 1 second | 47% |
| ≤ 5 seconds | 77% |
| ≤ 30 seconds | 94% |
| median gap | **1 second** |

Peak day was 2026-08-07 with **9,434 session starts**. Nobody opens nine
thousand conversations in a day, or one per second for hours.

**It is subsiding but not over.** Monthly: Jun 5,571 · Jul 10,578 · Aug 17,471
· Sep 2,141. Recent days run 4–384. An order of magnitude down from the peak
and still far above the ~130 sessions that have ever cleared the feed's
reporting threshold in total.

## What these files actually contain *(measured)*

Full scan of every event in every file — four prefixes, nothing else:

```
63,037  session
42,720  tool
   933  skill
    31  task
```

**No plugin telemetry.** `~/.onlooker` holds stores for archivist, assayer,
bursar, cartographer, compass, counsel, curator, echo, historian, librarian,
lineage, scribe, tribunal and warden, and not one of their events enters
`session-history`. Their stores are separate directories.

This corrects a claim in
`docs/superpowers/specs/2026-09-24-sessions-feed-over-time-design.md`, which
states that `event_count` counts plugin telemetry and that "a threshold on
`event_count` is a threshold on how many plugins are installed." That is false.
`event_count` counts session lifecycle plus real work — tool calls and skill
invocations. See *Correction* below.

## Why the feed is unaffected *(measured)*

`apps/cli/src/sessions.ts:47` drops any session under 20 events before upload.
Of those clearing it: 0 have zero prompts, 6 have one, 124 have two or more.

The threshold works, and it works for a better reason than the ONL-18 spec
gave: `event_count` is dominated by `tool`, so twenty events is twenty pieces
of actual work. A session that starts, does nothing and ends carries two or
three events and never gets near it.

## The gap that makes this unanswerable today *(measured)*

`session.start`'s payload carries exactly three fields: `git_branch`,
`git_commit`, `working_directory`.

It does **not** carry what kind of start it was. Claude Code's SessionStart
hook input distinguishes startup / resume / clear / compact, and
`plugins/onlooker/hooks/scripts/session-start-tracker.sh` (in the
**`marketplace` repo**, not this one) reads only `.session_id` and `.cwd` from
that stdin before calling `onlooker_emit_session_start`.

So the information needed to classify these 35,690 records was available at the
moment each one was written, and was discarded. Nothing downstream can
reconstruct it.

## The decision *(decided)*

**Mint them, but tag them subordinate.**

Not suppressed. A subagent's tool calls are real work, lineage and inspector
consume that stream, and this session alone spawned a dozen agents whose output
is worth attributing. The problem was never that the records exist — it is that
nothing distinguishes them from a person sitting down to work.

Two fields on `session.start` close it:

- **`source`** — pass through what Claude Code already hands the hook.
- **`parent_id`** — set when the session was spawned by another session, null
  when a human started it.

With those, "sessions per day" can mean either thing *deliberately* instead of
by accident, and the file pile becomes prunable by kind rather than by age
alone.

## What this does not claim

**It does not identify the code path minting them.** The evidence here is
statistical — volume, clustering, and the absence of prompts. It establishes
that the source is machine-driven and roughly when it accelerated. It does not
show *which* mechanism (subagent spawn, hook-triggered shell, aborted start,
retry loop) accounts for which share, and nothing here should be read as having
shown that. The `source`/`parent_id` fields exist precisely so the next person
can answer it from data rather than inference.

**It does not explain the June–August surge or the September decline.** Both
are visible and neither is accounted for.

## Correction to the ONL-18 spec

`docs/superpowers/specs/2026-09-24-sessions-feed-over-time-design.md`, in *Why
`prompts` is the field that matters*, asserts that `event_count` counts plugin
telemetry and therefore measures installed plugins rather than work. The full
scan above disproves it: no plugin event ever enters `session-history`.

The spec's *conclusion* survives — `prompts` is still the field a plugin cannot
inflate, and is still the right signal for human effort — but its stated
mechanism was wrong, and it was asserted without being checked. That file is
corrected in the same commit as this one rather than left to mislead.

## Filed from this

- `onlooker-kipn.5` — capture `source` and `parent_id` on `session.start`. Lives
  in the **`marketplace`** repo, not this one.
