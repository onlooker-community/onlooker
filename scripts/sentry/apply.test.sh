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
	environment="$(jq -r '.rule.environment // empty' "${file}")"
	if [[ "${environment}" == "production" ]]; then
		pass "${name} is scoped to production"
	else
		fail "${name} is scoped to production" "environment is '${environment:-unset}'"
	fi

	# A rule with no action fires into nothing. Sentry accepts it; a human
	# reading the rule list sees a rule that looks armed.
	if [[ "$(jq -r '.rule.actions | length' "${file}")" -gt 0 ]]; then
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
jq '.rule.environment = "staging"' "${RULES_DIR}/api-faults.json" >"${staging_rule}"
expect_exit 1 "refuses a rule that is not scoped to production" \
	env -u SENTRY_AUTH_TOKEN "${APPLY}" --dry-run "${staging_rule}"

unscoped_rule="$(mktemp -t sentry-rule-XXXXXX).json"
jq 'del(.rule.environment)' "${RULES_DIR}/api-faults.json" >"${unscoped_rule}"
expect_exit 1 "refuses a rule with no environment at all" \
	env -u SENTRY_AUTH_TOKEN "${APPLY}" --dry-run "${unscoped_rule}"

shapeless_rule="$(mktemp -t sentry-rule-XXXXXX).json"
echo '{"rule":{"environment":"production"}}' >"${shapeless_rule}"
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

if [[ "${blind_output}" == *"drift not checked"* ]]; then
	pass "says drift was not checked, per project"
else
	fail "says drift was not checked, per project" "no per-project notice: ${blind_output}"
fi

if [[ "${blind_output}" == *"drift UNKNOWN"* ]]; then
	pass "summarizes how many projects went unchecked"
else
	fail "summarizes how many projects went unchecked" "no summary line"
fi

# An unreachable Sentry must not abort the script before it reports. Under
# `set -e` a failed curl inside a `$(...)` assignment used to kill the run.
if [[ "${blind_output}" == *"did not apply"* ]]; then
	pass "still reports which rules did not apply when Sentry is unreachable"
else
	fail "still reports which rules did not apply when Sentry is unreachable" \
		"no failure summary: ${blind_output}"
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
if ((failures > 0)); then
	echo "apply.test.sh: ${failures} of ${tests} tests failed"
	exit 1
fi
echo "apply.test.sh: all ${tests} tests passed"
