#!/usr/bin/env bash
# Offline tests for scripts/seed-dev-projects.sh.
#
# The promise worth pinning is that it cannot reach a real database, so pnpm is
# stubbed to record every command the script runs.
set -uo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SEED="${SCRIPT_DIR}/seed-dev-projects.sh"

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

stub="$(mktemp -d)"
trap 'rm -rf "${stub}"' EXIT
record="${stub}/calls"
# Answers the account lookup with a row unless STUB_NO_ACCOUNT is set.
cat >"${stub}/pnpm" <<EOF
#!/bin/sh
echo "\$*" >>"${record}"
[ -z "\${STUB_NO_ACCOUNT:-}" ] && echo '[{"results":[{"id":"u1"}]}]'
exit 0
EOF
chmod +x "${stub}/pnpm"

echo "seed-dev-projects.sh: arguments"

for bad in "" "not-an-address" "a'b@example.com" "a@example.com'; DROP TABLE users;--"; do
	: >"${record}"
	actual=0
	PATH="${stub}:${PATH}" "${SEED}" "${bad}" >/dev/null 2>&1 || actual=$?
	if [[ "${actual}" == "2" && ! -s "${record}" ]]; then
		pass "refuses '${bad}' before running anything"
	else
		fail "refuses '${bad}' before running anything" "exit ${actual}"
	fi
done

echo
echo "seed-dev-projects.sh: where it writes"

: >"${record}"
PATH="${stub}:${PATH}" "${SEED}" dev@example.com >/dev/null 2>&1
if [[ "$(wc -l <"${record}" | tr -d ' ')" == "2" ]]; then
	pass "looks the account up, then writes"
else
	fail "looks the account up, then writes" "$(cat "${record}")"
fi
if [[ "$(grep -c -- '--local --env development' "${record}")" == "2" ]] &&
	! grep -q -- '--remote' "${record}"; then
	pass "every call is local"
else
	fail "every call is local" "$(cat "${record}")"
fi

: >"${record}"
actual=0
output="$(STUB_NO_ACCOUNT=1 PATH="${stub}:${PATH}" "${SEED}" dev@example.com 2>&1)" || actual=$?
if [[ "${actual}" == "2" && "${output}" == *"dev@example.com"* ]] &&
	[[ "$(wc -l <"${record}" | tr -d ' ')" == "1" ]]; then
	pass "an unknown account exits 2 without writing"
else
	fail "an unknown account exits 2 without writing" "exit ${actual}: ${output}"
fi

echo
echo "seed-dev-projects.sh: what it writes"

sql="$(SEED_PRINT_SQL=1 "${SEED}" dev@example.com)"

if [[ "$(grep -c 'INTO session_summaries' <<<"${sql}")" == "7" &&
	"$(grep -c 'INTO session_projects' <<<"${sql}")" == "8" ]]; then
	pass "one summary per session, one index row per project in it"
else
	fail "one summary per session, one index row per project in it" "wrong counts"
fi

if [[ "$(grep -n 'DELETE FROM machine_tokens' <<<"${sql}" | cut -d: -f1)" == "1" ]]; then
	pass "clears the last run before writing"
else
	fail "clears the last run before writing" "the delete is not first"
fi

if grep 'DELETE FROM machine_tokens' <<<"${sql}" | grep -q "LIKE 'seed-%'"; then
	pass "clears only what it wrote"
else
	fail "clears only what it wrote" "the delete is not scoped to seed- rows"
fi

echo
if ((failures > 0)); then
	echo "seed-dev-projects.test.sh: ${failures} of ${tests} tests failed"
	exit 1
fi

echo "seed-dev-projects.test.sh: all ${tests} tests passed"
