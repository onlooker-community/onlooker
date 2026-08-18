#!/usr/bin/env bash
# Offline tests for scripts/heartbeat.sh credential handling.
#
# These make no network requests. They exist because the authenticated checks
# skip when credentials are absent, and a skip is how a check rots into a no-op
# that passes forever. The guard that prevents that is worth pinning.
set -uo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HEARTBEAT="${SCRIPT_DIR}/heartbeat.sh"

tests=0
failures=0

# expect_preflight <expected-exit> <expected-branch> <description> <env-assignments...>
#
# Asserts BOTH the exit code and which branch the preflight took. The exit code
# alone cannot tell "run" from "skip" - they both exit 0 - so a bug that made
# the preflight skip forever would pass an exit-code-only suite while quietly
# disabling every authenticated check. That is the exact failure this guard
# exists to prevent, so the test has to be able to see it.
#
# <expected-branch> is `run`, `skip`, or empty for the exit-2 cases, which
# terminate before printing anything to stdout.
expect_preflight() {
	local expected_exit="$1" expected_branch="$2" description="$3"
	shift 3

	tests=$((tests + 1))

	local output="" actual=0
	output="$(env "$@" HEARTBEAT_PREFLIGHT_ONLY=1 "${HEARTBEAT}" production 2>/dev/null)" || actual=$?

	local branch=""
	case "${output}" in
		*"preflight: run"*) branch="run" ;;
		*"preflight: skip"*) branch="skip" ;;
	esac

	if [[ "${actual}" == "${expected_exit}" && "${branch}" == "${expected_branch}" ]]; then
		echo "  ok    ${description}"
	else
		echo "  FAIL  ${description} -> exit ${actual}, branch '${branch}' (expected exit ${expected_exit}, branch '${expected_branch}')"
		failures=$((failures + 1))
	fi
}

echo "heartbeat.sh: credential preflight"

expect_preflight 2 "" "required but no credentials -> exit 2" \
	HEARTBEAT_REQUIRE_AUTH=1 HEARTBEAT_EMAIL= HEARTBEAT_PASSWORD=

expect_preflight 2 "" "required but password only -> exit 2" \
	HEARTBEAT_REQUIRE_AUTH=1 HEARTBEAT_EMAIL= HEARTBEAT_PASSWORD=secret

expect_preflight 2 "" "required but email only -> exit 2" \
	HEARTBEAT_REQUIRE_AUTH=1 HEARTBEAT_EMAIL=a@b.test HEARTBEAT_PASSWORD=

expect_preflight 0 "skip" "not required and no credentials -> skips" \
	HEARTBEAT_REQUIRE_AUTH= HEARTBEAT_EMAIL= HEARTBEAT_PASSWORD=

expect_preflight 0 "run" "required and both present -> runs" \
	HEARTBEAT_REQUIRE_AUTH=1 HEARTBEAT_EMAIL=a@b.test HEARTBEAT_PASSWORD=secret

if (( failures > 0 )); then
	echo "heartbeat.sh: ${failures} of ${tests} tests failed"
	exit 1
fi

echo "heartbeat.sh: all ${tests} tests passed"
