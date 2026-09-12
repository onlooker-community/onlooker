# Commit Mining — Design

Bead: `onlooker-vmds`. **The implementation lands in `onlooker-community/ecosystem`**,
as a hook in the archivist plugin. The design lives here because this repository
holds the rest of the lesson pipeline's design series — the contract, the round
trip, the reader — and this is the piece that finally gives that pipeline an
input.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-12.
Sections marked *(measured)* were read on this machine on 2026-09-12; each
carries the file it came from.

## The gap *(measured)*

`archivist-extract` has fired **zero times** across this machine's entire
hook-health history. It is bound to `PreCompact` and nothing else
*(measured — `archivist/0.5.0/hooks/hooks.json`)*, so the lesson pipeline's
source has never run at all. Everything downstream of it — librarian's filter,
the classifier, the tribunal, the lesson transform, `sync`, the mirror, and now
`onlooker playbook` — is complete and has never had anything to carry.

## Why the trigger is the smaller problem *(approved)*

Binding extraction to `SessionEnd` would make it run. It is not enough, because
the mechanism is also wrong.

**Compaction is a proxy for context pressure, not for insight.** A long,
uneventful session compacts and gets mined; a short session in which something
was genuinely learned does not. The trigger correlates with transcript length,
which is close to uncorrelated with whether anything was learned.

**And extraction re-derives what has already been written.** It asks a model to
read a transcript tail and infer which decisions mattered — reconstructing,
later and for money, a judgment that was already made and already written down
by the agent that made it.

## The reframing: the distillation already happened *(approved)*

This repository produces lesson-shaped artifacts as a routine byproduct of how
it works, because the `/commit` skill requires commit bodies to explain *why*.
A body from this session reads:

> Anything unresolvable is cannot-tell, never does-not-apply. That direction is
> the one `applies-to.ts` warns about: skipping a constraint we could not
> evaluate mints a lesson that never expires, and calling it a non-match hides
> one silently.

That is a claim, a rationale, and its evidence — the lesson contract's own
shape — written at the moment of understanding, already durable, already
attributable to an author, a date, a diff and a bead.

**Nothing in the sixteen-plugin marketplace reads git history or beads**
*(measured — no `git log`, `git show` or `rev-list` in any plugin's scripts)*.
The most distilled source available is entirely unmined, while the one source
that is mined requires a model call and has never run.

### What a commit supplies mechanically *(measured)*

The archivist artifact shape is
`{id, kind, project_key, source, created_at, updated_at, summary, detail, files, session_id, trigger}`.
A commit fills nearly all of it without inference:

| Field | From |
|---|---|
| `summary` | the subject line |
| `detail` | the body |
| `files` | the diff's changed paths |
| `session_id` | the `Claude-Session:` trailer this repo already appends |
| `created_at` | the commit date |
| `id` | a fresh ULID |
| `trigger` | `"commit"` |

By contrast the same fields from a transcript are all inferred, and `files`
unreliably so.

## No model call *(approved)*

The miner makes none. This is the point of the reframing rather than an
optimization: the judgment already exists, both upstream in the commit body and
downstream in the pipeline's gates.

**The existing gates already accept this input.** librarian's durability filter
keeps an artifact whose text contains one of thirteen marker phrases; recent
commit bodies from this repository contain `never` and `because`
*(measured — `librarian/0.18.2/config.json`)*. Nothing new needs to judge
quality, and building a second filter here would duplicate the one that already
exists.

A useful consequence: because the miner invokes no model, it cannot recurse.
`archivist-extract` carries an `ARCHIVIST_NESTED` guard that its own comment
calls *"a uniformity guard rather than an observed loop"* — true only because a
nested `claude -p` does not compact. Binding a **model-calling** extractor to
`SessionEnd` would make that guard load-bearing, since a nested session does
end. A mechanical miner sidesteps the question entirely.

## One artifact per commit *(approved)*

Nothing pre-splits a multi-claim body. The classifier and the lesson transform
already exist to distill, and if they handle a several-claim artifact badly
that is a finding about them rather than a guess made here.

## The project key comes from the substrate *(approved)*

`archivist_project_key` computes `SHA256("remote:<url>")` truncated to twelve,
falling back to `SHA256("root:<repo root>")` *(measured —
`archivist/0.5.0/scripts/lib/archivist-project-key.sh:89`)*.

The miner must **not** reimplement that. The hash is not the risk; the remote
URL normalization is, and a divergence there writes artifacts into a directory
librarian never scans — silent, and the same shape as the two config-resolution
bugs this codebase has already paid for.

**A shared helper is arriving.** `feat/plugin-currency-surfacer` in `ecosystem`
adds `scripts/lib/onlooker-project-key.sh` with the identical scheme, and its
commit message states the problem directly: *"every plugin ships its own and
none of them is importable from here"* *(measured — `3a7430c`)*. The miner
imports that helper.

**This work is therefore blocked on that branch merging.** The fallback, if it
stalls, is to read `project_key` out of the store's own `manifest.json`, which
already records `repo_root` and `remote_url` against the key — a lookup rather
than a second implementation.

## The watermark *(approved)*

The last mined commit SHA per project, advancing **only after** its artifacts
are durably written. Same rule as the pull cursor, and for the same reason:
`ecosystem-449.55` is what happens when a watermark moves ahead of the data it
describes.

A first run on an established repository faces a long history. It mines forward
from the watermark in batches, advancing per batch, so an interrupted first run
keeps its progress.

## Trigger *(approved)*

A hook rather than a CLI command, in the archivist plugin.

`SessionEnd` rather than `PostToolUse` on Bash. One invocation rather than one
per tool call; it catches commits made outside Claude Code, which a tool-call
matcher structurally cannot; and the watermark makes a no-op run cheap. The
delay costs nothing, because nothing downstream runs sooner — librarian scans
at `SessionEnd` too.

## Boundary *(approved)*

**In scope:** a `SessionEnd` hook in archivist that mines commits into
artifacts, the watermark, and the project-key import.

**Out of scope:**

- **Beads and specs as sources.** Commits first, because the mapping is total
  and the trailer already carries the session id. Bead notes are the obvious
  second source and are deliberately not bundled.
- **Retiring `archivist-extract`.** Transcripts genuinely hold what commits
  lose — the dead ends, the corrections, the thing tried and abandoned. This
  adds a source; it does not argue the old one away, and binding that one to
  `SessionEnd` remains a separate, live question.
- **Filtering which commits to mine.** All of them. The durability filter
  already exists to decide, and a second filter here would be a second thing to
  tune wrongly.
- **Changing anything downstream.** The artifact shape is the existing one
  precisely so that nothing else has to change.

## Rollback

One hook binding and one script. Removing the binding stops mining; artifacts
already written are ordinary artifacts and remain valid. The watermark is the
only new state, and losing it re-mines, which is idempotent by ULID only if the
miner keys artifacts deterministically — see the open question.

## Open questions

**Is an artifact keyed by commit SHA, or by a fresh ULID?** A fresh ULID makes
re-mining produce duplicates; a deterministic id derived from the SHA makes
re-mining idempotent, but the artifact `id` field is a ULID by contract and a
SHA is not one. The watermark makes this mostly moot, and it stops being moot
the moment anyone re-mines. Worth settling before implementation rather than
discovering through duplicates.
