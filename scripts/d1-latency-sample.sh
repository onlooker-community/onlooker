#!/usr/bin/env bash
# Samples D1 span timings from Workers traces and prints a distribution.
#
# onlooker-ujy observed a d1_all span at 100 ms whose own
# cloudflare.d1.response.sql_duration_ms was 0.3078 - the worker in LAX, the
# database answering from MIA. So ~99.7% of what reads as database time was the
# trip across the continent, and tuning the query would recover nothing.
#
# That was n=2. The two spans were 40 ms and 100 ms, which is a range and not a
# distribution, and the bead explicitly says not to pick a lever from it. This
# script is how you get past n=2 without eyeballing the dashboard.
#
# It queries the telemetry API directly rather than reading the Traces tab,
# and that is the point. That list is titled "100 Slowest Traces" and means it -
# it is not a sample, so any percentile taken from it is biased upward by
# construction, which is exactly the wrong error when the question is whether
# 100 ms is typical or the tail.
#
# Usage: scripts/d1-latency-sample.sh production|staging [--minutes N]
#
# Exit codes are three-way, matching client-error-monitor.sh:
#   0 - sampled, distribution printed
#   1 - sampled, and the round trip dominates past the threshold (the finding)
#   2 - could not sample, which is NOT the same as "the database is fast"
#
# Collapsing 2 into 0 is how you get a confident distribution built on nothing.
set -euo pipefail

readonly ENVIRONMENT="${1:-}"

case "${ENVIRONMENT}" in
	production)
		readonly SERVICE="onlooker-api-production"
		;;
	staging)
		readonly SERVICE="onlooker-api-staging"
		;;
	*)
		echo "usage: $(basename "$0") production|staging [--minutes N]" >&2
		exit 2
		;;
esac

shift || true

LOOKBACK_MINUTES="${D1_SAMPLE_LOOKBACK_MINUTES:-1440}"
while (( $# )); do
	case "$1" in
		--minutes)
			LOOKBACK_MINUTES="${2:-}"
			shift 2 || { echo "--minutes needs a value" >&2; exit 2; }
			;;
		*)
			echo "unknown argument: $1" >&2
			exit 2
			;;
	esac
done
readonly LOOKBACK_MINUTES

if ! [[ "${LOOKBACK_MINUTES}" =~ ^[0-9]+$ ]] || (( LOOKBACK_MINUTES == 0 )); then
	echo "d1-latency-sample: --minutes must be a positive integer" >&2
	exit 2
fi

readonly API_BASE="https://api.cloudflare.com/client/v4"

readonly CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
readonly CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"

# The share of span time that has to be round trip before this reports a
# finding rather than just a table. The observed case was 99.7%; anything above
# this means the query itself is not the thing to tune.
readonly ROUND_TRIP_ALERT_PCT="${D1_SAMPLE_ALERT_PCT:-90}"

# Test seams. All exit before any network request.
readonly SAMPLE_PREFLIGHT_ONLY="${SAMPLE_PREFLIGHT_ONLY:-}"
readonly SAMPLE_PRINT_QUERY="${SAMPLE_PRINT_QUERY:-}"
readonly SAMPLE_RENDER_STATS="${SAMPLE_RENDER_STATS:-}"

# ---------------------------------------------------------------------------
# The unverified part, isolated on purpose.
#
# Everything below this block was verified against Cloudflare's published spans
# and attributes reference. These four values were NOT: the telemetry query
# API's dataset name and view for trace spans are not documented anywhere
# public, and they could not be confirmed by experiment because that needs a
# token this was written without.
#
# That matters more here than it would elsewhere. This endpoint answers an
# unknown filter key with success:true, errors:[], zero events - identical in
# every observable way to a correct query over a quiet window (onlooker-kuk,
# 2026-08-21). A wrong guess here does not fail. It produces a script that
# reports "no spans" forever and sounds like good news.
#
# So they are named constants with overrides rather than literals buried in the
# query, and assert_attributes_present below refuses to print a distribution
# unless the spans actually carry the fields being measured. If a guess is
# wrong you get exit 2 naming the key, on the first run, not a plausible table.
readonly TRACE_DATASET="${D1_SAMPLE_DATASET:-cloudflare-workers-traces}"
readonly TRACE_VIEW="${D1_SAMPLE_VIEW:-events}"
readonly SPAN_NAME_KEY="${D1_SAMPLE_SPAN_NAME_KEY:-name}"
readonly SPAN_DURATION_KEY="${D1_SAMPLE_DURATION_KEY:-duration}"
# ---------------------------------------------------------------------------

# Verified against the spans and attributes reference. Note served_by_REGION:
# onlooker-ujy's notes call it served_by_colo, which is the dashboard's display
# label, not the attribute name. Querying served_by_colo returns nothing, in
# the silent way described above.
readonly ATTR_SQL_MS="cloudflare.d1.response.sql_duration_ms"
readonly ATTR_SERVED_REGION="cloudflare.d1.response.served_by_region"
readonly ATTR_SERVED_PRIMARY="cloudflare.d1.response.served_by_primary"

# Every D1 span that runs a statement and returns rows. d1_all is what
# onlooker-ujy measured; the others are here because a refresh path that grows
# a d1_first would otherwise silently drop out of the sample.
readonly D1_SPAN_NAMES='["d1_all","d1_first","d1_run","d1_raw","d1_exec","d1_batch"]'

require_jq() {
	if ! command -v jq >/dev/null 2>&1; then
		echo "d1-latency-sample: jq is required" >&2
		exit 2
	fi
}

# build_filters
#
# Span name is matched with `in` rather than `eq` so the whole D1 family is
# sampled in one query.
build_filters() {
	jq -n -c \
		--arg service "${SERVICE}" \
		--arg name_key "${SPAN_NAME_KEY}" \
		--argjson names "${D1_SPAN_NAMES}" \
		'[
			{key: $name_key, operation: "in", value: $names, type: "string"},
			{key: "$metadata.service", operation: "eq", value: $service, type: "string"}
		]'
}

# build_query [filters-json]
#
# Timeframe is epoch MILLISECONDS. Cloudflare's own observability MCP client
# takes ISO-8601 and converts before sending, so a schema copied from it sends
# a value this API reads as 1970 and a window that matches nothing.
build_query() {
	local filters="${1:-$(build_filters)}"
	local to_ms from_ms
	to_ms=$(( $(date +%s) * 1000 ))
	from_ms=$(( to_ms - LOOKBACK_MINUTES * 60 * 1000 ))

	jq -n -c \
		--argjson from "${from_ms}" \
		--argjson to "${to_ms}" \
		--argjson filters "${filters}" \
		--arg dataset "${TRACE_DATASET}" \
		--arg view "${TRACE_VIEW}" \
		'{
			queryId: "onlooker-d1-latency-sample",
			parameters: {
				datasets: [$dataset],
				filters: $filters,
				filterCombination: "and"
			},
			timeframe: {from: $from, to: $to},
			view: $view,
			limit: 1000
		}'
}

# render_stats
#
# Reads the spans array on stdin and prints the distribution.
#
# Percentiles are nearest-rank on the sorted sample, not interpolated. With
# sample sizes this small interpolation invents precision that is not there,
# and every number printed here is meant to be one that was actually observed.
#
# The derived line is the whole reason the script exists: span duration minus
# sql_duration_ms is the part that is not the query, and on the observed trace
# that was 99.7% of it.
render_stats() {
	jq -r \
		--arg dur "${SPAN_DURATION_KEY}" \
		--arg sql "${ATTR_SQL_MS}" \
		--arg region "${ATTR_SERVED_REGION}" \
		--arg primary "${ATTR_SERVED_PRIMARY}" \
		'
		def pct(p): if length == 0 then null
			else sort | .[ ((length - 1) * p / 100) | floor ] end;
		def fmt(v): if v == null then "n/a" else (v * 1000 | round / 1000 | tostring) end;

		# Span duration is milliseconds in the dashboard. attributes may be flat
		# or nested depending on the view, so both are read - but a span that
		# yields neither is dropped and counted, never coerced to zero. A zero
		# would sink every percentile and read as a fast database.
		def attr($k): (.attributes[$k]? // .[$k]?);

		. as $spans
		| [ $spans[] | select(attr($dur) != null) ] as $timed
		| [ $timed[] | attr($dur) ] as $durations
		| [ $timed[] | attr($sql) | select(. != null) ] as $sqls
		| ($durations | add // 0) as $dur_total
		| ($sqls | add // 0) as $sql_total
		|
		"  spans sampled: \($spans | length)  (with a duration: \($timed | length))",
		"",
		"  span duration      p50  \(fmt($durations | pct(50))) ms",
		"                     p90  \(fmt($durations | pct(90))) ms",
		"                     p99  \(fmt($durations | pct(99))) ms",
		"                     max  \(fmt($durations | pct(100))) ms",
		"",
		"  sql_duration_ms    p50  \(fmt($sqls | pct(50))) ms",
		"                     p90  \(fmt($sqls | pct(90))) ms",
		"                     max  \(fmt($sqls | pct(100))) ms",
		"",
		(if $dur_total > 0 then
			"  round trip = span - sql  ->  \(((($dur_total - $sql_total) / $dur_total) * 1000 | round / 10))% of observed span time"
		else
			"  round trip: not computable, no span carried a duration"
		end),
		"",
		"  served_by_region:",
		( [ $spans[] | attr($region) // "(absent)" ]
			| group_by(.) | map({k: .[0], n: length}) | sort_by(-.n)
			| .[] | "    \(.k)  \(.n)" ),
		"",
		"  served_by_primary:",
		( [ $spans[] | attr($primary) | tostring ]
			| group_by(.) | map({k: .[0], n: length}) | sort_by(-.n)
			| .[] | "    \(.k)  \(.n)" )
		'
}

if [[ -n "${SAMPLE_PRINT_QUERY}" ]]; then
	require_jq
	build_query
	exit 0
fi

if [[ -n "${SAMPLE_RENDER_STATS}" ]]; then
	require_jq
	render_stats
	exit 0
fi

# preflight
#
# No skip branch, for the same reason client-error-monitor.sh has none: this
# script has exactly one job and cannot do any of it without credentials, so
# absent configuration is a failure rather than a quieter run.
preflight() {
	local missing=""

	if [[ -z "${CLOUDFLARE_API_TOKEN}" ]]; then
		missing="${missing} CLOUDFLARE_API_TOKEN"
	fi
	if [[ -z "${CLOUDFLARE_ACCOUNT_ID}" ]]; then
		missing="${missing} CLOUDFLARE_ACCOUNT_ID"
	fi
	if ! command -v jq >/dev/null 2>&1; then
		missing="${missing} jq"
	fi

	if [[ -n "${missing}" ]]; then
		# Names what is missing and nothing else. This repository is public and
		# so are its Actions logs.
		echo "d1-latency-sample: cannot run, missing:${missing}" >&2
		exit 2
	fi

	echo "preflight: run"
}

preflight

if [[ -n "${SAMPLE_PREFLIGHT_ONLY}" ]]; then
	exit 0
fi

telemetry_query() {
	local body="$1"

	# `|| true` so a connection failure becomes status 000 and travels through
	# the same non-200 branch as everything else. Without it `set -e` kills the
	# script with curl's own exit code, and a transient blip would be
	# indistinguishable from the exit codes documented at the top.
	printf '%s' "${body}" | curl -s --max-time 60 \
		-w $'\n%{http_code}' \
		-X POST "${API_BASE}/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/observability/telemetry/query" \
		-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
		-H 'Content-Type: application/json' \
		--data @- || true
}

# run_query <label> <body>
#
# Sets `span_count` and `spans_json`. Any failure to get a usable answer exits
# 2 rather than returning: there is no partial success worth continuing from,
# because a sampler that cannot read the traces must not print a distribution.
run_query() {
	local label="$1" body="$2"
	local response status payload

	response="$(telemetry_query "${body}")"
	status="${response##*$'\n'}"
	payload="${response%$'\n'*}"

	if [[ "${status}" != "200" ]]; then
		echo "d1-latency-sample: ${label} query -> HTTP ${status}" >&2

		# Print what Cloudflare said. The status alone is close to useless: a
		# token that is malformed, revoked, or scoped to the wrong account all
		# come back 400, and the body is the only thing that separates them.
		printf '%s' "${payload}" |
			jq -r '.errors[]? | "  cloudflare: \(.message) (code \(.code))"' >&2 2>/dev/null || true

		if [[ "${status}" == "403" ]]; then
			echo "d1-latency-sample: the token lacks the Workers Observability permission" >&2
		fi
		exit 2
	fi

	if [[ "$(printf '%s' "${payload}" | jq -r '.success' 2>/dev/null || true)" != "true" ]]; then
		echo "d1-latency-sample: ${label} query was rejected:" >&2
		printf '%s' "${payload}" | jq -r '.errors[]?.message // "no message"' >&2 2>/dev/null || true
		exit 2
	fi

	spans_json="$(printf '%s' "${payload}" | jq -c '.result.events.events // []')"
	span_count="$(printf '%s' "${spans_json}" | jq -r 'length')"
}

# The control query. Same endpoint, same window, same dataset, no filters.
#
# It must find something. An unknown dataset name, an unknown view, or a trace
# feed that simply is not there all return success with zero rows, and so does
# a genuinely quiet window - nothing in the response tells them apart. Without
# this, a wrong TRACE_DATASET produces "no D1 spans" forever, which reads as
# "no database problem" and is the same shape as the apex-path heartbeat that
# passed every check through a total outage.
run_query "control" "$(build_query '[]')"

if (( span_count == 0 )); then
	echo "d1-latency-sample: the control query found nothing in the last ${LOOKBACK_MINUTES}m" >&2
	echo "d1-latency-sample: dataset '${TRACE_DATASET}' view '${TRACE_VIEW}' returned no rows at all," >&2
	echo "  so either tracing is off, the window is empty, or those two names are wrong." >&2
	echo "  Override with D1_SAMPLE_DATASET / D1_SAMPLE_VIEW. See the block at the top of this file." >&2
	exit 2
fi

echo "  ok    control query found ${span_count} rows, the dataset is readable"

run_query "d1 spans" "$(build_query)"

if (( span_count == 0 )); then
	echo "d1-latency-sample: no D1 spans in the last ${LOOKBACK_MINUTES}m, though the dataset is readable" >&2
	echo "  Either nothing hit the database in that window, or '${SPAN_NAME_KEY}' is not the span name key." >&2
	echo "  Override with D1_SAMPLE_SPAN_NAME_KEY." >&2
	exit 2
fi

# assert_attributes_present
#
# The control query proves the dataset answers. It does not prove these spans
# carry the fields being measured, and a span whose duration and sql_duration
# both read as null would sail through every percentile above as "n/a" while
# still printing a confident-looking table.
#
# So this refuses to print anything unless at least one span actually carries
# each field. Named individually, because knowing WHICH key came back empty is
# the difference between a one-line fix and a rewrite.
assert_attributes_present() {
	local missing=""
	local key label

	while IFS='|' read -r key label; do
		local present
		present="$(printf '%s' "${spans_json}" | jq -r \
			--arg k "${key}" \
			'[ .[] | (.attributes[$k]? // .[$k]?) | select(. != null) ] | length')"
		if (( present == 0 )); then
			missing="${missing}\n    ${key}  (${label})"
		fi
	done <<-KEYS
		${SPAN_DURATION_KEY}|span duration, override with D1_SAMPLE_DURATION_KEY
		${ATTR_SQL_MS}|time inside the query itself
	KEYS

	if [[ -n "${missing}" ]]; then
		echo "d1-latency-sample: found ${span_count} D1 spans, but none of them carry:" >&2
		printf '%b\n' "${missing}" >&2
		echo "  Refusing to print a distribution over fields that are not there." >&2
		exit 2
	fi
}

assert_attributes_present

echo
echo "d1-latency-sample: ${ENVIRONMENT} — ${span_count} D1 spans over the last ${LOOKBACK_MINUTES}m"
echo
printf '%s' "${spans_json}" | render_stats
echo

if (( span_count >= 1000 )); then
	echo "  (1000 is the query limit, so the window holds more than this sample)"
fi

# The finding, restated as an exit code so this can be run from CI later
# without anyone reading the table.
round_trip_pct="$(printf '%s' "${spans_json}" | jq -r \
	--arg dur "${SPAN_DURATION_KEY}" \
	--arg sql "${ATTR_SQL_MS}" \
	'def attr($k): (.attributes[$k]? // .[$k]?);
	 ([ .[] | attr($dur) | select(. != null) ] | add // 0) as $d
	 | ([ .[] | attr($sql) | select(. != null) ] | add // 0) as $s
	 | if $d > 0 then (($d - $s) / $d * 100 | floor) else 0 end')"

if (( round_trip_pct >= ROUND_TRIP_ALERT_PCT )); then
	echo "d1-latency-sample: ${round_trip_pct}% of D1 span time is round trip, not query."
	echo "  Tuning the SQL recovers nothing. The levers are D1 read replication with"
	echo "  the Sessions API, or Smart Placement - see onlooker-ujy, and note that the"
	echo "  refresh path writes as well as reads, so read-your-own-writes needs the"
	echo "  bookmark handling the Sessions API exists to provide."
	exit 1
fi

exit 0
