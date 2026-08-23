#!/usr/bin/env bash
# Samples D1 query timings from Workers Logs and prints a distribution.
#
# onlooker-ujy observed a d1_all span at 100 ms whose own execution was 0.3078 ms
# - worker in LAX, database in MIA - so ~99.7% of what read as database time was
# the trip across the continent, and tuning the query would recover nothing.
# That was n=2: two spans, 40 ms and 100 ms, a range rather than a distribution.
# This is how you get past n=2.
#
# THE FIRST VERSION OF THIS SCRIPT COULD NOT WORK, and the reason is worth
# keeping. It queried Workers *tracing* for d1_all spans, because the bead noted
# that the dashboard's Traces tab already records everything needed. That is
# true of the dashboard and false of anything automated. Probed against
# production on 2026-08-23: the telemetry query API's key list contains no
# cloudflare.d1.* field of any kind, no event in it carries a spanName, and an
# `exists` filter on spanName returns nothing - with no error. The Traces tab
# reads a different backend. No dataset or view name would have fixed it.
#
# So apps/api measures this itself now - see apps/api/src/db/timing.ts - and
# emits one d1_timing line per query into Workers Logs, which this reads. The
# numbers are ours rather than the vendor's:
#
#   wall_ms  how long the Worker actually waited
#   exec_ms  meta.duration, D1's own report of execution time
#   trip_ms  wall - exec, the part that is neither the query nor the client
#
# trip_ms is the number the bead is about.
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

# The share of query time that has to be round trip before this reports a
# finding rather than just a table. The originally observed case was 99.7%.
readonly ROUND_TRIP_ALERT_PCT="${D1_SAMPLE_ALERT_PCT:-90}"

# Test seams. All exit before any network request.
readonly SAMPLE_PREFLIGHT_ONLY="${SAMPLE_PREFLIGHT_ONLY:-}"
readonly SAMPLE_PRINT_QUERY="${SAMPLE_PRINT_QUERY:-}"
readonly SAMPLE_RENDER_STATS="${SAMPLE_RENDER_STATS:-}"

# Verified against the live API on 2026-08-23 rather than guessed. The first
# version named `cloudflare-workers-traces`, which does not exist; a control
# query against this one returns rows.
readonly DATASET="${D1_SAMPLE_DATASET:-cloudflare-workers}"

# The discriminator, and the failure this script is most exposed to.
#
# Workers Logs parses the JSON string handed to console.error and makes each
# property a queryable top-level key, so `event` is filterable directly. The
# response nests the parsed object under `source`, but `source.` is NOT a query
# prefix - filtering on it matches nothing and reports success while doing so.
# Established for client_error in onlooker-kuk and reused here unchanged.
readonly EVENT_NAME="${D1_SAMPLE_EVENT:-d1_timing}"

require_jq() {
	if ! command -v jq >/dev/null 2>&1; then
		echo "d1-latency-sample: jq is required" >&2
		exit 2
	fi
}

build_filters() {
	jq -n -c \
		--arg event "${EVENT_NAME}" \
		--arg service "${SERVICE}" \
		'[
			{key: "event", operation: "eq", value: $event, type: "string"},
			{key: "$metadata.service", operation: "eq", value: $service, type: "string"}
		]'
}

# build_query [filters-json]
#
# Timeframe is epoch MILLISECONDS. Cloudflare's own observability MCP client
# takes ISO-8601 and converts before sending, so a schema copied from it sends a
# value this API reads as 1970 and a window that matches nothing.
#
# Note `operation: "eq"` throughout. An earlier version used `in` with an array
# value and the API answered HTTP 400 - only scalar eq is accepted here.
build_query() {
	local filters="${1:-$(build_filters)}"
	local to_ms from_ms
	to_ms=$(( $(date +%s) * 1000 ))
	from_ms=$(( to_ms - LOOKBACK_MINUTES * 60 * 1000 ))

	jq -n -c \
		--argjson from "${from_ms}" \
		--argjson to "${to_ms}" \
		--argjson filters "${filters}" \
		--arg dataset "${DATASET}" \
		'{
			queryId: "onlooker-d1-latency-sample",
			parameters: {
				datasets: [$dataset],
				filters: $filters,
				filterCombination: "and"
			},
			timeframe: {from: $from, to: $to},
			view: "events",
			limit: 1000
		}'
}

# render_stats
#
# Reads the events array on stdin and prints the distribution.
#
# Fields come from `.source`, which is where the API nests the parsed JSON
# object - the same place client-error-monitor.sh reads .source.kind from.
#
# Percentiles are nearest-rank on the sorted sample, not interpolated. At these
# sample sizes interpolation invents precision that is not there, and every
# number printed here is one that was actually observed.
render_stats() {
	jq -r '
		def pct(p): if length == 0 then null
			else sort | .[ ((length - 1) * p / 100) | floor ] end;
		def fmt(v): if v == null then "n/a" else (v * 1000 | round / 1000 | tostring) end;

		. as $events
		| [ $events[] | .source | select(.wall_ms != null) ] as $timed
		| [ $timed[] | .wall_ms ] as $walls
		| [ $timed[] | .exec_ms | select(. != null) ] as $execs
		| [ $timed[] | .trip_ms | select(. != null) ] as $trips
		| ($walls | add // 0) as $wall_total
		| ($execs | add // 0) as $exec_total
		|
		"  queries sampled: \($events | length)  (with a wall time: \($timed | length))",
		"",
		"  wall  (what the worker waited)   p50  \(fmt($walls | pct(50))) ms",
		"                                   p90  \(fmt($walls | pct(90))) ms",
		"                                   p99  \(fmt($walls | pct(99))) ms",
		"                                   max  \(fmt($walls | pct(100))) ms",
		"",
		"  exec  (D1 executing the query)   p50  \(fmt($execs | pct(50))) ms",
		"                                   p90  \(fmt($execs | pct(90))) ms",
		"                                   max  \(fmt($execs | pct(100))) ms",
		"",
		"  trip  (wall - exec)              p50  \(fmt($trips | pct(50))) ms",
		"                                   p90  \(fmt($trips | pct(90))) ms",
		"                                   max  \(fmt($trips | pct(100))) ms",
		"",
		(if $wall_total > 0 then
			"  round trip is \(((($wall_total - $exec_total) / $wall_total) * 1000 | round / 10))% of observed query time"
		else
			"  round trip: not computable, no query carried a wall time"
		end),
		"",
		"  by verb:",
		( [ $events[] | .source.verb // "(absent)" ]
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
# Sets `event_count` and `events_json`. Any failure to get a usable answer exits
# 2 rather than returning: there is no partial success worth continuing from,
# because a sampler that cannot read the logs must not print a distribution.
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

	events_json="$(printf '%s' "${payload}" | jq -c '.result.events.events // []')"
	event_count="$(printf '%s' "${events_json}" | jq -r 'length')"
}

# The control query, and the reason this script is more than one request.
#
# An unknown filter key returns success:true with zero events. So does a correct
# query over a quiet window - nothing in the response tells them apart. Without
# this, a wrong EVENT_NAME produces "no timings" forever, which reads as "no
# database problem" and is the same shape as the apex-path heartbeat that passed
# every check through a total outage.
run_query "control" "$(build_query '[]')"

if (( event_count == 0 )); then
	echo "d1-latency-sample: the control query found nothing in the last ${LOOKBACK_MINUTES}m" >&2
	echo "d1-latency-sample: dataset '${DATASET}' returned no rows at all, so either the" >&2
	echo "  window is empty or that name is wrong. Override with D1_SAMPLE_DATASET." >&2
	exit 2
fi

echo "  ok    control query found ${event_count} rows, the dataset is readable"

run_query "d1 timings" "$(build_query)"

if (( event_count == 0 )); then
	echo "d1-latency-sample: no '${EVENT_NAME}' events in the last ${LOOKBACK_MINUTES}m, though the dataset is readable" >&2
	echo "  Either apps/api served no request in that window, or the timing wrapper" >&2
	echo "  is not installed - see apps/api/src/db/timing.ts and confirm index.ts" >&2
	echo "  still passes timedD1(env.DB) to dispatch." >&2
	exit 2
fi

# assert_fields_present
#
# The control query proves the dataset answers and the filter proves these are
# d1_timing events. Neither proves they carry the numbers being measured - and
# an event whose wall_ms and exec_ms both read as null would sail through every
# percentile above as "n/a" while still printing a confident-looking table.
assert_fields_present() {
	local missing=""
	local field

	for field in wall_ms exec_ms; do
		local present
		present="$(printf '%s' "${events_json}" | jq -r \
			--arg f "${field}" \
			'[ .[] | .source[$f]? | select(. != null) ] | length')"
		if (( present == 0 )); then
			missing="${missing} ${field}"
		fi
	done

	if [[ -n "${missing}" ]]; then
		echo "d1-latency-sample: found ${event_count} ${EVENT_NAME} events, but none carry:${missing}" >&2
		echo "  Refusing to print a distribution over fields that are not there." >&2
		exit 2
	fi
}

assert_fields_present

echo
echo "d1-latency-sample: ${ENVIRONMENT} — ${event_count} queries over the last ${LOOKBACK_MINUTES}m"
echo
printf '%s' "${events_json}" | render_stats
echo

if (( event_count >= 1000 )); then
	echo "  (1000 is the query limit, so the window holds more than this sample)"
fi

# The finding, restated as an exit code so this can run from CI later without
# anyone reading the table.
round_trip_pct="$(printf '%s' "${events_json}" | jq -r \
	'([ .[] | .source.wall_ms? | select(. != null) ] | add // 0) as $w
	 | ([ .[] | .source.exec_ms? | select(. != null) ] | add // 0) as $e
	 | if $w > 0 then (($w - $e) / $w * 100 | floor) else 0 end')"

if (( round_trip_pct >= ROUND_TRIP_ALERT_PCT )); then
	echo "d1-latency-sample: ${round_trip_pct}% of D1 query time is round trip, not execution."
	echo "  Tuning the SQL recovers nothing. The levers are D1 read replication with"
	echo "  the Sessions API, or Smart Placement - see onlooker-ujy, and note that the"
	echo "  refresh path writes as well as reads, so read-your-own-writes needs the"
	echo "  bookmark handling the Sessions API exists to provide."
	exit 1
fi

exit 0
