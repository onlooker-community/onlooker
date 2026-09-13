#!/usr/bin/env bash
# Applies the issue alert rules in scripts/sentry/rules/ to Sentry.
#
# Why the rules live in files rather than in the Sentry UI: an alert rule is
# the part of monitoring that decides whether a human ever hears about a
# fault, and a hand-clicked one is invisible to review, undiffable, and gone
# the moment somebody tidies it away. Here, changing who gets told is a pull
# request.
#
# Usage: scripts/sentry/apply.sh [--dry-run] [rule.json...]
#   no file arguments means every rule in scripts/sentry/rules/
#
# Env:
#   SENTRY_AUTH_TOKEN  required unless --dry-run. Needs org:read + alerts:write.
#   SENTRY_ORG         defaults to onlooker-vw
#
# Exit codes, three-way for the reason client-error-monitor.sh gives:
#   0 - every rule applied (or, under --dry-run, every rule is well formed)
#   1 - Sentry rejected a rule, or a rule is malformed
#   2 - this script could not do its job at all
#
# THE TOKEN IS NEVER PRINTED and never passed as an argv element - it is read
# from the environment into a curl config on stdin, so it stays out of `ps`,
# out of the shell history, and out of any transcript of a run. Keep it that
# way: a `set -x` added for debugging would undo all three at once.
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly RULES_DIR="${SCRIPT_DIR}/rules"
readonly ORG="${SENTRY_ORG:-onlooker-vw}"
readonly API="${SENTRY_API_BASE:-https://sentry.io/api/0}"

DRY_RUN=0
declare -a RULE_FILES=()

while (($# > 0)); do
	case "$1" in
		--dry-run) DRY_RUN=1 ;;
		-h | --help)
			sed -n '2,20p' "${BASH_SOURCE[0]}"
			exit 0
			;;
		-*)
			echo "unknown option: $1" >&2
			exit 2
			;;
		*) RULE_FILES+=("$1") ;;
	esac
	shift
done

if ((${#RULE_FILES[@]} == 0)); then
	while IFS= read -r file; do RULE_FILES+=("${file}"); done \
		< <(find "${RULES_DIR}" -maxdepth 1 -name '*.json' | sort)
fi

if ((${#RULE_FILES[@]} == 0)); then
	echo "no rule files found in ${RULES_DIR}" >&2
	exit 2
fi

command -v jq >/dev/null 2>&1 || {
	echo "jq is required" >&2
	exit 2
}

if ((DRY_RUN == 0)) && [[ -z "${SENTRY_AUTH_TOKEN:-}" ]]; then
	echo "SENTRY_AUTH_TOKEN is not set." >&2
	echo "Run this under 1Password rather than exporting the token:" >&2
	echo "  SENTRY_AUTH_TOKEN=\"op://<vault>/<item>/credential\" \\" >&2
	echo "    op run -- scripts/sentry/apply.sh" >&2
	exit 2
fi

# curl, with the token supplied on stdin instead of the command line.
api() {
	local method="$1" path="$2" body="${3:-}"
	local -a args=(--silent --show-error --config - --request "${method}"
		--header "Content-Type: application/json"
		--write-out $'\n%{http_code}')
	[[ -n "${body}" ]] && args+=(--data "${body}")

	printf 'header = "Authorization: Bearer %s"\nurl = "%s%s"\n' \
		"${SENTRY_AUTH_TOKEN}" "${API}" "${path}" | curl "${args[@]}"
}

# The environment filter is the whole safety story for this setup: staging and
# production share one project per app and are told apart by this tag alone.
# A rule that loses it does not fail - it starts paging a human for somebody's
# work in progress, which is how an alert channel gets muted, which costs the
# production signal too.
assert_production_scoped() {
	local file="$1" environment
	environment="$(jq -r '.rule.environment // empty' "${file}")"

	if [[ "${environment}" != "production" ]]; then
		echo "  REFUSED  ${file##*/}: environment is '${environment:-unset}', expected 'production'" >&2
		return 1
	fi
}

# Ask Sentry which condition and action ids it actually accepts, rather than
# trusting the strings in the rule files. A wrong id is a 400 with a body that
# does not name the offending entry; this turns that into a line that does.
validate_against_configuration() {
	local file="$1" project="$2" response body status
	response="$(api GET "/projects/${ORG}/${project}/rules/configuration/")"
	status="$(tail -n1 <<<"${response}")"
	body="$(sed '$d' <<<"${response}")"

	if [[ "${status}" != "200" ]]; then
		echo "  ERROR    could not read rule configuration for project ${project} (HTTP ${status})" >&2
		return 1
	fi

	local known unknown
	known="$(jq -r '[.conditions[].id, .filters[].id, .actions[].id] | unique | .[]' <<<"${body}")"
	unknown="$(jq -r '[.rule.conditions[]?.id, .rule.filters[]?.id, .rule.actions[]?.id] | .[]' "${file}" |
		grep -Fxv -f <(printf '%s\n' "${known}") || true)"

	if [[ -n "${unknown}" ]]; then
		echo "  ERROR    ${file##*/} names ids this org does not offer:" >&2
		while IFS= read -r id; do echo "             ${id}" >&2; done <<<"${unknown}"
		return 1
	fi
}

# Create, or update the rule that already carries this name. Matching on the
# name is what keeps a re-run from stacking up duplicate rules, each firing
# its own copy of the same email.
apply_rule() {
	local file="$1"
	local project rule name
	project="$(jq -r '.project' "${file}")"
	rule="$(jq -c '.rule' "${file}")"
	name="$(jq -r '.rule.name' "${file}")"

	if ((DRY_RUN == 1)); then
		echo "  would apply  ${name}  ->  project ${project}"
		jq -c '.rule' "${file}" | sed 's/^/                 /'
		return 0
	fi

	validate_against_configuration "${file}" "${project}" || return 1

	local existing response status
	response="$(api GET "/projects/${ORG}/${project}/rules/")"
	status="$(tail -n1 <<<"${response}")"
	if [[ "${status}" != "200" ]]; then
		echo "  ERROR    could not list rules for project ${project} (HTTP ${status})" >&2
		return 1
	fi
	existing="$(sed '$d' <<<"${response}" |
		jq -r --arg name "${name}" '.[] | select(.name == $name) | .id' | head -n1)"

	local method path verb
	if [[ -n "${existing}" ]]; then
		method=PUT path="/projects/${ORG}/${project}/rules/${existing}/" verb=updated
	else
		method=POST path="/projects/${ORG}/${project}/rules/" verb=created
	fi

	response="$(api "${method}" "${path}" "${rule}")"
	status="$(tail -n1 <<<"${response}")"

	if [[ "${status}" == "200" || "${status}" == "201" ]]; then
		echo "  ok       ${verb}: ${name}"
		return 0
	fi

	echo "  ERROR    ${name} rejected (HTTP ${status}):" >&2
	sed '$d' <<<"${response}" | head -c 600 | sed 's/^/             /' >&2
	echo >&2
	return 1
}

if ((DRY_RUN == 1)); then
	echo "sentry: ${#RULE_FILES[@]} rule(s) for ${ORG} (dry run, no requests made)"
else
	echo "sentry: applying ${#RULE_FILES[@]} rule(s) to ${ORG}"
fi

failures=0
for file in "${RULE_FILES[@]}"; do
	if [[ ! -r "${file}" ]]; then
		echo "  ERROR    cannot read ${file}" >&2
		failures=$((failures + 1))
		continue
	fi

	if ! jq -e '.project and .rule.name' "${file}" >/dev/null 2>&1; then
		echo "  ERROR    ${file##*/} needs a .project and a .rule.name" >&2
		failures=$((failures + 1))
		continue
	fi

	assert_production_scoped "${file}" || {
		failures=$((failures + 1))
		continue
	}

	apply_rule "${file}" || failures=$((failures + 1))
done

if ((failures > 0)); then
	echo "sentry: ${failures} rule(s) did not apply" >&2
	exit 1
fi

if ((DRY_RUN == 1)); then
	echo "sentry: all rules are well formed. Nothing was applied."
else
	echo "sentry: all rules applied"
fi
