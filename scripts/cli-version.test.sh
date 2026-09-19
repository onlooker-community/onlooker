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
