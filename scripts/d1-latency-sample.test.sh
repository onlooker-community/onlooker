#!/usr/bin/env bash
# Offline tests for scripts/d1-latency-sample.sh.
#
# These make no network requests. They pin two things.
#
# First, the query shape - which sounds like testing a string literal until you
# know how this endpoint fails. An unknown filter key returns success:true,
# errors:[], zero rows, indistinguishable from a correct query over a quiet
# window. Two separate wrong guesses have already been shipped against this API
# in this repository, so the shape gets pinned rather than trusted.
#
# Second, the arithmetic. A sampler whose percentiles are wrong is worse than no
# sampler: it answers the question confidently and sends you to tune a query
# that was never the problem. The fixtures below have hand-checked answers.
set -uo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SAMPLER="${SCRIPT_DIR}/d1-latency-sample.sh"

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

expect_contains() {
	local haystack="$1" needle="$2" description="$3"
	if [[ "${haystack}" == *"${needle}"* ]]; then
		pass "${description}"
	else
		fail "${description}" "'${needle}' not found in: ${haystack}"
	fi
}

# expect_preflight <expected-exit> <expected-branch> <description> <env...>
#
# Asserts BOTH the exit code and which branch preflight took: two different
# outcomes can share an exit code, and an exit-code-only assertion cannot see a
# sampler that has quietly stopped checking anything.
expect_preflight() {
	local expected_exit="$1" expected_branch="$2" description="$3"
	shift 3

	local output="" actual=0
	output="$(env "$@" SAMPLE_PREFLIGHT_ONLY=1 "${SAMPLER}" production 2>/dev/null)" || actual=$?

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

query() {
	local environment="$1"
	shift
	env "$@" SAMPLE_PRINT_QUERY=1 "${SAMPLER}" "${environment}" 2>/dev/null
}

stats() {
	local fixture="$1"
	shift
	printf '%s' "${fixture}" | env "$@" SAMPLE_RENDER_STATS=1 "${SAMPLER}" production 2>&1
}

echo "d1-latency-sample.sh: credential preflight"

expect_preflight 2 "" "no credentials -> exit 2"
expect_preflight 2 "" "token without account id -> exit 2" \
	CLOUDFLARE_API_TOKEN=t
expect_preflight 2 "" "account id without token -> exit 2" \
	CLOUDFLARE_ACCOUNT_ID=a
expect_preflight 0 "run" "both credentials -> run" \
	CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a

echo
echo "d1-latency-sample.sh: argument handling"

for bad in "" "prod" "PRODUCTION" "all"; do
	actual=0
	env CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a SAMPLE_PREFLIGHT_ONLY=1 \
		"${SAMPLER}" "${bad}" >/dev/null 2>&1 || actual=$?
	if [[ "${actual}" == "2" ]]; then
		pass "environment '${bad}' -> exit 2"
	else
		fail "environment '${bad}'" "exit ${actual} (expected 2)"
	fi
done

# 'all' is rejected on purpose, unlike client-error-monitor.sh which accepts it.
# Pooling production and staging into one distribution would average two
# different databases in two different places, and the percentile would describe
# neither.
for bad_minutes in "0" "-5" "abc" ""; do
	actual=0
	env CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a SAMPLE_PREFLIGHT_ONLY=1 \
		"${SAMPLER}" production --minutes "${bad_minutes}" >/dev/null 2>&1 || actual=$?
	if [[ "${actual}" == "2" ]]; then
		pass "--minutes '${bad_minutes}' -> exit 2"
	else
		fail "--minutes '${bad_minutes}'" "exit ${actual} (expected 2)"
	fi
done

echo
echo "d1-latency-sample.sh: query shape"

body="$(query production CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a)"

# Verified against the live API on 2026-08-23. The first version of this script
# named cloudflare-workers-traces, which does not exist - the telemetry API has
# no trace dataset at all, and no cloudflare.d1.* key of any kind.
dataset="$(printf '%s' "${body}" | jq -r '.parameters.datasets[0]' 2>/dev/null || true)"
if [[ "${dataset}" == "cloudflare-workers" ]]; then
	pass "queries the cloudflare-workers dataset, the one that exists"
else
	fail "queries the cloudflare-workers dataset" "got '${dataset}'"
fi

discriminator="$(printf '%s' "${body}" |
	jq -r '.parameters.filters[] | select(.key == "event") | .value' 2>/dev/null || true)"
if [[ "${discriminator}" == "d1_timing" ]]; then
	pass "discriminator filters on event = d1_timing"
else
	fail "discriminator filters on event = d1_timing" "got '${discriminator}'"
fi

# `in` with an array value returns HTTP 400 from this endpoint - established by
# running it. Only scalar eq is accepted, so a filter that reintroduces `in`
# breaks the script at the network rather than in any test.
operations="$(printf '%s' "${body}" |
	jq -r '[.parameters.filters[].operation] | unique | join(",")' 2>/dev/null || true)"
if [[ "${operations}" == "eq" ]]; then
	pass "every filter uses scalar eq, never 'in'"
else
	fail "every filter uses scalar eq, never 'in'" "got '${operations}'"
fi

# `source.` is not a query prefix. Filtering on it matches nothing AND reports
# success while doing so, which is the exact shape of a monitor that is green
# forever.
wrong="$(printf '%s' "${body}" |
	jq -r '[.parameters.filters[].key] | map(select(startswith("source."))) | length' 2>/dev/null || true)"
if [[ "${wrong}" == "0" ]]; then
	pass "does not filter on a source. prefix"
else
	fail "does not filter on a source. prefix" "found ${wrong}"
fi

# Epoch MILLISECONDS, not ISO-8601 and not seconds. Cloudflare's own
# observability MCP client takes ISO and converts before sending, so a schema
# copied from it sends a value this API reads as 1970.
from="$(printf '%s' "${body}" | jq -r '.timeframe.from' 2>/dev/null || true)"
if [[ "${from}" =~ ^[0-9]{13}$ ]]; then
	pass "timeframe.from is epoch milliseconds (13 digits)"
else
	fail "timeframe.from is epoch milliseconds" "got '${from}'"
fi

service="$(printf '%s' "${body}" |
	jq -r '.parameters.filters[] | select(.key == "$metadata.service") | .value' 2>/dev/null || true)"
if [[ "${service}" == "onlooker-api-production" ]]; then
	pass "production filters on the production worker"
else
	fail "production filters on the production worker" "got '${service}'"
fi

staging_service="$(query staging CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a |
	jq -r '.parameters.filters[] | select(.key == "$metadata.service") | .value' 2>/dev/null || true)"
if [[ "${staging_service}" == "onlooker-api-staging" ]]; then
	pass "staging filters on the staging worker"
else
	fail "staging filters on the staging worker" "got '${staging_service}'"
fi

override="$(query production CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a \
	D1_SAMPLE_DATASET=other D1_SAMPLE_EVENT=other_event |
	jq -r '"\(.parameters.datasets[0]) \(.parameters.filters[0].value)"' 2>/dev/null || true)"
if [[ "${override}" == "other other_event" ]]; then
	pass "dataset and event name stay overridable"
else
	fail "dataset and event name stay overridable" "got '${override}'"
fi

echo
echo "d1-latency-sample.sh: the arithmetic"

# Wall times 40, 50, 84, 100 with exec 0.3 on each. Hand-checked against the
# nearest-rank definition in render_stats:
#   sorted        [40, 50, 84, 100]
#   p50 -> index ((4-1) * 50 / 100) | floor = 1 -> 50
#   p90 -> index ((4-1) * 90 / 100) | floor = 2 -> 84
#   max -> index 3                             -> 100
#   round trip = (274 - 1.2) / 274 = 99.6%
#
# Note the shape: fields live under `.source`, which is where this API nests the
# parsed JSON object. Reading them from the top level finds nothing and prints a
# table of n/a.
readonly FIXTURE='[
	{"source":{"event":"d1_timing","verb":"SELECT","wall_ms":100,"exec_ms":0.3,"trip_ms":99.7}},
	{"source":{"event":"d1_timing","verb":"SELECT","wall_ms":40,"exec_ms":0.3,"trip_ms":39.7}},
	{"source":{"event":"d1_timing","verb":"INSERT","wall_ms":84,"exec_ms":0.3,"trip_ms":83.7}},
	{"source":{"event":"d1_timing","verb":"SELECT","wall_ms":50,"exec_ms":0.3,"trip_ms":49.7}}
]'

rendered="$(stats "${FIXTURE}" CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a)"

expect_contains "${rendered}" "p50  50 ms" "p50 of [40,50,84,100] is 50"
expect_contains "${rendered}" "p90  84 ms" "p90 of [40,50,84,100] is 84"
expect_contains "${rendered}" "max  100 ms" "max of [40,50,84,100] is 100"
expect_contains "${rendered}" "99.6% of observed query time" "round trip share is 99.6%"
expect_contains "${rendered}" "queries sampled: 4" "counts every query"
expect_contains "${rendered}" "SELECT  3" "groups by verb"

# THREE wall times plus one null, not four, and the count is load-bearing. With
# four ([40,50,84,100]) a coerced zero gives [0,40,50,84,100] and p50 is 50
# either way - the assertion passes whether the bug is present or not. With
# three, correct is [40,50,100] -> 50 and coerced is [0,40,50,100] -> 40, so the
# number moves when the behavior does.
with_null="$(stats '[
	{"source":{"wall_ms":100,"exec_ms":0.3,"trip_ms":99.7}},
	{"source":{"wall_ms":40,"exec_ms":0.3,"trip_ms":39.7}},
	{"source":{"wall_ms":50,"exec_ms":0.3,"trip_ms":49.7}},
	{"source":{"exec_ms":0.3}}
]' CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a)"

expect_contains "${with_null}" "p50  50 ms" "a query with no wall time does not become a zero"
expect_contains "${with_null}" "queries sampled: 4  (with a wall time: 3)" "the dropped query is counted and reported"

# exec and trip are reported separately from wall, because the whole finding is
# the gap between them. A renderer that showed only wall would still pass every
# assertion above.
expect_contains "${rendered}" "exec  (D1 executing the query)" "reports execution time separately"
expect_contains "${rendered}" "trip  (wall - exec)" "reports the round trip separately"

empty="$(stats '[]' CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a)"
expect_contains "${empty}" "n/a" "an empty sample renders n/a rather than 0"
expect_contains "${empty}" "not computable" "an empty sample says the round trip is not computable"

echo
if (( failures > 0 )); then
	echo "d1-latency-sample.test.sh: ${failures} of ${tests} tests failed"
	exit 1
fi

echo "d1-latency-sample.test.sh: all ${tests} tests passed"
