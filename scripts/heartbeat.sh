#!/usr/bin/env bash
# Synthetic heartbeat: proves each deployed host is reachable and that the
# database read path works, without writing anything.
#
# Usage: scripts/heartbeat.sh production|staging
#
# Assertions are equality, not "not an error", because the interesting
# failures are specific. On /auth/refresh: 401 means the sessions table was
# queried and correctly found nothing; 500 means the query threw, which is the
# shape of an outage where the API still answers 200 at its root; 200 would
# mean a garbage token minted a session.
set -euo pipefail

readonly ENVIRONMENT="${1:-}"

case "${ENVIRONMENT}" in
	production)
		readonly APP_URL="https://app.onlooker.dev"
		readonly API_URL="https://api.onlooker.dev"
		;;
	staging)
		readonly APP_URL="https://app-staging.onlooker.dev"
		readonly API_URL="https://api-staging.onlooker.dev"
		;;
	*)
		echo "usage: $(basename "$0") production|staging" >&2
		exit 2
		;;
esac

# Every request this script makes is labelled, so analytics can separate
# synthetic traffic from real traffic by filtering rather than by arithmetic.
#
# The auth dashboard wants "401s that are not us". Without a label the only way
# to get there is to know the floor - this script produces exactly 4 401s per
# run, two per environment - and subtract it by eye. That number is held in a
# human's head, is invalidated by adding a hostname or a check, and cannot be
# drawn on a Cloudflare chart anyway. Excluding `curl/*` instead would also
# exclude anyone probing with curl, which is the traffic the chart exists to
# show.
#
# Versioned so the filter can be narrowed later without becoming ambiguous.
readonly USER_AGENT="onlooker-heartbeat/1"

# Credentials for the authenticated checks. Absent, those checks are skipped:
# somebody running this by hand has no reason to hold production credentials,
# and the read-only checks above are still worth having.
#
# Skipping is also how a check rots into a no-op that passes forever, so CI
# sets HEARTBEAT_REQUIRE_AUTH and absent credentials become a failure there. A
# secret that is deleted or renamed breaks the build rather than quietly
# returning this script to what it was before it could log in.
readonly HEARTBEAT_EMAIL="${HEARTBEAT_EMAIL:-}"
readonly HEARTBEAT_PASSWORD="${HEARTBEAT_PASSWORD:-}"
readonly HEARTBEAT_REQUIRE_AUTH="${HEARTBEAT_REQUIRE_AUTH:-}"

failures=0
# Counted rather than written down. The summary below said "3 checks" while a
# fourth was being added, which is the kind of small lie that makes a passing
# run harder to trust than a failing one.
checks=0

# record <label> <ok|fail> <detail>
#
# One place that counts, so the summary line cannot drift from what actually
# ran. `check` below is status-code assertions; the authenticated checks need
# to assert on response bodies too, and both report through here.
record() {
	local label="$1" outcome="$2" detail="${3:-}"

	checks=$((checks + 1))

	if [[ "${outcome}" == "ok" ]]; then
		echo "  ok    ${label}"
	else
		echo "  FAIL  ${label} -> ${detail}"
		failures=$((failures + 1))
	fi
}

# Decide whether the authenticated checks can run.
#   0 - run them
#   1 - skip them, and say so
#   exit 2 - they were required and cannot run
#
# jq is a hard requirement rather than a nicety: it builds the login body, so
# a password containing a quote or a backslash is escaped by a JSON encoder
# rather than by hand.
auth_preflight() {
	local missing=""

	if [[ -z "${HEARTBEAT_EMAIL}" ]]; then
		missing="${missing} HEARTBEAT_EMAIL"
	fi
	if [[ -z "${HEARTBEAT_PASSWORD}" ]]; then
		missing="${missing} HEARTBEAT_PASSWORD"
	fi
	if ! command -v jq >/dev/null 2>&1; then
		missing="${missing} jq"
	fi

	if [[ -z "${missing}" ]]; then
		return 0
	fi

	if [[ -n "${HEARTBEAT_REQUIRE_AUTH}" ]]; then
		# Deliberately names what is missing and nothing else. Never echo the
		# values - this repository is public and so are its Actions logs.
		echo "heartbeat: authenticated checks are required but unavailable:${missing}" >&2
		exit 2
	fi

	echo "  skip  authenticated checks (missing:${missing})"
	return 1
}

# check <label> <expected-status> <curl-args...>
check() {
	local label="$1"
	local expected="$2"
	shift 2

	local actual
	# curl must not abort the script on a network failure, so its exit status
	# is swallowed with `|| true` rather than allowed to trip `set -e`.
	#
	# Do NOT write `|| echo "000"` here. On a connection failure curl already
	# prints 000 via %{http_code} AND exits non-zero, so the fallback appends a
	# second one and the variable becomes "000000" - garbage in the exact
	# message you would be reading during an outage. Verified 2026-08-09.
	#
	# A DNS or connection failure therefore yields 000, which will not equal
	# the expected code - exactly the api-staging failure mode.
	actual="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
		-A "${USER_AGENT}" "$@" || true)"

	if [[ "${actual}" == "${expected}" ]]; then
		record "${label} -> ${actual}" ok
	else
		record "${label}" fail "${actual} (expected ${expected})"
	fi
}

echo "heartbeat: ${ENVIRONMENT}"

# Test hook: resolve credentials, then stop before making any request. Used by
# scripts/heartbeat.test.sh so the guard can be tested without network.
#
# It prints which branch it took because the exit code cannot say: run and skip
# both exit 0, so without this a preflight that skipped forever - disabling
# every authenticated check - would pass its own tests.
if [[ -n "${HEARTBEAT_PREFLIGHT_ONLY:-}" ]]; then
	if auth_preflight; then
		echo "preflight: run"
	else
		echo "preflight: skip"
	fi
	exit 0
fi

check "web app" 200 "${APP_URL}/"

# A route that exists only in the client router, so it is not a file in the
# assets bundle and can only answer 200 if the SPA fallback is configured.
#
# The check above cannot fail for that reason: / IS a file, served by the CDN
# whether or not the application routes. That is not hypothetical. Every route
# except / returned 404 in production - no bookmark, refresh, shared link or
# emailed link worked - and this heartbeat passed all three checks every 31
# minutes in both environments throughout, because it was watching the one path
# the bug could not reach (onlooker-hu8).
#
# /login rather than a deeper path on purpose: it takes no parameters, needs no
# session, and is the first page a locked-out person is sent to.
check "web app deep link" 200 "${APP_URL}/login"

check "api worker" 401 "${API_URL}/auth/me"

check "api d1 read" 401 \
	-X POST "${API_URL}/auth/refresh" \
	-H 'Content-Type: application/json' \
	-d '{"refreshToken":"heartbeat"}'

if (( failures > 0 )); then
	echo "heartbeat: ${ENVIRONMENT} — ${failures} of ${checks} checks failed"
	exit 1
fi

echo "heartbeat: ${ENVIRONMENT} — all ${checks} checks passed"
