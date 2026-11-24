# Tribunal's Override Signal — Design

**Linear:** ONL-308. **Beads:** `onlooker-do8fiq`. **Unblocks:** the calibrator, ONL-158 / `onlooker-46ltz5`.

## The problem

The calibrator (ONL-158) proposes gate thresholds from how often each gate's
blocks are overridden. Compass emits `compass.check.overridden` and warden
emits `warden.threat.cleared`. Tribunal emits nothing, so its override rate
can't be measured.

That's not a missing emit. Tribunal has no override to record, because it
never stops anything:

- **`/tribunal` runs** retry the actor until the jury accepts or
  `max_iterations` runs out, then report ✗ rejected or ⏱ exhausted. The actor's
  edits are already on disk. Whatever the person does next goes unrecorded.
- **The Stop gate** (`tribunal-stop-gate.sh`) always exits 0. It's advisory,
  off by default (`stop_hook.enabled: false`), and runs after the session has
  ended.

So for tribunal, an override isn't unblocking a gate. It's **keeping work the
jury rejected**.

Measured 2026-11-22 over the last 30 days of the event log: 3
`tribunal.gate.blocked`, all from one `/tribunal` run on 2026-10-25, and 1,724
`tribunal.gate.skipped`. Volume is low. The signal is still needed before any
calibrator can read tribunal at all.

## The decision

**After a run ends `rejected` or `exhausted_iterations`, the skill asks the
person what to do with the changes, and records the answer.**

Three choices:

| Choice | What happens | `decision` |
|---|---|---|
| Keep the changes | Nothing is touched. This is the override. | `kept` |
| Discard them | The actor's files are restored, except any that were dirty before the run (below). | `discarded` |
| Retry | A new run starts on the same task with the same config. | `retried` |

Each answer emits one `tribunal.session.resolved` event.

Considered and rejected:

- **`tribunal.verdict.overridden` only, mirroring compass.** A discard would
  look the same as a rejection nobody answered, and telling those apart is the
  point of this work.
- **Three events (`.overridden`, `.discarded`, `.retried`).** That's three
  schema entries and three roles for one decision.
- **Inferring an override from a later commit.** A commit can hold a fix for
  the rejection, or someone else's work.
- **A typed phrase, like `compass: proceed`.** A prompt that only quotes the
  phrase would also match, which is the fragility ONL-158 already flags for
  compass.

## The event

`tribunal.session.resolved`, in `schemas/payload/plugins-safety.json`, with
`additionalProperties: false` like its siblings.

| Field | Type | Required | Notes |
|---|---|---|---|
| `task_id` | string | yes | Joins to `tribunal.session.start` and `.complete`. |
| `outcome` | `"rejected"` \| `"exhausted_iterations"` | yes | The outcome being resolved. `aborted` is never asked about. |
| `decision` | `"kept"` \| `"discarded"` \| `"retried"` | yes | |
| `files_restored` | integer ≥ 0 | no | Discard only. |
| `files_left` | integer ≥ 0 | no | Discard only: files the actor touched that were already dirty, so they weren't restored. |

- **Counts, not paths.** The event says nothing about the person's code.
- **Role: `lifecycle`** in `src/event-roles.ts`. It's a person's decision, not
  something tribunal produced, so it must not count toward the plugin's
  "Produced" line in the web app.
- **No event means unanswered.** A non-accepted `session.complete` with no
  `session.resolved` for its `task_id` is a rejection nobody resolved. The
  calibrator reports it as that, not as a discard.

The calibrator's tribunal override rate is then `decision: kept` divided by
every non-accepted `session.complete`, with unanswered rejections reported
separately.

## How the skill asks

### Baseline, at the start of a run

Right after `tribunal.session.start`, the skill records which files are already
dirty or untracked (`git status --porcelain`). It saves them as `baseline.json`
in the task directory (`tribunal_task_dir`), next to the iteration artifacts.

If the working directory isn't a git repository there's no baseline, and
"Discard" isn't offered. Keep and Retry still are.

### The question, at the end of a run

Only when the outcome is `rejected` or `exhausted_iterations`, the skill reports
the verdict as it does today, then asks one `AskUserQuestion` with the three
choices.

- **Keep:** emit `decision: kept`.
- **Discard:** take the files dirty now, minus the baseline.
  - Tracked files are restored to `HEAD` with `git restore`.
  - Untracked files that weren't in the baseline are deleted.
  - Files that were in the baseline and were touched again are left alone. The
    reply names them.

  Then emit `decision: discarded` with `files_restored` and `files_left`.
- **Retry:** emit `decision: retried`, then start a new run on the same task
  with the same config. The new run has its own `task_id` and its own
  `session.start`, so each run keeps a separate record.
- **No answer** (dismissed, or a free-text reply that isn't one of the three):
  emit nothing.

### Out of scope

- **The Stop gate.** It runs after the session has ended, so there's no one to
  ask. It keeps emitting `tribunal.gate.blocked` as it does today.
- **`aborted` runs.** They ended for another reason, and there's no verdict to
  override.

### A known limit

A file the person edits during the run, in parallel with the actor, counts as
the actor's, since the baseline only knows what was dirty at the start. That's
acceptable because `/tribunal` runs in the foreground of the person's own
session. Files dirty before the run are never touched, whatever happens during
it.

## Where the logic lives

The skill already sources shell libraries (`tribunal-config.sh`,
`tribunal-gate.sh` and others), and those have bats tests. The prose in
`SKILL.md` can't be tested. So the logic goes in a new
`plugins/tribunal/scripts/lib/tribunal-resolve.sh`:

- `tribunal_baseline_write <task_dir> <worktree>` writes `baseline.json`.
  Outside git it writes nothing and returns non-zero, so the skill knows not to
  offer Discard.
- `tribunal_discard <task_dir> <worktree>` restores as described above. It
  prints the restored count, the left count, and the names of the files left
  alone.
- `tribunal_resolved_payload <task_id> <outcome> <decision> [restored left]`
  builds the payload with `jq`, so the skill never assembles JSON by hand.

`SKILL.md` gains two steps: the baseline call after `session.start`, and the
question and emit after `session.complete`.

## Testing

Each test is written failing first.

**schema:**

- A valid `tribunal.session.resolved` passes, with and without the discard
  counts.
- A missing `decision`, an unknown `decision`, an `outcome` of `accepted`, and
  an extra property each fail.
- Its role is `lifecycle`.

**ecosystem** (`test/bats/tribunal-resolve.bats`, against a fixture repo):

- Discard restores a tracked file the actor changed.
- Discard deletes an untracked file the actor created.
- Discard leaves a file that was dirty in the baseline untouched, and counts and
  names it.
- Discard leaves an untracked file that was in the baseline in place.
- `tribunal_baseline_write` fails outside git.
- Each payload `tribunal_resolved_payload` builds validates against the
  published schema.

## Rollout

Two PRs, in order. Schema has to come first: its payloads set
`additionalProperties: false`, and ecosystem's validation rejects an event type
it doesn't know.

1. **schema:** the payload, the type in the `schemas/event.v1.json` event-type
   enum, the type constant in `src/event-types.ts`, the payload type in
   `src/types.ts`, and the role. Then release it.
2. **ecosystem:** bump the schema dependency, add `tribunal-resolve.sh`, its
   bats tests, and the two `SKILL.md` steps. Tribunal gets a minor release,
   since this is new behavior.

## Done when

A `/tribunal` run that ends rejected asks the question. Each answer emits a
`tribunal.session.resolved` that validates against the published schema.
Discard never touches a file that was dirty before the run.
