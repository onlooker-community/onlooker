# Machine Plugin Inventory — Design

Bead: `onlooker-sbgh`. Touches `apps/cli`, `apps/api`, `apps/web`,
`packages/db` and `packages/api-contract`.

`onlooker sync` gains a first act: collect this machine's plugin inventory and
send it before any lesson work happens. The Machines page stops being a list of
names and becomes what is running where, and since when.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-11 and are
decisions rather than proposals. Sections marked *(measured)* were read on this
machine on 2026-09-11 at `a44f255`; each carries the file and line it came from
so a later reader can re-check rather than re-derive.

## Boundary *(approved)*

**In scope:** local inventory collection in `apps/cli`, a machine-authenticated
write endpoint, a JSON column on `machine_tokens`, the browser read path, and
the Machines page rendering.

**Out of scope, each for a reason rather than by omission:**

- **Drift detection and advisories.** "This machine is on librarian 0.6.1,
  which drops every lesson" is a different feature with a different data model —
  it needs a notion of what *current* is, and somewhere to put a verdict. The
  storage choice below is made so that adding it later does not require
  rewriting what this ships.
- **History.** Each report replaces the last. This is current state, not a
  timeline. A timeline is a table of snapshots and a retention policy, and
  nothing yet asks for one.
- **`applies_to` targeting.** Using the inventory to decide which lessons apply
  to a machine is the highest-value thing it eventually enables, and it cannot
  be built yet: it pays off only once lessons flow between machines, and they
  do not (see *The round trip*, below).
- **The lesson round trip.** Named here because it is the larger gap and this
  work does not close it.

## Context: what the app can and cannot do today *(measured)*

Worth stating, because it explains why the Machines page is where the next
useful thing lands.

| Capability | State |
|---|---|
| Auth, account, machine tokens | Working |
| Lessons leaving a machine | Working — `sync` pushes approved lessons |
| Lessons arriving on another machine | **No client.** `GET /lessons` is a full delta read with `seq` gap detection (`apps/api/src/routes/lessons.ts:425`), and `apps/cli` calls it only as `?since=0&limit=1`, a connectivity probe (`apps/cli/src/api.ts:136`). There is no `pull` command. |
| Lessons reaching another *person* | **Does not exist.** `handleReadLessons` and `handleBrowseLessons` both scope to `userId`. The `visibility` column grants no access to anyone. |

So lessons currently leave a machine and arrive nowhere. That is the larger
gap; this design does not address it, and should not be read as progress
toward it.

## Why the trigger is sync's first act, not sync's network call *(approved)*

The obvious implementation — attach the inventory to the request sync already
makes — never fires.

`sync` returns before it builds a client on four paths: no `~/.onlooker`
directory, no librarian directory, an unreadable directory (throws), and an
empty approved set. `createClient` is at `apps/cli/src/commands/sync.ts:70`,
below all of them *(measured)*. Every machine is on one of those paths today —
the lesson pool has been empty on this machine since June, which is the subject
of `onlooker-01x`.

An inventory report that only fires when lessons exist would therefore never
fire, for exactly the machines whose Machines page is emptiest. So the report
runs as soon as sync holds a token, before the lesson paths are evaluated, and
`Nothing to sync: librarian has not run here yet` still updates the page.

The cost is real and accepted: sync now always makes a network call, so paths
that were previously offline-safe gain a failure mode. See *Failure behavior*.

## What is collected *(approved)*

Two local sources, joined.

### Installs — `<configDir>/plugins/installed_plugins.json`

Every plugin, and every scope it is installed at. The file's entries carry
`scope`, `projectPath`, `installPath`, `version`, `installedAt`, `lastUpdated`
and `gitCommitSha` *(measured — 28 plugins on this machine)*.

`gitCommitSha` is reported alongside `version` rather than instead of it. For a
marketplace that ships squashed release mirrors, a version string dates a build
but does not identify one; the sha does.

### Enablement — `settings.json`, via `readEnablement`

User scope plus the project sync ran in. An installed plugin that nothing
enables does not run, and this repository has already paid for conflating the
two — `#97`, *enabling a plugin was never installing it*. The page must be able
to show an install as inert.

### The unit is the whole machine, with versions per scope *(approved)*

Not one version per plugin per machine. On this machine `librarian` is
installed four times *(measured)*:

```
project  …/ecosystem          0.18.0
project  …/onlooker           0.18.1
user     (all projects)       0.18.1
project  …/ecosystem-449.48   0.18.0
```

"What version does this machine have" has no single answer, and picking one
would be a guess presented as a fact. Reporting a version per scope is the only
shape that is true.

### Two judgment calls, stated so they can be overruled *(approved)*

1. **Paths travel home-relative** (`~/src/github.com/…`), not absolute. The
   page needs to distinguish which project pinned `0.18.0`, which the relative
   path preserves; the OS username it does not need. Reducing further to
   basenames remains available and costs only the ability to tell two
   same-named checkouts apart — which, given `ecosystem` and
   `ecosystem-449.48` both exist here, is not hypothetical.
2. **All marketplaces, not just `@onlooker-community`.** `enablement.ts`
   filters to one marketplace (`MARKETPLACE`, line 6) *(measured)*, which is
   right for `doctor` — it judges only plugins it knows. It is wrong here:
   fleet visibility that hides two-thirds of the fleet is not visibility.

### Config directory resolution — reuse, do not rewrite *(approved)*

`configDir` comes from `userConfigDir` (`apps/cli/src/enablement.ts:146`),
which resolves `CLAUDE_HOME || CLAUDE_CONFIG_DIR` before falling back to
`$HOME/.claude` *(measured)*. It is currently private; this work exports it.

This is not a style preference. Hardcoding `$HOME/.claude` is a defect this
codebase has now shipped twice — once in `readEnablement`, fixed in `280248b`
(whose subject names a different one of its three fixes, so searching the log
for this one by message will not find it), and once in librarian's vendored
config loader, where it disabled the plugin's entire output on any machine with
`CLAUDE_CONFIG_DIR` set. This machine sets it, and has no `$HOME/.claude` at
all. A second resolver in a new file is how that returns.

## Transport *(approved)*

`PUT /machine/inventory`, machine-authenticated, in the bare namespace beside
`/lessons` rather than under `/api/*`. That split is the existing convention:
`/lessons` is machine-authenticated, `/api/*` is browser-authenticated
*(measured — `apps/api/src/router.ts`)*.

`PUT` rather than `POST` because the operation is idempotent replacement of one
row's document. Re-running sync twice must not accumulate anything.

**On the adjacent security rule.** `apps/api/src/routes/machines.ts` states
deliberately that machine management is browser-authenticated and never
machine-authenticated, because a machine token that could mint further tokens
would make revocation meaningless. This endpoint does not weaken that rule. The
token identifies exactly one machine; the write targets only that machine's own
row; it mints nothing and enumerates nothing. A machine may describe itself. It
still may not name, create, or revoke any other.

## Storage *(approved)*

An `inventory` JSON document plus `inventory_at` on `machine_tokens`, replaced
whole on each report.

The alternative considered was a normalized `machine_plugins` table keyed by
machine, plugin, and scope. It was rejected for now, not on principle:

| | JSON document | Normalized table |
|---|---|---|
| Rendering a machine's inventory | Direct — the stored shape is the displayed shape | Re-nest rows into the per-scope shape on every read |
| Querying *across* machines | Not supported | The reason to have it |
| Cost when the source file's shape changes | None | A migration |

The per-scope unit is inherently a nested document. Normalizing it into rows
only to re-nest it for display is work that buys nothing while the purpose is
read-only rendering. What would force the table is querying across machines —
"which machines still run librarian 0.6.1" — which is the drift feature that is
explicitly out of scope. A JSON column does not block that later; it declines
to pay for it now.

The column stores a document with a `schema_version`, so a later reader can
tell an old report from a new one without guessing from its shape.

## Browser read path *(approved)*

Two steps, matching the browse-then-detail split the lessons pages already use:

- `GET /api/machines` gains a **summary only** — plugin count and
  `inventory_at`. The list must not carry 28 plugins times the number of
  machines.
- `GET /api/machines/:id/inventory` returns the full document. A new route
  rather than a body on the existing `/api/machines/:id`, because there is no
  such route today — `:id` currently serves `DELETE` alone *(measured —
  `apps/api/src/router.ts:171`)*.

`MachinesPage` renders each machine's plugins grouped by name, with a row per
scope showing version, sha and enabled state, and shows `inventory_at` so a
stale report is visible as stale rather than mistaken for current.

A machine that has never reported renders as *never reported* — not as a
machine with no plugins. The two claim different things, and only one of them
is knowable from an absent report.

## Failure behavior *(approved)*

A failed inventory report is **non-fatal and never silent.**

- Non-fatal: sync proceeds to the lesson work and exits on the lesson verdict.
  A reporting failure must not cost a lesson push, which is the more important
  of the two operations.
- Never silent: the failure is always printed. Exiting 0 while the inventory
  quietly stopped updating is the successful-looking silence this repository
  keeps rediscovering — most recently in `onlooker-01x`, where a filter denied
  3,837 candidates for two months while every instrument reported success.

Collection failures are distinguished from transport failures in the printed
message, because they need different responses: an unreadable
`installed_plugins.json` is a local problem, a rejected `PUT` is not.

## Testing *(approved)*

- **Collection** — unit tests against fixture config directories. The case that
  matters is one plugin installed at two versions in two scopes; a fixture with
  one install per plugin would pass against an implementation that silently
  keeps the last one it read.
- **Contract** — both endpoints land in `packages/api-contract`, asserted
  against the real API and `apps/web`'s mock. Drift between those two is
  already an open defect (`onlooker-jws`), so the mock conforms here rather
  than approximately.
- **Sync ordering** — a test that the report is attempted on a
  no-lessons-to-send path. This is the behavior the whole trigger decision
  rests on, and it is invisible to any test that only exercises sync with
  lessons present.
- **Failure isolation** — a test that a rejected report still lets the lesson
  push run and still sets the exit code from the lesson verdict.

## Rollback

The CLI change is inert without the endpoint; the endpoint is inert without the
column. Reverting is the reverse order, and a machine running an older CLI
simply never reports — which the page already renders as *never reported*.

## Open questions

None blocking. The two judgment calls above are decisions, and are recorded as
overrulable rather than as open.
