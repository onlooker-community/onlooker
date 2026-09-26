# Sessions Feed, Over Time — Design

Bead: `onlooker-quhvq4` ([ONL-18](https://linear.app/onlooker/issue/ONL-18)), a
spike under the *Feed is worth opening* milestone. One summary header, two
unused fields surfaced on each row, one optional query parameter. No API
change, no new endpoint.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-24.
Sections marked *(measured)* were computed from this machine's own session
store or read from this repository on 2026-09-24; each names where the fact
came from.

## The bead's premise does not hold *(measured)*

The bead says "most sessions are three events long and did nothing" and treats
that as a property of the feed. It is a property of the **local store**, not of
the feed, and the difference decides what gets built.

Counted across `~/.onlooker/session-history/*.jsonl` on 2026-09-24, twice, by
two independent implementations — a per-file `grep -c` loop and a single `awk`
pass — which agreed exactly:

| prompts per session | sessions | share |
|---|---|---|
| 0 | 24,916 | 70% |
| 1 | 10,643 | 30% |
| 2–5 | 58 | 0% |
| 6–20 | 49 | 0% |
| 21+ | 24 | 0% |
| **total** | **35,690** | mean 3 events each |

So 131 sessions out of 35,690 — 0.4% — involved more than one human turn. The
bead is right about the store.

But `apps/cli/src/sessions.ts:47` sets `DEFAULT_THRESHOLD = 20` and drops any
session with fewer events before upload, and that filter already does the job:

| of sessions clearing 20 events | count | share |
|---|---|---|
| reach the feed | 130 | |
| …with 0 prompts | 0 | 0% |
| …with 1 prompt | 6 | 5% |
| …with 2+ prompts | 124 | 95% |

`event_count >= 20` and `prompts >= 2` select nearly the same 130 rows. **The
feed contains no noise rows to triage.** A ranking or weighting design — the
obvious reading of the bead, and the first thing proposed in conversation —
would have built a scoring system for a problem that does not exist here.

What survives is the milestone's own sentence, now sharper: the rows are
accurate, there are about 130 of them, and it still is not clear what a person
takes away from reading them.

## Why `prompts` is the field that matters *(measured)*

> **Corrected 2026-09-26.** The paragraph that stood here claimed
> `event_count` counts plugin telemetry, and that "a threshold on
> `event_count` is a threshold on how many plugins are installed." That is
> false. A full scan of every event in `~/.onlooker/session-history` returns
> four prefixes and no others — `session` 63,037, `tool` 42,720, `skill` 933,
> `task` 31. Not one plugin event enters that store; the plugins write to
> their own directories. The claim was asserted from the presence of those
> directories without checking what the file actually contains. See
> `2026-09-26-what-counts-as-a-session-design.md`.

`event_count` counts session lifecycle events plus real work — `tool` calls
and `skill` invocations dominate it. So the 20-event threshold at
`apps/cli/src/sessions.ts:47` is twenty pieces of actual work, and a session
that starts, does nothing and ends carries two or three events and never
approaches it. The threshold is sound, for a better reason than this document
originally gave.

`prompts` increments only on `session.prompt`
(`apps/cli/src/sessions.ts:128`), one per human turn. It is the one field no
automation inflates, which is why it separates "I asked once and it ran for an
hour" from "I drove this for two hours" — the distinction the row exists to
show — and why it belongs there even though `event_count` is a fair proxy for
effort.

## What the page answers *(approved)*

**"What did I work on, and when."** Rows remain a history grouped into a
`Panel` per day, newest first. What changes is that the page opens on the shape
of the period rather than the top of a log.

## The header asserts only what it loaded *(approved)*

The fetch is newest-first across all time. It is not a calendar query, so a
header reading "This week" would claim something the data cannot support. It
labels itself by the range it actually holds:

```
41 sessions · 18h 20m · Sep 3 – Sep 24

Mon Sep 22  ████████  4 sessions   6h 20m
Tue Sep 23  █         2 sessions   1h 05m
Wed Sep 24  ██████    7 sessions   8h 40m

Longest  2h 15m · 41 prompts · 2 compactions
```

Bars are proportional to that day's total duration. Not hour-bucketed — that is
a finer grain than the question needs.

When `has_more` is true the first line becomes `most recent 200 sessions · 18h
20m · Sep 3 – Sep 24`, dropping any implication of a total. **The word
"sessions" never appears beside a number the page did not itself count.**

This is the whole reason for choosing a client-side rollup over a server-side
aggregate. Both can be incomplete; only this one can say so on the page. A
server-side `GET /sessions/summary?from=&to=` is correct at any volume and its
incorrectness would be invisible — see *Deferred*.

## Rows surface the fields already fetched *(approved)*

Today (`SessionsPage.tsx:262-273`):

```
9:32 AM   2h 15m   6,311 events   6,311 tool · 100 session · 81 skill
```

After:

```
9:32 AM   2h 15m   41 prompts   2 compactions   6,311 tool · 100 session · 81 skill
```

`prompts` and `compactions` are in every `SessionSummary` already and neither
has ever been displayed. `event_count` comes out: `shapeOf` already renders the
same total broken down by prefix, so the bare number was a second spelling of
information immediately to its right.

`plugins` and `machine_id` stay unshown here. `machine_id` is the subject of
`onlooker-kipn.1` under a different milestone — two machines' sessions look
identical — and belongs to that work rather than this one.

## Fetch change *(approved)*

`listSessions` gains an optional `limit`; the page requests 200.
`apps/web/src/api/sessionsApi.ts:74-86` currently sends only `cursor`, so every
read is the route's default of 50. The route already parses `limit` and clamps
it at `BROWSE_MAX_LIMIT` (200), so nothing server-side changes.

At 130 sessions one request covers the entire history. That is true today and
the header stops claiming otherwise the moment it is not.

## Loading and empty states *(approved)*

The three existing empty states are correct and unchanged.

The header follows the rule the `MachinesCheck` type already enforces on this
page: **it does not render until the sessions read has resolved.** That type
exists because gating on `sessions === null` let a `hasMachines === false`
check run against a default while the real read was in flight, and an account
with zero machines flashed the wrong empty state before correcting itself. A
header computed from a partial list is the same fault with arithmetic attached.

## Tests *(approved)*

Extending `apps/web/src/__tests__/sessions-page.test.tsx`:

1. header totals equal the sum of the rendered rows — not a fixture constant,
   so a rollup that drifts from what is on screen fails
2. header reads "most recent N sessions" when `has_more` is true, and states a
   total when it is false
3. no header at all when there are zero sessions
4. a still-running session (`ended_at: null`) contributes no duration rather
   than a negative one — `durationOf` already returns "Still running", and the
   rollup must not treat that as zero-length silently

Test 1 is the load-bearing one. The others pin wording and edges; that one pins
the claim.

## Deferred

- **Server-side aggregate** (`GET /sessions/summary?from=&to=`) with real
  calendar weeks. Needed when a user's history exceeds what one request can
  cover. File when the header starts saying "most recent 200" routinely.
- **Machine attribution on the row** — `onlooker-kipn.1`.
- **The session concept itself.** 35,690 things are called sessions and 130 are
  sessions in the sense a person means. Subagent spawns and hook-triggered
  shells are counted alongside real conversations. That is upstream of this
  page and overlaps the *Per-day logs* milestone's 150k-file pile; it deserves
  its own bead rather than a fix here.
