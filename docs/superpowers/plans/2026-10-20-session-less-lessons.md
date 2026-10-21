# Session-less Lessons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a lesson mined from a commit carry `evidence.session_ids: []` end to end, and recover the artifacts already declined because it couldn't (ONL-108).

**Architecture:** Two repos, two PRs, in order. The onlooker PR widens the lesson contract and teaches the API, web and CLI to accept and render an empty list. After it deploys, the ecosystem PR widens librarian's vendored schema and jq validator, stops the transform from writing `[""]`, and gives `lessons reconsider` a `--reason schema_invalid` path.

**Tech Stack:** zod 4 + vitest (onlooker, pnpm/turbo), Cloudflare Workers vitest pool for the API, React Testing Library for web; bash + jq + bats and node:test with ajv (ecosystem).

**Spec:** `docs/superpowers/specs/2026-10-19-session-less-lessons-design.md`

## Global Constraints

- `session_ids: []` is valid. `session_ids: [""]` stays invalid, everywhere (ONL-82).
- Lesson contract version: 2.0.1 → **2.1.0**. CLI version: 2.7.0 → **2.8.0** (a version bump, not the `cli-batch` label).
- The ecosystem PR does not merge until the onlooker PR is deployed to production.
- Rollout order: API deployed → CLI 2.8.0 released and installed on every machine that runs `onlooker sync` → ecosystem PR merged and librarian installed → replay. A CLI at 2.7.0 or older that pulls a session-less lesson marks it `invalid`, skips it, and advances its cursor past it (`apps/cli/src/pull.ts:102-131`), so that machine never receives the lesson, even after upgrading.
- Locate ecosystem code by content, not by the line numbers below; they drift (measured 2026-10-20: the transform stitch had moved to `:370`, `librarian_cli_lessons_reconsider` to `:720`). Rebase on `main` as it stands when Part 2 starts.
- Every new test is proven by ablation: revert the fix it covers, watch it fail, restore.
- Edit tracked files with the Edit/Write tools, not `sed -i` or heredocs (onlooker CLAUDE.md, lineage).
- Commits go through `/git-workflow:commit`. American English.
- ecosystem has an unrelated uncommitted `.claude/settings.json` change. Never stage it.
- Run a single bats file with `bats <file>`, never `npm run test:bats <file>`: the npm form skips the file and still exits 0 (ONL-109). Check that the reported test count is above zero.
- Under macOS bash 3.2, a bare `[[ ]]` that is not a bats test's last statement does not fail the test. Chain assertions with `&&` (see `librarian-lesson-transform.bats:482`).

---

## Part 1: onlooker repo

Branch: `meagan/onl-108-session-less-lessons` (already holds the spec commit).

### Task 1: Widen the contract

**Files:**
- Modify: `packages/lesson-contract/src/evidence.ts`
- Modify: `packages/lesson-contract/src/evidence.test.ts`
- Regenerate: `packages/lesson-contract/schema/lesson.schema.json`
- Modify: `packages/lesson-contract/package.json` (version)

**Interfaces:**
- Produces: `ZEvidence` whose `session_ids` is `z.array(z.string().min(1))`, with no minimum length. `TEvidence` is unchanged in shape (`string[]`).

- [ ] **Step 1: Write the failing tests.** In `evidence.test.ts`, replace the test `"requires at least one session id"` with:

```ts
	// A lesson mined from a commit has no session that honestly produced it:
	// on a squash-merged repo the commit on main is made by GitHub. Its
	// receipts are the artifact, the project and the time (ONL-108).
	it("accepts no session ids, for a lesson mined from a commit", () => {
		expect(ZEvidence.parse({ ...valid, session_ids: [] })).toEqual({
			...valid,
			session_ids: [],
		});
	});

	// The placeholder ONL-82 removed must not come back as an empty string.
	it("rejects an empty session id", () => {
		expect(ZEvidence.safeParse({ ...valid, session_ids: [""] }).success).toBe(
			false,
		);
	});
```

- [ ] **Step 2: Run them and confirm the first fails.**

Run: `pnpm --filter @onlooker-community/lesson-contract test -- evidence`
Expected: "accepts no session ids" FAILS (too small: expected array to have >=1 items). "rejects an empty session id" passes already.

- [ ] **Step 3: Change the contract.** In `evidence.ts`, replace the doc comment and the `session_ids` line:

```ts
/**
 * The receipts behind a claim. resolution is required: a lesson that says
 * "this breaks" without "and this fixed it" is a warning, not a lesson, and
 * it gives tribunal judges nothing to check the claim against.
 *
 * session_ids may be empty. A lesson mined from a commit has no session that
 * honestly produced it - on a squash-merged repository the commit on main is
 * made by GitHub, and the session that did the work is not recorded anywhere
 * a commit can reach. Its receipts are artifact_ids, project_key and
 * observed_at. An empty string is still refused: that was the placeholder
 * ONL-82 removed, and an empty array is the honest form of the same absence.
 */
export const ZEvidence = z.strictObject({
	artifact_ids: z.array(ZUlid).min(1),
	session_ids: z.array(z.string().min(1)),
	project_key: ZProjectKey,
	observed_at: z.iso.datetime(),
	resolution: z.string().min(1),
});
```

- [ ] **Step 4: Regenerate the JSON Schema and bump the version.**

Run: `pnpm --filter @onlooker-community/lesson-contract build`
Then set `"version": "2.1.0"` in `packages/lesson-contract/package.json` (Edit tool).
Verify: `git diff packages/lesson-contract/schema/lesson.schema.json` shows only the `"minItems": 1` line under `session_ids` removed.

- [ ] **Step 5: Run the package's tests, lint and typecheck.**

Run: `pnpm --filter @onlooker-community/lesson-contract test && pnpm --filter @onlooker-community/lesson-contract lint && pnpm --filter @onlooker-community/lesson-contract typecheck`
Expected: all pass, including `json-schema.test.ts`'s drift guard.

- [ ] **Step 6: Ablate.** Temporarily restore `.min(1)` on `session_ids`, rerun Step 2's command, and confirm "accepts no session ids" fails. Restore the change.

- [ ] **Step 7: Commit** via `/git-workflow:commit` with the files above. Suggested subject: `feat(lesson-contract): let a commit-mined lesson name no session`. Body ends `Refs ONL-108`.

### Task 2: The API stores a session-less lesson

**Files:**
- Modify: `apps/api/src/routes/lessons.test.ts` (inside `describe("POST /lessons")`, after `"stores a valid lesson and returns its seq"`)

**Interfaces:**
- Consumes: `lesson(overrides)` and `push(token, lessons)` from `apps/api/src/test-support/lessons.ts`. `lesson()` merges overrides shallowly, so pass the whole `evidence` object.

- [ ] **Step 1: Write the tests.**

```ts
	// ONL-108. A commit-mined lesson has no session; the pool stores it.
	it("stores a lesson that names no session", async () => {
		const base = lesson();
		const response = await push(machineToken, [
			{ ...base, evidence: { ...base.evidence, session_ids: [] } },
		]);

		const { results } = (await response.json()) as {
			results: Array<{ outcome: string }>;
		};
		expect(results[0].outcome).toBe("created");
	});

	it("still refuses an empty session id", async () => {
		const base = lesson();
		const response = await push(machineToken, [
			{ ...base, evidence: { ...base.evidence, session_ids: [""] } },
		]);

		const { results } = (await response.json()) as {
			results: Array<{ outcome: string; error: string }>;
		};
		expect(results[0].outcome).toBe("invalid");
		expect(results[0].error).toContain("session_ids");
	});
```

- [ ] **Step 2: Run them.**

Run: `pnpm --filter @onlooker/api test -- src/routes/lessons.test.ts`
Expected: both PASS (the API takes the contract from the workspace, and Task 1 already widened it). If the second fails only on the `toContain("session_ids")` line, print `results[0].error` and match the path the API actually reports. Don't weaken the test to drop it.

- [ ] **Step 3: Ablate.** Temporarily restore `.min(1)` in `packages/lesson-contract/src/evidence.ts`, rerun Step 2, and confirm "stores a lesson that names no session" fails with outcome `invalid`. Restore.

- [ ] **Step 4: Commit** via `/git-workflow:commit`. Suggested subject: `test(api): pin that the pool stores a session-less lesson`. `Refs ONL-108`.

### Task 3: Web omits "0 sessions"

**Files:**
- Modify: `apps/web/src/pages/LessonDetail.tsx:584-591` (the muted line under "What was observed")
- Modify: `apps/web/src/__tests__/lessons-page.test.tsx` (inside `describe("the detail pane")`)

**Interfaces:**
- Consumes: the `VITE` fixture and `withPool` / `at` helpers already in `lessons-page.test.tsx`.

- [ ] **Step 1: Write the failing test.** Add to `describe("the detail pane")`:

```tsx
	// The line under "What was observed": when, how many sessions, how many
	// artifacts. A commit-mined lesson has no session (ONL-108), and "0
	// sessions" would read as missing data rather than as how it was made.
	const observedLine = (resolution: string) =>
		screen.getByText(resolution).nextElementSibling?.textContent ?? "";

	it("counts the sessions behind a lesson", async () => {
		withPool([VITE]);
		await at(`/lessons/${VITE.id}`);
		await screen.findByRole("heading", { name: VITE.claim });
		expect(observedLine(VITE.evidence.resolution)).toMatch(
			/1 session · 1 artifact$/,
		);
	});

	it("says nothing about sessions for a lesson mined from a commit", async () => {
		const MINED = {
			...VITE,
			evidence: { ...VITE.evidence, session_ids: [] as string[] },
		};
		withPool([MINED]);
		await at(`/lessons/${MINED.id}`);
		await screen.findByRole("heading", { name: MINED.claim });
		const line = observedLine(MINED.evidence.resolution);
		expect(line).not.toMatch(/session/);
		expect(line).toMatch(/ · 1 artifact$/);
	});
```

- [ ] **Step 2: Run them and confirm the second fails.**

Run: `pnpm --filter @onlooker/web test -- lessons-page`
Expected: "says nothing about sessions" FAILS (line contains "0 sessions"). The first passes.

- [ ] **Step 3: Implement.** In `LessonDetail.tsx`, replace the session segment of that `<p>`:

```tsx
							<When iso={evidence.observed_at} />
							{evidence.session_ids.length > 0 && (
								<>
									{" · "}
									{evidence.session_ids.length} session
									{evidence.session_ids.length === 1 ? "" : "s"}
								</>
							)}
							{" · "}
							{evidence.artifact_ids.length} artifact
							{evidence.artifact_ids.length === 1 ? "" : "s"}
```

- [ ] **Step 4: Run the web tests, lint and typecheck.**

Run: `pnpm --filter @onlooker/web test && pnpm --filter @onlooker/web lint && pnpm --filter @onlooker/web typecheck`
Expected: all pass.

- [ ] **Step 5: Ablate.** Revert Step 3 only, rerun Step 2, confirm the second test fails, restore.

- [ ] **Step 6: Commit** via `/git-workflow:commit`. Suggested subject: `feat(web): say nothing about sessions a lesson never had`. `Refs ONL-108`.

### Task 4: Release the CLI with the contract, verify, open the PR

**Files:**
- Modify: `apps/cli/package.json` (`"version": "2.8.0"`)

- [ ] **Step 1: Bump the CLI version** (Edit tool). `onlooker sync` bundles the contract, so the installed CLI must be rebuilt to push a session-less lesson. That's why this is a bump and not `cli-batch`.

- [ ] **Step 2: Full gates from the repo root.**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all pass. Any failure blocks the PR. Report it with its output rather than working around it.

- [ ] **Step 3: Commit** via `/git-workflow:commit`. Suggested subject: `chore(cli): release 2.8.0 with the session-less lesson contract`. `Refs ONL-108`.

- [ ] **Step 4: Open the PR** via `/git-workflow:pr`. The body names the full rollout order from Global Constraints, including that CLI 2.8.0 must be installed on every syncing machine before librarian emits a session-less lesson. Use `Refs ONL-108`, not `Fixes`, because the issue closes with the ecosystem half.

- [ ] **Step 5: After merge,** confirm the production deploy succeeded (the "Deploy to Production" job) before starting Part 2. Then confirm CLI 2.8.0 is released and `onlooker --version` reports 2.8.0 on every machine that runs `onlooker sync`.

---

## Part 2: ecosystem repo

Start only after Task 4 Step 5. Branch from fresh `main`: `meagan/onl-108-session-less-lessons`.

### Task 5: Vendored schema and jq validator agree on the new rule

**Files:**
- Modify: `plugins/librarian/schema/lesson-evidence.subschema.json` (drop `"minItems": 1` under `session_ids` only)
- Modify: `plugins/librarian/scripts/lib/librarian-lesson-validate.sh:88`
- Modify: `test/node/lesson-validate-agreement.test.mjs`
- Modify: `test/bats/librarian-lesson-transform.bats` (validator section, after `"validate_candidate accepts a well-formed versioned candidate"`)

**Interfaces:**
- Produces: `librarian_lesson_validate_candidate` returns 0 for `session_ids: []` and 1 for `[""]`.

- [ ] **Step 1: Write the failing tests.** In `lesson-validate-agreement.test.mjs`, after the baseline case:

```js
  // ONL-108: a commit-mined lesson has no session. Both mechanisms must agree
  // that an empty list is valid and an empty string is not.
  it('agree that no session ids is accepted', () => {
    assertAgree('empty session_ids', withEvidence({ session_ids: [] }), true);
  });

  it('agree that an empty session id is rejected', () => {
    assertAgree('blank session id', withEvidence({ session_ids: [''] }), false);
  });
```

In `librarian-lesson-transform.bats`:

```bash
@test "validate_candidate accepts a candidate that names no session" {
  run librarian_lesson_validate_candidate \
    "$(_candidate '{"vite":"<6"}' '["vite"]' | jq -c '.evidence.session_ids = []')"
  [ "$status" -eq 0 ]
}

@test "validate_candidate rejects an empty session id" {
  run librarian_lesson_validate_candidate \
    "$(_candidate '{"vite":"<6"}' '["vite"]' | jq -c '.evidence.session_ids = [""]')"
  [ "$status" -eq 1 ]
}
```

- [ ] **Step 2: Run them and confirm the "accepted" cases fail.**

Run: `node --test test/node/lesson-validate-agreement.test.mjs` and `bats test/bats/librarian-lesson-transform.bats`
Expected: "no session ids is accepted" and "names no session" FAIL. The two rejection cases pass.

- [ ] **Step 3: Implement.** In `lesson-evidence.subschema.json`, delete the `"minItems": 1,` line inside `session_ids` (leave the one in `artifact_ids`). In `librarian-lesson-validate.sh`, change line 88:

```
	and (.evidence.session_ids | type) == "array"
```

`PROVENANCE.json` needs no edit: it records `schema_version: 2` and which properties were extracted, and neither changes (contract 2.1.0 is still lesson `schema_version` 2, which `lint:lesson-schema` pins). This replaces the spec's "update `PROVENANCE.json`".

Keep line 89 (`all(type == "string" and length > 0)`) as it is. Above line 88, add a comment matching the file's style:

```
	# session_ids may be empty: a lesson mined from a commit has no session
	# (ONL-108). An empty string is still refused - that was ONL-82's placeholder.
```

- [ ] **Step 4: Run both tests and the schema lint.**

Run: `node --test test/node/lesson-validate-agreement.test.mjs && bats test/bats/librarian-lesson-transform.bats && npm run lint:lesson-schema`
Expected: all pass, apart from the existing `:523` test, which Task 6 rewrites. If it fails here, note it and continue.

- [ ] **Step 5: Ablate** each half separately. Restore the jq `length > 0` clause: the agreement test must fail on jq-vs-schema disagreement. Restore `minItems`: it must fail the other way. Put both fixes back.

- [ ] **Step 6: Commit** via `/git-workflow:commit` (never `.claude/settings.json`). Suggested subject: `feat(librarian): accept a lesson that names no session`. `Refs ONL-108`.

### Task 6: The transform writes `[]`, not `[""]`

**Files:**
- Modify: `plugins/librarian/scripts/lib/librarian-lesson-transform.sh:356`
- Modify: `test/bats/librarian-lesson-transform.bats:523-538` (rewrite that test)

**Interfaces:**
- Consumes: Task 5's validator.
- Produces: `librarian_lesson_transform_one` returns `proposed:<id>` for a null-session artifact, and the proposal's `.candidate.evidence.session_ids == []`.

- [ ] **Step 1: Rewrite the test at :523** as the red step. Its old concern, that a null must not become `[""]`, still holds and is now asserted directly:

```bash
@test "transform_one proposes a session-less artifact with no session ids" {
  # archivist-mine.sh writes session_id: null for every commit with no
  # Claude-Session trailer, and archivist-extract.sh does when the hook
  # payload lacked one. That absence is honest (ONL-82, ONL-108): the
  # proposal carries session_ids: [], never [""].
  _transform_setup
  art=$(jq -cn --arg id "01KZ45MKAM734ZS7JK24D2DK0R" --arg k "$PROJECT_KEY" \
    '{id: $id, kind: "decision", project_key: $k, session_id: null,
      created_at: "2026-08-03T15:59:48Z",
      summary: "Vitest 4.1.9 / Vite 5.x mismatch",
      detail: "Vitest 4.1.9 imports vite/module-runner which is absent in Vite 5.4.21."}')
  run librarian_lesson_transform_one "$PROJECT_KEY" "$art"
  id="${output#proposed:}"
  [ "$status" -eq 0 ] \
    && [[ "$output" == proposed:* ]] \
    && jq -e '.candidate.evidence.session_ids == []' \
      "${LESSONS_DIR}/proposals/${id}.json"
}
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `bats test/bats/librarian-lesson-transform.bats`
Expected: FAIL on the `proposed:*` check. The transform still stitches `[""]`, which Task 5's validator refuses for the empty string, so the output is `declined:schema_invalid`.

- [ ] **Step 3: Implement.** In `librarian-lesson-transform.sh`, change the stitch:

```bash
		'.evidence.artifact_ids = [$aid]
		 | .evidence.session_ids = (if $sid == "" then [] else [$sid] end)
		 | .evidence.project_key = $pk
		 | .evidence.observed_at = $at' 2>/dev/null) || candidate=""
```

Above `# Stitch in the provenance the model is not asked to produce.`, add:

```bash
	# A null session_id becomes [], not [""]: commit-mined artifacts have no
	# session (ONL-108), and librarian-classify-worker.sh already writes
	# source_session_ids the same way.
```

- [ ] **Step 4: Run the transform tests.**

Run: `bats test/bats/librarian-lesson-transform.bats`
Expected: all pass, including `"stitches all four provenance fields"` (which still expects `["sess-1"]`).

- [ ] **Step 5: Ablate.** Revert Step 3, confirm the rewritten test fails, restore.

- [ ] **Step 6: Commit** via `/git-workflow:commit`. Suggested subject: `fix(librarian): stop writing a blank session into commit-mined lessons`. `Refs ONL-108`.

### Task 7: `lessons reconsider --reason schema_invalid`

**Files:**
- Modify: `plugins/librarian/scripts/lib/librarian-cli.sh:714-765` (`librarian_cli_lessons_reconsider` and its header comment)
- Modify: `test/bats/librarian-lesson-reconsider.bats`

**Interfaces:**
- Consumes: `librarian_lesson_remove_declined <key> <reason>` (prints removed ids, rewrites the file), `librarian_lesson_append_declined <key> <id> <reason>`, `librarian_archivist_load_by_id <key> <id>`, `librarian_lesson_transform_one <key> <artifact> <unscoped_so_far> [forced_mode]`.
- Produces: `librarian_cli lessons reconsider [--reason no_versions|schema_invalid] [--limit N] [cwd]`. The default reason is `no_versions` and its behavior doesn't change.

- [ ] **Step 1: Write the failing tests.** In `librarian-lesson-reconsider.bats`, extend the stub so the versioned route answers with a valid candidate. Add this branch before the `else` in `_reconsider_setup`'s heredoc:

```bash
elif [[ "$prompt" == *"module-runner"* ]]; then
  printf '%s' '{"claim":"Vitest 4 cannot import vite/module-runner on Vite 5","rationale":"vite/module-runner ships in Vite 6; Vitest 4 assumes it exists.","evidence":{"resolution":"Pin vitest to 3.x until Vite 6 lands."},"applies_to":{"stack":["vite","vitest"],"scope":{"kind":"versioned","versions":{"vite":"<6","vitest":">=4"}},"file_patterns":[],"task_kinds":[]}}'
```

Give `_seed_artifact_on_disk` an optional fourth argument for the session. The default keeps every existing caller unchanged:

```bash
_seed_artifact_on_disk() {
  local dir="${ONLOOKER_DIR}/archivist/${PROJECT_KEY}/decisions"
  mkdir -p "$dir"
  jq -cn --arg id "$1" --arg s "$2" --arg d "$3" --arg k "$PROJECT_KEY" \
    --arg sid "${4-sess-1}" \
    '{id: $id, kind: "decision", project_key: $k,
      session_id: (if $sid == "" then null else $sid end),
      created_at: "2026-08-03T15:59:48Z", summary: $s, detail: $d, files: []}' \
    > "${dir}/$1.json"
}
```

Then the tests:

```bash
@test "reconsider --reason schema_invalid replays a session-less decline" {
  _reconsider_setup
  _seed_artifact_on_disk "01M3B87J7046SJE5BECNMP670K" \
    "Vitest 4.1.9 / Vite 5.x mismatch" \
    "Vitest 4.1.9 imports vite/module-runner which is absent in Vite 5.4.21." ""
  printf '%s\n' \
    '{"artifact_id":"01M3B87J7046SJE5BECNMP670K","reason":"schema_invalid","declined_at":"2026-10-18T21:46:22Z"}' \
    > "${LESSONS_DIR}/declined.jsonl"

  run librarian_cli lessons reconsider --reason schema_invalid "$PROJECT_REPO"
  [ "$status" -eq 0 ] \
    && [ "$(ls "${LESSONS_DIR}/proposals" | wc -l | tr -d ' ')" -eq 1 ] \
    && jq -e '.candidate.evidence.session_ids == []
              and .candidate.applies_to.scope.kind == "versioned"' \
      "${LESSONS_DIR}/proposals/"*.json \
    && ! grep -q "01M3B87J7046SJE5BECNMP670K" "${LESSONS_DIR}/declined.jsonl"
}

@test "reconsider --reason schema_invalid keeps a decline whose artifact has a session" {
  # A schema_invalid with a real session failed for some other reason,
  # which ONL-108 does not fix. Replaying it would spend a model call to be
  # refused again.
  _reconsider_setup
  _seed_artifact_on_disk "01M3B87J7046SJE5BECNMP670K" \
    "Vitest 4.1.9 / Vite 5.x mismatch" \
    "Vitest 4.1.9 imports vite/module-runner which is absent in Vite 5.4.21."
  printf '%s\n' \
    '{"artifact_id":"01M3B87J7046SJE5BECNMP670K","reason":"schema_invalid","declined_at":"2026-10-18T21:46:22Z"}' \
    > "${LESSONS_DIR}/declined.jsonl"

  run librarian_cli lessons reconsider --reason schema_invalid "$PROJECT_REPO"
  [ "$status" -eq 0 ] \
    && [[ "$output" == *"has a session, decline kept"* ]] \
    && jq -e 'select(.artifact_id == "01M3B87J7046SJE5BECNMP670K")
              | .reason == "schema_invalid"' < "${LESSONS_DIR}/declined.jsonl" \
    && [ -z "$(ls -A "${LESSONS_DIR}/proposals")" ]
}

@test "reconsider refuses a reason it cannot replay" {
  _reconsider_setup
  run librarian_cli lessons reconsider --reason no_resolution "$PROJECT_REPO"
  [ "$status" -eq 1 ] && [[ "$output" == *"no_resolution"* ]]
}
```

Also update the file's header comment. Its last sentence becomes: "no_versions replays forced unscoped; schema_invalid replays only artifacts with no session (ONL-108); no_resolution is still a correct refusal."

- [ ] **Step 2: Run them and confirm the three new tests fail.**

Run: `bats test/bats/librarian-lesson-reconsider.bats`
Expected: the three new tests FAIL (`unknown option: --reason`). The existing tests pass, including after the `_seed_artifact_on_disk` change.

- [ ] **Step 3: Implement.** Replace `librarian_cli_lessons_reconsider` and its header comment in `librarian-cli.sh`:

```bash
# Replay declined artifacts back through the transform. Two reasons are
# replayable, each because a later change made the original refusal wrong:
#
#   no_versions     (default) forced onto the unscoped route, which now
#                   exists for exactly these artifacts (ONL-107).
#   schema_invalid  only for an artifact with no session_id. Those were
#                   refused because the transform wrote session_ids: [""]
#                   (ONL-108). Any other schema_invalid failed for a reason
#                   nothing has fixed, so its decline is written back.
#
# no_resolution is still a correct refusal and is not accepted.
#
# Arg shape follows librarian_cli_lessons_promote: options, then an optional
# trailing [cwd] positional that resolves the project key.
librarian_cli_lessons_reconsider() {
	local limit=0 cwd="" reason="no_versions"
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--limit) limit="${2:-0}"; shift 2 ;;
			--reason) reason="${2:-}"; shift 2 ;;
			--*) printf 'unknown option: %s\n' "$1" >&2; return 1 ;;
			*) cwd="$1"; shift ;;
		esac
	done

	case "$reason" in
		no_versions|schema_invalid) ;;
		*)
			printf 'cannot reconsider %s: only no_versions and schema_invalid are replayable\n' "$reason"
			return 1
			;;
	esac

	local key
	key=$(_librarian_cli_project_key "$cwd")
	[[ -z "$key" ]] && { printf 'No project key resolvable from this directory.\n'; return 1; }

	local ids
	ids=$(librarian_lesson_remove_declined "$key" "$reason") || return 1
	[[ -z "$ids" ]] && { printf 'Nothing to reconsider: no %s declines.\n' "$reason"; return 0; }

	# remove_declined has already rewritten the file, so anything not replayed
	# here has to have its decline put back. Without that, a --limit run would
	# silently make every remaining id eligible on the next scan, outside the
	# per-scan cap the transform applies.
	local id artifact result session forced count=0 unscoped=0
	while IFS= read -r id; do
		[[ -z "$id" ]] && continue
		if [[ "$limit" -gt 0 && "$count" -ge "$limit" ]]; then
			printf '%s: stopped at --limit %s\n' "$id" "$limit"
			librarian_lesson_append_declined "$key" "$id" "$reason"
			continue
		fi
		artifact=$(librarian_archivist_load_by_id "$key" "$id" 2>/dev/null)
		if [[ -z "$artifact" ]]; then
			printf '%s: artifact missing, decline kept\n' "$id"
			librarian_lesson_append_declined "$key" "$id" "$reason"
			continue
		fi
		forced=""
		if [[ "$reason" == "no_versions" ]]; then
			# Forced unscoped, not routed: this artifact's decline record says the
			# versioned route already refused it, and the pre-gate would send it
			# straight back there — every no_versions decline passed that gate by
			# definition. See ONL-107.
			forced="unscoped"
		else
			session=$(printf '%s' "$artifact" | jq -r '.session_id // ""' 2>/dev/null)
			if [[ -n "$session" ]]; then
				printf '%s: has a session, decline kept\n' "$id"
				librarian_lesson_append_declined "$key" "$id" "$reason"
				continue
			fi
		fi
		result=$(librarian_lesson_transform_one "$key" "$artifact" "$unscoped" "$forced")
		printf '%s: %s\n' "$id" "$result"
		case "$result" in
			proposed:*:unscoped) unscoped=$((unscoped + 1)) ;;
		esac
		count=$((count + 1))
	done <<< "$ids"

	printf 'Reconsidered %s artifact(s).\n' "$count"
}
```

Check the CLI's help/usage text (`grep -n "reconsider" plugins/librarian/scripts/lib/librarian-cli.sh` and the librarian `skills/` SKILL.md). Wherever reconsider's usage is printed or documented, add `[--reason no_versions|schema_invalid]`.

- [ ] **Step 4: Run the reconsider and transform tests.**

Run: `bats test/bats/librarian-lesson-reconsider.bats test/bats/librarian-lesson-transform.bats`
Expected: all pass. The existing `"reports nothing to do when no no_versions declines exist"` still matches `*"Nothing to reconsider"*`.

- [ ] **Step 5: Ablate.** Delete the `has a session` check: the second new test must fail. Then revert Task 6's stitch: the first new test must fail. Restore both.

- [ ] **Step 6: Commit** via `/git-workflow:commit`. Suggested subject: `feat(librarian): replay the lessons a blank session refused`. `Refs ONL-108`.

### Task 8: Gates, PR, and the replay

- [ ] **Step 1: Full gates.**

Run: `npm test && npm run test:shellcheck && npm run lint:lesson-schema && npm run lint:references`
Expected: all pass. Report any failure with its output.

- [ ] **Step 2: Open the PR** via `/git-workflow:pr`, with `Fixes ONL-108`. The body states that the onlooker contract PR (link it) is already in production and that CLI 2.8.0 is installed on every syncing machine. Do not merge until both hold.

- [ ] **Step 3: After merge,** follow the four install steps (release PR merged → local clone fetched → plugin updated → process restarted). Confirm the installed librarian version contains the change before replaying.

- [ ] **Step 4: Ask before replaying.** Each replay is a model call. Report the per-key counts first:

```bash
for f in ~/.onlooker/librarian/*/lessons/declined.jsonl; do
  printf '%s ' "$f"; jq -r .reason "$f" | sort | uniq -c | tr '\n' ' '; echo
done
```

With approval, run per project directory: `lessons reconsider --reason schema_invalid --limit 10`, then `lessons reconsider --limit 10` (no_versions). Record the outcomes as a comment on ONL-108. A replayed artifact can decline again for a reason this change doesn't touch (ONL-110's transform prompt raised empty-`stack` `schema_invalid` declines), so report new declines by reason rather than counting every replay as an ONL-108 recovery.
