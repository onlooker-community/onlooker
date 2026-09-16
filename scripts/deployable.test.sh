#!/usr/bin/env bash
# Offline tests for scripts/deployable.sh.
#
# These make no network requests and touch no git history. Both halves of the
# script are exercised as themselves rather than through a stub: `--match`
# reads a file list on stdin, `--select-sha` reads the deployments payload on
# stdin, and the full run composes the two. Feeding real inputs to the real
# code is the only way these tests can fail for the reason they claim to.
#
# What they are protecting: the filter decides whether a merge reaches
# production at all, and its failure mode is silent. A wrong answer here is a
# green run that deployed nothing - see onlooker-txcu.7, where exactly that
# stranded a change on main for hours with two passing runs to show for it.
set -uo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DEPLOYABLE="${SCRIPT_DIR}/deployable.sh"

tests=0
failures=0

# expect_match <expected> <description> <path...>
#
# Asserts the answer the path matcher gives for a set of changed files. The
# paths are passed as arguments and fed in on stdin, because that is how the
# real run hands them over - `git diff --name-only` output, one per line.
expect_match() {
	local expected="$1" description="$2"
	shift 2

	tests=$((tests + 1))

	local actual=""
	actual="$(printf '%s\n' "$@" | "${DEPLOYABLE}" --match 2>/dev/null)"

	if [[ "${actual}" == "${expected}" ]]; then
		echo "  ok    ${description}"
	else
		echo "  FAIL  ${description} -> '${actual}' (expected '${expected}')"
		failures=$((failures + 1))
	fi
}

# expect_sha <expected> <description> <json>
#
# Asserts which commit the script treats as "last successfully deployed" for a
# given deployments payload. An empty expectation means it found none and the
# caller must fall back to deploying.
#
# The exit code is asserted alongside the output, and not for symmetry: "found
# nothing" prints nothing, and so does a script that is missing, unreadable or
# broken before it reaches the query. Without a distinct exit status the
# empty-expectation cases would pass against no script at all, which is how a
# test ends up guarding nothing. 0 means it found one, 1 means it looked and
# there was none.
expect_sha() {
	local expected="$1" description="$2" json="$3"

	tests=$((tests + 1))

	local expected_exit=0
	[[ -z "${expected}" ]] && expected_exit=1

	local actual="" actual_exit=0
	actual="$(printf '%s' "${json}" | "${DEPLOYABLE}" --select-sha 2>/dev/null)" ||
		actual_exit=$?

	if [[ "${actual}" == "${expected}" && "${actual_exit}" == "${expected_exit}" ]]; then
		echo "  ok    ${description}"
	else
		echo "  FAIL  ${description} -> '${actual}' exit ${actual_exit}" \
			"(expected '${expected}' exit ${expected_exit})"
		failures=$((failures + 1))
	fi
}

# expect_exit <expected-exit> <description> <arg...>
expect_exit() {
	local expected="$1" description="$2"
	shift 2

	tests=$((tests + 1))

	local actual=0
	"${DEPLOYABLE}" "$@" >/dev/null 2>&1 || actual=$?

	if [[ "${actual}" == "${expected}" ]]; then
		echo "  ok    ${description}"
	else
		echo "  FAIL  ${description} -> exit ${actual} (expected ${expected})"
		failures=$((failures + 1))
	fi
}

# Builds a deployments payload in the shape the GraphQL query returns.
# `nodes` is passed in whole so a test can express an empty list or a missing
# status, neither of which a per-field helper could produce.
payload() {
	printf '{"data":{"repository":{"deployments":{"nodes":[%s]}}}}' "$1"
}

node() {
	printf '{"commitOid":"%s","latestStatus":%s}' "$1" "$2"
}

status() {
	printf '{"state":"%s"}' "$1"
}

echo "deployable.sh: which paths are worth a deploy"

expect_match "true" "an api source file deploys" "apps/api/src/email/index.ts"
expect_match "true" "a web source file deploys" "apps/web/src/main.tsx"
expect_match "true" "a website source file deploys" "apps/website/src/index.astro"
expect_match "true" "a shared package deploys" "packages/api-contract/src/redact.ts"
expect_match "true" "the root manifest deploys" "package.json"
expect_match "true" "the lockfile deploys" "pnpm-lock.yaml"
expect_match "true" "the turbo config deploys" "turbo.json"
expect_match "true" "deploy.yml deploys itself" ".github/workflows/deploy.yml"

expect_match "false" "another workflow does not" ".github/workflows/heartbeat.yml"
expect_match "false" "documentation does not" "docs/superpowers/specs/whatever.md"
expect_match "false" "the issue export does not" ".beads/issues.jsonl"
expect_match "false" "a bare readme does not" "README.md"

# The pattern is anchored, and this is the test that proves it. An unanchored
# match would see "apps/api/" inside a documentation path and deploy the whole
# stack because somebody wrote about the API.
expect_match "false" "a doc that merely names a deployable path does not" \
	"docs/apps/api/overview.md"

expect_match "false" "nothing changed at all" ""
expect_match "true" "one deployable file among many that are not" \
	"README.md" "docs/notes.md" "apps/api/src/index.ts" ".beads/issues.jsonl"

echo "deployable.sh: which commit counts as last deployed"

expect_sha "aaaa1111" "the newest successful deployment" \
	"$(payload "$(node aaaa1111 "$(status SUCCESS)")")"

# The case this whole mode exists for. A deployment record is created when the
# job starts, so a failed deploy leaves a record naming a commit that never
# shipped. Anchoring there would treat unshipped work as already deployed and
# skip it forever - the same silent-skip bug in a new place.
expect_sha "bbbb2222" "skips a failed deployment for the success behind it" \
	"$(payload "$(node aaaa1111 "$(status FAILURE)"),$(node bbbb2222 "$(status SUCCESS)")")"

expect_sha "bbbb2222" "skips a deployment still in flight" \
	"$(payload "$(node aaaa1111 "$(status IN_PROGRESS)"),$(node bbbb2222 "$(status SUCCESS)")")"

expect_sha "bbbb2222" "skips one that was queued and never started" \
	"$(payload "$(node aaaa1111 null),$(node bbbb2222 "$(status SUCCESS)")")"

expect_sha "" "no deployments at all yields nothing" "$(payload "")"
expect_sha "" "nothing successful yields nothing" \
	"$(payload "$(node aaaa1111 "$(status FAILURE)"),$(node bbbb2222 "$(status ERROR)")")"

echo "deployable.sh: usage"

expect_exit 2 "no environment named"
expect_exit 2 "an environment that does not exist" "preprod"

echo
if ((failures > 0)); then
	echo "deployable.test.sh: ${failures} of ${tests} tests failed"
	exit 1
fi
echo "deployable.test.sh: all ${tests} tests passed"
