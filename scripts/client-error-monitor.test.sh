#!/usr/bin/env bash
# Offline tests for scripts/client-error-monitor.sh.
#
# These make no network requests. Most of them pin the shape of the query body,
# which sounds like testing a string literal until you know how this endpoint
# fails: an unknown filter key does not error. Cloudflare answers success:true,
# errors:[], zero events - identical in every observable way to a correct query
# over a window where nothing went wrong.
#
# So the difference between a monitor that works and one that is green forever
# is a key name, and nothing at runtime can tell you which one you shipped. That
# is what these assertions are for. The key was established by experiment on
# 2026-08-21 (see onlooker-kuk): a synthetic report was sent to staging and
# queried back, and only `event` matched it.
set -uo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly MONITOR="${SCRIPT_DIR}/client-error-monitor.sh"

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

# expect_preflight <expected-exit> <expected-branch> <description> <env-assignments...>
#
# Asserts BOTH the exit code and which branch the preflight took, for the same
# reason heartbeat.test.sh does: a skip and a success both exit 0, so an
# exit-code-only assertion cannot see a monitor that has quietly stopped
# checking anything.
expect_preflight() {
	local expected_exit="$1" expected_branch="$2" description="$3"
	shift 3

	local output="" actual=0
	output="$(env "$@" MONITOR_PREFLIGHT_ONLY=1 "${MONITOR}" all 2>/dev/null)" || actual=$?

	local branch=""
	case "${output}" in
		*"preflight: run"*) branch="run" ;;
	esac

	if [[ "${actual}" == "${expected_exit}" && "${branch}" == "${expected_branch}" ]]; then
		pass "${description}"
	else
		fail "${description}" "exit ${actual}, branch '${branch}' (expected exit ${expected_exit}, branch '${expected_branch}')"
	fi
}

# query <environment> [env-assignments...] - print the query body the script builds
query() {
	local environment="$1"
	shift
	env "$@" MONITOR_PRINT_QUERY=1 "${MONITOR}" "${environment}" 2>/dev/null
}

echo "client-error-monitor.sh: credential preflight"

expect_preflight 2 "" "no credentials -> exit 2"
expect_preflight 2 "" "token without account id -> exit 2" \
	CLOUDFLARE_API_TOKEN=t
expect_preflight 2 "" "account id without token -> exit 2" \
	CLOUDFLARE_ACCOUNT_ID=a
expect_preflight 0 "run" "both credentials -> run" \
	CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a

echo
echo "client-error-monitor.sh: argument handling"

for bad in "" "prod" "PRODUCTION" "onlooker-api-production"; do
	actual=0
	env CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a MONITOR_PREFLIGHT_ONLY=1 \
		"${MONITOR}" "${bad}" >/dev/null 2>&1 || actual=$?
	if [[ "${actual}" == "2" ]]; then
		pass "environment '${bad}' -> exit 2"
	else
		fail "environment '${bad}'" "exit ${actual} (expected 2)"
	fi
done

echo
echo "client-error-monitor.sh: the filter key"

# The assertion this whole file exists for. $metadata.message and source.event
# both return zero matches against a real client error report; only `event`
# finds it. Workers Logs parses the JSON string given to console.error into
# top-level keys, and promotes the report's own `message` property into
# $metadata.message - so the literal string 'client_error' is never in it.
body="$(query all CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a GITHUB_TOKEN=)"

discriminator="$(printf '%s' "${body}" |
	jq -r '.parameters.filters[] | select(.value == "client_error") | .key' 2>/dev/null || true)"
if [[ "${discriminator}" == "event" ]]; then
	pass "discriminator filters on 'event'"
else
	fail "discriminator filters on 'event'" "got '${discriminator}'"
fi

operation="$(printf '%s' "${body}" |
	jq -r '.parameters.filters[] | select(.value == "client_error") | .operation' 2>/dev/null || true)"
if [[ "${operation}" == "eq" ]]; then
	pass "discriminator uses 'eq'"
else
	fail "discriminator uses 'eq'" "got '${operation}'"
fi

# Guard against the two keys that look right and silently match nothing.
wrong="$(printf '%s' "${body}" |
	jq -r '[.parameters.filters[].key] | map(select(. == "source.event" or . == "$metadata.message")) | length' 2>/dev/null || true)"
if [[ "${wrong}" == "0" ]]; then
	pass "does not filter on source.event or \$metadata.message"
else
	fail "does not filter on source.event or \$metadata.message" "found ${wrong}"
fi

echo
echo "client-error-monitor.sh: query shape"

view="$(printf '%s' "${body}" | jq -r '.view' 2>/dev/null || true)"
if [[ "${view}" == "events" ]]; then
	pass "view is 'events'"
else
	fail "view is 'events'" "got '${view}'"
fi

dataset="$(printf '%s' "${body}" | jq -r '.parameters.datasets | join(",")' 2>/dev/null || true)"
if [[ "${dataset}" == "cloudflare-workers" ]]; then
	pass "queries the cloudflare-workers dataset"
else
	fail "queries the cloudflare-workers dataset" "got '${dataset}'"
fi

# Milliseconds, not seconds, and not ISO-8601. Cloudflare's own observability
# MCP client accepts ISO strings and converts before sending, so copying its
# input schema sends a value the API reads as 1970.
timeframe_ok="$(printf '%s' "${body}" |
	jq -r '(.timeframe.from | type) == "number" and (.timeframe.to | type) == "number" and .timeframe.from > 1000000000000' 2>/dev/null || true)"
if [[ "${timeframe_ok}" == "true" ]]; then
	pass "timeframe is epoch milliseconds"
else
	fail "timeframe is epoch milliseconds" "got $(printf '%s' "${body}" | jq -c '.timeframe' 2>/dev/null)"
fi

span="$(printf '%s' "${body}" |
	jq -r '(.timeframe.to - .timeframe.from) / 60000 | round' 2>/dev/null || true)"
if [[ "${span}" == "480" ]]; then
	pass "the window falls back to 480 minutes without run history"
else
	fail "the window falls back to 480 minutes without run history" "got ${span}"
fi

custom_span="$(query all CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a CLIENT_ERROR_LOOKBACK_MINUTES=45 |
	jq -r '(.timeframe.to - .timeframe.from) / 60000 | round' 2>/dev/null || true)"
if [[ "${custom_span}" == "45" ]]; then
	pass "lookback is configurable"
else
	fail "lookback is configurable" "got ${custom_span}"
fi

echo
echo "client-error-monitor.sh: lookback derivation"

# runs_fixture <minutes-ago> [conclusion]
#
# Prints what the GitHub runs API returns for one completed run that started
# the given number of minutes ago. jq does the date conversion because
# `date -d` is GNU-only and `date -j -f` is BSD-only, and this suite runs on
# both.
runs_fixture() {
	local minutes_ago="$1" conclusion="${2:-success}"
	local stamp
	stamp="$(jq -rn --argjson ago "$(( $(date +%s) - minutes_ago * 60 ))" '$ago | todateiso8601')"
	jq -n -c --arg created "${stamp}" --arg conclusion "${conclusion}" \
		'{workflow_runs: [{created_at: $created, conclusion: $conclusion}]}'
}

# lookback <description> <expected-minutes> [env-assignments...]
#
# GITHUB_TOKEN is blanked on every call so the suite can never reach the
# network, whatever the ambient environment holds.
lookback() {
	local description="$1" expected="$2"
	shift 2
	local actual
	actual="$(query all CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a GITHUB_TOKEN= "$@" |
		jq -r '(.timeframe.to - .timeframe.from) / 60000 | round' 2>/dev/null || true)"
	if [[ "${actual}" == "${expected}" ]]; then
		pass "${description}"
	else
		fail "${description}" "got ${actual}, expected ${expected}"
	fi
}

lookback "derives the window from the previous run" 125 \
	MONITOR_RUNS_RESPONSE="$(runs_fixture 120)"

# The bug this whole change exists to fix: on 2026-09-19 the gap between runs
# reached 327 minutes against a fixed 180-minute window.
lookback "a 327-minute gap is covered, not truncated" 332 \
	MONITOR_RUNS_RESPONSE="$(runs_fixture 327)"

# A workflow_dispatch seconds after a scheduled run must not query a
# 30-second window and miss the report it was dispatched to check.
lookback "a too-recent previous run is floored at 60" 60 \
	MONITOR_RUNS_RESPONSE="$(runs_fixture 1)"

lookback "an ancient previous run is capped at 1440" 1440 \
	MONITOR_RUNS_RESPONSE="$(runs_fixture 4320)"

# A failed run still queried - it failed because it found client errors.
# Skipping it would re-report the same errors until a clean run.
lookback "a failed previous run still counts" 125 \
	MONITOR_RUNS_RESPONSE="$(runs_fixture 120 failure)"

lookback "empty run history falls back to 480" 480 \
	MONITOR_RUNS_RESPONSE='{"workflow_runs":[]}'

lookback "an error response falls back to 480" 480 \
	MONITOR_RUNS_RESPONSE='{"message":"Bad credentials"}'

lookback "unparseable JSON falls back to 480" 480 \
	MONITOR_RUNS_RESPONSE='not json at all'

lookback "no credential falls back to 480" 480

lookback "an explicit override beats derivation" 45 \
	CLIENT_ERROR_LOOKBACK_MINUTES=45 MONITOR_RUNS_RESPONSE="$(runs_fixture 120)"

# A silent fallback is the failure mode this change exists to end, so the
# fallback announces itself.
fallback_stderr="$(env CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a GITHUB_TOKEN= \
	MONITOR_PRINT_QUERY=1 "${MONITOR}" all 2>&1 >/dev/null || true)"
if [[ "${fallback_stderr}" == *"falling back"* && "${fallback_stderr}" == *"480"* ]]; then
	pass "the fallback says so on stderr"
else
	fail "the fallback says so on stderr" "got '${fallback_stderr}'"
fi

echo
echo "client-error-monitor.sh: environment scoping"

prod_service="$(query production CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a |
	jq -r '.parameters.filters[] | select(.key == "$metadata.service") | .value' 2>/dev/null || true)"
if [[ "${prod_service}" == "onlooker-api-production" ]]; then
	pass "production scopes to onlooker-api-production"
else
	fail "production scopes to onlooker-api-production" "got '${prod_service}'"
fi

staging_service="$(query staging CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a |
	jq -r '.parameters.filters[] | select(.key == "$metadata.service") | .value' 2>/dev/null || true)"
if [[ "${staging_service}" == "onlooker-api-staging" ]]; then
	pass "staging scopes to onlooker-api-staging"
else
	fail "staging scopes to onlooker-api-staging" "got '${staging_service}'"
fi

all_filters="$(printf '%s' "${body}" | jq -r '.parameters.filters | length' 2>/dev/null || true)"
if [[ "${all_filters}" == "1" ]]; then
	pass "all applies no service filter"
else
	fail "all applies no service filter" "got ${all_filters} filters"
fi

echo
echo "client-error-monitor.sh: rendering a report"

# This path runs only when errors are found, so every green run leaves it
# unexercised. The first version shipped `.$metadata.service`, which is a jq
# syntax error rather than a field access - the monitor would have run clean
# for weeks and then died at the moment it finally had something to say.
readonly SAMPLE_EVENTS='[{"$metadata":{"service":"onlooker-api-production","level":"error"},"source":{"event":"client_error","kind":"render","message":"Cannot read properties of undefined","url":"https://app.onlooker.dev/dashboard"}}]'

render_exit=0
rendered="$(printf '%s' "${SAMPLE_EVENTS}" |
	env CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a MONITOR_RENDER_EVENTS=1 \
		"${MONITOR}" all 2>&1)" || render_exit=$?

if [[ "${render_exit}" == "0" ]]; then
	pass "renders without error"
else
	fail "renders without error" "exit ${render_exit}: ${rendered}"
fi

for expected in "onlooker-api-production" "render" "Cannot read properties of undefined" "https://app.onlooker.dev/dashboard"; do
	if [[ "${rendered}" == *"${expected}"* ]]; then
		pass "output includes '${expected}'"
	else
		fail "output includes '${expected}'" "not found in: ${rendered}"
	fi
done

# A report missing optional fields must still render rather than abort the run
# partway through the list, which would hide every report after it.
sparse_exit=0
sparse="$(printf '%s' '[{"$metadata":{},"source":{"event":"client_error"}}]' |
	env CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a MONITOR_RENDER_EVENTS=1 \
		"${MONITOR}" all 2>&1)" || sparse_exit=$?

if [[ "${sparse_exit}" == "0" && "${sparse}" == *"unknown service"* && "${sparse}" == *"(no message)"* ]]; then
	pass "a report with missing fields still renders"
else
	fail "a report with missing fields still renders" "exit ${sparse_exit}: ${sparse}"
fi

echo
if (( failures > 0 )); then
	echo "client-error-monitor.test.sh: ${failures} of ${tests} tests failed"
	exit 1
fi

echo "client-error-monitor.test.sh: all ${tests} tests passed"
