#!/usr/bin/env bash
# Does this pull request change the code inside the CLI binary without
# releasing it?
#
# Usage: scripts/cli-version.sh
#        scripts/cli-version.sh --paths [ROOT]
#
# WHY THIS EXISTS
#
# The CLI's release trigger is a version change in apps/cli/package.json.
# tag-cli.yml is paths-filtered on that one file, and deploy.yml deliberately
# never ships the CLI. So a pull request can change apps/cli/src, merge green,
# deploy the API and the web app, and leave every installed `onlooker` running
# the old binary, with nothing anywhere reporting it.
#
# That has happened twice. #141 shipped the machine inventory inert and #142
# was spent fixing it; #167 shipped session summaries inert and #168 cut the
# release, caught only because a person thought to ask. 7af44e2 wrote the rule
# down in a commit message, and the plan behind #167 forgot it anyway. A rule
# in a commit message is not a check.
#
# FAILS CLOSED, unlike deployable.sh next door. That script deploys rather than
# guess, because a skipped deploy is worse than a redundant one. Here the
# asymmetry runs the other way: a gate that wrongly passes restores exactly the
# silence it was built to end, and a gate that wrongly fails costs one label or
# one re-run. When this script cannot work something out, it blocks.
set -euo pipefail

readonly REPO_ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Print every path in this repository whose contents end up in the CLI binary.
#
# Derived from the manifest rather than hardcoded. apps/cli builds with
# `esbuild --bundle`, so its workspace dependencies are compiled into
# dist/onlooker.mjs - lessons.ts, pull.ts and commands/playbook.ts import
# ZLesson, a Zod schema and therefore a runtime value, from
# @onlooker-community/lesson-contract. A change under that package ships a
# different binary without touching apps/cli/src at all. Reading the manifest
# means adding a workspace dependency widens this gate by itself instead of
# quietly reopening the hole.
derive_paths() {
	local root="${1:-${REPO_ROOT_DEFAULT}}"
	local manifest="${root}/apps/cli/package.json"

	if [[ ! -f "${manifest}" ]]; then
		echo "cli-version: no manifest at ${manifest}" >&2
		return 1
	fi

	echo "apps/cli/src"

	local dep dir
	while read -r dep; do
		[[ -n "${dep}" ]] || continue

		if ! dir="$(package_dir "${root}" "${dep}")"; then
			echo "cli-version: ${dep} is a workspace dependency with no package under ${root}/packages" >&2
			return 1
		fi

		echo "${dir}/src"
	done < <(jq -r '
		.dependencies // {}
		| to_entries[]
		| select(.value | startswith("workspace:"))
		| .key
	' "${manifest}")
}

# Map a package name to its directory by reading each manifest's own `name`.
#
# Not by assuming the directory is named after the package: the one workspace
# dependency the CLI has today is @onlooker-community/lesson-contract living in
# packages/lesson-contract, and nothing enforces that correspondence.
package_dir() {
	local root="$1" name="$2" manifest="" dir=""

	for manifest in "${root}"/packages/*/package.json; do
		[[ -f "${manifest}" ]] || continue

		if [[ "$(jq -r '.name // ""' "${manifest}")" == "${name}" ]]; then
			dir="${manifest%/package.json}"
			printf '%s\n' "packages/$(basename "${dir}")"
			return 0
		fi
	done

	return 1
}

# Did the dependencies block move between two manifests?
#
# Not "did the manifest change": apps/cli/package.json changes on every release
# by definition, and it also carries scripts, bin and devDependencies, none of
# which alter the shipped binary. Only a dependency change does, and only that
# should make the manifest count as CLI source.
#
# -S sorts keys so a formatter reordering the block does not read as a change,
# and `// {}` makes a missing block compare equal to an empty one rather than
# `null` against `{}`.
deps_differ() {
	local old="$1" new="$2" old_deps="" new_deps=""

	old_deps="$(jq -S -c '.dependencies // {}' "${old}")"
	new_deps="$(jq -S -c '.dependencies // {}' "${new}")"

	[[ "${old_deps}" != "${new_deps}" ]]
}

case "${1:-}" in
	--paths)
		derive_paths "${2:-}"
		exit $?
		;;
	--deps-differ)
		if [[ $# -ne 3 ]]; then
			echo "usage: $(basename "$0") --deps-differ OLD NEW" >&2
			exit 2
		fi
		deps_differ "$2" "$3"
		exit $?
		;;
	*)
		echo "usage: $(basename "$0")" >&2
		echo "       $(basename "$0") --paths [ROOT]" >&2
		exit 2
		;;
esac
