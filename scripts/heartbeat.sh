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

failures=0

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
	actual="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true)"

	if [[ "${actual}" == "${expected}" ]]; then
		echo "  ok    ${label} -> ${actual}"
	else
		echo "  FAIL  ${label} -> ${actual} (expected ${expected})"
		failures=$((failures + 1))
	fi
}

echo "heartbeat: ${ENVIRONMENT}"

check "web app" 200 "${APP_URL}/"

check "api worker" 401 "${API_URL}/auth/me"

check "api d1 read" 401 \
	-X POST "${API_URL}/auth/refresh" \
	-H 'Content-Type: application/json' \
	-d '{"refreshToken":"heartbeat"}'

if (( failures > 0 )); then
	echo "heartbeat: ${ENVIRONMENT} — ${failures} of 3 checks failed"
	exit 1
fi

echo "heartbeat: ${ENVIRONMENT} — all 3 checks passed"
