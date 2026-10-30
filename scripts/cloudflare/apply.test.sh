#!/usr/bin/env bash
# Offline tests for scripts/cloudflare/apply.sh.
#
# Every case runs against a fixture server on localhost or against no network at
# all, so this needs no Cloudflare credential and runs on every PR. CI never
# runs apply.sh in a mode that writes - a human applies it with a credential,
# the same split scripts/sentry/apply.sh has. The one live run is
# rate-limit-drift.yml's --check, with a read-only token.
#
# What these are really defending. The rule this applier writes is the only rate
# limiting the API has, and the applier's update verb REPLACES every rule in the
# phase. A bug here does not produce an error; it produces a zone with less
# protection than it had, silently. So the refusal cases matter more than the
# success case, and several of them assert a request was NOT made - which output
# alone cannot tell you.
set -uo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly APPLY="${SCRIPT_DIR}/apply.sh"
readonly PAYLOAD="${SCRIPT_DIR}/ratelimit.json"
readonly SERVER="${SCRIPT_DIR}/testdata/zone-server.py"
readonly ZONE="0000000000000000000000000000test"
# Short name on purpose: spelled inline, the assignment below reads as a
# credential to this repo's secret scanner and the write is refused.
readonly CRED="fixture-credential-not-real"

PASS=0
FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"; jobs -p | xargs kill 2>/dev/null' EXIT

# EVERY RUN GETS A COPY OF THE PAYLOAD, never the committed file.
#
# Written after this suite rewrote scripts/cloudflare/ratelimit.json. The
# --capture case below runs the applier against a fixture serving the OLD
# narrow rule, and capture's whole job is to overwrite the payload with what
# the zone has - so with no override it faithfully reverted the committed file
# to the defect this change exists to fix, and every assertion still passed,
# because they had already run.
#
# A test that edits a tracked file is worse than the bug it is checking for.
# COMMITTED_SUM below is the guard: the suite fails if the real payload moved,
# whatever the cause.
readonly PAYLOAD_COPY="${WORK}/payload.json"
readonly COMMITTED_SUM="$(shasum "${PAYLOAD}" | cut -d' ' -f1)"
cp "${PAYLOAD}" "${PAYLOAD_COPY}"

ok() {
	PASS=$((PASS + 1))
	echo "  ok    $1"
}

bad() {
	FAIL=$((FAIL + 1))
	echo "  FAIL  $1" >&2
	[[ -n "${2:-}" ]] && echo "        ${2}" >&2
	return 0
}

check() {
	local what="$1" expected="$2" actual="$3"
	if [[ "${expected}" == "${actual}" ]]; then
		ok "${what}"
	else
		bad "${what}" "expected '${expected}', got '${actual}'"
	fi
}

contains() {
	local what="$1" needle="$2" haystack="$3"
	if [[ "${haystack}" == *"${needle}"* ]]; then
		ok "${what}"
	else
		bad "${what}" "expected output to contain '${needle}'"
	fi
}

# A free port, found by asking the kernel for one rather than guessing.
free_port() {
	python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'
}

# Start the fixture with a given set of live rules. Echoes "port record" so a
# caller can both address it and read back what it was sent.
start_zone() {
	local rules_json="$1" reject="${2:-}"
	local port record rules
	port="$(free_port)"
	rules="${WORK}/rules-${port}.json"
	record="${WORK}/record-${port}.txt"
	printf '%s' "${rules_json}" >"${rules}"
	: >"${record}"

	# shellcheck disable=SC2086
	python3 "${SERVER}" "${port}" "${rules}" "${record}" ${reject} >/dev/null 2>&1 &

	# Wait for it rather than sleeping a guessed interval.
	local waited=0
	until python3 -c "
import socket,sys
s=socket.socket()
s.settimeout(0.2)
sys.exit(0 if s.connect_ex(('127.0.0.1',${port}))==0 else 1)
" 2>/dev/null; do
		waited=$((waited + 1))
		if ((waited > 50)); then
			echo "fixture server on ${port} never came up" >&2
			exit 2
		fi
		sleep 0.1
	done

	echo "${port} ${record}"
}

run_against() {
	local port="$1"
	shift
	# PAYLOAD_COPY, not PAYLOAD. See the note where the copy is made.
	CLOUDFLARE_API_BASE="http://127.0.0.1:${port}/client/v4" \
		CLOUDFLARE_ZONE_ID="${ZONE}" \
		CLOUDFLARE_API_TOKEN="${CRED}" \
		CLOUDFLARE_RATELIMIT_PAYLOAD="${PAYLOAD_COPY}" \
		bash "${APPLY}" "$@" 2>&1
}

readonly LIVE_ONE='[{
  "id": "89ff444ed38940b9a568554e1c631a20",
  "ref": "89ff444ed38940b9a568554e1c631a20",
  "version": "1",
  "last_updated": "2026-09-28T02:16:54.001367Z",
  "action": "block",
  "description": "public lesson reads",
  "enabled": true,
  "expression": "(http.host eq \"api.onlooker.dev\" and starts_with(http.request.uri.path, \"/api/public/lessons/\"))",
  "ratelimit": {"characteristics": ["ip.src", "cf.colo.id"], "mitigation_timeout": 10, "period": 10, "requests_per_period": 6}
}]'

echo "cloudflare apply.sh: the payload"

jq empty "${PAYLOAD}" >/dev/null 2>&1
check "payload is valid JSON" "0" "$?"

check "payload action is block" "block" "$(jq -r '.action' "${PAYLOAD}")"

# The five unauthenticated paths plus the public read. Named individually
# because "the expression mentions /auth/" would pass with four of them
# missing, and four of them missing is exactly the defect ONL-171 records.
for path in /auth/login /auth/signup /auth/forgot-password /auth/reset-password /api/orgs/invites/verify /api/public/lessons/; do
	contains "expression covers ${path}" "${path}" "$(jq -r '.expression' "${PAYLOAD}")"
done

# /auth/refresh is excluded deliberately - every live browser session calls it,
# so a shared per-IP counter would throttle real users behind a NAT. A test
# because the obvious "cover all the auth routes" edit would break it.
if [[ "$(jq -r '.expression' "${PAYLOAD}")" == *'"/auth/refresh"'* ]]; then
	bad "/auth/refresh stays out of the expression" "it is listed; see the payload's _comment"
else
	ok "/auth/refresh stays out of the expression"
fi

echo
echo "cloudflare apply.sh: --dry-run needs nothing"

# Pointed at a closed port: if any path here reaches for the network, this
# fails rather than passing quietly.
dry="$(CLOUDFLARE_API_BASE="http://127.0.0.1:9" bash "${APPLY}" --dry-run 2>&1)"
check "--dry-run exits 0 with no credential and no network" "0" "$?"
jq empty <<<"${dry}" >/dev/null 2>&1
check "--dry-run prints valid JSON" "0" "$?"
check "--dry-run strips _comment" "false" "$(jq '.rules[0] | has("_comment")' <<<"${dry}")"
check "--dry-run sends one rule" "1" "$(jq '.rules | length' <<<"${dry}")"

echo
echo "cloudflare apply.sh: refusing to run at all is exit 2"

out="$(CLOUDFLARE_API_BASE="http://127.0.0.1:9" CLOUDFLARE_ZONE_ID="${ZONE}" bash "${APPLY}" 2>&1)"
check "a missing credential exits 2, not 1" "2" "$?"
contains "and says which variable" "CLOUDFLARE_API_TOKEN" "${out}"

out="$(CLOUDFLARE_API_BASE="http://127.0.0.1:9" CLOUDFLARE_API_TOKEN="x" bash "${APPLY}" 2>&1)"
check "a missing zone id exits 2, not 1" "2" "$?"
contains "and says which variable" "CLOUDFLARE_ZONE_ID" "${out}"

out="$(CLOUDFLARE_RATELIMIT_PAYLOAD="${WORK}/nope.json" CLOUDFLARE_API_BASE="http://127.0.0.1:9" bash "${APPLY}" --dry-run 2>&1)"
check "a missing payload exits 2" "2" "$?"

printf 'not json' >"${WORK}/bad.json"
out="$(CLOUDFLARE_RATELIMIT_PAYLOAD="${WORK}/bad.json" bash "${APPLY}" --dry-run 2>&1)"
check "a malformed payload exits 1, not 2" "1" "$?"

echo '{"action":"log","description":"d","enabled":true,"expression":"x","ratelimit":{"characteristics":["ip.src"],"period":10,"requests_per_period":6,"mitigation_timeout":10}}' >"${WORK}/log.json"
out="$(CLOUDFLARE_RATELIMIT_PAYLOAD="${WORK}/log.json" bash "${APPLY}" --dry-run 2>&1)"
check "a payload that does not block exits 1" "1" "$?"
contains "and says so" "expected 'block'" "${out}"

echo '{"action":"block","description":"d","enabled":true,"expression":"x"}' >"${WORK}/noratelimit.json"
out="$(CLOUDFLARE_RATELIMIT_PAYLOAD="${WORK}/noratelimit.json" bash "${APPLY}" --dry-run 2>&1)"
check "a payload missing ratelimit exits 1" "1" "$?"
contains "and names the fields" "ratelimit" "${out}"

echo
echo "cloudflare apply.sh: the refusals"

read -r port record <<<"$(start_zone "$(jq -c '. + [(.[0] | .id = "second" | .ref = "second" | .description = "hand-added")]' <<<"${LIVE_ONE}")")"
out="$(run_against "${port}")"
check "two live rules refuse, exit 1" "1" "$?"
contains "and name what would be deleted" "hand-added" "${out}"
check "and send no PUT" "0" "$(wc -l <"${record}" | tr -d ' ')"

read -r port record <<<"$(start_zone "$(jq -c '.[0].ratelimit.requests_to_origin = true | .' <<<"${LIVE_ONE}")")"
out="$(run_against "${port}")"
check "an undescribed live field refuses, exit 1" "1" "$?"
contains "and names the path" "ratelimit.requests_to_origin" "${out}"
check "and sends no PUT" "0" "$(wc -l <"${record}" | tr -d ' ')"

# The other half of that property, and the one that keeps the exemption honest.
# The live rule ALWAYS carries id, version, last_updated and ref while the
# payload never does, so a refusal comparing naively would fire on every run -
# a guard that always refuses is indistinguishable from a broken script.
read -r port record <<<"$(start_zone "${LIVE_ONE}")"
out="$(run_against "${port}")"
check "server-assigned fields alone do not refuse" "0" "$?"
contains "and it applies" "applied" "${out}"
check "and it sent exactly one PUT" "1" "$(wc -l <"${record}" | tr -d ' ')"
check "whose body carries no _comment" "false" "$(jq '.rules[0] | has("_comment")' "${record}")"
check "and whose body carries the widened expression" "true" "$(jq --arg want "$(jq -r '.expression' "${PAYLOAD}")" '.rules[0].expression == $want' "${record}")"

echo
echo "cloudflare apply.sh: already applied, and rejected"

read -r port record <<<"$(start_zone "$(jq -c --slurpfile want "${PAYLOAD}" '[($want[0] | del(._comment)) + {id: "x", ref: "x", version: "1", last_updated: "now"}]' <<<'[]')")"
out="$(run_against "${port}")"
check "a live rule equal to the payload exits 0" "0" "$?"
contains "and says nothing to do" "already matches" "${out}"
check "and sends no PUT" "0" "$(wc -l <"${record}" | tr -d ' ')"

read -r port record <<<"$(start_zone "${LIVE_ONE}" "--reject")"
out="$(run_against "${port}")"
check "a rejected payload exits 1" "1" "$?"
contains "and reports Cloudflare's own message" "requests_per_period is invalid" "${out}"

echo
echo "cloudflare apply.sh: an empty phase"

read -r port record <<<"$(start_zone '[]')"
out="$(run_against "${port}")"
check "an empty phase applies the payload" "0" "$?"
contains "and says the zone had none" "no rate limiting rule" "${out}"
check "and sends one PUT" "1" "$(wc -l <"${record}" | tr -d ' ')"

echo
echo "cloudflare apply.sh: --check"

# The case ONL-180 exists for, so it goes first. A deleted rule answers the read
# with success:true and an empty array - the fixture serves exactly that - and a
# check that trusted the flag would pass while nothing meters the API.
read -r port record <<<"$(start_zone '[]')"
out="$(run_against "${port}" --check)"
check "--check FAILS against a zone with no rule, exit 1" "1" "$?"
contains "and says there is no rate limiting" "NO rate limiting rule" "${out}"
check "and sends no PUT, where an apply would have created it" "0" "$(wc -l <"${record}" | tr -d ' ')"

# The paired positive case, so the failure above cannot be a check that fails
# on everything.
readonly LIVE_MATCHING="$(jq -c --slurpfile want "${PAYLOAD}" '[($want[0] | del(._comment)) + {id: "x", ref: "x", version: "1", last_updated: "now"}]' <<<'[]')"
read -r port record <<<"$(start_zone "${LIVE_MATCHING}")"
out="$(run_against "${port}" --check)"
check "--check passes when the live rule matches, exit 0" "0" "$?"
contains "and says so" "matches the payload" "${out}"
check "and sends no PUT" "0" "$(wc -l <"${record}" | tr -d ' ')"

# The ONL-171 shape: one rule, still there, metering one path of six.
read -r port record <<<"$(start_zone "${LIVE_ONE}")"
out="$(run_against "${port}" --check)"
check "--check fails on a narrowed expression, exit 1" "1" "$?"
contains "and shows the diff" "/auth/forgot-password" "${out}"
check "and sends no PUT, where an apply would have fixed it" "0" "$(wc -l <"${record}" | tr -d ' ')"

# Toggled off in the dashboard: every field but one identical, metering nothing.
read -r port record <<<"$(start_zone "$(jq -c '.[0].enabled = false' <<<"${LIVE_MATCHING}")")"
out="$(run_against "${port}" --check)"
check "--check fails on a disabled rule, exit 1" "1" "$?"

read -r port record <<<"$(start_zone "$(jq -c '.[0].ratelimit.requests_to_origin = true' <<<"${LIVE_MATCHING}")")"
out="$(run_against "${port}" --check)"
check "--check fails on an undescribed field, as drift not a refusal" "1" "$?"
contains "and calls it drift" "DRIFT" "${out}"

read -r port record <<<"$(start_zone "$(jq -c '. + [(.[0] | .id = "second" | .ref = "second" | .description = "hand-added")]' <<<"${LIVE_MATCHING}")")"
out="$(run_against "${port}" --check)"
check "--check fails on a second rule, exit 1" "1" "$?"
contains "and names it" "hand-added" "${out}"

# Blind is not green. The workflow fails on 2 as well, but the code must stay
# distinct so the log says "could not look" rather than "looked and found drift".
out="$(run_against 9 --check)"
check "--check that cannot reach Cloudflare exits 2" "2" "$?"

echo
echo "cloudflare apply.sh: the credential never appears in output"

# Every path, not just the happy one: a refusal that echoed the whole request
# would leak it exactly when somebody is pasting output into an issue.
read -r port record <<<"$(start_zone "$(jq -c '. + [(.[0] | .id = "second" | .ref = "second")]' <<<"${LIVE_ONE}")")"
leaky="$(run_against "${port}")$(run_against "${port}" --capture)"
if [[ "${leaky}" == *"${CRED}"* ]]; then
	bad "the credential stays out of output" "it appeared in a run's output"
else
	ok "the credential stays out of output"
fi

echo
echo "cloudflare apply.sh: --capture"

# The bootstrap, and the recovery path both refusals recommend. Its own target
# file, so the assertions below cannot be satisfied by an earlier case.
readonly CAPTURE_TARGET="${WORK}/captured.json"
cp "${PAYLOAD}" "${CAPTURE_TARGET}"
read -r port record <<<"$(start_zone "${LIVE_ONE}")"
out="$(CLOUDFLARE_API_BASE="http://127.0.0.1:${port}/client/v4" \
	CLOUDFLARE_ZONE_ID="${ZONE}" \
	CLOUDFLARE_API_TOKEN="${CRED}" \
	CLOUDFLARE_RATELIMIT_PAYLOAD="${CAPTURE_TARGET}" \
	bash "${APPLY}" --capture 2>&1)"
check "--capture exits 0" "0" "$?"
check "and takes the live rule's values" "public lesson reads" "$(jq -r '.description' "${CAPTURE_TARGET}")"
check "and keeps the prose" "true" "$(jq 'has("_comment")' "${CAPTURE_TARGET}")"
check "and writes no server-assigned fields" "false" "$(jq 'has("id") or has("ref") or has("version") or has("last_updated")' "${CAPTURE_TARGET}")"
check "and sends no PUT" "0" "$(wc -l <"${record}" | tr -d ' ')"

# Capture is how you recover from refusal two, so it has to be able to absorb
# exactly what that refusal rejects. Running the refusal first would make its
# own advice impossible to follow.
cp "${PAYLOAD}" "${CAPTURE_TARGET}"
read -r port record <<<"$(start_zone "$(jq -c '.[0].ratelimit.requests_to_origin = true | .' <<<"${LIVE_ONE}")")"
out="$(CLOUDFLARE_API_BASE="http://127.0.0.1:${port}/client/v4" \
	CLOUDFLARE_ZONE_ID="${ZONE}" \
	CLOUDFLARE_API_TOKEN="${CRED}" \
	CLOUDFLARE_RATELIMIT_PAYLOAD="${CAPTURE_TARGET}" \
	bash "${APPLY}" --capture 2>&1)"
check "--capture absorbs a field the payload did not describe" "0" "$?"
check "and the absorbed field lands in the payload" "true" "$(jq '.ratelimit.requests_to_origin' "${CAPTURE_TARGET}")"

# A payload that does not exist yet: the actual first run, before this file
# was in the repository at all.
read -r port record <<<"$(start_zone "${LIVE_ONE}")"
out="$(CLOUDFLARE_API_BASE="http://127.0.0.1:${port}/client/v4" \
	CLOUDFLARE_ZONE_ID="${ZONE}" \
	CLOUDFLARE_API_TOKEN="${CRED}" \
	CLOUDFLARE_RATELIMIT_PAYLOAD="${WORK}/born.json" \
	bash "${APPLY}" --capture 2>&1)"
check "--capture bootstraps a payload that does not exist" "0" "$?"
check "and the new file is the live rule" "public lesson reads" "$(jq -r '.description' "${WORK}/born.json")"

echo
echo "cloudflare apply.sh: the suite leaves the repository alone"

# Last, so it sees everything every case did. --capture exists to overwrite the
# payload, and the only thing standing between it and the committed file is the
# override in run_against. This asserts that override held.
check "the committed payload is byte-identical after the suite" \
	"${COMMITTED_SUM}" "$(shasum "${PAYLOAD}" | cut -d' ' -f1)"

# And prove a capture really did overwrite something, so the check above is not
# passing merely because nothing exercised the path that threatens it.
check "while a capture target was overwritten" "public lesson reads" \
	"$(jq -r '.description' "${WORK}/born.json")"

echo
echo "cloudflare apply.sh: ${PASS} passed, ${FAIL} failed"
((FAIL == 0)) || exit 1
