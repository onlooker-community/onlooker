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
# Which files may contain a lesson query: exactly one. Everything under
# apps/api/src is scanned, not a hand-listed set of directories - the realistic
# regression is someone adding a second query to a SIBLING of lessons.ts in
# db/, which a directory allowlist that omits db/ cannot see.
#
# The matcher squashes newlines before grepping. grep is line-oriented, so
# "FROM" on one line and the table name on the next slips past a naive pattern -
# and that is not a contrived evasion: every query in db/lessons.ts is already
# a multi-line template literal, so it is the file's own house style. Verified
# by probe: the line-broken form does NOT match a plain
# `grep -Eqi "FROM[[:space:]]+lesson_feed"`.
#
# The trailing [^_a-zA-Z0-9] keeps a hypothetical `lessons_archive` from being
# flagged, and the appended space guarantees a delimiter exists at end of file.
has_lesson_query() {
	{ tr '\n' ' ' < "$1"; printf ' '; } |
		grep -Eqi "FROM[[:space:]]+(lessons|lesson_feed)[^_a-zA-Z0-9]"
}

offenders=""
while IFS= read -r file; do
	case "${file}" in
		*/db/lessons.ts) continue ;;
		*.test.ts) continue ;;
	esac

	if has_lesson_query "${file}"; then
		offenders="${offenders} ${file#"${ROOT}/"}"
	fi
done < <(find "${ROOT}/apps/api/src" -name '*.ts' -type f)

if [[ -n "${offenders}" ]]; then
	fail "no lesson query outside db/lessons.ts" "found in:${offenders}"
else
	pass "no lesson query outside db/lessons.ts"
fi

# The second check, and it is not padding. Without it the guard passes
# trivially once every lesson query is deleted - a check that holds when the
# thing it guards is gone.
if has_lesson_query "${ROOT}/apps/api/src/db/lessons.ts"; then
	pass "db/lessons.ts is where the lesson queries live"
else
	fail "db/lessons.ts is where the lesson queries live" "no lesson query found there"
fi

echo
if (( failures > 0 )); then
	echo "source-guards.test.sh: ${failures} of ${tests} tests failed"
	exit 1
fi

echo "source-guards.test.sh: all ${tests} tests passed"
