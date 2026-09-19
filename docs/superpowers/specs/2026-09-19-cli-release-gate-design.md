# CLI Release Gate — Design

Bead: `onlooker-mcwn`. One new job in `.github/workflows/deploy.yml`, one new
script under `scripts/` with its test beside it, and one new repository label.
Nothing ships differently; something finally notices when it does not.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-19.
Sections marked *(measured)* were read from this repository and the GitHub API
on 2026-09-19; each names where the fact came from.

## The gap *(measured)*

The CLI's release trigger is a version change in `apps/cli/package.json`.
`tag-cli.yml` is paths-filtered on that one file, cuts `cli-v<version>`, and
`release-cli.yml` turns the tag into a GitHub release and a Homebrew tap
update. `deploy.yml` deliberately never ships the CLI — `release-cli.yml`'s
own header says shipping the CLI must never start a Cloudflare deploy, and a
Cloudflare deploy must never cut a CLI release.

That separation is right, and it leaves a hole. A pull request can change
`apps/cli/src`, merge green, deploy the API and the web app, and leave the CLI
exactly as it was, with nothing anywhere reporting that the code on `main` is
not the code anybody is running.

It has happened twice:

- **#141** shipped the machine inventory inert. **#142** was spent fixing it.
- **#167** shipped session summaries inert. The API stored them and `/sessions`
  rendered them while every installed `onlooker sync` reported nothing. **#168**
  cut 2.6.0. It was caught only because a person thought to ask whether the CLI
  needed releasing.

The 2.4.0 release commit (`7af44e2`) wrote the rule down and put the bump in the
same pull request as the feature so it could not be forgotten. A rule in a
commit message is not a check. The eight-task plan behind #167 had no task for
it and forgot anyway.

As of this writing `cli-v2.6.0` is the newest tag and `git diff
cli-v2.6.0..HEAD -- apps/cli/src` is empty, so the gate would pass on today's
`main`. It is being built from a clean state, not to clear a backlog.

## Why the contract's check cannot simply be copied *(approved)*

`deploy.yml` already carries `contract-version`: a pull-request-only job that
fails when `packages/lesson-contract/schema/` changed without a version bump,
wired into the `required` aggregate. It is the right shape and the wrong
policy.

A contract schema change without a bump is *always* wrong — nothing publishes,
and consumers keep resolving the old contract. Batching several CLI changes
across pull requests and cutting one release at the end is *legitimate*. A
check that forbids it would be worse than the gap it closes.

So the gate fails by default and carries an explicit opt-out. Forgetting fails
loudly; batching costs one deliberate, recorded act. The decision moves from
silence to a label somebody chose to add.

## What the binary actually contains *(measured)*

`apps/cli/package.json` builds with `esbuild --bundle`, and its only runtime
dependency is `@onlooker-community/lesson-contract` at `workspace:*`.

That dependency is not types-only. `ZLesson` is a Zod schema — a runtime value —
imported in three places:

```
apps/cli/src/lessons.ts
apps/cli/src/pull.ts
apps/cli/src/commands/playbook.ts
```

A change under `packages/lesson-contract/src` therefore changes the shipped
binary without touching `apps/cli/src` at all, and would slip past a gate
scoped to the path the bead names. `contract-version` does not cover this: it
bumps the *contract's* version, not the CLI's, and it watches `schema/` rather
than `src/`.

The closure is shallow. `lesson-contract` depends on `zod` and nothing in this
workspace, so resolving one level reaches every file in the bundle today.

## Where a blocking check has to live *(measured)*

Three rulesets govern this repository. The one that matters is **Require CI**
(id `22402388`, active, branch target), and it carries exactly one
`required_status_checks` context:

```
All checks passed
```

That is the `required` job at the end of `deploy.yml`, which `needs: [quality,
test, contract-version, changes]` and fails the gate on any result that is
neither `success` nor `skipped`. A check becomes blocking here by being a job
in `deploy.yml` and a line in that list. A standalone workflow could not block
without an org ruleset change, and a context the repository does not always
emit sits pending forever.

## Why the opt-out is not read from the event payload *(approved)*

A label opt-out means the gate must see labels added *after* a failing run.
Adding `labeled`/`unlabeled` to `deploy.yml`'s `pull_request` trigger would
re-run `quality`, `test`, and `changes` on every label change.

Gating those jobs off for label events is worse, not cheaper. They would be
**skipped**, and `required` counts `skipped` as passing — so labeling a pull
request would mint a green `All checks passed` from a run that tested nothing.
That is the same silent-green failure this whole line of work exists to remove.

Instead the job queries the pull request's labels live, at run time, through
the API rather than from `github.event`. Adding the label after a failure means
clicking it and pressing **Re-run failed jobs**, which re-runs that job and the
gate and nothing else. No new trigger types, no full re-test, and the event
payload's staleness stops mattering.

## Placement *(approved)*

A new pull-request-only job **`cli-version`** in `deploy.yml`, beside
`contract-version`, added to `required`'s `needs:` and to its result loop.
Like `contract-version` it takes `fetch-depth: 0` so the base ref is available
to diff against, and it declares its permissions explicitly:

```yaml
permissions:
  contents: read
  pull-requests: read
```

`deploy.yml` has no top-level `permissions:` block, so every job that needs
more than the default says so itself. `tag-cli.yml` already sets per-job
permissions with a comment explaining why.

The logic goes in **`scripts/cli-version.sh`** with
**`scripts/cli-version.test.sh`** beside it, run from `quality` as
`bash scripts/cli-version.test.sh` alongside the seven script suites already
there. `contract-version` is inline because it is a straight-line thirty lines.
This one derives a path set from a manifest, compares two versions, and queries
an API — the shape `deployable.sh` earned a script and a test file for.

## Seams *(approved)*

`deployable.sh` isolates its one network call and exposes its decision logic as
subcommands reading stdin, so its tests exercise the real code offline without
stubbing `gh`. Its own header argues the point: feeding real inputs to the real
code is the only way the tests can fail for the reason they claim to. Same
structure here.

| Invocation | Does | Pure |
| --- | --- | --- |
| `--paths` | Reads `apps/cli/package.json`, resolves each `workspace:*` dependency to its directory by matching `name` across `packages/*/package.json`, prints `apps/cli/src` and each dependency's `src` | yes |
| `--deps-differ OLD NEW` | Compares `jq -S .dependencies` of two manifest files; exit 0 when they differ | yes |
| `--decide` | Reads a changed-file list on stdin; takes `--source-paths`, `--old-version`, `--new-version`, `--labels`; prints one verdict | yes |
| *(no arguments)* | Gathers all four from git and `gh`, composes them, emits the annotation | no |

`--decide` takes the **whole** changed-file list on stdin — `git diff
--name-only` output, one per line, which is how the real run hands it over —
and filters it against `--source-paths` itself. It does not call `--paths`. A
test can therefore feed any combination of files and path sets without building
a manifest to imply them.

Verdicts, one token each:

```
pass:no-cli-change   pass:bumped   pass:deferred
fail:no-bump         fail:backward
```

The gatherer supplies `--old-version` from `git show
"$BASE:apps/cli/package.json" | jq -r .version` and `--new-version` from
`jq -r .version apps/cli/package.json`.

## The decision *(approved)*

1. **Derive the path set** with `--paths`. Today it resolves to
   `apps/cli/src` and `packages/lesson-contract/src`. Derived rather than
   hardcoded, so adding a workspace dependency to the CLI widens the gate
   automatically instead of silently reopening this hole.

2. **Did any of it change** in `BASE...HEAD`, where `BASE` is
   `origin/${{ github.base_ref }}`? Nothing changed → `pass:no-cli-change`.

   `apps/cli/package.json` is a special case and is deliberately *not* in the
   derived path set. It changes on every bump, and it also carries `scripts`,
   `bin` and `devDependencies`, none of which alter the shipped binary. So the
   gatherer runs `--deps-differ` across the range and appends the manifest to
   the **source path set** it hands `--decide` — not to the changed-file list,
   which already contains it — **only** when the `dependencies` block itself
   differs. A dependency bump changes the bundle without touching a line of
   first-party source; everything else in that file does not.

3. **Did `version` change** between base and head? Yes → `pass:bumped`, unless
   `sort -V` says it moved backward → `fail:backward`. `contract-version`
   carries that guard because publishing a lower number moves a dist-tag
   backward; the CLI has a Homebrew tap that would take the lower number the
   same way.

4. **Is `cli-batch` on the pull request**, read live via
   `gh pr view "$PR" --json labels --jq '.labels[].name'`? Yes →
   `pass:deferred`, printing which paths are being deferred so the run log
   records what the batch contains.

5. Otherwise → `fail:no-bump`.

## The failure *(approved)*

```
::error title=CLI source changed without a release::apps/cli/src/sessions.ts,
packages/lesson-contract/src/lesson.ts changed, but apps/cli/package.json is
still 2.6.0. tag-cli.yml releases on a version change and nothing else, so this
merges, deploys the API and the web app, and leaves every installed `onlooker`
running the old binary - the failure in #141 and #167. Bump the version here,
or add the `cli-batch` label and re-run this job to release these changes
together later.
```

It names the paths that changed, the version that stayed, the mechanism, the
precedent, and both ways out. The escape hatch is in the failure that sends you
looking for it, so it teaches itself and needs no documentation nobody reads.

`cli-batch` does not exist yet — this repository carries only the nine GitHub
defaults — so it is created once with `gh label create`, with a description
that says what it means.

## Tests *(approved)*

`cli-version.test.sh` builds throwaway git trees under a temporary directory
and drives the pure subcommands. No network, and no `gh` stub, because the code
that talks to `gh` is not the code being tested.

| Seam | Case | Expected |
| --- | --- | --- |
| `--decide` | Nothing under the path set changed | `pass:no-cli-change` |
| `--decide` | `apps/cli/src` changed, version bumped | `pass:bumped` |
| `--decide` | `apps/cli/src` changed, version unchanged | `fail:no-bump` |
| `--decide` | Same, with `cli-batch` among the labels | `pass:deferred` |
| `--decide` | Same, with other labels but not `cli-batch` | `fail:no-bump` |
| `--decide` | `packages/lesson-contract/src` changed, version unchanged | `fail:no-bump` |
| `--decide` | Only unrelated files changed, version bumped | `pass:no-cli-change` |
| `--decide` | Version moved 2.6.0 → 2.5.0 | `fail:backward` |
| `--deps-differ` | `dependencies` differ | exit 0 |
| `--deps-differ` | Only `version` differs | exit 1 |
| `--deps-differ` | Only `scripts` or `devDependencies` differ | exit 1 |
| `--paths` | Manifest with one `workspace:*` dependency | both paths |
| `--paths` | A second `workspace:*` dependency added | widens |

Row six is the one a gate scoped to `apps/cli/src` would get wrong. Rows ten
and eleven are what stop every version bump and every script edit from reading
as a source change. Row thirteen keeps the derivation honest as the manifest
grows.

## Deliberately out of scope *(approved)*

- **No run on `main`.** A push has no base ref to diff against, and the
  standing "unreleased CLI code exists" alarm was considered and not chosen:
  it fires after the merge and leaves `main` red for the whole duration of a
  deliberate batch.
- **It does not decide the version number.** A person still does, in the pull
  request that earns it, which is exactly where `7af44e2` argued the bump
  belonged and where `tag-cli.yml`'s header says the decision lives.
- **It does not cover a direct push to `main`.** The ruleset requires pull
  requests and the repository owner is a bypass actor, so that path exists and
  no pull-request job can see it. That belongs in its own bead rather than
  widening this one.
