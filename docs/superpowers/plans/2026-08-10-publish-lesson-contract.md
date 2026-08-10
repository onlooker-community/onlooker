# Publish the Lesson Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `packages/lesson-contract` to npm as
`@onlooker-community/lesson-contract`, guarded so it cannot silently go stale.

**Architecture:** Four independent pieces. The package becomes publishable; two
CI guards make staleness impossible to miss; a publish job ships it on merge.
The guards are the point — the publish job is the easy half, and a contract that
publishes but drifts is exactly the failure this replaces.

**Tech Stack:** pnpm 11.0.9, Node 24, GitHub Actions, npm registry, `jq`
(preinstalled on `ubuntu-latest`).

**Spec:** `docs/superpowers/specs/2026-08-10-publish-lesson-contract-design.md`.

## Global Constraints

- **Published name is `@onlooker-community/lesson-contract`.** The `@onlooker/*`
  scope is private workspace naming and is not ours on the registry. Verified
  `404` on 2026-08-10, so the name is free.
- **First published version is `2.0.0`**, because the package major tracks
  `schema_version`, which `lesson.schema.json` declares as
  `{"type": "number", "const": 2}`.
- **`dist/` is gitignored; `schema/` is committed.** Any step that packs or
  publishes must build first. Any step that reads `schema/*.json` need not.
- **Schema emission is byte-deterministic** — verified by rebuilding and
  comparing checksums. Guard 1 depends on this and would false-positive without
  it.
- **Every guard must be observed failing before it is trusted.** Break the thing
  it protects, watch it fail, restore. A guard nobody has seen fail is
  indistinguishable from one that cannot.
- **CI env values, copied from `.github/workflows/deploy.yml`:**
  `NODE_VERSION: '24'`, `PNPM_VERSION: '11.0.9'`.
- **All commits route through the `/commit` skill**, per the repository's
  CLAUDE.md.
- American English throughout.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/lesson-contract/package.json` | identity, what ships, publish config | 1 |
| `.github/workflows/deploy.yml` (new job) | Guard 1 — committed schema is current | 2 |
| `.github/workflows/deploy.yml` (new job) | Guard 2 — schema change carries a version bump | 3 |
| `.github/workflows/deploy.yml` (new job) | publish on version change | 4 |

Three tasks touch one workflow file. They are split anyway because each has its
own deliberate-break verification and a reviewer could accept one while
rejecting another — Guard 2's base-ref handling is fiddly in a way Guard 1's is
not, and the publish job carries a credential neither guard does.

---

## Task 1: Make the package publishable

**Files:**
- Modify: `packages/lesson-contract/package.json`

**Interfaces:**
- Produces: the workspace filter name changes from `@onlooker/lesson-contract`
  to `@onlooker-community/lesson-contract`. **Tasks 2 and 4 use the new name in
  `pnpm --filter`.** Nothing else in the repo references the old name — verified,
  it appears only in this file — so no import sites need updating.
- Produces: the subpath `@onlooker-community/lesson-contract/schema/lesson.schema.json`,
  which is what the ecosystem's drift check will import.

- [ ] **Step 1: Confirm the name is still free**

```bash
npm view @onlooker-community/lesson-contract version
```

Expected: `E404 Not Found`. If it resolves to a version, **stop and report** —
someone else published under that name and the plan's identity assumption is
broken.

- [ ] **Step 2: Rewrite package.json**

Replace `packages/lesson-contract/package.json` with:

```json
{
	"name": "@onlooker-community/lesson-contract",
	"version": "2.0.0",
	"description": "Shared lesson contract for the Onlooker ecosystem",
	"type": "module",
	"main": "dist/index.js",
	"types": "dist/index.d.ts",
	"repository": {
		"type": "git",
		"url": "https://github.com/onlooker-community/onlooker",
		"directory": "packages/lesson-contract"
	},
	"publishConfig": {
		"access": "public"
	},
	"exports": {
		".": {
			"import": "./dist/index.js",
			"types": "./dist/index.d.ts"
		},
		"./schema/*": "./schema/*"
	},
	"files": ["dist", "schema"],
	"scripts": {
		"build": "tsc --project tsconfig.build.json && node scripts/emit-json-schema.mjs",
		"dev": "tsc --watch",
		"lint": "biome check src",
		"lint:fix": "biome check --write src",
		"typecheck": "tsc --noEmit",
		"test": "vitest run"
	},
	"dependencies": {
		"zod": "4.4.3"
	},
	"devDependencies": {
		"@onlooker/config-biome": "workspace:*",
		"@onlooker/config-typescript": "workspace:*",
		"typescript": "^5.6.3",
		"vitest": "^4.1.9"
	}
}
```

Three changes from the current file: `private: true` is gone, the name and
version changed, and `exports` / `files` / `publishConfig` / `repository` are
added. Scripts and dependencies are unchanged — do not touch them.

`publishConfig.access` is set explicitly rather than relying on the `access:
public` line in `pnpm-workspace.yaml`, so the intent travels with the package.

- [ ] **Step 3: Reinstall so the workspace picks up the rename**

```bash
pnpm install
```

Expected: succeeds. The lockfile will record the new package name.

- [ ] **Step 4: Build, then inspect exactly what would ship**

```bash
pnpm --filter @onlooker-community/lesson-contract build
cd packages/lesson-contract && npm pack --dry-run
```

Expected file list contains:

- `dist/index.js`, `dist/index.d.ts` (and other emitted `dist/` files)
- `schema/lesson.schema.json`
- `schema/counter-observation.schema.json`
- `package.json`

Expected file list does **not** contain `src/`, `scripts/`, `tsconfig*.json`, or
`node_modules`.

This list is the actual contract with consumers. Read it rather than assuming
`files` did what you meant.

- [ ] **Step 5: Verify the subpath a consumer would import resolves**

```bash
cd packages/lesson-contract
node --input-type=module -e "
import s from './schema/lesson.schema.json' with { type: 'json' };
if (s.properties.schema_version.const !== 2) {
  console.error('expected schema_version const 2, got', s.properties.schema_version.const);
  process.exit(1);
}
console.log('schema_version const 2 - ok');
"
```

Expected: `schema_version const 2 - ok`.

This is the exact shape the ecosystem's check will rely on. If the `const`
is not 2, the version chosen in Step 2 is wrong and the plan needs revisiting
rather than the assertion being changed.

- [ ] **Step 6: Confirm the repo still builds and tests green**

```bash
pnpm build && pnpm test && pnpm lint
```

Expected: all tasks successful. The rename touches a workspace name, so a
failure here most likely means something referenced the old name that the
earlier survey missed — report it rather than patching around it.

- [ ] **Step 7: Commit**

Use the `/commit` skill with `packages/lesson-contract/package.json` and
`pnpm-lock.yaml`.

Suggested subject: `feat(lesson-contract): make the contract publishable :package:`

The body should say why the scope changed — `@onlooker/*` is private workspace
naming, `@onlooker-community` is the org's registry scope — and why the version
starts at `2.0.0` rather than continuing from `0.0.1`.

---

## Task 2: Guard 1 — the committed schema is current

**Files:**
- Modify: `.github/workflows/deploy.yml` (the `quality` job)

**Interfaces:**
- Consumes: `pnpm --filter @onlooker-community/lesson-contract build` from Task 1.

The failure this catches: someone edits `src/*.ts`, does not rebuild, and
`schema/*.json` silently stops describing the contract. Everything downstream
then consumes a stale artifact that looks authoritative.

- [ ] **Step 1: Add the guard as its own job**

In `.github/workflows/deploy.yml`, add this job immediately after the `quality`
job:

```yaml
  # ============================================================================
  # LESSON CONTRACT SCHEMA FRESHNESS
  # ============================================================================
  contract-schema:
    name: Contract schema is current
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}

      - name: Install pnpm
        run: npm install -g pnpm@${{ env.PNPM_VERSION }}

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      # The committed schema artifacts are generated from the zod source. If
      # someone edits src/ without rebuilding, schema/*.json silently stops
      # describing the contract while still looking authoritative. Emission is
      # byte-deterministic, so rebuilding and finding a diff means exactly one
      # thing: the committed artifacts are stale.
      - name: Rebuild and assert the committed schema matches
        run: |
          pnpm --filter @onlooker-community/lesson-contract build
          if ! git diff --exit-code -- packages/lesson-contract/schema/; then
            echo "::error title=Stale lesson contract schema::packages/lesson-contract/schema/ does not match the zod source. Run 'pnpm --filter @onlooker-community/lesson-contract build' and commit the result."
            exit 1
          fi
```

**It is a standalone job, not a step inside `quality`.** `quality` is a matrix
over `@onlooker/api` and `@onlooker/web`, so a step added there would run twice
per PR and annotate twice on failure. A standalone job also runs in parallel
rather than behind the matrix, and matches the shape Task 3 uses.

The job has no `if:` guard, so it runs on both `push` and `pull_request` — this
must gate PRs.

- [ ] **Step 2: Verify the guard FAILS when it should — locally first**

Deliberately stale the artifact, then run the guard's logic:

```bash
cd /path/to/repo
python3 - <<'PY'
import json, pathlib
p = pathlib.Path("packages/lesson-contract/schema/lesson.schema.json")
d = json.loads(p.read_text())
d["properties"]["claim"]["description"] = "TAMPERED - should be reverted"
p.write_text(json.dumps(d, indent=2) + "\n")
PY

pnpm --filter @onlooker-community/lesson-contract build
git diff --exit-code -- packages/lesson-contract/schema/ ; echo "exit=$?"
```

Expected: a diff is printed and `exit=1`.

`properties.claim` has no `description` key in the real schema, so the script
adds one and the rebuild removes it again. The diff you see is that key being
stripped — which is the guard correctly reporting that the committed artifact
did not match what the source generates.

- [ ] **Step 3: Restore**

```bash
git checkout -- packages/lesson-contract/schema/
git diff --exit-code -- packages/lesson-contract/schema/ ; echo "exit=$?"
```

Expected: no output, `exit=0`.

- [ ] **Step 4: Verify the guard PASSES on a clean tree**

```bash
pnpm --filter @onlooker-community/lesson-contract build
git diff --exit-code -- packages/lesson-contract/schema/ ; echo "exit=$?"
```

Expected: `exit=0`. This is the determinism the guard depends on — if this
fails on an untouched tree, emission is not deterministic and **the guard must
not ship**; stop and report.

- [ ] **Step 5: Commit**

Use the `/commit` skill with `.github/workflows/deploy.yml`.

Suggested subject: `ci(lesson-contract): catch schema artifacts that went stale :mag:`

The body should record that emission is byte-deterministic and that this is what
makes a rebuild-and-diff guard valid rather than flaky.

---

## Task 3: Guard 2 — a schema change carries a version bump

**Files:**
- Modify: `.github/workflows/deploy.yml` (new job)

**Interfaces:**
- Consumes: `packages/lesson-contract/package.json` with a `version` field from
  Task 1.

The failure this catches: the schema changes, the version does not, so Task 4's
publish job finds nothing new and skips. Consumers keep resolving the old
contract while our source has moved — this bead's own failure mode, relocated to
our side of the line.

- [ ] **Step 1: Add the job**

In `.github/workflows/deploy.yml`, add this job after the `quality` job:

```yaml
  # ============================================================================
  # LESSON CONTRACT VERSION GUARD
  # ============================================================================
  contract-version:
    name: Contract version bumped with schema
    runs-on: ubuntu-latest
    # Pull requests only: the comparison is against the PR's base, which a push
    # to main does not have.
    if: github.event_name == 'pull_request'
    steps:
      # Full history so the base ref is available to diff against.
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Fail if the schema changed without a version bump
        env:
          BASE: origin/${{ github.base_ref }}
        run: |
          set -euo pipefail

          if git diff --quiet "${BASE}...HEAD" -- packages/lesson-contract/schema/; then
            echo "lesson contract schema unchanged - nothing to check"
            exit 0
          fi

          echo "lesson contract schema changed; checking for a version bump"

          old="$(git show "${BASE}:packages/lesson-contract/package.json" | jq -r .version)"
          new="$(jq -r .version packages/lesson-contract/package.json)"

          if [ "${old}" = "${new}" ]; then
            echo "::error title=Schema changed without a version bump::packages/lesson-contract/schema/ changed but the version is still ${new}. Nothing would publish, so consumers would keep resolving the old contract. Bump the version - a schema_version change is a major bump."
            exit 1
          fi

          echo "version moved ${old} -> ${new}"
```

`jq` is preinstalled on `ubuntu-latest`; no setup step is needed.

The three-dot `${BASE}...HEAD` compares against the merge base, so commits that
landed on `main` after this branch started do not count as changes made here.

- [ ] **Step 2: Verify the guard FAILS when it should**

Reproduce the job's logic locally against the real base:

```bash
git fetch origin main
python3 - <<'PY'
import json, pathlib
p = pathlib.Path("packages/lesson-contract/schema/lesson.schema.json")
d = json.loads(p.read_text())
d["properties"]["claim"]["description"] = "TAMPERED - should be reverted"
p.write_text(json.dumps(d, indent=2) + "\n")
PY
git add packages/lesson-contract/schema/lesson.schema.json
git commit -m "temp: tamper for guard verification"

BASE=origin/main
git diff --quiet "${BASE}...HEAD" -- packages/lesson-contract/schema/ && echo "no change seen" || echo "change detected (correct)"
old="$(git show "${BASE}:packages/lesson-contract/package.json" | jq -r .version)"
new="$(jq -r .version packages/lesson-contract/package.json)"
echo "old=${old} new=${new}"
```

Expected: `change detected (correct)`, and `old` equals `new` — which is the
condition that makes the job exit 1.

Note `old` will be `0.0.1` here because Task 1's rename is not yet on `main`.
That is fine; the guard compares equality, not ordering.

- [ ] **Step 3: Undo the tampering commit**

```bash
git reset --hard HEAD~1
git status --short
```

Expected: clean tree, and the tamper commit is gone. Confirm with
`git log --oneline -1` that HEAD is back to your real work.

- [ ] **Step 4: Verify the guard PASSES when the schema is untouched**

```bash
BASE=origin/main
git diff --quiet "${BASE}...HEAD" -- packages/lesson-contract/schema/ && echo "unchanged - guard exits 0 (correct)"
```

Expected: `unchanged - guard exits 0 (correct)`.

- [ ] **Step 5: Commit**

Use the `/commit` skill with `.github/workflows/deploy.yml`.

Suggested subject: `ci(lesson-contract): require a version bump with schema changes :lock:`

The body should explain that a schema change without a bump publishes nothing,
which leaves consumers on a stale contract — the same silent staleness this work
exists to remove, moved one step upstream.

---

## Task 4: Publish on version change

**Files:**
- Modify: `.github/workflows/deploy.yml` (new job)

**Interfaces:**
- Consumes: the publishable package from Task 1, including
  `publishConfig.access` and `files`.

- [ ] **Step 1: Add the publish job**

In `.github/workflows/deploy.yml`, add this job after `contract-version`:

```yaml
  # ============================================================================
  # PUBLISH THE LESSON CONTRACT
  # ============================================================================
  publish-contract:
    name: Publish lesson contract
    runs-on: ubuntu-latest
    needs: test
    # Merges to main only. Never publish from a pull request.
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          # Required for NODE_AUTH_TOKEN to reach the registry.
          registry-url: 'https://registry.npmjs.org'

      - name: Install pnpm
        run: npm install -g pnpm@${{ env.PNPM_VERSION }}

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      # dist/ is gitignored, so the tarball has nothing to ship without this.
      - name: Build
        run: pnpm --filter @onlooker-community/lesson-contract build

      - name: Publish if this exact version is not on the registry
        working-directory: packages/lesson-contract
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: |
          set -euo pipefail

          name="$(jq -r .name package.json)"
          version="$(jq -r .version package.json)"

          # Queries the exact version rather than "latest". An unpublished
          # version and an unpublished package both yield empty output, so the
          # very first publish - where no latest exists to compare against -
          # takes the same path as every later one.
          published="$(npm view "${name}@${version}" version 2>/dev/null || true)"

          if [ -n "${published}" ]; then
            echo "${name}@${version} is already published; nothing to do"
            exit 0
          fi

          echo "publishing ${name}@${version}"
          npm publish
```

- [ ] **Step 2: Confirm the skip path is correct without publishing**

```bash
cd packages/lesson-contract
name="$(jq -r .name package.json)"
version="$(jq -r .version package.json)"
published="$(npm view "${name}@${version}" version 2>/dev/null || true)"
echo "name=${name} version=${version} published='${published}'"
```

Expected: `published=''` — empty, because the package does not exist yet. That
is the branch that publishes.

Then check the opposite branch resolves for a package that does exist:

```bash
npm view "@onlooker-community/schema@2.11.0" version
```

Expected: `2.11.0`. This confirms `npm view name@version` returns a value when
the version exists, which is what makes the skip path work.

- [ ] **Step 3: Report the credential requirement**

`NPM_TOKEN` does not exist in this repository — it has never published anything.
The job cannot succeed until it is added as a repository secret, scoped to
publish only.

**Stop and tell your human partner this is needed.** Do not attempt to create
it, and do not remove the job to make CI green.

- [ ] **Step 4: Commit**

Use the `/commit` skill with `.github/workflows/deploy.yml`.

Suggested subject: `ci(lesson-contract): publish when the version changes :rocket:`

The body should explain why the check queries `name@version` rather than
comparing against `latest` — an unpublished version and an unpublished package
both return empty, so the first publish needs no special case — and note that
this is the repository's first publish credential.

---

## Post-merge verification

**These steps cannot run before merge.** The publish job triggers on `push` to
`main`, and GitHub runs the version of a push-triggered job that exists on the
default branch. This is the same constraint the heartbeat hit: a workflow's
push path is not exercisable from a branch.

Record this as outstanding when the branch is finished rather than reporting the
work complete.

- [ ] **Step 1: Confirm the package published**

```bash
npm view @onlooker-community/lesson-contract version
```

Expected: `2.0.0`.

- [ ] **Step 2: Confirm a consumer can install and import it**

In a scratch directory outside the repo:

```bash
mkdir -p /tmp/contract-check && cd /tmp/contract-check
npm init -y >/dev/null
npm install @onlooker-community/lesson-contract@2.0.0
node --input-type=module -e "
import s from '@onlooker-community/lesson-contract/schema/lesson.schema.json' with { type: 'json' };
console.log('schema_version const:', s.properties.schema_version.const);
console.log('has evidence:', 'evidence' in s.properties);
console.log('has applies_to:', 'applies_to' in s.properties);
"
```

Expected: `const: 2`, and both `true`. Those two properties are the subtrees the
ecosystem vendored, so this proves the artifact they need is reachable at the
path they will import.

**A successful publish is not sufficient evidence.** A tarball missing `schema/`
would publish just as cleanly. Install it and read it.

- [ ] **Step 3: Confirm the guards ran on the merge**

Check that the `quality` job's schema step and the `contract-version` job both
appear in the PR's checks, green. A guard that was never invoked is not a guard.

---

## Definition of Done

- `npm view @onlooker-community/lesson-contract version` returns `2.0.0`
- A fresh install in a scratch directory can import
  `@onlooker-community/lesson-contract/schema/lesson.schema.json` and read
  `schema_version.const === 2`
- Guard 1 has been **observed failing** on a deliberately staled artifact and
  passing on a clean tree
- Guard 2 has been **observed failing** on a schema change without a version
  bump and passing when the schema is untouched
- `npm pack --dry-run` output was read, and contains `dist/` and `schema/` and
  nothing else

## Not in this plan

**Anything in the ecosystem repo.** Adding the dependency and upgrading
`check-lesson-schema-drift.mjs` from a provenance-pin check to a real comparison
is their work. This makes it possible; it does not do it.

**Their jq rules.** `librarian-lesson-validate.sh` mirrors the vendored JSON by
hand. Publishing does nothing about that third representation.

**Changelog automation.** If publishing becomes frequent enough to want one,
release-please is the org's existing pattern and layers on without undoing any
of this.

**Consumers of `counter-observation.schema.json`.** It ships because it is
generated alongside; nothing consumes it yet.
