# A lesson mined from a commit carries no session id

**Issue:** ONL-108 · **Status:** approved 2026-10-19 · **Repos:** onlooker (contract, API, web, CLI), then ecosystem (librarian)

## Problem

archivist mines commits at SessionEnd and takes `session_id` from a
`Claude-Session: …session_XXX` trailer (`archivist-mine.sh:138`). Only old
cloud-session commits carry one, so every commit-triggered artifact since
2026-09-20 has `session_id: null` (ONL-82's fix, ecosystem#355, made that
honest instead of the literal `"unknown"`).

The lesson transform then sets `.evidence.session_ids = [$sid]` with
`$sid = ""` (`librarian-lesson-transform.sh:356`), the validator refuses
`[""]`, and the candidate is declined `schema_invalid`. That decline is
terminal.

Measured 2026-10-18 on the dogfood machine, transform declines since
2026-10-01: 91, and 90 of them are commit-triggered null-session artifacts.
All 47 `schema_invalid` declines are this case. The 40 `no_versions` declines
are the same artifacts and would reach `schema_invalid` next. One lesson has
ever reached `approved/`.

## Decision: represent the absence, don't recover a session

Recovering a real session was ruled out:

- No local record links a commit SHA to a session. `tool.shell.exec` records
  the `git commit` command and its session, not the SHA it produced, so a join
  would have to match on repo, time and subject text.
- On a squash-merged repo, the commits archivist mines on `main` are made by
  GitHub when a PR merges. The session that did the work wrote the branch
  commits, and the squash doesn't record which one it was. A heuristic join
  would name the wrong session or no session. That is ONL-82's fabricated
  provenance again by another name.
- Adding a session trailer at commit time only helps future commits, and it
  is lost in a squash unless the PR body carries it too. It could be added
  later, but it doesn't replace this change.

So `evidence.session_ids` may be empty. An empty array is a valid value; an
array containing an empty string is not. A commit-derived lesson's receipts
are `artifact_ids`, `project_key` and `observed_at`, which are all real.

## Part 1: onlooker repo (ships and deploys first)

1. **Contract.** `packages/lesson-contract/src/evidence.ts`:
   `session_ids: z.array(z.string().min(1))`, with `.min(1)` dropped. The doc
   comment says why it can be empty. Regenerate `schema/lesson.schema.json`
   (`minItems` goes away). Bump 2.0.1 to **2.1.0**: accepting a new value is
   a widening change, and the "Contract version bumped with schema" gate
   requires a bump.
2. **API.** It consumes the contract through the workspace. Add a test that
   a lesson with `session_ids: []` is accepted, and one that `[""]` is still
   refused.
3. **Web.** In `LessonDetail.tsx`, the "What was observed" line renders
   `N sessions`. With 0 it omits that segment and its separator, rather than
   showing "0 sessions". Test both renderings.
4. **CLI.** `onlooker sync` bundles the contract, so this is a CLI behavior
   change: bump the CLI version, not `cli-batch`.

Ordering: the API must accept `[]` before any librarian emits one. If it
doesn't, `onlooker sync` refuses those lessons loudly; nothing is lost.

## Part 2: ecosystem repo (after Part 1 deploys)

1. **Vendored schema.** Re-vendor `plugins/librarian/schema/lesson-evidence.subschema.json`
   from contract 2.1.0 and update `PROVENANCE.json`.
2. **Validator.** `librarian-lesson-validate.sh:88-89`: drop the
   `length > 0` clause and keep `all(type == "string" and length > 0)`.
3. **Transform.** `librarian-lesson-transform.sh:356`:
   `.evidence.session_ids = (if $sid == "" then [] else [$sid] end)`, which
   is the idiom `librarian-classify-worker.sh:346` already uses for
   `source_session_ids`.
4. **Replay.** `lessons reconsider` gains `--reason <reason>`. The default
   stays `no_versions`, and so does the behavior for it.
   - `--reason schema_invalid` replays only declines whose artifact has
     `session_id: null`, through the normal pre-gate route (nothing about
     scope was refused). Any other `schema_invalid` decline has a cause this
     change doesn't touch, so its decline is written back, the same way the
     `--limit` path already restores declines it doesn't replay.
   - The 40 null-session `no_versions` declines need nothing new: the
     existing reconsider replays them, and after step 3 they no longer fall
     through to `schema_invalid`.
   - `--limit` applies. Each replay is one transform model call (about 90 on
     the dogfood machine).
5. **Release.** A `feat(librarian)` commit, so release-please cuts a minor
   version.

## Testing (bats, ecosystem; vitest, onlooker)

- A null-session commit artifact goes through the transform, and the result
  is `proposed` with `session_ids: []`.
- The validator accepts `[]` and refuses `[""]`.
- `reconsider --reason schema_invalid` replays only the null-session
  declines and writes the others back.
- Contract, API and web cases as listed in Part 1.

Each new test is proven by ablation: revert the fix it covers and confirm it
fails, because a test that passes either way guards nothing.

## Out of scope

- Running the replay on the dogfood machine. It happens after the release
  is installed and needs explicit approval, because it spends model calls.
- Replayed candidates failing adversarial review: ONL-110.
- A commit-time session trailer (see Decision).

## Done when

These are ONL-108's three conditions:

- A commit-triggered artifact can be represented without a session id end
  to end: validator, vendored contract, and pool.
- A test drives the no-session case through the transform.
- The artifacts already declined for this reason can be recovered with
  `reconsider`.
