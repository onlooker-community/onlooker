#!/usr/bin/env bash
# Synthetic heartbeat: proves each deployed host is reachable, that the
# database read path works, and that a real session can be created, used and
# revoked.
#
# Checks 1-4 write nothing. Checks 5-9 deliberately do: they log in, which
# writes a session row, and log out, which revokes it. A check that cannot
# write cannot verify that writing works, and "the API correctly says no" is a
# different claim from "the API works" - only the first was ever monitored.
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
# to get there is to know the floor - this script produces exactly 6 401s per
# run, three per environment - and subtract it by eye. That number is held in a
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

# api_request <method> <path> [extra curl args...]
#
# Prints the response body, then a final line holding the status code. Callers
# split on the last newline. The existing `check` discards bodies with
# -o /dev/null; these checks need them, because a 200 carrying the wrong user
# is a worse failure than a 500 and a status code cannot see it.
api_request() {
	local method="$1" path="$2"
	shift 2

	curl -s --max-time 10 -A "${USER_AGENT}" \
		-w $'\n%{http_code}' \
		-X "${method}" "${API_URL}${path}" \
		"$@" || true
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

# --- Authenticated checks -------------------------------------------------
#
# Everything above proves the API correctly says no. An outage confined to the
# authenticated path - a rotated JWT secret, a bad users migration, a
# requireAuth regression - passes every one of them. These prove it can say
# yes, which is a different claim.
#
# This is also where the script stops being read-only: check 5 writes a session
# row and check 7 revokes it. That is the cost of verifying that writing works.
if auth_preflight; then
	# jq builds the body so the password is escaped by a JSON encoder rather
	# than by hand, and the pipe below keeps it out of curl's arguments.
	#
	# The password reaches jq through the environment rather than --arg,
	# because a command line is not private: /proc/PID/cmdline is world-readable
	# on Linux, while /proc/PID/environ is readable only by the owner. Exported
	# here for that reason - `export` after `readonly` is permitted, and the
	# value is unchanged.
	export HEARTBEAT_PASSWORD
	login_payload="$(jq -n \
		--arg email "${HEARTBEAT_EMAIL}" \
		'{email: $email, password: env.HEARTBEAT_PASSWORD}')"

	login_response="$(printf '%s' "${login_payload}" |
		api_request POST /auth/login \
			-H 'Content-Type: application/json' \
			--data @-)"
	login_status="${login_response##*$'\n'}"
	login_body="${login_response%$'\n'*}"

	access_token=""
	refresh_token=""

	if [[ "${login_status}" != "200" ]]; then
		record "auth login" fail "${login_status} (expected 200)"
	else
		# jq exits 5 on a body it cannot parse, and under `set -euo pipefail`
		# that would abort this script mid-run rather than report a failure.
		# A 200 carrying HTML is unlikely but not impossible, and the whole
		# point of this script is to survive the API misbehaving.
		access_token="$(printf '%s' "${login_body}" | jq -r '.token // empty' 2>/dev/null || true)"
		refresh_token="$(printf '%s' "${login_body}" | jq -r '.refreshToken // empty' 2>/dev/null || true)"

		if [[ -z "${access_token}" || -z "${refresh_token}" ]]; then
			# A 200 with no tokens in it is a success the client cannot use.
			record "auth login" fail "200 without token and refreshToken"
		else
			record "auth login -> 200" ok
		fi
	fi

	if [[ -n "${access_token}" ]]; then
		# Both tokens go in argv, unlike the password. They belong to an
		# account that owns nothing, and the runner is destroyed after the
		# job. The access token expires in TOKEN_EXPIRY_MINUTES (15). The
		# refresh token carries 30 days, which is the weaker case - it is
		# revoked seconds later by check 8, but only if check 8 runs. The
		# password is the durable secret and the one worth the extra handling.
		me_response="$(api_request GET /auth/me \
			-H "Authorization: Bearer ${access_token}")"
		me_status="${me_response##*$'\n'}"
		me_body="${me_response%$'\n'*}"

		if [[ "${me_status}" != "200" ]]; then
			record "auth me" fail "${me_status} (expected 200)"
		else
			# Parsed only once the status is known good, and never fatally.
			# Cloudflare's edge errors - 502, 520-524, the 1101 Worker
			# exception page - are HTML, so parsing before checking the status
			# would abort this script on exactly the outage it exists to
			# catch: no failure line, no summary, and checks 7 to 9 skipped,
			# leaving the session this run created unrevoked for 30 days.
			me_email="$(printf '%s' "${me_body}" | jq -r '.user.email // empty' 2>/dev/null || true)"

			if [[ "${me_email}" != "${HEARTBEAT_EMAIL}" ]]; then
				# Never print either address. That this failed is the whole
				# message; the values belong in a private log, and this one is
				# public. A 200 whose body will not parse lands here too, which
				# is the honest answer - it is not the account we asked for.
				record "auth me" fail "200 for a different account than expected"
			else
				record "auth me -> 200" ok
			fi
		fi
	fi

	if [[ -n "${refresh_token}" ]]; then
		# The only check here that asserts a session can be EXTENDED. Every
		# other assertion about refresh is negative - check 4 sends a garbage
		# token and check 9 sends a revoked one, and both expect 401. A token
		# lookup that silently stopped matching would satisfy both: login still
		# writes, /auth/me reads a JWT and never consults the sessions table,
		# logout returns 200 unconditionally, and a 401 here would look
		# correct. Every check would pass while every real user was logged out
		# 15 minutes after signing in, which is TOKEN_EXPIRY_MINUTES.
		refresh_payload="$(jq -n --arg token "${refresh_token}" '{refreshToken: $token}')"
		refresh_response="$(printf '%s' "${refresh_payload}" |
			api_request POST /auth/refresh \
				-H 'Content-Type: application/json' \
				--data @-)"
		refresh_status="${refresh_response##*$'\n'}"
		refresh_body="${refresh_response%$'\n'*}"

		if [[ "${refresh_status}" != "200" ]]; then
			# handleRefresh revokes only after every validation has passed, so
			# a non-200 means the token we hold was not consumed and is still
			# the right one to clean up below.
			record "auth valid refresh" fail "${refresh_status} (expected 200)"
		else
			rotated_access="$(printf '%s' "${refresh_body}" | jq -r '.token // empty' 2>/dev/null || true)"
			rotated_refresh="$(printf '%s' "${refresh_body}" | jq -r '.refreshToken // empty' 2>/dev/null || true)"

			if [[ -z "${rotated_access}" || -z "${rotated_refresh}" ]]; then
				# A 200 that carries no new pair. The server has already
				# revoked what we sent, and we cannot see what replaced it, so
				# the session below is unreachable and expires on its own after
				# REFRESH_TOKEN_EXPIRY_DAYS. One orphan row per occurrence, and
				# the failure is recorded rather than the row being pursued.
				record "auth valid refresh" fail "200 without token and refreshToken"
			else
				record "auth valid refresh -> 200" ok
				# Rotation consumed the old token. Everything after this must
				# use the new one, or it is asserting against a token the
				# server already revoked - which would pass for the wrong
				# reason and leave the live session behind.
				refresh_token="${rotated_refresh}"
			fi
		fi

		logout_payload="$(jq -n --arg token "${refresh_token}" '{refreshToken: $token}')"
		logout_response="$(printf '%s' "${logout_payload}" |
			api_request POST /auth/logout \
				-H 'Content-Type: application/json' \
				--data @-)"
		logout_status="${logout_response##*$'\n'}"

		if [[ "${logout_status}" == "200" ]]; then
			record "auth logout -> 200" ok
		else
			record "auth logout" fail "${logout_status} (expected 200)"
		fi

		# Logout once revoked nothing at all, so a logged-out session could
		# call /auth/refresh indefinitely, each call minting a fresh 30-day
		# window. That shipped. This is the assertion that would have caught
		# it, and it costs one request.
		revoked_response="$(printf '%s' "${logout_payload}" |
			api_request POST /auth/refresh \
				-H 'Content-Type: application/json' \
				--data @-)"
		revoked_status="${revoked_response##*$'\n'}"

		if [[ "${revoked_status}" == "401" ]]; then
			record "auth revoked refresh -> 401" ok
		else
			record "auth revoked refresh" fail "${revoked_status} (expected 401)"
		fi
	fi
fi

if (( failures > 0 )); then
	echo "heartbeat: ${ENVIRONMENT} — ${failures} of ${checks} checks failed"
	exit 1
fi

echo "heartbeat: ${ENVIRONMENT} — all ${checks} checks passed"
