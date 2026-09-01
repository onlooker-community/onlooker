# Sync Pipeline Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `onlooker sync` and `onlooker status` say *where* the lesson pipeline stopped, instead of collapsing four different situations into "no approved lessons yet."

**Architecture:** One new module, `apps/cli/src/pipeline.ts`, surveys `~/.onlooker/librarian/<key>/lessons/` on disk and returns a plain count object. Two renderers in that same module turn one survey into `sync`'s inline clause and `status`'s block, so the two commands cannot drift in wording. `lessons.ts` and `discoverApproved` are not touched.

**Tech Stack:** TypeScript, Node `node:fs`, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-sync-pipeline-diagnostics-design.md`
**Bead:** `onlooker-5iy`

## Global Constraints

- **Tabs, not spaces.** Every file in `apps/cli/src` is tab-indented; biome enforces it. Run `pnpm --filter @onlooker/cli lint` before each commit.
- **To run one test file, use `pnpm --filter @onlooker/cli exec vitest run <pattern>`.** The package's `test` script is a bare `vitest run` with no argument passthrough, so `pnpm --filter @onlooker/cli test -- <pattern>` silently runs the whole suite instead of filtering — it looks like it worked. Found during Task 1.
- **American English** in all comments, identifiers, and user-facing strings.
- **Edit tracked files with `Edit`/`Write`, never with `sed`, heredocs, or shell redirection.** See `CLAUDE.md` §Conventions & Patterns — the `lineage` and `inspector` plugins hook on tool calls, so a shell edit is invisible to them.
- **The survey never throws.** `status` is the command you run *because* something is broken. Every failure mode becomes a count, not an exception.
- **Do not modify `apps/cli/src/lessons.ts`.** `discoverApproved` and its tests stay exactly as they are.
- **All work lands via a branch and PR**, never a direct push to `main`.
- Status strings (`pending`, `confirmed`, `approved`, `rejected`, `passed`) and the `promoted_at` field are owned by `onlooker-community/ecosystem`, in `plugins/librarian/scripts/lib/librarian-lesson-storage.sh` and `librarian-lesson-promote.sh`. Treat the set as open: anything unfamiliar is counted under its own name, never dropped.

## File Structure

| File | Responsibility |
|---|---|
| `apps/cli/src/pipeline.ts` | **Create.** Reads `lessons/proposals/*.json` and `lessons/declined.jsonl`, counts by stage, and renders both output forms. |
| `apps/cli/src/__tests__/pipeline.test.ts` | **Create.** Unit tests for the survey and both renderers over temp directories. |
| `apps/cli/src/commands/sync.ts` | **Modify** the single `found.files.length === 0` branch (currently line 43-45). |
| `apps/cli/src/commands/status.ts` | **Modify** the `Lessons:` block and re-pad every label. |
| `apps/cli/src/__tests__/sync.test.ts` | **Modify.** Add cases for each zero-state. |
| `apps/cli/src/__tests__/status.test.ts` | **Modify.** Add a `Pipeline:` block case. |

---

### Task 1: The survey reader

**Files:**
- Create: `apps/cli/src/pipeline.ts`
- Test: `apps/cli/src/__tests__/pipeline.test.ts`

**Interfaces:**
- Consumes: `onlookerDir(env)` from `apps/cli/src/config.ts` — returns `$ONLOOKER_DIR` or `~/.onlooker`.
- Produces: `PipelineSurvey` (interface) and `surveyPipeline(env?: NodeJS.ProcessEnv): PipelineSurvey`. Task 2 renders this object; Tasks 3 and 4 call the function.

- [ ] **Step 1: Write the failing test**

Create `apps/cli/src/__tests__/pipeline.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { surveyPipeline } from "../pipeline";

/** A temp `$ONLOOKER_DIR` with nothing in it. */
function emptyDir(): NodeJS.ProcessEnv {
	return { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-pipe-")) };
}

/** Write one proposal under `librarian/<key>/lessons/proposals/<id>.json`. */
function proposal(
	env: NodeJS.ProcessEnv,
	key: string,
	id: string,
	body: unknown,
): void {
	const dir = join(
		env.ONLOOKER_DIR as string,
		"librarian",
		key,
		"lessons",
		"proposals",
	);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${id}.json`),
		typeof body === "string" ? body : JSON.stringify(body),
	);
}

describe("surveyPipeline", () => {
	it("counts nothing when no librarian directory exists", () => {
		const survey = surveyPipeline(emptyDir());
		expect(survey.lessonDirs).toBe(0);
		expect(survey.pendingReview).toBe(0);
		expect(survey.declined).toBe(0);
		expect(survey.unrecognized).toEqual({});
	});

	it("sorts each status into its own bucket", () => {
		const env = emptyDir();
		proposal(env, "aaaaaaaaaaaa", "p1", { status: "pending" });
		proposal(env, "aaaaaaaaaaaa", "p2", { status: "confirmed" });
		proposal(env, "aaaaaaaaaaaa", "p3", { status: "approved" });
		proposal(env, "aaaaaaaaaaaa", "p4", { status: "rejected" });
		proposal(env, "aaaaaaaaaaaa", "p5", { status: "passed" });

		const survey = surveyPipeline(env);
		expect(survey.lessonDirs).toBe(1);
		expect(survey.pendingReview).toBe(1);
		expect(survey.awaitingJury).toBe(1);
		// `approved` and `rejected` are both judged-but-not-yet-promoted, and
		// both are unstuck by the same command, so they share one bucket.
		expect(survey.awaitingPromotion).toBe(2);
		expect(survey.passed).toBe(1);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @onlooker/cli exec vitest run pipeline`
Expected: FAIL — `Failed to resolve import "../pipeline"`.

- [ ] **Step 3: Write the implementation**

Create `apps/cli/src/pipeline.ts`:

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { onlookerDir } from "./config";

/**
 * What each stage of the lesson pipeline is holding.
 *
 * `sync` used to answer "no approved lessons yet" for four different
 * situations that call for four different responses: nothing has ever
 * proposed a lesson, proposals are waiting on a human, they are waiting on
 * the jury, or they were judged and never promoted. The counts here are what
 * lets one sentence say which.
 *
 * The stage a proposal sits at is a `status` field INSIDE each file, not a
 * directory - `lessons/proposals/` holds every state from `pending` through
 * `rejected`. So this is a read of each file, not a directory listing.
 */
export interface PipelineSurvey {
	/** Project keys with a `lessons/` directory at all. */
	lessonDirs: number;
	/** `pending` - librarian proposed it, no human has reviewed it. */
	pendingReview: number;
	/** `confirmed` - a human confirmed it, the jury has not judged it. */
	awaitingJury: number;
	/** `approved` or `rejected`, with no `promoted_at`. */
	awaitingPromotion: number;
	/** `passed` - a human declined to put it forward. Terminal. */
	passed: number;
	/** Non-empty lines in `declined.jsonl`. Terminal. */
	declined: number;
	/** Status values this CLI does not know, by name and count. */
	unrecognized: Record<string, number>;
	/** Files that would not parse, or that carry no usable status. */
	unreadable: number;
}

/**
 * Count what sits at each stage, across every project key.
 *
 * Never throws. This feeds `status`, which is the command someone runs
 * *because* something is wrong - a diagnostic that dies on the state it
 * exists to report is useless at the only moment it matters. Every failure
 * mode below becomes a count instead.
 */
export function surveyPipeline(
	env: NodeJS.ProcessEnv = process.env,
): PipelineSurvey {
	const survey: PipelineSurvey = {
		lessonDirs: 0,
		pendingReview: 0,
		awaitingJury: 0,
		awaitingPromotion: 0,
		passed: 0,
		declined: 0,
		unrecognized: {},
		unreadable: 0,
	};

	const librarian = join(onlookerDir(env), "librarian");
	if (!existsSync(librarian)) return survey;

	for (const project of readdirSync(librarian)) {
		// `<key>/lessons/`, never `<key>/proposals/`. The latter is librarian's
		// MEMORY proposal queue, held apart from lessons on purpose - see
		// librarian-lesson-storage.sh:8. Counting it here would report memory
		// candidates as lesson candidates.
		const lessons = join(librarian, project, "lessons");
		if (!existsSync(lessons)) continue;
		survey.lessonDirs++;
		countProposals(join(lessons, "proposals"), survey);
		survey.declined += countDeclined(join(lessons, "declined.jsonl"));
	}

	return survey;
}

function countProposals(dir: string, survey: PipelineSurvey): void {
	if (!existsSync(dir)) return;

	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".json")) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(join(dir, entry), "utf8"));
		} catch {
			// Counted, not skipped. A file that will not parse is itself a
			// finding, and dropping it would let the totals below claim to
			// describe files nobody could read.
			survey.unreadable++;
			continue;
		}

		const proposal = parsed as Record<string, unknown> | null;
		if (typeof proposal !== "object" || proposal === null) {
			survey.unreadable++;
			continue;
		}

		// A promoted proposal keeps its file here forever: proposals/ is the
		// sole dedup source for an approved lesson, so librarian never prunes
		// it (librarian-lesson-storage.sh:184). Its outcome is already counted
		// downstream, in approved/ or in declined.jsonl. Counting it again
		// would report finished work as stuck, and would grow without bound.
		if (proposal.promoted_at !== undefined) continue;

		const status = proposal.status;
		if (typeof status !== "string" || status === "") {
			survey.unreadable++;
			continue;
		}

		switch (status) {
			case "pending":
				survey.pendingReview++;
				break;
			case "confirmed":
				survey.awaitingJury++;
				break;
			case "approved":
			case "rejected":
				survey.awaitingPromotion++;
				break;
			case "passed":
				survey.passed++;
				break;
			default:
				// Named, not dropped. This vocabulary is owned by another repo
				// and can grow without telling us. Silently ignoring an
				// unfamiliar status would under-report a real stall and print a
				// confident total - which is the exact defect this module
				// exists to fix, reintroduced one layer down.
				survey.unrecognized[status] = (survey.unrecognized[status] ?? 0) + 1;
		}
	}
}

/**
 * Non-empty lines, rather than parsed entries.
 *
 * `declined.jsonl` is append-only and librarian never re-reads it, so a torn
 * final write must not be able to break a count - and the count does not
 * depend on what shape the entries have.
 */
function countDeclined(path: string): number {
	if (!existsSync(path)) return 0;
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return 0;
	}
	return raw.split("\n").filter((line) => line.trim() !== "").length;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @onlooker/cli exec vitest run pipeline`
Expected: PASS, 2 tests.

- [ ] **Step 5: Add the remaining survey tests**

Append inside the `describe("surveyPipeline", ...)` block in `apps/cli/src/__tests__/pipeline.test.ts`:

```ts
	// proposals/ is the sole dedup source for an approved lesson, so librarian
	// never prunes a promoted proposal. Its outcome is already counted in
	// approved/ or declined.jsonl - counting it here too would report finished
	// work as stuck, forever.
	it("excludes a proposal that has already been promoted", () => {
		const env = emptyDir();
		proposal(env, "aaaaaaaaaaaa", "p1", {
			status: "approved",
			promoted_at: "2026-08-14T00:00:00Z",
		});
		proposal(env, "aaaaaaaaaaaa", "p2", { status: "approved" });

		expect(surveyPipeline(env).awaitingPromotion).toBe(1);
	});

	it("aggregates across project keys", () => {
		const env = emptyDir();
		proposal(env, "aaaaaaaaaaaa", "p1", { status: "pending" });
		proposal(env, "bbbbbbbbbbbb", "p2", { status: "pending" });
		proposal(env, "cccccccccccc", "p3", { status: "confirmed" });

		const survey = surveyPipeline(env);
		expect(survey.lessonDirs).toBe(3);
		expect(survey.pendingReview).toBe(2);
		expect(survey.awaitingJury).toBe(1);
	});

	it("skips a project key with no lessons directory", () => {
		const env = emptyDir();
		// The shape 15 of 16 real project keys have: librarian's memory queue
		// and no lesson pipeline state at all.
		mkdirSync(
			join(env.ONLOOKER_DIR as string, "librarian", "aaaaaaaaaaaa", "proposals"),
			{ recursive: true },
		);

		const survey = surveyPipeline(env);
		expect(survey.lessonDirs).toBe(0);
		expect(survey.pendingReview).toBe(0);
	});

	it("counts a malformed proposal instead of throwing", () => {
		const env = emptyDir();
		proposal(env, "aaaaaaaaaaaa", "p1", "{ not json");
		proposal(env, "aaaaaaaaaaaa", "p2", { status: "pending" });

		const survey = surveyPipeline(env);
		expect(survey.unreadable).toBe(1);
		expect(survey.pendingReview).toBe(1);
	});

	it("counts a proposal with no status as unreadable", () => {
		const env = emptyDir();
		proposal(env, "aaaaaaaaaaaa", "p1", { candidate: {} });

		expect(surveyPipeline(env).unreadable).toBe(1);
	});

	// The vocabulary belongs to another repo and can grow. A status we do not
	// know must show up by name, so drift is visible rather than silently
	// subtracted from the totals.
	it("buckets an unrecognized status under its own name", () => {
		const env = emptyDir();
		proposal(env, "aaaaaaaaaaaa", "p1", { status: "quarantined" });
		proposal(env, "aaaaaaaaaaaa", "p2", { status: "quarantined" });

		const survey = surveyPipeline(env);
		expect(survey.unrecognized).toEqual({ quarantined: 2 });
		expect(survey.unreadable).toBe(0);
	});

	it("counts declined entries by line, with or without a trailing newline", () => {
		const env = emptyDir();
		const dir = join(
			env.ONLOOKER_DIR as string,
			"librarian",
			"aaaaaaaaaaaa",
			"lessons",
		);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "declined.jsonl"),
			'{"id":"a"}\n{"id":"b"}\n\n{"id":"c"}',
		);

		expect(surveyPipeline(env).declined).toBe(3);
	});
```

- [ ] **Step 6: Run the full file**

Run: `pnpm --filter @onlooker/cli exec vitest run pipeline`
Expected: PASS, 9 tests.

- [ ] **Step 7: Lint and typecheck**

Run: `pnpm --filter @onlooker/cli lint && pnpm --filter @onlooker/cli typecheck`
Expected: both clean.

- [ ] **Step 8: Commit**

Use the `/commit` skill. Stage exactly `apps/cli/src/pipeline.ts` and `apps/cli/src/__tests__/pipeline.test.ts`.

---

### Task 2: The two renderers

**Files:**
- Modify: `apps/cli/src/pipeline.ts` (append)
- Test: `apps/cli/src/__tests__/pipeline.test.ts` (append)

**Interfaces:**
- Consumes: `PipelineSurvey` from Task 1.
- Produces: `pipelineClause(survey: PipelineSurvey): string` — the whole tail of `sync`'s sentence, everything after `"Nothing to sync: "`. And `pipelineLines(survey: PipelineSurvey): string[]` — the value lines of `status`'s `Pipeline:` block, unpadded and unlabeled. Tasks 3 and 4 consume these.

- [ ] **Step 1: Write the failing tests**

Append to `apps/cli/src/__tests__/pipeline.test.ts`. Add `pipelineClause` and `pipelineLines` to the existing import from `"../pipeline"`:

```ts
/** A survey with everything at zero, so a test names only what it cares about. */
function survey(over: Partial<PipelineSurvey> = {}): PipelineSurvey {
	return {
		lessonDirs: 1,
		pendingReview: 0,
		awaitingJury: 0,
		awaitingPromotion: 0,
		passed: 0,
		declined: 0,
		unrecognized: {},
		unreadable: 0,
		...over,
	};
}

describe("pipelineClause", () => {
	it("says the pipeline has never run when no lessons directory exists", () => {
		const clause = pipelineClause(survey({ lessonDirs: 0 }));
		expect(clause).toMatch(/lesson pipeline/i);
		expect(clause).toMatch(/never/i);
	});

	// `lessonDirs` is also 0 when the walk could not list a directory, and
	// "the pipeline never ran" would be a confident wrong answer for that.
	it("reports a fault ahead of the never-ran reading", () => {
		const clause = pipelineClause(survey({ lessonDirs: 0, unreadable: 1 }));
		expect(clause).toMatch(/could not be read/i);
		expect(clause).not.toMatch(/never/i);
	});

	// The most common state, and the one the old single sentence hid worst:
	// the pipeline is wired up and has produced nothing at any stage.
	it("says nothing is at any stage when every count is zero", () => {
		const clause = pipelineClause(survey());
		expect(clause).toMatch(/nothing at any earlier stage/i);
		expect(clause).toMatch(/archivist and librarian/i);
	});

	it("names all three stall stages in pipeline order once one holds something", () => {
		const clause = pipelineClause(survey({ awaitingJury: 2 }));
		expect(clause).toBe(
			"no approved lessons yet - 0 pending review, 2 confirmed and awaiting a jury, 0 judged and awaiting promotion.",
		);
	});

	it("appends the exceptional counts only when they are non-zero", () => {
		expect(pipelineClause(survey({ pendingReview: 1 }))).not.toMatch(/unread/i);
		const clause = pipelineClause(
			survey({ pendingReview: 1, unreadable: 2, unrecognized: { odd: 1 } }),
		);
		expect(clause).toMatch(/2 that could not be read/);
		expect(clause).toMatch(/1 with an unrecognized status \(odd\)/);
	});
});

describe("pipelineLines", () => {
	it("always lists the three stall stages and the declined count", () => {
		expect(pipelineLines(survey({ awaitingJury: 2, declined: 4 }))).toEqual([
			"0 pending review",
			"2 confirmed, awaiting a jury",
			"0 judged, awaiting promotion",
			"4 declined",
		]);
	});

	it("collapses to one line when the pipeline has never run", () => {
		expect(pipelineLines(survey({ lessonDirs: 0 }))).toEqual([
			"no lesson pipeline has run here",
		]);
	});

	it("shows the fault instead when the walk could not read a directory", () => {
		expect(pipelineLines(survey({ lessonDirs: 0, unreadable: 2 }))).toEqual([
			"2 that could not be read",
		]);
	});

	it("adds a line per exceptional count", () => {
		const lines = pipelineLines(
			survey({ passed: 1, unreadable: 2, unrecognized: { odd: 3 } }),
		);
		expect(lines).toContain("1 passed over");
		expect(lines).toContain("2 that could not be read");
		expect(lines).toContain("3 with an unrecognized status (odd)");
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @onlooker/cli exec vitest run pipeline`
Expected: FAIL — `pipelineClause is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `apps/cli/src/pipeline.ts`:

```ts
/**
 * The three stages a proposal can be stuck at, in pipeline order.
 *
 * Two phrasings from one table, because the same fact reads differently in
 * the two places it appears: `sync` runs them into a sentence where commas
 * are already separating stages, so it needs "confirmed and awaiting a jury";
 * `status` puts each on its own line, where the comma is the clearer break.
 * Keeping both here is what stops the two commands describing the same disk
 * state in different words.
 */
const STAGES = [
	{ key: "pendingReview", inline: "pending review", block: "pending review" },
	{
		key: "awaitingJury",
		inline: "confirmed and awaiting a jury",
		block: "confirmed, awaiting a jury",
	},
	{
		key: "awaitingPromotion",
		inline: "judged and awaiting promotion",
		block: "judged, awaiting promotion",
	},
] as const;

/** Anything at all, at any stage, including the two fault counts. */
function holdsSomething(survey: PipelineSurvey): boolean {
	return (
		STAGES.some((stage) => survey[stage.key] > 0) ||
		survey.passed > 0 ||
		survey.declined > 0 ||
		survey.unreadable > 0 ||
		Object.keys(survey.unrecognized).length > 0
	);
}

/**
 * The faults, phrased the same way in both renderers. Empty when clean, so
 * both callers can append it unconditionally.
 */
function faults(survey: PipelineSurvey): string[] {
	const out: string[] = [];
	if (survey.unreadable > 0) {
		out.push(`${survey.unreadable} that could not be read`);
	}
	for (const [status, count] of Object.entries(survey.unrecognized)) {
		out.push(`${count} with an unrecognized status (${status})`);
	}
	return out;
}

/**
 * Everything after "Nothing to sync: " in `sync`'s empty-pool message.
 *
 * All three stall stages are named even at zero. A zero is information here:
 * "2 confirmed and awaiting a jury, 0 pending review" says the stall is not
 * being fed, which is the difference between a backlog and a blockage. It
 * also means there is no rule about which counts appear, and one output to
 * test.
 */
export function pipelineClause(survey: PipelineSurvey): string {
	if (survey.lessonDirs === 0) {
		// A fault outranks the "never ran" reading. `lessonDirs` is also 0 when
		// the walk could not list a directory at all, and reporting that as
		// "the pipeline never ran" would be the same confident-but-wrong
		// sentence this module exists to remove.
		const unread = faults(survey);
		if (unread.length > 0) {
			return `no approved lessons yet, and the pipeline could not be read - ${unread.join(", ")}.`;
		}
		return "no approved lessons yet - librarian has run here, but its lesson pipeline never has. Check that archivist and librarian are enabled.";
	}
	if (!holdsSomething(survey)) {
		return "no approved lessons yet, and nothing at any earlier stage either - librarian has run here but has proposed no lessons. Check that archivist and librarian are enabled.";
	}

	const parts = STAGES.map(
		(stage) => `${survey[stage.key]} ${stage.inline}`,
	).concat(faults(survey));
	return `no approved lessons yet - ${parts.join(", ")}.`;
}

/** The value lines of `status`'s `Pipeline:` block, unlabeled and unpadded. */
export function pipelineLines(survey: PipelineSurvey): string[] {
	if (survey.lessonDirs === 0) {
		// Same precedence as the clause: a directory we could not list is not
		// a pipeline that never ran.
		const unread = faults(survey);
		return unread.length > 0 ? unread : ["no lesson pipeline has run here"];
	}

	const lines = STAGES.map((stage) => `${survey[stage.key]} ${stage.block}`);
	// `declined` always: a jury refusing everything it sees is precisely what
	// someone runs `status` to find out. `passed` only when non-zero - it is a
	// human's decision not to put something forward, not a stall.
	lines.push(`${survey.declined} declined`);
	if (survey.passed > 0) lines.push(`${survey.passed} passed over`);
	return lines.concat(faults(survey));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @onlooker/cli exec vitest run pipeline`
Expected: PASS, 20 tests — Task 1's 11 (its original 9, plus 2 added in review for unlistable directories) and the 9 added here.

- [ ] **Step 5: Lint and typecheck**

Run: `pnpm --filter @onlooker/cli lint && pnpm --filter @onlooker/cli typecheck`
Expected: both clean. If `survey[stage.key]` errors under `noUncheckedIndexedAccess`, the `as const` on `STAGES` is what narrows `stage.key` to the three literal keys — verify it is present rather than widening the type.

- [ ] **Step 6: Commit**

Use the `/commit` skill. Stage `apps/cli/src/pipeline.ts` and `apps/cli/src/__tests__/pipeline.test.ts`.

---

### Task 3: Wire it into `sync`

**Files:**
- Modify: `apps/cli/src/commands/sync.ts:43-45`
- Test: `apps/cli/src/__tests__/sync.test.ts`

**Interfaces:**
- Consumes: `surveyPipeline` and `pipelineClause` from Tasks 1 and 2.
- Produces: no new exports. `sync`'s return string changes on the empty-pool path only.

- [ ] **Step 1: Write the failing tests**

In `apps/cli/src/__tests__/sync.test.ts`, add these beside the existing `"succeeds with nothing to do when no lesson is approved"` test. That existing test creates `librarian/` with no project keys, which is now the `lessonDirs === 0` state; it asserts only `/nothing to sync/i` and keeps passing unchanged — leave it alone.

```ts
	it("says the lesson pipeline has never run when no key has a lessons dir", async () => {
		const env = linked();
		// A project key librarian knows about, with only its memory queue.
		mkdirSync(
			join(env.ONLOOKER_DIR as string, "librarian", "aaaaaaaaaaaa", "proposals"),
			{ recursive: true },
		);
		const message = await sync({ env, fetchImpl: accepts() });
		expect(message).toMatch(/lesson pipeline never has/i);
	});

	it("says nothing is at any stage when the pipeline has run and proposed nothing", async () => {
		const env = linked();
		mkdirSync(
			join(
				env.ONLOOKER_DIR as string,
				"librarian",
				"aaaaaaaaaaaa",
				"lessons",
				"proposals",
			),
			{ recursive: true },
		);
		const message = await sync({ env, fetchImpl: accepts() });
		expect(message).toMatch(/nothing at any earlier stage/i);
	});

	// The case the bead was filed for: the pool is empty and the reason is two
	// proposals stuck one step short of it.
	it("names the stage that is holding proposals back", async () => {
		const env = linked();
		const dir = join(
			env.ONLOOKER_DIR as string,
			"librarian",
			"aaaaaaaaaaaa",
			"lessons",
			"proposals",
		);
		mkdirSync(dir, { recursive: true });
		for (const id of ["p1", "p2"]) {
			writeFileSync(join(dir, `${id}.json`), JSON.stringify({ status: "confirmed" }));
		}

		const fetchImpl = accepts();
		const message = await sync({ env, fetchImpl });
		expect(message).toMatch(/2 confirmed and awaiting a jury/);
		expect(message).toMatch(/0 pending review/);
		// Still the success path: nothing to send is not a failure.
		expect(fetchImpl).not.toHaveBeenCalled();
	});
```

Add `writeFileSync` to the existing `node:fs` import at the top of the file.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @onlooker/cli exec vitest run sync`
Expected: FAIL on all three new cases — the message is still `"Nothing to sync: no approved lessons yet."`

- [ ] **Step 3: Write the implementation**

In `apps/cli/src/commands/sync.ts`, add to the imports:

```ts
import { pipelineClause, surveyPipeline } from "../pipeline";
```

Then replace this block (currently lines 43-45):

```ts
	if (found.files.length === 0) {
		return "Nothing to sync: no approved lessons yet.";
	}
```

with:

```ts
	if (found.files.length === 0) {
		// An empty pool has four causes that need four different responses, and
		// this sentence used to be the same for all of them. The survey is a
		// read of files already on disk - no network call, and it only runs on
		// the path where there is nothing to send anyway.
		return `Nothing to sync: ${pipelineClause(surveyPipeline(env))}`;
	}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @onlooker/cli exec vitest run sync`
Expected: PASS, all cases including the untouched pre-existing ones.

- [ ] **Step 5: Lint and typecheck**

Run: `pnpm --filter @onlooker/cli lint && pnpm --filter @onlooker/cli typecheck`
Expected: both clean.

- [ ] **Step 6: Commit**

Use the `/commit` skill. Stage `apps/cli/src/commands/sync.ts` and `apps/cli/src/__tests__/sync.test.ts`.

---

### Task 4: Wire it into `status`, and re-pad the labels

**Files:**
- Modify: `apps/cli/src/commands/status.ts`
- Test: `apps/cli/src/__tests__/status.test.ts`

**Interfaces:**
- Consumes: `surveyPipeline` and `pipelineLines` from Tasks 1 and 2.
- Produces: no new exports.

**Context:** `status.ts` pads every label to the width of the longest, which is currently `Lessons:` (8 characters, padded to 9 columns). `Pipeline:` is 9 characters, so **every label gains one space** and the block's continuation lines indent by 10.

- [ ] **Step 1: Write the failing tests**

Add to `apps/cli/src/__tests__/status.test.ts`:

```ts
	it("breaks the pipeline down by stage", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		writeConfig(
			{ apiBaseUrl: "https://api.onlooker.dev", machineToken: "tok" },
			env,
		);
		const dir = join(
			env.ONLOOKER_DIR as string,
			"librarian",
			"aaaaaaaaaaaa",
			"lessons",
			"proposals",
		);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "p1.json"), JSON.stringify({ status: "confirmed" }));

		const message = await status({ env, fetchImpl: ok() });
		expect(message).toMatch(/^Pipeline: 0 pending review$/m);
		expect(message).toMatch(/^ {10}1 confirmed, awaiting a jury$/m);
		expect(message).toMatch(/^ {10}0 judged, awaiting promotion$/m);
		expect(message).toMatch(/^ {10}0 declined$/m);
	});

	// Every label pads to the longest, and `Pipeline:` is now the longest.
	it("re-pads every label so the values still share a column", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		writeConfig(
			{ apiBaseUrl: "https://api.onlooker.dev", machineToken: "tok" },
			env,
		);
		mkdirSync(join(env.ONLOOKER_DIR as string, "librarian"), {
			recursive: true,
		});

		const message = await status({ env, fetchImpl: ok() });
		// Continuation lines start with a space and carry no label.
		const labeled = message.split("\n").filter((line) => /^\S/.test(line));
		expect(labeled.length).toBe(5);
		for (const line of labeled) {
			// The first colon is always the label's - a value containing one
			// (the API URL) has it later. Every value begins at column 10.
			const afterLabel = line.indexOf(":") + 1;
			expect(line.slice(afterLabel).search(/\S/) + afterLabel).toBe(10);
		}
	});

	// The pool is empty either way; only `status` can say the difference
	// between "librarian never ran" and "it ran and proposed nothing".
	it("says when the lesson pipeline has never run", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		writeConfig(
			{ apiBaseUrl: "https://api.onlooker.dev", machineToken: "tok" },
			env,
		);
		mkdirSync(join(env.ONLOOKER_DIR as string, "librarian"), {
			recursive: true,
		});

		const message = await status({ env, fetchImpl: ok() });
		expect(message).toMatch(/^Pipeline: no lesson pipeline has run here$/m);
	});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @onlooker/cli exec vitest run status`
Expected: FAIL — no `Pipeline:` line exists.

- [ ] **Step 3: Write the implementation**

In `apps/cli/src/commands/status.ts`, add to the imports:

```ts
import { pipelineLines, surveyPipeline } from "../pipeline";
```

Replace the two opening lines of the `lines` array (currently the `API:`/`Config:` entries) and its comment with:

```ts
	// Padded to the width of the longest label, so every value starts in the
	// same column. `Pipeline:` is the longest at nine characters, so every
	// label pads to ten and the pipeline block's continuation lines indent to
	// match.
	const lines = [
		`API:      ${config.apiBaseUrl}`,
		`Config:   ${configPath(env)}`,
	];
```

Then widen the three token lines by one space each — `"Token:    not linked - run \`onlooker link\`"`, `` `Token:    accepted` ``, and the two in the catch block (`` `Token:    rejected - ${detail}` `` and `` `Token:    unknown - ${detail}` ``).

Widen the two `Lessons:` lines in the `no-onlooker-dir` and `no-librarian-dir` branches to `"Lessons:  "`, and the `found` branch's template to:

```ts
		lines.push(
			`Lessons:  ${ready} approved lesson${ready === 1 ? "" : "s"} ready to sync` +
				(unreadable > 0 ? `, ${unreadable} that cannot be read` : ""),
		);
```

Finally, append the block at the end of that same `else` branch, so it appears exactly when the `librarian/` directory exists:

```ts
		// Only on the `found` branch. The two branches above already say that
		// no plugin, or no librarian, has run here - a stage breakdown under
		// either would be four zeros restating a sentence directly above it.
		const [first, ...rest] = pipelineLines(surveyPipeline(env));
		lines.push(`Pipeline: ${first}`);
		for (const line of rest) lines.push(`${" ".repeat(10)}${line}`);
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @onlooker/cli exec vitest run status`
Expected: PASS. If a pre-existing test asserts an exact label width, update it to the new column — that is the intended change, not a regression.

- [ ] **Step 5: Run the whole CLI suite**

Run: `pnpm --filter @onlooker/cli test`
Expected: PASS, all files.

- [ ] **Step 6: Lint and typecheck**

Run: `pnpm --filter @onlooker/cli lint && pnpm --filter @onlooker/cli typecheck`
Expected: both clean.

- [ ] **Step 7: Verify against the real machine**

Run: `pnpm --filter @onlooker/cli build && node apps/cli/dist/onlooker.mjs status`

Expected on this machine, given 15 project keys hold only librarian's memory queue and the sole `lessons/` directory belongs to the `74a96f183d5e` fixture:

```
Pipeline: 0 pending review
          2 confirmed, awaiting a jury
          0 judged, awaiting promotion
          0 declined
```

If `Pipeline:` instead reports `no lesson pipeline has run here`, the walk is not finding `74a96f183d5e/lessons/proposals/` — check the `existsSync` on `<key>/lessons` before assuming the counts are wrong.

- [ ] **Step 8: Commit**

Use the `/commit` skill. Stage `apps/cli/src/commands/status.ts` and `apps/cli/src/__tests__/status.test.ts`.

---

### Task 5: Close out

- [ ] **Step 1: Run the full workspace gates**

Run: `pnpm typecheck && pnpm lint && ./node_modules/.bin/turbo run test --force`
Expected: typecheck 11/11, lint 12/12, test 14/14.

On lint warnings: `SESSION_HANDOFF.md` says there are 11 pre-existing warnings (9 in `apps/web`, 2 in `apps/api`). That figure is stale — it describes the old two-workspace CI matrix. Across all 12 linted workspaces the real count is **36**: `lesson-contract` 11, `auth-react` 14, `web` 9, `api` 2. PR #103 widened lint coverage and made the other 25 visible without anyone re-baselining the number. This branch adds none of them: it touches only `apps/cli`, which reports zero warnings, plus two docs files.

- [ ] **Step 2: Open the PR**

Use the `git-workflow:pr` skill. The branch must not be `main`.

- [ ] **Step 3: Update the bead**

```bash
bd close onlooker-5iy
```

Note in the close reason that the bead's "counts are all directory listings" premise was wrong — the stage lives in a `status` field inside each proposal — and that the implementation covers five statuses and four zero-states rather than the three states the bead described.

---

## Self-Review

**Spec coverage.** Every approved section maps to a task: the module and survey to Task 1; unknown-status bucketing, the four zero-states, and both output forms to Tasks 1-2; `sync`'s clause to Task 3; `status`'s block and the re-padding to Task 4. The error-handling section is covered by the `unreadable` and `unrecognized` tests in Task 1. The out-of-scope list is honored — no task touches `lessons.ts`, `discoverApproved`, or `~/.claude`.

**Known deviation from the spec.** The spec's `status` mockup shows four lines and does not show `passed`; Task 2 renders `passed` only when non-zero, which is what the spec's "Which counts appear" subsection specifies. The mockup and the rule agree because that mockup has `passed: 0`.

**Type consistency.** `PipelineSurvey` field names are identical in the interface (Task 1), the `STAGES` table keys (Task 2), and every test helper. `surveyPipeline`, `pipelineClause`, and `pipelineLines` keep the same signatures across Tasks 1-4.

**Test-only import.** Task 2's `survey()` helper annotates its return as `PipelineSurvey`, so the test file must import the type as well as the three functions.
