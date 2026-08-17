# Authenticated Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the heartbeat prove production can say *yes*, not only that it correctly says *no*.

**Architecture:** Four checks are appended to `scripts/heartbeat.sh` — log in, read `/auth/me` with the returned bearer token, log out, then confirm the logout took by refreshing with the revoked token and expecting `401`. Credentials arrive as environment variables that `.github/workflows/heartbeat.yml` maps from per-environment secrets. Absent credentials skip locally and fail in CI.

**Tech Stack:** Bash 3.2+ (`set -euo pipefail`), `curl`, `jq`, GitHub Actions.

**Spec:** [`docs/superpowers/specs/2026-08-17-authenticated-heartbeat-design.md`](../specs/2026-08-17-authenticated-heartbeat-design.md)

**Bead:** `onlooker-9bn`

## Global Constraints

- **American English** in all comments, docs and commit messages.
- **The script must never print `HEARTBEAT_EMAIL` or `HEARTBEAT_PASSWORD`.** This repository is public, which makes its Actions logs public. Check labels name the check, not the account.
- **The password must not appear in process arguments.** Build the request body with `jq -n` and pipe it to `curl --data @-`.
- **Assertions are equality**, not "not an error" — matching the existing `check()` contract.
- **Account addresses:** `heartbeat@onlooker.dev` (production), `heartbeat-staging@onlooker.dev` (staging). No Email Routing rule for either.
- **Existing checks 1–4 must not change.** Their behavior is load-bearing and separately verified.
- Commit with the `/commit` skill; conventional commits, mood emoji, why-focused body.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/heartbeat.sh` | Modify. Adds credential preflight, a shared pass/fail recorder, and checks 5–8. |
| `scripts/heartbeat.test.sh` | Create. Offline tests for the preflight logic — the one piece of new branching that can rot silently. |
| `.github/workflows/heartbeat.yml` | Modify. Maps per-environment secrets into the generic variables and sets `HEARTBEAT_REQUIRE_AUTH`. |
| `.github/workflows/deploy.yml` | Modify. One step so `heartbeat.test.sh` runs on every PR. |
| `docs/runbooks/2026-08-17-heartbeat-account.md` | Create. Provisioning, rotation, and what the account may own. |
| `docs/observability-dashboards.md` | Modify. Volumes table and Dashboard 4's `401` baseline. |
| `docs/superpowers/specs/2026-08-09-heartbeat-design.md` | Modify. A pointer to the new spec; its request counts are already stale. |

---

### Task 1: Credential preflight and a shared recorder

**Files:**
- Modify: `scripts/heartbeat.sh` (the `check()` function, around lines 45–79)
- Create: `scripts/heartbeat.test.sh`

**Interfaces:**
- Produces: `record <label> <outcome> <detail>` where `outcome` is the literal `ok` or `fail`; increments `checks`, and `failures` when failing. `auth_preflight()` returns `0` to run authenticated checks, `1` to skip them, and exits `2` when they are required but unavailable.
- Consumes: nothing from earlier tasks.

**Why this task exists separately:** the preflight is the spec's anti-rot guard. A deleted or renamed secret must break the build rather than quietly return this script to what it was before. That is the one piece of logic worth testing offline.

- [ ] **Step 1: Write the failing test**

Create `scripts/heartbeat.test.sh`:

```bash
#!/usr/bin/env bash
# Offline tests for scripts/heartbeat.sh credential handling.
#
# These make no network requests. They exist because the authenticated checks
# skip when credentials are absent, and a skip is how a check rots into a no-op
# that passes forever. The guard that prevents that is worth pinning.
set -uo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HEARTBEAT="${SCRIPT_DIR}/heartbeat.sh"

tests=0
failures=0

# expect_preflight <expected-exit> <expected-branch> <description> <env-assignments...>
#
# Asserts BOTH the exit code and which branch the preflight took. The exit code
# alone cannot tell "run" from "skip" - they both exit 0 - so a bug that made
# the preflight skip forever would pass an exit-code-only suite while quietly
# disabling every authenticated check. That is the exact failure this guard
# exists to prevent, so the test has to be able to see it.
#
# <expected-branch> is `run`, `skip`, or empty for the exit-2 cases, which
# terminate before printing anything to stdout.
expect_preflight() {
	local expected_exit="$1" expected_branch="$2" description="$3"
	shift 3

	tests=$((tests + 1))

	local output="" actual=0
	output="$(env "$@" HEARTBEAT_PREFLIGHT_ONLY=1 "${HEARTBEAT}" production 2>/dev/null)" || actual=$?

	local branch=""
	case "${output}" in
		*"preflight: run"*) branch="run" ;;
		*"preflight: skip"*) branch="skip" ;;
	esac

	if [[ "${actual}" == "${expected_exit}" && "${branch}" == "${expected_branch}" ]]; then
		echo "  ok    ${description}"
	else
		echo "  FAIL  ${description} -> exit ${actual}, branch '${branch}' (expected exit ${expected_exit}, branch '${expected_branch}')"
		failures=$((failures + 1))
	fi
}

echo "heartbeat.sh: credential preflight"

expect_preflight 2 "" "required but no credentials -> exit 2" \
	HEARTBEAT_REQUIRE_AUTH=1 HEARTBEAT_EMAIL= HEARTBEAT_PASSWORD=

expect_preflight 2 "" "required but password only -> exit 2" \
	HEARTBEAT_REQUIRE_AUTH=1 HEARTBEAT_EMAIL= HEARTBEAT_PASSWORD=secret

expect_preflight 2 "" "required but email only -> exit 2" \
	HEARTBEAT_REQUIRE_AUTH=1 HEARTBEAT_EMAIL=a@b.test HEARTBEAT_PASSWORD=

expect_preflight 0 "skip" "not required and no credentials -> skips" \
	HEARTBEAT_EMAIL= HEARTBEAT_PASSWORD=

expect_preflight 0 "run" "required and both present -> runs" \
	HEARTBEAT_REQUIRE_AUTH=1 HEARTBEAT_EMAIL=a@b.test HEARTBEAT_PASSWORD=secret

if (( failures > 0 )); then
	echo "heartbeat.sh: ${failures} of ${tests} tests failed"
	exit 1
fi

echo "heartbeat.sh: all ${tests} tests passed"
```

Make it executable:

```bash
chmod +x scripts/heartbeat.test.sh
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bash scripts/heartbeat.test.sh`
Expected: FAIL on all five cases. `HEARTBEAT_PREFLIGHT_ONLY` is not implemented yet, so the script runs its real checks against live hosts. The three exit-2 cases get exit `0` instead, and the two exit-0 cases report branch `''` because nothing prints `preflight: run` or `preflight: skip` yet.

If any case passes here, stop and work out why — a test that passes before the code exists is testing nothing.

- [ ] **Step 3: Refactor `check()` onto a shared recorder**

In `scripts/heartbeat.sh`, replace the body of `check()` so counting lives in one place. Insert `record()` immediately above `check()`:

```bash
# record <label> <ok|fail> <detail>
#
# One place that counts, so the summary line cannot drift from what actually
# ran. `check` below is status-code assertions; the authenticated checks need
# to assert on response bodies too, and both report through here.
record() {
	local label="$1" outcome="$2" detail="${3:-}"

	checks=$((checks + 1))

	if [[ "${outcome}" == "ok" ]]; then
		echo "  ok    ${label}"
	else
		echo "  FAIL  ${label} -> ${detail}"
		failures=$((failures + 1))
	fi
}
```

Then rewrite the tail of `check()` to delegate. Replace these lines:

```bash
	checks=$((checks + 1))
```

(delete that line from `check()` — `record` now owns it) and replace:

```bash
	if [[ "${actual}" == "${expected}" ]]; then
		echo "  ok    ${label} -> ${actual}"
	else
		echo "  FAIL  ${label} -> ${actual} (expected ${expected})"
		failures=$((failures + 1))
	fi
```

with:

```bash
	if [[ "${actual}" == "${expected}" ]]; then
		record "${label} -> ${actual}" ok
	else
		record "${label}" fail "${actual} (expected ${expected})"
	fi
```

- [ ] **Step 4: Add the preflight and its test hook**

Insert after the `USER_AGENT` declaration and before `failures=0`:

```bash
# Credentials for the authenticated checks. Absent, those checks are skipped:
# somebody running this by hand has no reason to hold production credentials,
# and the read-only checks above are still worth having.
#
# Skipping is also how a check rots into a no-op that passes forever, so CI
# sets HEARTBEAT_REQUIRE_AUTH and absent credentials become a failure there. A
# secret that is deleted or renamed breaks the build rather than quietly
# returning this script to what it was before it could log in.
readonly HEARTBEAT_EMAIL="${HEARTBEAT_EMAIL:-}"
readonly HEARTBEAT_PASSWORD="${HEARTBEAT_PASSWORD:-}"
readonly HEARTBEAT_REQUIRE_AUTH="${HEARTBEAT_REQUIRE_AUTH:-}"
```

Then add the function after `record()`:

```bash
# Decide whether the authenticated checks can run.
#   0 - run them
#   1 - skip them, and say so
#   exit 2 - they were required and cannot run
#
# jq is a hard requirement rather than a nicety: it builds the login body, so
# a password containing a quote or a backslash is escaped by a JSON encoder
# rather than by hand.
auth_preflight() {
	local missing=""

	if [[ -z "${HEARTBEAT_EMAIL}" ]]; then
		missing="${missing} HEARTBEAT_EMAIL"
	fi
	if [[ -z "${HEARTBEAT_PASSWORD}" ]]; then
		missing="${missing} HEARTBEAT_PASSWORD"
	fi
	if ! command -v jq >/dev/null 2>&1; then
		missing="${missing} jq"
	fi

	if [[ -z "${missing}" ]]; then
		return 0
	fi

	if [[ -n "${HEARTBEAT_REQUIRE_AUTH}" ]]; then
		# Deliberately names what is missing and nothing else. Never echo the
		# values - this repository is public and so are its Actions logs.
		echo "heartbeat: authenticated checks are required but unavailable:${missing}" >&2
		exit 2
	fi

	echo "  skip  authenticated checks (missing:${missing})"
	return 1
}
```

Immediately after the `echo "heartbeat: ${ENVIRONMENT}"` line, add the test hook:

```bash
# Test hook: resolve credentials, then stop before making any request. Used by
# scripts/heartbeat.test.sh so the guard can be tested without network.
#
# It prints which branch it took because the exit code cannot say: run and skip
# both exit 0, so without this a preflight that skipped forever - disabling
# every authenticated check - would pass its own tests.
if [[ -n "${HEARTBEAT_PREFLIGHT_ONLY:-}" ]]; then
	if auth_preflight; then
		echo "preflight: run"
	else
		echo "preflight: skip"
	fi
	exit 0
fi
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `bash scripts/heartbeat.test.sh`
Expected: PASS — `all 5 tests passed`.

- [ ] **Step 6: Confirm the existing checks still behave**

Run: `scripts/heartbeat.sh production`
Expected: the four existing checks report `ok` and `all 4 checks passed`, exactly as before this task.

There is deliberately no `skip` line yet. `auth_preflight` is defined here but nothing calls it outside the test hook — the call site arrives in Task 2. If you see a skip line at this point, something was added early.

- [ ] **Step 7: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add scripts/heartbeat.sh scripts/heartbeat.test.sh
```

---

### Task 2: The four authenticated checks

**Files:**
- Modify: `scripts/heartbeat.sh` (append after check 4, the `api d1 read` check)

**Interfaces:**
- Consumes: `record()`, `auth_preflight()`, `API_URL`, `USER_AGENT`, `HEARTBEAT_EMAIL`, `HEARTBEAT_PASSWORD` from Task 1.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add a body-and-status request helper**

Insert after `auth_preflight()`:

```bash
# api_request <method> <path> [extra curl args...]
#
# Prints the response body, then a final line holding the status code. Callers
# split on the last newline. The existing `check` discards bodies with
# -o /dev/null; these checks need them, because a 200 carrying the wrong user
# is a worse failure than a 500 and a status code cannot see it.
api_request() {
	local method="$1" path="$2"
	shift 2

	curl -s --max-time 10 -A "${USER_AGENT}" \
		-w $'\n%{http_code}' \
		-X "${method}" "${API_URL}${path}" \
		"$@" || true
}
```

- [ ] **Step 2: Add checks 5–8**

Append immediately before the `if (( failures > 0 ))` summary block:

```bash
# --- Authenticated checks -------------------------------------------------
#
# Everything above proves the API correctly says no. An outage confined to the
# authenticated path - a rotated JWT secret, a bad users migration, a
# requireAuth regression - passes every one of them. These prove it can say
# yes, which is a different claim.
#
# This is also where the script stops being read-only: check 5 writes a session
# row and check 7 revokes it. That is the cost of verifying that writing works.
if auth_preflight; then
	# jq builds the body so the password is escaped by a JSON encoder, and the
	# pipe keeps it out of this process's arguments.
	login_payload="$(jq -n \
		--arg email "${HEARTBEAT_EMAIL}" \
		--arg password "${HEARTBEAT_PASSWORD}" \
		'{email: $email, password: $password}')"

	login_response="$(printf '%s' "${login_payload}" |
		api_request POST /auth/login \
			-H 'Content-Type: application/json' \
			--data @-)"
	login_status="${login_response##*$'\n'}"
	login_body="${login_response%$'\n'*}"

	access_token=""
	refresh_token=""

	if [[ "${login_status}" != "200" ]]; then
		record "auth login" fail "${login_status} (expected 200)"
	else
		access_token="$(printf '%s' "${login_body}" | jq -r '.token // empty')"
		refresh_token="$(printf '%s' "${login_body}" | jq -r '.refreshToken // empty')"

		if [[ -z "${access_token}" || -z "${refresh_token}" ]]; then
			# A 200 with no tokens in it is a success the client cannot use.
			record "auth login" fail "200 without token and refreshToken"
		else
			record "auth login -> 200" ok
		fi
	fi

	if [[ -n "${access_token}" ]]; then
		# The access token goes in argv, unlike the password. It expires in
		# TOKEN_EXPIRY_MINUTES (15), belongs to an account that owns nothing,
		# and the runner is destroyed after the job. The password is the
		# durable secret and it is the one worth the extra handling.
		me_response="$(api_request GET /auth/me \
			-H "Authorization: Bearer ${access_token}")"
		me_status="${me_response##*$'\n'}"
		me_body="${me_response%$'\n'*}"
		me_email="$(printf '%s' "${me_body}" | jq -r '.user.email // empty')"

		if [[ "${me_status}" != "200" ]]; then
			record "auth me" fail "${me_status} (expected 200)"
		elif [[ "${me_email}" != "${HEARTBEAT_EMAIL}" ]]; then
			# Never print either address. That this failed is the whole
			# message; the values belong in a private log, and this one is
			# public.
			record "auth me" fail "200 for a different account than expected"
		else
			record "auth me -> 200" ok
		fi
	fi

	if [[ -n "${refresh_token}" ]]; then
		logout_payload="$(jq -n --arg token "${refresh_token}" '{refreshToken: $token}')"
		logout_response="$(printf '%s' "${logout_payload}" |
			api_request POST /auth/logout \
				-H 'Content-Type: application/json' \
				--data @-)"
		logout_status="${logout_response##*$'\n'}"

		if [[ "${logout_status}" == "200" ]]; then
			record "auth logout -> 200" ok
		else
			record "auth logout" fail "${logout_status} (expected 200)"
		fi

		# Logout once revoked nothing at all, so a logged-out session could
		# call /auth/refresh indefinitely, each call minting a fresh 30-day
		# window. That shipped. This is the assertion that would have caught
		# it, and it costs one request.
		revoked_response="$(printf '%s' "${logout_payload}" |
			api_request POST /auth/refresh \
				-H 'Content-Type: application/json' \
				--data @-)"
		revoked_status="${revoked_response##*$'\n'}"

		if [[ "${revoked_status}" == "401" ]]; then
			record "auth revoked refresh -> 401" ok
		else
			record "auth revoked refresh" fail "${revoked_status} (expected 401)"
		fi
	fi
fi
```

- [ ] **Step 3: Rewrite the script header, which now lies**

The header currently claims the script proves the read path works "without writing anything." Replace the first four comment lines:

```bash
# Synthetic heartbeat: proves each deployed host is reachable, that the
# database read path works, and that a real session can be created, used and
# revoked.
#
# Checks 1-4 write nothing. Checks 5-8 deliberately do: they log in, which
# writes a session row, and log out, which revokes it. A check that cannot
# write cannot verify that writing works, and "the API correctly says no" is a
# different claim from "the API works" - only the first was ever monitored.
```

- [ ] **Step 4: Verify the skip path is unchanged**

Run: `scripts/heartbeat.sh production`
Expected: four `ok` lines, one `skip` line, `all 4 checks passed`. No credentials locally means checks 5–8 must not run.

- [ ] **Step 5: Verify the guard fires**

Run: `HEARTBEAT_REQUIRE_AUTH=1 scripts/heartbeat.sh production; echo "exit=$?"`
Expected: `heartbeat: authenticated checks are required but unavailable: HEARTBEAT_EMAIL HEARTBEAT_PASSWORD` on stderr, `exit=2`.

- [ ] **Step 6: Confirm the offline tests still pass**

Run: `bash scripts/heartbeat.test.sh`
Expected: `all 5 tests passed`.

- [ ] **Step 7: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add scripts/heartbeat.sh
```

**Note:** checks 5–8 cannot be run end-to-end until Task 3 provisions the accounts. That is expected; do not fabricate credentials to test them here.

---

### Task 3: Provision the accounts — HUMAN HANDOFF, gates Task 4

**Files:**
- Create: `docs/runbooks/2026-08-17-heartbeat-account.md`

**Interfaces:**
- Consumes: nothing.
- Produces: two accounts and four repository secrets that Task 4 depends on.

**This task gates Task 4.** Task 4 sets `HEARTBEAT_REQUIRE_AUTH=1`, which makes every heartbeat run fail until these secrets exist. Do not merge Task 4 before this is done.

**Steps 2 and 3 can only be performed by the repository owner.** An agent executing this plan should write the runbook, then stop and hand off.

- [ ] **Step 1: Write the runbook**

Create `docs/runbooks/2026-08-17-heartbeat-account.md`:

````markdown
# Runbook — the heartbeat account

**Created:** 2026-08-17
**Design:** [authenticated heartbeat](../superpowers/specs/2026-08-17-authenticated-heartbeat-design.md)

The heartbeat logs in on every run to prove the authenticated path works. This
is the account it logs in as.

| | Production | Staging |
|---|---|---|
| Address | `heartbeat@onlooker.dev` | `heartbeat-staging@onlooker.dev` |
| Password secret | `HEARTBEAT_PASSWORD_PRODUCTION` | `HEARTBEAT_PASSWORD_STAGING` |
| Address secret | `HEARTBEAT_EMAIL_PRODUCTION` | `HEARTBEAT_EMAIL_STAGING` |

## Rules

**It owns nothing.** No data anyone would miss, no elevated permission. It is
an ordinary user row that exists to be logged into.

**Its address does not route.** There is no Email Routing rule for either
address and there should not be one. Password reset is impossible by
construction rather than by policy, which matters because this repository is
public, `/auth/forgot-password` is public, and Email Routing forwards to a
personal inbox — a routable address would make reading that inbox sufficient to
take the account.

**It is permanently unverified, on purpose.** `email_verified` stays `null`
because nothing can confirm an address that accepts no mail. Nothing in the
login path reads that column today. If verification ever gates login, this
heartbeat will start failing — which is correct signal, because the same change
would lock out every unverified real user. Fix the product decision, not the
heartbeat.

**The address is a secret, not an Actions variable.** Not for obscurity — the
runbook names it — but because secrets are masked in logs and this repository's
logs are public.

## Creating one

Use the product's own signup endpoint so the password hash is produced by the
same code that will later verify it. No hand-written SQL, no hand-generated
bcrypt hash.

Generate a password:

```bash
openssl rand -base64 32
```

Create the account (production shown; for staging use
`https://api-staging.onlooker.dev` and the staging address):

```bash
read -rs HEARTBEAT_PW    # paste the generated password, it will not echo
jq -n --arg email 'heartbeat@onlooker.dev' \
      --arg password "${HEARTBEAT_PW}" \
      '{email: $email, password: $password, name: "Heartbeat"}' |
  curl -s -X POST https://api.onlooker.dev/auth/signup \
    -H 'Content-Type: application/json' --data @-
```

Expect `201` or `200` with a `token` and `refreshToken` in the body. A `409`
with `user_exists` means the account is already there — do not create a second.

Then set the secrets under **Settings → Secrets and variables → Actions**:
`HEARTBEAT_EMAIL_PRODUCTION`, `HEARTBEAT_PASSWORD_PRODUCTION`,
`HEARTBEAT_EMAIL_STAGING`, `HEARTBEAT_PASSWORD_STAGING`.

Finally, unset the shell variable so the password does not sit in the session:

```bash
unset HEARTBEAT_PW
```

## Rotating one

Because the address does not route, there is no reset flow. Two options:

1. **Change the password** via `POST /auth/change-password` using the current
   one, then update the secret.
2. **Replace the account** — create a new one at a new address, update both
   secrets, and delete the old via `DELETE /auth/account`. Simpler when the
   current password is lost, and cheap because the account owns nothing.

Option 2 is the recovery path if the password is ever lost. There is no other
one, and that is deliberate.

## When the heartbeat fails on an authenticated check

The four authenticated checks are `auth login`, `auth me`, `auth logout` and
`auth revoked refresh`. What each failure means:

| Failing check | Most likely cause |
|---|---|
| `auth login` returning `401` | Password drift between the database and the secret. Rotate. |
| `auth login` returning `200 without token and refreshToken` | The login handler's response shape changed. A client-breaking change. |
| `auth me` returning `401` | `JWT_SECRET` changed, or `requireAuth` regressed. |
| `auth me` returning a different account | A serious `getUserById` or session-lookup bug. Treat as an incident. |
| `auth logout` failing | Revocation is broken; sessions will not end. |
| `auth revoked refresh` returning `200` | Logout is not revoking. This exact regression has shipped once before. |
| The run failing with `authenticated checks are required but unavailable` | A secret was deleted or renamed. The guard is working. |
````

- [ ] **Step 2: HUMAN — create both accounts**

Follow the runbook's "Creating one" section against production and staging. Two accounts, two passwords.

- [ ] **Step 3: HUMAN — set the four repository secrets**

`HEARTBEAT_EMAIL_PRODUCTION`, `HEARTBEAT_PASSWORD_PRODUCTION`, `HEARTBEAT_EMAIL_STAGING`, `HEARTBEAT_PASSWORD_STAGING`.

- [ ] **Step 4: Verify the full flow by hand against staging**

With the staging values exported in your shell:

```bash
HEARTBEAT_EMAIL='heartbeat-staging@onlooker.dev' \
HEARTBEAT_PASSWORD='<the staging password>' \
  scripts/heartbeat.sh staging
```

Expected: `all 8 checks passed`. This is the first end-to-end run of checks 5–8 and it must pass before the workflow is wired up.

- [ ] **Step 5: Commit the runbook**

Use the `/commit` skill. Stage exactly:

```bash
git add docs/runbooks/2026-08-17-heartbeat-account.md
```

---

### Task 4: Wire the workflow

**Files:**
- Modify: `.github/workflows/heartbeat.yml:34-44`
- Modify: `.github/workflows/deploy.yml` (the `quality` job)

**Interfaces:**
- Consumes: the four secrets from Task 3, and `HEARTBEAT_REQUIRE_AUTH` handling from Task 1.
- Produces: nothing consumed by later tasks.

**Do not start this task until Task 3 steps 2 and 3 are confirmed done.**

- [ ] **Step 1: Add credentials to the staging step**

In `.github/workflows/heartbeat.yml`, replace the `Staging (advisory)` step with:

```yaml
      - name: Staging (advisory)
        env:
          HEARTBEAT_EMAIL: ${{ secrets.HEARTBEAT_EMAIL_STAGING }}
          HEARTBEAT_PASSWORD: ${{ secrets.HEARTBEAT_PASSWORD_STAGING }}
          # Required here too. Staging is advisory, so a missing secret surfaces
          # as a warning rather than a failure - but it still surfaces, instead
          # of silently reducing this step to the read-only checks.
          HEARTBEAT_REQUIRE_AUTH: '1'
        run: |
          if ! scripts/heartbeat.sh staging; then
            echo "::warning title=Staging heartbeat failed::One or more staging checks did not return the expected status. This does not fail the run."
            echo "⚠️ **Staging heartbeat failed** — see the step log above." >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
          fi
```

- [ ] **Step 2: Add credentials to the production step**

Replace the `Production` step with:

```yaml
      - name: Production
        env:
          HEARTBEAT_EMAIL: ${{ secrets.HEARTBEAT_EMAIL_PRODUCTION }}
          HEARTBEAT_PASSWORD: ${{ secrets.HEARTBEAT_PASSWORD_PRODUCTION }}
          HEARTBEAT_REQUIRE_AUTH: '1'
        run: scripts/heartbeat.sh production
```

- [ ] **Step 3: Run the offline tests in CI**

In `.github/workflows/deploy.yml`, inside the `quality` job's `steps`, after the checkout step, add:

```yaml
      # The heartbeat's credential guard decides whether the authenticated
      # checks run at all. It is the one piece of that script that can fail
      # silently, by skipping forever, so it is pinned on every PR.
      - name: Heartbeat script tests
        run: bash scripts/heartbeat.test.sh
```

- [ ] **Step 4: Verify the workflow parses**

Run: `gh workflow view heartbeat.yml`
Expected: the workflow is listed without a parse error.

- [ ] **Step 5: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add .github/workflows/heartbeat.yml .github/workflows/deploy.yml
```

- [ ] **Step 6: HUMAN — trigger a real run once merged**

```bash
gh workflow run heartbeat.yml
gh run watch
```

Expected: `all 8 checks passed` for both environments. `workflow_dispatch` exists on this workflow precisely so this does not require waiting for the schedule.

---

### Task 5: Correct the documented volumes

**Files:**
- Modify: `docs/observability-dashboards.md` (the `### Expected volumes` table and Dashboard 4's `401` paragraph)
- Modify: `docs/superpowers/specs/2026-08-09-heartbeat-design.md` (status header)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Update the volumes table**

In `docs/observability-dashboards.md`, replace the table under `### Expected volumes`:

```markdown
| | per day |
|---|---|
| heartbeat runs | ~53 |
| `onlooker-api-production` invocations | ~318 |
| `onlooker-web-production` invocations | ~106 |
| D1 queries per database | ~318 |
| total requests, all four hosts | ~848 |
```

- [ ] **Step 2: Say where the new figures came from**

The section's own rule is that every figure records how it was measured. Immediately after the table, add:

```markdown
The API and D1 figures roughly tripled on 2026-08-17 when the heartbeat gained
four authenticated checks — login, an authenticated read, logout, and a
revoked-token refresh. Six API requests per environment per run rather than
two, and six D1 operations rather than one.

**These two are derived, not measured.** They come from counting the calls each
handler makes, against the same ~53 runs/day. Every other figure in this table
was counted from delivered runs, and the ones that were derived have been wrong
twice. Re-measure and correct them here.
```

- [ ] **Step 3: Correct Dashboard 4's baseline**

In the Dashboard 4 section, the `401s over time` paragraph says the script produces exactly 4 `401`s per run, two per environment. Replace that sentence:

```markdown
This used to be phrased as a constant to subtract by eye — the script produced
exactly 4 401s per run, two per environment. It is now 6, three per environment,
since the revoked-token check asserts a 401 too. That the number moved is the
argument: it lived in a human's head, adding a check invalidated it, and
Cloudflare charts cannot draw a reference line at it anyway. The label replaces
arithmetic with a filter, and did not need updating when the number changed.
```

- [ ] **Step 4: Point the old spec at the new one**

In `docs/superpowers/specs/2026-08-09-heartbeat-design.md`, replace the `**Status:**` line:

```markdown
**Status:** Implemented and running — amended after measurement, then extended
**Date:** 2026-08-09 (design), amended same day once the schedule had run
**Extended by:** [the authenticated heartbeat](2026-08-17-authenticated-heartbeat-design.md), 2026-08-17

The request table below describes checks 1–4 only, and its "six requests per
run, three per environment" is doubly out of date: a deep-link check was added
in PR #49, and four authenticated checks in 2026-08-17. It is eight per
environment now. The reasoning here about equality assertions and about why
`/auth/refresh` is the database check is unchanged and still worth reading.
```

- [ ] **Step 5: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add docs/observability-dashboards.md docs/superpowers/specs/2026-08-09-heartbeat-design.md
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Checks 5–8 with stated assertions | 2 |
| Check 6 asserts email, not only status | 2 |
| Password via `--data @-`, not argv | 2 |
| Never print email or password | 1, 2 |
| Per-environment secrets → generic env vars | 4 |
| Email as secret, not Actions variable | 3 (runbook), 4 (workflow) |
| Skip locally, fail in CI via `HEARTBEAT_REQUIRE_AUTH` | 1 |
| Unroutable addresses, distinct per environment | 3 |
| Permanently unverified, documented as deliberate | 3 |
| Provisioning via `/auth/signup` | 3 |
| Runbook: creation, rotation, owns nothing | 3 |
| Script header stops claiming it writes nothing | 2 |
| Volumes table corrected, labeled derived | 5 |
| Dashboard 4 `401` baseline corrected | 5 |

**Type consistency:** `record <label> <ok|fail> <detail>` is defined in Task 1 and called with that arity in Tasks 1 and 2. `auth_preflight` returns `0`/`1`/exit `2` consistently in Tasks 1, 2 and 4. `api_request <method> <path> [args]` is defined in Task 2 step 1 and used four times in step 2. Variable names `access_token`, `refresh_token`, `login_payload`, `logout_payload` are consistent across step 2.

**Known gap, accepted:** checks 5–8 have no automated test — only the credential guard does. Testing them offline would need a mock API, and testing them online needs the credentials Task 3 provisions. Task 3 step 4 and Task 4 step 6 are manual end-to-end verifications instead, which is how the original heartbeat's checks were verified in its own spec.
