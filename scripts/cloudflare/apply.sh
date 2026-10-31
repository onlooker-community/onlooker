#!/usr/bin/env bash
# Applies the zone's rate limiting rule from scripts/cloudflare/ratelimit.json.
#
# Why this rule lives in a file: it is the only rate limiting the API has, at
# the edge or anywhere else, and until 2026-10-17 it lived exclusively in the
# Cloudflare dashboard. The consequence was not hypothetical. apps/api/
# DEPLOYMENT.md described a rule covering five paths at 60 requests per minute
# per IP; the zone held one path at 6 per 10 seconds counted per IP per
# datacenter. Four unauthenticated endpoints that the document promised were
# metered were not, including /auth/forgot-password, which reaches sendEmail
# without a credential. Nobody lied - a description of a thing is not the
# thing, and there was no way to tell them apart. See ONL-171.
#
# So the payload is canonical and this script is the only thing that should
# write the rule. A reviewer reads the diff; the zone gets exactly that.
#
# THE UPDATE VERB IS A REPLACE. PUT on a phase entry point sets its rules to
# exactly what is sent, which Cloudflare documents on the sibling cache phase:
# "using these examples directly will cause any existing rules to be deleted."
# For one rule that is the right verb - it makes the operation idempotent - and
# it means a careless run can silently delete a rule somebody added by hand. The
# two refusals below exist for that, and they are the reason this script is
# strict enough to be annoying: it refuses rather than choosing, the way
# scripts/sentry/apply.sh refuses a workflow it cannot unambiguously resolve.
#
# Usage: scripts/cloudflare/apply.sh [--capture | --dry-run | --check]
#   --capture   read the live rule and write it to the payload file. How the
#               payload is born: the first one was captured, not typed, because
#               typing it from the document is the mistake this script exists to
#               make impossible.
#   --dry-run   validate the payload and print the exact body a real run would
#               PUT. Makes NO request and needs no credential - so it cannot
#               show a diff against the live rule, which needs both by
#               definition.
#   --check     fetch and compare, never write. Exit 1 on ANY drift, including
#               a zone with no rule at all. What rate-limit-drift.yml runs.
#   (no flag)   fetch, refuse or report, and PUT only if the live rule differs.
#
# Env:
#   CLOUDFLARE_API_TOKEN  required unless --dry-run. Needs Zone -> Zone WAF ->
#                         Edit on this zone. Read alone is enough for --capture
#                         and --check, and the scheduled check holds only Read.
#   CLOUDFLARE_ZONE_ID    required unless --dry-run. Not committed: this repo is
#                         public, already keeps ids out of config by a source
#                         guard, and a wrong value would meter the wrong zone.
#   CLOUDFLARE_API_BASE   overridable so apply.test.sh can point at a fixture
#                         server, the reason SENTRY_API_BASE is overridable.
#   CLOUDFLARE_RATELIMIT_PAYLOAD  overridable for the same reason.
#
# Exit codes, three-way like scripts/sentry/apply.sh:
#   0 - applied, already matching, or a well-formed --dry-run
#   1 - Cloudflare rejected it, the payload is malformed, a refusal fired, or
#       --check found the live zone differs from the payload
#   2 - this script could not do its job at all (no credential, no zone, no tools)
#
# THE CREDENTIAL IS NEVER PRINTED and never passed as an argv element - it is
# read from the environment into a curl config on stdin, so it stays out of
# `ps`, out of shell history, and out of any transcript of a run. A `set -x`
# added for debugging would undo all three at once.
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PAYLOAD="${CLOUDFLARE_RATELIMIT_PAYLOAD:-${SCRIPT_DIR}/ratelimit.json}"
readonly API="${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}"
readonly PHASE="http_ratelimit"

# Fields Cloudflare assigns and the payload deliberately never carries.
#
# ONE named constant because two things read it, and they must agree: --capture
# strips these before writing, and the undescribed-field refusal ignores them
# when comparing. Compared without this exemption, "a field the payload does not
# describe" is true of `id` on every single run, and the refusal would fire
# universally - a guard that always refuses is indistinguishable from a broken
# script. `ref` belongs here because Cloudflare defaults it to the rule id; the
# captured rule had both set to the same value.
readonly SERVER_ASSIGNED='["id","version","last_updated","ref"]'

MODE="apply"
for argument in "$@"; do
	case "${argument}" in
		--capture) MODE="capture" ;;
		--dry-run) MODE="dry-run" ;;
		--check) MODE="check" ;;
		-h|--help)
			sed -n '/^# Usage:/,/^#   (no flag)/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			echo "apply.sh: unknown argument '${argument}'" >&2
			exit 2
			;;
	esac
done

fail() {
	echo "apply.sh: $1" >&2
	exit "${2}"
}

for tool in curl jq; do
	command -v "${tool}" >/dev/null 2>&1 || fail "${tool} is required" 2
done

# --capture is the bootstrap, so it cannot require what it exists to produce.
# It tolerates a missing payload, and a payload holding nothing but its
# _comment block - which is how the first one was made. Every other mode needs
# a complete, valid file.
if [[ -f "${PAYLOAD}" ]]; then
	jq empty "${PAYLOAD}" 2>/dev/null || fail "payload is not valid JSON: ${PAYLOAD}" 1
elif [[ "${MODE}" != "capture" ]]; then
	fail "no payload at ${PAYLOAD}" 2
fi

# What a real run would send: the payload without its prose, wrapped as the
# ruleset body. Stripping _comment is load-bearing rather than cosmetic -
# Cloudflare rejects unknown fields - so apply.test.sh asserts it is gone.
desired_rule() { jq -S 'del(._comment)' "${PAYLOAD}"; }
desired_body() { jq -S -n --argjson rule "$(desired_rule)" '{rules: [$rule]}'; }

# Required fields, checked here rather than discovered in a 400. The action
# check is deliberate: this rule exists to block, and a payload that said
# "log" would apply cleanly, report success, and meter nothing.
validate_payload() {
	local rule missing
	rule="$(desired_rule)"

	for field in description expression action ratelimit; do
		if [[ "$(jq -r --arg f "${field}" 'has($f)' <<<"${rule}")" != "true" ]]; then
			missing="${missing:-}${missing:+, }${field}"
		fi
	done
	for field in characteristics period requests_per_period mitigation_timeout; do
		if [[ "$(jq -r --arg f "${field}" '.ratelimit // {} | has($f)' <<<"${rule}")" != "true" ]]; then
			missing="${missing:-}${missing:+, }ratelimit.${field}"
		fi
	done
	[[ -z "${missing:-}" ]] || fail "payload is missing ${missing}" 1

	local action
	action="$(jq -r '.action' <<<"${rule}")"
	[[ "${action}" == "block" ]] || fail "payload action is '${action}', expected 'block'" 1
}

[[ "${MODE}" == "capture" ]] || validate_payload

if [[ "${MODE}" == "dry-run" ]]; then
	# Nothing read from the environment, no zone, no request. The test points
	# CLOUDFLARE_API_BASE at a closed port, so anything reaching for the
	# network here fails that test rather than passing quietly.
	desired_body
	exit 0
fi

readonly AUTH="${CLOUDFLARE_API_TOKEN:-}"
readonly ZONE="${CLOUDFLARE_ZONE_ID:-}"
[[ -n "${AUTH}" ]] || fail "CLOUDFLARE_API_TOKEN is required" 2
[[ -n "${ZONE}" ]] || fail "CLOUDFLARE_ZONE_ID is required" 2

# Shape checks, before any request. Without them a trailing newline in either
# secret fails inside curl - a malformed URL, or a config line that no longer
# parses - and prints the same "could not reach Cloudflare" as an outage, which
# is how bringing up rate-limit-drift.yml took four rounds (ONL-227). Exit 2
# because nothing was asked of Cloudflare. Neither message prints the value.
[[ "${ZONE}" =~ ^[0-9a-f]{32}$ ]] ||
	fail "CLOUDFLARE_ZONE_ID is not a zone id (32 lowercase hex characters) - check it for whitespace, or a URL pasted in its place" 2
# Only what breaks the curl config: whitespace ends the line, and a quote or a
# backslash changes how it parses. Anything else is Cloudflare's to reject.
[[ ! "${AUTH}" =~ [[:space:]\"\\] ]] ||
	fail "CLOUDFLARE_API_TOKEN contains whitespace, a quote or a backslash, which no token has - check it for a trailing newline" 2

readonly ENTRYPOINT="${API}/zones/${ZONE}/rulesets/phases/${PHASE}/entrypoint"

# The credential goes in on stdin and nowhere else. See the header.
auth_config() { printf 'header = "Authorization: Bearer %s"\n' "${AUTH}"; }

# A transport failure is exit 2, not 1: nothing was rejected and nothing was
# written, so the caller should retry rather than reach for the payload.
#
# curl's exit code goes in the message because its stderr cannot: that would
# echo the request, and the request carries the credential. The code alone
# tells an outage (6, 7, 28) from a malformed request (3).
request() {
	local method="$1" url="$2" body="${3:-}" response
	if [[ -n "${body}" ]]; then
		response="$(auth_config | curl -s -K - --max-time 20 \
			--request "${method}" \
			--header "Content-Type: application/json" \
			--data "${body}" \
			"${url}" 2>/dev/null)" || fail "could not reach Cloudflare (curl exit $?)" 2
	else
		response="$(auth_config | curl -s -K - --max-time 20 \
			--request "${method}" "${url}" 2>/dev/null)" || fail "could not reach Cloudflare (curl exit $?)" 2
	fi
	[[ -n "${response}" ]] || fail "Cloudflare returned an empty response" 2
	jq empty <<<"${response}" 2>/dev/null || fail "Cloudflare returned non-JSON" 2
	printf '%s' "${response}"
}

# Cloudflare answers 200 with success:false for a rejected payload, so the
# flag is the thing to read rather than curl's exit code.
require_success() {
	local response="$1" what="$2"
	if [[ "$(jq -r '.success' <<<"${response}")" != "true" ]]; then
		echo "apply.sh: Cloudflare rejected ${what}:" >&2
		jq -r '.errors[]? | "  \(.code // "?"): \(.message // "unknown")"' <<<"${response}" >&2
		exit 1
	fi
}

live="$(request GET "${ENTRYPOINT}")"
require_success "${live}" "the entry point read"

live_count="$(jq '.result.rules // [] | length' <<<"${live}")"

# The live rule with what Cloudflare assigns stripped, so it compares against
# the payload. Only meaningful when the phase holds exactly one rule.
strip_server_assigned() {
	jq -S --argjson drop "${SERVER_ASSIGNED}" \
		'.result.rules[0] | delpaths([$drop[] | [.]])' <<<"${live}"
}

# --check: compare and report, and never write.
#
# It answers before either refusal, and the order matters. The refusals are
# about what an APPLY would destroy; a check destroys nothing, and every case
# they cover - a second rule, an undescribed field - is drift, so it fails
# here with one word instead of a recommendation to reconcile by hand.
#
# THE EMPTY PHASE IS THE CASE THIS EXISTS FOR. A zone with the rule deleted
# answers the read with success:true and an empty array, so a check that read
# only the success flag would pass at exactly the moment the API has no rate
# limiting at all. ONL-180, and the first case apply.test.sh asserts.
if [[ "${MODE}" == "check" ]]; then
	if ((live_count == 0)); then
		echo "apply.sh: DRIFT - the zone has NO rate limiting rule. Nothing meters the" >&2
		echo "  API's unauthenticated paths. Restore it with scripts/cloudflare/apply.sh." >&2
		exit 1
	fi
	if ((live_count > 1)); then
		echo "apply.sh: DRIFT - the zone holds ${live_count} rate limiting rules; the payload describes one:" >&2
		jq -r '.result.rules[] | "    \(.description // "(no description)")  \(.expression)"' <<<"${live}" >&2
		exit 1
	fi
	live_rule="$(strip_server_assigned)"
	if [[ "${live_rule}" == "$(desired_rule)" ]]; then
		echo "apply.sh: the live rule matches the payload."
		exit 0
	fi
	echo "apply.sh: DRIFT - the live rule differs from the payload (< live, > payload):" >&2
	diff <(printf '%s\n' "${live_rule}") <(desired_rule) >&2 || true
	exit 1
fi

# REFUSAL ONE: more than one live rule.
#
# The plan allows a single rate limiting rule, so a second one means somebody
# added it deliberately - and a PUT of this payload would delete it without
# saying so. Naming them is the point: a refusal that does not say what it
# found just looks like a broken script.
if ((live_count > 1)); then
	echo "apply.sh: REFUSED - the zone holds ${live_count} rate limiting rules," >&2
	echo "  and applying this payload would delete every one it does not describe:" >&2
	jq -r '.result.rules[] | "    \(.description // "(no description)")  \(.expression)"' <<<"${live}" >&2
	echo "  Reconcile by hand, or capture the one you mean with --capture." >&2
	exit 1
fi

if ((live_count == 0)); then
	# Nothing to lose and nothing to compare. Worth saying out loud, because
	# an empty phase means the API currently has NO rate limiting at all.
	echo "apply.sh: the zone has no rate limiting rule; applying the payload creates it."
	live_rule='{}'
else
	live_rule="$(strip_server_assigned)"
fi

# Capture writes before anything compares, and that order is deliberate.
# Refusal two below exists to stop an APPLY from dropping a field the payload
# does not describe - but absorbing exactly those fields is what capture is
# for. Running the refusal first would make the recovery path it recommends
# impossible.
if [[ "${MODE}" == "capture" ]]; then
	# Keep the prose, take everything else from the zone. Writing via a temp
	# file so a failure cannot leave a half-written payload behind.
	tmp="$(mktemp)"
	if [[ -f "${PAYLOAD}" ]]; then
		jq -S --argjson captured "${live_rule}" \
			'$captured + (if has("_comment") then {_comment} else {} end)' \
			"${PAYLOAD}" >"${tmp}"
	else
		jq -S -n --argjson captured "${live_rule}" '$captured' >"${tmp}"
	fi
	mv "${tmp}" "${PAYLOAD}"
	echo "apply.sh: captured the live rule into ${PAYLOAD}. Review the diff."
	exit 0
fi

desired="$(desired_rule)"

if [[ "${live_rule}" == "${desired}" ]]; then
	echo "apply.sh: the live rule already matches the payload; nothing to do."
	exit 0
fi

# REFUSAL TWO: the live rule carries something the payload does not describe.
#
# Leaf paths rather than top-level keys, so this also catches a characteristic
# added to the array or a field added inside `ratelimit`. The server-assigned
# set is already gone from live_rule above, which is what keeps this from
# firing on `id` every time.
#
# This is the analog of scripts/sentry/apply.sh refusing a workflow "listening
# to anything this file does not describe". A counting expression or a
# requests_to_origin set in the dashboard is a deliberate act, and an apply
# that dropped it would look exactly like an apply that worked.
undescribed="$(jq -r -n \
	--argjson live "${live_rule}" \
	--argjson want "${desired}" '
	def leaves: [paths(scalars) | map(tostring) | join(".")];
	(($live | leaves) - ($want | leaves)) | .[]' || true)"

if [[ -n "${undescribed}" ]]; then
	echo "apply.sh: REFUSED - the live rule carries fields this payload does not describe," >&2
	echo "  so applying it would drop them:" >&2
	while IFS= read -r path; do
		[[ -n "${path}" ]] || continue
		echo "    ${path}" >&2
	done <<<"${undescribed}"
	echo "  Fold them into the payload, or re-sync with --capture and review the diff." >&2
	exit 1
fi

echo "apply.sh: the live rule differs from the payload. Applying:"
diff <(printf '%s\n' "${live_rule}") <(printf '%s\n' "${desired}") || true

# Any change clears the rule's currently triggered actions, per Cloudflare's own
# docs - so an apply during an attack releases whatever is presently blocked.
applied="$(request PUT "${ENTRYPOINT}" "$(desired_body)")"
require_success "${applied}" "the rule"

echo "apply.sh: applied. The zone now meters:"
jq -r '.result.rules[] | "  \(.expression)"' <<<"${applied}"
