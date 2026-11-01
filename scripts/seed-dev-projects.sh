#!/usr/bin/env bash
# Gives one local account projects to look at.
#
# Sessions only reach a database through a machine syncing, so a local account
# has an empty /projects until someone points a CLI at localhost. This writes
# the shapes the page has to handle instead, which a real sync would only
# produce by luck: a key with no name, two keys sharing one, a root key on two
# machines, a root key on a removed machine, and a labeled key with no sessions.
#
# Usage: pnpm seed:dev <email>
#
# Local only, by construction: every wrangler call passes --local, there is no
# flag to change that, and the database name exists nowhere but development.
# Everything it writes is marked `seed-`, and each run replaces the last, so
# running it twice leaves the same rows. The account's own machines and labels
# are left alone.
#
# Sessions are written with SQL rather than through POST /machine/sessions
# because that needs a machine's token, and only its hash is stored. So this
# has to write session_projects itself, the way putSessionSummaries does.
#
# SEED_PRINT_SQL=1 prints the SQL and stops, without running wrangler.
set -euo pipefail

readonly EMAIL="${1:-}"
readonly DATABASE="onlooker-db-local"

if [[ ! "${EMAIL}" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]]; then
	echo "usage: $(basename "$0") <email of a local account>" >&2
	exit 2
fi

readonly DESKTOP="seed-desktop"
readonly LAPTOP="seed-laptop"
readonly OLD_DESKTOP="seed-old-desktop"

readonly ONLOOKER_HTTPS="a1b2c3d4e5f6"
readonly ONLOOKER_SSH="b2c3d4e5f6a1"
readonly UNNAMED="c3d4e5f6a1b2"
readonly SCRATCH="d4e5f6a1b2c3"
readonly RETIRED="e5f6a1b2c3d4"
readonly PAST_RETENTION="f6a1b2c3d4e5"

readonly USER_ID="(SELECT id FROM users WHERE email = '${EMAIL}')"

machine() {
	local id="$1" name="$2" retired="$3"
	echo "INSERT INTO machine_tokens (id, user_id, name, token_hash, revoked_at, removed_at)
VALUES ('${id}', ${USER_ID}, '${name}', '${id}-not-a-credential', ${retired}, ${retired});"
}

label() {
	local key="$1" machine_id="$2" name="$3"
	echo "INSERT INTO project_labels (user_id, project_key, machine_id, source, label)
VALUES (${USER_ID}, '${key}', '${machine_id}', 'user', '${name}');"
}

# session <machine> <number> <days-ago> <key:basis:events>...
session() {
	local machine_id="$1" number="$2" days="$3"
	shift 3

	local id="seed-session-${number}" started events=0 counts="" entry key basis count
	started="strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${days} days')"
	for entry in "$@"; do
		IFS=: read -r key basis count <<<"${entry}"
		events=$((events + count))
		counts+="${counts:+,}\"${key}\":{\"basis\":\"${basis}\",\"event_count\":${count}}"
	done

	echo "INSERT INTO session_summaries
(user_id, machine_id, session_id, started_at, ended_at, event_count, counts_by_prefix, counts_by_type, counts_by_project, plugins, prompts)
VALUES (${USER_ID}, '${machine_id}', '${id}', ${started}, ${started}, ${events},
'{\"tool\":${events}}', '{\"tool.use\":${events}}', '{${counts}}', '[\"lineage\"]', 3);"

	for entry in "$@"; do
		IFS=: read -r key basis count <<<"${entry}"
		echo "INSERT INTO session_projects (user_id, machine_id, session_id, project_key, basis, event_count)
VALUES (${USER_ID}, '${machine_id}', '${id}', '${key}', '${basis}', ${count});"
	done
}

build_sql() {
	# Sessions and session_projects go with their machine by cascade.
	echo "DELETE FROM machine_tokens WHERE id LIKE 'seed-%' AND user_id = ${USER_ID};"
	echo "DELETE FROM project_labels WHERE user_id = ${USER_ID} AND project_key IN
('${ONLOOKER_HTTPS}', '${ONLOOKER_SSH}', '${UNNAMED}', '${SCRATCH}', '${RETIRED}', '${PAST_RETENTION}');"

	machine "${DESKTOP}" "seed desktop" "NULL"
	machine "${LAPTOP}" "seed laptop" "NULL"
	# Removed from the Machines page, and still named here.
	machine "${OLD_DESKTOP}" "seed old desktop" "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-40 days')"

	# An https and an ssh clone of one repository: two rows, one name.
	label "${ONLOOKER_HTTPS}" "" "onlooker"
	label "${ONLOOKER_SSH}" "" "onlooker"
	# One root key on two machines, which are two projects with their own names.
	label "${SCRATCH}" "${DESKTOP}" "scratch on the desktop"
	label "${SCRATCH}" "${LAPTOP}" "scratch on the laptop"
	label "${RETIRED}" "${OLD_DESKTOP}" "retired experiment"
	# Named, with every session past retention: listed with no activity.
	label "${PAST_RETENTION}" "" "archived project"

	session "${DESKTOP}" 1 0 "${ONLOOKER_HTTPS}:remote:1240"
	session "${LAPTOP}" 2 1 "${ONLOOKER_HTTPS}:remote:318"
	# One session across two repositories, as 17.4% of them are.
	session "${DESKTOP}" 3 2 "${ONLOOKER_SSH}:remote:96" "${UNNAMED}:remote:41"
	session "${LAPTOP}" 4 4 "${UNNAMED}:remote:27"
	session "${DESKTOP}" 5 6 "${SCRATCH}:root:64"
	session "${LAPTOP}" 6 9 "${SCRATCH}:root:12"
	session "${OLD_DESKTOP}" 7 45 "${RETIRED}:root:503"
}

if [[ -n "${SEED_PRINT_SQL:-}" ]]; then
	build_sql
	exit 0
fi

wrangler_local() {
	pnpm --filter @onlooker/api exec wrangler d1 execute "${DATABASE}" \
		--local --env development "$@"
}

# Checked first, because the subquery above would otherwise resolve to NULL and
# fail on a NOT NULL column, in an error that doesn't mention the address.
found="$(wrangler_local --command "SELECT id FROM users WHERE email = '${EMAIL}'" 2>/dev/null)"
if [[ "${found}" != *'"id"'* ]]; then
	echo "seed-dev-projects: no local account for ${EMAIL}. Sign up at the local web app first." >&2
	exit 2
fi

sql_file="$(mktemp)"
trap 'rm -f "${sql_file}"' EXIT
build_sql >"${sql_file}"
wrangler_local --file "${sql_file}" >/dev/null

echo "seed-dev-projects: seeded ${EMAIL}. Open /projects, or /sessions for the feed."
