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

echo
if ((failures > 0)); then
	echo "cli-version.test.sh: ${failures} of ${tests} tests failed"
	exit 1
fi
echo "cli-version.test.sh: all ${tests} tests passed"
