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

# expect_exit <expected-code> <description> <env-assignments...>
expect_exit() {
	local expected="$1" description="$2"
	shift 2

	tests=$((tests + 1))

	local actual=0
	env "$@" HEARTBEAT_PREFLIGHT_ONLY=1 "${HEARTBEAT}" production >/dev/null 2>&1 || actual=$?

	if [[ "${actual}" == "${expected}" ]]; then
		echo "  ok    ${description}"
	else
		echo "  FAIL  ${description} -> exit ${actual} (expected ${expected})"
		failures=$((failures + 1))
	fi
}

echo "heartbeat.sh: credential preflight"

expect_exit 2 "required but no credentials -> exit 2" \
	HEARTBEAT_REQUIRE_AUTH=1 HEARTBEAT_EMAIL= HEARTBEAT_PASSWORD=

expect_exit 2 "required but password only -> exit 2" \
	HEARTBEAT_REQUIRE_AUTH=1 HEARTBEAT_EMAIL= HEARTBEAT_PASSWORD=secret

expect_exit 2 "required but email only -> exit 2" \
	HEARTBEAT_REQUIRE_AUTH=1 HEARTBEAT_EMAIL=a@b.test HEARTBEAT_PASSWORD=

expect_exit 0 "not required and no credentials -> skip, exit 0" \
	HEARTBEAT_EMAIL= HEARTBEAT_PASSWORD=

expect_exit 0 "required and both present -> exit 0" \
	HEARTBEAT_REQUIRE_AUTH=1 HEARTBEAT_EMAIL=a@b.test HEARTBEAT_PASSWORD=secret

if (( failures > 0 )); then
	echo "heartbeat.sh: ${failures} of ${tests} tests failed"
	exit 1
fi

echo "heartbeat.sh: all ${tests} tests passed"
