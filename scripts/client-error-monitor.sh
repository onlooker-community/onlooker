#!/usr/bin/env bash
# Reads the client error reports that apps/web has been sending since PR #53,
# and fails the run when any appear.
#
# Capture has worked for weeks. Nothing has ever read the result: the reports
# land in Workers Logs with 3-day retention and no one watches that, so a
# dashboard that blanked for every logged-in user would be recorded, readable,
# and unseen. This is the reader. Failing the run is the whole alert - GitHub
# emails on workflow failure, which is already this project's only alerting
# mechanism and the only one anyone actually watches.
#
# Usage: scripts/client-error-monitor.sh production|staging|all
#
# Exit codes are three-way on purpose:
#   0 - the window was quiet
#   1 - client errors were reported (this is the alert)
#   2 - the monitor could not do its job, which is NOT the same as quiet
#
# Collapsing 2 into 0 is how a broken monitor reads as good news forever.
set -euo pipefail

readonly ENVIRONMENT="${1:-}"

# Service names as Workers Logs knows them, which are the deployed Worker
# names, not the hostnames the heartbeat uses. apps/web is deliberately absent:
# it is static assets with no Worker of its own, which is the blind spot the
# reporting exists to cover in the first place.
case "${ENVIRONMENT}" in
	production)
		readonly SERVICE="onlooker-api-production"
		;;
	staging)
		readonly SERVICE="onlooker-api-staging"
		;;
	all)
		readonly SERVICE=""
		;;
	*)
		echo "usage: $(basename "$0") production|staging|all" >&2
		exit 2
		;;
esac

readonly API_BASE="https://api.cloudflare.com/client/v4"

# Wider than the schedule that drives it. The cron interval is nominal: the
# heartbeat's delivery was remeasured over 100 runs at a 24 minute median with
# a 112 minute maximum (onlooker-2ho), so a window equal to the interval leaves
# gaps whenever GitHub runs late, and a gap here is a client error nobody hears
# about. The overlap costs a repeated email for an error that is still inside
# two windows, which is the cheaper mistake.
readonly LOOKBACK_MINUTES="${CLIENT_ERROR_LOOKBACK_MINUTES:-180}"

readonly CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
readonly CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"

# Test seams. Both exit before any network request.
readonly MONITOR_PREFLIGHT_ONLY="${MONITOR_PREFLIGHT_ONLY:-}"
readonly MONITOR_PRINT_QUERY="${MONITOR_PRINT_QUERY:-}"
readonly MONITOR_RENDER_EVENTS="${MONITOR_RENDER_EVENTS:-}"

# build_filters
#
# The discriminator key is `event`, and getting it wrong is the failure this
# script is most exposed to.
#
# Workers Logs parses the JSON string handed to console.error and makes each
# property a queryable top-level key. The report's own `message` property is
# promoted into $metadata.message, so $metadata.message holds the error text
# and never the JSON envelope - the literal string 'client_error' is nowhere in
# it. Responses nest the parsed object under `source`, but `source.` is not a
# query prefix.
#
# Measured against a real report on 2026-08-21 (onlooker-kuk):
#   $metadata.message includes client_error -> 0
#   source.event eq client_error            -> 0
#   event eq client_error                   -> 1
#
# All three returned success:true with no errors. A wrong key here does not
# fail, it just never matches, which is why client-error-monitor.test.sh pins
# this string and why the control query below exists.
build_filters() {
	local filters
	filters='[{"key":"event","operation":"eq","value":"client_error","type":"string"}]'

	if [[ -n "${SERVICE}" ]]; then
		filters="$(printf '%s' "${filters}" | jq -c \
			--arg service "${SERVICE}" \
			'. + [{key: "$metadata.service", operation: "eq", value: $service, type: "string"}]')"
	fi

	printf '%s' "${filters}"
}

# build_query [filters-json]
#
# Defaults to the client error filters; the control query passes an empty array.
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
		'{
			queryId: "onlooker-client-error-monitor",
			parameters: {
				datasets: ["cloudflare-workers"],
				filters: $filters,
				filterCombination: "and"
			},
			timeframe: {from: $from, to: $to},
			view: "events",
			limit: 100
		}'
}

# render_events
#
# Reads the events array on stdin and prints one readable block per report.
#
# $metadata needs bracket syntax: in jq a `.` followed by `$` is a syntax
# error, not a field access, so the obvious `.$metadata.service` does not
# parse at all. This matters more than it looks. This function runs only on
# the alert path, so a mistake in it survives every green run and surfaces on
# the one day the monitor finally has something to report - turning "the
# dashboard is broken" into "the monitor is broken too". Hence the seam below,
# so the offline suite can reach it.
render_events() {
	jq -r '.[] |
		"  \(.["$metadata"].service // "unknown service")  \(.source.kind // "unknown kind")\n" +
		"    \(.source.message // "(no message)")\n" +
		"    at \(.source.url // "(no url)")\n"'
}

require_jq() {
	if ! command -v jq >/dev/null 2>&1; then
		echo "client-error-monitor: jq is required" >&2
		exit 2
	fi
}

if [[ -n "${MONITOR_PRINT_QUERY}" ]]; then
	require_jq
	build_query
	exit 0
fi

if [[ -n "${MONITOR_RENDER_EVENTS}" ]]; then
	require_jq
	render_events
	exit 0
fi

# preflight
#
# Unlike the heartbeat's, this one has no skip branch. The heartbeat can still
# do useful read-only work without credentials; this script has exactly one job
# and cannot do any of it, so absent configuration is a failure rather than a
# quieter run.
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
		echo "client-error-monitor: cannot run, missing:${missing}" >&2
		exit 2
	fi

	echo "preflight: run"
}

preflight

if [[ -n "${MONITOR_PREFLIGHT_ONLY}" ]]; then
	exit 0
fi

# telemetry_query <body>
#
# Prints the response body, then a final line holding the status code, matching
# the convention in heartbeat.sh. The body matters here: this endpoint answers
# 200 with success:false for a malformed query, so the status code alone cannot
# tell a working query from a rejected one.
telemetry_query() {
	local body="$1"

	# `|| true` so a connection failure becomes status 000 and travels through
	# the same non-200 branch as everything else. Without it `set -e` kills the
	# script with curl's own exit code, and a transient network blip would be
	# indistinguishable from the exit codes this script documents.
	printf '%s' "${body}" | curl -s --max-time 30 \
		-w $'\n%{http_code}' \
		-X POST "${API_BASE}/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/observability/telemetry/query" \
		-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
		-H 'Content-Type: application/json' \
		--data @- || true
}

# run_query <label> <body>
#
# Sets `event_count` and `events_json`. Any failure to get a usable answer
# exits 2 rather than returning, because there is no partial success worth
# continuing from - a monitor that cannot read the logs must not report quiet.
run_query() {
	local label="$1" body="$2"
	local response status payload

	response="$(telemetry_query "${body}")"
	status="${response##*$'\n'}"
	payload="${response%$'\n'*}"

	if [[ "${status}" != "200" ]]; then
		echo "client-error-monitor: ${label} query -> HTTP ${status}" >&2

		# Print what Cloudflare said. The status alone is close to useless here:
		# a token that is malformed, revoked, or scoped to the wrong account all
		# come back 400, and the message in the body is the only thing that
		# distinguishes them.
		printf '%s' "${payload}" |
			jq -r '.errors[]? | "  cloudflare: \(.message) (code \(.code))"' >&2 2>/dev/null || true

		# 403 means the token authenticated but is not scoped for Workers
		# Observability. Worth naming, because the required permission is not
		# documented anywhere and this line is where you find out.
		if [[ "${status}" == "403" ]]; then
			echo "client-error-monitor: the token lacks the Workers Observability permission" >&2
		fi
		exit 2
	fi

	if [[ "$(printf '%s' "${payload}" | jq -r '.success' 2>/dev/null || true)" != "true" ]]; then
		echo "client-error-monitor: ${label} query was rejected:" >&2
		printf '%s' "${payload}" | jq -r '.errors[]?.message // "no message"' >&2 2>/dev/null || true
		exit 2
	fi

	events_json="$(printf '%s' "${payload}" | jq -c '.result.events.events // []')"
	event_count="$(printf '%s' "${events_json}" | jq -r 'length')"
}

# The control query, and the reason this script is more than one request.
#
# An unknown filter key returns success:true with zero events. So does a
# correct query over a quiet window. Nothing in the response distinguishes
# "nothing went wrong" from "this monitor has been asking the wrong question
# since the day it shipped" - which is the shape of the apex-path heartbeat
# that passed all its checks through a total outage.
#
# This asks the same endpoint, over the same window, with no filters at all. It
# must find something. If it does not, the monitor cannot see the dataset and
# its silence is worthless, so it fails loudly instead of reporting quiet.
#
# It is sound because the heartbeat runs against both API environments every
# few minutes and every request logs an invocation, so a three-hour window is
# never legitimately empty. If the heartbeat is ever retired, this assumption
# retires with it.
run_query "control" "$(build_query '[]')"

if (( event_count == 0 )); then
	echo "client-error-monitor: the control query found no events at all in the last ${LOOKBACK_MINUTES}m" >&2
	echo "client-error-monitor: the dataset is unreadable or empty, so silence here proves nothing" >&2
	exit 2
fi

echo "  ok    control query found ${event_count} events, the dataset is readable"

run_query "client error" "$(build_query)"

if (( event_count == 0 )); then
	echo "client-error-monitor: ${ENVIRONMENT} — no client errors in the last ${LOOKBACK_MINUTES}m"
	exit 0
fi

# Print them. The email says only that a workflow failed, so whatever is worth
# knowing has to be in the log the recipient opens next.
echo "client-error-monitor: ${ENVIRONMENT} — ${event_count} client error(s) in the last ${LOOKBACK_MINUTES}m" >&2
echo >&2
printf '%s' "${events_json}" | render_events >&2

if (( event_count >= 100 )); then
	echo "  (100 is the query limit, so there may be more)" >&2
fi

exit 1
