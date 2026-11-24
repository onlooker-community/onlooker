# Tribunal Override Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a `/tribunal` run ends `rejected` or `exhausted_iterations`, the skill asks whether to keep, discard or retry the changes, and records the answer as one `tribunal.session.resolved` event.

**Architecture:** Two PRs, in order.

1. **schema** registers `tribunal.session.resolved`, and is released first.
2. **ecosystem** then adds `plugins/tribunal/scripts/lib/tribunal-resolve.sh`. It holds the testable parts: the baseline taken at the start of a run, the discard, and the payload builder. The `/tribunal` skill gains two steps that call it.

The spec is `docs/superpowers/specs/2026-11-22-tribunal-override-signal-design.md` in the onlooker repo. Read it before starting.

**Tech Stack:**

- schema: TypeScript, JSON Schema and vitest, with npm.
- ecosystem: bash libs (bash 3.2-compatible), git, jq, and bats through `scripts/test/run-bats.sh`.

## Global Constraints

- **Event type:** `tribunal.session.resolved`. Its payload has `additionalProperties: false` and these fields:
  - `task_id: string` (required).
  - `outcome: "rejected" | "exhausted_iterations"` (required).
  - `decision: "kept" | "discarded" | "retried"` (required).
  - `files_restored: integer ≥ 0` (optional, discard only).
  - `files_left: integer ≥ 0` (optional, discard only).
- **Role:** `lifecycle`, never `output`. The web app counts `output` events toward a plugin's "Produced" line.
- **Counts, never paths,** in the event.
- **No event means unanswered.** Never emit a guess.
- **Discard never touches a file that was dirty or untracked before the run.**
- **Bash 3.2.** No associative arrays, no `mapfile`, no `${var,,}`, no globstar. An empty array expands as `${a[@]+"${a[@]}"}` under `set -u`.
- **Arithmetic:** `x=$((x + 1))`, never a bare `(( x++ ))`. `npm run lint:bash-arithmetic` enforces it.
- **bats gating:** every non-final assertion ends with `|| return 1`. Use `[ ]` in bats, not `[[ ]]`. `npm run lint:bats-assertions` enforces it.
- **Every git call that takes a path passes `--literal-pathspecs`,** as `tribunal-session-files.sh` does.
- **`$ONLOOKER_DIR`, never `~/.onlooker`,** in code.
- **No shell formatters** (`biome check --write`, `lint:fix`). Match formatting by hand with the Edit tool. Run only the lint and format *checks*.
- **Commits** go through `/git-workflow:commit`, and PRs through `/git-workflow:pr`. Never push to main.
- **Worktrees:** the main `ecosystem` checkout holds another session's branch (`meagan/onl-307-...`), so don't touch it. Work in new worktrees, as below.
- **American English** everywhere.

## Decisions beyond the spec

These came out of planning. Each one is a way of meeting a rule the spec states. Flag any that look wrong before Task 2.

1. **The baseline stores a content hash per dirty file.** It's how discard knows which pre-existing files the actor "touched again", so it names only those. A file that was dirty before the run and untouched since is neither restored nor counted in `files_left`.
2. **The baseline stores `HEAD`, and discard refuses (exit 2, touching nothing) if `HEAD` moved.** A moved `HEAD` means the actor committed. Restoring to the new `HEAD` would keep the commit and report a discard that didn't happen. The skill tells the person, and emits nothing.
3. **A retry carries the first run's baseline forward,** by copying `baseline.json` into the new task directory. Taking a fresh one would treat the first run's edits as "dirty before the run", so a discard after the retry could never remove them.
4. **`tribunal_discard` takes only `<task_dir>`.** The worktree root is read from the baseline, so the two can't disagree.
5. **Files git ignores aren't seen.** A build output the actor creates under an ignored path survives a discard, because `git status` doesn't list it.
6. **The baseline needs a commit to restore to.** In a repository with no commits, `tribunal_baseline_write` fails, and Discard isn't offered.
7. **Discard fails closed** (added after Task 2's review). Discard validates and loads the baseline once, before changing anything, and returns 1 if it can't. The code first written here sent any jq error down the delete or restore path.
8. **A pre-run file the actor reverted or deleted is named** (added after Task 2's review). Such a file no longer shows in `git status`, so discard counts every baseline entry missing from it as left.
9. **Discard returns 3 on a partial failure** (added after Task 2's review). If a file can't be restored or deleted, discard still prints the usual stdout, names the file on stderr as `tribunal: could not restore <path>`, and returns 3.
10. **The baseline is written atomically** (added after Task 2's review). A failed write leaves no file behind.

11. **A retry of a run with no baseline gets none** (added after Task 5's review). The earlier run's directory is noted as `previous_task_dir` before the new `task_dir` is computed. If the earlier run had no baseline, the retry doesn't write a fresh one, and it doesn't offer Discard.
12. **The emit step is runnable as written** (added after Task 5's review). `outcome` is among the values set again in each shell. `task_id` is the run being resolved. Discard's exit code, stdout and stderr are captured separately. The example is split into a keep/retry block and a discard block.
13. **A failed discard asks again** (added after Task 5's review). After exit 1 or 2, the person is asked again with only Keep and Retry. Exit 2 says HEAD moved, "most likely a commit".

Task 2's code blocks below are the version first planned. Commit d5150696 and the fix commit that follows it are the authority. Likewise, Task 5's prose was corrected in its fix round, and the final review changed both again. What shipped in ecosystem #629 (tribunal 1.11.0) is the authority.

## File structure

**schema repo** (worktree `/Users/meaganwaller/src/github.com/onlooker-community/schema-tribunal-resolved`):

| File | Change |
|---|---|
| `schemas/event.v1.json` | One `event_type` enum entry. |
| `schemas/payload/plugins-safety.json` | One payload schema. |
| `src/event-types.ts` | A constant, and its place in `ALL_EVENT_TYPES`. |
| `src/types.ts` | The payload interface and its `PayloadMap` entry. |
| `src/event-roles.ts` | The role. |
| `src/validate.test.ts`, `src/event-roles.test.ts` | Tests. |

**ecosystem repo** (worktree `/Users/meaganwaller/src/github.com/onlooker-community/ecosystem-tribunal-resolved`):

| File | Change |
|---|---|
| `plugins/tribunal/scripts/lib/tribunal-resolve.sh` | New: the baseline, the discard and the payload builder. |
| `test/bats/tribunal-resolve.bats` | New: its tests, against scratch git repositories. |
| `test/bats/tribunal-events.bats` | Emission of the new event validates against the schema. |
| `test/bus-coverage.json` | The new type in `expected`. |
| `package.json`, `package-lock.json` | Bump `@onlooker-community/schema`. |
| `plugins/tribunal/skills/tribunal/SKILL.md` | The baseline step and the end-of-run question. |
| `plugins/tribunal/README.md` | How it works, storage layout, and events. |

---

### Task 1: Schema PR — register `tribunal.session.resolved`

**Files** (all in the schema worktree):

- Modify: `schemas/event.v1.json`. The enum entry goes after `"tribunal.session.complete"`, at line 95.
- Modify: `schemas/payload/plugins-safety.json`. The payload goes after the `"tribunal.session.complete"` block, which ends at line 90.
- Modify: `src/event-types.ts`. The constant goes after line 25. The array entry goes after `TRIBUNAL_SESSION_COMPLETE,`, at line 228.
- Modify: `src/types.ts`. The interface goes after `TribunalSessionCompletePayload`, which ends at line 189. The map entry goes after line 1759.
- Modify: `src/event-roles.ts`. The role goes after `"tribunal.session.complete": "lifecycle",`, at line 85.
- Test: `src/validate.test.ts` and `src/event-roles.test.ts`.

**Interfaces:**

- Produces:
  - `TRIBUNAL_SESSION_RESOLVED = "tribunal.session.resolved"`.
  - `TribunalSessionResolvedPayload`.
  - A published release `3.x.0`, which Task 4 depends on.

- [ ] **Step 1: Make the worktree**

```bash
cd /Users/meaganwaller/src/github.com/onlooker-community/schema
git fetch origin
git worktree add ../schema-tribunal-resolved -b meagan/onl-308-tribunal-session-resolved origin/main
cd ../schema-tribunal-resolved
npm ci
```

- [ ] **Step 2: Write the failing tests**

In `src/validate.test.ts`:

1. Add `TRIBUNAL_SESSION_RESOLVED,` to the import list, between `TRIBUNAL_SESSION_COMPLETE,` and `TRIBUNAL_SESSION_START,`.
2. Add this block after the `describe("tribunal.nudge.skipped", ...)` block:

```ts
// What the person did after a /tribunal run the jury did not accept. A
// rejection with no resolved event is one nobody answered (ONL-308).
describe("tribunal.session.resolved", () => {
	beforeEach(() => {
		_resetSequence();
	});

	function resolved(payload: unknown) {
		return createEvent({
			runtime: "claude-code",
			plugin: "tribunal",
			machine_id: MACHINE_ID,
			session_id: "session-resolved-1",
			event_type: TRIBUNAL_SESSION_RESOLVED,
			payload: payload as never,
		});
	}

	it("validates each decision for each outcome it resolves", () => {
		for (const outcome of ["rejected", "exhausted_iterations"] as const) {
			for (const decision of ["kept", "discarded", "retried"] as const) {
				expect(
					validate(resolved({ task_id: "t", outcome, decision })).valid,
				).toBe(true);
			}
		}
	});

	it("validates a discard's file counts", () => {
		expect(
			validate(
				resolved({
					task_id: "t",
					outcome: "rejected",
					decision: "discarded",
					files_restored: 3,
					files_left: 1,
				}),
			).valid,
		).toBe(true);
	});

	it("rejects a missing decision", () => {
		expect(
			validate(resolved({ task_id: "t", outcome: "rejected" })).valid,
		).toBe(false);
	});

	it("rejects an unknown decision", () => {
		expect(
			validate(
				resolved({ task_id: "t", outcome: "rejected", decision: "ignored" }),
			).valid,
		).toBe(false);
	});

	// Only a run the jury did not accept is asked about.
	it.each(["accepted", "aborted"])("rejects the %s outcome", (outcome) => {
		expect(
			validate(resolved({ task_id: "t", outcome, decision: "kept" })).valid,
		).toBe(false);
	});

	it("rejects a negative count", () => {
		expect(
			validate(
				resolved({
					task_id: "t",
					outcome: "rejected",
					decision: "discarded",
					files_restored: -1,
				}),
			).valid,
		).toBe(false);
	});

	// Counts, never paths: the event says nothing about the person's code.
	it("rejects an unregistered property", () => {
		expect(
			validate(
				resolved({
					task_id: "t",
					outcome: "rejected",
					decision: "discarded",
					file_paths: ["src/a.ts"],
				}),
			).valid,
		).toBe(false);
	});
});
```

In `src/event-roles.test.ts`, add after the `describe("EVENT_TYPE_ROLES", ...)` block:

```ts
describe("tribunal.session.resolved", () => {
	// A person's answer after a rejection, not something tribunal produced. As
	// "output" it would count toward the plugin's "Produced" line in the web
	// app, once for every keep, discard and retry (ONL-308).
	it("is lifecycle, not output", () => {
		expect(roleOf("tribunal.session.resolved")).toBe("lifecycle");
	});
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npm test -- src/validate.test.ts src/event-roles.test.ts`

Expected:
- The new `validate` cases fail: the valid ones because the type is unknown, so every expectation of `true` fails.
- The role test fails with `undefined`.
- The "rejects" cases may pass already. They prove nothing until Step 5.

- [ ] **Step 4: Register the type**

`schemas/event.v1.json`, after `"tribunal.session.complete",`:

```json
				"tribunal.session.resolved",
```

`schemas/payload/plugins-safety.json`, after the `"tribunal.session.complete"` block's closing `},`:

```json
		"tribunal.session.resolved": {
			"type": "object",
			"additionalProperties": false,
			"required": ["task_id", "outcome", "decision"],
			"properties": {
				"task_id": {
					"type": "string",
					"description": "The run being resolved. Joins to its tribunal.session.start and tribunal.session.complete."
				},
				"outcome": {
					"type": "string",
					"enum": ["rejected", "exhausted_iterations"],
					"description": "How the run ended. Only a run the jury did not accept is asked about; accepted and aborted never are."
				},
				"decision": {
					"type": "string",
					"enum": ["kept", "discarded", "retried"],
					"description": "What the person chose for the actor's changes. kept is the override: work the jury rejected stays. discarded restores the files the run changed that were clean when it started. retried starts a new run, with its own task_id. A non-accepted run with no resolved event went unanswered."
				},
				"files_restored": {
					"type": "integer",
					"minimum": 0,
					"description": "Discard only. Files restored to HEAD or, if the run created them, deleted."
				},
				"files_left": {
					"type": "integer",
					"minimum": 0,
					"description": "Discard only. Files that were already dirty before the run and that the actor changed again. They are left alone."
				}
			}
		},
```

`src/event-types.ts`, after `TRIBUNAL_SESSION_COMPLETE`'s line:

```ts
export const TRIBUNAL_SESSION_RESOLVED = "tribunal.session.resolved" as const;
```

and in `ALL_EVENT_TYPES`, after `TRIBUNAL_SESSION_COMPLETE,`:

```ts
	TRIBUNAL_SESSION_RESOLVED,
```

`src/types.ts`, after `TribunalSessionCompletePayload`:

```ts
/**
 * What the person did after a /tribunal run ended without acceptance. Emitted
 * once they answer, so a rejection with none went unanswered.
 */
export interface TribunalSessionResolvedPayload {
	task_id: string;
	outcome: "rejected" | "exhausted_iterations";
	/** `kept` is the override: work the jury rejected stays. */
	decision: "kept" | "discarded" | "retried";
	/** Discard only: files restored to HEAD, or deleted if the run created them. */
	files_restored?: number;
	/** Discard only: files dirty before the run that the actor changed again. */
	files_left?: number;
}
```

and in `PayloadMap`, after `"tribunal.session.complete": TribunalSessionCompletePayload;`:

```ts
	"tribunal.session.resolved": TribunalSessionResolvedPayload;
```

`src/event-roles.ts`, after `"tribunal.session.complete": "lifecycle",`:

```ts
	// A person's answer after a rejected run, not something tribunal produced.
	"tribunal.session.resolved": "lifecycle",
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npm test -- src/validate.test.ts src/event-roles.test.ts`

Expected: all pass. Two existing tests pass only if all three registrations agree:
- "covers the same types the envelope schema accepts"
- "has exactly one role for every registered event type"

- [ ] **Step 6: Mutation check**

1. Temporarily add `"accepted"` to the new `outcome` enum.
2. Run `npm test -- src/validate.test.ts`, and confirm `rejects the accepted outcome` fails.
3. Revert.
4. Temporarily change the role to `"output"`, confirm the role test fails, and revert.

- [ ] **Step 7: Run the full check**

Run: `npm run ci`

Expected: lint, typecheck, tests and schema validation all pass. If the format check fails, fix the formatting with the Edit tool. Don't run a formatter.

- [ ] **Step 8: Commit and open the PR**

Run `/git-workflow:commit`, with the subject `feat(events): record what happens after tribunal rejects work`. The body says why:
- Tribunal had no override to count: it never blocks, so keeping rejected work is the override.
- The role is `lifecycle`.

Then run `/git-workflow:pr`, with `Refs ONL-308`. Meagan submits and merges it, and release-please publishes the minor release. Note the published version, `3.x.0`, for Task 4.

---

### Task 2: The baseline and the discard

**Files** (all in the ecosystem worktree):

- Create: `plugins/tribunal/scripts/lib/tribunal-resolve.sh`
- Test: `test/bats/tribunal-resolve.bats`

**Interfaces:**

- Produces:
  - `tribunal_baseline_write <task_dir> <worktree>` writes `<task_dir>/baseline.json` and returns 0. It returns 1, writing nothing, outside a git worktree or before the first commit. The file looks like this:
    ```json
    {"root": "<toplevel>", "head": "<sha>", "dirty": [{"path": "<relative path>", "hash": "<blob sha, or \"\" for a deleted file>"}]}
    ```
  - `tribunal_discard <task_dir>` prints `<restored> <left>`, then each left path on its own line, and returns 0. Its other returns:
    - **1**, touching nothing, when the baseline is missing or unreadable.
    - **2**, touching nothing, when `HEAD` moved.
    - **3** when some files couldn't be restored. They're named on stderr as `tribunal: could not restore <path>`, and stdout is as for 0.

- [ ] **Step 1: Make the worktree**

```bash
cd /Users/meaganwaller/src/github.com/onlooker-community/ecosystem
git fetch origin
git worktree add ../ecosystem-tribunal-resolved -b meagan/onl-308-tribunal-override-signal origin/main
cd ../ecosystem-tribunal-resolved
npm ci
```

- [ ] **Step 2: Write the failing tests**

Create `test/bats/tribunal-resolve.bats`:

```bash
#!/usr/bin/env bats

# tribunal-resolve.sh: the baseline a /tribunal run takes when it starts, the
# discard offered when the jury does not accept the result, and the
# tribunal.session.resolved payload (ONL-308). The rule every discard test
# protects: a file that was dirty before the run is never touched.

setup() {
	# shellcheck source=../helpers/setup.bash
	source "${BATS_TEST_DIRNAME}/../helpers/setup.bash"
	setup_test_env
	# shellcheck source=../../plugins/tribunal/scripts/lib/tribunal-resolve.sh
	source "${REPO_ROOT}/plugins/tribunal/scripts/lib/tribunal-resolve.sh"

	# Keeps git from finding a repository above the scratch directory, so the
	# outside-git case is outside git wherever the suite runs.
	export GIT_CEILING_DIRECTORIES="$BATS_TEST_TMPDIR"

	REPO="${BATS_TEST_TMPDIR}/repo"
	TASK="${BATS_TEST_TMPDIR}/task"
	mkdir -p "$REPO"
	git -C "$REPO" init -q
	git -C "$REPO" config user.email test@example.com
	git -C "$REPO" config user.name test
	printf 'a\n' > "$REPO/a.txt"
	printf 'b\n' > "$REPO/b.txt"
	git -C "$REPO" add a.txt b.txt
	git -C "$REPO" commit -q -m init
}

@test "baseline fails outside a git worktree and writes nothing" {
	mkdir -p "${BATS_TEST_TMPDIR}/plain"
	run tribunal_baseline_write "$TASK" "${BATS_TEST_TMPDIR}/plain"
	[ "$status" -eq 1 ] || return 1
	[ ! -e "$TASK/baseline.json" ]
}

@test "baseline fails before the first commit and writes nothing" {
	mkdir -p "${BATS_TEST_TMPDIR}/fresh"
	git -C "${BATS_TEST_TMPDIR}/fresh" init -q
	run tribunal_baseline_write "$TASK" "${BATS_TEST_TMPDIR}/fresh"
	[ "$status" -eq 1 ] || return 1
	[ ! -e "$TASK/baseline.json" ]
}

@test "baseline records the root, HEAD, and each dirty path with its hash" {
	printf 'mine\n' >> "$REPO/b.txt"
	printf 'n\n' > "$REPO/notes.txt"
	tribunal_baseline_write "$TASK" "$REPO" || return 1
	local b="$TASK/baseline.json"
	[ "$(jq -r .head "$b")" = "$(git -C "$REPO" rev-parse HEAD)" ] || return 1
	[ "$(jq -r .root "$b")" = "$(git -C "$REPO" rev-parse --show-toplevel)" ] || return 1
	[ "$(jq -r '[.dirty[].path] | sort | join(",")' "$b")" = "b.txt,notes.txt" ] || return 1
	[ "$(jq -r '.dirty[] | select(.path == "b.txt") | .hash' "$b")" = "$(git -C "$REPO" hash-object b.txt)" ]
}

@test "baseline of a clean tree lists nothing dirty" {
	tribunal_baseline_write "$TASK" "$REPO" || return 1
	[ "$(jq '.dirty | length' "$TASK/baseline.json")" = "0" ]
}

@test "discard restores a tracked file the actor changed" {
	tribunal_baseline_write "$TASK" "$REPO" || return 1
	printf 'actor\n' >> "$REPO/a.txt"
	run tribunal_discard "$TASK"
	[ "$status" -eq 0 ] || return 1
	[ "$output" = "1 0" ] || return 1
	[ "$(cat "$REPO/a.txt")" = "a" ]
}

@test "discard brings back a tracked file the actor deleted" {
	tribunal_baseline_write "$TASK" "$REPO" || return 1
	rm "$REPO/a.txt"
	run tribunal_discard "$TASK"
	[ "$output" = "1 0" ] || return 1
	[ "$(cat "$REPO/a.txt")" = "a" ]
}

@test "discard deletes an untracked file the actor created" {
	tribunal_baseline_write "$TASK" "$REPO" || return 1
	mkdir -p "$REPO/new/dir"
	printf 'x\n' > "$REPO/new/dir/x.txt"
	run tribunal_discard "$TASK"
	[ "$output" = "1 0" ] || return 1
	[ ! -e "$REPO/new/dir/x.txt" ]
}

@test "discard removes a new file the actor staged, from the index too" {
	tribunal_baseline_write "$TASK" "$REPO" || return 1
	printf 'x\n' > "$REPO/staged.txt"
	git -C "$REPO" add staged.txt
	run tribunal_discard "$TASK"
	[ "$output" = "1 0" ] || return 1
	[ ! -e "$REPO/staged.txt" ] || return 1
	[ -z "$(git -C "$REPO" status --porcelain)" ]
}

@test "discard handles a path with a space" {
	tribunal_baseline_write "$TASK" "$REPO" || return 1
	printf 'x\n' > "$REPO/my notes.txt"
	run tribunal_discard "$TASK"
	[ "$output" = "1 0" ] || return 1
	[ ! -e "$REPO/my notes.txt" ]
}

@test "discard leaves a file dirty before the run, and names it when the actor changed it again" {
	printf 'mine\n' >> "$REPO/b.txt"
	tribunal_baseline_write "$TASK" "$REPO" || return 1
	printf 'actor\n' >> "$REPO/b.txt"
	printf 'actor\n' >> "$REPO/a.txt"
	run tribunal_discard "$TASK"
	[ "$status" -eq 0 ] || return 1
	[ "$output" = "$(printf '1 1\nb.txt')" ] || return 1
	[ "$(cat "$REPO/b.txt")" = "$(printf 'b\nmine\nactor')" ] || return 1
	[ "$(cat "$REPO/a.txt")" = "a" ]
}

@test "discard leaves an untracked file from before the run, and does not count it when untouched" {
	printf 'n\n' > "$REPO/notes.txt"
	tribunal_baseline_write "$TASK" "$REPO" || return 1
	run tribunal_discard "$TASK"
	[ "$output" = "0 0" ] || return 1
	[ "$(cat "$REPO/notes.txt")" = "n" ]
}

@test "discard leaves an untracked file from before the run that the actor edited, and names it" {
	printf 'n\n' > "$REPO/notes.txt"
	tribunal_baseline_write "$TASK" "$REPO" || return 1
	printf 'actor\n' >> "$REPO/notes.txt"
	run tribunal_discard "$TASK"
	[ "$output" = "$(printf '0 1\nnotes.txt')" ] || return 1
	[ "$(cat "$REPO/notes.txt")" = "$(printf 'n\nactor')" ]
}

@test "discard leaves a file deleted before the run deleted" {
	rm "$REPO/b.txt"
	tribunal_baseline_write "$TASK" "$REPO" || return 1
	run tribunal_discard "$TASK"
	[ "$output" = "0 0" ] || return 1
	[ ! -e "$REPO/b.txt" ]
}

@test "discard refuses, touching nothing, when HEAD moved since the baseline" {
	tribunal_baseline_write "$TASK" "$REPO" || return 1
	printf 'actor\n' >> "$REPO/a.txt"
	git -C "$REPO" commit -q -am "actor commit"
	printf 'actor\n' >> "$REPO/b.txt"
	run tribunal_discard "$TASK"
	[ "$status" -eq 2 ] || return 1
	[ "$(cat "$REPO/b.txt")" = "$(printf 'b\nactor')" ]
}

@test "discard fails without a baseline" {
	run tribunal_discard "$TASK"
	[ "$status" -eq 1 ]
}
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `scripts/test/run-bats.sh test/bats/tribunal-resolve.bats`

Expected: every test fails, because the `source` in `setup` fails: the file doesn't exist.

- [ ] **Step 4: Write the lib**

Create `plugins/tribunal/scripts/lib/tribunal-resolve.sh`:

```bash
#!/usr/bin/env bash
# What happens to a /tribunal run's changes after the jury does not accept
# them (ONL-308).
#
# A rejected or exhausted run leaves the actor's edits on disk, and until this
# lib nothing recorded what the person did next, so tribunal had no override
# rate for a calibrator to read (ONL-158). The skill now asks: keep the
# changes, discard them, or retry. This lib holds the parts of that which can
# be tested: the baseline a run takes when it starts, the discard, and the
# payload of the tribunal.session.resolved event that records the answer.
#
# Discard must never touch work that was there before the run. The baseline
# records every file already dirty or untracked, with a hash of its contents,
# and discard leaves each of those alone. One the actor changed again is named
# to the person instead, so they can sort it out by hand.
#
# Every git call that takes a path passes --literal-pathspecs, as
# tribunal-session-files.sh does: a path starting with `:` would otherwise be
# read as pathspec magic.

# _tribunal_dirty_entries <root>
# Prints each dirty or untracked path as "XY path", NUL-terminated. With
# --no-renames a rename reads as a deletion plus an addition, so every entry
# holds exactly one path. -uall lists the files inside an untracked directory
# rather than the directory.
_tribunal_dirty_entries() {
	git -C "$1" --literal-pathspecs status --porcelain=v1 -z --no-renames --untracked-files=all
}

# _tribunal_content_hash <root> <path>
# Prints the blob hash of the file's current contents, or nothing when the
# file does not exist.
_tribunal_content_hash() {
	if [ -f "$1/$2" ] || [ -L "$1/$2" ]; then
		git -C "$1" hash-object --no-filters -- "$2" 2>/dev/null
	fi
}

# Usage: tribunal_baseline_write <task_dir> <worktree>
# Writes <task_dir>/baseline.json: the worktree root, HEAD, and every path that
# is dirty or untracked right now, with the hash of its contents ("" for a file
# deleted from the worktree). Returns 1 and writes nothing outside a git
# worktree or before the first commit. There is then nothing to restore to, and
# the skill does not offer Discard.
tribunal_baseline_write() {
	local task_dir="$1" worktree="$2" root head entry path
	local -a args=()
	root=$(git -C "$worktree" rev-parse --show-toplevel 2>/dev/null) || return 1
	head=$(git -C "$root" rev-parse --verify --quiet HEAD) || return 1
	while IFS= read -r -d '' entry; do
		path="${entry:3}"
		args+=("$path" "$(_tribunal_content_hash "$root" "$path")")
	done < <(_tribunal_dirty_entries "$root")
	mkdir -p "$task_dir" || return 1
	jq -n --arg root "$root" --arg head "$head" '
		$ARGS.positional as $a
		| {root: $root, head: $head,
		   dirty: [range(0; $a | length; 2) | {path: $a[.], hash: $a[. + 1]}]}
	' --args ${args[@]+"${args[@]}"} > "${task_dir}/baseline.json"
}

# Usage: tribunal_discard <task_dir>
# Restores every file the actor changed that was clean when the run started. A
# tracked file goes back to HEAD in the index and the worktree. An untracked
# file is deleted. A file in the baseline is never touched; one whose contents
# changed since the baseline was taken is counted and named.
#
# Prints "<restored> <left>" on the first line, then each left path, one per
# line. Returns 1 with no baseline. Returns 2, touching nothing, if HEAD moved
# since the baseline: the actor committed, and restoring to the new HEAD would
# keep its commit while reporting a discard.
tribunal_discard() {
	local baseline="$1/baseline.json" root head entry status path recorded
	local restored=0 left=0
	local -a entries=() left_paths=()
	[ -f "$baseline" ] || return 1
	root=$(jq -r '.root' "$baseline") || return 1
	head=$(jq -r '.head' "$baseline") || return 1
	[ "$(git -C "$root" rev-parse --verify --quiet HEAD)" = "$head" ] || return 2

	# Read in full before changing anything. git status can hold index.lock
	# while it refreshes the index, and a restore running against a status
	# still streaming would fail on that lock.
	while IFS= read -r -d '' entry; do
		entries+=("$entry")
	done < <(_tribunal_dirty_entries "$root")

	for entry in ${entries[@]+"${entries[@]}"}; do
		status="${entry:0:2}"
		path="${entry:3}"
		if recorded=$(jq -er --arg p "$path" '.dirty[] | select(.path == $p) | .hash' "$baseline"); then
			if [ "$(_tribunal_content_hash "$root" "$path")" != "$recorded" ]; then
				left=$((left + 1))
				left_paths+=("$path")
			fi
		elif [ "$status" = "??" ]; then
			rm -f -- "${root}/${path}" && restored=$((restored + 1))
		elif git -C "$root" --literal-pathspecs restore --source=HEAD --staged --worktree -- "$path" 2>/dev/null; then
			restored=$((restored + 1))
		else
			echo "tribunal: could not restore ${path}" >&2
		fi
	done

	printf '%s %s\n' "$restored" "$left"
	[ "$left" -eq 0 ] || printf '%s\n' "${left_paths[@]}"
}
```

Notes for the implementer:
- `jq -e` exits 0 when the path is in the baseline, even when its hash is `""` (a file that was deleted). It exits non-zero when the path isn't there.
- `git restore --source=HEAD --staged --worktree` on a path that isn't in `HEAD` removes it from both the index and the worktree. That's what the staged-new-file test relies on. It was checked against git 2.54 while writing this plan.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `scripts/test/run-bats.sh test/bats/tribunal-resolve.bats`

Expected: all 15 pass.

- [ ] **Step 6: Ablate the three guards**

For each change below: make it, run the bats file, confirm exactly the named test fails, then revert.

1. In `tribunal_discard`, replace the hash comparison `if [ "$(_tribunal_content_hash ...)" != "$recorded" ]; then` with `if true; then`. Every baseline file still dirty would then count as left. Expected failures:
   - "does not count it when untouched";
   - "leaves a file deleted before the run deleted".
2. Replace the baseline lookup `if recorded=$(jq -er ...); then` with `if false; then`. Every file dirty before the run would then be restored or deleted. Expected failures, the four "before the run" tests:
   - "leaves a file dirty before the run…";
   - "…does not count it when untouched";
   - "…that the actor edited, and names it";
   - "leaves a file deleted before the run deleted".
3. Delete the `HEAD` check line. Expected failure: "refuses, touching nothing, when HEAD moved".

- [ ] **Step 7: Lint**

Run: `npm run test:shellcheck && npm run lint:bash-arithmetic && npm run lint:bats-assertions`

Expected: clean.

- [ ] **Step 8: Commit**

Run `/git-workflow:commit` with `plugins/tribunal/scripts/lib/tribunal-resolve.sh test/bats/tribunal-resolve.bats`. Use the subject `feat(tribunal): let a rejected run's changes be discarded safely`. The body says why the baseline hashes contents and stores `HEAD`. Use `Refs ONL-308`, not `Fixes`, since the work isn't wired in yet.

---

### Task 3: The payload builder

**Files:**

- Modify: `plugins/tribunal/scripts/lib/tribunal-resolve.sh` (append).
- Test: `test/bats/tribunal-resolve.bats` (append).

**Interfaces:**

- Produces: `tribunal_resolved_payload <task_id> <outcome> <decision> [<restored> <left>]` prints a compact JSON object and returns 0. It returns 1, printing nothing, for an empty task id, or an `outcome` or `decision` the event doesn't allow. The counts are included only when `decision` is `discarded`.

- [ ] **Step 1: Write the failing tests**

Append to `test/bats/tribunal-resolve.bats`:

```bash
@test "payload for a keep carries no counts" {
	run tribunal_resolved_payload T1 rejected kept 3 1
	[ "$status" -eq 0 ] || return 1
	[ "$output" = '{"task_id":"T1","outcome":"rejected","decision":"kept"}' ]
}

@test "payload for a retry carries no counts" {
	run tribunal_resolved_payload T1 exhausted_iterations retried
	[ "$output" = '{"task_id":"T1","outcome":"exhausted_iterations","decision":"retried"}' ]
}

@test "payload for a discard carries both counts as numbers" {
	run tribunal_resolved_payload T1 rejected discarded 3 1
	[ "$output" = '{"task_id":"T1","outcome":"rejected","decision":"discarded","files_restored":3,"files_left":1}' ]
}

@test "payload refuses an outcome the event does not resolve" {
	local o
	for o in accepted aborted bogus; do
		run tribunal_resolved_payload T1 "$o" kept
		[ "$status" -eq 1 ] || return 1
		[ -z "$output" ] || return 1
	done
}

@test "payload refuses an unknown decision" {
	run tribunal_resolved_payload T1 rejected ignored
	[ "$status" -eq 1 ]
}

@test "payload refuses an empty task id" {
	run tribunal_resolved_payload "" rejected kept
	[ "$status" -eq 1 ]
}
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `scripts/test/run-bats.sh test/bats/tribunal-resolve.bats`

Expected: the six new tests fail with `tribunal_resolved_payload: command not found` (status 127), and the 15 from Task 2 still pass.

- [ ] **Step 3: Write the function**

Append to `plugins/tribunal/scripts/lib/tribunal-resolve.sh`:

```bash
# Usage: tribunal_resolved_payload <task_id> <outcome> <decision> [<restored> <left>]
# Prints the tribunal.session.resolved payload. The counts are included only for
# a discard. Returns 1 for an empty task id, or an outcome or decision the event
# does not allow, so a typo fails here: the skill only warns when an emission is
# rejected, and the answer would be lost.
tribunal_resolved_payload() {
	local task_id="$1" outcome="$2" decision="$3" restored="${4:-}" left="${5:-}"
	[ -n "$task_id" ] || return 1
	case "$outcome" in
		rejected | exhausted_iterations) ;;
		*) return 1 ;;
	esac
	case "$decision" in
		kept | retried) restored="" left="" ;;
		discarded) ;;
		*) return 1 ;;
	esac
	jq -cn --arg t "$task_id" --arg o "$outcome" --arg d "$decision" \
		--arg r "$restored" --arg l "$left" '
		{task_id: $t, outcome: $o, decision: $d}
		+ (if $r != "" then {files_restored: ($r | tonumber)} else {} end)
		+ (if $l != "" then {files_left: ($l | tonumber)} else {} end)
	'
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `scripts/test/run-bats.sh test/bats/tribunal-resolve.bats`

Expected: all 21 pass.

- [ ] **Step 5: Lint and commit**

Run: `npm run test:shellcheck && npm run lint:bats-assertions`. Expected: clean.

Then run `/git-workflow:commit` with both files, using the subject `feat(tribunal): build the payload that records a rejected run's outcome` and `Refs ONL-308`.

---

### Task 4: Bump schema, and prove the emission validates

**Blocked on Task 1's release.** Check that it's published: `npm view @onlooker-community/schema version` should print the version Task 1 noted.

**Files:**

- Modify: `package.json` (line 56) and `package-lock.json`.
- Modify: `test/bats/tribunal-events.bats`, in `setup` and with a new test.
- Modify: `test/bus-coverage.json` (`expected`).

**Interfaces:**

- Consumes:
  - `tribunal_resolved_payload` (Task 3).
  - `tribunal_emit_event <type> <payload>` (existing, `tribunal-events.sh`).
  - `expect_emission_rejected` (existing, `test/helpers/setup.bash`).

- [ ] **Step 1: Write the failing test**

In `test/bats/tribunal-events.bats` `setup`, after the `source "${PLUGIN_ROOT}/scripts/lib/tribunal-events.sh"` line:

```bash
	# shellcheck disable=SC1091
	source "${PLUGIN_ROOT}/scripts/lib/tribunal-resolve.sh"
```

After the `session.complete validates with exhausted_iterations outcome` test:

```bash
# Checks the line was appended as well as valid: _validate_latest_event reads
# the last line, which is the previous event's when an emission is rejected.
_latest_is_resolved() { # <decision>
	[ "$(tail -n 1 "$ONLOOKER_EVENTS_LOG" | jq -r '.event_type + " " + .payload.decision')" = "tribunal.session.resolved $1" ]
}

@test "session.resolved validates for each decision" {
	local d p
	for d in kept retried; do
		p=$(tribunal_resolved_payload "$TASK_ID" rejected "$d") || return 1
		tribunal_emit_event "tribunal.session.resolved" "$p"
		_latest_is_resolved "$d" || return 1
		_validate_latest_event || return 1
	done
	p=$(tribunal_resolved_payload "$TASK_ID" exhausted_iterations discarded 2 1) || return 1
	tribunal_emit_event "tribunal.session.resolved" "$p"
	_latest_is_resolved discarded || return 1
	run _validate_latest_event
	[ "$status" -eq 0 ]
}

@test "session.resolved with an unknown decision is rejected by the schema" {
	expect_emission_rejected tribunal_emit_event "tribunal.session.resolved" \
		'{"task_id":"x","outcome":"rejected","decision":"ignored"}'
	[ "$status" -ne 0 ]
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `scripts/test/run-bats.sh test/bats/tribunal-events.bats`

Expected: `session.resolved validates for each decision` fails, because the installed schema (3.10.0) doesn't know the type. The rejection test passes either way: it proves something only once the type is known.

- [ ] **Step 3: Bump the dependency**

Run: `npm install @onlooker-community/schema@^<version from Task 1>`

Expected: `package.json` line 56 reads `"^<version>"`, and `package-lock.json` changes only the schema entry. Check with `git diff --stat`: only those two files.

- [ ] **Step 4: Run it and watch it pass**

Run: `scripts/test/run-bats.sh test/bats/tribunal-events.bats`

Expected: all pass.

- [ ] **Step 5: Add the type to bus coverage**

In `test/bus-coverage.json` `expected`, between `"tribunal.session.complete",` and `"tribunal.session.start",`:

```json
    "tribunal.session.resolved",
```

Run: `npm run test:bats && npm run test:bus`

Expected: both pass. Run the bats suite once, alone, in this checkout. The bus gate refuses a report from a run that another run in the same checkout interrupted.

- [ ] **Step 6: Commit**

Run `/git-workflow:commit` with `package.json package-lock.json test/bats/tribunal-events.bats test/bus-coverage.json`, using the subject `test(tribunal): prove tribunal.session.resolved validates against the schema` and `Refs ONL-308`.

---

### Task 5: Wire it into the skill, and document it

**Files:**

- Modify: `plugins/tribunal/skills/tribunal/SKILL.md` (the Setup block, Per-task initialization, and a new section after "Summary to the user").
- Modify: `plugins/tribunal/README.md` ("How it works", "Storage layout", "Events emitted").

**Interfaces:**

- Consumes: `tribunal_baseline_write`, `tribunal_discard`, `tribunal_resolved_payload`, and the existing `tribunal_task_dir <project_key> <task_id>`.

There is no automated test for skill prose. Step 3 is a manual run.

- [ ] **Step 1: Edit SKILL.md**

In the Setup block, after `source "${CLAUDE_PLUGIN_ROOT}/scripts/lib/tribunal-verdict.sh"`:

```bash
source "${CLAUDE_PLUGIN_ROOT}/scripts/lib/tribunal-resolve.sh"
```

In "Per-task initialization", after the line ``Emit `tribunal.session.start` with the resolved config (...).``:

````markdown
Then record what is already dirty in the worktree, so that a discard at the end of the run can leave it alone:

```bash
task_dir=$(tribunal_task_dir "$project_key" "$task_id")
tribunal_baseline_write "$task_dir" "$(pwd)"
```

Remember whether it succeeded. It fails outside a git worktree or before the first commit, and then the end-of-run question doesn't offer Discard.

On a retry (see "Resolving a run the jury did not accept"), copy the previous run's baseline instead of writing a new one: `cp "$previous_task_dir/baseline.json" "$task_dir/"`. The previous run's edits are on disk by then. A fresh baseline would count them as work from before the run, and a later discard would never remove them.
````

After the "Summary to the user" section, before "Error handling":

````markdown
## Resolving a run the jury did not accept

When the outcome is `rejected` or `exhausted_iterations`, the actor's changes are still on disk. After the summary, ask the person what to do with them, in one `AskUserQuestion`:

- **Question:** "The jury didn't accept this. What should happen to the changes?"
- **Keep the changes:** "Leave everything as it is."
- **Discard them:** "Restore the files this run changed. Files that already had changes before it started are left alone." Offer this only when the baseline was written.
- **Retry:** "Run the task again with the same settings, for up to `<max_iterations>` more iterations."

Then act on the answer:

- **Keep:** emit `decision: kept`. This is the override a calibrator reads.
- **Discard:** run `tribunal_discard "$task_dir"`.
  - **Exit 0:** the first line is `<restored> <left>`. Each remaining line is a file that had changes before the run and that the actor changed again. Tell the person how many files were restored, and name each file that was left alone so they can sort it out by hand. Emit `decision: discarded` with both counts.
  - **Exit 2:** `HEAD` moved during the run, so the actor committed. Tell the person nothing was restored, and that the commit has to be undone by hand. Emit nothing: the discard they chose didn't happen.
  - **Exit 1:** the baseline is missing or unreadable. Tell the person nothing was restored, and emit nothing.
  - **Exit 3:** some files couldn't be restored. They're named on stderr as `tribunal: could not restore <path>`. Stdout is as for exit 0. Tell the person what was restored, which files are left alone, and which couldn't be restored, so they can fix those by hand. Emit `decision: discarded` with the stdout counts, since a discard did happen.
- **Retry:** emit `decision: retried`. Then start again from "Per-task initialization", with the same task description, rubric and config, carrying the baseline forward as described there. The new run has its own `task_id`.
- **No answer** (dismissed, or a reply that is none of the three): emit nothing. A rejection without `tribunal.session.resolved` reads as unanswered. Never record a guess.

Emit a keep or a retry with three arguments, and a discard with its two counts:

```bash
payload=$(tribunal_resolved_payload "$task_id" "$outcome" kept)
payload=$(tribunal_resolved_payload "$task_id" "$outcome" discarded "$restored" "$left")
tribunal_emit_event "tribunal.session.resolved" "$payload"
```

The Setup block runs under `set -u`, so don't pass `"$restored" "$left"` when they were never set. Each block runs in a new shell, so set `project_key`, `task_id` and `task_dir` again from the values you noted.

Never ask after `accepted` or `aborted`.
````

- [ ] **Step 2: Edit README.md**

In the "How it works" table, append to the `/tribunal <task>` row's text:

> When a run ends rejected or out of iterations, it asks whether to keep the changes, discard them, or retry, and records the answer as `tribunal.session.resolved`. Discard restores only the files that were clean when the run started.

In "Storage layout", after `    ├── session-complete.json`:

```text
    ├── baseline.json                   # files already dirty when the run started
```

In "Events emitted", change `` `session.complete`, and the nudge's `` to `` `session.complete`, `session.resolved` (schema v<version from Task 1>+, after a rejected or exhausted run), and the nudge's ``.

- [ ] **Step 3: Run it for real**

In a scratch git repository with one committed file and one uncommitted change of your own, start Claude Code with this worktree's plugin loaded. Run a `/tribunal` task the jury will reject, such as "rewrite README.md as a haiku". To make the rejection likely, set `max_iterations` to 1 and `score_threshold` to 0.99 wherever the README's "Configuration" section says a project overrides them. Answer **Discard**, and check:

- the actor's files are restored;
- your own change is untouched, and named only if the actor changed that file too;
- the last line of `$ONLOOKER_DIR/logs/onlooker-events.jsonl` is a `tribunal.session.resolved` with `decision: "discarded"`.

Run it again and answer **Keep**, then check for `decision: "kept"`.

- [ ] **Step 4: Commit**

Run `/git-workflow:commit` with `plugins/tribunal/skills/tribunal/SKILL.md plugins/tribunal/README.md`, using the subject `feat(tribunal): ask what to do with work the jury rejected` and `Fixes ONL-308`. release-please bumps tribunal's minor version from the `feat` commits, so don't edit `plugin.json`.

---

### Task 6: Full check and PR

- [ ] **Step 1: Run CI's checks locally**

Run: `npm run test:ci`

Expected: pass. If a lint other than the ones above fails, fix the cause with the Edit tool, then rerun.

- [ ] **Step 2: Open the PR**

Run `/git-workflow:pr`. In the body:
- Link the spec.
- List "Decisions beyond the spec".
- Say that the skill steps were checked by the manual run in Task 5, Step 3.

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| Event and fields, `additionalProperties: false` | 1 |
| Role `lifecycle` | 1 |
| Counts, not paths | 1 (the unregistered-property test), 3 |
| Baseline at run start; no Discard outside git | 2, 5 |
| Ask only after `rejected` or `exhausted_iterations`, with three choices | 5 |
| Discard: restore tracked files, delete new untracked files, leave and name baseline files the actor touched | 2 |
| Retry gets a new `task_id` | 5 |
| No answer emits nothing | 5 |
| Stop gate and `aborted` out of scope | 5 ("Never ask after `accepted` or `aborted`"; the Stop gate is untouched) |
| Logic in `tribunal-resolve.sh`, testable | 2, 3 |
| schema tests: valid with and without counts; missing or unknown decision, `accepted`, and extra property each fail; role | 1 |
| ecosystem tests: the four discard cases, baseline outside git, payload validates against the published schema | 2, 4 |
| Rollout: schema first, then bump and emit; tribunal minor release | 1, 4, 5 |
