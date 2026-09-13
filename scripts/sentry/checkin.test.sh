#!/usr/bin/env bash
# Offline tests for scripts/sentry/checkin.sh. These make no successful network
# request - the one test that reaches out points at a host that cannot resolve.
#
# The property under test is the awkward one: this script must NEVER fail its
# caller. It runs inside heartbeat.yml, whose failure is this project's entire
# production alarm, and inside client-error-monitor.yml, whose failure is the
# client error alarm. If a check-in could fail the job, then Sentry having a bad
# afternoon would look exactly like production being down - and the fix for that
# false alarm would be to delete the monitoring.
#
# So every path here exits 0, and these tests exist to keep it that way through
# whatever gets added later.
set -uo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly CHECKIN="${SCRIPT_DIR}/checkin.sh"

tests=0
failures=0

pass() {
	tests=$((tests + 1))
	echo "  ok    $1"
}

fail() {
	tests=$((tests + 1))
	failures=$((failures + 1))
	echo "  FAIL  $1 -> $2"
}

# exits_zero <description> <env-assignments-or-empty> <args...>
exits_zero() {
	local description="$1"
	shift
	local actual=0
	"$@" >/dev/null 2>&1 || actual=$?
	if [[ "${actual}" == "0" ]]; then
		pass "${description}"
	else
		fail "${description}" "exit ${actual}, expected 0"
	fi
}

echo
echo "sentry/checkin: it cannot fail the job it reports on"

exits_zero "survives a slug it was not given" bash "${CHECKIN}" "" in_progress
exits_zero "survives a status it does not know" bash "${CHECKIN}" some-monitor sideways
exits_zero "survives no arguments at all" bash "${CHECKIN}"
exits_zero "survives a Sentry it cannot reach" \
	env SENTRY_INGEST_HOST=does-not-resolve.invalid bash "${CHECKIN}" some-monitor ok

echo
echo "sentry/checkin: the URL shape"

# Established against the live endpoint on 2026-09-13, and it is the opposite
# of what the path reads like. The key is a PATH segment and the status is a
# query parameter. Swap them - status in the path, key as ?sentry_key= - and
# the endpoint parses the status positionally as the key and answers
# "multiple authorization payloads detected", which sounds like a credentials
# problem and sends you looking in the wrong place entirely.
url_line="$(grep -n 'readonly URL=' "${CHECKIN}" | head -n1)"

if [[ "${url_line}" == *'/cron/${SLUG}/${SENTRY_KEY}/?status=${STATUS}'* ]]; then
	pass "sends the key in the path and the status as a query parameter"
else
	fail "sends the key in the path and the status as a query parameter" "${url_line}"
fi

if [[ "${url_line}" != *'sentry_key='* ]]; then
	pass "does not also send ?sentry_key=, which would be a second auth payload"
else
	fail "does not also send ?sentry_key=" "found sentry_key in the URL"
fi

echo
if ((failures > 0)); then
	echo "checkin.test.sh: ${failures} of ${tests} tests failed"
	exit 1
fi
echo "checkin.test.sh: all ${tests} tests passed"
