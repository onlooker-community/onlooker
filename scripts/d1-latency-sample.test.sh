#!/usr/bin/env bash
# Offline tests for scripts/d1-latency-sample.sh.
#
# These make no network requests. They pin two things.
#
# First, the query shape - which sounds like testing a string literal until you
# know how this endpoint fails. An unknown key returns success:true, errors:[],
# zero rows, indistinguishable from a correct query over a quiet window
# (onlooker-kuk, 2026-08-21). The sampler's dataset and view names could not be
# confirmed by experiment, so what CAN be pinned is that they stay overridable
# and that the attribute names stay the documented ones.
#
# Second, the arithmetic. A sampler whose percentiles are wrong is worse than
# no sampler: it answers the question confidently and sends you to tune a query
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
# Asserts BOTH the exit code and which branch preflight took, for the same
# reason client-error-monitor.test.sh does: two different outcomes can share an
# exit code, and an exit-code-only assertion cannot see a sampler that has
# quietly stopped checking anything.
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

# query <environment> [env...] - print the query body the script builds
query() {
	local environment="$1"
	shift
	env "$@" SAMPLE_PRINT_QUERY=1 "${SAMPLER}" "${environment}" 2>/dev/null
}

# stats <spans-json> [env...] - run the renderer over a fixture
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
# Pooling production and staging spans into one distribution would average two
# different databases in two different places, and the resulting percentile
# would describe neither.
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

view="$(printf '%s' "${body}" | jq -r '.view' 2>/dev/null || true)"
if [[ -n "${view}" && "${view}" != "null" ]]; then
	pass "view is set ('${view}')"
else
	fail "view is set" "got '${view}'"
fi

dataset="$(printf '%s' "${body}" | jq -r '.parameters.datasets[0]' 2>/dev/null || true)"
if [[ -n "${dataset}" && "${dataset}" != "null" ]]; then
	pass "dataset is set ('${dataset}')"
else
	fail "dataset is set" "got '${dataset}'"
fi

# The dataset and view could not be confirmed against a live account, so the
# thing worth pinning is that they stay overridable. If the shipped guess is
# wrong, the fix has to be an env var rather than an edit.
override="$(query production CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a \
	D1_SAMPLE_DATASET=some-other-dataset D1_SAMPLE_VIEW=some-other-view |
	jq -r '"\(.parameters.datasets[0]) \(.view)"' 2>/dev/null || true)"
if [[ "${override}" == "some-other-dataset some-other-view" ]]; then
	pass "dataset and view are overridable"
else
	fail "dataset and view are overridable" "got '${override}'"
fi

# Epoch milliseconds, not ISO-8601 and not seconds. Cloudflare's own
# observability MCP client takes ISO and converts before sending, so a schema
# copied from it sends a value this API reads as 1970 - a window that matches
# nothing, reported as success.
from="$(printf '%s' "${body}" | jq -r '.timeframe.from' 2>/dev/null || true)"
if [[ "${from}" =~ ^[0-9]{13}$ ]]; then
	pass "timeframe.from is epoch milliseconds (13 digits)"
else
	fail "timeframe.from is epoch milliseconds" "got '${from}'"
fi

span_names="$(printf '%s' "${body}" |
	jq -r '[.parameters.filters[] | select(.operation == "in") | .value[]] | join(",")' 2>/dev/null || true)"
expect_contains "${span_names}" "d1_all" "span filter includes d1_all, the span onlooker-ujy measured"
expect_contains "${span_names}" "d1_first" "span filter includes d1_first, so a changed query shape stays in the sample"

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

echo
echo "d1-latency-sample.sh: attribute names"

# The correction that made this script necessary to get right. onlooker-ujy's
# notes call the region attribute served_by_colo, which is the dashboard's
# display label. The documented attribute is served_by_region, and querying the
# wrong one returns nothing in the silent way described at the top of this file.
rendered="$(stats '[{"duration":10,"cloudflare.d1.response.sql_duration_ms":0.3,"cloudflare.d1.response.served_by_region":"MIA"}]' \
	CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a)"
expect_contains "${rendered}" "MIA" "reads served_by_region"

colo_rendered="$(stats '[{"duration":10,"cloudflare.d1.response.sql_duration_ms":0.3,"cloudflare.d1.response.served_by_colo":"MIA"}]' \
	CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a)"
expect_contains "${colo_rendered}" "(absent)" "served_by_colo is NOT read - it is the display label, not the attribute"

if ! grep -q "served_by_colo" "${SAMPLER}" || grep -q 'ATTR_SERVED_REGION=.*served_by_colo' "${SAMPLER}"; then
	fail "the script never queries served_by_colo" "found it as a query key"
else
	pass "the script never queries served_by_colo (named only in the warning comment)"
fi

echo
echo "d1-latency-sample.sh: the arithmetic"

# Durations 40, 50, 84, 100 with sql 0.3 on each. Hand-checked against the
# nearest-rank definition in render_stats:
#   sorted        [40, 50, 84, 100]
#   p50 -> index ((4-1) * 50 / 100) | floor = 1 -> 50
#   p90 -> index ((4-1) * 90 / 100) | floor = 2 -> 84
#   max -> index 3                             -> 100
#   round trip = (274 - 1.2) / 274 = 99.6%
readonly FIXTURE='[
	{"duration":100,"cloudflare.d1.response.sql_duration_ms":0.3,"cloudflare.d1.response.served_by_region":"MIA","cloudflare.d1.response.served_by_primary":true},
	{"duration":40,"cloudflare.d1.response.sql_duration_ms":0.3,"cloudflare.d1.response.served_by_region":"MIA","cloudflare.d1.response.served_by_primary":true},
	{"duration":84,"cloudflare.d1.response.sql_duration_ms":0.3,"cloudflare.d1.response.served_by_region":"MIA","cloudflare.d1.response.served_by_primary":true},
	{"duration":50,"cloudflare.d1.response.sql_duration_ms":0.3,"cloudflare.d1.response.served_by_region":"MIA","cloudflare.d1.response.served_by_primary":true}
]'

rendered="$(stats "${FIXTURE}" CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a)"

expect_contains "${rendered}" "p50  50 ms" "p50 of [40,50,84,100] is 50"
expect_contains "${rendered}" "p90  84 ms" "p90 of [40,50,84,100] is 84"
expect_contains "${rendered}" "max  100 ms" "max of [40,50,84,100] is 100"
expect_contains "${rendered}" "99.6% of observed span time" "round trip share is 99.6%"
expect_contains "${rendered}" "spans sampled: 4" "counts every span"

# Nested attributes, which is the other shape this response can take. Same
# numbers must come out, or the script silently measures only one of the two.
nested="$(stats '[
	{"attributes":{"duration":100,"cloudflare.d1.response.sql_duration_ms":0.3}},
	{"attributes":{"duration":40,"cloudflare.d1.response.sql_duration_ms":0.3}},
	{"attributes":{"duration":84,"cloudflare.d1.response.sql_duration_ms":0.3}},
	{"attributes":{"duration":50,"cloudflare.d1.response.sql_duration_ms":0.3}}
]' CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a)"
expect_contains "${nested}" "p50  50 ms" "nested attributes give the same p50"

# The assertion that matters most for honesty. A span with no duration must be
# EXCLUDED, not coerced to zero - a zero drags every percentile down and makes
# a slow database look fast, which is the one wrong answer this script must
# never give.
# THREE durations plus one null, not four, and the count is load-bearing.
# With four ([40,50,84,100]) a coerced zero gives [0,40,50,84,100] and p50 is
# 50 either way - the assertion passes whether the bug is present or not. With
# three, correct is [40,50,100] -> 50 and coerced is [0,40,50,100] -> 40, so
# the number actually moves when the behavior does. Verified by mutating
# render_stats to `attr($dur) // 0` and watching this fail.
with_null="$(stats '[
	{"duration":100,"cloudflare.d1.response.sql_duration_ms":0.3},
	{"duration":40,"cloudflare.d1.response.sql_duration_ms":0.3},
	{"duration":50,"cloudflare.d1.response.sql_duration_ms":0.3},
	{"cloudflare.d1.response.sql_duration_ms":0.3}
]' CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a)"

expect_contains "${with_null}" "p50  50 ms" "a span with no duration does not become a zero"
expect_contains "${with_null}" "spans sampled: 4  (with a duration: 3)" "the dropped span is counted and reported"

# An empty sample must not print numbers at all.
empty="$(stats '[]' CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a)"
expect_contains "${empty}" "n/a" "an empty sample renders n/a rather than 0"
expect_contains "${empty}" "not computable" "an empty sample says the round trip is not computable"

echo
if (( failures > 0 )); then
	echo "d1-latency-sample.test.sh: ${failures} of ${tests} tests failed"
	exit 1
fi

echo "d1-latency-sample.test.sh: all ${tests} tests passed"
