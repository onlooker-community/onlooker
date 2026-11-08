# Ecosystem Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep onlooker.dev's plugin pages in step with ecosystem through one rolling bot PR, and let a website-only merge deploy the website alone.

**Architecture:** The deploy filter learns surfaces (`apps`, `website`), and the website gets its own `deploy-website` job on its own `website` GitHub environment, so each surface's last successful deployment is recorded separately. An hourly workflow regenerates the marketplace fixture with the website's own loader at a pinned ecosystem commit, records that commit in the fixture, and keeps one PR on `bot/ecosystem-sync` up to date with a body saying what changed.

**Tech Stack:** Bash (`scripts/deployable.sh` and its offline test harness), GitHub Actions, TypeScript with Vitest (apps/website), `tsx` 4.22.4 (root devDependency) to run a TypeScript CLI.

**Spec:** `docs/superpowers/specs/2026-11-08-ecosystem-sync-design.md`. Linear: ONL-277.

## Global Constraints

- Edit tracked files with the Edit or Write tool only. Never `sed -i`, heredocs, `cp`, or any script that writes a tracked file — the repo's lineage plugin records tool edits only. This includes generated files: when a step generates content (the fixture), write it to the scratchpad, then put it in place with Write.
- Never run `biome check --write`, `biome format --write`, `lint:fix` or `format`. If lint reports a formatting error, fix it with Edit.
- American English in code, comments, commits and docs.
- Comments match the surrounding files: they explain *why*, in full sentences, wrapped at 80 columns.
- Run one website test file as `pnpm --filter @onlooker/website test <name>`, with no `--` (with `--` the whole suite runs).
- Commits: `<type>(<scope>): <subject> :emoji:`, subject ≤72 characters, lowercase after the colon, a why-focused body wrapped at 80 columns, ending `Refs ONL-277`. `git add` named files only, never `-A` or `.`. Never push.
- Do not change anything in the ecosystem repository.
- The GitHub environment `website` already exists with a required reviewer. Secrets are repository-level; do not move or add any.
- Surface names are exactly `apps` and `website`. The `changes` job outputs are exactly `staging`, `production` and `website`.
- Sync branch: `bot/ecosystem-sync`. Fixture shape: `{ "commit": "<40-char lowercase hex>", "plugins": MarketplacePlugin[] }`.

## File Structure

| File | Responsibility |
| -- | -- |
| `scripts/deployable.sh` (modify) | Answer "is anything pending?" per environment **and surface** |
| `scripts/deployable.test.sh` (modify) | Offline tests for the above |
| `.github/workflows/deploy.yml` (modify) | `changes` gains a `website` output; website steps move to a new `deploy-website` job on environment `website` |
| `apps/website/src/__tests__/marketplace.test.ts` (modify) | Reads deploy.yml as text; loader `ref`; fixture shape |
| `apps/website/src/lib/marketplace.ts` (modify) | Export `fromGitHub(read, ref)`; read the new fixture shape |
| `apps/website/src/lib/ecosystem-sync.ts` (create) | Pure: compare two fixtures plus a changed-file list, render the PR body |
| `apps/website/src/__tests__/ecosystem-sync.test.ts` (create) | Tests for the above |
| `apps/website/scripts/ecosystem-sync.ts` (create) | CLI: read at a commit, call `summarize`, write fixture and body to given paths |
| `apps/website/src/data/plugins/marketplace.fixture.json` (modify) | New shape, regenerated at ecosystem's current `main` |
| `apps/website/src/__tests__/plugin-pages.test.ts` (modify) | Read `fixture.plugins` |
| `scripts/ecosystem-sync.sh` (create) | Git and GitHub side of the sync: diff, branch, push, PR |
| `.github/workflows/ecosystem-sync.yml` (create) | Hourly + manual trigger, App token, two checkouts |
| `docs/runbooks/2026-09-05-cli-release-tap-app.md` (modify) | Record the App's third job and its Pull requests permission |

---

### Task 1: The deploy filter answers per surface

**Files:**
- Modify: `scripts/deployable.sh` (the `DEPLOYABLE_PATHS` block, `match_paths`, the argument `case`, the final `match_paths` call)
- Test: `scripts/deployable.test.sh`

**Interfaces:**
- Produces: `scripts/deployable.sh <production|staging|website> <apps|website>` prints `true`/`false`; `scripts/deployable.sh --match <apps|website> < file-list`; `--select-sha` unchanged. A missing or unknown surface exits 2. Task 2 calls it as `staging apps`, `production apps`, `website website`.

- [ ] **Step 1: Give `expect_match` a surface and rewrite the path cases**

In `scripts/deployable.test.sh`, replace the `expect_match` helper with:

```bash
# expect_match <expected> <surface> <description> <path...>
#
# Asserts the answer the path matcher gives for a set of changed files on one
# surface. The paths are passed as arguments and fed in on stdin, because that
# is how the real run hands them over - `git diff --name-only` output, one per
# line.
expect_match() {
	local expected="$1" surface="$2" description="$3"
	shift 3

	tests=$((tests + 1))

	local actual=""
	actual="$(printf '%s\n' "$@" | "${DEPLOYABLE}" --match "${surface}" 2>/dev/null)"

	if [[ "${actual}" == "${expected}" ]]; then
		echo "  ok    ${description}"
	else
		echo "  FAIL  ${description} -> '${actual}' (expected '${expected}')"
		failures=$((failures + 1))
	fi
}
```

Then replace everything from `echo "deployable.sh: which paths are worth a deploy"` up to (not including) `echo "deployable.sh: which commit counts as last deployed"` with:

```bash
echo "deployable.sh: which paths are worth a deploy"

expect_match "true" apps "an api source file deploys the apps" "apps/api/src/email/index.ts"
expect_match "true" apps "a web source file deploys the apps" "apps/web/src/main.tsx"
expect_match "true" website "a website source file deploys the website" "apps/website/src/index.astro"

# The split ONL-277 exists for. A sync PR changes only the fixture, and it must
# deploy the website without redeploying the API and web app.
expect_match "true" website "the marketplace fixture deploys the website" \
	"apps/website/src/data/plugins/marketplace.fixture.json"
expect_match "false" apps "the marketplace fixture does not deploy the apps" \
	"apps/website/src/data/plugins/marketplace.fixture.json"
expect_match "false" website "an api source file does not deploy the website" \
	"apps/api/src/index.ts"

# apps/web/ is a prefix of apps/website/ in everything but the slash. These two
# prove the slash is load-bearing in both directions.
expect_match "false" apps "apps/website/ is not apps/web/" "apps/website/src/index.astro"
expect_match "false" website "apps/web/ is not apps/website/" "apps/web/src/main.tsx"

# Shared inputs reach every surface: a package or a lockfile change can alter
# any bundle, and a redundant deploy costs minutes where a skipped one ships
# nothing.
for surface in apps website; do
	expect_match "true" "${surface}" "a shared package deploys ${surface}" \
		"packages/api-contract/src/redact.ts"
	expect_match "true" "${surface}" "the root manifest deploys ${surface}" "package.json"
	expect_match "true" "${surface}" "the lockfile deploys ${surface}" "pnpm-lock.yaml"
	expect_match "true" "${surface}" "the turbo config deploys ${surface}" "turbo.json"
	expect_match "true" "${surface}" "deploy.yml deploys ${surface}" ".github/workflows/deploy.yml"

	expect_match "false" "${surface}" "another workflow does not deploy ${surface}" \
		".github/workflows/heartbeat.yml"
	expect_match "false" "${surface}" "documentation does not deploy ${surface}" \
		"docs/superpowers/specs/whatever.md"
	expect_match "false" "${surface}" "the issue export does not deploy ${surface}" \
		".beads/issues.jsonl"
	expect_match "false" "${surface}" "a bare readme does not deploy ${surface}" "README.md"
	expect_match "false" "${surface}" "nothing changed at all deploys nothing on ${surface}" ""
done

# The pattern is anchored, and this is the test that proves it. An unanchored
# match would see "apps/api/" inside a documentation path and deploy the whole
# stack because somebody wrote about the API.
expect_match "false" apps "a doc that merely names a deployable path does not" \
	"docs/apps/api/overview.md"

# Markdown under a deployable path is documentation, and rebuilding unchanged
# code for it is a deploy run spent on nothing (ONL-251). Under src/ it is
# exempt from that: a content collection or a `?raw` import puts Markdown in
# the bundle, and a filter that skipped it would strand a real change.
expect_match "false" apps "an app's markdown does not" "apps/api/DEV.md"
expect_match "false" apps "a package's markdown does not" "packages/brand/ATTRIBUTION.md"
expect_match "false" apps "several app docs together do not" \
	"apps/web/API_INTEGRATION.md" "apps/web/INTEGRATION_TEST_CHECKLIST.md" \
	"apps/api/DEPLOYMENT.md"
expect_match "true" website "markdown under src/ deploys" \
	"apps/website/src/content/post.md"
expect_match "true" apps "an app doc alongside its code deploys" \
	"apps/api/DEV.md" "apps/api/src/router.ts"

expect_match "true" apps "one deployable file among many that are not" \
	"README.md" "docs/notes.md" "apps/api/src/index.ts" ".beads/issues.jsonl"
```

And replace the usage block at the end (the two `expect_exit 2` lines) with:

```bash
echo "deployable.sh: usage"

expect_exit 2 "no environment named"
expect_exit 2 "an environment that does not exist" "preprod" "apps"
expect_exit 2 "no surface named" "production"
expect_exit 2 "a surface that does not exist" "production" "everything"
expect_exit 2 "--match with no surface" "--match"
expect_exit 2 "--match with a surface that does not exist" "--match" "everything"
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bash scripts/deployable.test.sh`
Expected: exit 1. `--match` ignores its argument today, so the "does not deploy" cases on one surface fail (for example "the marketplace fixture does not deploy the apps" prints `'true'`), and `expect_exit 2 "no surface named" "production"` fails because the script tries to reach the API instead.

- [ ] **Step 3: Teach `deployable.sh` surfaces**

Replace the `DEPLOYABLE_PATHS` comment and constant with:

```bash
# Paths whose contents end up in a deployed artifact, per surface.
#
# A surface is a set of things that deploy together and are recorded together.
# `apps` is the API and web app, which deploy to staging and to `production`.
# `website` is onlooker.dev, which deploys only to its own `website`
# environment. They are separate because this script anchors on each
# environment's last SUCCESSFUL deployment: if a website-only change deployed
# through `production`, it would record a production deployment at a commit
# whose API changes never shipped, and they would read as live from then on
# (ONL-277).
#
# Shared inputs count for both. A package, the lockfile or the build config can
# change any bundle, and a redundant deploy costs minutes where a skipped one
# ships nothing.
#
# Anchored at the start of the path, which is load-bearing: unanchored, a
# document that merely mentions `apps/api/` would deploy the entire stack.
# deploy.yml is here because a change to how deploying works has to be able to
# deploy itself; no other workflow can. `apps/(api|web)/` keeps its trailing
# slash so that apps/website/ is not mistaken for apps/web/.
readonly SHARED_PATHS='packages/|package\.json|pnpm-lock\.yaml|turbo\.json|\.github/workflows/deploy\.yml'
readonly APPS_PATHS="^(apps/(api|web)/|${SHARED_PATHS})"
readonly WEBSITE_PATHS="^(apps/website/|${SHARED_PATHS})"
```

Add, directly after the `DEPLOYMENT_SEARCH_DEPTH` block:

```bash
usage() {
	echo "usage: $(basename "$0") production|staging|website apps|website" >&2
	echo "       $(basename "$0") --match apps|website < changed-file-list" >&2
	echo "       $(basename "$0") --select-sha        < deployments-json" >&2
	exit 2
}

# Print the path pattern for a surface. Returns 1 for anything else, so a typo
# in deploy.yml is a usage error rather than a surface that never deploys.
paths_for() {
	case "${1:-}" in
		apps) printf '%s\n' "${APPS_PATHS}" ;;
		website) printf '%s\n' "${WEBSITE_PATHS}" ;;
		*) return 1 ;;
	esac
}
```

Change `match_paths` to take the pattern as its argument. Its header comment becomes `# Read changed file names on stdin, print whether any of them matches the
# pattern in $1.` (keep the rest of the comment), and its `if` line becomes:

```bash
	if awk '!(/\.md$/ && !/\/src\//)' | grep -E "$1" >/dev/null; then
```

Replace the argument `case` and the two lines after it (`readonly ENVIRONMENT=...`, `readonly HEAD_SHA=...`) with:

```bash
case "${1:-}" in
	--match)
		pattern="$(paths_for "${2:-}")" || usage
		match_paths "${pattern}"
		exit 0
		;;
	--select-sha)
		select_sha
		exit $?
		;;
	production | staging | website) ;;
	*) usage ;;
esac

readonly ENVIRONMENT="$1"
# Checked before anything reaches the network, so a bad surface fails the same
# way offline and in CI.
PATTERN="$(paths_for "${2:-}")" || usage
readonly PATTERN
readonly HEAD_SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"
```

Change the last line of the script to:

```bash
printf '%s\n' "${changed}" | match_paths "${PATTERN}"
```

Update the header usage line near the top to `# Usage: scripts/deployable.sh production|staging|website apps|website`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bash scripts/deployable.test.sh`
Expected: `deployable.test.sh: all N tests passed`, exit 0.

- [ ] **Step 5: Prove the split test by ablation**

Temporarily change `APPS_PATHS` to `"^(apps/(api|web|website)/|${SHARED_PATHS})"` with Edit and run `bash scripts/deployable.test.sh`.
Expected: FAIL on "the marketplace fixture does not deploy the apps" and "apps/website/ is not apps/web/". Revert with Edit, re-run, expect all pass. Record both outputs in the report.

- [ ] **Step 6: Check the script's other gates**

Run: `bash -n scripts/deployable.sh && bash scripts/source-guards.test.sh`
Expected: exit 0 for both. (Lint also runs shell checks in CI; if `pnpm lint` at the root reports anything in these files, fix it with Edit.)

- [ ] **Step 7: Commit**

```bash
git add scripts/deployable.sh scripts/deployable.test.sh
git commit -m "<message per Global Constraints>"
```

Suggested subject: `feat(deploy): answer the change filter per surface :compass:`

---

### Task 2: The website deploys in its own job and environment

**Files:**
- Modify: `.github/workflows/deploy.yml` (the `changes` job's outputs and filter step; `deploy-production`'s Build, Build Website, Deploy Website and Smoke test comments; a new `deploy-website` job after `deploy-production`)
- Test: `apps/website/src/__tests__/marketplace.test.ts` (the `MARKETPLACE_REQUIRED reaches the production website build` describe)

**Interfaces:**
- Consumes: Task 1's `scripts/deployable.sh <environment> <surface>`.
- Produces: `needs.changes.outputs.website`; job id `deploy-website`, name `Deploy Website`, environment `website`.

- [ ] **Step 1: Point the workflow tests at the new job**

In `apps/website/src/__tests__/marketplace.test.ts`, move the workflow reading to module scope so two describes can share it. Delete the `root` and `deploy` constants and the `productionSteps` and `step` functions from inside the `MARKETPLACE_REQUIRED reaches the production website build` describe, and add this directly above that describe (its comment block stays where it is, above the describe):

```ts
const root = new URL("../../../../", import.meta.url);
const deploy = readFileSync(
	new URL(".github/workflows/deploy.yml", root),
	"utf8",
);

/** A deploy.yml job's text, from its `  <id>:` line to the next job. */
function job(id: string): string {
	const start = deploy.indexOf(`\n  ${id}:`);
	if (start === -1) throw new Error(`deploy.yml has no ${id} job`);
	const rest = deploy.slice(start + 1);
	const end = rest.search(/\n {2}[a-z][\w-]*:\n/);
	return end === -1 ? rest : rest.slice(0, end);
}

/** A job's steps, in order, each as its name and its text. */
function steps(id: string): { name: string; text: string }[] {
	return job(id)
		.split(/\n {6}- /)
		.slice(1)
		.map((text) => ({
			name: text.match(/^name: (.+)/)?.[1] ?? "",
			text,
		}));
}

function step(id: string, name: string): string {
	const found = steps(id).find((s) => s.name === name);
	if (!found) throw new Error(`${id} has no "${name}" step`);
	return found.text;
}
```

Update the three step tests and replace the ordering test:

```ts
	it("is not set on the production job's main Build, which skips the website", () => {
		const build = step("deploy-production", "Build");
		expect(build).toMatch(/run: pnpm build --filter='!@onlooker\/website'\n/);
		expect(build).not.toMatch(/MARKETPLACE_REQUIRED/);
	});

	it("is set to true on a Build Website step that builds only the website", () => {
		const build = step("deploy-website", "Build Website");
		expect(build).toMatch(/run: pnpm --filter @onlooker\/website build\n/);
		expect(build).toMatch(/MARKETPLACE_REQUIRED: ['"]true['"]/);
	});

	it("builds the website's dependencies, then the website, then deploys it", () => {
		const names = steps("deploy-website").map((s) => s.name);
		const at = names.indexOf("Build Website");
		expect(names[at - 1]).toBe("Build website dependencies");
		expect(names[at + 1]).toBe("Deploy Website to Production");
		expect(step("deploy-website", "Build website dependencies")).toMatch(
			/run: pnpm build --filter='@onlooker\/website\^\.\.\.'\n/,
		);
	});
```

Keep `is declared through astro:env`, `is in turbo's build env` and `is set nowhere else in the workflow` as they are. Add a new describe after it:

```ts
// scripts/deployable.sh measures each surface from the last successful
// deployment in its environment. A website deploy recorded under `production`
// would mark API changes that never shipped as live (ONL-277), so these hold
// the split in place.
describe("the website deploys on a record of its own", () => {
	it("uses the website environment, not production", () => {
		expect(job("deploy-website")).toMatch(/environment:\n\s+name: website\n/);
		expect(job("deploy-website")).not.toMatch(/name: production\n/);
	});

	it("leaves no website step in the production job", () => {
		expect(job("deploy-production")).not.toMatch(/deploy:website/);
		expect(job("deploy-production")).not.toMatch(/name: Build Website\n/);
	});

	it("does not wait for the production deploy", () => {
		expect(job("deploy-website")).toMatch(/needs: \[test, changes\]\n/);
	});

	it("asks the filter about the website surface on its own environment", () => {
		expect(job("changes")).toMatch(/deployable\.sh website website\)/);
		expect(job("changes")).toMatch(/deployable\.sh production apps\)/);
		expect(job("changes")).toMatch(/deployable\.sh staging apps\)/);
	});
});
```

- [ ] **Step 2: Run the test file and watch it fail**

Run: `pnpm --filter @onlooker/website test marketplace`
Expected: FAIL — `deploy.yml has no deploy-website job`, and the `changes` assertions.

- [ ] **Step 3: Change the `changes` job**

In `outputs:` add `website: ${{ steps.filter.outputs.website }}` after `production`. In the non-push branch add `echo "website=true" >> "$GITHUB_OUTPUT"` after the production line. Replace the two `if ! ...deployable.sh...` blocks and the echo lines after them with:

```bash
          if ! STAGING="$(./scripts/deployable.sh staging apps)"; then
            echo "deployable: staging check failed; deploying rather than guessing"
            STAGING=true
          fi
          if ! PRODUCTION="$(./scripts/deployable.sh production apps)"; then
            echo "deployable: production check failed; deploying rather than guessing"
            PRODUCTION=true
          fi
          # The website has no staging, and records its deployments in its own
          # environment so a website-only deploy cannot mark an undeployed API
          # change as live. See deploy-website.
          if ! WEBSITE="$(./scripts/deployable.sh website website)"; then
            echo "deployable: website check failed; deploying rather than guessing"
            WEBSITE=true
          fi
          echo "staging=${STAGING} production=${PRODUCTION} website=${WEBSITE}"

          echo "staging=${STAGING}" >> "$GITHUB_OUTPUT"
          echo "production=${PRODUCTION}" >> "$GITHUB_OUTPUT"
          echo "website=${WEBSITE}" >> "$GITHUB_OUTPUT"
```

In the comment above `deploy-staging`'s `if:`, change "keeps a CLI-only merge from redeploying the API, web and website with identical code" to "keeps a CLI-only or website-only merge from redeploying the API and web app with identical code".

- [ ] **Step 4: Move the website steps into `deploy-website`**

In `deploy-production`:
- Change the comment above `- name: Build` to: "Every package but the website, which deploys in its own job, deploy-website. Nothing depends on @onlooker/website, so the filter drops it and nothing else."
- Delete the `Build Website` step and the `Deploy Website to Production` step, each with its comment block.
- In the comment above `Smoke test Production`, change "Runs after the website deploy as well as the app and API, so it is the last word on a production release." to "Runs after the app and API deploys, so it is the last word on their release."

Directly after the whole `deploy-production` job (before the `REQUIRED CHECK GATE` banner), add:

```yaml
  # ============================================================================
  # DEPLOY THE WEBSITE
  # ============================================================================
  deploy-website:
    name: Deploy Website
    runs-on: ubuntu-latest
    # Its own job and its own environment, and the environment is the point.
    # scripts/deployable.sh measures each surface from the last SUCCESSFUL
    # deployment recorded in its environment. A website-only run that deployed
    # through `production` would record a production deployment at a commit
    # whose API and web changes never shipped, and the filter would treat them
    # as live from then on - onlooker-txcu.7 by another door. See ONL-277 and
    # docs/superpowers/specs/2026-11-08-ecosystem-sync-design.md.
    #
    # Queued and never cancelled, like the other deploys: a cancel can land
    # halfway through an upload as easily as halfway through a migration.
    concurrency:
      group: deploy-website
      cancel-in-progress: false
    # Not `needs: deploy-production`. Waiting on it would hold this job until
    # production is approved, so a run that changes both would ask for two
    # approvals one after the other instead of one review covering both, and a
    # rejected or failed API deploy would strand a website change that does
    # not depend on it. Until ONL-277 the two shared a job, so a failed API
    # deploy also stopped the website; that coupling is gone on purpose.
    #
    # There is no staging website, so nothing has to deploy first.
    needs: [test, changes]
    # A manual run ignores the filter for deploy-staging's reason: the button
    # exists for when the filter was wrong.
    if: >-
      github.ref == 'refs/heads/main'
      && (
        (github.event_name == 'push' && needs.changes.outputs.website == 'true')
        || github.event_name == 'workflow_dispatch'
      )
    environment:
      name: website
      url: https://onlooker.dev
    steps:
      - uses: actions/checkout@v5

      - name: Setup Node.js
        uses: actions/setup-node@v5
        with:
          node-version: ${{ env.NODE_VERSION }}
          # See deploy-production: pnpm is installed after this step, so
          # auto-caching would invoke a pnpm that does not exist yet.
          package-manager-cache: false

      - name: Install pnpm
        run: npm install -g pnpm@${{ env.PNPM_VERSION }}

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      # The packages the website imports, and not the website: Build Website
      # below builds it strictly, on its own, so a GitHub outage fails only
      # that step.
      - name: Build website dependencies
        run: pnpm build --filter='@onlooker/website^...'

      <the Build Website step, moved from deploy-production with its comment>

      <the Deploy Website to Production step, moved from deploy-production with its comment>

      - name: Notify Deployment
        if: always()
        uses: actions/github-script@v8
        with:
          script: |
            const status = '${{ job.status }}';
            const deployment_url = 'https://onlooker.dev';
            const commit_sha = '${{ github.sha }}'.substring(0, 7);

            console.log(`Website deployment: ${status}`);
            console.log(`URL: ${deployment_url}`);
            console.log(`Commit: ${commit_sha}`);
```

The two moved steps are moved verbatim (step body and env unchanged), with these comment edits only:
- Build Website's comment: replace "apart from Build above because it is the one build that reads the network" with "apart from its dependencies' build because it is the one build that reads the network"; replace "Build runs before the API and Web deploys, so a strict check there would let a GitHub outage block both. Here a failure stops only the website deploy and the smoke test after it." with "In its own job it cannot block the API or web deploys at all; a failure stops only the website."; replace "Its dependencies were built by Build above; this builds the website alone, so it does not rebuild them." with "Its dependencies were built by the step above; this builds the website alone, so it does not rebuild them."
- Deploy Website's comment: replace "It sits in this job rather than its own so it is behind the same production approval gate as everything else user-facing." with "It sits behind the `website` environment's own required reviewer, so it is still approved by hand like everything else user-facing."

- [ ] **Step 5: Run the test file and watch it pass**

Run: `pnpm --filter @onlooker/website test marketplace`
Expected: PASS, including `is set nowhere else in the workflow` (exactly one `MARKETPLACE_REQUIRED:` in deploy.yml).

- [ ] **Step 6: Prove the environment test by ablation**

Temporarily change `deploy-website`'s `name: website` under `environment:` to `name: production` with Edit; run `pnpm --filter @onlooker/website test marketplace`.
Expected: FAIL on "uses the website environment, not production". Revert with Edit and re-run to PASS. Record both in the report.

- [ ] **Step 7: Validate the workflow and the dependency build**

Run:
```bash
python3 -c 'import sys,yaml; d=yaml.safe_load(open(".github/workflows/deploy.yml")); j=d["jobs"]; print(sorted(j)); print(j["deploy-website"]["needs"], j["deploy-website"]["environment"])'
pnpm build --filter='@onlooker/website^...'
bash scripts/deployable.test.sh
```
Expected: the job list includes `deploy-website`; it prints `['test', 'changes'] {'name': 'website', 'url': 'https://onlooker.dev'}`; the build exits 0 having built only the website's workspace dependencies (no `@onlooker/website#build` in its output); the filter tests pass. If `python3 -c 'import yaml'` fails, use `ruby -ryaml -e 'p YAML.load_file(".github/workflows/deploy.yml")["jobs"].keys'` instead.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/deploy.yml apps/website/src/__tests__/marketplace.test.ts
git commit -m "<message per Global Constraints>"
```

Suggested subject: `feat(deploy): deploy the website on its own environment :house:`

---

### Task 3: The loader reads at a given ref

**Files:**
- Modify: `apps/website/src/lib/marketplace.ts` (`RAW`, `json`, `fromGitHub`, `fetchMarketplace`)
- Test: `apps/website/src/__tests__/marketplace.test.ts`

**Interfaces:**
- Produces: `export async function fromGitHub(read: typeof fetch, ref?: string): Promise<MarketplacePlugin[]>`, `ref` defaulting to `"main"`. Raw reads go to `https://raw.githubusercontent.com/onlooker-community/ecosystem/<ref>/<path>`; `readmeUrl` is always `https://github.com/onlooker-community/ecosystem/blob/main/<dir>README.md`. Task 4's CLI calls `fromGitHub(fetch, commit)`.

- [ ] **Step 1: Write the failing test**

Change the import at the top of `marketplace.test.ts` to `import { fetchMarketplace, fromGitHub } from "../lib/marketplace";`, and add after the `fetchMarketplace` describe:

```ts
// The ecosystem sync records the commit it read, so it must read at that
// commit: a read of main could land on either side of a release mid-run. The
// README links stay on main, so the fixture it writes is exactly what a build
// of main reads.
describe("fromGitHub", () => {
	const sha = "0123456789abcdef0123456789abcdef01234567";
	const atSha = `https://raw.githubusercontent.com/onlooker-community/ecosystem/${sha}/`;

	it("reads at the ref it is given, and links READMEs on main", async () => {
		const read = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (!url.startsWith(atSha))
				return new Response("wrong ref", { status: 404 });
			const path = url.slice(atSha.length);
			if (path === ".claude-plugin/marketplace.json")
				return Response.json(marketplace);
			if (path in manifests) return Response.json(manifests[path]);
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

		const plugins = await fromGitHub(read, sha);

		expect(plugins.map((p) => p.version)).toEqual(["2.0.0", "0.10.0"]);
		expect(plugins.map((p) => p.readmeUrl)).toEqual([
			"https://github.com/onlooker-community/ecosystem/blob/main/README.md",
			"https://github.com/onlooker-community/ecosystem/blob/main/plugins/archivist/README.md",
		]);
	});

	it("reads main when given no ref", async () => {
		const read = github();
		await fromGitHub(read);
		expect(read).toHaveBeenCalledWith(`${RAW}.claude-plugin/marketplace.json`);
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @onlooker/website test marketplace`
Expected: FAIL — `fromGitHub` is not exported (`fromGitHub is not a function`).

- [ ] **Step 3: Implement**

In `marketplace.ts`:

```ts
const RAW = "https://raw.githubusercontent.com/onlooker-community/ecosystem/";
const BLOB = "https://github.com/onlooker-community/ecosystem/blob/main/";
```

```ts
async function json(
	read: typeof fetch,
	ref: string,
	path: string,
): Promise<unknown> {
	const response = await read(`${RAW}${ref}/${path}`);
	if (!response.ok) throw new Error(`${path} answered ${response.status}`);
	return response.json();
}
```

```ts
/**
 * Every plugin's facts, read at `ref`: `main` for a site build, a commit SHA
 * for the ecosystem sync, which records the commit it read. `readmeUrl` stays
 * on main either way, so the fixture the sync writes equals what a build of
 * main reads.
 */
export async function fromGitHub(
	read: typeof fetch,
	ref = "main",
): Promise<MarketplacePlugin[]> {
```

and pass `ref` through both `json(read, ...)` calls in its body (`json(read, ref, ".claude-plugin/marketplace.json")`, `json(read, ref, path)`). `fetchMarketplace` keeps calling `fromGitHub(read)`.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter @onlooker/website test marketplace`
Expected: PASS, all tests in the file (the existing `fetchMarketplace` tests still use `.../ecosystem/main/`).

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm --filter @onlooker/website typecheck && pnpm --filter @onlooker/website lint`
Expected: exit 0 for both. Fix any formatting report with Edit.

- [ ] **Step 6: Commit**

```bash
git add apps/website/src/lib/marketplace.ts apps/website/src/__tests__/marketplace.test.ts
git commit -m "<message per Global Constraints>"
```

Suggested subject: `feat(website): read the marketplace at a given ref :pushpin:`

---

### Task 4: Compare fixtures, render the PR body, and record the commit

**Files:**
- Create: `apps/website/src/lib/ecosystem-sync.ts`
- Create: `apps/website/src/__tests__/ecosystem-sync.test.ts`
- Create: `apps/website/scripts/ecosystem-sync.ts`
- Modify: `apps/website/src/lib/marketplace.ts` (fixture fallback)
- Modify: `apps/website/src/data/plugins/marketplace.fixture.json` (new shape, regenerated)
- Modify: `apps/website/src/__tests__/marketplace.test.ts` (fixture uses)
- Modify: `apps/website/src/__tests__/plugin-pages.test.ts` (fixture import)

**Interfaces:**
- Consumes: Task 3's `fromGitHub(read, ref)`, and `MarketplacePlugin` from `../lib/marketplace`.
- Produces:
  - `export interface Fixture { commit: string; plugins: MarketplacePlugin[] }`
  - `export function readmePath(plugin: MarketplacePlugin): string`
  - `export function summarize(input: { before: Fixture; after: Fixture; changedFiles: string[] }): { changed: boolean; body: string }`
  - CLI: `pnpm exec tsx apps/website/scripts/ecosystem-sync.ts <commit> <before.json> <changed-files.txt> <fixture-out.json> <body-out.md>` prints `changed` or `unchanged`; writes both output files only when `changed`; exit 2 on bad arguments; non-zero on a failed read. Task 5's shell script calls exactly this.

- [ ] **Step 1: Write the failing tests**

Create `apps/website/src/__tests__/ecosystem-sync.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { type Fixture, readmePath, summarize } from "../lib/ecosystem-sync";
import type { MarketplacePlugin } from "../lib/marketplace";

const BLOB = "https://github.com/onlooker-community/ecosystem/blob/main/";
const A = "a".repeat(40);
const B = "b".repeat(40);

function plugin(
	name: string,
	version = "1.0.0",
	description = `${name} does things.`,
): MarketplacePlugin {
	const dir = name === "ecosystem" ? "" : `plugins/${name}/`;
	return { name, version, description, readmeUrl: `${BLOB}${dir}README.md` };
}

const before: Fixture = {
	commit: A,
	plugins: [plugin("ecosystem"), plugin("archivist", "0.10.0")],
};

function after(plugins: MarketplacePlugin[]): Fixture {
	return { commit: B, plugins };
}

describe("readmePath", () => {
	it("is the README's path in ecosystem", () => {
		expect(readmePath(plugin("ecosystem"))).toBe("README.md");
		expect(readmePath(plugin("archivist"))).toBe("plugins/archivist/README.md");
	});

	it("refuses a README that is not on ecosystem's main", () => {
		expect(() =>
			readmePath({ ...plugin("archivist"), readmeUrl: "https://example.com/x" }),
		).toThrow(/archivist/);
	});
});

describe("summarize", () => {
	it("finds no change when nothing differs", () => {
		const sync = summarize({ before, after: before, changedFiles: [] });
		expect(sync.changed).toBe(false);
	});

	// A new ecosystem commit alone is not a change: recording every one would
	// reopen the PR twice a day for nothing. READMEs that are not a plugin's
	// own, like measurement write-ups, do not count either.
	it("finds no change when only unrelated ecosystem files moved", () => {
		const sync = summarize({
			before,
			after: after(before.plugins),
			changedFiles: [
				"plugins/archivist/src/extract.ts",
				"plugins/librarian/docs/measurements/2026-10-24-hooks-off/README.md",
			],
		});
		expect(sync.changed).toBe(false);
	});

	it("reports a version bump", () => {
		const sync = summarize({
			before,
			after: after([plugin("ecosystem"), plugin("archivist", "0.11.0")]),
			changedFiles: [],
		});
		expect(sync.changed).toBe(true);
		expect(sync.body).toContain("`archivist` 0.10.0 → 0.11.0");
	});

	it("reports a new description", () => {
		const sync = summarize({
			before,
			after: after([
				plugin("ecosystem"),
				plugin("archivist", "0.10.0", "Now says something else."),
			]),
			changedFiles: [],
		});
		expect(sync.changed).toBe(true);
		expect(sync.body).toContain("Now says something else.");
	});

	it("reports an added plugin and the prose file it needs", () => {
		const sync = summarize({
			before,
			after: after([...before.plugins, plugin("newcomer", "0.1.0")]),
			changedFiles: ["plugins/newcomer/README.md"],
		});
		expect(sync.changed).toBe(true);
		expect(sync.body).toContain("`newcomer` 0.1.0");
		expect(sync.body).toContain("apps/website/src/data/plugins/newcomer.ts");
	});

	it("reports a removed plugin", () => {
		const sync = summarize({
			before,
			after: after([plugin("ecosystem")]),
			changedFiles: [],
		});
		expect(sync.changed).toBe(true);
		expect(sync.body).toMatch(/### Removed\n\n- `archivist`/);
	});

	it("reports a changed README even when the facts did not change", () => {
		const sync = summarize({
			before,
			after: after(before.plugins),
			changedFiles: ["README.md", "plugins/archivist/README.md"],
		});
		expect(sync.changed).toBe(true);
		expect(sync.body).toContain("`plugins/archivist/README.md`");
		expect(sync.body).toContain("apps/website/src/data/plugins/archivist.ts");
		expect(sync.body).toContain("apps/website/src/data/plugins/ecosystem.ts");
	});

	it("links the ecosystem range it covers", () => {
		const sync = summarize({
			before,
			after: after([plugin("ecosystem"), plugin("archivist", "0.11.0")]),
			changedFiles: [],
		});
		expect(sync.body).toContain(
			`https://github.com/onlooker-community/ecosystem/compare/${A}...${B}`,
		);
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @onlooker/website test ecosystem-sync`
Expected: FAIL — cannot resolve `../lib/ecosystem-sync`.

- [ ] **Step 3: Implement `apps/website/src/lib/ecosystem-sync.ts`**

```ts
import type { MarketplacePlugin } from "./marketplace";

/**
 * What the ecosystem sync PR says, and whether there is one at all.
 *
 * Pure, so it is tested here; the network read is the site's own loader and
 * the git side is scripts/ecosystem-sync.sh. See ONL-277.
 */

/** The committed fixture: the plugins, and the ecosystem commit they came from. */
export interface Fixture {
	commit: string;
	plugins: MarketplacePlugin[];
}

const BLOB = "https://github.com/onlooker-community/ecosystem/blob/main/";
const REPO = "https://github.com/onlooker-community/ecosystem/";
const PROSE = "apps/website/src/data/plugins/";

/**
 * A plugin's README as a path in ecosystem. Taken from readmeUrl, which the
 * loader builds from the marketplace's `source`, so it is the README that
 * plugin's page was written against and never one of the measurement
 * write-ups that also live under plugins/.
 */
export function readmePath(plugin: MarketplacePlugin): string {
	if (!plugin.readmeUrl.startsWith(BLOB))
		throw new Error(
			`${plugin.name}'s readmeUrl is not on ecosystem's main: ${plugin.readmeUrl}`,
		);
	return plugin.readmeUrl.slice(BLOB.length);
}

const short = (sha: string) => sha.slice(0, 7);
const prose = (name: string) => `\`${PROSE}${name}.ts\``;

export function summarize({
	before,
	after,
	changedFiles,
}: {
	before: Fixture;
	after: Fixture;
	changedFiles: string[];
}): { changed: boolean; body: string } {
	const old = new Map(before.plugins.map((p) => [p.name, p]));
	const now = new Map(after.plugins.map((p) => [p.name, p]));

	const added = after.plugins.filter((p) => !old.has(p.name));
	const removed = before.plugins.filter((p) => !now.has(p.name));

	const updated: string[] = [];
	for (const p of after.plugins) {
		const was = old.get(p.name);
		if (!was) continue;
		const parts: string[] = [];
		if (was.version !== p.version)
			parts.push(`\`${p.name}\` ${was.version} → ${p.version}`);
		if (was.description !== p.description)
			parts.push(
				`${parts.length ? "description" : `\`${p.name}\` description`} now: “${p.description}”`,
			);
		if (parts.length) updated.push(`- ${parts.join("; ")}`);
	}

	const touched = new Set(changedFiles);
	const readmes = after.plugins.filter(
		(p) => old.has(p.name) && touched.has(readmePath(p)),
	);

	// Order and links count too: they change the pages even when no version
	// or description did.
	const pluginsDiffer =
		JSON.stringify(before.plugins) !== JSON.stringify(after.plugins);
	const changed = pluginsDiffer || readmes.length > 0;

	const compare = `${REPO}compare/${before.commit}...${after.commit}`;
	const lines = [
		`Brings onlooker.dev's copy of ecosystem's marketplace from [\`${short(before.commit)}\`](${REPO}commit/${before.commit}) to [\`${short(after.commit)}\`](${REPO}commit/${after.commit}) ([compare](${compare})).`,
		"",
		"Merging this deploys onlooker.dev alone, after the `website` approval. Merging also confirms that the prose files listed under READMEs still match their READMEs.",
	];

	if (updated.length)
		lines.push("", "### Versions and descriptions", "", ...updated);
	if (added.length)
		lines.push(
			"",
			"### Added",
			"",
			...added.map(
				(p) =>
					`- \`${p.name}\` ${p.version}. CI fails until it has a prose file, ${prose(p.name)}, listed in \`${PROSE}index.ts\`.`,
			),
		);
	if (removed.length)
		lines.push(
			"",
			"### Removed",
			"",
			...removed.map(
				(p) =>
					`- \`${p.name}\`. CI fails until ${prose(p.name)} and its entry in \`${PROSE}index.ts\` are deleted.`,
			),
		);
	if (readmes.length)
		lines.push(
			"",
			"### READMEs to re-check",
			"",
			...readmes.map(
				(p) =>
					`- \`${readmePath(p)}\` changed ([compare](${compare})). Check ${prose(p.name)} against it.`,
			),
		);
	if (pluginsDiffer && !updated.length && !added.length && !removed.length)
		lines.push("", "Only the plugins' order or README links changed.");

	lines.push(
		"",
		"---",
		"",
		"Opened by `.github/workflows/ecosystem-sync.yml`, which updates this pull request every hour while ecosystem keeps changing. Commits you add to this branch are kept.",
		"",
	);

	return { changed, body: lines.join("\n") };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter @onlooker/website test ecosystem-sync`
Expected: PASS, 10 tests.

- [ ] **Step 5: Prove the "unrelated README" test by ablation**

With Edit, temporarily replace `touched.has(readmePath(p))` in `ecosystem-sync.ts` with `changedFiles.some((f) => f.endsWith("README.md"))` (any README counts). Run `pnpm --filter @onlooker/website test ecosystem-sync`.
Expected: FAIL on "finds no change when only unrelated ecosystem files moved". Revert with Edit, re-run to PASS, and record both outputs in the report.

- [ ] **Step 6: Change the fixture's shape everywhere it is read**

- `apps/website/src/lib/marketplace.ts`: in `fetchMarketplace`'s catch, `return { source: "fixture", plugins: fixture.plugins };`.
- `apps/website/src/__tests__/plugin-pages.test.ts`: change the import to `import marketplaceFixture from "../data/plugins/marketplace.fixture.json";` and add `const fixture = marketplaceFixture.plugins;` directly below the imports. Nothing else in that file changes.
- `apps/website/src/__tests__/marketplace.test.ts`: `expect(result).toEqual({ source: "fixture", plugins: fixture.plugins });`, and replace the `the fixture` describe with:

```ts
describe("the fixture", () => {
	it("holds ecosystem and at least one plugin, each fully described", () => {
		expect(fixture.plugins.map((p) => p.name)).toContain("ecosystem");
		expect(fixture.plugins.length).toBeGreaterThan(1);
		for (const p of fixture.plugins) {
			expect(p.version).toMatch(/^\d+\.\d+\.\d+/);
			expect(p.description.length).toBeGreaterThan(0);
			expect(p.readmeUrl).toMatch(
				/^https:\/\/github\.com\/onlooker-community\/ecosystem\/blob\/main\//,
			);
		}
	});

	// The sync diffs ecosystem from this commit to find the READMEs whose prose
	// needs re-checking, so it has to be a whole commit SHA.
	it("records the ecosystem commit it was read at", () => {
		expect(fixture.commit).toMatch(/^[0-9a-f]{40}$/);
	});
});
```

- [ ] **Step 7: Write the CLI `apps/website/scripts/ecosystem-sync.ts`**

```ts
/**
 * Regenerates the marketplace fixture and the ecosystem sync PR's body.
 *
 * Usage:
 *   tsx apps/website/scripts/ecosystem-sync.ts <commit> <before.json> \
 *     <changed-files.txt> <fixture-out.json> <body-out.md>
 *
 * Prints `changed` or `unchanged`, and writes the two output files only when
 * changed. Run by scripts/ecosystem-sync.sh, which owns the git and GitHub
 * side; this owns only the data. The read is the site's own loader at a
 * pinned commit, so the fixture is exactly what a build would read, and the
 * decision is summarize(), tested in src/__tests__/ecosystem-sync.test.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { type Fixture, summarize } from "../src/lib/ecosystem-sync";
import { fromGitHub } from "../src/lib/marketplace";

async function main(): Promise<void> {
	const [commit, beforePath, changedPath, fixtureOut, bodyOut] =
		process.argv.slice(2);
	if (
		!commit ||
		!beforePath ||
		!changedPath ||
		!fixtureOut ||
		!bodyOut ||
		!/^[0-9a-f]{40}$/.test(commit)
	) {
		console.error(
			"usage: ecosystem-sync.ts <commit> <before.json> <changed-files.txt> <fixture-out.json> <body-out.md>",
		);
		process.exit(2);
	}

	const before = JSON.parse(readFileSync(beforePath, "utf8")) as Fixture;
	const changedFiles = readFileSync(changedPath, "utf8")
		.split("\n")
		.filter(Boolean);
	const after: Fixture = { commit, plugins: await fromGitHub(fetch, commit) };

	const sync = summarize({ before, after, changedFiles });
	if (sync.changed) {
		writeFileSync(fixtureOut, `${JSON.stringify(after, null, "\t")}\n`);
		writeFileSync(bodyOut, sync.body);
	}
	console.log(sync.changed ? "changed" : "unchanged");
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
```

- [ ] **Step 8: Regenerate the fixture at ecosystem's current main**

Use the scratchpad directory you were given (call it `$SCRATCH`). Run:

```bash
HEAD_SHA="$(git ls-remote https://github.com/onlooker-community/ecosystem.git refs/heads/main | cut -f1)"
git show HEAD:apps/website/src/data/plugins/marketplace.fixture.json > "$SCRATCH/old-plugins.json"
jq --arg c "$HEAD_SHA" '{commit: $c, plugins: .}' "$SCRATCH/old-plugins.json" > "$SCRATCH/before.json"
: > "$SCRATCH/changed.txt"
pnpm exec tsx apps/website/scripts/ecosystem-sync.ts "$HEAD_SHA" "$SCRATCH/before.json" "$SCRATCH/changed.txt" "$SCRATCH/fixture.json" "$SCRATCH/body.md"
```

Expected: prints `changed` (the committed fixture's archivist version is behind ecosystem's main). Then Read `$SCRATCH/fixture.json` and Write its exact contents to `apps/website/src/data/plugins/marketplace.fixture.json` with the Write tool. If it printed `unchanged`, instead Write `{ "commit": "<HEAD_SHA>", "plugins": <the old array> }` in the same tab-indented layout `JSON.stringify(x, null, "\t")` produces. Record `HEAD_SHA` and `$SCRATCH/body.md`'s contents in the report.

- [ ] **Step 9: The bot's output must pass lint as written**

Run: `pnpm --filter @onlooker/website lint`
Expected: exit 0, no error on `marketplace.fixture.json`. The sync workflow commits the CLI's output byte for byte, so if Biome reports a formatting difference on the fixture, the fix is in the CLI's serializer, not the file: change how Step 7 serializes, re-run Step 8, and Write the new output. Report what changed. Fix any other lint report with Edit.

- [ ] **Step 10: Run the website suite, typecheck**

Run: `pnpm --filter @onlooker/website test && pnpm --filter @onlooker/website typecheck`
Expected: all tests pass (including `plugin-pages.test.ts`'s prose checks against the regenerated fixture — if a plugin now lacks prose or prose lacks a plugin, report it as BLOCKED with the names rather than adding or deleting prose), typecheck exit 0.

- [ ] **Step 11: Commit**

```bash
git add apps/website/src/lib/ecosystem-sync.ts apps/website/src/__tests__/ecosystem-sync.test.ts apps/website/scripts/ecosystem-sync.ts apps/website/src/lib/marketplace.ts apps/website/src/data/plugins/marketplace.fixture.json apps/website/src/__tests__/marketplace.test.ts apps/website/src/__tests__/plugin-pages.test.ts
git commit -m "<message per Global Constraints>"
```

Suggested subject: `feat(website): record the ecosystem commit the fixture came from :bookmark:`

---

### Task 5: The sync workflow keeps one PR up to date

**Files:**
- Create: `scripts/ecosystem-sync.sh`
- Create: `.github/workflows/ecosystem-sync.yml`
- Modify: `docs/runbooks/2026-09-05-cli-release-tap-app.md` (the summary table, step 1's permissions, step 2's repository table)

**Interfaces:**
- Consumes: Task 4's CLI exactly as specified there; the fixture's `commit` field.
- Produces: nothing other tasks use.

- [ ] **Step 1: Write `scripts/ecosystem-sync.sh`**

Create it with the Write tool, then `chmod +x scripts/ecosystem-sync.sh` (mode change only):

```bash
#!/usr/bin/env bash
# Keep one pull request in step with ecosystem's marketplace (ONL-277).
#
# Usage: scripts/ecosystem-sync.sh <ecosystem-clone>
#
# Run by .github/workflows/ecosystem-sync.yml from the root of an onlooker
# checkout whose origin pushes as the release App, with git's user already set.
# The ecosystem clone needs full history: the README list is a diff between
# the commit the fixture records and ecosystem's main now.
#
# This is the git and GitHub side only. Reading the marketplace, deciding
# whether anything changed and writing the PR body happen in
# apps/website/scripts/ecosystem-sync.ts, whose logic is tested in
# apps/website/src/__tests__/ecosystem-sync.test.ts.
set -euo pipefail

readonly ECOSYSTEM="${1:?usage: ecosystem-sync.sh <ecosystem-clone>}"
readonly FIXTURE="apps/website/src/data/plugins/marketplace.fixture.json"
readonly BRANCH="bot/ecosystem-sync"
readonly TITLE="chore(website): sync the ecosystem marketplace"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

head="$(git -C "${ECOSYSTEM}" rev-parse HEAD)"

git fetch --quiet origin main
git show "origin/main:${FIXTURE}" >"${work}/before.json"
base="$(jq -r '.commit' "${work}/before.json")"

# Without the recorded commit the README list cannot be computed, and a sync
# that quietly listed no READMEs would read as "nothing to re-check". So this
# stops instead: a force-push in ecosystem, or a hand-edited fixture.
if ! git -C "${ECOSYSTEM}" cat-file -e "${base}^{commit}" 2>/dev/null; then
	echo "::error title=Recorded ecosystem commit not found::${FIXTURE} records ${base}, which ecosystem's history does not contain."
	exit 1
fi

# core.quotePath=false for scripts/deployable.sh's reason: a quoted path would
# never equal the README path it is compared with.
git -C "${ECOSYSTEM}" -c core.quotePath=false \
	diff --name-only "${base}" "${head}" >"${work}/changed.txt"

result="$(pnpm exec tsx apps/website/scripts/ecosystem-sync.ts \
	"${head}" "${work}/before.json" "${work}/changed.txt" \
	"${work}/fixture.json" "${work}/body.md")"

if [[ "${result}" == "unchanged" ]]; then
	echo "ecosystem-sync: nothing to sync between ${base} and ${head}"
	exit 0
fi

# Never force-push. A prose file somebody committed on the branch has to
# survive the next run, so the branch is extended, not rebuilt. Merging main
# keeps it current; a conflict stops the run, because a bot resolving one would
# be choosing whose change to keep.
if git ls-remote --exit-code --heads origin "${BRANCH}" >/dev/null; then
	git fetch --quiet origin "${BRANCH}"
	git checkout --quiet -B "${BRANCH}" "origin/${BRANCH}"
	if ! git merge --quiet --no-edit origin/main; then
		conflicts="$(git diff --name-only --diff-filter=U | paste -sd ' ' -)"
		git merge --abort
		echo "::error title=Sync branch conflicts with main::${conflicts}"
		exit 1
	fi
else
	git checkout --quiet -B "${BRANCH}" origin/main
fi

cp "${work}/fixture.json" "${FIXTURE}"
git add "${FIXTURE}"
if ! git diff --cached --quiet; then
	git commit --quiet -m "chore(website): sync the marketplace to ecosystem ${head:0:7}"
fi
git push --quiet origin "${BRANCH}"

number="$(gh pr list --head "${BRANCH}" --state open --json number --jq '.[0].number // empty')"
if [[ -n "${number}" ]]; then
	gh pr edit "${number}" --body-file "${work}/body.md"
else
	gh pr create --base main --head "${BRANCH}" \
		--title "${TITLE}" --body-file "${work}/body.md"
fi
```

(The `cp` writes the fixture inside the CI runner's checkout, which is the bot's job; it is not an agent edit of a tracked file.)

- [ ] **Step 2: Check it offline**

Run:
```bash
bash -n scripts/ecosystem-sync.sh
bash scripts/ecosystem-sync.sh; echo "exit=$?"
```
Expected: the syntax check exits 0; the second prints the `usage: ecosystem-sync.sh <ecosystem-clone>` error and `exit=1`, having touched nothing (confirm `git status --short` shows only your new files).

- [ ] **Step 3: Write `.github/workflows/ecosystem-sync.yml`**

```yaml
# Keeps one pull request in step with ecosystem's marketplace, so a plugin
# release reaches onlooker.dev the next time somebody merges that PR, not the
# next time something unrelated happens to deploy. See ONL-277 and
# docs/superpowers/specs/2026-11-08-ecosystem-sync-design.md.
#
# It deploys nothing. Merging its PR deploys the website alone, through
# deploy.yml's normal push path and behind the `website` approval.
name: Ecosystem sync

on:
  # Hourly, and GitHub will not keep to it: heartbeat.yml measured a median of
  # 203 minutes between runs. That is fine here, because the PR waits for a
  # person anyway, and a faster trigger would not change when anything ships.
  # Off the hour, where GitHub's scheduler is busiest.
  schedule:
    - cron: '17 * * * *'
  workflow_dispatch:

# One at a time. Two runs would race to push the same branch; the loser's push
# would fail rather than lose anything, but there is no reason to let it.
concurrency:
  group: ecosystem-sync
  cancel-in-progress: false

permissions:
  contents: read

env:
  NODE_VERSION: '24'
  PNPM_VERSION: '11.0.9'

jobs:
  sync:
    name: Sync the ecosystem marketplace
    runs-on: ubuntu-latest
    steps:
      # Not GITHUB_TOKEN. A pull request it opens, or a push it makes, starts no
      # workflows, so the sync PR would never report "All checks passed" and
      # could never merge. The App needs Contents and Pull requests read and
      # write on this repository; see
      # docs/runbooks/2026-09-05-cli-release-tap-app.md.
      - name: Mint a token for this repository
        id: app
        uses: actions/create-github-app-token@v3
        with:
          app-id: ${{ secrets.TAP_APP_ID }}
          private-key: ${{ secrets.TAP_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
          # Named outright, not github.event.repository.name: a scheduled
          # run's event payload carries no repository object.
          repositories: onlooker

      - uses: actions/checkout@v5
        with:
          path: onlooker
          token: ${{ steps.app.outputs.token }}
          fetch-depth: 0

      # Full history, because the README list is a diff between the commit
      # the fixture records and ecosystem's main now. Public, so no token.
      - uses: actions/checkout@v5
        with:
          repository: onlooker-community/ecosystem
          ref: main
          path: ecosystem
          fetch-depth: 0
          persist-credentials: false

      - name: Setup Node.js
        uses: actions/setup-node@v5
        with:
          node-version: ${{ env.NODE_VERSION }}
          # See deploy.yml: pnpm is installed after this step, so auto-caching
          # would invoke a pnpm that does not exist yet.
          package-manager-cache: false

      - name: Install pnpm
        run: npm install -g pnpm@${{ env.PNPM_VERSION }}

      - name: Install dependencies
        working-directory: onlooker
        run: pnpm install --frozen-lockfile

      # The App's bot account, so the history says a bot made the commit, as
      # release-cli.yml does for the tap.
      - name: Commit as the App
        working-directory: onlooker
        env:
          GH_TOKEN: ${{ steps.app.outputs.token }}
          APP_SLUG: ${{ steps.app.outputs.app-slug }}
        run: |
          BOT_ID="$(gh api "/users/${APP_SLUG}%5Bbot%5D" --jq .id)"
          git config user.name "${APP_SLUG}[bot]"
          git config user.email "${BOT_ID}+${APP_SLUG}[bot]@users.noreply.github.com"

      - name: Sync
        working-directory: onlooker
        env:
          GH_TOKEN: ${{ steps.app.outputs.token }}
        run: ./scripts/ecosystem-sync.sh ../ecosystem
```

- [ ] **Step 4: Validate the workflow**

Run: `python3 -c 'import yaml; d=yaml.safe_load(open(".github/workflows/ecosystem-sync.yml")); print(list(d[True]), [s.get("name", s.get("uses")) for s in d["jobs"]["sync"]["steps"]])'`
Expected: `['schedule', 'workflow_dispatch']` (YAML reads `on` as `True`) and the seven steps in order. If `python3 -c 'import yaml'` fails, use the `ruby -ryaml` form from Task 2.

- [ ] **Step 5: Record the App's third job in the runbook**

In `docs/runbooks/2026-09-05-cli-release-tap-app.md`, with Edit:
- In the summary table, add a row after `Generator`: `| Ecosystem sync | `.github/workflows/ecosystem-sync.yml` — hourly; opens and updates the `bot/ecosystem-sync` pull request |`.
- In step 1, after the Contents bullet, add a bullet: `- **Pull requests → Read and write**, for the ecosystem sync (ONL-277). A pull request opened with GITHUB_TOKEN starts no workflows, so it could never report the "All checks passed" check the ruleset requires. Added 2026-11-08; an existing installation has to accept the new permission before the sync can open its PR.`
- Change the step 1 sentence "That is the only one." to "It is one of two; see the next bullet."
- In step 2's table, add a row: `| `onlooker` | `ecosystem-sync.yml` | pushing `bot/ecosystem-sync` and opening its pull request |`. The App's bypass on Require Pull Request is never exercised by this job, which pushes only to that branch; say so in one sentence under the table.

- [ ] **Step 6: Run the repo-wide gates**

Run: `pnpm lint && pnpm typecheck && bash scripts/deployable.test.sh`
Expected: exit 0 each. Fix any report with Edit.

- [ ] **Step 7: Commit**

```bash
git add scripts/ecosystem-sync.sh .github/workflows/ecosystem-sync.yml docs/runbooks/2026-09-05-cli-release-tap-app.md
git commit -m "<message per Global Constraints>"
```

Suggested subject: `feat(website): keep a pull request in step with ecosystem :satellite:`

---

## After merge (controller and owner, not an implementer task)

1. The owner adds **Pull requests: read and write** to the `onlooker-cli-release` App and accepts it on the org installation.
2. Run `gh workflow run ecosystem-sync.yml` and watch it. Expected: either `nothing to sync` (if ecosystem has not changed since Task 4's commit) or a `bot/ecosystem-sync` PR whose CI runs and whose body lists the changes.
3. The first push that touches only the website deploys through `deploy-website`, waiting on the `website` approval, while `deploy-staging` and `deploy-production` skip.
4. Record the CLI rows of ONL-277 (`streams.ts`, `enablement.ts`) in a document on the Linear project, not as a new issue.
