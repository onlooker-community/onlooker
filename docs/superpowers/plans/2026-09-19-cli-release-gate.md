# CLI Release Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fail a pull request that changes the code inside the CLI binary without bumping `apps/cli/package.json`'s version, unless it carries a `cli-batch` label saying the release is deliberately deferred.

**Architecture:** One bash script, `scripts/cli-version.sh`, built as three pure subcommands plus a gatherer that composes them — the structure `scripts/deployable.sh` already uses so its tests can drive real code offline without stubbing `gh`. One new pull-request-only job in `.github/workflows/deploy.yml` runs the gatherer and is added to the `required` aggregate, which is the single status context the org ruleset enforces.

**Tech Stack:** bash (`set -euo pipefail`), `jq`, `git`, `gh` CLI, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-19-cli-release-gate-design.md`

**Bead:** `onlooker-mcwn`

## Global Constraints

- **Edit tracked files with `Edit`/`Write`, never `sed -i` or heredocs.** The `lineage` and `inspector` plugins hook `PostToolUse` on tool edits; a shell edit moves the same bytes invisibly and `/lineage` then answers "no record" for a line that was demonstrably written. Project `CLAUDE.md` makes this override any general shell preference.
- **Route every commit through `/git-workflow:commit`**, including from subagents. Never craft `git commit -m` ad hoc. Each commit step below gives the message to hand the skill.
- **American English** in comments, commit messages, and docs.
- **Work lands on a branch, never a direct push to `main`.** The branch `docs/cli-release-gate-spec` already exists and carries the spec; continue on it.
- **This gate fails closed.** `deployable.sh` fails *open* — it deploys rather than guess, because a skipped deploy is worse than a redundant one. This script is the opposite: an unreadable manifest, an unreachable API, or an unrecognized verdict must **block**, because a wrongly-passed gate is exactly the silence being removed and a wrongly-failed one costs one label or one re-run. Do not copy `deployable.sh`'s failure direction.
- **Shell style matches the neighbors:** tabs for indentation, `readonly` for constants, a comment above each function saying *why* it exists rather than what it does.
- `scripts/cli-version.sh` and `scripts/cli-version.test.sh` must both be `chmod +x` — every other script in `scripts/` is.

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/cli-version.sh` (create) | Three pure subcommands (`--paths`, `--deps-differ`, `--decide`) and a gatherer that reads git and `gh` and emits the annotation |
| `scripts/cli-version.test.sh` (create) | Offline tests driving the three pure subcommands; no network, no `gh` stub |
| `.github/workflows/deploy.yml` (modify) | New `cli-version` job; new `quality` test step; `required` gains a dependency |

The gatherer is in the same file as the subcommands rather than split out, matching `deployable.sh`, which does the same thing at a similar size.

---

### Task 1: `--paths` — derive what is actually in the binary

**Files:**
- Create: `scripts/cli-version.sh`
- Create: `scripts/cli-version.test.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: `cli-version.sh --paths [ROOT]` prints one repo-relative path per line — `apps/cli/src`, then `packages/<dir>/src` for each `workspace:*` entry in `apps/cli/package.json`'s `dependencies`. `ROOT` defaults to the repository root derived from the script's own location; tests pass a temp tree. Exits 1 with a message on stderr when the manifest is missing or a workspace dependency has no package.

- [ ] **Step 1: Write the failing test**

Create `scripts/cli-version.test.sh`:

```bash
#!/usr/bin/env bash
# Offline tests for scripts/cli-version.sh.
#
# These make no network requests. Each pure subcommand is exercised as itself
# on real inputs - a real manifest tree for --paths, real manifest files for
# --deps-differ, a real file list on stdin for --decide - rather than through a
# stub of something else, which is the only way these tests can fail for the
# reason they claim to.
#
# What they are protecting: the gate is the only thing that notices when the
# code on main is not the code anybody is running. Its failure mode is silent
# and has already cost two releases (#141/#142 and #167/#168).
set -uo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly CLI_VERSION="${SCRIPT_DIR}/cli-version.sh"

tests=0
failures=0

# make_tree <dir> <cli-dependencies-json> [<pkg-name>:<pkg-dir> ...]
#
# Builds a throwaway repository root: an apps/cli manifest carrying the given
# dependencies block, and a package under packages/ for each name:dir pair.
# The pairs are deliberately separate from the dependency names so a test can
# build a tree where a package is named nothing like its directory - which is
# the real situation, @onlooker-community/lesson-contract living in
# packages/lesson-contract.
make_tree() {
	local dir="$1" deps="$2"
	shift 2

	mkdir -p "${dir}/apps/cli"
	printf '{"name":"@onlooker/cli","version":"2.6.0","dependencies":%s}\n' \
		"${deps}" >"${dir}/apps/cli/package.json"

	local pair name pkgdir
	for pair in "$@"; do
		name="${pair%%:*}"
		pkgdir="${pair##*:}"
		mkdir -p "${dir}/packages/${pkgdir}/src"
		printf '{"name":"%s","version":"1.0.0"}\n' "${name}" \
			>"${dir}/packages/${pkgdir}/package.json"
	done
}

# expect_paths <expected-newline-list> <description> <tree-dir>
expect_paths() {
	local expected="$1" description="$2" dir="$3"

	tests=$((tests + 1))

	local actual=""
	actual="$("${CLI_VERSION}" --paths "${dir}" 2>/dev/null)"

	if [[ "${actual}" == "${expected}" ]]; then
		echo "  ok    ${description}"
	else
		echo "  FAIL  ${description} -> '${actual}' (expected '${expected}')"
		failures=$((failures + 1))
	fi
}

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

echo "cli-version.sh: which paths end up in the binary"

make_tree "${work}/one" '{"@onlooker-community/lesson-contract":"workspace:*"}' \
	"@onlooker-community/lesson-contract:lesson-contract"
expect_paths "apps/cli/src
packages/lesson-contract/src" \
	"the CLI's own source and its one workspace dependency" "${work}/one"

# The gate has to widen on its own when somebody adds a workspace dependency to
# the CLI. Hardcoding today's answer is how this hole reopens quietly.
make_tree "${work}/two" \
	'{"@onlooker-community/lesson-contract":"workspace:*","@onlooker/logger":"workspace:*"}' \
	"@onlooker-community/lesson-contract:lesson-contract" "@onlooker/logger:logger"
expect_paths "apps/cli/src
packages/lesson-contract/src
packages/logger/src" \
	"a second workspace dependency widens it" "${work}/two"

# A registry dependency is bundled too, but it is not a path in this repository
# and nothing here can diff it.
make_tree "${work}/registry" '{"zod":"4.4.3"}'
expect_paths "apps/cli/src" "a registry dependency contributes no path" "${work}/registry"

make_tree "${work}/none" '{}'
expect_paths "apps/cli/src" "no dependencies at all" "${work}/none"

echo
if ((failures > 0)); then
	echo "cli-version.test.sh: ${failures} of ${tests} tests failed"
	exit 1
fi
echo "cli-version.test.sh: all ${tests} tests passed"
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
chmod +x scripts/cli-version.test.sh
bash scripts/cli-version.test.sh
```

Expected: every `expect_paths` reports `FAIL ... -> ''`, because `scripts/cli-version.sh` does not exist yet. The empty actual is what a missing script produces, which is why Task 3's verdict helper asserts an exit code alongside the output — see its note.

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/cli-version.sh`:

```bash
#!/usr/bin/env bash
# Does this pull request change the code inside the CLI binary without
# releasing it?
#
# Usage: scripts/cli-version.sh
#        scripts/cli-version.sh --paths [ROOT]
#
# WHY THIS EXISTS
#
# The CLI's release trigger is a version change in apps/cli/package.json.
# tag-cli.yml is paths-filtered on that one file, and deploy.yml deliberately
# never ships the CLI. So a pull request can change apps/cli/src, merge green,
# deploy the API and the web app, and leave every installed `onlooker` running
# the old binary, with nothing anywhere reporting it.
#
# That has happened twice. #141 shipped the machine inventory inert and #142
# was spent fixing it; #167 shipped session summaries inert and #168 cut the
# release, caught only because a person thought to ask. 7af44e2 wrote the rule
# down in a commit message, and the plan behind #167 forgot it anyway. A rule
# in a commit message is not a check.
#
# FAILS CLOSED, unlike deployable.sh next door. That script deploys rather than
# guess, because a skipped deploy is worse than a redundant one. Here the
# asymmetry runs the other way: a gate that wrongly passes restores exactly the
# silence it was built to end, and a gate that wrongly fails costs one label or
# one re-run. When this script cannot work something out, it blocks.
set -euo pipefail

readonly REPO_ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Print every path in this repository whose contents end up in the CLI binary.
#
# Derived from the manifest rather than hardcoded. apps/cli builds with
# `esbuild --bundle`, so its workspace dependencies are compiled into
# dist/onlooker.mjs - lessons.ts, pull.ts and commands/playbook.ts import
# ZLesson, a Zod schema and therefore a runtime value, from
# @onlooker-community/lesson-contract. A change under that package ships a
# different binary without touching apps/cli/src at all. Reading the manifest
# means adding a workspace dependency widens this gate by itself instead of
# quietly reopening the hole.
derive_paths() {
	local root="${1:-${REPO_ROOT_DEFAULT}}"
	local manifest="${root}/apps/cli/package.json"

	if [[ ! -f "${manifest}" ]]; then
		echo "cli-version: no manifest at ${manifest}" >&2
		return 1
	fi

	echo "apps/cli/src"

	local dep dir
	while read -r dep; do
		[[ -n "${dep}" ]] || continue

		if ! dir="$(package_dir "${root}" "${dep}")"; then
			echo "cli-version: ${dep} is a workspace dependency with no package under ${root}/packages" >&2
			return 1
		fi

		echo "${dir}/src"
	done < <(jq -r '
		.dependencies // {}
		| to_entries[]
		| select(.value | startswith("workspace:"))
		| .key
	' "${manifest}")
}

# Map a package name to its directory by reading each manifest's own `name`.
#
# Not by assuming the directory is named after the package: the one workspace
# dependency the CLI has today is @onlooker-community/lesson-contract living in
# packages/lesson-contract, and nothing enforces that correspondence.
package_dir() {
	local root="$1" name="$2" manifest="" dir=""

	for manifest in "${root}"/packages/*/package.json; do
		[[ -f "${manifest}" ]] || continue

		if [[ "$(jq -r '.name // ""' "${manifest}")" == "${name}" ]]; then
			dir="${manifest%/package.json}"
			printf '%s\n' "packages/$(basename "${dir}")"
			return 0
		fi
	done

	return 1
}

case "${1:-}" in
	--paths)
		derive_paths "${2:-}"
		exit $?
		;;
	*)
		echo "usage: $(basename "$0")" >&2
		echo "       $(basename "$0") --paths [ROOT]" >&2
		exit 2
		;;
esac
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
chmod +x scripts/cli-version.sh
bash scripts/cli-version.test.sh
```

Expected: `cli-version.test.sh: all 4 tests passed`

- [ ] **Step 5: Commit**

Run `/git-workflow:commit` with this message:

```
feat(ci): derive what is actually inside the CLI binary :mag:

First piece of the release gate. The CLI bundles with esbuild, and
lessons.ts, pull.ts and commands/playbook.ts import ZLesson - a Zod
schema, so a runtime value - from @onlooker-community/lesson-contract.
A change under packages/lesson-contract/src therefore ships a different
binary without touching apps/cli/src, and a gate scoped to the path
onlooker-mcwn names would miss it.

Derived from the manifest rather than hardcoded so that adding a
workspace dependency to the CLI widens the gate by itself. Package
names are resolved by reading each manifest's own `name` - the one
dependency that exists today is @onlooker-community/lesson-contract in
packages/lesson-contract, and nothing enforces that correspondence.

Refs onlooker-mcwn
```

---

### Task 2: `--deps-differ` — tell a dependency change from a version bump

**Files:**
- Modify: `scripts/cli-version.sh`
- Modify: `scripts/cli-version.test.sh`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `cli-version.sh --deps-differ OLD_MANIFEST NEW_MANIFEST` — exit 0 when the two files' `dependencies` blocks differ, exit 1 when they match. Both arguments are paths to JSON files. Exits 2 on a usage error.

Why this is its own subcommand rather than a line in the gatherer: `apps/cli/package.json` cannot go in the derived path set, because it changes on *every* bump and also carries `scripts`, `bin`, and `devDependencies`, none of which alter the shipped binary. Only the `dependencies` block earns the manifest a place, and that comparison needs to be testable on its own.

- [ ] **Step 1: Write the failing test**

In `scripts/cli-version.test.sh`, add this helper immediately after `expect_paths`:

```bash
# expect_deps <expected-exit> <description> <old-json> <new-json>
#
# The exit code is the whole answer here, so it is what gets asserted. 0 means
# the dependencies moved, 1 means they did not.
expect_deps() {
	local expected="$1" description="$2" old_json="$3" new_json="$4"

	tests=$((tests + 1))

	local old_file="${work}/deps-old.json" new_file="${work}/deps-new.json"
	printf '%s\n' "${old_json}" >"${old_file}"
	printf '%s\n' "${new_json}" >"${new_file}"

	local actual=0
	"${CLI_VERSION}" --deps-differ "${old_file}" "${new_file}" >/dev/null 2>&1 || actual=$?

	if [[ "${actual}" == "${expected}" ]]; then
		echo "  ok    ${description}"
	else
		echo "  FAIL  ${description} -> exit ${actual} (expected ${expected})"
		failures=$((failures + 1))
	fi
}
```

And add this block immediately before the final `echo` / summary:

```bash
echo "cli-version.sh: a dependency change against everything else in the manifest"

expect_deps 0 "a dependency version moved" \
	'{"version":"2.6.0","dependencies":{"zod":"4.4.3"}}' \
	'{"version":"2.6.0","dependencies":{"zod":"4.5.0"}}'

expect_deps 0 "a dependency was added" \
	'{"version":"2.6.0","dependencies":{"zod":"4.4.3"}}' \
	'{"version":"2.6.0","dependencies":{"zod":"4.4.3","@onlooker/logger":"workspace:*"}}'

expect_deps 0 "a dependency was removed" \
	'{"version":"2.6.0","dependencies":{"zod":"4.4.3"}}' \
	'{"version":"2.6.0","dependencies":{}}'

# The case that keeps every release from reading as a source change. If a bump
# counted, the gate would see source in every release-only pull request - which
# still passes, but for the wrong reason, and the test that proves it does not
# is cheaper than the confusion later.
expect_deps 1 "only the version moved" \
	'{"version":"2.6.0","dependencies":{"zod":"4.4.3"}}' \
	'{"version":"2.7.0","dependencies":{"zod":"4.4.3"}}'

expect_deps 1 "only a script changed" \
	'{"version":"2.6.0","scripts":{"build":"old"},"dependencies":{"zod":"4.4.3"}}' \
	'{"version":"2.6.0","scripts":{"build":"new"},"dependencies":{"zod":"4.4.3"}}'

expect_deps 1 "only devDependencies changed" \
	'{"version":"2.6.0","devDependencies":{"vitest":"4.1.9"},"dependencies":{"zod":"4.4.3"}}' \
	'{"version":"2.6.0","devDependencies":{"vitest":"4.2.0"},"dependencies":{"zod":"4.4.3"}}'

# Key order is a formatting accident, not a change. Without -S this reports a
# dependency move every time a formatter reorders the block.
expect_deps 1 "the same dependencies in a different order" \
	'{"dependencies":{"zod":"4.4.3","@onlooker/logger":"workspace:*"}}' \
	'{"dependencies":{"@onlooker/logger":"workspace:*","zod":"4.4.3"}}'

expect_deps 1 "no dependencies block on either side" \
	'{"version":"2.6.0"}' '{"version":"2.7.0"}'
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bash scripts/cli-version.test.sh
```

Expected: the four `expect_paths` cases still pass; all eight `expect_deps` cases report `FAIL ... -> exit 2`, because `--deps-differ` is not a recognized subcommand and the usage branch exits 2.

- [ ] **Step 3: Write the minimal implementation**

In `scripts/cli-version.sh`, add this function immediately after `package_dir`:

```bash
# Did the dependencies block move between two manifests?
#
# Not "did the manifest change": apps/cli/package.json changes on every release
# by definition, and it also carries scripts, bin and devDependencies, none of
# which alter the shipped binary. Only a dependency change does, and only that
# should make the manifest count as CLI source.
#
# -S sorts keys so a formatter reordering the block does not read as a change,
# and `// {}` makes a missing block compare equal to an empty one rather than
# `null` against `{}`.
deps_differ() {
	local old="$1" new="$2" old_deps="" new_deps=""

	old_deps="$(jq -S -c '.dependencies // {}' "${old}")"
	new_deps="$(jq -S -c '.dependencies // {}' "${new}")"

	[[ "${old_deps}" != "${new_deps}" ]]
}
```

And extend the `case` block — add this branch before the `*)` fallthrough:

```bash
	--deps-differ)
		if [[ $# -ne 3 ]]; then
			echo "usage: $(basename "$0") --deps-differ OLD NEW" >&2
			exit 2
		fi
		deps_differ "$2" "$3"
		exit $?
		;;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bash scripts/cli-version.test.sh
```

Expected: `cli-version.test.sh: all 12 tests passed`

- [ ] **Step 5: Commit**

Run `/git-workflow:commit` with this message:

```
feat(ci): let the gate tell a dependency bump from a release :scales:

apps/cli/package.json cannot sit in the derived path set: it changes on
every release by definition, and it also carries scripts, bin and
devDependencies, none of which alter the shipped binary. Only the
dependencies block does - a dependency bump changes the bundle without
touching a line of first-party source.

So the comparison is narrowed to that block and given its own
subcommand, which makes it testable on its own. Keys are sorted, so a
formatter reordering the block does not read as a change, and a missing
block compares equal to an empty one.

Refs onlooker-mcwn
```

---

### Task 3: `--decide` — the verdict

**Files:**
- Modify: `scripts/cli-version.sh`
- Modify: `scripts/cli-version.test.sh`

**Interfaces:**
- Consumes: the path list Task 1's `--paths` produces, passed as `--source-paths`.
- Produces:

```
cli-version.sh --decide --source-paths <list> \
                        --old-version X --new-version Y \
                        --labels <list>
```

Reads the **whole** changed-file list on stdin (`git diff --name-only` output, one per line) and filters it against `--source-paths` itself; it never calls `--paths`. Both list flags accept comma- or newline-separated values. Prints exactly one verdict token and **always exits 0**:

```
pass:no-cli-change   pass:bumped   pass:deferred
fail:no-bump         fail:backward
```

Always exiting 0 keeps `set -e` in the gatherer from killing the run on a legitimate `fail:` answer, and makes the token the single source of truth. A broken or missing script prints the empty string, which is not a valid token — the gatherer in Task 4 treats anything unrecognized as a block, which is the fail-closed direction.

- [ ] **Step 1: Write the failing test**

In `scripts/cli-version.test.sh`, add this helper immediately after `expect_deps`:

```bash
# expect_verdict <expected> <description> <source-paths> <old> <new> <labels> <changed-path...>
#
# The changed paths are passed as arguments and fed in on stdin, because that
# is how the real run hands them over - `git diff --name-only` output, one per
# line. The exit code is asserted alongside the output: a verdict is a token,
# and a missing or broken script prints the empty string, which would otherwise
# make a "no verdict expected" case pass against no script at all.
expect_verdict() {
	local expected="$1" description="$2" source_paths="$3"
	local old="$4" new="$5" labels="$6"
	shift 6

	tests=$((tests + 1))

	local actual="" status=0
	actual="$(printf '%s\n' "$@" | "${CLI_VERSION}" --decide \
		--source-paths "${source_paths}" \
		--old-version "${old}" \
		--new-version "${new}" \
		--labels "${labels}" 2>/dev/null)" || status=$?

	if [[ "${actual}" == "${expected}" && "${status}" == 0 ]]; then
		echo "  ok    ${description}"
	else
		echo "  FAIL  ${description} -> '${actual}' exit ${status} (expected '${expected}' exit 0)"
		failures=$((failures + 1))
	fi
}

# The path set the real repository derives today. Written once so every verdict
# case below reads as the question it is asking rather than as plumbing.
readonly PATHS="apps/cli/src,packages/lesson-contract/src"
```

And add this block immediately before the final `echo` / summary:

```bash
echo "cli-version.sh: the verdict"

expect_verdict "pass:no-cli-change" "nothing touched the binary" \
	"${PATHS}" "2.6.0" "2.6.0" "" "README.md" "apps/api/src/index.ts"

expect_verdict "pass:no-cli-change" "nothing changed at all" \
	"${PATHS}" "2.6.0" "2.6.0" "" ""

# A release-only pull request. It passes at step one, before the version is
# even considered, and that is correct - there is no source to release.
expect_verdict "pass:no-cli-change" "only the version moved" \
	"${PATHS}" "2.6.0" "2.7.0" "" "apps/cli/package.json"

expect_verdict "pass:bumped" "CLI source changed and the version moved" \
	"${PATHS}" "2.6.0" "2.7.0" "" "apps/cli/src/sessions.ts"

expect_verdict "fail:no-bump" "CLI source changed and the version did not" \
	"${PATHS}" "2.6.0" "2.6.0" "" "apps/cli/src/sessions.ts"

# The case a gate scoped to apps/cli/src would get wrong. ZLesson is a runtime
# value, so this ships a different binary having touched no CLI file.
expect_verdict "fail:no-bump" "the bundled contract changed and the version did not" \
	"${PATHS}" "2.6.0" "2.6.0" "" "packages/lesson-contract/src/lesson.ts"

# The manifest counts only when the gatherer has already decided its
# dependencies moved, and says so by adding it to the path set.
expect_verdict "fail:no-bump" "a dependency change the gatherer flagged" \
	"${PATHS},apps/cli/package.json" "2.6.0" "2.6.0" "" "apps/cli/package.json"

expect_verdict "pass:deferred" "the batch label defers the release" \
	"${PATHS}" "2.6.0" "2.6.0" "cli-batch" "apps/cli/src/sessions.ts"

expect_verdict "pass:deferred" "the batch label among several" \
	"${PATHS}" "2.6.0" "2.6.0" "enhancement,cli-batch,documentation" \
	"apps/cli/src/sessions.ts"

expect_verdict "fail:no-bump" "labels that are not the batch label" \
	"${PATHS}" "2.6.0" "2.6.0" "enhancement,documentation" "apps/cli/src/sessions.ts"

# A bump still has to be a bump. The CLI has a Homebrew tap, and it would take
# the lower number the same way a registry moves a dist-tag backward.
expect_verdict "fail:backward" "the version moved backward" \
	"${PATHS}" "2.6.0" "2.5.0" "" "apps/cli/src/sessions.ts"

expect_verdict "fail:backward" "backward wins over the batch label" \
	"${PATHS}" "2.6.0" "2.5.0" "cli-batch" "apps/cli/src/sessions.ts"

# Anchored prefix matching, the same property DEPLOYABLE_PATHS is anchored for.
# Unanchored, a document that merely lives under a similar path would demand a
# CLI release.
expect_verdict "pass:no-cli-change" "a doc that merely names a source path" \
	"${PATHS}" "2.6.0" "2.6.0" "" "docs/apps/cli/src/notes.md"

expect_verdict "pass:no-cli-change" "a sibling directory with a shared prefix" \
	"${PATHS}" "2.6.0" "2.6.0" "" "apps/cli/srcextra/x.ts"

expect_verdict "fail:no-bump" "one CLI file among many that are not" \
	"${PATHS}" "2.6.0" "2.6.0" "" \
	"README.md" "docs/notes.md" "apps/cli/src/main.ts" ".beads/issues.jsonl"
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bash scripts/cli-version.test.sh
```

Expected: the twelve earlier cases still pass; all fifteen `expect_verdict` cases report `FAIL ... -> '' exit 2`.

- [ ] **Step 3: Write the minimal implementation**

In `scripts/cli-version.sh`, add these three functions immediately after `deps_differ`:

```bash
# The label that turns a missing bump into a recorded decision.
#
# Batching several CLI changes across pull requests and cutting one release at
# the end is legitimate, so this gate cannot simply forbid a missing bump the
# way contract-version forbids a missing schema bump. Forgetting fails;
# batching costs one deliberate act that leaves a trace on the pull request.
readonly BATCH_LABEL="cli-batch"

# Split a comma- or newline-separated list into lines.
#
# Both separators are accepted so the gatherer can pipe `--paths` output and
# `gh pr view --jq '.labels[].name'` output straight through, while a test can
# write one readable flag value.
as_lines() {
	printf '%s' "$1" | tr ',' '\n'
}

# Does any changed file live under one of the source paths?
#
# Prefix-matched and anchored at the path boundary, which is load-bearing in
# both directions: `apps/cli/src` must match `apps/cli/src/main.ts` but neither
# `apps/cli/srcextra/x.ts` nor `docs/apps/cli/src/notes.md`. Unanchored, a
# document that merely mentions a source path would demand a release.
touches_source() {
	local source_paths="$1" file="" path=""
	local -a paths=()

	while read -r path; do
		[[ -n "${path}" ]] || continue
		paths+=("${path}")
	done < <(as_lines "${source_paths}")

	while read -r file; do
		[[ -n "${file}" ]] || continue

		for path in "${paths[@]}"; do
			if [[ "${file}" == "${path}" || "${file}" == "${path}/"* ]]; then
				return 0
			fi
		done
	done

	return 1
}

# Is the batch label among the pull request's labels?
has_batch_label() {
	local labels="$1" label=""

	while read -r label; do
		[[ "${label}" == "${BATCH_LABEL}" ]] && return 0
	done < <(as_lines "${labels}")

	return 1
}

# Read a changed-file list on stdin, print one verdict.
#
# Separated from the git and API calls so it can be tested as itself, on real
# file lists, rather than through a stub of something else. Always exits 0: the
# token is the answer, and a `fail:` result is a verdict rather than a broken
# run. The caller decides what to do about it, and an empty token - which is
# what a missing script prints - is not a verdict at all.
decide() {
	local source_paths="$1" old_version="$2" new_version="$3" labels="$4"

	if ! touches_source "${source_paths}"; then
		echo "pass:no-cli-change"
		return 0
	fi

	if [[ "${old_version}" != "${new_version}" ]]; then
		# Checked before the bump is accepted, not after. The CLI has a
		# Homebrew tap, and a lower number would move the formula backward the
		# same way publishing one moves a registry dist-tag backward - which
		# cannot be cleanly undone. contract-version carries this guard for
		# the same reason.
		local newest=""
		newest="$(printf '%s\n%s\n' "${old_version}" "${new_version}" | sort -V | tail -1)"

		if [[ "${newest}" != "${new_version}" ]]; then
			echo "fail:backward"
			return 0
		fi

		echo "pass:bumped"
		return 0
	fi

	if has_batch_label "${labels}"; then
		echo "pass:deferred"
		return 0
	fi

	echo "fail:no-bump"
	return 0
}
```

Then add the `--decide` branch to the `case` block, before the `*)` fallthrough:

```bash
	--decide)
		shift
		decide_source_paths=""
		decide_old=""
		decide_new=""
		decide_labels=""

		while [[ $# -gt 0 ]]; do
			case "$1" in
				--source-paths) decide_source_paths="${2:-}"; shift 2 ;;
				--old-version) decide_old="${2:-}"; shift 2 ;;
				--new-version) decide_new="${2:-}"; shift 2 ;;
				--labels) decide_labels="${2:-}"; shift 2 ;;
				*)
					echo "cli-version: unknown --decide flag '$1'" >&2
					exit 2
					;;
			esac
		done

		decide "${decide_source_paths}" "${decide_old}" "${decide_new}" "${decide_labels}"
		exit 0
		;;
```

Finally, update the usage block in the `*)` branch to list all three subcommands:

```bash
	*)
		echo "usage: $(basename "$0")" >&2
		echo "       $(basename "$0") --paths [ROOT]" >&2
		echo "       $(basename "$0") --deps-differ OLD NEW" >&2
		echo "       $(basename "$0") --decide --source-paths L --old-version X --new-version Y --labels L  < changed-file-list" >&2
		exit 2
		;;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bash scripts/cli-version.test.sh
```

Expected: `cli-version.test.sh: all 27 tests passed`

- [ ] **Step 5: Commit**

Run `/git-workflow:commit` with this message:

```
feat(ci): decide whether a change to the CLI was ever released :thinking:

The verdict, as a pure function of a changed-file list, two versions and
a label set - so the tests drive the real decision on real inputs rather
than a stub of something else, which is the only way they can fail for
the reason they claim to.

Path matching is anchored at the path boundary in both directions:
apps/cli/src has to match apps/cli/src/main.ts and neither
apps/cli/srcextra/x.ts nor docs/apps/cli/src/notes.md, or a document
that merely mentions a source path would demand a release.

A backward version is rejected before the bump is accepted. The CLI has
a Homebrew tap and it would take the lower number, the same way
publishing moves a registry dist-tag backward.

Always exits 0. The token is the answer, a fail: result is a verdict
rather than a broken run, and an empty token - what a missing script
prints - is not a verdict at all.

Refs onlooker-mcwn
```

---

### Task 4: The gatherer — read the real world, emit the annotation

**Files:**
- Modify: `scripts/cli-version.sh`

**Interfaces:**
- Consumes: `derive_paths`, `deps_differ`, and `decide` from Tasks 1–3.
- Produces: `scripts/cli-version.sh` with no arguments. Reads `BASE_REF` (required), `PR_NUMBER` (optional), and `GH_TOKEN` from the environment. Exits 0 on a `pass:` verdict, 1 on a `fail:` verdict or on anything it cannot work out.

No new tests: everything testable was tested in Tasks 1–3, and what remains is the composition plus the two calls that need a network and a git history. `deployable.sh` draws the line in the same place, and its header says why — the code that talks to `gh` is not the code worth stubbing.

- [ ] **Step 1: Write the implementation**

In `scripts/cli-version.sh`, replace the `*)` branch of the `case` block so that no arguments runs the gatherer rather than printing usage. The `case` block's final two branches become:

```bash
	"")
		;;
	*)
		echo "usage: $(basename "$0")" >&2
		echo "       $(basename "$0") --paths [ROOT]" >&2
		echo "       $(basename "$0") --deps-differ OLD NEW" >&2
		echo "       $(basename "$0") --decide --source-paths L --old-version X --new-version Y --labels L  < changed-file-list" >&2
		exit 2
		;;
esac
```

Then append the gatherer below the `esac`:

```bash
# ---------------------------------------------------------------------------
# The full run. Everything above is pure; everything below reads the world.
# ---------------------------------------------------------------------------

readonly REPO_ROOT="${REPO_ROOT_DEFAULT}"
readonly MANIFEST="${REPO_ROOT}/apps/cli/package.json"

if [[ -z "${BASE_REF:-}" ]]; then
	echo "::error title=CLI release gate misconfigured::BASE_REF is not set. It must name the base to diff against, e.g. origin/main."
	exit 1
fi

source_paths="$(derive_paths "${REPO_ROOT}")"

old_manifest="$(mktemp)"
trap 'rm -f "${old_manifest}"' EXIT

if ! git show "${BASE_REF}:apps/cli/package.json" >"${old_manifest}" 2>/dev/null; then
	echo "::error title=CLI release gate cannot read the base::apps/cli/package.json is not present at ${BASE_REF}. Without it there is nothing to compare, and this gate blocks rather than guess."
	exit 1
fi

# The manifest is not in the derived set on purpose - it changes on every
# release, and it carries scripts, bin and devDependencies too. It earns a
# place in the set only when its dependencies moved, because that is the only
# part of it that changes the bundle.
if deps_differ "${old_manifest}" "${MANIFEST}"; then
	source_paths="${source_paths}"$'\n'"apps/cli/package.json"
	echo "cli-version: the CLI's dependencies moved; counting the manifest as source" >&2
fi

old_version="$(jq -r '.version // ""' "${old_manifest}")"
new_version="$(jq -r '.version // ""' "${MANIFEST}")"

# A missing label read fails closed. A transient API error must not quietly
# turn a deliberate batch into a passing run or an unlabelled one into a pass -
# it leaves labels empty, which can only make the gate stricter, and the run
# log says so.
labels=""
if [[ -n "${PR_NUMBER:-}" ]]; then
	if ! labels="$(gh pr view "${PR_NUMBER}" --json labels --jq '.labels[].name' 2>/dev/null)"; then
		labels=""
		echo "cli-version: could not read the labels of #${PR_NUMBER}; treating it as unlabelled" >&2
	fi
else
	echo "cli-version: no PR_NUMBER; treating this run as unlabelled" >&2
fi

changed="$(git diff --name-only "${BASE_REF}...HEAD")"

# Printed because it is the whole explanation for the answer, and the run log
# is where anyone will look when the answer surprises them.
echo "cli-version: comparing ${BASE_REF}...HEAD" >&2
printf '%s\n' "${changed}" >&2
echo "cli-version: source paths" >&2
printf '%s\n' "${source_paths}" >&2

verdict="$(printf '%s\n' "${changed}" | decide \
	"${source_paths}" "${old_version}" "${new_version}" "${labels}")"

# Which files made it count. Recomputed rather than threaded out of `decide`,
# which stays a pure function of its inputs and answers one question.
touched="$(printf '%s\n' "${changed}" | while read -r file; do
	[[ -n "${file}" ]] || continue
	if printf '%s\n' "${file}" | touches_source "${source_paths}"; then
		printf '%s ' "${file}"
	fi
done)"
touched="${touched% }"

case "${verdict}" in
	pass:no-cli-change)
		echo "cli-version: nothing in this pull request reaches the CLI binary"
		exit 0
		;;
	pass:bumped)
		echo "cli-version: CLI source changed and the version moved ${old_version} -> ${new_version}"
		exit 0
		;;
	pass:deferred)
		echo "cli-version: ${touched} changed and the version is still ${new_version}, deferred by the ${BATCH_LABEL} label. Remember to bump before this reaches anybody."
		exit 0
		;;
	fail:backward)
		echo "::error title=CLI version moved backward::apps/cli/package.json went from ${old_version} to ${new_version}. release-cli.yml would cut cli-v${new_version} and the Homebrew tap would take the lower number, which cannot be cleanly undone once somebody has installed it."
		exit 1
		;;
	fail:no-bump)
		echo "::error title=CLI source changed without a release::${touched} changed, but apps/cli/package.json is still ${new_version}. tag-cli.yml releases on a version change and nothing else, so this merges, deploys the API and the web app, and leaves every installed \`onlooker\` running the old binary - the failure in #141 and #167. Bump the version here, or add the \`${BATCH_LABEL}\` label and re-run this job to release these changes together later."
		exit 1
		;;
	*)
		# Fails closed, unlike deployable.sh next door. A gate that cannot work
		# out an answer and passes anyway restores exactly the silence it was
		# built to end.
		echo "::error title=CLI release gate could not decide::The verdict was '${verdict}', which is not one this script knows. Blocking rather than guessing."
		exit 1
		;;
esac
```

- [ ] **Step 2: Run the existing tests to verify nothing regressed**

```bash
bash scripts/cli-version.test.sh
```

Expected: `cli-version.test.sh: all 27 tests passed`. The gatherer is new code below the `esac`, and none of the pure subcommands changed, so a failure here means the `case` restructuring in Step 1 broke a subcommand.

- [ ] **Step 3: Exercise the gatherer against this branch by hand**

```bash
BASE_REF=origin/main bash scripts/cli-version.sh; echo "exit: $status"
```

Expected: `cli-version: no PR_NUMBER; treating this run as unlabelled` on stderr, the changed-file list and source paths printed, then `cli-version: nothing in this pull request reaches the CLI binary` and exit 0 — this branch has touched only `docs/` and `scripts/`.

Note: the shell here is fish, where the exit status is `$status`, not `$?`.

- [ ] **Step 4: Exercise the failing path by hand**

```bash
echo "// gate check, to be reverted" >> apps/cli/src/main.ts
BASE_REF=origin/main bash scripts/cli-version.sh; echo "exit: $status"
git checkout apps/cli/src/main.ts
```

Expected: the `::error title=CLI source changed without a release::` annotation naming `apps/cli/src/main.ts` and version `2.6.0`, and exit 1. Confirm `git status` is clean afterward — the revert matters, this file ships.

- [ ] **Step 5: Commit**

Run `/git-workflow:commit` with this message:

```
feat(ci): give the CLI release gate its failing voice :mega:

Composes the three pure subcommands with the two things that need a
network and a git history, and turns a verdict into a GitHub annotation.

The failure names the paths that changed, the version that stayed, the
mechanism, the two incidents, and both ways out - so the escape hatch
lives in the message that sends somebody looking for it rather than in
documentation nobody reads.

Every unknown fails closed, which is the opposite of deployable.sh next
door. That script deploys rather than guess, because a skipped deploy is
worse than a redundant one. Here a gate that wrongly passes restores the
exact silence it was built to end, and one that wrongly fails costs a
label or a re-run. An unreadable base, an unreachable label API and an
unrecognized verdict all block.

Refs onlooker-mcwn
```

---

### Task 5: Wire it into CI and create the label

**Files:**
- Modify: `.github/workflows/deploy.yml` (three edits: a `quality` step, a new job, and the `required` gate)

**Interfaces:**
- Consumes: `scripts/cli-version.sh` and `scripts/cli-version.test.sh` from Tasks 1–4.
- Produces: a `cli-version` job whose result the `required` job reads. `required` is the single status context the **Require CI** ruleset (id `22402388`) enforces, under the name `All checks passed`.

- [ ] **Step 1: Add the test suite to the `quality` job**

In `.github/workflows/deploy.yml`, immediately after the `Source guard tests` step (currently around line 159) and before `- name: Setup Node.js`, insert:

```yaml
      # The gate is the only thing that notices when the code on main is not
      # the code anybody is running, and like the deployable filter it fails
      # silently in the direction that matters: a wrong "nothing changed" is a
      # green merge that released nothing. That has already cost two releases,
      # #141/#142 and #167/#168.
      - name: CLI release gate tests
        run: bash scripts/cli-version.test.sh
```

- [ ] **Step 2: Add the `cli-version` job**

In `.github/workflows/deploy.yml`, immediately after the `contract-version` job ends (the line `          echo "version moved ${old} -> ${new}"`, currently around line 232) and before the `# ====` banner introducing `publish-contract`, insert:

```yaml
  cli-version:
    name: CLI released with its source
    runs-on: ubuntu-latest
    # Pull requests only, for contract-version's reason: the comparison is
    # against the PR's base, which a push to main does not have.
    if: github.event_name == 'pull_request'
    # Explicit because deploy.yml has no top-level permissions block. The label
    # read is the only thing this needs beyond a checkout.
    permissions:
      contents: read
      pull-requests: read
    steps:
      # Full history so the base ref is available to diff against.
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0

      # The labels are read live from the API rather than from
      # github.event.pull_request.labels, which is a snapshot taken when the
      # run started. Adding the label after a failure therefore counts, and
      # costs a click plus "Re-run failed jobs" - which re-runs this job and
      # the gate and nothing else.
      #
      # The alternative was adding `labeled` to this workflow's pull_request
      # trigger, which would re-run quality, test and changes on every label
      # change. Gating those off for label events is worse: they would be
      # SKIPPED, and `required` counts skipped as passing, so labeling a pull
      # request would mint a green "All checks passed" from a run that tested
      # nothing.
      - name: Fail if CLI source changed without a release
        env:
          BASE_REF: origin/${{ github.base_ref }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          GH_TOKEN: ${{ github.token }}
        run: bash scripts/cli-version.sh
```

- [ ] **Step 3: Add it to the `required` gate**

In `.github/workflows/deploy.yml`, in the `required` job (currently around line 794), change the `needs:` line:

```yaml
    needs: [quality, test, contract-version, cli-version, changes]
```

Update the comment inside `Check results`, which currently names only `contract-version`:

```yaml
          # `contract-version` and `cli-version` are pull-request-only, so both
          # are skipped on a push to main - expected, not a failure. Anything
          # other than success or skipped fails the gate.
```

And add the new result to the loop:

```yaml
          for r in "${{ needs.quality.result }}" \
                   "${{ needs.test.result }}" \
                   "${{ needs.contract-version.result }}" \
                   "${{ needs.cli-version.result }}" \
                   "${{ needs.changes.result }}"; do
```

- [ ] **Step 4: Verify the workflow still parses**

```bash
actionlint .github/workflows/deploy.yml
```

Expected: no output, which is how `actionlint` reports a clean file. It is installed through mise and validates more than YAML syntax — a `needs:` naming a job that does not exist, or a `${{ needs.cli-version.result }}` reference that does not resolve, is an error rather than a file that parses and silently never gates anything.

Do not reach for `python3 -c "import yaml"` here; pyyaml is not installed on this machine, and a plain parse would not catch a bad `needs:` reference anyway.

- [ ] **Step 5: Create the label**

```bash
gh label create cli-batch \
  --description "CLI source changes here ship in a later release, on purpose" \
  --color FBCA04
```

Expected: `✓ Label "cli-batch" created`. Verify with `gh label list | grep cli-batch`. Without this label existing, the failure message names an escape hatch nobody can reach.

- [ ] **Step 6: Commit**

Run `/git-workflow:commit` with this message:

```
feat(ci): make an unreleased CLI change fail its pull request :closed_lock_with_key:

Puts the gate where a blocking check has to live here. The Require CI
ruleset enforces exactly one status context, "All checks passed", which
is the required job at the end of this workflow - so a check becomes
blocking by being a job here and a line in that list, and a workflow of
its own could not block without an org ruleset change.

Pull-request-only, like contract-version, because the comparison needs
a base that a push to main does not have. Both are now skipped on main,
so the comment in the gate that explains why skipped counts as passing
had to name both.

The cli-batch label is created alongside, because the failure message
names it as the way out and a hatch nobody can reach is not one.

Refs onlooker-mcwn
```

---

### Task 6: Prove the gate on a real pull request

**Files:** none — this task verifies the five before it.

**Interfaces:**
- Consumes: everything.
- Produces: evidence that the gate fails, that the label clears it, and that a bump clears it.

The gate's whole value is behaving correctly on a real pull request, and every step before this ran locally. `contract-version` has never been observed failing on a real PR either; this one should be, once, before it is trusted.

- [ ] **Step 1: Open the pull request**

Run `/git-workflow:pr`. The branch is `docs/cli-release-gate-spec`, carrying the spec, the script, its tests, and the workflow wiring.

- [ ] **Step 2: Confirm the gate passes on its own pull request**

```bash
gh pr checks --watch
```

Expected: `CLI released with its source` passes. This PR touches `docs/`, `scripts/`, and `.github/`, none of which are in the derived path set, so the verdict is `pass:no-cli-change`. Read the job log and confirm that is the reason it passed rather than an accident.

- [ ] **Step 3: Prove it fails**

Push a throwaway commit touching CLI source:

```bash
echo "// remove me" >> apps/cli/src/main.ts
```

Commit it via `/git-workflow:commit` with the message `test(ci): prove the CLI gate fails :test_tube:` and push.

Expected: `CLI released with its source` fails, and the annotation on the Files tab names `apps/cli/src/main.ts`, version `2.6.0`, and the `cli-batch` label.

- [ ] **Step 4: Prove the label clears it**

```bash
gh pr edit --add-label cli-batch
gh run rerun --failed
gh pr checks --watch
```

Expected: the job passes with `pass:deferred`, and the log names `apps/cli/src/main.ts` as deferred. This is the step that proves the live label read works — the label was added *after* the run that read the event payload, which is the whole reason it queries the API.

- [ ] **Step 5: Prove a bump clears it, then revert both**

```bash
gh pr edit --remove-label cli-batch
```

Bump `apps/cli/package.json`'s version to `2.7.0` with `Edit`, push, and confirm the job passes with `pass:bumped`.

Then undo the whole experiment — the version bump *and* the `apps/cli/src/main.ts` line — with `Edit`, restoring `2.6.0` and removing the `// remove me` line, so the pull request that merges carries only the gate.

Verify against the base rather than trusting the edits:

```bash
git diff origin/main -- apps/cli
```

Expected: **empty**. Do not merge until it is. A version bump left in this PR would cut `cli-v2.7.0` for a release nobody meant to make, which is a neat way for the gate's own pull request to cause the class of incident it exists to prevent. The leftover `// remove me` line is milder but would ship in the next real release.

Note that the gate itself now guards this: with the bump reverted and the stray line still present, `cli-version` fails — so the check has to be green for the right reason, which is `pass:no-cli-change`, not `pass:bumped`. Read the log and confirm which.

Commit the revert via `/git-workflow:commit` with `test(ci): remove the gate proof :broom:`.

- [ ] **Step 6: Close the bead**

```bash
bd close onlooker-mcwn
```

Then file the follow-up the spec named as out of scope:

```bash
bd create "Nothing notices CLI source pushed straight to main" \
  --type bug -p 3 \
  -d "cli-version is pull-request-only, so it cannot see a direct push to main.
The Require CI ruleset requires pull requests, but the repository owner is a
bypass actor and direct pushes have happened before - see the memory from
2026-08-13, where two commits went to main and the ruleset printed its refusal
and allowed them anyway.

A main-time check would have to compare the tip against the newest cli-v* tag
rather than against a base ref. It was considered for onlooker-mcwn and left
out deliberately: it fires after the merge, and it leaves main red for the
whole duration of a deliberate batch. Whether that is worth it depends on
whether direct pushes keep happening.

Refs onlooker-mcwn"
```

---

## Self-Review

**Spec coverage.** Every section of `docs/superpowers/specs/2026-09-19-cli-release-gate-design.md` maps to a task:

| Spec section | Task |
| --- | --- |
| What the binary actually contains | 1 (`--paths` derivation, `package_dir` name mapping) |
| The decision, step 2's manifest special case | 2 (`--deps-differ`), 4 (gatherer appends to the path set) |
| The decision, steps 1–5 | 3 (`--decide`) |
| Seams table | 1, 2, 3 (pure), 4 (gatherer) |
| The failure | 4 (annotation), 5 (label creation) |
| Where a blocking check has to live | 5 (`required` wiring) |
| Why the opt-out is not read from the event payload | 5 (live query, with the reasoning in the job comment), 6 Step 4 (proves it) |
| Placement | 5 (job + `quality` step) |
| Tests table, 13 rows | 1 (2 `--paths` rows, plus 2 extra), 2 (3 `--deps-differ` rows, plus 5 extra), 3 (8 `--decide` rows, plus 7 extra) |
| Deliberately out of scope | 6 Step 6 (files the direct-push follow-up) |

**Type consistency.** `derive_paths`, `package_dir`, `deps_differ`, `as_lines`, `touches_source`, `has_batch_label`, and `decide` are each defined once in Tasks 1–3 and called by those names in Task 4. `BATCH_LABEL` is defined in Task 3 and read in Task 4's `pass:deferred` and `fail:no-bump` messages. `REPO_ROOT_DEFAULT` is defined in Task 1 and read in Task 4. The five verdict tokens are identical in Task 3's implementation, Task 3's tests, and Task 4's `case`.

**One deliberate redundancy.** Task 4 recomputes which files matched, for the message, rather than having `decide` return them. `decide` stays a pure function answering one question, and the alternative — a second output line, or a token carrying a payload — would make every test in Task 3 assert on formatting instead of on the decision.

**Known gap.** Task 4's gatherer has no automated test; it is verified by hand in Task 4 Steps 3–4 and on a real pull request in Task 6. That matches where `deployable.sh` draws the line, and the untested part is composition plus two calls that need a network and a git history.
