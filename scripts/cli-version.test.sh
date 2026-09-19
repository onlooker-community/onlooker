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
make_tree "${work}/missing-pkg" '{"@onlooker-community/lesson-contract":"workspace:*"}'
expect_paths "apps/cli/src" 1 \
	"a workspace dependency with no matching package" "${work}/missing-pkg"

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

echo "cli-version.sh: --deps-differ failing closed"

# The gatherer this feeds calls --deps-differ inside an `if`, which bash
# exempts from set -e - so a raw jq failure leaking through as an ordinary
# nonzero exit would read as "1 = unchanged" and let an unreleased dependency
# change pass silently. Exit 2 is what tells the gatherer to block instead.
deps_valid="${work}/deps-valid.json"
printf '{"version":"2.6.0","dependencies":{"zod":"4.4.3"}}\n' >"${deps_valid}"

deps_malformed="${work}/deps-malformed.json"
printf '{not valid json\n' >"${deps_malformed}"

expect_exit 2 "old manifest does not exist" \
	--deps-differ "${work}/deps-missing.json" "${deps_valid}"

expect_exit 2 "new manifest is not valid JSON" \
	--deps-differ "${deps_valid}" "${deps_malformed}"

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

echo
if ((failures > 0)); then
	echo "cli-version.test.sh: ${failures} of ${tests} tests failed"
	exit 1
fi
echo "cli-version.test.sh: all ${tests} tests passed"
