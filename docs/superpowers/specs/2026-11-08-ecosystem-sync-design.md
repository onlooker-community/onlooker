# Ecosystem sync: keep onlooker.dev in step with ecosystem

Linear: ONL-277. Approved 2026-11-08.

## Problem

onlooker.dev's plugin pages read ecosystem's marketplace at build time, and the
website builds only in a production deploy. An ecosystem release, about two a
day, reaches the site only when an unrelated onlooker change happens to deploy.
The committed fallback, `apps/website/src/data/plugins/marketplace.fixture.json`,
is never refreshed, and a plugin added to the marketplace without a prose file
is first noticed by the strict production build.

## Scope

The website rows of ONL-277 only: the marketplace data, the fixture, and the
per-plugin prose files. The CLI rows (`apps/cli/src/streams.ts`,
`apps/cli/src/enablement.ts`) are out of scope; they need a drift check, not a
deploy, and get noted in a Linear project document rather than a new issue.

## Decisions

- **Scheduled sync PR.** An onlooker workflow keeps one rolling bot PR up to
  date. Ecosystem is not changed and holds no new secret.
- **No auto-merge.** Each merge is one website approval; auto-merge would turn
  every ecosystem release into one.
- **No dispatch from ecosystem.** The PR waits for a human either way, so a
  faster trigger would not change when anything ships.
- **The website gets its own job and GitHub environment**, because the deploy
  filter anchors on each environment's last successful deployment (see Part 1).

## Part 1: the website deploys as its own surface

### Why not skip steps inside `deploy-production`

`scripts/deployable.sh` answers "is anything pending?" by diffing from the
newest *successful deployment to the environment*. If a website-only run
succeeded inside `deploy-production`, it would record a `production`
deployment at its commit although the API and web app never redeployed:

1. Commit A changes the API; its approval is rejected.
2. Commit B is an ecosystem sync; its approval is granted.
3. Production now records B, so A's API change reads as already live.

That is onlooker-txcu.7's silent skip by a different route. Each surface
therefore records its deployments in its own environment.

### Jobs

- **`deploy-production`** (environment `production`): migrations, API, web
  app, production smoke test. Build Website and Deploy Website move out.
- **`deploy-website`** (new; environment `website`, which has a required
  reviewer): Build Website, with `MARKETPLACE_REQUIRED: 'true'` and its Sentry
  env unchanged, then Deploy Website. It builds its own dependencies, since
  `deploy-production`'s Build step may not run in the same job. Concurrency
  group `deploy-website`, `cancel-in-progress: false`.
  - Runs on `main` only, for a push whose website answer is `true` or for
    `workflow_dispatch`, after `test` succeeds.
  - When `deploy-production` also runs, `deploy-website` runs after it,
    keeping today's order. A skipped or failed `deploy-production` does not
    block it. That is a change: today both share a job, so a failed API
    deploy also stops the website deploy. The website does not depend on the
    API to build or serve, and a website change must not wait on an API
    approval or failure.
  - A run that changes both surfaces shows both environments in GitHub's
    "Review deployments" dialog, so one review approves both.
- **`deploy-staging`** is unchanged in content. Staging never deployed the
  website, so its answer is the apps surface only: a website-only merge skips
  staging, and `deploy-production`'s existing condition (staging skipped and
  `changes.staging == 'false'`) still holds.

### The filter

`scripts/deployable.sh <environment> <surface>`, surface `apps` or `website`.

| Paths | apps | website |
| -- | -- | -- |
| `apps/api/`, `apps/web/` | yes | no |
| `apps/website/` | no | yes |
| `packages/`, `package.json`, `pnpm-lock.yaml`, `turbo.json`, `.github/workflows/deploy.yml` | yes | yes |

The markdown rule (docs-only changes deploy nothing, except under `src/`), the
`core.quotePath=false` diff, and "every failure answers `true`" are unchanged.
The `changes` job outputs `staging` (staging, apps), `production` (production,
apps) and `website` (website, website). A non-push event still answers `true`
for all three. The first run against `website` finds no deployment on record,
and the existing fallback answers `true`.

The `website` environment was created on 2026-11-08 with a required reviewer.
Secrets are repository-level, so none move.

## Part 2: the sync workflow

`.github/workflows/ecosystem-sync.yml`, on an hourly `schedule` and
`workflow_dispatch`. It deploys nothing. The logic lives in a script under
`scripts/`, not in YAML, so it can be tested offline.

Each run:

1. **Pin one ecosystem commit.** Resolve the SHA of ecosystem's `main`, then
   read `.claude-plugin/marketplace.json` and every `plugin.json` at that SHA.
2. **Rebuild the fixture with the website's own loader.** `marketplace.ts`
   exports `fromGitHub` and gives it a `ref` used for the raw reads (default
   `main`). `readmeUrl` keeps `blob/main/`, so the fixture is exactly what a
   live build of `main` would produce.
3. **Record the commit.** The fixture becomes
   `{ "commit": "<40-char sha>", "plugins": [...] }`. `marketplace.ts`,
   `marketplace.test.ts` and `plugin-pages.test.ts` read `fixture.plugins`.
4. **Stop if nothing changed.** If the generated fixture equals the one on
   onlooker's `main`, the run exits without pushing or editing a PR.
5. **Update one branch and one PR.** Branch `bot/ecosystem-sync`:
   - If it exists, check it out, merge `origin/main` into it, regenerate the
     fixture on top, commit if it changed, and push without force. A commit
     someone added there, such as a new prose file, survives the next run. A
     merge conflict fails the run and names the files; the run never resolves
     one itself.
   - If not, create it from `origin/main`.
   - Open the PR if none is open for the branch; otherwise edit its body.
   - The body is regenerated each run and covers everything from `main`'s
     recorded commit to the new one:
     - version and description changes, one line per plugin;
     - plugins added and removed;
     - each plugin README that changed (`README.md` for `ecosystem`,
       `plugins/<name>/README.md` for the rest; other READMEs ignored), with a
       compare link, naming the prose file to re-check.
   - When `main`'s fixture has no recorded commit (the first sync), the body
     says so and lists no README changes.

Merging the sync PR is the point where the prose is confirmed against the
listed READMEs.

### Token

The workflow mints a token from the `onlooker-cli-release` App
(`TAP_APP_ID`, `TAP_APP_PRIVATE_KEY`), scoped to this repository, as
`tag-cli.yml` does. A PR opened with `GITHUB_TOKEN` runs no workflows, so it
could never report `All checks passed`. The App has **Contents: read and
write**; it also needs **Pull requests: read and write**, which the owner adds
in the App's settings and accepts on the org installation. The App's bypass on
"Require Pull Request" never applies: it pushes only to `bot/ecosystem-sync`.
`docs/runbooks/2026-09-05-cli-release-tap-app.md` records the new permission
and why.

### Prose checks

`plugin-pages.test.ts` already fails when a fixture plugin has no prose file
and when a prose file has no plugin. With the fixture tracking ecosystem, those
tests fail on the sync PR within an hour of a plugin being added or removed.
The fix is a commit on the sync branch.

## Failures

- Ecosystem or GitHub unreachable, or a bad `plugin.json`/`marketplace.json`:
  the run fails with the loader's reason. No fixture is written and no branch
  or PR changes.
- Merge conflict on the bot branch: the run fails and names the conflict.
- Deploy filter: every failure still answers "deploy".
- The production Build Website step stays strict, so the site never ships
  fixture data during a GitHub outage.

## Tests

- `scripts/deployable.test.sh`: per environment and surface — a fixture-only
  change gives website `true`, apps `false`; an `apps/api/` change gives apps
  `true`, website `false`; a `packages/` change gives both `true`. Proved by
  ablation: counting `apps/website/` for apps must fail the first case.
- `deploy.yml` read as text, as `monitoring.test.ts` already does:
  `deploy-website` uses environment `website` and not `production`; Build
  Website keeps `MARKETPLACE_REQUIRED` (the existing assertion moves from
  `deploy-production` to `deploy-website`).
- `marketplace.test.ts`: `ref` reaches the raw URLs while `readmeUrl` stays on
  `main`; the fixture's `commit` is a 40-character hex SHA.
- The sync script: PR-body rendering from fixed before/after fixtures (version
  and description changes, added and removed plugins, changed READMEs); two
  equal fixtures produce no change.
- Not testable offline: the App token and opening a real PR. After merge, one
  `workflow_dispatch` run of `ecosystem-sync.yml` checks both, and is the
  plan's last step.

## Done when (from ONL-277)

- An ecosystem merge touching the marketplace, a `plugin.json` or a plugin
  README leads, with no manual step, to an onlooker PR saying what changed.
- The fixture is refreshed by the same mechanism.
- A plugin added with no prose file fails the sync PR's CI within an hour.
- An ecosystem-only change deploys the website alone; the API and web app do
  not redeploy.
