#!/usr/bin/env bash
# Offline tests for scripts/sentry/apply.sh. These make no network requests.
#
# What they are really guarding is the environment filter. apps/web and apps/api
# each report staging and production into ONE Sentry project, told apart by the
# environment tag and nothing else. A rule that loses that tag does not fail and
# does not look wrong - it quietly starts paging a human for somebody's work in
# progress. The predictable end of that is a muted alert channel, which costs
# the production signal too, and the alerts would then be worse than none
# because the silence reads as health.
#
# So: every rule file is asserted to be production-scoped, and the script is
# asserted to REFUSE one that is not. The second half matters more than the
# first - the files here are correct today, and the point is that tomorrow's
# cannot be wrong without failing CI.
set -uo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly APPLY="${SCRIPT_DIR}/apply.sh"
readonly RULES_DIR="${SCRIPT_DIR}/rules"

tests=0
failures=0

pass() {
	tests=$((tests + 1))
	echo "  ok    $1"
}

fail() {
	tests=$((tests + 1))
	failures=$((failures + 1))
	echo "  FAIL  $1 -> $2"
}

expect_exit() {
	local expected="$1" description="$2"
	shift 2

	local actual=0
	"$@" >/dev/null 2>&1 || actual=$?

	if [[ "${actual}" == "${expected}" ]]; then
		pass "${description}"
	else
		fail "${description}" "exit ${actual}, expected ${expected}"
	fi
}

echo
echo "sentry/apply: the rules it ships with"

for file in "${RULES_DIR}"/*.json; do
	name="$(basename "${file}")"

	if jq -e . "${file}" >/dev/null 2>&1; then
		pass "${name} is valid JSON"
	else
		fail "${name} is valid JSON" "jq could not parse it"
		continue
	fi

	# The invariant this whole file exists for.
	environment="$(jq -r '.workflow.environment // empty' "${file}")"
	if [[ "${environment}" == "production" ]]; then
		pass "${name} is scoped to production"
	else
		fail "${name} is scoped to production" "environment is '${environment:-unset}'"
	fi

	# A rule with no action fires into nothing. Sentry accepts it; a human
	# reading the rule list sees a rule that looks armed.
	if [[ "$(jq -r '.workflow.actionFilters[0].actions | length' "${file}")" -gt 0 ]]; then
		pass "${name} tells somebody"
	else
		fail "${name} tells somebody" "actions is empty"
	fi

	# Numeric, because it comes from the DSN path. A slug would still work
	# against the API and would break the day somebody renames the project.
	if [[ "$(jq -r '.project' "${file}")" =~ ^[0-9]+$ ]]; then
		pass "${name} names its project by id"
	else
		fail "${name} names its project by id" "project is not numeric"
	fi
done

echo
echo "sentry/apply: what it refuses"

# Every rule file in the repo, checked without touching the network.
expect_exit 0 "a dry run over the shipped rules succeeds" \
	env -u SENTRY_AUTH_TOKEN "${APPLY}" --dry-run

# The failure mode this guards: a token-less run that silently does nothing
# would be indistinguishable from a run that applied everything.
expect_exit 2 "refuses to run for real with no token" \
	env -u SENTRY_AUTH_TOKEN "${APPLY}"

expect_exit 2 "refuses an unknown option" \
	env -u SENTRY_AUTH_TOKEN "${APPLY}" --wat

expect_exit 1 "refuses a rule file it cannot read" \
	env -u SENTRY_AUTH_TOKEN "${APPLY}" --dry-run /nonexistent/rule.json

staging_rule="$(mktemp -t sentry-rule-XXXXXX).json"
jq '.workflow.environment = "staging"' "${RULES_DIR}/api-faults.json" >"${staging_rule}"
expect_exit 1 "refuses a rule that is not scoped to production" \
	env -u SENTRY_AUTH_TOKEN "${APPLY}" --dry-run "${staging_rule}"

unscoped_rule="$(mktemp -t sentry-rule-XXXXXX).json"
jq 'del(.workflow.environment)' "${RULES_DIR}/api-faults.json" >"${unscoped_rule}"
expect_exit 1 "refuses a rule with no environment at all" \
	env -u SENTRY_AUTH_TOKEN "${APPLY}" --dry-run "${unscoped_rule}"

shapeless_rule="$(mktemp -t sentry-rule-XXXXXX).json"
echo '{"workflow":{"environment":"production"}}' >"${shapeless_rule}"
expect_exit 1 "refuses a rule with no project or name" \
	env -u SENTRY_AUTH_TOKEN "${APPLY}" --dry-run "${shapeless_rule}"

rm -f "${staging_rule}" "${unscoped_rule}" "${shapeless_rule}"

echo
echo "sentry/apply: what it says when it cannot see"

# The property: a run that could not READ a project must never report that
# project as clean. This was broken and shipped - report_drift skipped an
# unreadable project and then printed "no drift" from a loop that had read
# nothing, which happened for real on 2026-09-13 when every request answered
# 410 during a deprecation brownout. A tool built to catch green-while-blind
# was itself green while blind.
#
# 127.0.0.1:9 is the discard port: nothing listens, so curl fails to connect
# without waiting on DNS or a timeout.
blind_output="$(env SENTRY_AUTH_TOKEN=not-a-real-value \
	SENTRY_API_BASE="http://127.0.0.1:9" "${APPLY}" 2>&1 || true)"

if [[ "${blind_output}" != *"no drift"* ]]; then
	pass "does not claim 'no drift' when it could not read a single project"
else
	fail "does not claim 'no drift' when it could not read a single project" \
		"said 'no drift' while blind"
fi

# A workflow binds to a project only through a detector, so a run that cannot
# list detectors cannot apply anything at all. It stops there rather than
# attempting each file and printing the same error three times - but it must
# say so, because "nothing was applied" and "everything was applied" are the
# two outcomes a silent exit is ambiguous between.
if [[ "${blind_output}" == *"nothing was applied"* ]]; then
	pass "says plainly that nothing was applied when detectors cannot be listed"
else
	fail "says plainly that nothing was applied when detectors cannot be listed" \
		"no such statement: ${blind_output}"
fi

if [[ "${blind_output}" == *"could not list detectors"* ]]; then
	pass "names the call that failed rather than just failing"
else
	fail "names the call that failed rather than just failing" "${blind_output}"
fi

# An unreachable Sentry must not abort the script before it reports. Under
# `set -e` a failed curl inside a `$(...)` assignment used to kill the run
# outright, with no output at all.
blind_exit=0
env SENTRY_AUTH_TOKEN=not-a-real-value SENTRY_API_BASE="http://127.0.0.1:9" \
	"${APPLY}" >/dev/null 2>&1 || blind_exit=$?
if [[ "${blind_exit}" == "1" ]]; then
	pass "exits 1 when it could not apply anything"
else
	fail "exits 1 when it could not apply anything" "exit ${blind_exit}"
fi

# The case that actually happened, which is NOT the same as unreachable:
# Sentry answers, curl exits 0, and the status is 410. The old script crashed
# on an unreachable host but printed a clean "no drift" against a reachable
# one that refused every request - so a connection-failure test would have
# missed the real bug entirely. This serves 410 with the same deprecation
# headers Sentry sends.
if command -v python3 >/dev/null 2>&1; then
	gone_port=8793
	python3 "${SCRIPT_DIR}/testdata/gone-server.py" "${gone_port}" >/dev/null 2>&1 &
	gone_pid=$!
	# Wait for the port rather than sleeping a guessed interval.
	for _ in $(seq 1 50); do
		curl -s -o /dev/null "http://127.0.0.1:${gone_port}/" && break
		sleep 0.1
	done

	gone_output="$(env SENTRY_AUTH_TOKEN=not-a-real-value \
		SENTRY_API_BASE="http://127.0.0.1:${gone_port}" "${APPLY}" 2>&1 || true)"
	kill "${gone_pid}" 2>/dev/null || true
	wait "${gone_pid}" 2>/dev/null || true

	if [[ "${gone_output}" != *"no drift"* ]]; then
		pass "does not claim 'no drift' when every request answers 410"
	else
		fail "does not claim 'no drift' when every request answers 410" \
			"said 'no drift' while every read was refused"
	fi

	if [[ "${gone_output}" == *"Sentry says to use:"* ]]; then
		pass "surfaces the replacement endpoint Sentry names in its headers"
	else
		fail "surfaces the replacement endpoint Sentry names in its headers" \
			"no replacement hint: ${gone_output}"
	fi

	# Repeated per project it buries the rule failures it is meant to explain.
	hint_count="$(grep -c "Sentry says to use:" <<<"${gone_output}" || true)"
	if [[ "${hint_count}" == "1" ]]; then
		pass "explains the deprecation once, not once per project"
	else
		fail "explains the deprecation once, not once per project" \
			"printed it ${hint_count} times"
	fi
else
	echo "  skip  410 brownout tests (python3 not available)"
fi

echo
echo "sentry/apply: which detector a rule binds to"

# Project 4512075995283456 carries two monitor_check_in_failure detectors, one
# per cron monitor. detector_for used to select on (projectId, type) and take
# `first`, so a rule naming only those two fields bound to whichever Sentry
# listed first - and one of the two fronts a monitor that was created DISABLED
# and receives nothing. Binding there produces a workflow that cannot fire,
# which is the fault onlooker-txcu.9 exists to remove. Picking silently is the
# bug; refusing out loud is the fix.
if command -v python3 >/dev/null 2>&1; then
	detectors_port=8794
	python3 "${SCRIPT_DIR}/testdata/detectors-server.py" "${detectors_port}" >/dev/null 2>&1 &
	detectors_pid=$!
	for _ in $(seq 1 50); do
		curl -s -o /dev/null "http://127.0.0.1:${detectors_port}/" && break
		sleep 0.1
	done

	# Built from a shipped rule so these test only the detector binding, and do
	# not quietly re-test the workflow payload alongside it.
	cron_base="$(mktemp -t sentry-rule-XXXXXX).json"
	jq '.project = "4512075995283456"
		| .detectorType = "monitor_check_in_failure"
		| .workflow.name = "Client error monitor missed a check-in (production)"' \
		"${RULES_DIR}/api-faults.json" >"${cron_base}"

	ambiguous_rule="$(mktemp -t sentry-rule-XXXXXX).json"
	cp "${cron_base}" "${ambiguous_rule}"

	named_rule="$(mktemp -t sentry-rule-XXXXXX).json"
	jq '.detectorName = "Client error monitor workflow"' "${cron_base}" >"${named_rule}"

	absent_rule="$(mktemp -t sentry-rule-XXXXXX).json"
	jq '.detectorName = "No such detector"' "${cron_base}" >"${absent_rule}"

	apply_against_fake() {
		env SENTRY_AUTH_TOKEN=not-a-real-value \
			SENTRY_API_BASE="http://127.0.0.1:${detectors_port}" \
			"${APPLY}" "$1" 2>&1 || true
	}

	# The exit code cannot carry this on its own. apply.sh exits 1 for a
	# malformed file, an unscoped one and a Sentry rejection alike, so an
	# exit-only assertion would pass whether or not this branch exists at all.
	# It has to be caught saying which fault it hit.
	ambiguous_output="$(apply_against_fake "${ambiguous_rule}")"
	if [[ "${ambiguous_output}" == *"ambiguous"* ]]; then
		pass "refuses a rule whose (project, type) matches two detectors"
	else
		fail "refuses a rule whose (project, type) matches two detectors" \
			"${ambiguous_output}"
	fi

	# Listing the candidates is the difference between a refusal you can act on
	# and one that sends you to the Sentry UI to find the name yourself.
	if [[ "${ambiguous_output}" == *"10315978"* && "${ambiguous_output}" == *"10315979"* ]]; then
		pass "names both candidate detectors when it refuses"
	else
		fail "names both candidate detectors when it refuses" "${ambiguous_output}"
	fi

	# The positive case. It has to differ from the refusal in something the
	# refusal cannot produce - the bound id - rather than only in exit status.
	named_output="$(apply_against_fake "${named_rule}")"
	if [[ "${named_output}" == *"detector 10315979"* ]]; then
		pass "binds to the detector the rule names"
	else
		fail "binds to the detector the rule names" "${named_output}"
	fi

	# The half that matters: not merely that it found the right one, but that
	# the wrong one is nowhere in the result.
	if [[ "${named_output}" == *"10315978"* ]]; then
		fail "leaves the other detector of that type alone" \
			"named the heartbeat detector: ${named_output}"
	else
		pass "leaves the other detector of that type alone"
	fi

	absent_output="$(apply_against_fake "${absent_rule}")"
	if [[ "${absent_output}" == *"named 'No such detector'"* ]]; then
		pass "errors when detectorName matches no detector"
	else
		fail "errors when detectorName matches no detector" "${absent_output}"
	fi

	kill "${detectors_pid}" 2>/dev/null || true
	wait "${detectors_pid}" 2>/dev/null || true
	rm -f "${cron_base}" "${ambiguous_rule}" "${named_rule}" "${absent_rule}"
else
	echo "  skip  detector binding tests (python3 not available)"
fi

echo
if ((failures > 0)); then
	echo "apply.test.sh: ${failures} of ${tests} tests failed"
	exit 1
fi
echo "apply.test.sh: all ${tests} tests passed"
