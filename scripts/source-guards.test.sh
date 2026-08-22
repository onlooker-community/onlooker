#!/usr/bin/env bash
# Assertions about source TEXT that the app's own suite cannot make.
#
# apps/api's vitest runs in the Cloudflare Workers pool, where node:fs throws.
# A guard that needs to know which FILES contain something therefore cannot
# live there. (A guard that only needs one function's body can - see
# Function.prototype.toString() in apps/api/src/utils/crypto.test.ts.)
set -uo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

echo
echo "source-guards: the lesson visibility boundary"

# The contract spec designates the visibility filter as the security boundary:
# "A bug there leaks private lessons, so it belongs in exactly one place rather
# than spread across every query site."
#
# That is only true while it stays in one place, and the natural way to break it
# is not to write a bug - it is to add a second query somewhere else that
# forgets the filter. No behavioral test notices that until it leaks, because
# the new query works fine for whoever wrote it.
offenders=""
for dir in routes middleware lessons utils; do
	path="${ROOT}/apps/api/src/${dir}"
	[[ -d "${path}" ]] || continue

	while IFS= read -r file; do
		case "${file}" in *.test.ts) continue ;; esac
		if grep -Eqi "FROM[[:space:]]+lessons|FROM[[:space:]]+lesson_feed" "${file}"; then
			offenders="${offenders} ${file#"${ROOT}/"}"
		fi
	done < <(find "${path}" -name '*.ts' -type f)
done

if [[ -n "${offenders}" ]]; then
	fail "no lesson query outside db/lessons.ts" "found in:${offenders}"
else
	pass "no lesson query outside db/lessons.ts"
fi

# The boundary is only meaningful if the module it lives in actually queries.
# Without this, deleting every query in the codebase would pass the check above.
if grep -Eqi "FROM[[:space:]]+lesson_feed" "${ROOT}/apps/api/src/db/lessons.ts"; then
	pass "db/lessons.ts is where the lesson queries live"
else
	fail "db/lessons.ts is where the lesson queries live" "no lesson_feed query found there"
fi

echo
if (( failures > 0 )); then
	echo "source-guards.test.sh: ${failures} of ${tests} tests failed"
	exit 1
fi

echo "source-guards.test.sh: all ${tests} tests passed"
