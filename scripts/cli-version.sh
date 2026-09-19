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
#
# That claim holds only for a dependency under packages/ - package_dir below
# globs packages/*/package.json, not apps/*/package.json, even though
# pnpm-workspace.yaml declares both. A workspace dependency on something under
# apps/ makes package_dir return 1, which makes this function return 1, which
# wedges the whole gate closed for every pull request rather than widening it.
# That fails closed, and after the ::error added below it is loud, so it is
# recorded here rather than fixed.
# Print the directory of every workspace dependency the CLI bundles.
#
# Shared by derive_paths and derive_manifests rather than written twice, so the
# two cannot drift. A gate whose source list knows about a dependency its
# manifest list does not is a gate with a blind spot, which is the shape of
# onlooker-dnkx.
workspace_dirs() {
	local root="$1" manifest="${root}/apps/cli/package.json" dep="" dir=""

	if [[ ! -f "${manifest}" ]]; then
		echo "cli-version: no manifest at ${manifest}" >&2
		return 1
	fi

	while read -r dep; do
		[[ -n "${dep}" ]] || continue

		if ! dir="$(package_dir "${root}" "${dep}")"; then
			echo "cli-version: ${dep} is a workspace dependency with no package under ${root}/packages" >&2
			return 1
		fi

		echo "${dir}"
	done < <(jq -r '
		.dependencies // {}
		| to_entries[]
		| select(.value | startswith("workspace:"))
		| .key
	' "${manifest}")
}

derive_paths() {
	local root="${1:-${REPO_ROOT_DEFAULT}}" dirs="" dir=""

	# Resolved before anything is printed. The earlier shape emitted
	# apps/cli/src and then failed partway through the dependency loop, so a
	# caller reading stdout without checking the exit status saw what looked
	# like a short but successful answer. Command substitution propagates the
	# failure; a process substitution driving the loop directly would not.
	dirs="$(workspace_dirs "${root}")" || return 1

	echo "apps/cli/src"

	while read -r dir; do
		[[ -n "${dir}" ]] || continue
		echo "${dir}/src"
	done <<<"${dirs}"
}

# Print every manifest whose contents can change what the binary contains.
#
# The CLI's own, plus one per bundled workspace dependency. Watching
# packages/<dir>/src without packages/<dir>/package.json was the hole
# onlooker-dnkx records: zod is the runtime behind ZLesson, so bumping it
# inside the contract recompiles a different dist/onlooker.mjs through a file
# the gate never read.
derive_manifests() {
	local root="${1:-${REPO_ROOT_DEFAULT}}" dirs="" dir=""

	dirs="$(workspace_dirs "${root}")" || return 1

	echo "apps/cli/package.json"

	while read -r dir; do
		[[ -n "${dir}" ]] || continue
		echo "${dir}/package.json"
	done <<<"${dirs}"
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

# Did anything that reaches the binary move between two manifests?
#
# Everything except `version`, rather than a list of the fields that matter.
# That inversion is the point. This compared `dependencies` alone until
# onlooker-dnkx, on the stated grounds that scripts, bin and devDependencies do
# not alter the artifact - which is false. scripts.build IS the esbuild
# invocation that produces dist/onlooker.mjs, so --target, --format, --minify
# and the shebang banner all change it; bin is what `onlooker` resolves to once
# installed; devDependencies.esbuild is the bundler itself.
#
# A list of fields that matter has to stay right forever, and every field added
# later is a fresh blind spot. The list of fields that provably do not matter
# has exactly one entry, because the version IS the release. Measured before
# choosing: of the nine changes ever made to apps/cli/package.json, eight were
# version-only and the ninth created the file, so this has never over-fired.
#
# -S sorts keys recursively, so a formatter reordering a block does not read as
# a change.
#
# Exit 0 = the dependencies moved, 1 = they did not, 2 = the question could
# not be answered (a missing, unreadable or non-JSON manifest). That third
# code is load-bearing: the caller runs this inside an `if`, which bash
# exempts from set -e, so a raw jq failure would otherwise surface as an
# ordinary nonzero exit and read as "1 = unchanged" - the same silence this
# whole script exists to end. Checking both files up front, rather than
# letting jq's own exit code leak out of the comparison below, is what keeps
# 2 distinguishable from 1.
manifest_differs() {
	local old="$1" new="$2" old_body="" new_body="" manifest=""

	for manifest in "${old}" "${new}"; do
		if [[ ! -r "${manifest}" ]]; then
			echo "cli-version: cannot read ${manifest}" >&2
			return 2
		fi

		if ! jq empty "${manifest}" 2>/dev/null; then
			echo "cli-version: ${manifest} is not valid JSON" >&2
			return 2
		fi
	done

	old_body="$(jq -S -c 'del(.version)' "${old}")"
	new_body="$(jq -S -c 'del(.version)' "${new}")"

	[[ "${old_body}" != "${new_body}" ]]
}

# The label that turns a missing bump into a recorded decision.
#
# Batching several CLI changes across pull requests and cutting one release at
# the end is legitimate, so this gate cannot simply forbid a missing bump the
# way contract-version forbids a missing schema bump. Forgetting fails;
# batching costs one deliberate act that leaves a trace on the pull request.
readonly BATCH_LABEL="cli-batch"

# Split a comma- or newline-separated list into lines.
#
# Both separators are accepted so the gatherer can pipe `--paths` output and
# `gh pr view --jq '.labels[].name'` output straight through, while a test can
# write one readable flag value.
#
# The trailing newline is not decoration: every caller here reads the result
# with `while read`, whose loop condition is `read`'s own exit status. `read`
# returns nonzero on a final line with no trailing delimiter, so a `while read`
# loop skips its body for that last line - silently dropping the last path or
# the only label. `printf '%s\n'` guarantees the final field always has one.
as_lines() {
	printf '%s\n' "$1" | tr ',' '\n'
}

# Does any changed file live under one of the source paths?
#
# Prefix-matched and anchored at the path boundary, which is load-bearing in
# both directions: `apps/cli/src` must match `apps/cli/src/main.ts` but neither
# `apps/cli/srcextra/x.ts` nor `docs/apps/cli/src/notes.md`. Unanchored, a
# document that merely mentions a source path would demand a release.
touches_source() {
	local source_paths="$1" file="" path=""
	local -a paths=()

	while read -r path; do
		[[ -n "${path}" ]] || continue
		paths+=("${path}")
	done < <(as_lines "${source_paths}")

	while read -r file; do
		[[ -n "${file}" ]] || continue

		for path in "${paths[@]}"; do
			if [[ "${file}" == "${path}" || "${file}" == "${path}/"* ]]; then
				return 0
			fi
		done
	done

	return 1
}

# Is the batch label among the pull request's labels?
has_batch_label() {
	local labels="$1" label=""

	while read -r label; do
		[[ "${label}" == "${BATCH_LABEL}" ]] && return 0
	done < <(as_lines "${labels}")

	return 1
}

# Read a changed-file list on stdin, print one verdict.
#
# Separated from the git and API calls so it can be tested as itself, on real
# file lists, rather than through a stub of something else. Always exits 0: the
# token is the answer, and a `fail:` result is a verdict rather than a broken
# run. The caller decides what to do about it, and an empty token - which is
# what a missing script prints - is not a verdict at all.
decide() {
	local source_paths="$1" old_version="$2" new_version="$3" labels="$4"

	if ! touches_source "${source_paths}"; then
		echo "pass:no-cli-change"
		return 0
	fi

	if [[ "${old_version}" != "${new_version}" ]]; then
		# Checked before the bump is accepted, not after. The CLI has a
		# Homebrew tap, and a lower number would move the formula backward the
		# same way publishing one moves a registry dist-tag backward - which
		# cannot be cleanly undone. contract-version carries this guard for
		# the same reason.
		local newest=""
		newest="$(printf '%s\n%s\n' "${old_version}" "${new_version}" | sort -V | tail -1)"

		if [[ "${newest}" != "${new_version}" ]]; then
			echo "fail:backward"
			return 0
		fi

		echo "pass:bumped"
		return 0
	fi

	if has_batch_label "${labels}"; then
		echo "pass:deferred"
		return 0
	fi

	echo "fail:no-bump"
	return 0
}

case "${1:-}" in
	--paths)
		derive_paths "${2:-}"
		exit $?
		;;
	--manifests)
		derive_manifests "${2:-}"
		exit $?
		;;
	--manifest-differs)
		if [[ $# -ne 3 ]]; then
			echo "usage: $(basename "$0") --manifest-differs OLD NEW" >&2
			exit 2
		fi
		manifest_differs "$2" "$3"
		exit $?
		;;
	--decide)
		shift
		decide_source_paths=""
		decide_old=""
		decide_new=""
		decide_labels=""

		while [[ $# -gt 0 ]]; do
			case "$1" in
				--source-paths) decide_source_paths="${2:-}"; shift 2 ;;
				--old-version) decide_old="${2:-}"; shift 2 ;;
				--new-version) decide_new="${2:-}"; shift 2 ;;
				--labels) decide_labels="${2:-}"; shift 2 ;;
				*)
					echo "cli-version: unknown --decide flag '$1'" >&2
					exit 2
					;;
			esac
		done

		decide "${decide_source_paths}" "${decide_old}" "${decide_new}" "${decide_labels}"
		exit 0
		;;
	"")
		;;
	*)
		echo "usage: $(basename "$0")" >&2
		echo "       $(basename "$0") --paths [ROOT]" >&2
		echo "       $(basename "$0") --manifests [ROOT]" >&2
		echo "       $(basename "$0") --manifest-differs OLD NEW" >&2
		echo "       $(basename "$0") --decide --source-paths L --old-version X --new-version Y --labels L  < changed-file-list" >&2
		exit 2
		;;
esac

# ---------------------------------------------------------------------------
# The full run. Everything above is pure; everything below reads the world.
# ---------------------------------------------------------------------------

# CLI_VERSION_ROOT exists so the composition below can be tested. Without it
# this resolves from the script's own location and can only ever run against
# this repository, which would leave the gatherer - the part that decides what
# actually happens - as the one piece with no test at all. Nothing in CI sets
# it; the default is the repository the script lives in.
readonly REPO_ROOT="${CLI_VERSION_ROOT:-${REPO_ROOT_DEFAULT}}"
readonly MANIFEST="${REPO_ROOT}/apps/cli/package.json"

# Every git command below is relative to the repository being examined, which
# is not necessarily the one this script lives in.
cd "${REPO_ROOT}"

if [[ -z "${BASE_REF:-}" ]]; then
	echo "::error title=CLI release gate misconfigured::BASE_REF is not set. It must name the base to diff against, e.g. origin/main."
	exit 1
fi

# Captured rather than left to set -e, the same reasoning as deps_status
# below: derive_paths already prints its own reason on stderr, but stderr
# never reaches the annotation surface a pull request shows by default, and
# every other blocking path in this script emits one.
source_paths=""
if ! source_paths="$(derive_paths "${REPO_ROOT}")"; then
	echo "::error title=CLI release gate cannot derive its source paths::apps/cli/package.json could not be read, or one of its workspace dependencies has no matching package under packages/ - see the step log above for which. The CLI's source path set could not be worked out, and this gate blocks rather than guessing what the bundle actually contains."
	exit 1
fi

manifests=""
if ! manifests="$(derive_manifests "${REPO_ROOT}")"; then
	echo "::error title=CLI release gate cannot derive its manifests::apps/cli/package.json could not be read, or one of its workspace dependencies has no matching package under packages/ - see the step log above. Blocking rather than guessing what the bundle contains."
	exit 1
fi

old_manifest="$(mktemp)"
trap 'rm -f "${old_manifest}"' EXIT

# No manifest is in the derived path set on purpose. Each changes on every
# release of its own package, and each carries fields that do not reach the
# binary. One earns a place in the set only when manifest_differs says
# something other than its version moved.
#
# Every bundled manifest, not only the CLI's. Watching packages/<dir>/src
# without packages/<dir>/package.json was the hole in onlooker-dnkx: zod is the
# runtime behind ZLesson, so a bump inside the contract recompiles a different
# dist/onlooker.mjs through a file nothing here read.
manifest=""
while read -r manifest; do
	[[ -n "${manifest}" ]] || continue

	# A manifest absent from the base is a bundle input this range introduced,
	# which is a change by definition. Blocking instead would fail every pull
	# request that adds a workspace dependency.
	if ! git show "${BASE_REF}:${manifest}" >"${old_manifest}" 2>/dev/null; then
		source_paths="${source_paths}"$'\n'"${manifest}"
		echo "cli-version: ${manifest} is new since ${BASE_REF}; counting it as source" >&2
		continue
	fi

	# Captured rather than written as `if manifest_differs ...; then`. Bash
	# exempts an `if` condition from set -e, so every non-zero status collapses
	# into "false" there - and "false" means "nothing moved", which means the
	# manifest is not counted as source, which lets an unreleased change
	# through. An unreadable manifest would produce the exact silence this
	# script exists to end. manifest_differs answers 0 differ, 1 same, 2 cannot
	# answer, and 2 has to be told apart from 1 rather than blurred into it.
	manifest_status=0
	manifest_differs "${old_manifest}" "${REPO_ROOT}/${manifest}" || manifest_status=$?

	case "${manifest_status}" in
		0)
			source_paths="${source_paths}"$'\n'"${manifest}"
			echo "cli-version: ${manifest} moved in something other than its version; counting it as source" >&2
			;;
		1)
			;;
		*)
			echo "::error title=CLI release gate cannot read a manifest::Could not compare ${manifest} across ${BASE_REF}...HEAD - one side is missing or is not valid JSON. Blocking rather than guessing whether the bundle changed."
			exit 1
			;;
	esac
done <<<"${manifests}"

# Re-read, because the loop above overwrote the temp file once per manifest and
# the versions that decide the verdict are the CLI's own.
if ! git show "${BASE_REF}:apps/cli/package.json" >"${old_manifest}" 2>/dev/null; then
	echo "::error title=CLI release gate cannot read the base::apps/cli/package.json is not present at ${BASE_REF}. Without it there is nothing to compare, and this gate blocks rather than guess."
	exit 1
fi

old_version="$(jq -r '.version // ""' "${old_manifest}")"
new_version="$(jq -r '.version // ""' "${MANIFEST}")"

# A missing label read fails closed. A transient API error must not quietly
# turn a deliberate batch into a passing run or an unlabelled one into a pass -
# it leaves labels empty, which can only make the gate stricter, and the run
# log says so.
labels=""
if [[ -n "${PR_NUMBER:-}" ]]; then
	if ! labels="$(gh pr view "${PR_NUMBER}" --json labels --jq '.labels[].name' 2>/dev/null)"; then
		labels=""
		echo "cli-version: could not read the labels of #${PR_NUMBER}; treating it as unlabelled" >&2
	fi
else
	echo "cli-version: no PR_NUMBER; treating this run as unlabelled" >&2
fi

# core.quotePath=false, because its default is true and that breaks the match.
# With quoting on, git renders apps/cli/src/café.ts as the literal
# "apps/cli/src/caf\303\251.ts" - surrounding double quotes included - and the
# leading quote defeats the anchored prefix test in touches_source, so the file
# reads as untouched. A gate that silently stops seeing a file because somebody
# named it in their own language is the failure this whole script exists to
# end. scripts/deployable.sh carries the same flag for the same reason.
changed="$(git -c core.quotePath=false diff --name-only "${BASE_REF}...HEAD")"

# Printed because it is the whole explanation for the answer, and the run log
# is where anyone will look when the answer surprises them.
echo "cli-version: comparing ${BASE_REF}...HEAD" >&2
printf '%s\n' "${changed}" >&2
echo "cli-version: source paths" >&2
printf '%s\n' "${source_paths}" >&2

# A herestring, not `printf | decide`. touches_source returns on its first
# match without draining the rest of stdin, so once the changed-file list
# outgrows the pipe buffer the upstream printf takes EPIPE, pipefail turns
# that into a failed pipeline, and set -e kills the run - silently, on a
# legitimate pass:bumped, with no annotation printed at all. deployable.sh's
# match_paths comment documents this exact trap; a herestring has no upstream
# process to signal, so there is nothing left to kill.
verdict="$(decide \
	"${source_paths}" "${old_version}" "${new_version}" "${labels}" <<<"${changed}")"

# Which files made it count. Recomputed rather than threaded out of `decide`,
# which stays a pure function of its inputs and answers one question.
touched="$(printf '%s\n' "${changed}" | while read -r file; do
	[[ -n "${file}" ]] || continue
	# Same herestring reasoning as the `decide` call above: one file per
	# iteration fits the pipe buffer today, but the early return inside
	# touches_source is the same shape of risk, and a herestring costs
	# nothing to rule it out.
	if touches_source "${source_paths}" <<<"${file}"; then
		printf '%s ' "${file}"
	fi
done)"
touched="${touched% }"

case "${verdict}" in
	pass:no-cli-change)
		echo "cli-version: nothing in this pull request reaches the CLI binary"
		exit 0
		;;
	pass:bumped)
		echo "cli-version: CLI source changed and the version moved ${old_version} -> ${new_version}"
		exit 0
		;;
	pass:deferred)
		echo "cli-version: ${touched} changed and the version is still ${new_version}, deferred by the ${BATCH_LABEL} label. Remember to bump before this reaches anybody."
		exit 0
		;;
	fail:backward)
		echo "::error title=CLI version moved backward::apps/cli/package.json went from ${old_version} to ${new_version}. release-cli.yml would cut cli-v${new_version} and the Homebrew tap would take the lower number, which cannot be cleanly undone once somebody has installed it."
		exit 1
		;;
	fail:no-bump)
		echo "::error title=CLI source changed without a release::${touched} changed, but apps/cli/package.json is still ${new_version}. tag-cli.yml releases on a version change and nothing else, so this merges, deploys the API and the web app, and leaves every installed \`onlooker\` running the old binary - the failure in #141 and #167. Bump the version here, or add the \`${BATCH_LABEL}\` label and re-run this job to release these changes together later."
		exit 1
		;;
	*)
		# Fails closed, unlike deployable.sh next door. A gate that cannot work
		# out an answer and passes anyway restores exactly the silence it was
		# built to end.
		echo "::error title=CLI release gate could not decide::The verdict was '${verdict}', which is not one this script knows. Blocking rather than guessing."
		exit 1
		;;
esac
