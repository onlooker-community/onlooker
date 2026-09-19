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
# packages/lesson-contract. Naming a dependency in `deps` without a matching
# name:dir pair is how a test builds a workspace dependency with no package.
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

# expect_paths <expected-stdout> <expected-exit> <description> <tree-dir>
#
# Asserts both the stdout and the exit status. The exit status is not
# redundant with the output: a workspace dependency with no matching package
# fails after derive_paths has already printed apps/cli/src, so stdout alone
# cannot tell that real failure from a real success that happened to share the
# same prefix. And on the other error path, empty stdout is also what a
# missing or broken script produces - see deployable.sh's expect_sha, which
# asserts the same pair for the same reason.
expect_paths() {
	local expected="$1" expected_exit="$2" description="$3" dir="$4"

	tests=$((tests + 1))

	local actual="" actual_exit=0
	actual="$("${CLI_VERSION}" --paths "${dir}" 2>/dev/null)" || actual_exit=$?

	if [[ "${actual}" == "${expected}" && "${actual_exit}" == "${expected_exit}" ]]; then
		echo "  ok    ${description}"
	else
		echo "  FAIL  ${description} -> '${actual}' exit ${actual_exit}" \
			"(expected '${expected}' exit ${expected_exit})"
		failures=$((failures + 1))
	fi
}

# expect_manifests <expected-newline-list> <expected-exit> <description> <dir>
#
# Asserts which manifests the gate compares across the range. Same output-plus-
# exit pair as expect_paths, for the same reason.
expect_manifests() {
	local expected="$1" expected_exit="$2" description="$3" dir="$4"

	tests=$((tests + 1))

	local actual="" actual_exit=0
	actual="$("${CLI_VERSION}" --manifests "${dir}" 2>/dev/null)" || actual_exit=$?

	if [[ "${actual}" == "${expected}" && "${actual_exit}" == "${expected_exit}" ]]; then
		echo "  ok    ${description}"
	else
		echo "  FAIL  ${description} -> '${actual}' exit ${actual_exit}" \
			"(expected '${expected}' exit ${expected_exit})"
		failures=$((failures + 1))
	fi
}

# expect_manifest <expected-exit> <description> <old-json> <new-json>
#
# The exit code is the whole answer here, so it is what gets asserted. 0 means
# something that reaches the binary moved, 1 means nothing did.
expect_manifest() {
	local expected="$1" description="$2" old_json="$3" new_json="$4"

	tests=$((tests + 1))

	local old_file="${work}/manifest-old.json" new_file="${work}/manifest-new.json"
	printf '%s\n' "${old_json}" >"${old_file}"
	printf '%s\n' "${new_json}" >"${new_file}"

	local actual=0
	"${CLI_VERSION}" --manifest-differs "${old_file}" "${new_file}" >/dev/null 2>&1 || actual=$?

	if [[ "${actual}" == "${expected}" ]]; then
		echo "  ok    ${description}"
	else
		echo "  FAIL  ${description} -> exit ${actual} (expected ${expected})"
		failures=$((failures + 1))
	fi
}

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

# make_repo <dir> <old-manifest-json> <new-manifest-json> <changed-path...>
#
# Builds a throwaway git repository with two commits - a base carrying the old
# manifest, a head carrying the new one plus the named changed paths - and
# prints the base sha for BASE_REF. Real commits rather than a stub of git,
# because the gatherer's whole job is asking git questions and a stub would
# answer them the way the test already believes.
# Every git command make_repo runs goes through this rather than plain git, so
# the throwaway repo's isolation is a property of the test and not of whatever
# config happens to sit on the machine running it - the same argument
# expect_run already makes below for clearing PR_NUMBER and GH_TOKEN. This is
# not hypothetical: this exact hazard already fired on this branch. The
# throwaway identity below escaped into the real repository's local
# .git/config and authored four commits before it was caught and reverted.
# GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM keep every setting on this machine
# out of the throwaway repo entirely, rather than trusting each git config
# call below to override the ambient config one key at a time - a global
# commit.gpgsign or core.hooksPath would break this suite on another machine
# today, and a global core.excludesFile could silently drop the filler files
# below.
git_throwaway() {
	GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
		git -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"
}

make_repo() {
	local dir="$1" old_json="$2" new_json="$3"
	shift 3

	mkdir -p "${dir}/apps/cli/src" "${dir}/packages/lesson-contract/src"
	git_throwaway -C "${dir}" init -q
	git_throwaway -C "${dir}" config user.email "test@example.invalid"
	git_throwaway -C "${dir}" config user.name "cli-version tests"

	printf '{"name":"@onlooker-community/lesson-contract","version":"2.0.1"}\n' \
		>"${dir}/packages/lesson-contract/package.json"
	printf '%s\n' "${old_json}" >"${dir}/apps/cli/package.json"
	echo "base" >"${dir}/apps/cli/src/main.ts"
	git_throwaway -C "${dir}" add -A
	git_throwaway -C "${dir}" commit -qm base

	printf '%s\n' "${new_json}" >"${dir}/apps/cli/package.json"

	local path
	for path in "$@"; do
		mkdir -p "${dir}/$(dirname "${path}")"
		echo "changed" >>"${dir}/${path}"
	done

	git_throwaway -C "${dir}" add -A
	# --allow-empty so a case where nothing moved at all still produces a head
	# commit to diff against rather than failing the harness.
	git_throwaway -C "${dir}" commit -q --allow-empty -m head

	git_throwaway -C "${dir}" rev-parse HEAD~1
}

# expect_run <expected-exit> <expected-substring> <description> <dir> <base>
#
# Drives the whole gatherer against a throwaway repository. PR_NUMBER is unset
# on purpose: with no pull request to ask about, the label read is skipped and
# these tests touch no network. Both the exit code and a distinctive phrase
# from the output are asserted - the exit code is what CI acts on, and the
# message is the only thing a person will read.
expect_run() {
	local expected_exit="$1" expected_text="$2" description="$3"
	local dir="$4" base="$5"

	tests=$((tests + 1))

	# PR_NUMBER and GH_TOKEN are cleared explicitly rather than left to
	# whatever the environment happens to be. Without this, "no network" is a
	# property of the shell that ran the suite rather than of the suite
	# itself - a PR_NUMBER exported by a caller (a real one from the same
	# pull request this gate runs in, say) would send this to `gh`, and a
	# real `cli-batch` label on it would flip run-nobump from a failure to a
	# pass while the suite still reported green.
	local output="" status=0
	output="$(PR_NUMBER= GH_TOKEN= CLI_VERSION_ROOT="${dir}" BASE_REF="${base}" "${CLI_VERSION}" 2>&1)" || status=$?

	if [[ "${status}" == "${expected_exit}" && "${output}" == *"${expected_text}"* ]]; then
		echo "  ok    ${description}"
	else
		echo "  FAIL  ${description} -> exit ${status}, expected ${expected_exit} and '${expected_text}'"
		printf '        %s\n' "${output}"
		failures=$((failures + 1))
	fi
}

# The path set the real repository derives today. Written once so every verdict
# case below reads as the question it is asking rather than as plumbing.
readonly PATHS="apps/cli/src,packages/lesson-contract/src"

# expect_exit <expected-exit> <description> <arg...>
#
# For cases expect_deps can't express: it always writes two well-formed JSON
# files, and these need a path that has no file behind it at all, or one that
# is not JSON. Args are passed straight through to the script, same shape as
# deployable.test.sh's helper of the same name.
expect_exit() {
	local expected="$1" description="$2"
	shift 2

	tests=$((tests + 1))

	local actual=0
	"${CLI_VERSION}" "$@" >/dev/null 2>&1 || actual=$?

	if [[ "${actual}" == "${expected}" ]]; then
		echo "  ok    ${description}"
	else
		echo "  FAIL  ${description} -> exit ${actual} (expected ${expected})"
		failures=$((failures + 1))
	fi
}

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

echo "cli-version.sh: which paths end up in the binary"

make_tree "${work}/one" '{"@onlooker-community/lesson-contract":"workspace:*"}' \
	"@onlooker-community/lesson-contract:lesson-contract"
expect_paths "apps/cli/src
packages/lesson-contract/src" 0 \
	"the CLI's own source and its one workspace dependency" "${work}/one"

# The gate has to widen on its own when somebody adds a workspace dependency to
# the CLI. Hardcoding today's answer is how this hole reopens quietly.
make_tree "${work}/two" \
	'{"@onlooker-community/lesson-contract":"workspace:*","@onlooker/logger":"workspace:*"}' \
	"@onlooker-community/lesson-contract:lesson-contract" "@onlooker/logger:logger"
expect_paths "apps/cli/src
packages/lesson-contract/src
packages/logger/src" 0 \
	"a second workspace dependency widens it" "${work}/two"

# A registry dependency is bundled too, but it is not a path in this repository
# and nothing here can diff it.
make_tree "${work}/registry" '{"zod":"4.4.3"}'
expect_paths "apps/cli/src" 0 "a registry dependency contributes no path" "${work}/registry"

make_tree "${work}/empty-deps" '{}'
expect_paths "apps/cli/src" 0 "an empty dependencies object" "${work}/empty-deps"

# Distinct from the empty-object case above. jq's `//` fallback in derive_paths
# only fires when the left side is null, and {} is not null - only a manifest
# missing the key entirely reaches `.dependencies // {}`'s right-hand side.
mkdir -p "${work}/no-deps-key/apps/cli"
printf '{"name":"@onlooker/cli","version":"2.6.0"}\n' \
	>"${work}/no-deps-key/apps/cli/package.json"
expect_paths "apps/cli/src" 0 "no dependencies key in the manifest at all" "${work}/no-deps-key"

echo "cli-version.sh: failing closed"

mkdir -p "${work}/no-manifest"
expect_paths "" 1 "no apps/cli manifest at all" "${work}/no-manifest"

# A workspace dependency the CLI manifest names but that has no package built
# for it - make_tree with no name:dir pair for the one dependency it declares.
#
# Nothing is printed before the failure. The earlier shape emitted
# apps/cli/src and then failed partway through the loop, so a caller reading
# stdout without checking the exit status saw a short but plausible answer.
make_tree "${work}/missing-pkg" '{"@onlooker-community/lesson-contract":"workspace:*"}'
expect_paths "" 1 \
	"a workspace dependency with no matching package" "${work}/missing-pkg"

echo "cli-version.sh: which manifests reach the binary"

# The hole onlooker-dnkx names. Watching packages/<dir>/src but not
# packages/<dir>/package.json means a zod bump inside the bundled contract
# recompiles a different binary that the gate never looks at - and zod is the
# runtime behind ZLesson, which is the whole reason the contract is watched.
expect_manifests "apps/cli/package.json
packages/lesson-contract/package.json" 0 \
	"the CLI manifest and its one workspace dependency" "${work}/one"

expect_manifests "apps/cli/package.json
packages/lesson-contract/package.json
packages/logger/package.json" 0 \
	"a second workspace dependency widens it" "${work}/two"

expect_manifests "apps/cli/package.json" 0 \
	"a registry dependency contributes no manifest" "${work}/registry"

expect_manifests "apps/cli/package.json" 0 \
	"no dependencies at all" "${work}/empty-deps"

expect_manifests "" 1 "no apps/cli manifest at all" "${work}/no-manifest"

expect_manifests "" 1 \
	"a workspace dependency with no matching package" "${work}/missing-pkg"

echo "cli-version.sh: what counts as a manifest change that reaches the binary"

expect_manifest 0 "a dependency version moved" \
	'{"version":"2.6.0","dependencies":{"zod":"4.4.3"}}' \
	'{"version":"2.6.0","dependencies":{"zod":"4.5.0"}}'

expect_manifest 0 "a dependency was added" \
	'{"version":"2.6.0","dependencies":{"zod":"4.4.3"}}' \
	'{"version":"2.6.0","dependencies":{"zod":"4.4.3","@onlooker/logger":"workspace:*"}}'

expect_manifest 0 "a dependency was removed" \
	'{"version":"2.6.0","dependencies":{"zod":"4.4.3"}}' \
	'{"version":"2.6.0","dependencies":{}}'

# scripts.build IS the esbuild invocation that produces dist/onlooker.mjs, so
# --target, --format, --minify and the shebang banner each change the artifact.
# This read as "unchanged" until onlooker-dnkx, on the stated grounds that
# scripts does not affect the binary. It does.
expect_manifest 0 "the build script changed" \
	'{"version":"2.6.0","scripts":{"build":"esbuild --target=node20"}}' \
	'{"version":"2.6.0","scripts":{"build":"esbuild --target=node22"}}'

# esbuild is the bundler. A different bundler emits a different bundle.
expect_manifest 0 "the bundler version moved" \
	'{"version":"2.6.0","devDependencies":{"esbuild":"0.28.1"}}' \
	'{"version":"2.6.0","devDependencies":{"esbuild":"0.29.0"}}'

# bin is what `onlooker` resolves to once installed.
expect_manifest 0 "the bin mapping changed" \
	'{"version":"2.6.0","bin":{"onlooker":"./dist/onlooker.mjs"}}' \
	'{"version":"2.6.0","bin":{"onlooker":"./dist/cli.mjs"}}'

# The whole argument for comparing everything-but-version rather than a list of
# fields that matter: a field nobody has thought about yet is watched by
# default. Under an enumeration it would be a fresh blind spot, which is
# precisely how onlooker-dnkx came to exist.
expect_manifest 0 "a field the gate has never heard of appeared" \
	'{"version":"2.6.0","dependencies":{"zod":"4.4.3"}}' \
	'{"version":"2.6.0","dependencies":{"zod":"4.4.3"},"imports":{"#x":"./x.js"}}'

# The one field that provably cannot change the artifact, because it IS the
# release. If a bump counted, every release-only pull request would read as a
# source change - passing, but for the wrong reason.
expect_manifest 1 "only the version moved" \
	'{"version":"2.6.0","dependencies":{"zod":"4.4.3"}}' \
	'{"version":"2.7.0","dependencies":{"zod":"4.4.3"}}'

# Key order is a formatting accident, not a change. Without -S this reports a
# change every time a formatter reorders a block.
expect_manifest 1 "the same content in a different key order" \
	'{"dependencies":{"zod":"4.4.3","@onlooker/logger":"workspace:*"}}' \
	'{"dependencies":{"@onlooker/logger":"workspace:*","zod":"4.4.3"}}'

expect_manifest 1 "two manifests that differ in nothing but the version" \
	'{"version":"2.6.0"}' '{"version":"2.7.0"}'

echo "cli-version.sh: --manifest-differs failing closed"

# The gatherer this feeds captures the status rather than testing it in an `if`,
# because bash exempts an `if` condition from set -e - so a raw jq failure
# leaking through as an ordinary nonzero exit would read as "1 = unchanged" and
# let an unreleased change pass silently. Exit 2 is what tells it to block.
deps_valid="${work}/manifest-valid.json"
printf '{"version":"2.6.0","dependencies":{"zod":"4.4.3"}}\n' >"${deps_valid}"

deps_malformed="${work}/manifest-malformed.json"
printf '{not valid json\n' >"${deps_malformed}"

expect_exit 2 "old manifest does not exist" \
	--manifest-differs "${work}/manifest-missing.json" "${deps_valid}"

expect_exit 2 "new manifest is not valid JSON" \
	--manifest-differs "${deps_valid}" "${deps_malformed}"

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

echo "cli-version.sh: the whole run, against a throwaway repository"

readonly BUMPED='{"name":"@onlooker/cli","version":"2.7.0","dependencies":{"@onlooker-community/lesson-contract":"workspace:*"}}'
readonly SAME='{"name":"@onlooker/cli","version":"2.6.0","dependencies":{"@onlooker-community/lesson-contract":"workspace:*"}}'

base="$(make_repo "${work}/run-nobump" "${SAME}" "${SAME}" "apps/cli/src/sessions.ts")"
expect_run 1 "CLI source changed without a release" \
	"CLI source changed and the version did not" "${work}/run-nobump" "${base}"

# The annotation has to name the file, or the person reading it has to go
# looking for what tripped the gate.
expect_run 1 "apps/cli/src/sessions.ts" \
	"the failure names the file that tripped it" "${work}/run-nobump" "${base}"

base="$(make_repo "${work}/run-bumped" "${SAME}" "${BUMPED}" "apps/cli/src/sessions.ts")"
expect_run 0 "2.6.0 -> 2.7.0" \
	"CLI source changed and the version moved" "${work}/run-bumped" "${base}"

base="$(make_repo "${work}/run-clean" "${SAME}" "${SAME}" "README.md")"
expect_run 0 "nothing in this pull request reaches the CLI binary" \
	"nothing relevant changed" "${work}/run-clean" "${base}"

# The case a gate scoped to apps/cli/src would miss, driven end to end.
base="$(make_repo "${work}/run-contract" "${SAME}" "${SAME}" \
	"packages/lesson-contract/src/lesson.ts")"
expect_run 1 "packages/lesson-contract/src/lesson.ts" \
	"the bundled contract changed and the version did not" "${work}/run-contract" "${base}"

base="$(make_repo "${work}/run-deps" "${SAME}" \
	'{"name":"@onlooker/cli","version":"2.6.0","dependencies":{"@onlooker-community/lesson-contract":"workspace:*","zod":"4.4.3"}}')"
expect_run 1 "moved in something other than its version" \
	"a dependency moved and the version did not" "${work}/run-deps" "${base}"

# A devDependency now counts, where it used to be waved through. The gate
# cannot tell vitest from esbuild without a list of which names matter, and
# esbuild IS the bundler - so everything but the version counts, and the
# release-only pull request stays the case that passes. See onlooker-dnkx.
base="$(make_repo "${work}/run-devdeps" "${SAME}" \
	'{"name":"@onlooker/cli","version":"2.6.0","dependencies":{"@onlooker-community/lesson-contract":"workspace:*"},"devDependencies":{"vitest":"4.2.0"}}')"
expect_run 1 "moved in something other than its version" \
	"a devDependency moved and the version did not" "${work}/run-devdeps" "${base}"

base="$(make_repo "${work}/run-backward" "${SAME}" \
	'{"name":"@onlooker/cli","version":"2.5.0","dependencies":{"@onlooker-community/lesson-contract":"workspace:*"}}' \
	"apps/cli/src/sessions.ts")"
expect_run 1 "CLI version moved backward" \
	"the version moved backward" "${work}/run-backward" "${base}"

# A changed-file list larger than a pipe buffer must not kill the run.
# touches_source returns on its first match without draining the rest of
# stdin, so `printf | decide` used to take EPIPE once the list grew past the
# buffer, and pipefail + set -e turned that into a silent exit 1 with no
# annotation - on a pull request that should have passed. 9000 filler paths
# plus the one that matters reliably exceeds the buffer on every platform
# this runs on.
large_paths=("apps/cli/src/sessions.ts")
i=0
while ((i < 9000)); do
	large_paths+=("docs/filler-${i}.md")
	i=$((i + 1))
done
base="$(make_repo "${work}/run-large" "${SAME}" "${BUMPED}" "${large_paths[@]}")"
expect_run 0 "2.6.0 -> 2.7.0" \
	"a changed-file list past the pipe buffer still resolves" "${work}/run-large" "${base}"

# Fails closed. A gate that cannot work out what to compare against must block
# rather than wave the pull request through.
tests=$((tests + 1))
status=0
output="$(CLI_VERSION_ROOT="${work}/run-clean" "${CLI_VERSION}" 2>&1)" || status=$?
if [[ "${status}" == 1 && "${output}" == *"BASE_REF is not set"* ]]; then
	echo "  ok    a missing BASE_REF blocks rather than passes"
else
	echo "  FAIL  a missing BASE_REF blocks rather than passes -> exit ${status}"
	printf '        %s\n' "${output}"
	failures=$((failures + 1))
fi

# derive_paths' own failure used to reach no further than the step log - see
# the ::error added for it. A repo with no apps/cli manifest at all exercises
# the same path F6 says a future apps/* workspace dependency will take.
mkdir -p "${work}/run-no-manifest"
git_throwaway -C "${work}/run-no-manifest" init -q
git_throwaway -C "${work}/run-no-manifest" config user.email "test@example.invalid"
git_throwaway -C "${work}/run-no-manifest" config user.name "cli-version tests"
echo "hello" >"${work}/run-no-manifest/README.md"
git_throwaway -C "${work}/run-no-manifest" add -A
git_throwaway -C "${work}/run-no-manifest" commit -qm base
no_manifest_base="$(git_throwaway -C "${work}/run-no-manifest" rev-parse HEAD)"

expect_run 1 "::error title=CLI release gate cannot derive its source paths" \
	"a missing apps/cli manifest blocks with an annotation, not just a log line" \
	"${work}/run-no-manifest" "${no_manifest_base}"

# The hole onlooker-dnkx names, driven end to end. apps/cli/package.json never
# moves, apps/cli/src never moves, and the only change in the range is a
# dependency inside the bundled contract. zod is the runtime behind ZLesson, so
# this recompiles a different dist/onlooker.mjs - and until now the gate
# answered pass:no-cli-change, because it compared the CLI manifest and nothing
# else.
contract_deps="${work}/run-contract-deps"
mkdir -p "${contract_deps}/apps/cli/src" "${contract_deps}/packages/lesson-contract/src"
git_throwaway -C "${contract_deps}" init -q
git_throwaway -C "${contract_deps}" config user.email "test@example.invalid"
git_throwaway -C "${contract_deps}" config user.name "cli-version tests"
printf '%s\n' "${SAME}" >"${contract_deps}/apps/cli/package.json"
printf '{"name":"@onlooker-community/lesson-contract","version":"2.0.1","dependencies":{"zod":"4.4.3"}}\n' \
	>"${contract_deps}/packages/lesson-contract/package.json"
echo "base" >"${contract_deps}/apps/cli/src/main.ts"
git_throwaway -C "${contract_deps}" add -A
git_throwaway -C "${contract_deps}" commit -qm base
contract_deps_base="$(git_throwaway -C "${contract_deps}" rev-parse HEAD)"

printf '{"name":"@onlooker-community/lesson-contract","version":"2.0.1","dependencies":{"zod":"4.5.0"}}\n' \
	>"${contract_deps}/packages/lesson-contract/package.json"
git_throwaway -C "${contract_deps}" add -A
git_throwaway -C "${contract_deps}" commit -qm head

expect_run 1 "CLI source changed without a release" \
	"a dependency bump inside the bundled contract blocks" \
	"${contract_deps}" "${contract_deps_base}"

expect_run 1 "packages/lesson-contract/package.json" \
	"the failure names the contract manifest that moved" \
	"${contract_deps}" "${contract_deps_base}"

# git's core.quotePath defaults to true, which renders this path as the literal
# "apps/cli/src/caf\303\251.ts" - surrounding double quotes included - and the
# leading quote defeats the anchored prefix match, so the file reads as
# untouched. Without the flag on the diff, this case answers pass:no-cli-change
# and an unreleased change ships because somebody named a file in their own
# language.
base="$(make_repo "${work}/run-nonascii" "${SAME}" "${SAME}" "apps/cli/src/café.ts")"
expect_run 1 "CLI source changed without a release" \
	"a non-ASCII filename is still seen" "${work}/run-nonascii" "${base}"

echo
if ((failures > 0)); then
	echo "cli-version.test.sh: ${failures} of ${tests} tests failed"
	exit 1
fi
echo "cli-version.test.sh: all ${tests} tests passed"
