# Local Lesson Reader — Design

Bead: `onlooker-onz1`. Touches `apps/cli` only. No API, schema, contract or
web change.

`onlooker playbook` reads this machine's mirror, resolves the project's
installed stack, and reports which lessons apply here and now.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-12 and are
decisions rather than proposals. Sections marked *(measured)* were read on this
machine on 2026-09-12 at `17ae546`; each carries the file and line it came from.

## The gap *(measured)*

`sync` writes lessons to `~/.onlooker/pool/` and nothing opens them. The round
trip spec accepted that knowingly — *"Nothing reads this yet… the retrieval
layer that would consume it is not installed"* — and this is the work that
closes it.

The architecture already said where this belongs. From `packages/db/src/schema.ts:165`:

> The server never matches `applies_to`. `scope.versions` holds comparator
> strings like `">=4 <6"`, and deciding whether one matches `vite@5.2.1` is a
> semver comparison that D1 cannot do. **Matching happens on the client against
> its mirror**, which leaves visibility as the only server-side filter.

Client-side matching is not a new idea being introduced here; it is a
responsibility the schema assigned and nothing has yet picked up.

## Naming *(approved)*

Both names are taken from vocabulary this product already published, rather
than invented. The four established terms:

| Term | Meaning | Source |
|---|---|---|
| **lesson** | the shareable unit | contract spec Q2 |
| **pool** | the hosted set | every user-facing string in `sync` |
| **playbook** | *a saved-query view over a pool, not a container* | contract spec Q2 |
| **hint** | what waypoint's engine delivers | landing page, `index.astro:69` |

**The command is `onlooker playbook`.** It runs a query over a pool and returns
the lessons that apply — which is the published definition of a playbook,
supplied here as the built-in default view. It scales to `onlooker playbook
<name>` if saved views ever ship, it leaves `lessons` free for the flat listing
that name most naturally means, and it does not claim `hints`, which belongs to
waypoint's engine and would collide the moment that engine delivers one.

**The mirror directory is renamed `pool/` → `mirror/`.** Every user-facing
string uses "pool" for the *hosted* set — *"already in the pool"*, *"the pool
holds a different version"* — so naming the local copy `pool/` collides with
the tool's own vocabulary in its own output. `schema.ts:167` already calls this
thing "its mirror"; using that word makes the code match the source of truth.

### Migration *(approved)*

`pool/` shipped in 2.4.0, so a machine may already have one. On startup, if
`pool/` exists and `mirror/` does not, the directory is moved and the move is
reported. Silent migration is not an option in this codebase.

The cost of getting this wrong is bounded either way: the cursor is the only
thing of value, and losing it re-mirrors from zero, which is free because
writes upsert by id. The migration exists to avoid leaving a confusing orphan
beside the new directory, not to protect data.

## What "applies" means *(approved)*

Three gates, in order. Each is a different question, and collapsing them is how
a reader starts lying.

### 1. Status

Only `active` lessons are advice. `refuted`, `superseded` and `retracted` are
excluded outright.

Surfacing a refuted lesson is worse than surfacing nothing: it is the failure
this whole pipeline exists to prevent, dressed as its output.

### 2. Applicability — the structural staleness gate

- **`scope.kind === "version_independent"`** → no version gate. The
  `justification` is displayed, because it is the field the tribunal's
  `scope_accuracy` criterion scored and the only thing a reader can weigh.
- **`scope.kind === "versioned"`** → every key in `versions` must resolve in
  this project **and** satisfy its comparator. Entries combine with AND, as the
  schema states.
- **Every entry in `stack` must be present in this project.** A lesson naming
  `["vite", "vitest"]` is about their interaction; requiring both is the safer
  direction, at the cost of missing a lesson that was really only about one.

**Versions come from what is installed**, not from `package.json`. A declared
`^5.2.0` against a lockfile pinning 6.x would keep a retired lesson alive,
which is precisely the false positive structural staleness exists to prevent.

#### Comparison, without a semver dependency *(approved)*

`apps/cli` has exactly one runtime dependency — the lesson contract — and this
work does not add a second. `VERSION_RANGE` is a deliberately small grammar:
comparator-prefixed, at most a lower and an upper bound, with a bare `"4"`
rejected *because* it is ambiguous about whether it means "exactly 4"
*(measured — `primitives.ts:61`)*. A grammar that narrow is honestly
implementable in about thirty testable lines; pulling in a general semver
engine to evaluate it would be the larger change, not the smaller one.

An installed version carrying a prerelease or build suffix — `6.0.0-beta.1` —
is compared on its numeric core. Someone running a 6 prerelease is on 6 for the
purpose of a lesson scoped `<6`, and the alternative reading would keep a
retired lesson alive for exactly the people most likely to hit its replacement.

A version string with no parseable numeric core resolves to **cannot tell**.

### 3. Relevance — what you are touching

`file_patterns` are matched against the files changed in the working tree. This
**splits** the output rather than filtering it:

- **About what you are changing** — a pattern matched a changed file.
- **Applies to this project** — everything else that passed gates 1 and 2.

A pattern that does not match demotes a lesson; it never hides one. Hiding on a
weak signal is how a reader silently withholds the thing someone needed.

`task_kinds` is **displayed and never filtered on.** Nothing in a CLI
invocation knows what task you are doing, and pretending otherwise would drop
lessons on a guess.

## Unresolvable is a third state, not a negative *(approved)*

**Anything that cannot be resolved reads as "cannot tell", never as "does not
apply."** A project whose dependencies are not installed resolves nothing; that
is ignorance, not absence.

This is the trap the contract names at `applies-to.ts`:

> A key naming something absent from `stack` is a defect: depending on how
> retrieval treats an unmatched key, the lesson either never matches or the
> constraint is skipped, **and skipping it produces a lesson that never
> expires.**

Skipping an unresolvable constraint is the dangerous direction — it mints an
immortal lesson. Treating it as a non-match is the quiet direction — it hides a
lesson that may apply. Neither is acceptable silently, so these are listed in
their own group with the reason, and counted in the summary.

This is the same shape as `Enablement.unknown` and the inventory's
`enabled: null`: the codebase already refuses to collapse "I do not know" into
"no", and this follows it.

## A mirror file the contract refuses *(approved)*

Reported, never skipped. Same reasoning as `pull`: a record the contract
refuses is a fact worth seeing, and this command is the only place a person
would ever see it.

## Output *(approved)*

Human-readable by default, grouped by the three outcomes above, each lesson
showing its claim, its scope, and **why** it landed in that group — a match
without its reason cannot be checked.

`--json` ships from the start. A SessionStart plugin in the ecosystem repo is
the stated next step and would shell out to this; machine-readable output is
therefore foreseeable rather than speculative, and retrofitting it once someone
parses the prose is worse.

## Boundary *(approved)*

**In scope:** the rename and its migration, stack resolution from installed
dependencies, the three gates, working-tree relevance, and the command.

**Out of scope:**

- **The plugin.** The destination is a SessionStart plugin beside librarian and
  archivist, in the `ecosystem` repo. It comes after the matching logic is
  proven here, where it is unit-testable with the harness this repo already has.
- **Non-npm stack entries.** `stack` is free-form, so a lesson could name
  `node` or `python`. Each source is its own resolver and its own failure mode;
  unresolved entries fall into "cannot tell", which is the honest answer until
  a resolver exists.
- **Ranking.** Lessons are grouped, not scored. A scoring rule is a thing to
  get wrong quietly, and there is no pool large enough yet to need one.
- **Sharing.** Still the hosted app's stated purpose, still absent, still its
  own design.

## Rollback

One command and a directory rename. Reverting leaves `mirror/` on disk,
harmless and re-derivable — the cursor is the only state and re-mirroring from
zero is free.

## Open questions

None blocking. The decision most likely to be revisited is requiring **every**
`stack` entry to be present rather than any, which is deliberately the strict
direction and will be visible the first time a real lesson fails to appear.
