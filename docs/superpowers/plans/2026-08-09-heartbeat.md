# Synthetic Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a steady, verifiable request floor across all four deployed hosts so the Cloudflare dashboards can distinguish "idle" from "dead."

**Architecture:** A bash script holds the check logic and is runnable locally; a GitHub Actions scheduled workflow is thin glue that calls it once per environment. Splitting it this way is what makes the thing testable — a workflow with `curl` inlined in YAML can only be tested by waiting for cron.

**Tech Stack:** bash, `curl`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-09-heartbeat-design.md`.

## Global Constraints

- **Assertions are equality, not "not an error."** Each check asserts the HTTP status equals its expected value. `500` and `200` on `/auth/refresh` are both failures and mean different things; a `not 5xx` check catches neither.
- **Expected codes, verified live on 2026-08-09:** `GET /` → `200`, `GET /auth/me` → `401`, `POST /auth/refresh` → `401`.
- **The heartbeat writes nothing.** `/auth/refresh` with a garbage token exercises the D1 read path and creates no rows. Never add a check that logs in.
- **Production failures exit non-zero; staging failures do not.** Staging breaks by design during deploys, and a monitor that fires during normal work gets muted.
- Every `curl` uses `--max-time 10` so a hanging host fails rather than hanging the job.
- Shell scripts follow `scripts/setup-dev-env.sh`: `#!/usr/bin/env bash`, `set -euo pipefail`, `readonly` for constants, executable bit set.
- **All commits route through the `/commit` skill**, per the repository's CLAUDE.md.
- American English throughout.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `scripts/heartbeat.sh` | the three checks for one environment; exits non-zero on mismatch | 1 |
| `.github/workflows/heartbeat.yml` | schedule, and calling the script once per environment with the right failure policy | 2 |

Two files, two tasks. The split is meaningful rather than cosmetic: a reviewer
could reasonably accept the script and reject the workflow's schedule or
failure policy, and the script must be provably working before the workflow is
worth writing.

---

## Task 1: The check script

**Files:**
- Create: `scripts/heartbeat.sh`

**Interfaces:**
- Produces: `scripts/heartbeat.sh <environment>` where `<environment>` is
  `production` or `staging`. Exits `0` if all three checks match, `1` otherwise.
  Prints one line per check. Task 2 calls exactly this.

- [ ] **Step 1: Write the script**

Create `scripts/heartbeat.sh`:

```bash
#!/usr/bin/env bash
# Synthetic heartbeat: proves each deployed host is reachable and that the
# database read path works, without writing anything.
#
# Usage: scripts/heartbeat.sh production|staging
#
# Assertions are equality, not "not an error", because the interesting
# failures are specific. On /auth/refresh: 401 means the sessions table was
# queried and correctly found nothing; 500 means the query threw, which is the
# shape of an outage where the API still answers 200 at its root; 200 would
# mean a garbage token minted a session.
set -euo pipefail

readonly ENVIRONMENT="${1:-}"

case "${ENVIRONMENT}" in
	production)
		readonly APP_URL="https://app.onlooker.dev"
		readonly API_URL="https://api.onlooker.dev"
		;;
	staging)
		readonly APP_URL="https://app-staging.onlooker.dev"
		readonly API_URL="https://api-staging.onlooker.dev"
		;;
	*)
		echo "usage: $(basename "$0") production|staging" >&2
		exit 2
		;;
esac

failures=0

# check <label> <expected-status> <curl-args...>
check() {
	local label="$1"
	local expected="$2"
	shift 2

	local actual
	# curl must not abort the script on a network failure, so its exit status
	# is swallowed with `|| true` rather than allowed to trip `set -e`.
	#
	# Do NOT write `|| echo "000"` here. On a connection failure curl already
	# prints 000 via %{http_code} AND exits non-zero, so the fallback appends a
	# second one and the variable becomes "000000" - garbage in the exact
	# message you would be reading during an outage. Verified 2026-08-09.
	#
	# A DNS or connection failure therefore yields 000, which will not equal
	# the expected code - exactly the api-staging failure mode.
	actual="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true)"

	if [[ "${actual}" == "${expected}" ]]; then
		echo "  ok    ${label} -> ${actual}"
	else
		echo "  FAIL  ${label} -> ${actual} (expected ${expected})"
		failures=$((failures + 1))
	fi
}

echo "heartbeat: ${ENVIRONMENT}"

check "web app" 200 "${APP_URL}/"

check "api worker" 401 "${API_URL}/auth/me"

check "api d1 read" 401 \
	-X POST "${API_URL}/auth/refresh" \
	-H 'Content-Type: application/json' \
	-d '{"refreshToken":"heartbeat"}'

if (( failures > 0 )); then
	echo "heartbeat: ${ENVIRONMENT} — ${failures} of 3 checks failed"
	exit 1
fi

echo "heartbeat: ${ENVIRONMENT} — all 3 checks passed"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/heartbeat.sh
```

- [ ] **Step 3: Verify the failure path FIRST**

A monitor that has never been seen failing is indistinguishable from one that
cannot fail. Prove it fails before trusting it to pass.

```bash
scripts/heartbeat.sh nonsense; echo "exit=$?"
```

Expected: usage message on stderr, `exit=2`.

Then point it at a host that does not exist, by temporarily editing the
`staging` branch's `APP_URL` to `https://app-staging-nope.onlooker.dev`:

```bash
scripts/heartbeat.sh staging; echo "exit=$?"
```

Expected: `FAIL web app -> 000 (expected 200)`, the other two checks still
`ok`, and `exit=1`.

**Revert that edit before continuing.**

- [ ] **Step 4: Verify the success path**

```bash
scripts/heartbeat.sh production; echo "exit=$?"
scripts/heartbeat.sh staging; echo "exit=$?"
```

Expected for both: three `ok` lines and `exit=0`.

```
heartbeat: production
  ok    web app -> 200
  ok    api worker -> 401
  ok    api d1 read -> 401
heartbeat: production — all 3 checks passed
```

If any check reports something other than the expected code, **stop and report
it** rather than adjusting the expectation to match. These three codes were
verified against the live deployments on 2026-08-09; a different answer means
something changed in the API, and the plan needs revisiting rather than the
assertion being loosened.

- [ ] **Step 5: Commit**

Use the `/commit` skill with `scripts/heartbeat.sh`.

Suggested subject: `feat(heartbeat): add the synthetic check script :heartbeat:`

The body should say why `/auth/refresh` is the database check — it queries the
sessions table and writes no row, where `/auth/me` throws in `requireAuth`
before D1 is ever touched.

---

## Task 2: The scheduled workflow

**Files:**
- Create: `.github/workflows/heartbeat.yml`

**Interfaces:**
- Consumes: `scripts/heartbeat.sh production|staging` from Task 1 — exits `0`
  on success, `1` on any check mismatch, `2` on bad usage.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/heartbeat.yml`:

```yaml
name: Heartbeat

# Generates a steady request floor across all four hosts so the Cloudflare
# dashboards can tell "idle" from "dead", and fails loudly when production
# stops answering correctly.
#
# workflow_dispatch is deliberate: without it the only way to test a change
# here is to wait for the next scheduled run.
on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:

# A slow run must never stack up behind the next scheduled one.
concurrency:
  group: heartbeat
  cancel-in-progress: false

jobs:
  heartbeat:
    name: Check all environments
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4

      # Staging runs first and never fails the job. It breaks by design during
      # deploys and migrations, and a monitor that fires during normal work is
      # one people mute. Its result still reaches you as an annotation, and the
      # requests still reach Cloudflare either way.
      - name: Staging (advisory)
        run: |
          if ! scripts/heartbeat.sh staging; then
            echo "::warning title=Staging heartbeat failed::One or more staging checks did not return the expected status. This does not fail the run."
            echo "⚠️ **Staging heartbeat failed** — see the step log above." >> "$GITHUB_STEP_SUMMARY"
          fi

      # Production failures fail the run, which is the whole alerting
      # mechanism: GitHub emails on workflow failure by default.
      - name: Production
        run: scripts/heartbeat.sh production
```

- [ ] **Step 2: Commit and push the branch**

Use the `/commit` skill with `.github/workflows/heartbeat.yml`.

Suggested subject: `feat(heartbeat): run the checks on a schedule :stopwatch:`

The body should explain that a failing run *is* the alert — GitHub's default
failure notification — and why staging is advisory.

Then push the branch so the workflow exists on the remote.

- [ ] **Step 3: Trigger it manually and confirm it passes**

A scheduled workflow only runs from the default branch, so before merge the
only way to exercise it is `workflow_dispatch` on the branch:

```bash
gh workflow run Heartbeat --ref feat/heartbeat
sleep 45
gh run list --workflow Heartbeat --limit 1
```

Expected: `completed  success`.

- [ ] **Step 4: Read the log and confirm all six checks actually ran**

```bash
gh run view --log --job "$(gh run list --workflow Heartbeat --limit 1 --json databaseId --jq '.[0].databaseId')" 2>/dev/null | grep -E 'ok |FAIL |heartbeat:'
```

Expected: two `heartbeat:` headers and six `ok` lines — three per environment.

**A green run is not sufficient evidence.** If the script were never reached,
the job would also be green. Confirm the six lines are present.

- [ ] **Step 5: Confirm the requests reached Cloudflare's analytics**

This is the step that proves the whole exercise worked. A green workflow only
shows the requests were *sent*; the dashboards are useless unless they were
also *recorded*.

Wait roughly ten minutes after a run, then open the Cloudflare dashboard and
check the request-by-hostname chart. All four hosts should show a non-zero
floor.

If they do not, stop and report it rather than continuing. Two likely causes,
and they need different fixes: analytics lag (wait longer and re-check), or the
requests are being answered somewhere that never reaches the analytics
pipeline. The second would mean the dashboards cannot see heartbeat traffic at
all, which invalidates the design rather than the implementation.

Note that scheduled runs only fire from the default branch, so a continuous
floor will not appear until this branch merges. Until then, each
`workflow_dispatch` produces one burst.

---

## Definition of Done

- `scripts/heartbeat.sh production` and `... staging` both exit `0` and print
  three `ok` lines each
- The script has been **observed failing** — bad argument exits `2`, unreachable
  host exits `1`
- `gh workflow run Heartbeat` completes successfully, and its log shows all six
  checks
- The workflow file contains `workflow_dispatch`, so it can be tested without
  waiting for cron
- Cloudflare's request-by-hostname chart shows a non-zero floor for all four
  hosts

## Not in this plan

**Analytics Engine.** Verdicts live in Actions; the requests land in
Cloudflare's HTTP datasets automatically because they cross the edge.

**Any check of the database write path**, and the "successful logins" metric the
second dashboard needs. Both require an Analytics Engine binding and a
`writeDataPoint` call inside the API worker.

**Consecutive-failure suppression.** Needs state between runs. Revisit only if
single-blip noise proves annoying in practice.
