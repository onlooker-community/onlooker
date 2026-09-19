# Cadence Honesty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `scripts/client-error-monitor.sh` reading a window narrower than the gap between its own runs, and correct every comment in the repository that asserts a cadence GitHub does not deliver.

**Architecture:** The lookback window stops being a constant and is derived from the workflow's own run history through the GitHub API, clamped between a floor and a ceiling, with a widened constant as the announced fallback. Everything else is comment and documentation correction — no other behavior changes.

**Tech Stack:** Bash 4+ with `set -euo pipefail`, `jq` for all JSON parsing and date conversion, `curl` for the GitHub API, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-19-cadence-honesty-design.md`

## Global Constraints

- **American English** in every comment, message, and commit (project CLAUDE.md).
- **Edit tracked files with the `Edit`/`Write` tools, never `sed -i` or heredocs** — the `lineage` and `inspector` plugins hook on the tool call, not the filesystem write (project CLAUDE.md).
- **Every commit goes through `/git-workflow:commit`** — conventional commit, mood emoji reflecting this change, why-focused body (user CLAUDE.md).
- **Tabs, not spaces**, in both shell scripts — match the surrounding file.
- **`jq` does all date math.** `date -d` is GNU-only and `date -j -f` is BSD-only; `fromdateiso8601` / `todateiso8601` work on both. The scripts run on `ubuntu-latest` in CI and on macOS locally.
- **`set -u` is on.** Every environment variable read must use `${VAR:-}`.
- **Do not assign a credential into a constant whose name ends in `TOKEN`, `SECRET`, or `PASSWORD`.** A repository hook blocks writes matching `(password|secret|token)\s*[:=]\s*"..."`, and it blocks the plan as readily as the script. Read credentials into locals at the point of use.
- **Measured values are fixed** and must appear exactly: fallback 480, floor 60, ceiling 1440, overlap 5. Measurements cited in comments: median 197 / max 327 for `client-error-monitor.yml`, median 203 / max 332 for `heartbeat.yml`, both on 2026-09-19 over 20 scheduled runs.
- **No new network call may fire from a test seam.** `MONITOR_PREFLIGHT_ONLY`, `MONITOR_PRINT_QUERY`, and `MONITOR_RENDER_EVENTS` must continue to exit before any request.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `scripts/client-error-monitor.sh` | Derives the window; reads Workers Logs | 1 |
| `scripts/client-error-monitor.test.sh` | Offline proof of the derivation and its bounds | 1 |
| `.github/workflows/client-error-monitor.yml` | Grants `actions: read`, passes the credential, states the real cadence | 2 |
| `.github/workflows/heartbeat.yml` | States the real cadence above its cron | 3 |
| `.github/workflows/deploy.yml` | Drops the "31 minutes" claim | 3 |
| `apps/web/src/monitoring.ts`, `apps/web/src/lib/reportError.ts`, `packages/monitoring/src/monitor.ts` | Stop calling the workflow hourly | 4 |
| `docs/runbooks/2026-08-21-client-error-monitor.md`, `docs/observability-dashboards.md` | Correct the lookback claim and the run-rate arithmetic | 4 |
| `apps/api/src/heartbeat.ts`, `apps/api/wrangler.toml` | Append the remeasurement to the dated history | 4 |

---

### Task 1: Derive the lookback from run history

**Files:**
- Modify: `scripts/client-error-monitor.sh:44-52` (the constant block), and add one function above `build_query` at `:95`
- Modify: `scripts/client-error-monitor.sh:101-106` (`build_query` reads the resolved global)
- Modify: `scripts/client-error-monitor.sh:149-153` (the `MONITOR_PRINT_QUERY` seam resolves first)
- Modify: `scripts/client-error-monitor.sh:192` (resolve once, at top level, after `preflight`)
- Test: `scripts/client-error-monitor.test.sh:98` and `:153-158` (existing assertions change) plus a new block before `echo "client-error-monitor.sh: environment scoping"`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `resolve_lookback_minutes()` — takes no arguments, returns nothing, sets the global `LOOKBACK_MINUTES` to an integer number of minutes. Idempotent: returns immediately if `LOOKBACK_MINUTES` is already non-empty. Reads the seam `MONITOR_RUNS_RESPONSE` (a JSON string standing in for the GitHub runs API response), and reads `GITHUB_TOKEN` / `GITHUB_REPOSITORY` from the environment as function locals. Task 2 supplies both.

**Why `resolve_lookback_minutes` sets a global rather than printing:** `build_query` is called at `:275` and `:285` inside `$(...)`, which is a subshell. A value resolved there is lost to the parent, and the function would make a second API call. Resolving once at top level is what makes it happen exactly once, and it is why `build_query` must only *read* the value.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/client-error-monitor.test.sh`, immediately before the line `echo "client-error-monitor.sh: environment scoping"`:

```bash
echo
echo "client-error-monitor.sh: lookback derivation"

# runs_fixture <minutes-ago> [conclusion]
#
# Prints what the GitHub runs API returns for one completed run that started
# the given number of minutes ago. jq does the date conversion because
# `date -d` is GNU-only and `date -j -f` is BSD-only, and this suite runs on
# both.
runs_fixture() {
	local minutes_ago="$1" conclusion="${2:-success}"
	local stamp
	stamp="$(jq -rn --argjson ago "$(( $(date +%s) - minutes_ago * 60 ))" '$ago | todateiso8601')"
	jq -n -c --arg created "${stamp}" --arg conclusion "${conclusion}" \
		'{workflow_runs: [{created_at: $created, conclusion: $conclusion}]}'
}

# lookback <description> <expected-minutes> [env-assignments...]
#
# GITHUB_TOKEN is blanked on every call so the suite can never reach the
# network, whatever the ambient environment holds.
lookback() {
	local description="$1" expected="$2"
	shift 2
	local actual
	actual="$(query all CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a GITHUB_TOKEN= "$@" |
		jq -r '(.timeframe.to - .timeframe.from) / 60000 | round' 2>/dev/null || true)"
	if [[ "${actual}" == "${expected}" ]]; then
		pass "${description}"
	else
		fail "${description}" "got ${actual}, expected ${expected}"
	fi
}

lookback "derives the window from the previous run" 125 \
	MONITOR_RUNS_RESPONSE="$(runs_fixture 120)"

# The bug this whole change exists to fix: on 2026-09-19 the gap between runs
# reached 327 minutes against a fixed 180-minute window.
lookback "a 327-minute gap is covered, not truncated" 332 \
	MONITOR_RUNS_RESPONSE="$(runs_fixture 327)"

# A workflow_dispatch seconds after a scheduled run must not query a
# 30-second window and miss the report it was dispatched to check.
lookback "a too-recent previous run is floored at 60" 60 \
	MONITOR_RUNS_RESPONSE="$(runs_fixture 1)"

lookback "an ancient previous run is capped at 1440" 1440 \
	MONITOR_RUNS_RESPONSE="$(runs_fixture 4320)"

# A failed run still queried - it failed because it found client errors.
# Skipping it would re-report the same errors until a clean run.
lookback "a failed previous run still counts" 125 \
	MONITOR_RUNS_RESPONSE="$(runs_fixture 120 failure)"

lookback "empty run history falls back to 480" 480 \
	MONITOR_RUNS_RESPONSE='{"workflow_runs":[]}'

lookback "an error response falls back to 480" 480 \
	MONITOR_RUNS_RESPONSE='{"message":"Bad credentials"}'

lookback "unparseable JSON falls back to 480" 480 \
	MONITOR_RUNS_RESPONSE='not json at all'

lookback "no credential falls back to 480" 480

lookback "an explicit override beats derivation" 45 \
	CLIENT_ERROR_LOOKBACK_MINUTES=45 MONITOR_RUNS_RESPONSE="$(runs_fixture 120)"

# A silent fallback is the failure mode this change exists to end, so the
# fallback announces itself.
fallback_stderr="$(env CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a GITHUB_TOKEN= \
	MONITOR_PRINT_QUERY=1 "${MONITOR}" all 2>&1 >/dev/null || true)"
if [[ "${fallback_stderr}" == *"falling back"* && "${fallback_stderr}" == *"480"* ]]; then
	pass "the fallback says so on stderr"
else
	fail "the fallback says so on stderr" "got '${fallback_stderr}'"
fi
```

Then change two existing assertions. Line `:98` becomes:

```bash
body="$(query all CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a GITHUB_TOKEN=)"
```

and the `span` assertion at `:153-158`, which currently reads `if [[ "${span}" == "180" ]]`, becomes:

```bash
if [[ "${span}" == "480" ]]; then
	pass "the window falls back to 480 minutes without run history"
else
	fail "the window falls back to 480 minutes without run history" "got ${span}"
fi
```

Leave the `custom_span` assertion below it exactly as it is — `CLIENT_ERROR_LOOKBACK_MINUTES=45` must keep working, and it now proves the override beats derivation from the other direction.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bash scripts/client-error-monitor.test.sh`
Expected: FAIL. The derivation assertions report `got 180, expected 125` and similar, because `MONITOR_RUNS_RESPONSE` is not read yet; the fallback assertions report `got 180, expected 480`; the stderr assertion reports an empty string.

- [ ] **Step 3: Replace the constant with the bounds**

In `scripts/client-error-monitor.sh`, replace the comment block and constant at `:46-52` — everything from `# Wider than the schedule that drives it.` through the `readonly LOOKBACK_MINUTES=...` line — with:

```bash
# The window is derived per run, not declared - see resolve_lookback_minutes.
# These are its bounds, and each number has a reason.
#
# Fallback 480: the worst gap between runs measured on 2026-09-19 was 327
# minutes. This covers it with headroom, and is only reached when run history
# cannot be read at all.
readonly LOOKBACK_FALLBACK_MINUTES=480
# Floor 60: a workflow_dispatch seconds after a scheduled run would otherwise
# query a 30-second window and miss the very report it was dispatched to check.
readonly LOOKBACK_FLOOR_MINUTES=60
# Ceiling 1440: if this workflow is disabled for a week, the window must not
# become a week. Workers Logs keeps three days regardless, and each run already
# reads over a million rows.
readonly LOOKBACK_CEILING_MINUTES=1440
# Overlap 5: GitHub stamps the run and Cloudflare stamps the log, and those are
# not the same clock.
readonly LOOKBACK_OVERLAP_MINUTES=5

readonly LOOKBACK_OVERRIDE="${CLIENT_ERROR_LOOKBACK_MINUTES:-}"
readonly RUNS_WORKFLOW_FILE="client-error-monitor.yml"

# Resolved once by resolve_lookback_minutes, then read by build_query and by
# the result messages at the end of the run.
LOOKBACK_MINUTES=""
```

The seam declaration goes next to the other seams at `:58-60`, so all four sit together:

```bash
readonly MONITOR_RUNS_RESPONSE="${MONITOR_RUNS_RESPONSE:-}"
```

The GitHub credential is deliberately *not* hoisted into a constant here. It is read as a local inside `resolve_lookback_minutes`, which is the only place that needs it — and a top-level `readonly SOMETHING_TOKEN="..."` trips the repository's secret-scanning hook.

- [ ] **Step 4: Add the resolver**

Insert immediately above the `# build_query [filters-json]` comment at `:95`:

```bash
# resolve_lookback_minutes
#
# Sets LOOKBACK_MINUTES to how many minutes this run should read, derived from
# when this workflow last completed rather than from a constant.
#
# WHY NOT A CONSTANT: there was one. 180 minutes, sized on 2026-08-16 against a
# 24-minute median delivery (onlooker-2ho). By 2026-09-19 GitHub was delivering
# this workflow every 197 minutes at the median and 327 at the worst, so 11 of
# the last 19 runs left a window nobody read - up to 147 minutes of client
# error reports at the worst. Nothing changed but GitHub, and nothing here
# noticed. A wider constant inherits exactly that shelf life. Run history does
# not: it tracks throttling as throttling changes.
#
# COMPLETED, NOT SUCCESSFUL: this script exits 1 when it finds client errors,
# which fails the run on purpose. A failed run still queried. Asking only for
# successful runs would drag the window back across every failure and re-report
# the same errors on every run until a clean one, turning one alert into a
# repeating one.
#
# The hole that leaves, stated rather than engineered around: exit 2 means the
# monitor could not do its job, and from the runs API that is indistinguishable
# from exit 1. Such a run's interval is treated as covered. That is acceptable
# because an exit 2 run already emailed a human. The gap worth closing here is
# the silent one.
resolve_lookback_minutes() {
	if [[ -n "${LOOKBACK_MINUTES}" ]]; then
		return
	fi

	if [[ -n "${LOOKBACK_OVERRIDE}" ]]; then
		LOOKBACK_MINUTES="${LOOKBACK_OVERRIDE}"
		return
	fi

	# Read here rather than hoisted to a constant: this is the only consumer,
	# and a top-level readonly ending in TOKEN trips the secret-scanning hook.
	local auth="${GITHUB_TOKEN:-}"
	local repo="${GITHUB_REPOSITORY:-}"

	local response=""
	if [[ -n "${MONITOR_RUNS_RESPONSE}" ]]; then
		response="${MONITOR_RUNS_RESPONSE}"
	elif [[ -n "${auth}" && -n "${repo}" ]]; then
		# status=completed excludes the run doing the asking, which would
		# otherwise always be the most recent one. per_page=1 because the API
		# returns newest first and only the newest is wanted.
		response="$(curl --silent --max-time 10 \
			--header "Authorization: Bearer ${auth}" \
			--header "Accept: application/vnd.github+json" \
			"https://api.github.com/repos/${repo}/actions/workflows/${RUNS_WORKFLOW_FILE}/runs?status=completed&per_page=1" \
			2>/dev/null || true)"
	fi

	# try/catch rather than a shape check: an error response has no
	# workflow_runs at all, and fromdateiso8601 on null throws rather than
	# returning empty.
	local last_epoch=""
	if [[ -n "${response}" ]]; then
		last_epoch="$(printf '%s' "${response}" |
			jq -r 'try (.workflow_runs[0].created_at | fromdateiso8601) catch empty' 2>/dev/null || true)"
	fi

	if [[ ! "${last_epoch}" =~ ^[0-9]+$ ]]; then
		LOOKBACK_MINUTES="${LOOKBACK_FALLBACK_MINUTES}"
		echo "client-error-monitor: no previous run to measure from, falling back to a ${LOOKBACK_FALLBACK_MINUTES}m window" >&2
		return
	fi

	local minutes=$(( ( $(date +%s) - last_epoch ) / 60 + LOOKBACK_OVERLAP_MINUTES ))

	if (( minutes < LOOKBACK_FLOOR_MINUTES )); then
		minutes="${LOOKBACK_FLOOR_MINUTES}"
	elif (( minutes > LOOKBACK_CEILING_MINUTES )); then
		echo "client-error-monitor: last run was over ${LOOKBACK_CEILING_MINUTES}m ago, capping the window there" >&2
		minutes="${LOOKBACK_CEILING_MINUTES}"
	fi

	LOOKBACK_MINUTES="${minutes}"
}
```

- [ ] **Step 5: Wire the resolver into both call paths**

In the `MONITOR_PRINT_QUERY` seam at `:149-153`, add the resolve call between `require_jq` and `build_query`:

```bash
if [[ -n "${MONITOR_PRINT_QUERY}" ]]; then
	require_jq
	resolve_lookback_minutes
	build_query
	exit 0
fi
```

On the real path, immediately after the `preflight` call and its `MONITOR_PREFLIGHT_ONLY` guard at `:192-195`, add:

```bash
# Resolved here, at top level, and not inside build_query: build_query is
# called from $(...) at the control and client-error queries below, and a value
# resolved inside a subshell is lost - which would also mean two API calls.
resolve_lookback_minutes
```

`build_query` itself changes only in that `LOOKBACK_MINUTES` is now a resolved global rather than a constant; the arithmetic at `:105` stays exactly as written.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bash scripts/client-error-monitor.test.sh`
Expected: PASS — `client-error-monitor.test.sh: all N tests passed`, with N raised by exactly 11 over the previous run (10 `lookback` assertions plus the stderr one; the `span` assertion was changed, not added).

- [ ] **Step 7: Verify the seams still make no network request**

Run: `env -u GITHUB_TOKEN CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a MONITOR_PREFLIGHT_ONLY=1 bash scripts/client-error-monitor.sh all`
Expected: prints `preflight: run`, exits 0, returns immediately with no pause for a network round trip.

Run: `bash -n scripts/client-error-monitor.sh && bash -n scripts/client-error-monitor.test.sh`
Expected: no output, exit 0.

- [ ] **Step 8: Commit**

Use `/git-workflow:commit`. Stage exactly `scripts/client-error-monitor.sh` and `scripts/client-error-monitor.test.sh`. The body carries the measurement (median 197 / max 327 on 2026-09-19, 11 of 19 gaps wider than the window) and `Refs onlooker-txcu.5, ONL-51`.

---

### Task 2: Give the workflow the permission and the credential

**Files:**
- Modify: `.github/workflows/client-error-monitor.yml:13-15` (the header claim), `:21-22` (permissions), `:72-74` and `:88-90` (both step `env` blocks)

**Interfaces:**
- Consumes: `resolve_lookback_minutes` from Task 1, which reads `GITHUB_TOKEN` and `GITHUB_REPOSITORY`.
- Produces: nothing later tasks depend on.

Without this task, Task 1's derivation falls back to 480 on every production run and says so on stderr each time. Task 1 is correct without it and simply never takes the derived path.

- [ ] **Step 1: Grant `actions: read`**

The `permissions` block currently reads `contents: read` alone. Replace it with:

```yaml
permissions:
  contents: read
  # Reading this workflow's own run history is how the script sizes its
  # lookback window - see resolve_lookback_minutes in
  # scripts/client-error-monitor.sh. Without this it falls back to a fixed
  # 480-minute window and says so on stderr.
  actions: read
```

- [ ] **Step 2: Pass the credential to both steps**

Add this line to the staging step's `env:` block (after `CLOUDFLARE_ACCOUNT_ID` at `:74`) and again to the production step's (after `CLOUDFLARE_ACCOUNT_ID` at `:90`):

```yaml
          GITHUB_TOKEN: ${{ github.token }}
```

Both steps need it: they are separate script invocations and each resolves its own window.

- [ ] **Step 3: Correct the header claim**

Replace the paragraph at `:13-15` beginning `# Hourly rather than every five minutes.` with:

```yaml
# Declared hourly, delivered every ~197 minutes at the median and 327 at the
# worst - measured 2026-09-19 over the last 20 scheduled runs. GitHub throttles
# scheduled workflows silently, dropping runs rather than queueing them, so
# every run that does fire succeeds and nothing looks wrong. The cron below is
# a request, not a promise.
#
# The declared hour is kept rather than rewritten to match: a frequent
# declaration acts as continuous retry, and a sparse cron that gets dropped has
# no attempts behind it to catch. Re-declaring would trade a measured cadence
# for an unmeasured one.
#
# The reports being watched here are already hours old by the time anyone can
# act on them, and each run reads over a million log rows, so a tighter
# schedule would buy nothing and spend quota.
#
# What the drift cost, before it was noticed: the lookback window was a fixed
# 180 minutes, narrower than the median gap, so 11 of the last 19 runs left
# client errors that no run ever read. The window is now derived from this
# workflow's own run history. See onlooker-txcu.5 (ONL-51).
```

- [ ] **Step 4: Verify the workflow still parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/client-error-monitor.yml'))" && echo ok`
Expected: `ok`.

- [ ] **Step 5: Commit**

Use `/git-workflow:commit`. Stage only `.github/workflows/client-error-monitor.yml`.

---

### Task 3: Correct the CI cadence claims

**Files:**
- Modify: `.github/workflows/heartbeat.yml:8-11` (above the cron)
- Modify: `.github/workflows/deploy.yml:798-802` (the smoke test comment)

**Interfaces:** Independent of Tasks 1 and 2. Comment-only; no behavior changes.

- [ ] **Step 1: State the real cadence above the heartbeat cron**

`heartbeat.yml:11` is `    - cron: '*/5 * * * *'`. After the existing `# workflow_dispatch is deliberate:` paragraph and before the `on:` key, insert:

```yaml
# The cron below is a request, not a promise. Measured 2026-09-19 over the last
# 20 scheduled runs, it delivers every 203 minutes at the median and 332 at the
# worst. GitHub throttles scheduled workflows silently: it drops runs rather
# than queueing them, so every run that fires succeeds and nothing looks wrong.
#
# It stays '*/5' anyway. That declaration functions as continuous retry, and a
# sparse cron that gets dropped has no attempts behind it to catch - declaring
# '0 */3 * * *' would read honestly and might well deliver worse. The frequent
# shallow check that actually needs a kept schedule already moved to a
# Cloudflare cron trigger (apps/api/src/heartbeat.ts); what is left here is the
# deep authenticated check, where lateness costs less. See onlooker-txcu.5.
```

- [ ] **Step 2: Drop the "31 minutes" claim in deploy.yml**

Replace the comment at `:798-802` — the paragraph ending `up to 31 minutes later on the cron, and next to the commit responsible.` — with:

```yaml
      # Runs after the website deploy as well as the app and API, so it is the
      # last word on a production release. A failure here means production is
      # already serving the bad build - the gate is the alarm, not the
      # prevention - but the alarm rings in the run that caused it, next to the
      # commit responsible, rather than whenever the next periodic check
      # happens to notice.
      #
      # This used to say "up to 31 minutes later on the cron". That number was
      # wrong twice over: heartbeat.yml delivers every ~203 minutes, not 31
      # (measured 2026-09-19), and the frequent check no longer lives there at
      # all - it runs on a Cloudflare cron trigger every five minutes, which is
      # a schedule that is actually kept. See onlooker-txcu.5.
```

- [ ] **Step 3: Verify both workflows still parse**

Run: `python3 -c "import yaml; [yaml.safe_load(open(f)) for f in ['.github/workflows/heartbeat.yml','.github/workflows/deploy.yml']]" && echo ok`
Expected: `ok`.

- [ ] **Step 4: Commit**

Use `/git-workflow:commit`. Stage `.github/workflows/heartbeat.yml` and `.github/workflows/deploy.yml`.

---

### Task 4: Correct the application and documentation claims

**Files:**
- Modify: `apps/web/src/monitoring.ts:40`, `apps/web/src/lib/reportError.ts:16`, `packages/monitoring/src/monitor.ts:137`
- Modify: `docs/runbooks/2026-08-21-client-error-monitor.md:135`
- Modify: `docs/observability-dashboards.md:209` and `:270`
- Modify: `apps/api/src/heartbeat.ts:7-11`, `apps/api/wrangler.toml:101-104`

**Interfaces:** Independent of Tasks 1-3. Comment and prose only.

- [ ] **Step 1: Correct the three "hourly" claims in code**

Each justifies a design decision on a false alerting latency. Correct the latency, keep the decision.

`apps/web/src/monitoring.ts:40` reads `client-error-monitor.yml alerts hourly. Sending to the provider instead of`. Change `alerts hourly` to `alerts every few hours (~197 min median, measured 2026-09-19)`.

`apps/web/src/lib/reportError.ts:16` reads `hourly workflow stays fed until it is retired on purpose.` Change `hourly workflow` to `client-error-monitor workflow`.

`packages/monitoring/src/monitor.ts:137` reads `today and an hourly workflow alerts on it; sending to a new provider instead`. Change `an hourly workflow` to `a workflow reading a derived window`.

- [ ] **Step 2: Correct the runbook**

`docs/runbooks/2026-08-21-client-error-monitor.md:135` reads:

```markdown
3. **Expect repeats.** The 180-minute lookback is wider than the hourly
```

The lookback is no longer 180 and no longer fixed, and the reason to expect repeats is now the 5-minute overlap rather than a wide constant. Rewrite the item as:

```markdown
3. **Expect repeats.** The lookback window is derived from when this workflow
   last completed, plus a 5-minute overlap for clock skew, so an error near a
   window boundary can be reported twice. That overlap is deliberate: a
   repeated email costs less than a report nobody reads. It replaced a fixed
   180-minute window that had become narrower than the median gap between runs
   (onlooker-txcu.5).
```

- [ ] **Step 3: Correct the dashboard arithmetic**

`docs/observability-dashboards.md:209` reads `median of 24 minutes imply ~60 runs/day, which overstates the real rate by ~13%.` That median is a 2026-08-16 figure. Append to the sentence:

```markdown
(That 24-minute median was measured 2026-08-16. The same workflow measured a
203-minute median on 2026-09-19 — GitHub's throttling tightened roughly
eightfold with nothing in the repository changing, so treat any run-rate
arithmetic here as a snapshot with a short shelf life. See onlooker-txcu.5.)
```

`docs/observability-dashboards.md:270` reads `some of the time: ~4.4% of clock-hours at hourly, constantly at the 15 minutes`. The "at hourly" figure rests on the same stale rate; append to the sentence containing it: `— on the delivery measured 2026-09-19 (~197-minute median) the hourly figure is closer to constant.`

- [ ] **Step 4: Append the remeasurement to the dated history**

`apps/api/src/heartbeat.ts:7-11` and `apps/api/wrangler.toml:101-104` both cite the 2026-09-13 numbers. Both are dated and attributed, so they are history and get an addition, not a rewrite.

In `apps/api/src/heartbeat.ts`, after the sentence ending `See onlooker-txcu.5.` in the opening block, add:

```typescript
 * Remeasured 2026-09-19 over 20 runs: a 203-minute median, 332 at the worst.
 * The throttling tightened rather than eased.
```

The same block at `:9-11` says a comment in deploy.yml "still reasoned about the alarm ringing 'up to 31 minutes later on the cron'". Task 3 corrects that comment, so change `still reasoned` to `reasoned, until 2026-09-19,`.

In `apps/api/wrangler.toml`, after the sentence ending `GitHub throttles scheduled workflows silently.` at `:103`, add:

```toml
# Remeasured 2026-09-19 over 20 runs: 203-minute median, 332 at the worst.
```

- [ ] **Step 5: Verify nothing broke**

Run: `pnpm -r exec tsc --noEmit 2>&1 | tail -5`
Expected: no errors. These are comment-only changes, but `monitor.ts` and `monitoring.ts` are typechecked sources and a malformed block comment breaks the parse.

Run: `git diff --stat`
Expected: 8 files changed, comment additions and rewrites only, no logic lines.

- [ ] **Step 6: Commit**

Use `/git-workflow:commit`. Stage all eight files from this task.

---

## Verification before opening the PR

- [ ] `bash scripts/client-error-monitor.test.sh` — all tests pass
- [ ] `bash scripts/heartbeat.test.sh` — unchanged, still passes
- [ ] `bash -n` clean on both modified shell scripts
- [ ] All four modified workflow files parse as YAML
- [ ] `grep -rn "hourly\|31 minutes" --include="*.ts" --include="*.yml" --include="*.md" . | grep -v node_modules` returns nothing that still asserts a false cadence
- [ ] `bd update onlooker-txcu.5 --append-notes` with the remeasurement and what shipped — `--append-notes`, never `--notes`, which replaces the whole body
- [ ] ONL-51 moved in Linear by a human — `bd linear sync --pull` overwrites local status from Linear, so closing the bead alone does not stick

## Out of scope

Both are named in the spec and neither belongs on this branch:

- A dead man's switch for the Worker cron (`apps/api/src/heartbeat.ts:17-24` states the gap; overlaps `onlooker-txcu.9`).
- Moving the client error check onto the Cloudflare cron.
