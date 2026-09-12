# Local Lesson Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `onlooker playbook` reads this machine's mirror and reports which lessons apply to this project, and which of those are about what you are currently changing.

**Architecture:** Four pure modules and one command. `stack.ts` resolves installed versions from disk. `ranges.ts` evaluates the contract's comparator grammar with no dependency. `playbook.ts` applies the three gates and returns a verdict per lesson. `worktree.ts` supplies changed files and pattern matching. `commands/playbook.ts` renders.

**Tech Stack:** TypeScript, Vitest, Node `fs`. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-12-local-lesson-reader-design.md`. **Bead:** `onlooker-onz1`.

## Global Constraints

- **Unresolvable is "cannot tell", never "does not apply."** Skipping an unmatched constraint mints a lesson that never expires; treating it as a non-match hides one silently. Neither happens quietly.
- **Only `active` lessons are advice.** `refuted`, `superseded`, `retracted` are excluded outright.
- **Every `stack` entry must be present, and every `scope.versions` entry must satisfy its comparator.** Entries combine with AND.
- **Versions come from what is installed**, never from `package.json`'s declared ranges.
- **`file_patterns` split the output; they never hide a lesson.** `task_kinds` is displayed and never filtered on.
- **No new runtime dependency.** `apps/cli` has exactly one and keeps it.
- **A mirror file the contract refuses is reported, not skipped.**
- Run tests with `pnpm --filter @onlooker/cli test`.

## Two decisions the spec left to this plan

**Git is the first subprocess this CLI has ever run.** Nothing in `apps/cli` imports `child_process` today. Working-tree relevance needs the changed-file list, and the alternatives are worse: parsing `.git` by hand, or a `--files` flag that a human would have to populate by hand. So `worktree.ts` shells out to `git`, and **every failure mode degrades to "no working-tree signal"** rather than to an error — no git on PATH, not a repository, a git that errors. Relevance is an enhancement to the output, so losing it must not cost the answer.

**Glob matching is hand-rolled and deliberately small.** Supports `*` (within a segment), `**` (across segments) and `?`. Anything else is treated as a literal. A pattern this matcher cannot express is documented as such rather than silently mismatched.

## File Structure

| File | Responsibility |
|---|---|
| `apps/cli/src/pool.ts` → keeps its name, gains the rename | The mirror on disk and the cursor. `poolDir` becomes `mirrorDir`, with a one-time migration. |
| `apps/cli/src/ranges.ts` (new) | The contract's comparator grammar. Pure, no I/O. |
| `apps/cli/src/stack.ts` (new) | What is installed in this project, and at what version. |
| `apps/cli/src/worktree.ts` (new) | Changed files from git, and glob matching. The only subprocess in the CLI. |
| `apps/cli/src/playbook.ts` (new) | The three gates. Pure: takes lessons plus resolved context, returns verdicts. |
| `apps/cli/src/commands/playbook.ts` (new) | Reads the mirror, assembles context, renders text or JSON. |

`playbook.ts` is pure on purpose: the gates are the part most worth testing exhaustively, and keeping them free of disk and git means their tests state applicability rules rather than fixture plumbing.

---

### Task 1: Rename the mirror, and migrate anyone who has the old name

**Files:**
- Modify: `apps/cli/src/pool.ts`
- Modify: `apps/cli/src/__tests__/pool.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `mirrorDir(env?)` replacing `poolDir`; `migrateLegacyPool(env?): string | null` returning a note when it moved something.

- [ ] **Step 1: Write the failing tests**

```ts
describe("mirrorDir", () => {
	it("is ~/.onlooker/mirror, not pool", () => {
		const e = env();
		expect(mirrorDir(e)).toBe(join(e.ONLOOKER_DIR as string, "mirror"));
	});
});

describe("migrateLegacyPool", () => {
	// pool/ shipped in 2.4.0. A machine that pulled before the rename has one,
	// and leaving it beside mirror/ is the confusion the rename exists to end.
	it("moves an existing pool directory and says so", () => {
		const e = env();
		const legacy = join(e.ONLOOKER_DIR as string, "pool");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "cursor.json"), JSON.stringify({ seq: 9 }));

		const note = migrateLegacyPool(e);

		expect(note).toMatch(/pool/);
		expect(note).toMatch(/mirror/);
		expect(readCursor(e)).toBe(9);
		expect(existsSync(legacy)).toBe(false);
	});

	it("says nothing when there is nothing to move", () => {
		expect(migrateLegacyPool(env())).toBeNull();
	});

	// Never clobber. If both exist, the new one is authoritative and the old
	// one is left alone for a person to look at rather than silently merged.
	it("leaves both alone when mirror already exists", () => {
		const e = env();
		mkdirSync(join(e.ONLOOKER_DIR as string, "pool"), { recursive: true });
		writeCursor(3, e);

		expect(migrateLegacyPool(e)).toMatch(/both/i);
		expect(existsSync(join(e.ONLOOKER_DIR as string, "pool"))).toBe(true);
		expect(readCursor(e)).toBe(3);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @onlooker/cli test -- pool`
Expected: FAIL — `mirrorDir is not a function`.

- [ ] **Step 3: Implement**

Rename `poolDir` to `mirrorDir`, changing `"pool"` to `"mirror"`, and add:

```ts
/**
 * Move a pre-2.4.1 `pool/` to `mirror/`.
 *
 * `pool/` shipped in 2.4.0, and the rename is because every user-facing string
 * uses "pool" for the *hosted* set - so the local copy sharing that name
 * collides with the tool's own output.
 *
 * Reported rather than silent: this codebase does not move a person's files
 * without saying so. The stakes are low either way - the cursor is the only
 * state and re-mirroring from zero is free - so this exists to avoid leaving a
 * confusing orphan, not to protect data.
 */
export function migrateLegacyPool(
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const legacy = join(onlookerDir(env), "pool");
	if (!existsSync(legacy)) return null;

	const target = mirrorDir(env);
	if (existsSync(target)) {
		// Merging two cursors would be a guess about which is further along.
		return `Both ${legacy} and ${target} exist. ${target} is the one in use; ${legacy} is left for you to remove.`;
	}

	renameSync(legacy, target);
	return `Moved ${legacy} to ${target}: "pool" now means the hosted set only.`;
}
```

Update every `poolDir` reference in `pull.ts` and the tests.

- [ ] **Step 4: Run the whole CLI suite**

Run: `pnpm --filter @onlooker/cli test`
Expected: PASS. `pull.test.ts` references `poolDir`; it moves to `mirrorDir` with no behavior change.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/pool.ts apps/cli/src/pull.ts apps/cli/src/__tests__/
git commit -m "refactor(cli): call the local copy a mirror, because pool means the hosted set :label:"
```

---

### Task 2: The comparator grammar

**Files:**
- Create: `apps/cli/src/ranges.ts`
- Create: `apps/cli/src/__tests__/ranges.test.ts`

**Interfaces:**
- Consumes: nothing. Pure.
- Produces:

```ts
export type RangeVerdict = "satisfied" | "unsatisfied" | "unparseable";
export function satisfies(installed: string, range: string): RangeVerdict;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { satisfies } from "../ranges";

describe("satisfies", () => {
	it("evaluates a single upper bound", () => {
		expect(satisfies("5.2.1", "<6")).toBe("satisfied");
		expect(satisfies("6.0.0", "<6")).toBe("unsatisfied");
	});

	it("evaluates a single lower bound", () => {
		expect(satisfies("5.2.1", ">=4")).toBe("satisfied");
		expect(satisfies("3.9.9", ">=4")).toBe("unsatisfied");
	});

	// Two clauses AND, lower bound then upper, per VERSION_RANGE.
	it("evaluates a two-sided range", () => {
		expect(satisfies("5.2.1", ">=4 <6")).toBe("satisfied");
		expect(satisfies("3.0.0", ">=4 <6")).toBe("unsatisfied");
		expect(satisfies("6.0.1", ">=4 <6")).toBe("unsatisfied");
	});

	it("compares numerically, not lexically", () => {
		// The bug a string comparison produces: "10" < "9" as text.
		expect(satisfies("10.0.0", ">=9")).toBe("satisfied");
		expect(satisfies("5.10.0", ">=5.9")).toBe("satisfied");
	});

	it("treats a missing component as zero", () => {
		expect(satisfies("6", "<6.0.1")).toBe("satisfied");
		expect(satisfies("6.0", ">=6")).toBe("satisfied");
	});

	// Someone on a 6 prerelease is on 6 for a lesson scoped <6. The other
	// reading keeps a retired lesson alive for the people most likely to hit
	// whatever replaced it.
	it("compares a prerelease on its numeric core", () => {
		expect(satisfies("6.0.0-beta.1", "<6")).toBe("unsatisfied");
		expect(satisfies("6.0.0-beta.1", ">=6")).toBe("satisfied");
	});

	it("reports an unparseable installed version rather than guessing", () => {
		expect(satisfies("workspace:*", "<6")).toBe("unparseable");
		expect(satisfies("", "<6")).toBe("unparseable");
	});

	it("reports an unparseable range rather than guessing", () => {
		// A bare "4" is rejected by the contract precisely because it is
		// ambiguous; if one reaches us anyway, we do not invent a meaning.
		expect(satisfies("4.0.0", "4")).toBe("unparseable");
		expect(satisfies("4.0.0", "~4")).toBe("unparseable");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @onlooker/cli test -- ranges`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/cli/src/ranges.ts`**

```ts
/**
 * The contract's comparator grammar, evaluated without a semver dependency.
 *
 * `apps/cli` has exactly one runtime dependency and keeps it. VERSION_RANGE is
 * deliberately narrow - comparator-prefixed, at most a lower and an upper
 * bound, with a bare "4" rejected because it is ambiguous about whether it
 * means "exactly 4" - and a grammar that small is honestly implementable here.
 * A general semver engine would be the larger change, not the smaller one.
 */
export type RangeVerdict = "satisfied" | "unsatisfied" | "unparseable";

/** `6.0.0-beta.1` -> [6, 0, 0]. Null when there is no numeric core. */
function numericCore(version: string): number[] | null {
	const core = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
	if (!core) return null;
	return [Number(core[1]), Number(core[2] ?? 0), Number(core[3] ?? 0)];
}

/** Negative, zero or positive, comparing component by component. */
function compare(a: number[], b: number[]): number {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
}

export function satisfies(installed: string, range: string): RangeVerdict {
	const version = numericCore(installed);
	if (version === null) return "unparseable";

	const clauses = range.trim().split(/\s+/).filter(Boolean);
	if (clauses.length === 0) return "unparseable";

	for (const clause of clauses) {
		const parsed = /^(>=|<=|>|<)(.+)$/.exec(clause);
		// A clause with no comparator is the ambiguous case the contract
		// rejects at ingest. Reaching here means something upstream accepted
		// what it should not have, and inventing a meaning would hide that.
		if (!parsed) return "unparseable";

		const bound = numericCore(parsed[2]);
		if (bound === null) return "unparseable";

		const diff = compare(version, bound);
		const ok =
			parsed[1] === "<"
				? diff < 0
				: parsed[1] === "<="
					? diff <= 0
					: parsed[1] === ">"
						? diff > 0
						: diff >= 0;
		if (!ok) return "unsatisfied";
	}

	return "satisfied";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @onlooker/cli test -- ranges`
Expected: PASS, all eight.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/ranges.ts apps/cli/src/__tests__/ranges.test.ts
git commit -m "feat(cli): evaluate the contract's version ranges without a dependency :straight_ruler:"
```

---

### Task 3: What is installed here

**Files:**
- Create: `apps/cli/src/stack.ts`
- Create: `apps/cli/src/__tests__/stack.test.ts`

**Interfaces:**
- Consumes: `repoRoot` from `enablement.ts`.
- Produces:

```ts
/** Installed version per package name. Absent key means not installed. */
export type InstalledStack = Map<string, string>;
export function resolveStack(cwd: string): {
	root: string | null;
	installed: InstalledStack;
};
```

- [ ] **Step 1: Write the failing tests**

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStack } from "../stack";

function project(): string {
	const root = mkdtempSync(join(tmpdir(), "onlooker-stack-"));
	mkdirSync(join(root, ".git"), { recursive: true });
	return root;
}

function installed(root: string, name: string, version: string): void {
	const dir = join(root, "node_modules", ...name.split("/"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
}

describe("resolveStack", () => {
	it("reads the installed version, not the declared range", () => {
		const root = project();
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ dependencies: { vite: "^5.2.0" } }),
		);
		installed(root, "vite", "6.0.1");

		// The whole point: a caret over a lockfile pinning 6 must not keep a
		// lesson scoped `<6` alive.
		expect(resolveStack(root).installed.get("vite")).toBe("6.0.1");
	});

	it("handles a scoped package", () => {
		const root = project();
		installed(root, "@vitest/coverage-v8", "4.1.9");

		expect(resolveStack(root).installed.get("@vitest/coverage-v8")).toBe("4.1.9");
	});

	// Not installed is absent, which the matcher reads as "cannot tell" rather
	// than as "does not apply".
	it("omits a package that is not installed", () => {
		const root = project();
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ dependencies: { vite: "^5.2.0" } }),
		);

		expect(resolveStack(root).installed.has("vite")).toBe(false);
	});

	it("reports no root outside a repository", () => {
		const loose = mkdtempSync(join(tmpdir(), "onlooker-loose-"));
		expect(resolveStack(loose).root).toBeNull();
	});

	it("survives a package.json that will not parse", () => {
		const root = project();
		installed(root, "vite", "5.0.0");
		const broken = join(root, "node_modules", "broken");
		mkdirSync(broken, { recursive: true });
		writeFileSync(join(broken, "package.json"), "{ not json");

		// One unreadable package must not cost the whole resolution.
		expect(resolveStack(root).installed.get("vite")).toBe("5.0.0");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @onlooker/cli test -- stack`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/cli/src/stack.ts`**

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./enablement";

export type InstalledStack = Map<string, string>;

/**
 * What this project actually runs.
 *
 * Read from `node_modules`, never from `package.json`'s declared ranges. A
 * declared `^5.2.0` against a lockfile pinning 6.x would keep a lesson scoped
 * `<6` alive - the exact false positive structural staleness exists to
 * prevent.
 *
 * An absent key means "not installed", which the matcher reads as *cannot
 * tell* rather than as *does not apply*. A project whose dependencies are not
 * installed yet is a project we cannot answer about, not one that nothing
 * applies to.
 */
export function resolveStack(cwd: string): {
	root: string | null;
	installed: InstalledStack;
} {
	const root = repoRoot(cwd);
	const installed: InstalledStack = new Map();
	if (root === null) return { root: null, installed };

	const modules = join(root, "node_modules");
	if (!existsSync(modules)) return { root, installed };

	for (const entry of safeReaddir(modules)) {
		if (entry.startsWith(".")) continue;
		// A scope directory holds packages rather than being one.
		if (entry.startsWith("@")) {
			for (const scoped of safeReaddir(join(modules, entry))) {
				record(installed, modules, `${entry}/${scoped}`);
			}
			continue;
		}
		record(installed, modules, entry);
	}

	return { root, installed };
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** One package's version, skipping anything unreadable. */
function record(into: InstalledStack, modules: string, name: string): void {
	try {
		const manifest = JSON.parse(
			readFileSync(join(modules, ...name.split("/"), "package.json"), "utf8"),
		) as { version?: unknown };
		// One unreadable package must not cost the whole resolution; the
		// matcher will report the lesson that needed it as cannot-tell.
		if (typeof manifest.version === "string") into.set(name, manifest.version);
	} catch {
		return;
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @onlooker/cli test -- stack`
Expected: PASS, all five.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/stack.ts apps/cli/src/__tests__/stack.test.ts
git commit -m "feat(cli): resolve what a project runs from what is installed :package:"
```

---

### Task 4: The working tree

**Files:**
- Create: `apps/cli/src/worktree.ts`
- Create: `apps/cli/src/__tests__/worktree.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
/** Changed files relative to the repo root, or null when git cannot say. */
export function changedFiles(cwd: string): string[] | null;
export function matchesPattern(file: string, pattern: string): boolean;
```

- [ ] **Step 1: Write the failing tests**

```ts
describe("matchesPattern", () => {
	it("matches a literal path", () => {
		expect(matchesPattern("src/worker.ts", "src/worker.ts")).toBe(true);
		expect(matchesPattern("src/other.ts", "src/worker.ts")).toBe(false);
	});

	// `*` stops at a separator; `**` crosses them. Getting this backwards
	// makes every pattern match everything.
	it("keeps * within one segment", () => {
		expect(matchesPattern("src/worker.ts", "src/*.ts")).toBe(true);
		expect(matchesPattern("src/deep/worker.ts", "src/*.ts")).toBe(false);
	});

	it("lets ** cross segments", () => {
		expect(matchesPattern("src/deep/worker.ts", "src/**/*.ts")).toBe(true);
		expect(matchesPattern("src/worker.ts", "src/**/*.ts")).toBe(true);
	});

	it("matches a single character with ?", () => {
		expect(matchesPattern("src/a.ts", "src/?.ts")).toBe(true);
		expect(matchesPattern("src/ab.ts", "src/?.ts")).toBe(false);
	});

	// Regex metacharacters in a pattern are literals, not syntax.
	it("treats a dot as a dot", () => {
		expect(matchesPattern("srcXworker.ts", "src.worker.ts")).toBe(false);
	});
});

describe("changedFiles", () => {
	it("is null outside a git repository", () => {
		expect(changedFiles(mkdtempSync(join(tmpdir(), "onlooker-nogit-")))).toBeNull();
	});

	// Relevance is an enhancement to the answer. Losing it must not cost the
	// answer, so every failure degrades to null rather than throwing.
	it("is null rather than throwing when git cannot answer", () => {
		expect(changedFiles("/definitely/not/a/path")).toBeNull();
	});

	// Against a real repository, not a stub: this module's whole risk is the
	// subprocess and its output format, and a stub would test neither.
	it("lists a modified file, relative to the repo root", () => {
		const root = mkdtempSync(join(tmpdir(), "onlooker-repo-"));
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, stdio: "ignore" });
		git("init");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "T");
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "worker.ts"), "export {};\n");
		git("add", ".");
		git("commit", "-m", "first");
		writeFileSync(join(root, "src", "worker.ts"), "export const x = 1;\n");

		expect(changedFiles(root)).toContain("src/worker.ts");
	});

	it("lists an untracked file too", () => {
		const root = mkdtempSync(join(tmpdir(), "onlooker-repo-"));
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, stdio: "ignore" });
		git("init");
		writeFileSync(join(root, "new.ts"), "export {};\n");

		// A file you just created is something you are working on, and a
		// lesson about it is as relevant as one about a modified file.
		expect(changedFiles(root)).toContain("new.ts");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @onlooker/cli test -- worktree`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/cli/src/worktree.ts`**

```ts
import { execFileSync } from "node:child_process";

/**
 * Files the working tree has changed, relative to the repository root.
 *
 * The only subprocess in this CLI. Nothing else here shells out, and that was
 * worth preserving - but the alternatives are parsing `.git` by hand or asking
 * a person to list their own changed files, and both are worse.
 *
 * Null on every failure: no git, not a repository, a git that errors. Relevance
 * only ever splits the output; losing it must not cost the answer.
 */
export function changedFiles(cwd: string): string[] | null {
	try {
		const out = execFileSync(
			"git",
			["status", "--porcelain=v1", "--untracked-files=all"],
			{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
		return out
			.split("\n")
			.filter(Boolean)
			// "XY path", and for a rename "XY old -> new": the new name is
			// what exists to be matched against.
			.map((line) => line.slice(3).split(" -> ").pop() ?? "")
			.filter(Boolean);
	} catch {
		return null;
	}
}

/**
 * Glob matching, deliberately small: `*` within a segment, `**` across them,
 * `?` for one character. Everything else is a literal, including regex
 * metacharacters - a pattern this cannot express should fail to match rather
 * than match something unintended.
 */
export function matchesPattern(file: string, pattern: string): boolean {
	const expanded = pattern
		.split(/(\*\*\/|\*\*|\*|\?)/)
		.filter(Boolean)
		.map((part) => {
			if (part === "**/") return "(?:.*/)?";
			if (part === "**") return ".*";
			if (part === "*") return "[^/]*";
			if (part === "?") return "[^/]";
			return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		})
		.join("");

	return new RegExp(`^${expanded}$`).test(file);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @onlooker/cli test -- worktree`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/worktree.ts apps/cli/src/__tests__/worktree.test.ts
git commit -m "feat(cli): ask git what you are touching, and shrug if it cannot say :mag_right:"
```

---

### Task 5: The three gates

The task the design rests on. Pure — no disk, no git — so its tests state applicability rules rather than fixture plumbing.

**Files:**
- Create: `apps/cli/src/playbook.ts`
- Create: `apps/cli/src/__tests__/playbook.test.ts`

**Interfaces:**
- Consumes: `satisfies` (Task 2), `InstalledStack` (Task 3), `matchesPattern` (Task 4).
- Produces:

```ts
export type Verdict =
	| { kind: "applies"; changed: boolean; matchedPatterns: string[] }
	| { kind: "cannot-tell"; reason: string }
	| { kind: "excluded"; reason: string };

export function judge(
	lesson: TLesson,
	context: { installed: InstalledStack; changedFiles: string[] | null },
): Verdict;
```

- [ ] **Step 1: Write the failing tests**

```ts
const base = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as TLesson;

const lesson = (over: Partial<TLesson>): TLesson => ({ ...base, ...over });
const ctx = (
	installed: Record<string, string>,
	changedFiles: string[] | null = null,
) => ({ installed: new Map(Object.entries(installed)), changedFiles });

describe("judge — status", () => {
	// Surfacing a refuted lesson as advice is worse than surfacing nothing:
	// it is this pipeline's failure dressed as its output.
	it.each(["refuted", "superseded", "retracted"])("excludes %s", (status) => {
		const v = judge(lesson({ status } as Partial<TLesson>), ctx({ vite: "5.0.0" }));
		expect(v.kind).toBe("excluded");
	});

	it("admits active", () => {
		expect(judge(base, ctx({ vite: "5.0.0" })).kind).toBe("applies");
	});
});

describe("judge — applicability", () => {
	it("applies when every version constraint is satisfied", () => {
		expect(judge(base, ctx({ vite: "5.2.1" })).kind).toBe("applies");
	});

	// Structural staleness: the lesson retires itself on vite 6.
	it("excludes when a constraint is unsatisfied", () => {
		const v = judge(base, ctx({ vite: "6.0.0" }));
		expect(v.kind).toBe("excluded");
		if (v.kind !== "excluded") return;
		expect(v.reason).toMatch(/vite/);
	});

	// The trap applies-to.ts names: skipping the constraint would mint a
	// lesson that never expires, and calling it a non-match hides one.
	it("cannot tell when the package is not installed", () => {
		const v = judge(base, ctx({}));
		expect(v.kind).toBe("cannot-tell");
		if (v.kind !== "cannot-tell") return;
		expect(v.reason).toMatch(/vite/);
	});

	it("cannot tell when the installed version will not parse", () => {
		expect(judge(base, ctx({ vite: "workspace:*" })).kind).toBe("cannot-tell");
	});

	it("applies a version_independent lesson with no version gate", () => {
		const free = lesson({
			applies_to: {
				...base.applies_to,
				scope: { kind: "version_independent", justification: "Holds for all." },
			},
		});

		expect(judge(free, ctx({ vite: "99.0.0" })).kind).toBe("applies");
	});

	// Every stack entry, not any: a lesson naming two is about their
	// interaction.
	it("cannot tell when one of several stack entries is missing", () => {
		const pair = lesson({
			applies_to: { ...base.applies_to, stack: ["vite", "vitest"] },
		});

		expect(judge(pair, ctx({ vite: "5.2.1" })).kind).toBe("cannot-tell");
	});

	it("still gates a version_independent lesson on stack presence", () => {
		const free = lesson({
			applies_to: {
				...base.applies_to,
				scope: { kind: "version_independent", justification: "Holds." },
			},
		});

		expect(judge(free, ctx({})).kind).toBe("cannot-tell");
	});
});

describe("judge — relevance", () => {
	it("marks a lesson whose pattern matches a changed file", () => {
		const v = judge(base, ctx({ vite: "5.2.1" }, ["src/worker.ts"]));
		expect(v).toMatchObject({ kind: "applies", changed: true });
		if (v.kind !== "applies") return;
		expect(v.matchedPatterns).toEqual(["src/worker.ts"]);
	});

	// Demoted, never hidden.
	it("still applies when no pattern matches", () => {
		const v = judge(base, ctx({ vite: "5.2.1" }, ["README.md"]));
		expect(v).toMatchObject({ kind: "applies", changed: false });
	});

	// No git signal is not the same as nothing matching.
	it("is not marked changed when the working tree is unknown", () => {
		const v = judge(base, ctx({ vite: "5.2.1" }, null));
		expect(v).toMatchObject({ kind: "applies", changed: false });
	});

	// task_kinds is displayed, never filtered on: nothing here knows the task.
	it("never excludes on task_kinds", () => {
		const odd = lesson({
			applies_to: { ...base.applies_to, task_kinds: ["nothing-like-this"] },
		});

		expect(judge(odd, ctx({ vite: "5.2.1" })).kind).toBe("applies");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @onlooker/cli test -- playbook`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/cli/src/playbook.ts`**

Three gates in order, each returning before the next. Status first; then stack presence and `scope`, accumulating a `cannot-tell` reason the moment anything fails to resolve; then relevance, which only annotates. `matchesPattern` comes from Task 4, which is why it lands first: these gates import it.

```ts
export function judge(
	lesson: TLesson,
	context: { installed: InstalledStack; changedFiles: string[] | null },
): Verdict {
	if (lesson.status !== "active") {
		return {
			kind: "excluded",
			reason: `status is ${lesson.status}, so this is not advice`,
		};
	}

	const { stack, scope, file_patterns } = lesson.applies_to;

	const missing = stack.filter((name) => !context.installed.has(name));
	if (missing.length > 0) {
		return {
			kind: "cannot-tell",
			reason: `not installed here: ${missing.join(", ")}`,
		};
	}

	if (scope.kind === "versioned") {
		for (const [name, range] of Object.entries(scope.versions)) {
			const version = context.installed.get(name);
			// A versions key naming something absent from stack is the defect
			// applies-to.ts describes. Skipping it would mint a lesson that
			// never expires, so it resolves to cannot-tell instead.
			if (version === undefined) {
				return { kind: "cannot-tell", reason: `not installed here: ${name}` };
			}
			const verdict = satisfies(version, range);
			if (verdict === "unparseable") {
				return {
					kind: "cannot-tell",
					reason: `could not compare ${name} ${version} against "${range}"`,
				};
			}
			if (verdict === "unsatisfied") {
				return {
					kind: "excluded",
					reason: `${name} ${version} is outside "${range}"`,
				};
			}
		}
	}

	const matchedPatterns =
		context.changedFiles === null
			? []
			: file_patterns.filter((pattern) =>
					(context.changedFiles ?? []).some((file) =>
						matchesPattern(file, pattern),
					),
				);

	return { kind: "applies", changed: matchedPatterns.length > 0, matchedPatterns };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @onlooker/cli test -- playbook`
Expected: PASS, all fourteen.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/playbook.ts apps/cli/src/__tests__/playbook.test.ts
git commit -m "feat(cli): decide what applies, and refuse to guess when it cannot :balance_scale:"
```

---

### Task 6: The command

**Files:**
- Create: `apps/cli/src/commands/playbook.ts`
- Create: `apps/cli/src/__tests__/playbook-command.test.ts`
- Modify: `apps/cli/src/cli.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `playbook(opts: { env?; cwd?; json?: boolean }): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

```ts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { playbook } from "../commands/playbook";

const FIXTURE = JSON.parse(
	readFileSync(join(__dirname, "fixtures", "lesson.json"), "utf8"),
);

const IDS = [
	"01KZ45MKAM734ZS7JK24D2DK0R",
	"01KZ45MKAM734ZS7JK24D2DK0S",
	"01KZ45MKAM734ZS7JK24D2DK0T",
];

/** An ONLOOKER_DIR whose mirror holds these lessons. */
function mirrored(lessons: unknown[]): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(tmpdir(), "onlooker-pb-"));
	mkdirSync(join(dir, "mirror"), { recursive: true });
	for (const lesson of lessons) {
		const id = (lesson as { id: string }).id;
		writeFileSync(
			join(dir, "mirror", `${id}.json`),
			JSON.stringify(lesson, null, 2),
		);
	}
	return { ONLOOKER_DIR: dir };
}

/** A project root with the named packages installed. */
function project(installed: Record<string, string> = {}): string {
	const root = mkdtempSync(join(tmpdir(), "onlooker-proj-"));
	mkdirSync(join(root, ".git"), { recursive: true });
	for (const [name, version] of Object.entries(installed)) {
		const dir = join(root, "node_modules", ...name.split("/"));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
	}
	return root;
}

describe("playbook", () => {
	// An empty mirror and "nothing applies here" are different facts, and
	// collapsing them would tell someone their pool is irrelevant when it is
	// merely absent.
	it("says the mirror is empty rather than saying nothing applies", async () => {
		const out = await playbook({ env: mirrored([]), cwd: project() });

		expect(out).toMatch(/nothing has been mirrored/i);
		expect(out).not.toMatch(/nothing applies/i);
	});

	it("groups what is about your changes, what applies, and what it cannot tell", async () => {
		const env = mirrored([
			{ ...FIXTURE, id: IDS[0] },
			{
				...FIXTURE,
				id: IDS[1],
				applies_to: { ...FIXTURE.applies_to, file_patterns: ["nothing/here.ts"] },
			},
			{
				...FIXTURE,
				id: IDS[2],
				applies_to: { ...FIXTURE.applies_to, stack: ["not-installed"] },
			},
		]);

		const out = await playbook({ env, cwd: project({ vite: "5.2.1" }) });

		expect(out).toMatch(/applies to this project/i);
		expect(out).toMatch(/cannot tell/i);
		expect(out).toContain(IDS[2]);
	});

	// A verdict without its reason cannot be checked, which makes it a claim
	// rather than a finding.
	it("says why each lesson landed where it did", async () => {
		const env = mirrored([
			{
				...FIXTURE,
				id: IDS[0],
				applies_to: { ...FIXTURE.applies_to, stack: ["not-installed"] },
			},
		]);

		const out = await playbook({ env, cwd: project() });

		expect(out).toMatch(/not installed here: not-installed/);
	});

	it("excludes a refuted lesson and says so", async () => {
		const env = mirrored([{ ...FIXTURE, id: IDS[0], status: "refuted" }]);

		const out = await playbook({ env, cwd: project({ vite: "5.2.1" }) });

		// Never as advice; visible as excluded, because a refuted lesson in
		// your mirror is worth knowing about.
		expect(out).toMatch(/refuted/i);
		expect(out).not.toMatch(/applies to this project[\s\S]*01KZ45MKAM734ZS7JK24D2DK0R/i);
	});

	it("reports a mirror file the contract refuses rather than skipping it", async () => {
		const env = mirrored([]);
		writeFileSync(
			join(env.ONLOOKER_DIR as string, "mirror", "broken.json"),
			"{ not json",
		);

		const out = await playbook({ env, cwd: project() });

		expect(out).toMatch(/broken\.json/);
	});

	it("emits machine-readable output under --json", async () => {
		const env = mirrored([{ ...FIXTURE, id: IDS[0] }]);

		const out = await playbook({
			env,
			cwd: project({ vite: "5.2.1" }),
			json: true,
		});

		const parsed = JSON.parse(out) as {
			applies: Array<{ id: string; reason: string }>;
		};
		expect(parsed.applies[0].id).toBe(IDS[0]);
		expect(typeof parsed.applies[0].reason).toBe("string");
	});

	it("carries the migration note when it moved a legacy pool directory", async () => {
		const env = mirrored([]);
		// Remove mirror/ so the migration has somewhere to move to.
		const dir = env.ONLOOKER_DIR as string;
		mkdirSync(join(dir, "pool"), { recursive: true });
		writeFileSync(join(dir, "pool", "cursor.json"), JSON.stringify({ seq: 2 }));

		const out = await playbook({ env, cwd: project() });

		expect(out).toMatch(/pool/);
		expect(out).toMatch(/mirror/);
	});
});
```

The last test needs `mirrored([])` not to have created `mirror/` yet; if it has, delete it in the test before creating `pool/`, so the migration's happy path is the one exercised.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @onlooker/cli test -- playbook-command`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the command**

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ZLesson } from "@onlooker-community/lesson-contract";
import { judge, type Verdict } from "../playbook";
import { migrateLegacyPool, mirrorDir } from "../pool";
import { resolveStack } from "../stack";
import { changedFiles } from "../worktree";

interface Entry {
	id: string;
	claim: string;
	verdict: Verdict;
}

export async function playbook(opts: {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	json?: boolean;
}): Promise<string> {
	const env = opts.env ?? process.env;
	const cwd = opts.cwd ?? process.cwd();

	// First, so a machine that pulled before the rename is not quietly
	// reading an empty new directory beside its populated old one.
	const migration = migrateLegacyPool(env);

	const dir = mirrorDir(env);
	let files: string[];
	try {
		files = readdirSync(dir).filter(
			(f) => f.endsWith(".json") && f !== "cursor.json",
		);
	} catch {
		files = [];
	}

	const entries: Entry[] = [];
	const invalid: string[] = [];
	const { installed } = resolveStack(cwd);
	const changed = changedFiles(cwd);

	for (const file of files) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
		} catch (error) {
			invalid.push(`${file}: ${(error as Error).message}`);
			continue;
		}
		const parsed = ZLesson.safeParse(raw);
		if (!parsed.success) {
			// Reported, never skipped. This command is the only place a person
			// would ever see a mirrored record the contract refuses.
			const issue = parsed.error.issues[0];
			invalid.push(
				`${file}: ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "did not match the lesson contract"}`,
			);
			continue;
		}
		entries.push({
			id: parsed.data.id,
			claim: parsed.data.claim,
			verdict: judge(parsed.data, { installed, changedFiles: changed }),
		});
	}

	const changedGroup = entries.filter(
		(e) => e.verdict.kind === "applies" && e.verdict.changed,
	);
	const appliesGroup = entries.filter(
		(e) => e.verdict.kind === "applies" && !e.verdict.changed,
	);
	const cannotTell = entries.filter((e) => e.verdict.kind === "cannot-tell");
	const excluded = entries.filter((e) => e.verdict.kind === "excluded");

	if (opts.json) {
		return JSON.stringify(
			{
				migration,
				changed: changedGroup.map(describe),
				applies: appliesGroup.map(describe),
				cannotTell: cannotTell.map(describe),
				excluded: excluded.map(describe),
				invalid,
			},
			null,
			2,
		);
	}

	const lines: string[] = [];
	if (migration !== null) lines.push(migration, "");

	// An empty mirror and "nothing applies" are different facts. Saying the
	// second when the first is true tells someone their pool is irrelevant
	// when it is merely absent.
	if (entries.length === 0 && invalid.length === 0) {
		lines.push(
			`Nothing has been mirrored yet: ${dir} holds no lessons. Run \`onlooker sync\` to receive some.`,
		);
		return lines.join("\n");
	}

	section(lines, "About what you are changing", changedGroup);
	section(lines, "Applies to this project", appliesGroup);
	section(lines, "Cannot tell", cannotTell);
	section(lines, "Excluded", excluded);

	if (invalid.length > 0) {
		lines.push("", `${invalid.length} mirrored file(s) the contract refuses:`);
		for (const line of invalid) lines.push(`  ${line}`);
	}

	return lines.join("\n");
}

function describe(entry: Entry) {
	return {
		id: entry.id,
		claim: entry.claim,
		verdict: entry.verdict.kind,
		reason: reasonOf(entry.verdict),
		changed: entry.verdict.kind === "applies" && entry.verdict.changed,
	};
}

/** Every verdict carries one: a verdict without a reason cannot be checked. */
function reasonOf(verdict: Verdict): string {
	if (verdict.kind === "applies") {
		return verdict.matchedPatterns.length > 0
			? `matches ${verdict.matchedPatterns.join(", ")} in your working tree`
			: "stack and version constraints are satisfied";
	}
	return verdict.reason;
}

function section(lines: string[], heading: string, entries: Entry[]): void {
	if (entries.length === 0) return;
	lines.push("", `${heading} (${entries.length}):`);
	for (const entry of entries) {
		lines.push(`  ${entry.id}  ${entry.claim}`);
		lines.push(`    ${reasonOf(entry.verdict)}`);
	}
}
```

- [ ] **Step 4: Wire it into `cli.ts`**

```ts
		} else if (command === "playbook") {
			console.log(await playbook({ json: argv.includes("--json") }));
```

and add a line to the help text.

- [ ] **Step 5: Run the whole CLI suite**

Run: `pnpm --filter @onlooker/cli test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands/playbook.ts apps/cli/src/cli.ts apps/cli/src/__tests__/playbook-command.test.ts
git commit -m "feat(cli): give the mirror its first reader :open_book:"
```

---

## Final verification

- [ ] `pnpm test`, `pnpm typecheck`, and biome on the touched files only — **never `pnpm format`**, which reformats 32 unrelated files repo-wide.
- [ ] Run `onlooker playbook` in this repository against the real mirror. It is empty, so the expected output is the empty-mirror sentence — confirm it says that rather than "nothing applies", because those are different facts and the distinction is the whole design.
- [ ] Run it in a project with `node_modules` present and confirm the stack resolves — `resolveStack` against this repo should find real packages.
- [ ] Bump `apps/cli/package.json` to 2.5.0 **in the same PR**. Omitting it is what made the inventory ship inert.
- [ ] `bd close onlooker-onz1` once merged and released.
