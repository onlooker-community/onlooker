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
# TWO forms, because raw SQL is not how the next lesson query gets written.
# db/queries.ts and db/machine-tokens.ts - the two files sitting beside
# db/lessons.ts - are both drizzle builder style, so `.from(lessons)` is the
# MOST likely shape for a second query, and matching only `FROM lessons` walks
# straight past the thing this guard exists to catch. `.update`, `.insert` and
# `.delete` are here for the same reason: drizzle names the table as the
# builder's argument, not after a FROM.
#
# Both forms end on a delimiter so a name that merely starts with a table name
# is not flagged. `FROM lessons_archive` and `.from(lessonsArchive)` are legal
# code that has nothing to do with this boundary, and a guard that over-flags
# gets disabled by the first person it inconveniences. The appended space
# guarantees the raw-SQL form has a delimiter at end of file.
has_lesson_query() {
	{ tr '\n' ' ' < "$1"; printf ' '; } |
		grep -Eqi "FROM[[:space:]]+(lessons|lesson_feed)[^_a-zA-Z0-9]|\.(from|update|insert|delete)\([[:space:]]*(lessons|lesson_feed)[[:space:]]*[,)]"
}

# The matcher is itself tested, because a matcher that quietly stops matching
# looks exactly like a boundary that is being respected. The previous version
# recognized only `FROM lessons`, so every drizzle-style query walked past it -
# and nothing here would have said so.
probe_dir="$(mktemp -d)"
trap 'rm -rf "${probe_dir}"' EXIT

probe() {
	local expected="$1" name="$2" content="$3" actual
	printf '%s' "${content}" > "${probe_dir}/probe.ts"

	if has_lesson_query "${probe_dir}/probe.ts"; then
		actual="catches"
	else
		actual="ignores"
	fi

	if [[ "${actual}" == "${expected}" ]]; then
		pass "${expected}: ${name}"
	else
		fail "${expected}: ${name}" "the matcher ${actual} it"
	fi
}

echo
echo "source-guards: what the matcher sees"

probe catches "single-line FROM lessons" \
	'const rows = await db.prepare("SELECT * FROM lessons WHERE id = ?").all();'
probe catches "FROM on its own line, table on the next" \
	'const rows = await db.prepare(`SELECT f.seq
		 FROM lesson_feed
		 WHERE f.user_id = ?`).all();'
probe catches "drizzle .from(lesson_feed)" \
	'client(db).select().from(lesson_feed).where(eq(lesson_feed.user_id, id));'
probe catches "drizzle .from(lessons)" \
	'client(db).select().from(lessons).limit(1);'
probe catches "drizzle .update(lessons)" \
	'client(db).update(lessons).set({ status: "retracted" });'
probe catches "drizzle .insert(lesson_feed)" \
	'client(db).insert(lesson_feed).values(row);'
probe catches "drizzle .delete(lessons)" \
	'client(db).delete(lessons).where(eq(lessons.id, id));'
probe catches "drizzle builder broken across lines" \
	'client(db)
		.select()
		.from(
			lessons,
		)
		.limit(1);'

# Over-flagging is not the safe direction. A guard that fires on code with
# nothing to do with this boundary gets disabled by the first person it
# inconveniences, and then it guards nothing.
probe ignores "a differently named table in raw SQL" \
	'const rows = await db.prepare("SELECT * FROM lessons_archive").all();'
probe ignores "a differently named table in drizzle" \
	'client(db).select().from(lessonsArchive).limit(1);'
probe ignores "importing from the module that owns the queries" \
	'import { getLessonById } from "../db/lessons.js";'
probe ignores "prose that mentions the tables" \
	'// Every query touching lessons or lesson_feed belongs in db/lessons.ts.'

echo
echo "source-guards: the lesson visibility boundary"

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
