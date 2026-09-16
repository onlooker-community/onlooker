#!/usr/bin/env bash
# Does this commit contain anything the named environment has not deployed yet?
#
# Prints `true` or `false`. deploy.yml gates its deploy jobs on the answer.
#
# Usage: scripts/deployable.sh production|staging
#
# WHY THIS IS NOT A DIFF FROM github.event.before
#
# It used to be, and that is onlooker-txcu.7. `github.event.before` is "the
# commit main pointed at before this push", which is only the same thing as
# "the commit we last deployed" when every push deploys. On 2026-09-13 two pull
# requests merged a minute apart: the first push's deploy was cancelled mid
# flight, and the second push then computed its diff from the head the first
# merge had just created. The first merge's own files were not in that range,
# so the filter answered "nothing deployable" and both deploy jobs skipped. Two
# green runs, a change sitting on main that had never been deployed, and no
# failure anywhere to notice it.
#
# Cancellation was one way to open that gap and has since been closed for main,
# but it was never the only one. Any run that does not reach its deploy jobs -
# a runner dying, a failed test, an approval that expires, somebody hitting the
# stop button - leaves the same hole, because the next push still measures from
# a commit rather than from a deploy.
#
# So the question is asked of the thing that actually knows. GitHub records a
# deployment per environment with the commit it deployed, and this script
# anchors on the newest one that SUCCEEDED. A change stays pending until it has
# really shipped, however many pushes happen in between.
#
# PER ENVIRONMENT, not one shared answer. Production sits behind a required
# reviewer, so it can trail staging by hours or days while an approval waits.
# One shared anchor would have to pick which environment to be wrong about:
# anchored on production, staging redeploys everything since the last approval;
# anchored on staging, production treats work as shipped that only ever reached
# staging - and that second one loses changes. Each environment measures from
# its own last success instead.
set -euo pipefail

# Paths whose contents end up in a deployed artifact.
#
# Anchored at the start of the path, which is load-bearing: unanchored, a
# document that merely mentions `apps/api/` would deploy the entire stack.
# deploy.yml is here because a change to how deploying works has to be able to
# deploy itself; no other workflow can.
readonly DEPLOYABLE_PATHS='^(apps/(api|web|website)/|packages/|package\.json|pnpm-lock\.yaml|turbo\.json|\.github/workflows/deploy\.yml)'

# How far back to look for a successful deployment.
#
# Deep enough to see past a run of failures, shallow enough to stay one cheap
# query. Falling off the end is not a silent wrong answer - it is the same
# "found none" that a fresh repository gives, which deploys.
readonly DEPLOYMENT_SEARCH_DEPTH=50

# Read changed file names on stdin, print whether any of them is deployable.
#
# Separated from the git and API calls so it can be tested as itself, on real
# file lists, rather than through a stub of something else.
match_paths() {
	# Deliberately not `grep -q`. With -q, grep exits at the first match and
	# closes the pipe beneath it; whatever is upstream then takes SIGPIPE, and
	# `set -o pipefail` turns that into a failed script - on the MATCH path,
	# which is the common one, and only once the input is large enough for the
	# writer to still be writing. A filter that fails intermittently blocks
	# every deploy behind it, which is worse than anything it was built to
	# prevent. Reading the whole list costs nothing at this size.
	if grep -E "${DEPLOYABLE_PATHS}" >/dev/null; then
		echo "true"
	else
		echo "false"
	fi
}

# Read a deployments payload on stdin, print the newest commit that deployed
# successfully. Exits 1 when there is none.
#
# The state filter is the point. A deployment record is created when the job
# STARTS, so a deploy that failed, was cancelled, or is still running leaves a
# record naming a commit that never shipped. Anchoring on one of those would
# mark unshipped work as already deployed and skip it from then on - the same
# silent skip this script exists to end, wearing a different hat.
#
# Exiting 1 rather than printing nothing gives the caller a way to tell "looked
# and found none" apart from "could not look", and gives the tests a way to
# tell either apart from a script that is simply broken.
select_sha() {
	local sha=""

	sha="$(jq -r '
		[ .data.repository.deployments.nodes[]?
		  | select(.latestStatus.state == "SUCCESS")
		  | .commitOid
		][0] // ""
	' 2>/dev/null)" || sha=""

	[[ -n "${sha}" ]] || return 1

	printf '%s\n' "${sha}"
}

# Ask GitHub for the recent deployments of one environment.
#
# One query rather than a listing plus a status call per deployment: the REST
# deployments endpoint cannot filter or return state, so it would take N+1
# round trips to learn the one thing that matters about each record.
fetch_deployments() {
	local environment="$1" owner_repo="${GITHUB_REPOSITORY:-}"

	if [[ -z "${owner_repo}" ]]; then
		owner_repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
	fi

	gh api graphql \
		-f owner="${owner_repo%%/*}" \
		-f name="${owner_repo##*/}" \
		-f environment="${environment}" \
		-F depth="${DEPLOYMENT_SEARCH_DEPTH}" \
		-f query='
			query($owner: String!, $name: String!, $environment: String!, $depth: Int!) {
				repository(owner: $owner, name: $name) {
					deployments(
						environments: [$environment]
						orderBy: {field: CREATED_AT, direction: DESC}
						first: $depth
					) {
						nodes { commitOid latestStatus { state } }
					}
				}
			}'
}

case "${1:-}" in
	--match)
		match_paths
		exit 0
		;;
	--select-sha)
		select_sha
		exit $?
		;;
	production | staging) ;;
	*)
		echo "usage: $(basename "$0") production|staging" >&2
		echo "       $(basename "$0") --match       < changed-file-list" >&2
		echo "       $(basename "$0") --select-sha  < deployments-json" >&2
		exit 2
		;;
esac

readonly ENVIRONMENT="$1"
readonly HEAD_SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"

# Every failure below answers `true`, and that asymmetry is deliberate. A
# redundant deploy costs a few minutes of CI; a skipped one ships nothing and
# says it succeeded. When this script cannot work out what was last deployed,
# it must not guess that the answer is "everything already".
base_sha=""
if ! deployments="$(fetch_deployments "${ENVIRONMENT}" 2>/dev/null)"; then
	echo "deployable: cannot reach the deployments API; deploying rather than guessing" >&2
	echo "true"
	exit 0
fi

if ! base_sha="$(printf '%s' "${deployments}" | select_sha)"; then
	echo "deployable: ${ENVIRONMENT} has no successful deployment on record; deploying" >&2
	echo "true"
	exit 0
fi

# The recorded commit can be absent from this clone - a force-push that removed
# it, or a fetch too shallow to reach it. `git diff` against a missing object is
# a hard error, and under `set -e` that fails the step and blocks every deploy
# behind it, which is the one outcome this filter must never cause.
if ! git cat-file -e "${base_sha}^{commit}" 2>/dev/null; then
	echo "deployable: ${base_sha} is not in this clone; deploying rather than guessing" >&2
	echo "true"
	exit 0
fi

echo "deployable: ${ENVIRONMENT} last deployed ${base_sha}" >&2

# Captured rather than piped straight through. The list is worth printing - it
# is the whole explanation for the answer, and the run log is where anyone will
# look when the answer surprises them - and `git diff | tee | match` would put
# two more processes in a pipeline whose failure mode is a blocked deploy.
changed="$(git diff --name-only "${base_sha}" "${HEAD_SHA}")"
printf '%s\n' "${changed}" >&2

printf '%s\n' "${changed}" | match_paths
