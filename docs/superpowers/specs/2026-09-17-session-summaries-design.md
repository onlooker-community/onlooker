# Session Summaries — Design

Bead: `onlooker-kipn`. Spans `apps/cli`, `packages/db`, `packages/api-contract`,
`apps/api`, and `apps/web` — in that order of weight. The page is the last and
smallest piece.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-17.
Sections marked *(measured)* were read on this machine on 2026-09-17; each names
where the number came from.

## The gap *(measured)*

The hosted database holds `users`, `sessions` (auth sessions, not agent
sessions), `lessons`, `lesson_feed`, machine tokens, and machine inventory. It
knows nothing observability-shaped.

`apps/web/src/pages/ActivityPage.tsx` is already a real feed — day grouping,
designed empty states, cursor pagination — and its rows are lesson events only:
`describeKind` maps `create` to "Published" and `status` to "Status changed",
and every row links to `/lessons/:id`. It is empty because lesson sharing does
not exist yet, not because the page is unfinished.

Meanwhile the local side records a great deal.
`~/.onlooker/logs/onlooker-events.jsonl` is **93MB**, growing ~21MB a month
*(the 70MB figure in `apps/cli/src/eventlog.ts` is already stale)*. Every line
carries a designed envelope:

```
event_type · id · machine_id · session_id · sequence · timestamp
plugin · adapter_id · runtime · schema_version · payload · redacted
```

None of it reaches the hosted side.

## Most sessions are not sessions *(measured)*

Over an 80,000-event tail of this machine's log:

| | sessions | events |
|---|---|---|
| more than 20 events | **72** | 41,595 |
| everything else | **11,114** | 38,406 |

11,186 distinct `session_id`s. Median session **3** events; p90 **4**; p99 16;
max 6,497. A typical three-event session is `session.start`, `session.end`, and
one `bursar` event — a session that opened and closed having done nothing.

This is the finding that shapes the feature. A feed of "all sessions" would be
eleven thousand rows of noise with the interesting seventy buried in it, so the
design needs a notion of *worth showing* before it needs anything else.

Event volume by `event_type` prefix, same sample: `tool` 54%, then `session`,
`lineage`, `inspector`, `memory`, `assayer`, `bursar`, `curator`, `librarian`,
`tribunal`, `skill`.

## What this changes about the product *(approved)*

The README says the local-first tooling lives elsewhere, and "what is here
exists to support the one capability that cannot be local — sharing lessons
between people."

This widens that line deliberately. Observability becomes something the hosted
side also holds, in summary form. That was a decision, not an oversight, and the
README should be updated to say so rather than left to contradict the schema.

## Envelope only *(approved)*

The summarizer reads `event_type`, `session_id`, `timestamp`, `plugin` and
`sequence`. **It never reads `payload`.**

That is the whole safety story, and it is structural rather than procedural. The
alternative considered was an allowlist of payload fields — richer, since it
could name the tools used and the repository — and rejected because an allowlist
has to be re-decided every time someone adds an event type, and the default for
an undecided type is where the leak lives. With envelope-only, a new plugin
shipping a new event type cannot leak, because no code path reads what its
events contain.

Leaning on the existing `redacted` flag was also considered and rejected: it is
`false` on every event sampled. It exists and nothing sets it, so trusting it
today would mean shipping prompt text.

The cost is real and worth stating. A summary reading `6,311 tool events over
two hours` says *that* something happened, not *what*. Answering "what was I
working on" would need the repository name at minimum, which is the first
allowlist entry and the beginning of the rejected option. If that turns out to
be the thing people want, it is a later decision made on purpose, not a drift.

## The summary *(approved)*

One row per session:

```
session_id, machine_id, started_at, ended_at,
event_count, counts_by_prefix { tool: 6311, session: 100, skill: 81, task: 5 },
plugins [ ... ], prompts, compactions, schema_version
```

`prompts` counts `session.prompt`; `compactions` counts `session.compact`. Both
are counts of envelope types, not content.

A *prefix* is the part of `event_type` before the first dot — `tool.shell.exec`
counts under `tool`. This matches what `eventlog.ts` already means by prefix in
its `lastByPrefix` scan, so the two agree rather than each inventing a rule.

At a few hundred bytes per session this is small enough that the transport
decisions below can be chosen for robustness rather than for size.

## Worth showing: a count threshold *(approved)*

Default **20 events**, configurable.

20 is not a magic number; it is where this machine's data separates two
populations that are obviously different in kind. It is configurable precisely
because it was derived from one machine, and a constant nobody can move would
harden an observation about a single log into a rule for everyone.

Sessions below the threshold are not summarized and never leave the machine.

## Transport: idempotent upsert *(approved)*

Summaries ride `sync`, which already runs authenticated and already calls
`reportInventory` — documented in `apps/cli/src/api.ts` as "replace this
machine's reported inventory". A session summary is the same kind of statement
about the same machine, so it travels the same trip rather than adding a command
someone has to remember to run.

Each sync makes one full streamed pass over the log — `eventlog.ts` already
streams rather than reading whole, and measures a full pass at 0.25s — and sends
every session above threshold whose **last event falls within the previous 7
days**. The API upserts on `(machine_id, session_id)`.

Seven days rather than "since last sync" so that a machine which has not synced
in a while still reports its recent work, and so the window is a property of the
data rather than of how often someone happened to run the command. A session
older than the window is never re-sent; its row on the server stands as last
written.

The alternative was a client-side high-water mark — remember the last synced
`sequence`, send only what is newer. It moves less data and was rejected anyway,
for three reasons: there is no local state to corrupt or lose; a wiped
`cli.json` re-reports rather than orphaning history; and a session still in
progress gets its summary **updated** on the next sync instead of being frozen
at whatever it looked like the first time it was seen. Re-sending unchanged rows
costs a few hundred bytes each.

## Hosted shape *(approved)*

A new `session_summaries` table in `packages/db`, keyed
`(user_id, machine_id, session_id)`. The package owns the schema and the
migration; the API consumes it, as it does for every other table.

- `POST /machine/sessions` behind `requireMachineToken`, mirroring
  `/machine/inventory`.
- `GET /sessions` behind `requireAuth`, cursor-paginated the way `listActivity`
  already is.

Both go in `packages/api-contract`, so `apps/api` and `apps/web`'s mock run the
same cases. The README names contract drift as one of two things that are easy
to get wrong here, and it has already cost two outages.

## Web *(approved)*

A new `/sessions` route, added as a sixth entry in `SECTIONS`. It inherits its
nav link, its `h1` and its document title from that list without further work —
that is what `onlooker-lo1x` built the route-derived chrome for.

Rows group by day like `/activity`. Each row shows when the session started, how
long it ran, its event count, and its shape (`6,311 tool · 100 session ·
81 skill`).

Two empty states, distinguished because they are different facts: no machine has
ever synced, versus machines have synced and nothing cleared the threshold. The
lessons pool already set this precedent — an empty pool and an empty filter say
different things, and conflating them tells someone to go connect a machine when
their real problem is a threshold.

## Retention *(approved, and the most arguable choice here)*

Summaries are kept for **180 days**, pruned server-side.

At roughly 72 qualifying sessions per three days of heavy use, one machine
produces on the order of 9,000 rows a year. D1 would not notice that, so this
is not a capacity decision — it is a decision that "forever" should be chosen
rather than defaulted into. 180 days keeps a couple of quarters of history,
which is long enough to see a trend and short enough that a row written today
has a stated end.

This is the section most worth arguing with.

## Error handling *(approved)*

- A malformed line in the event log is skipped, not fatal. The log is appended
  to by many plugins; one bad writer must not stop summarizing.
- A session with a `session.start` and no `session.end` is summarized as
  in-progress, with a null `ended_at`. It updates on a later sync.
- A failed `POST /machine/sessions` must not fail `sync` as a whole. Inventory
  reporting and session reporting are independent statements; one failing is not
  a reason to lose the other.
- `GET /sessions` for a user with no machines returns an empty page, not an
  error. "Nothing yet" is an answer.

## Testing *(approved)*

- The summarizer is a pure function from an iterable of envelopes to an array of
  summaries. Tested with synthetic events — no fixture log, no developer's real
  history.
- A test asserting the summarizer never reads `payload`: feed it events whose
  payload is a getter that throws, and assert summarizing succeeds. This is the
  safety property, so it gets a test that fails if someone adds a payload read.
- Threshold boundaries: a session at exactly the threshold, one below, one above.
- A session with no `session.end` summarizes as in-progress.
- Contract cases in `packages/api-contract` for both endpoints, so the mock and
  the real API cannot drift.
- Web: both empty states, and a row rendering its shape.

## Out of scope

- Payload contents of any kind, including tool names and repository names. That
  is the allowlist option, rejected above.
- Redaction. The `redacted` flag stays unused by this work; making it mean
  something is a separate piece.
- Any change to what the local event log records or how it is written.
- Retiring or merging `/activity`. Lesson events and session summaries stay
  separate surfaces because they are different things.
