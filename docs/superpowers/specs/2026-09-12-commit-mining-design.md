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
| `id` | a ULID derived from the message text — see below |
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

## The unit is an authored message, not a commit *(approved)*

### What squash merging does to this *(measured)*

This repository merges by squash, exclusively: all of the last twenty commits
on `main` end in `(#N)` *(measured 2026-09-12)*. So `main` holds one commit per
pull request, and the individual commits that were written never appear in it.

Squashing is **lossless but lumpy**. GitHub concatenates every commit message
into the squashed body, each prefixed with `* `, and PR #141 arrives on `main`
as one commit whose body carries eleven of them. A single-commit PR gets its
body verbatim with no bullet at all *(measured — `4e198fa`, `17ae546`)*.

### So the miner splits them back *(approved)*

One artifact per **authored message**: split a squashed body on `^\* `, or take
a bulletless body whole.

This is not a retreat from letting the pipeline distil. That answer was right
for the input we believed we had — one commit, one author, three or four
related claims. A squashed pull request is not that. It is eight separately
authored units mechanically stapled together, and splitting them is undoing a
packaging step rather than second-guessing content.

Nothing pre-splits *within* an authored message. A body that makes four claims
still arrives as one artifact, and if the classifier handles that badly it
remains a finding about the classifier.

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
only new state, and losing it re-mines — which is free, because content-
addressed ids make a re-mine overwrite rather than accumulate.

## The id is content-addressed *(approved)*

An artifact's id is derived from the message that was written, not from the
commit that happens to carry it.

**Why it has to be deterministic.** `evidence.artifact_ids` is
`z.array(ZUlid).min(1)` *(measured — `lesson-contract/src/evidence.ts:10`)*:
lessons cite artifact ids as their evidence. A re-mine that minted new ids
would leave every lesson already derived from a message pointing at an artifact
that no longer exists on disk — the evidence chain broken, silently, with
nothing failing. Avoiding duplicate files is the lesser benefit; keeping
citations valid is the reason.

**Why it cannot be the commit SHA.** The SHA is precisely what this workflow
destroys. A squash merge replaces every commit on a branch with one new commit,
and a rebase or a cherry-pick rewrites them too. Keying an artifact to a SHA
means keying it to the least durable thing in reach — the same class of mistake
as keying a lesson to a version that has already moved on.

**So the id derives from the message text.** A ULID is a 48-bit millisecond
timestamp encoded as ten Crockford characters, followed by eighty bits of
randomness as sixteen more *(measured — `archivist-ulid.sh:5`)*. Only the
second half has to be random, and nothing requires it to come from a random
source:

- **randomness half** ← the first eighty bits of `SHA256(<normalized message>)`,
  split into two forty-bit halves through the existing
  `_archivist_ulid_encode`, which already takes an integer and a length.
- **timestamp half** ← the carrying commit's date, in milliseconds.

Normalizing means the subject and body with the `* ` bullet prefix stripped and
trailing whitespace trimmed, so a message hashes identically whether it is read
from the branch commit that authored it or from the squashed body that later
carried it.

The result is a well-formed ULID that satisfies `ZUlid`, so nothing downstream
learns these ids were derived rather than generated. Checked rather than
assumed: the construction run against a real commit yields
`01M2B8E6Y0SJPD71T40Q2XKKMB`, matching `ZUlid`'s `[0-9A-HJKMNP-TV-Z]{26}`
exactly *(measured 2026-09-12)*.

**Two properties fall out.** Re-mining is idempotent — the same message
produces the same id and overwrites its own artifact rather than adding a
second, the same upsert-by-id the mirror already relies on. And because ULIDs
sort lexicographically by their timestamp prefix, a pull request's artifacts
sort together, at the moment it landed.

**The timestamp half is the one part squashing still moves.** Mine a message
from its branch commit and again from the squash that carried it, and the
randomness halves agree while the timestamps differ. That is why the miner
reads only the default branch: one source, one carrying commit, one id. It is a
constraint rather than a property, and it is the reason mining is not offered
on a feature branch.

## Open questions

None blocking.
