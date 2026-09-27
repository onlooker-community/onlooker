#!/usr/bin/env bash
# Applies the alert workflows in scripts/sentry/rules/ to Sentry.
#
# Why these live in files rather than in the Sentry UI: an alert decides
# whether a human ever hears about a fault, and a hand-clicked one is
# undiffable, unreviewable, and gone the moment somebody tidies it away. Here,
# changing who gets told is a pull request.
#
# THE MODEL, because it changed and the names are not obvious. Sentry retired
# the per-project rules API (deprecated 2026-05-14, then brownouts answering
# 410) in favour of two objects:
#
#   a DETECTOR is project-scoped and notices something - an issue appearing, a
#   metric crossing a threshold, a cron check-in going missing. Sentry creates
#   the standard ones with the project; `issue_stream` is the one that fires on
#   new issues.
#
#   a WORKFLOW is org-scoped and reacts. It names the detectors it listens to
#   in `detectorIds`, so that field is where a workflow's project binding now
#   lives - not the URL.
#
# So the files here name a project and a detector TYPE, and this script
# resolves the id. Pinning detector ids in the files would put a number that
# means nothing to a reviewer in the diff, and break whenever a project is
# recreated.
#
# A type does not always identify one detector. onlooker-api holds two of type
# monitor_check_in_failure, one per cron monitor, and one of those fronts a
# monitor created DISABLED that receives nothing - so a workflow bound to it
# cannot fire. A file may add an optional "detectorName" to say which it means;
# where that still leaves more than one match, this script REFUSES rather than
# choosing, because the wrong choice does not fail, it just never fires.
#
# The other direction has the same shape. ONE WORKFLOW CAN SERVE MANY DETECTORS,
# and a file here resolves exactly one - so because an update PUTs the whole
# workflow, applying a file can REPLACE bindings it never knew about. Connecting
# an alert to a monitor in the Sentry UI attaches it to a matching workflow
# rather than making its own, which is how a workflow acquires one. So a
# workflow listening to anything this file does not describe is REFUSED too, and
# report_drift names the binding. Neither outcome announces itself: an unbound
# monitor keeps detecting, its workflow keeps alerting, and only the path
# between them and a human is gone.
#
# Usage: scripts/sentry/apply.sh [--dry-run] [rule.json...]
#   no file arguments means every rule in scripts/sentry/rules/
#
# Env:
#   SENTRY_AUTH_TOKEN  required unless --dry-run. Needs org:read + alerts:write.
#   SENTRY_ORG         defaults to onlooker-vw
#
# Exit codes, three-way for the reason client-error-monitor.sh gives:
#   0 - every workflow applied (or, under --dry-run, every file is well formed)
#   1 - Sentry rejected one, or a file is malformed
#   2 - this script could not do its job at all
#
# THE TOKEN IS NEVER PRINTED and never passed as an argv element - it is read
# from the environment into a curl config on stdin, so it stays out of `ps`,
# out of shell history, and out of any transcript of a run. Keep it that way: a
# `set -x` added for debugging would undo all three at once.
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly RULES_DIR="${SCRIPT_DIR}/rules"
# Overridable for the same reason SENTRY_API_BASE is: positional arguments go
# to RULE_FILES, so without this there is no way to point the dashboard path at
# a fixture, and its guard can only be tested through a file that the WORKFLOW
# path rejects first - which is a test that passes for the wrong reason.
readonly DASHBOARDS_DIR="${SENTRY_DASHBOARDS_DIR:-${SCRIPT_DIR}/dashboards}"
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
		# The payload directories this script actually sends, one per line.
		# apply.test.sh reads this and fails if a directory of payloads is
		# neither listed here nor explained in unapplied.txt - because a
		# committed payload nothing sends looks identical, in a diff, to one
		# that ships. alerts/ was exactly that for twelve days.
		--applied-dirs)
			basename "${RULES_DIR}"
			basename "${DASHBOARDS_DIR}"
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

HEADERS="$(mktemp -t sentry-apply-headers-XXXXXX)"
trap 'rm -f "${HEADERS}"' EXIT

# curl, with the token supplied on stdin instead of the command line.
api() {
	local method="$1" path="$2" body="${3:-}"
	local -a args=(--silent --show-error --config - --request "${method}"
		--header "Content-Type: application/json"
		--dump-header "${HEADERS}"
		--write-out $'\n%{http_code}')
	[[ -n "${body}" ]] && args+=(--data "${body}")

	# `|| true` so an unreachable Sentry is reportable rather than fatal. Under
	# `set -e` a failed curl inside `response="$(api ...)"` aborts the script.
	# Callers all branch on the status line, and a curl that never connected
	# simply produces none.
	printf 'header = "Authorization: Bearer %s"\nurl = "%s%s"\n' \
		"${SENTRY_AUTH_TOKEN}" "${API}" "${path}" | curl "${args[@]}" || true
}

# Said once per run: every call hits the same endpoints, so repeating it per
# file buries the failures it is meant to explain.
DEPRECATION_REPORTED=0

deprecation_note() {
	((DEPRECATION_REPORTED == 0)) || return 0

	local replacement deprecated
	replacement="$(grep -i '^x-sentry-replacement-endpoint:' "${HEADERS}" 2>/dev/null |
		tr -d '\r' | cut -d' ' -f2- || true)"
	deprecated="$(grep -i '^x-sentry-deprecation-date:' "${HEADERS}" 2>/dev/null |
		tr -d '\r' | cut -d' ' -f2- || true)"

	[[ -n "${replacement}" ]] || return 0
	DEPRECATION_REPORTED=1
	echo "           this endpoint was deprecated on ${deprecated:-an unstated date}" >&2
	echo "           Sentry says to use: ${replacement}" >&2
	echo "           A 410 here is a scheduled brownout, not a bad token." >&2
}

status_of() { tail -n1 <<<"$1"; }
body_of() { sed '$d' <<<"$1"; }

# The environment filter is the whole safety story for this setup: staging and
# production report into ONE project per app and are told apart by this tag
# alone. A workflow that loses it does not fail - it starts paging a human for
# somebody's work in progress, which is how an alert channel gets muted, which
# costs the production signal too.
assert_production_scoped() {
	local file="$1" environment
	environment="$(jq -r '.workflow.environment // empty' "${file}")"

	if [[ "${environment}" != "production" ]]; then
		echo "  REFUSED  ${file##*/}: environment is '${environment:-unset}', expected 'production'" >&2
		return 1
	fi
}

DETECTORS=""

# Fetch the org's detectors once, so each file can be bound by (project, type).
load_detectors() {
	local response status
	response="$(api GET "/organizations/${ORG}/detectors/")"
	status="$(status_of "${response}")"

	if [[ "${status}" != "200" ]]; then
		echo "  ERROR    could not list detectors (HTTP ${status})" >&2
		deprecation_note
		return 1
	fi

	DETECTORS="$(body_of "${response}")"
}

# Every detector a file could bind to, one `id<TAB>name` per line: those
# matching its project and type, narrowed by name when the file gives one.
#
# This used to return `first` of the matches, which is only correct while a
# project holds one detector per type. onlooker-api holds two of type
# monitor_check_in_failure, one per cron monitor, and one of those fronts a
# monitor created DISABLED that receives nothing - so `first` could bind a
# workflow to a monitor that never fires. The caller refuses rather than
# choosing; see apply_workflow.
detectors_matching() {
	local project="$1" type="$2" name="${3:-}"
	jq -r --arg p "${project}" --arg t "${type}" --arg n "${name}" \
		'[.[] | select((.projectId|tostring) == $p and .type == $t)
			| select($n == "" or .name == $n)]
		| .[] | [.id, .name] | @tsv' \
		<<<"${DETECTORS}"
}

# A detector id on its own says nothing about what it watches, and both the
# refusal and the drift report exist to be acted on without a trip to the UI.
detector_name() {
	jq -r --arg id "$1" \
		'[.[] | select((.id|tostring) == $id) | .name] | first // "name unknown"' \
		<<<"${DETECTORS}"
}

apply_workflow() {
	local file="$1"
	local project type name wanted detector payload

	project="$(jq -r '.project' "${file}")"
	type="$(jq -r '.detectorType' "${file}")"
	name="$(jq -r '.workflow.name' "${file}")"
	wanted="$(jq -r '.detectorName // empty' "${file}")"

	if ((DRY_RUN == 1)); then
		echo "  would apply  ${name}  ->  project ${project}, detector type ${type}${wanted:+, named ${wanted}}"
		jq -c '.workflow' "${file}" | sed 's/^/                 /'
		return 0
	fi

	local -a matches=()
	while IFS= read -r line; do
		[[ -n "${line}" ]] && matches+=("${line}")
	done < <(detectors_matching "${project}" "${type}" "${wanted}")

	if ((${#matches[@]} == 0)); then
		echo "  ERROR    ${name}: project ${project} has no '${type}' detector${wanted:+ named '${wanted}'}" >&2
		if [[ -n "${wanted}" ]]; then
			echo "           No detector of that type in this project carries that" >&2
			echo "           name. A detector renamed in Sentry has to be renamed" >&2
			echo "           here too - the name is how this file finds it." >&2
		else
			echo "           Sentry creates the standard ones with a project, so this" >&2
			echo "           usually means the project id is wrong rather than that a" >&2
			echo "           detector is missing." >&2
		fi
		return 1
	fi

	# Refusing beats choosing. Two detectors of a type means one of them is
	# probably not the one you want, and binding to the wrong one does not fail
	# - it produces a workflow that sits there looking configured and never
	# fires, which is the fault this whole epic exists to remove.
	if ((${#matches[@]} > 1)); then
		echo "  REFUSED  ${name}: ambiguous. ${#matches[@]} detectors in project" >&2
		echo "           ${project} are of type '${type}', and this file names" >&2
		echo "           none of them." >&2
		echo "           Add a \"detectorName\" to it, one of:" >&2
		printf '             %s\n' "${matches[@]}" >&2
		return 1
	fi

	detector="${matches[0]%%$'\t'*}"

	# detectorIds is injected rather than stored in the file - see the header.
	payload="$(jq -c --arg d "${detector}" '.workflow + {detectorIds: [$d]}' "${file}")"

	local response status existing
	response="$(api GET "/organizations/${ORG}/workflows/")"
	status="$(status_of "${response}")"
	if [[ "${status}" != "200" ]]; then
		echo "  ERROR    could not list workflows (HTTP ${status})" >&2
		deprecation_note
		return 1
	fi
	# Matching on the name is what keeps a re-run from stacking up duplicate
	# workflows, each firing its own copy of the same email.
	#
	# The bindings come back with it because the PUT below replaces them, and a
	# workflow can be listening to detectors this file knows nothing about.
	local bindings=""
	IFS=$'\t' read -r existing bindings < <(body_of "${response}" |
		jq -r --arg name "${name}" \
			'[.[] | select(.name == $name)
				| [.id, ((.detectorIds // []) | join(","))]]
			| first // [] | @tsv') || true

	# A PUT sends the whole workflow, so detectorIds is REPLACED, not merged -
	# and this file resolves exactly one detector while Sentry's model lets one
	# workflow serve many. Connecting an alert to a monitor in the UI attaches
	# it to a matching workflow rather than making a new one, so the workflow
	# can hold a binding no file here describes.
	#
	# Refusing beats merging, for the reason the ambiguity branch above refuses:
	# neither outcome fails. Applying would leave the workflow alerting and the
	# monitor detecting with nothing between them, and unioning the live
	# bindings in would quietly make the UI the source of truth for who gets
	# told - which is the whole thing these files exist to prevent.
	if [[ -n "${bindings}" ]]; then
		local -a undescribed=()
		local binding
		for binding in ${bindings//,/ }; do
			[[ "${binding}" == "${detector}" ]] || undescribed+=("${binding}")
		done

		if ((${#undescribed[@]} > 0)); then
			local live_count
			live_count="$(awk -F, '{print NF}' <<<"${bindings}")"
			echo "  REFUSED  ${name}: Sentry has it listening to ${live_count} detectors," >&2
			echo "           and ${file##*/} describes 1. Not applied - a PUT here" >&2
			echo "           would unbind:" >&2
			for binding in "${undescribed[@]}"; do
				echo "             ${binding}  $(detector_name "${binding}")" >&2
			done
			echo "           A rule file cannot name a second detector yet, so this" >&2
			echo "           cannot be resolved by editing it. Either disconnect that" >&2
			echo "           binding in Sentry, so this file describes the workflow" >&2
			echo "           again, or leave the file unapplied until it can." >&2
			return 1
		fi
	fi

	local method path verb
	if [[ -n "${existing}" ]]; then
		method=PUT path="/organizations/${ORG}/workflows/${existing}/" verb=updated
	else
		method=POST path="/organizations/${ORG}/workflows/" verb=created
	fi

	response="$(api "${method}" "${path}" "${payload}")"
	status="$(status_of "${response}")"

	if [[ "${status}" == "200" || "${status}" == "201" ]]; then
		echo "  ok       ${verb}: ${name}  (detector ${detector})"
		return 0
	fi

	echo "  ERROR    ${name} rejected (HTTP ${status}):" >&2
	body_of "${response}" | head -c 600 | sed 's/^/             /' >&2
	echo >&2
	deprecation_note
	return 1
}

# A dashboard's environment is an ARRAY, where a workflow's is a string. The
# two payloads are not variations on one shape - they go to different
# endpoints with different vocabularies for the same data, and
# dashboards/waitlist-funnel.json's own comment records that all three of its
# spellings (widget_type, the aggregate, the tags[] form) fail by rendering an
# EMPTY CHART rather than by erroring. That is why this has its own assertion
# instead of reusing assert_production_scoped: a dashboard scoped
# ["production","staging"] would pass a contains-check and quietly mix
# somebody's work in progress into the funnel.
assert_dashboard_production_scoped() {
	local file="$1" environments
	environments="$(jq -c '.environment // empty' "${file}")"

	if [[ "${environments}" != '["production"]' ]]; then
		echo "  REFUSED  ${file##*/}: environment is ${environments:-unset}, expected [\"production\"]" >&2
		return 1
	fi
}

# Dashboards are matched by title, the way workflows are matched by name: the
# id is assigned by Sentry and writing it into the file would put a number
# nobody can review into the diff. The cost is the same one the workflow path
# already accepts - rename the title here and the next run creates a second
# dashboard rather than renaming the first.
apply_dashboard() {
	local file="$1"
	local title payload response status existing

	title="$(jq -r '.title' "${file}")"

	if ((DRY_RUN == 1)); then
		echo "  would apply  dashboard: ${title}"
		return 0
	fi

	# _comment is ours, not Sentry's. Everything else in the file is the
	# payload, so the file stays readable as the thing it actually sends.
	payload="$(jq -c 'del(._comment)' "${file}")"

	response="$(api GET "/organizations/${ORG}/dashboards/")"
	status="$(status_of "${response}")"
	if [[ "${status}" != "200" ]]; then
		echo "  ERROR    could not list dashboards (HTTP ${status})" >&2
		deprecation_note
		return 1
	fi

	existing="$(body_of "${response}" |
		jq -r --arg title "${title}" '[.[] | select(.title == $title) | .id] | first // empty')"

	local method path verb
	if [[ -n "${existing}" ]]; then
		method=PUT path="/organizations/${ORG}/dashboards/${existing}/" verb=updated
	else
		method=POST path="/organizations/${ORG}/dashboards/" verb=created
	fi

	response="$(api "${method}" "${path}" "${payload}")"
	status="$(status_of "${response}")"

	if [[ "${status}" == "200" || "${status}" == "201" ]]; then
		echo "  ok       ${verb}: dashboard ${title}"
		return 0
	fi

	echo "  ERROR    dashboard ${title} rejected (HTTP ${status}):" >&2
	body_of "${response}" | head -c 600 | sed 's/^/             /' >&2
	echo >&2
	deprecation_note
	return 1
}

# Workflows that exist in Sentry, listen to one of our projects, and are in no
# file here.
#
# This script is additive: it creates and updates what the repo names, and
# without this it could not see anything else. That blindness had a cost the
# first time it ran - each project carried a default rule Sentry created with
# it, active and UNSCOPED, firing on staging and, for the website whose DSN is
# hard-coded, on local development.
#
# Reported rather than deleted, and it does not fail the run. A workflow added
# in the UI during an incident is a legitimate thing to find; the problem was
# never that one existed, only that nobody was told.
report_drift() {
	local response status ours known
	response="$(api GET "/organizations/${ORG}/workflows/")"
	status="$(status_of "${response}")"

	# Counted, not skipped. This used to `continue` past a failed read and then
	# report "no drift" from a check that had read nothing - the failure this
	# whole epic exists to remove, in the tool built to remove it. Observed for
	# real on 2026-09-13 when every read answered 410 during a brownout.
	if [[ "${status}" != "200" ]]; then
		echo "  UNKNOWN  could not list workflows (HTTP ${status}) - drift not checked" >&2
		deprecation_note
		return 0
	fi

	# Drift is a property of this REPO against Sentry, so both sides of the
	# comparison come from every rule the repo defines - not from whichever
	# files were named on the command line.
	#
	# Building these from RULE_FILES made a subset run slander its own config.
	# Observed on 2026-09-22 applying rules/cron-checkin-missed.json alone: it
	# reported "API fault (production)" as a workflow this repo does not define,
	# while rules/api-faults.json sitting beside it defines exactly that. Both
	# halves came from the same mistake - `known` held one name, and `ours`
	# narrowed to one project, which is why the web and website workflows went
	# unmentioned rather than being slandered too.
	#
	# Files named explicitly are unioned in, so applying one from outside
	# rules/ does not make that workflow its own drift.
	local -a known_files=()
	while IFS= read -r file; do
		[[ -r "${file}" ]] && known_files+=("${file}")
	done < <({
		find "${RULES_DIR}" -maxdepth 1 -name '*.json'
		printf '%s\n' "${RULE_FILES[@]}"
	} | sort -u)

	if ((${#known_files[@]} == 0)); then
		echo "  UNKNOWN  no readable rule files to compare against - drift not checked" >&2
		return 0
	fi

	# Only detectors belonging to projects this repo manages. A workflow bound
	# to some other project is not this repo's business to report.
	ours="$(jq -r '.project' "${known_files[@]}" | sort -u |
		while IFS= read -r project; do
			jq -r --arg p "${project}" '.[] | select((.projectId|tostring) == $p) | .id' <<<"${DETECTORS}"
		done)"
	known="$(jq -r '.workflow.name' "${known_files[@]}")"

	# Which detectors the repo says each workflow listens to, as
	# `name<TAB>detectorId` lines. Without this, drift compared NAMES alone, so
	# a workflow the repo defines was clean by definition no matter what it
	# actually listened to - which is why a binding made in the UI stayed
	# invisible until somebody read the workflow by hand.
	#
	# A file whose (project, type) matches two detectors contributes both, so
	# neither reads as drift. That is deliberate: apply_workflow refuses such a
	# file out loud, and reporting a second fault about the same ambiguity here
	# would only bury it.
	local described="" file f_name f_project f_type f_wanted line
	for file in "${known_files[@]}"; do
		f_name="$(jq -r '.workflow.name // empty' "${file}")"
		f_project="$(jq -r '.project // empty' "${file}")"
		f_type="$(jq -r '.detectorType // empty' "${file}")"
		f_wanted="$(jq -r '.detectorName // empty' "${file}")"
		[[ -n "${f_name}" && -n "${f_project}" && -n "${f_type}" ]] || continue

		while IFS= read -r line; do
			[[ -n "${line}" ]] || continue
			described+="${f_name}"$'\t'"${line%%$'\t'*}"$'\n'
		done < <(detectors_matching "${f_project}" "${f_type}" "${f_wanted}")
	done

	# One line per workflow as `id<TAB>name<TAB>detectorId,...`, then the set
	# membership is done in bash where it can be read.
	local found=0 id name detectors
	while IFS=$'\t' read -r id name detectors; do
		[[ -n "${id}" ]] || continue

		# Does it listen to any detector of ours?
		local mine=0
		for detector in ${detectors//,/ }; do
			grep -Fxq "${detector}" <<<"${ours}" && mine=1 && break
		done
		((mine == 1)) || continue

		# Defined here, so the question becomes whether the repo describes
		# everything it listens to. Reported even when no file for it was
		# applied this run, because the binding is drift whether or not
		# anybody happened to name that file on the command line.
		if grep -Fxq "${name}" <<<"${known}"; then
			for detector in ${detectors//,/ }; do
				grep -Fxq "${name}"$'\t'"${detector}" <<<"${described}" && continue
				found=1
				echo "  drift    ${name} listens to a detector this repo does not" \
					"describe: $(detector_name "${detector}") [id ${detector}]"
			done
			continue
		fi

		found=1
		echo "  drift    Sentry has a workflow this repo does not define: ${name} [id ${id}]"
	done < <(body_of "${response}" |
		jq -r '.[] | [.id, .name, ((.detectorIds // []) | join(","))] | @tsv')

	((found == 0)) && echo "  no drift: every workflow on these projects is defined here," \
		"listening only to detectors it describes"
	return 0
}

if ((DRY_RUN == 1)); then
	echo "sentry: ${#RULE_FILES[@]} workflow(s) for ${ORG} (dry run, no requests made)"
else
	echo "sentry: applying ${#RULE_FILES[@]} workflow(s) to ${ORG}"
fi

failures=0

if ((DRY_RUN == 0)); then
	load_detectors || {
		echo "sentry: could not resolve detectors; nothing was applied" >&2
		exit 1
	}
fi

for file in "${RULE_FILES[@]}"; do
	if [[ ! -r "${file}" ]]; then
		echo "  ERROR    cannot read ${file}" >&2
		failures=$((failures + 1))
		continue
	fi

	if ! jq -e '.project and .detectorType and .workflow.name' "${file}" >/dev/null 2>&1; then
		echo "  ERROR    ${file##*/} needs a .project, a .detectorType and a .workflow.name" >&2
		failures=$((failures + 1))
		continue
	fi

	assert_production_scoped "${file}" || {
		failures=$((failures + 1))
		continue
	}

	apply_workflow "${file}" || failures=$((failures + 1))
done

if ((DRY_RUN == 0)); then
	report_drift
fi

# Dashboards, after the workflows. Ordered this way because an alert that does
# not fire is a worse outage than a chart that does not render, so the thing
# that pages somebody goes first and a dashboard failure cannot stop it.
declare -a DASHBOARD_FILES=()
while IFS= read -r file; do DASHBOARD_FILES+=("${file}"); done \
	< <(find "${DASHBOARDS_DIR}" -maxdepth 1 -name '*.json' 2>/dev/null | sort)

if ((${#DASHBOARD_FILES[@]} > 0)); then
	echo
	if ((DRY_RUN == 1)); then
		echo "sentry: ${#DASHBOARD_FILES[@]} dashboard(s) for ${ORG} (dry run, no requests made)"
	else
		echo "sentry: applying ${#DASHBOARD_FILES[@]} dashboard(s) to ${ORG}"
	fi

	for file in "${DASHBOARD_FILES[@]}"; do
		if ! jq -e '.title and .widgets' "${file}" >/dev/null 2>&1; then
			echo "  ERROR    ${file##*/} needs a .title and .widgets" >&2
			failures=$((failures + 1))
			continue
		fi

		assert_dashboard_production_scoped "${file}" || {
			failures=$((failures + 1))
			continue
		}

		apply_dashboard "${file}" || failures=$((failures + 1))
	done
fi

if ((failures > 0)); then
	echo "sentry: ${failures} payload(s) did not apply" >&2
	exit 1
fi

if ((DRY_RUN == 1)); then
	echo "sentry: all files are well formed. Nothing was applied."
else
	echo "sentry: all workflows applied"
fi
