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
expect_exit 2 "an environment that does not exist" "preprod" "apps"
expect_exit 2 "no surface named" "production"
expect_exit 2 "a surface that does not exist" "production" "everything"
expect_exit 2 "--match with no surface" "--match"
expect_exit 2 "--match with a surface that does not exist" "--match" "everything"

echo
if ((failures > 0)); then
	echo "deployable.test.sh: ${failures} of ${tests} tests failed"
	exit 1
fi
echo "deployable.test.sh: all ${tests} tests passed"
