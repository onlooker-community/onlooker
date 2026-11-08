#!/usr/bin/env bash
# Keep one pull request in step with ecosystem's marketplace (ONL-277).
#
# Usage: scripts/ecosystem-sync.sh <ecosystem-clone>
#
# Run by .github/workflows/ecosystem-sync.yml from the root of an onlooker
# checkout whose origin pushes as the release App, with git's user already set.
# The ecosystem clone needs full history: the README list is a diff between
# the commit the fixture records and ecosystem's main now.
#
# This is the git and GitHub side only. Reading the marketplace, deciding
# whether anything changed and writing the PR body happen in
# apps/website/scripts/ecosystem-sync.ts, whose logic is tested in
# apps/website/src/__tests__/ecosystem-sync.test.ts.
set -euo pipefail

readonly ECOSYSTEM="${1:?usage: ecosystem-sync.sh <ecosystem-clone>}"
readonly FIXTURE="apps/website/src/data/plugins/marketplace.fixture.json"
readonly BRANCH="bot/ecosystem-sync"
readonly TITLE="chore(website): sync the ecosystem marketplace"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

head="$(git -C "${ECOSYSTEM}" rev-parse HEAD)"

git fetch --quiet origin main
git show "origin/main:${FIXTURE}" >"${work}/before.json"
base="$(jq -r '.commit' "${work}/before.json")"

# Without the recorded commit the README list cannot be computed, and a sync
# that quietly listed no READMEs would read as "nothing to re-check". So this
# stops instead: a force-push in ecosystem, or a hand-edited fixture.
if ! git -C "${ECOSYSTEM}" cat-file -e "${base}^{commit}" 2>/dev/null; then
	echo "::error title=Recorded ecosystem commit not found::${FIXTURE} records ${base}, which ecosystem's history does not contain."
	exit 1
fi

# core.quotePath=false for scripts/deployable.sh's reason: a quoted path would
# never equal the README path it is compared with.
git -C "${ECOSYSTEM}" -c core.quotePath=false \
	diff --name-only "${base}" "${head}" >"${work}/changed.txt"

result="$(pnpm exec tsx apps/website/scripts/ecosystem-sync.ts \
	"${head}" "${work}/before.json" "${work}/changed.txt" \
	"${work}/fixture.json" "${work}/body.md")"

if [[ "${result}" == "unchanged" ]]; then
	echo "ecosystem-sync: nothing to sync between ${base} and ${head}"
	exit 0
fi

# Never force-push. A prose file somebody committed on the branch has to
# survive the next run, so the branch is extended, not rebuilt. Merging main
# keeps it current; a conflict stops the run, because a bot resolving one would
# be choosing whose change to keep.
if git ls-remote --exit-code --heads origin "${BRANCH}" >/dev/null; then
	git fetch --quiet origin "${BRANCH}"
	git checkout --quiet -B "${BRANCH}" "origin/${BRANCH}"
	if ! git merge --quiet --no-edit origin/main; then
		conflicts="$(git diff --name-only --diff-filter=U | paste -sd ' ' -)"
		git merge --abort
		echo "::error title=Sync branch conflicts with main::${conflicts}"
		exit 1
	fi
else
	git checkout --quiet -B "${BRANCH}" origin/main
fi

cp "${work}/fixture.json" "${FIXTURE}"
git add "${FIXTURE}"
if ! git diff --cached --quiet; then
	git commit --quiet -m "chore(website): sync the marketplace to ecosystem ${head:0:7}"
fi
git push --quiet origin "${BRANCH}"

number="$(gh pr list --head "${BRANCH}" --state open --json number --jq '.[0].number // empty')"
if [[ -n "${number}" ]]; then
	gh pr edit "${number}" --body-file "${work}/body.md"
else
	gh pr create --base main --head "${BRANCH}" \
		--title "${TITLE}" --body-file "${work}/body.md"
fi
