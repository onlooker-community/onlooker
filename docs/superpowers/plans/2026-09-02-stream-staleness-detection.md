# Stream Staleness Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `onlooker doctor`, a command that reports which of this project's enabled plugin streams have stopped producing output, and exits non-zero when one has.

**Architecture:** Four new modules behind one command. `enablement.ts` reads what *should* be running from `.claude/settings.json`; `eventlog.ts` streams the two JSONL logs under `~/.onlooker/logs/` once each; `streams.ts` holds the `STREAMS` table, combines the three sources into per-plugin verdicts, and renders them; `commands/doctor.ts` is a thin caller. The staleness rule is "count trigger firings since the output last moved" — the hook is the trigger, so the denominator calibrates itself per stream.

**Tech Stack:** TypeScript (ESM, `type: module`), Node 20 target, vitest, biome, esbuild. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-02-stream-staleness-detection-design.md`

## Global Constraints

- **Never throw from a survey or reader.** Every failure becomes a reported state. This is the command someone runs *because* the machine is broken; a diagnostic that dies on the state it exists to report is useless at the only moment it matters. `pipeline.ts` documents this contract — match it.
- **"Unknown" is never "healthy."** A source that could not be read produces `unknown`, not a clean bill. `status.ts` already draws this line for unlistable directories.
- **Alphabetical output, never filesystem order.** Filesystem listing order is not deterministic across platforms; a diagnostic that reshuffles between runs on identical disk state cannot be diffed or pasted into a bug report.
- **Exit codes reuse `cli.ts`'s existing convention:** `0` success, `1` "stop and go look", `2` "transient, retry may fix". Doctor uses only 0 and 1. Nothing here is transient.
- **Unknown vocabulary is named, not dropped.** A plugin with no table entry is reported by name. The stream vocabulary is owned by `onlooker-community/ecosystem` and will grow; a closed enum turns a marketplace release into a hard failure on a healthy machine.
- **Stall threshold: `5` firings.** Named constant, defined once in `streams.ts`.
- **No new dependencies.** Node built-ins only, `node:`-prefixed.
- **Tabs for indentation, American English throughout** (biome enforces the first; the repo convention is the second).
- **Edit tracked files with Edit/Write, never shell heredocs or `sed -i`.** The `lineage` and `inspector` plugins hook `PostToolUse` on `Edit`/`Write`/`MultiEdit`; a shell edit moves the same bytes invisibly and the change ledger cannot distinguish "not recorded" from "not changed."

---

### Task 1: Expected plugin set from `.claude/settings.json`

**Files:**
- Create: `apps/cli/src/enablement.ts`
- Test: `apps/cli/src/__tests__/enablement.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `findUp(startDir: string, relPath: string): string | null`, `type Enablement`, `readEnablement(opts: { cwd: string; home?: string }): Enablement`.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findUp, readEnablement } from "../enablement";

/** A temp directory tree with a `.claude/settings.json` at its root. */
function project(settings: unknown, nested = "a/b/c"): { root: string; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "onlooker-enable-"));
	mkdirSync(join(root, ".claude"), { recursive: true });
	writeFileSync(
		join(root, ".claude", "settings.json"),
		typeof settings === "string" ? settings : JSON.stringify(settings),
	);
	const cwd = join(root, nested);
	mkdirSync(cwd, { recursive: true });
	return { root, cwd };
}

/** A temp home with no `.claude/settings.json`, so only the project file counts. */
function bareHome(): string {
	return mkdtempSync(join(tmpdir(), "onlooker-home-"));
}

describe("findUp", () => {
	it("finds a file in an ancestor directory", () => {
		const { root, cwd } = project({ enabledPlugins: {} });
		expect(findUp(cwd, join(".claude", "settings.json"))).toBe(
			join(root, ".claude", "settings.json"),
		);
	});

	it("returns null when nothing up the tree has it", () => {
		const empty = mkdtempSync(join(tmpdir(), "onlooker-none-"));
		expect(findUp(empty, join(".claude", "nonexistent.json"))).toBeNull();
	});
});

describe("readEnablement", () => {
	it("keeps only onlooker-community plugins that are switched on", () => {
		const { cwd } = project({
			enabledPlugins: {
				"ecosystem@onlooker-community": true,
				"bursar@onlooker-community": true,
				"archivist@onlooker-community": false,
				"typescript-architect@meaganewaller-marketplace": true,
			},
		});
		const found = readEnablement({ cwd, home: bareHome() });
		expect(found.kind).toBe("found");
		if (found.kind !== "found") return;
		// Sorted, so the report cannot reshuffle between runs.
		expect(found.plugins).toEqual(["bursar", "ecosystem"]);
	});

	// The whole point of the command is to stop guessing. An absent config is
	// not an empty expected-set: one says "nothing should be running", the
	// other says "I do not know what should be running", and reporting the
	// first when the second is true is the confident-but-wrong sentence this
	// work exists to remove.
	it("reports unknown rather than empty when no settings file exists", () => {
		const empty = mkdtempSync(join(tmpdir(), "onlooker-bare-"));
		const found = readEnablement({ cwd: empty, home: bareHome() });
		expect(found.kind).toBe("unknown");
	});

	it("reports unknown rather than throwing when the settings file is not JSON", () => {
		const { cwd } = project("{ this is not json");
		const found = readEnablement({ cwd, home: bareHome() });
		expect(found.kind).toBe("unknown");
		if (found.kind !== "unknown") return;
		expect(found.reason).toContain("could not be read");
	});

	it("reports unknown when the file parses but declares no enabledPlugins", () => {
		const { cwd } = project({ hooks: {} });
		expect(readEnablement({ cwd, home: bareHome() }).kind).toBe("unknown");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/enablement.test.ts`
Expected: FAIL — `Failed to resolve import "../enablement"`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/cli/src/enablement.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The marketplace whose plugins this command knows how to survey. */
const MARKETPLACE = "@onlooker-community";

/**
 * What `.claude/settings.json` says should be running.
 *
 * `unknown` is a distinct outcome rather than an empty `plugins` array because
 * the two claim different things. An empty array asserts that nothing should be
 * recording; a config we could not find or parse supports no such claim. Every
 * verdict downstream depends on this distinction - without it the command
 * reports a machine with no config as a machine with nothing wrong.
 */
export type Enablement =
	| { kind: "unknown"; reason: string }
	| { kind: "found"; plugins: string[]; source: string };

/** Nearest ancestor of `startDir` containing `relPath`, or null. */
export function findUp(startDir: string, relPath: string): string | null {
	let dir = startDir;
	for (;;) {
		const candidate = join(dir, relPath);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		// `dirname("/")` is `"/"`, so this is the root check on every platform.
		if (parent === dir) return null;
		dir = parent;
	}
}

interface Settings {
	enabledPlugins?: Record<string, boolean>;
}

function readSettings(path: string): Settings | { error: string } {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) {
			return { error: `${path} could not be read: not a JSON object` };
		}
		return parsed as Settings;
	} catch (error) {
		return { error: `${path} could not be read: ${(error as Error).message}` };
	}
}

/**
 * Merge the project's enabled set with the user's global one.
 *
 * Project wins on conflict, matching how Claude Code layers them: a repo that
 * switches a plugin off has made a decision the global default should not undo.
 */
export function readEnablement(opts: {
	cwd: string;
	home?: string;
}): Enablement {
	const home = opts.home ?? homedir();
	const projectPath = findUp(opts.cwd, join(".claude", "settings.json"));
	const globalPath = join(home, ".claude", "settings.json");

	const sources: string[] = [];
	const merged: Record<string, boolean> = {};
	const problems: string[] = [];

	for (const path of [globalPath, projectPath]) {
		if (path === null || !existsSync(path)) continue;
		const settings = readSettings(path);
		if ("error" in settings) {
			problems.push(settings.error);
			continue;
		}
		if (settings.enabledPlugins === undefined) continue;
		Object.assign(merged, settings.enabledPlugins);
		sources.push(path);
	}

	if (sources.length === 0) {
		return {
			kind: "unknown",
			reason:
				problems.length > 0
					? problems.join("; ")
					: "no .claude/settings.json declares enabledPlugins",
		};
	}

	const plugins = Object.entries(merged)
		.filter(([name, on]) => on && name.endsWith(MARKETPLACE))
		.map(([name]) => name.slice(0, -MARKETPLACE.length))
		// Sorted here rather than at render time, so every consumer of this
		// list gets the same order and no renderer has to remember to sort.
		.sort((a, b) => a.localeCompare(b));

	return { kind: "found", plugins, source: sources.join(", ") };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/enablement.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

Route through the `/commit` skill. Stage exactly:

```bash
git add apps/cli/src/enablement.ts apps/cli/src/__tests__/enablement.test.ts
```

Suggested message: `feat(cli): read which plugins this project expects to be running :mag:`

---

### Task 2: Event-log reader

**Files:**
- Create: `apps/cli/src/eventlog.ts`
- Test: `apps/cli/src/__tests__/eventlog.test.ts`

**Interfaces:**
- Consumes: `onlookerDir` from `./config`.
- Produces: `type EventScan`, `scanEvents(opts: { root: string | null; env?: NodeJS.ProcessEnv }): Promise<EventScan>`.

`EventScan` shape, relied on by Task 5:

```ts
export interface EventScan {
	lastByPrefix: Record<string, string>;
	projectKeys: string[];
	sessions: number;
	unreadable: number;
	missing: boolean;
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanEvents } from "../eventlog";

/** A temp `$ONLOOKER_DIR` holding a `logs/onlooker-events.jsonl` of `lines`. */
function withEvents(lines: unknown[]): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(tmpdir(), "onlooker-events-"));
	mkdirSync(join(dir, "logs"), { recursive: true });
	writeFileSync(
		join(dir, "logs", "onlooker-events.jsonl"),
		`${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`,
	);
	return { ONLOOKER_DIR: dir };
}

const event = (type: string, ts: string, payload: unknown = {}) => ({
	event_type: type,
	timestamp: ts,
	session_id: "s1",
	payload,
});

describe("scanEvents", () => {
	it("records the newest timestamp for each event-type prefix", async () => {
		const env = withEvents([
			event("bursar.session.recorded", "2026-08-01T00:00:00Z"),
			event("bursar.rollup.surfaced", "2026-09-02T00:00:00Z"),
			event("lineage.change.recorded", "2026-08-15T00:00:00Z"),
		]);
		const scan = await scanEvents({ root: null, env });
		expect(scan.lastByPrefix.bursar).toBe("2026-09-02T00:00:00Z");
		expect(scan.lastByPrefix.lineage).toBe("2026-08-15T00:00:00Z");
		expect(scan.missing).toBe(false);
	});

	// The project key is a join, never a guess: match session.start's
	// working_directory to the repo root, then read project_key off any event
	// those sessions produced. This is what lets the CLI stay ignorant of the
	// hashing scheme the plugins use.
	it("derives project keys from sessions rooted at the given directory", async () => {
		const root = "/repo/onlooker";
		const env = withEvents([
			{
				event_type: "session.start",
				timestamp: "2026-09-01T00:00:00Z",
				session_id: "mine",
				payload: { working_directory: `${root}/apps/cli` },
			},
			{
				event_type: "session.start",
				timestamp: "2026-09-01T00:00:00Z",
				session_id: "theirs",
				payload: { working_directory: "/repo/elsewhere" },
			},
			{
				event_type: "bursar.session.recorded",
				timestamp: "2026-09-01T00:01:00Z",
				session_id: "mine",
				payload: { project_key: "6a7678979e31" },
			},
			{
				event_type: "bursar.session.recorded",
				timestamp: "2026-09-01T00:01:00Z",
				session_id: "theirs",
				payload: { project_key: "ffffffffffff" },
			},
		]);
		const scan = await scanEvents({ root, env });
		expect(scan.projectKeys).toEqual(["6a7678979e31"]);
		expect(scan.sessions).toBe(1);
	});

	it("counts a line that will not parse instead of throwing", async () => {
		const env = withEvents([
			event("bursar.session.recorded", "2026-09-01T00:00:00Z"),
			"{ not json",
		]);
		const scan = await scanEvents({ root: null, env });
		expect(scan.unreadable).toBe(1);
		expect(scan.lastByPrefix.bursar).toBe("2026-09-01T00:00:00Z");
	});

	it("reports a missing log rather than throwing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "onlooker-noevents-"));
		const scan = await scanEvents({ root: null, env: { ONLOOKER_DIR: dir } });
		expect(scan.missing).toBe(true);
		expect(scan.lastByPrefix).toEqual({});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/eventlog.test.ts`
Expected: FAIL — `Failed to resolve import "../eventlog"`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/cli/src/eventlog.ts`:

```ts
import { createReadStream, existsSync } from "node:fs";
import { join, sep } from "node:path";
import { createInterface } from "node:readline";
import { onlookerDir } from "./config";

/**
 * What one pass over `logs/onlooker-events.jsonl` found.
 *
 * Streamed rather than read whole. The log grows at roughly 21MB a month and
 * is already 70MB; `readFileSync` would work today and stop working on a
 * machine nobody is watching, which is the failure mode this command exists to
 * catch. A full streamed pass measures 0.25s at the current size.
 */
export interface EventScan {
	/** Newest ISO timestamp per `event_type` prefix (the part before the first dot). */
	lastByPrefix: Record<string, string>;
	/** `project_key` values seen on events from sessions rooted at `root`, sorted. */
	projectKeys: string[];
	/** How many sessions started in `root`. */
	sessions: number;
	/** Lines that would not parse. Counted, never skipped silently. */
	unreadable: number;
	/** True when the log could not be opened at all. */
	missing: boolean;
}

/** True when `dir` is `root` itself or sits underneath it. */
function within(dir: unknown, root: string): boolean {
	return (
		typeof dir === "string" && (dir === root || dir.startsWith(root + sep))
	);
}

export async function scanEvents(opts: {
	root: string | null;
	env?: NodeJS.ProcessEnv;
}): Promise<EventScan> {
	const scan: EventScan = {
		lastByPrefix: {},
		projectKeys: [],
		sessions: 0,
		unreadable: 0,
		missing: false,
	};

	const path = join(onlookerDir(opts.env ?? process.env), "logs", "onlooker-events.jsonl");
	if (!existsSync(path)) {
		scan.missing = true;
		return scan;
	}

	const mine = new Set<string>();
	const keys = new Set<string>();

	let stream: ReturnType<typeof createReadStream>;
	try {
		stream = createReadStream(path, { encoding: "utf8" });
	} catch {
		// `existsSync` proves the path existed at that instant, not that it can
		// be opened - it may be a directory, or unreadable. Same contract as
		// the readdirSync guards in pipeline.ts: become a reported state.
		scan.missing = true;
		return scan;
	}

	try {
		for await (const line of createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })) {
			const trimmed = line.trim();
			if (trimmed === "") continue;

			let record: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
				record = parsed as Record<string, unknown>;
			} catch {
				scan.unreadable++;
				continue;
			}

			const type = record.event_type;
			const timestamp = record.timestamp;
			if (typeof type !== "string" || typeof timestamp !== "string") {
				scan.unreadable++;
				continue;
			}

			// ISO-8601 in a fixed zone sorts lexically, so string comparison is
			// the right comparison here and costs no date parsing per record.
			const prefix = type.split(".")[0];
			if (timestamp > (scan.lastByPrefix[prefix] ?? "")) {
				scan.lastByPrefix[prefix] = timestamp;
			}

			if (opts.root === null) continue;
			const payload = (record.payload ?? {}) as Record<string, unknown>;
			const session = record.session_id;
			if (typeof session !== "string") continue;

			if (type === "session.start" && within(payload.working_directory, opts.root)) {
				mine.add(session);
			}
			if (mine.has(session) && typeof payload.project_key === "string") {
				keys.add(payload.project_key);
			}
		}
	} catch {
		// A read error mid-stream leaves a partial scan. Reporting it as
		// unreadable keeps the counts honest rather than presenting a
		// truncated pass as a complete one.
		scan.unreadable++;
	}

	scan.sessions = mine.size;
	scan.projectKeys = [...keys].sort((a, b) => a.localeCompare(b));
	return scan;
}
```

> **Note for the implementer:** the `mine.has(session)` check only catches a
> `project_key` on an event that arrives *after* its `session.start`. That
> ordering holds in an append-only log. If a test ever fails because a
> `project_key` event precedes its session, buffer the unmatched ones rather
> than reordering the log.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/eventlog.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

Route through `/commit`. Stage exactly:

```bash
git add apps/cli/src/eventlog.ts apps/cli/src/__tests__/eventlog.test.ts
```

Suggested message: `feat(cli): stream the event log for per-stream recency :satellite:`

---

### Task 3: Hook-health reader

**Files:**
- Modify: `apps/cli/src/eventlog.ts` (append; do not alter Task 2's exports)
- Test: `apps/cli/src/__tests__/eventlog.test.ts` (append a second `describe`)

**Interfaces:**
- Consumes: `onlookerDir` from `./config`.
- Produces: `type HookScan`, `scanHooks(opts: { since: Record<string, string>; env?: NodeJS.ProcessEnv }): Promise<HookScan>`.

`HookScan` shape, relied on by Task 5:

```ts
export interface HookScan {
	hooks: Record<string, { firedSince: number; okSince: number; last: string }>;
	unreadable: number;
	missing: boolean;
}
```

**Why `since` is a parameter rather than a post-filter:** the rule needs
"firings after the output last moved," and that threshold is only known once
mtimes are read. Passing it in keeps the scan O(1) in memory instead of
retaining 199,103 timestamps.

- [ ] **Step 1: Write the failing test**

```ts
// Append to apps/cli/src/__tests__/eventlog.test.ts
import { scanHooks } from "../eventlog";

/** A temp `$ONLOOKER_DIR` holding a `logs/hook-health.jsonl` of `lines`. */
function withHooks(lines: unknown[]): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(tmpdir(), "onlooker-hooks-"));
	mkdirSync(join(dir, "logs"), { recursive: true });
	writeFileSync(
		join(dir, "logs", "hook-health.jsonl"),
		`${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`,
	);
	return { ONLOOKER_DIR: dir };
}

const firing = (hook: string, ts: string, status = "success") => ({
	hook,
	timestamp: ts,
	status,
	error: null,
});

describe("scanHooks", () => {
	// This is the bursar shape and the reason the command exists: a hook that
	// fired and succeeded the whole time its output was frozen. Measured on
	// the real machine as 73 firings, 71 successful, against zero writes.
	it("counts only firings after the given threshold", async () => {
		const env = withHooks([
			firing("bursar-session-end", "2026-08-01T00:00:00Z"),
			firing("bursar-session-end", "2026-08-20T00:00:00Z"),
			firing("bursar-session-end", "2026-08-21T00:00:00Z"),
		]);
		const scan = await scanHooks({
			since: { "bursar-session-end": "2026-08-07T00:00:00Z" },
			env,
		});
		expect(scan.hooks["bursar-session-end"].firedSince).toBe(2);
		expect(scan.hooks["bursar-session-end"].okSince).toBe(2);
		expect(scan.hooks["bursar-session-end"].last).toBe("2026-08-21T00:00:00Z");
	});

	it("separates failures from successes", async () => {
		const env = withHooks([
			firing("assayer-stop", "2026-09-01T00:00:00Z"),
			firing("assayer-stop", "2026-09-01T01:00:00Z", "failure"),
		]);
		const scan = await scanHooks({ since: {}, env });
		expect(scan.hooks["assayer-stop"].firedSince).toBe(2);
		expect(scan.hooks["assayer-stop"].okSince).toBe(1);
	});

	// A hook absent from the threshold map has no output to lag behind, so
	// every firing counts. Defaulting to "count nothing" would silently zero
	// out every stream whose table entry has no output path.
	it("counts every firing for a hook with no threshold", async () => {
		const env = withHooks([firing("lineage-post-tool-use", "2026-09-01T00:00:00Z")]);
		const scan = await scanHooks({ since: {}, env });
		expect(scan.hooks["lineage-post-tool-use"].firedSince).toBe(1);
	});

	it("reports a missing log rather than throwing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "onlooker-nohooks-"));
		const scan = await scanHooks({ since: {}, env: { ONLOOKER_DIR: dir } });
		expect(scan.missing).toBe(true);
		expect(scan.hooks).toEqual({});
	});

	it("counts a line that will not parse instead of throwing", async () => {
		const env = withHooks([firing("assayer-stop", "2026-09-01T00:00:00Z"), "nope"]);
		const scan = await scanHooks({ since: {}, env });
		expect(scan.unreadable).toBe(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/eventlog.test.ts`
Expected: FAIL — `scanHooks is not a function` / no matching export.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/cli/src/eventlog.ts`:

```ts
/**
 * What one pass over `logs/hook-health.jsonl` found, per hook.
 *
 * Only the 21 hooks that write health records appear here. This file is not a
 * registry of streams and must never be used as one: six plugins that stopped
 * on 2026-08-07 have zero records across all 199,103 entries, so "no failures"
 * would give six dead streams a clean bill.
 */
export interface HookScan {
	hooks: Record<string, { firedSince: number; okSince: number; last: string }>;
	unreadable: number;
	missing: boolean;
}

export async function scanHooks(opts: {
	/** Hook name to the ISO timestamp its output last moved. Absent means count all. */
	since: Record<string, string>;
	env?: NodeJS.ProcessEnv;
}): Promise<HookScan> {
	const scan: HookScan = { hooks: {}, unreadable: 0, missing: false };

	const path = join(onlookerDir(opts.env ?? process.env), "logs", "hook-health.jsonl");
	if (!existsSync(path)) {
		scan.missing = true;
		return scan;
	}

	let stream: ReturnType<typeof createReadStream>;
	try {
		stream = createReadStream(path, { encoding: "utf8" });
	} catch {
		scan.missing = true;
		return scan;
	}

	try {
		for await (const line of createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })) {
			const trimmed = line.trim();
			if (trimmed === "") continue;

			let record: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
				record = parsed as Record<string, unknown>;
			} catch {
				scan.unreadable++;
				continue;
			}

			const hook = record.hook;
			const timestamp = record.timestamp;
			if (typeof hook !== "string" || typeof timestamp !== "string") {
				scan.unreadable++;
				continue;
			}

			const entry = (scan.hooks[hook] ??= { firedSince: 0, okSince: 0, last: "" });
			if (timestamp > entry.last) entry.last = timestamp;

			// No threshold means nothing downstream to lag behind, so every
			// firing counts. Defaulting the other way would zero out every
			// stream whose table entry has no output path.
			const threshold = opts.since[hook];
			if (threshold !== undefined && timestamp <= threshold) continue;

			entry.firedSince++;
			if (record.status === "success") entry.okSince++;
		}
	} catch {
		scan.unreadable++;
	}

	return scan;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/eventlog.test.ts`
Expected: PASS, 9 tests (4 from Task 2, 5 new).

- [ ] **Step 5: Commit**

Route through `/commit`. Stage exactly:

```bash
git add apps/cli/src/eventlog.ts apps/cli/src/__tests__/eventlog.test.ts
```

Suggested message: `feat(cli): count hook firings since a stream last produced output :stopwatch:`

---

### Task 4: The `STREAMS` table and output freshness

**Files:**
- Create: `apps/cli/src/streams.ts`
- Test: `apps/cli/src/__tests__/streams.test.ts`

**Interfaces:**
- Consumes: `onlookerDir` from `./config`.
- Produces: `type StreamEntry`, `STREAMS`, `STALL_THRESHOLD`, `outputFreshness(entry: StreamEntry, env?: NodeJS.ProcessEnv): { mtime: string | null; unreadable: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STALL_THRESHOLD, STREAMS, outputFreshness } from "../streams";

function emptyDir(): NodeJS.ProcessEnv {
	return { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-streams-")) };
}

/** Write a file at `rel` under `$ONLOOKER_DIR` with a fixed mtime. */
function fileAt(env: NodeJS.ProcessEnv, rel: string, iso: string): void {
	const path = join(env.ONLOOKER_DIR as string, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "x");
	const when = new Date(iso);
	utimesSync(path, when, when);
}

const entryFor = (plugin: string) => {
	const found = STREAMS.find((s) => s.plugin === plugin);
	if (found === undefined) throw new Error(`no table entry for ${plugin}`);
	return found;
};

describe("STREAMS", () => {
	// The single most load-bearing line in the design. bursar/sessions is
	// input and was written daily throughout the outage; bursar/projects is
	// the analytical output and was frozen for a month. Pointing this entry at
	// the busy directory silently restores the bug the command exists to find.
	it("points bursar at its analytical output, not its busiest directory", () => {
		expect(entryFor("bursar").output).toBe(join("bursar", "projects"));
	});

	// Both write no directory at all. Treating absence as a fault would report
	// two of five enabled plugins as broken on a healthy machine.
	it("expects no directory from the plugins that write none", () => {
		expect(entryFor("ecosystem").output).toBeNull();
		expect(entryFor("inspector").output).toBeNull();
	});

	// The directory is `governance/`; the events are `governor.*`. Real
	// mismatch on disk, and the table is the only place it is reconciled.
	it("keeps the governance directory separate from the governor event prefix", () => {
		const entry = entryFor("governance");
		expect(entry.output).toBe("governance");
		expect(entry.events).toContain("governor");
	});

	it("names every plugin exactly once", () => {
		const names = STREAMS.map((s) => s.plugin);
		expect(new Set(names).size).toBe(names.length);
	});
});

describe("outputFreshness", () => {
	it("returns the newest mtime beneath the output path", () => {
		const env = emptyDir();
		fileAt(env, join("bursar", "projects", "a", "sessions.jsonl"), "2026-08-07T00:00:00Z");
		fileAt(env, join("bursar", "projects", "b", "sessions.jsonl"), "2026-07-01T00:00:00Z");
		const fresh = outputFreshness(entryFor("bursar"), env);
		expect(fresh.mtime?.slice(0, 10)).toBe("2026-08-07");
		expect(fresh.unreadable).toBe(false);
	});

	// A busy sibling must not count. This is the bursar trap in miniature.
	it("ignores files outside the declared output path", () => {
		const env = emptyDir();
		fileAt(env, join("bursar", "sessions", "today.jsonl"), "2026-09-02T00:00:00Z");
		expect(outputFreshness(entryFor("bursar"), env).mtime).toBeNull();
	});

	it("returns null for an entry that declares no output", () => {
		expect(outputFreshness(entryFor("inspector"), emptyDir()).mtime).toBeNull();
	});

	// A file where a directory belongs makes readdirSync throw ENOTDIR. This
	// is the portable way to produce an unlistable path - chmod 000 does not
	// stop root, and CI often runs as root. The walk must flag it and keep
	// going rather than take the whole command down with it.
	it("flags an output path that cannot be listed instead of throwing", () => {
		const env = emptyDir();
		// `bursar/projects` itself is the file, so listing it fails.
		fileAt(env, join("bursar", "projects"), "2026-08-07T00:00:00Z");
		const fresh = outputFreshness(entryFor("bursar"), env);
		expect(fresh.unreadable).toBe(true);
		expect(fresh.mtime).toBeNull();
	});
});

describe("STALL_THRESHOLD", () => {
	// Every stream in the table can legitimately lag its trigger by one
	// session; bursar-session-start fires before bursar-session-end writes.
	// Five clears that with margin. The real outage hit 71.
	it("sits above one session of legitimate lag", () => {
		expect(STALL_THRESHOLD).toBe(5);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/streams.test.ts`
Expected: FAIL — `Failed to resolve import "../streams"`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/cli/src/streams.ts`:

```ts
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlookerDir } from "./config";

/**
 * How many trigger firings with no output movement count as stopped.
 *
 * The design's only arbitrary number, and recorded as such. Every stream in
 * the table can legitimately lag its trigger by one session -
 * `bursar-session-start` fires at the top of a session whose output is not
 * written until `bursar-session-end`. Five clears that ordering effect without
 * modeling it per plugin, and leaves margin for a plugin that batches writes.
 * The real bursar outage reached 71.
 */
export const STALL_THRESHOLD = 5;

/**
 * One known stream: where its output lands, what it calls its events, and
 * which hooks trigger it.
 *
 * `output` is the stream's ANALYTICAL OUTPUT, never its busiest directory.
 * That distinction is the whole design. `bursar/sessions` was written daily
 * throughout the month `bursar/projects` was frozen, and every check that
 * looked at the busy directory reported a healthy machine.
 *
 * `output: null` means the stream legitimately writes no files, so absence of
 * a directory is expected rather than a fault.
 */
export interface StreamEntry {
	plugin: string;
	output: string | null;
	events: readonly string[];
	hooks: readonly string[];
}

/**
 * Every stream this CLI knows a health rule for.
 *
 * Not exhaustive, and deliberately not a closed enum. The vocabulary is owned
 * by `onlooker-community/ecosystem` and can grow without telling us; a plugin
 * missing from this table is reported by name as having no health rule, never
 * dropped and never assumed healthy.
 */
export const STREAMS: readonly StreamEntry[] = [
	{
		plugin: "archivist",
		output: "archivist",
		events: ["archivist"],
		hooks: [],
	},
	{ plugin: "assayer", output: "assayer", events: ["assayer"], hooks: ["assayer-stop"] },
	{
		plugin: "bursar",
		// NOT `bursar/sessions`. See the interface docstring.
		output: join("bursar", "projects"),
		events: ["bursar"],
		hooks: ["bursar-session-start", "bursar-session-end"],
	},
	{ plugin: "cartographer", output: "cartographer", events: ["cartographer"], hooks: [] },
	{ plugin: "compass", output: "compass", events: ["compass"], hooks: [] },
	{ plugin: "counsel", output: "counsel", events: ["counsel"], hooks: [] },
	{ plugin: "curator", output: "curator", events: ["curator"], hooks: [] },
	{ plugin: "echo", output: "echo", events: ["echo"], hooks: ["echo-stop-gate"] },
	{
		// Writes no directory of its own; its trace is the shared event log.
		plugin: "ecosystem",
		output: null,
		events: ["session", "tool", "skill", "memory", "task"],
		hooks: [
			"session-start-tracker",
			"session-end-tracker",
			"session-duration-tracker",
			"turn-tracker",
			"tool-history-tracker",
			"tool-sequence-tracker",
			"skill-usage-tracker",
			"memory-recall-tracker",
			"prompt-rule-injector",
			"agent-spawn-tracker",
			"task-tracker",
			"pre-compact-tracker",
			"context-compact-tracker",
			"worktree-tracker",
		],
	},
	{
		// The directory is `governance/`; the events are `governor.*`. This
		// table is the only place that mismatch is reconciled.
		plugin: "governance",
		output: "governance",
		events: ["governor"],
		hooks: [],
	},
	{ plugin: "historian", output: "historian", events: ["historian"], hooks: [] },
	{
		// Writes no directory of its own; its trace is the shared event log.
		plugin: "inspector",
		output: null,
		events: ["inspector"],
		hooks: ["inspector-post-write"],
	},
	{ plugin: "librarian", output: "librarian", events: ["librarian"], hooks: [] },
	{
		plugin: "lineage",
		output: "lineage",
		events: ["lineage"],
		hooks: ["lineage-post-tool-use"],
	},
	{ plugin: "scribe", output: "scribe", events: ["scribe"], hooks: [] },
	{ plugin: "tribunal", output: "tribunal", events: ["tribunal"], hooks: ["tribunal-stop-gate"] },
	{ plugin: "warden", output: "warden", events: ["warden"], hooks: [] },
];

/** Newest mtime anywhere beneath a stream's declared output path. */
export function outputFreshness(
	entry: StreamEntry,
	env: NodeJS.ProcessEnv = process.env,
): { mtime: string | null; unreadable: boolean } {
	if (entry.output === null) return { mtime: null, unreadable: false };

	const root = join(onlookerDir(env), entry.output);
	if (!existsSync(root)) return { mtime: null, unreadable: false };

	let newest = 0;
	let unreadable = false;

	// Iterative rather than recursive: a stream directory's depth is not
	// bounded by anything this CLI controls, and a diagnostic must not be the
	// thing that blows the stack on a machine that is already misbehaving.
	const queue = [root];
	while (queue.length > 0) {
		const dir = queue.pop() as string;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			// Same contract as pipeline.ts: a directory that exists but cannot
			// be listed is a finding, not something to swallow. Keep walking so
			// one bad directory does not cost the others their timestamps.
			unreadable = true;
			continue;
		}
		for (const name of entries) {
			const path = join(dir, name);
			try {
				const stat = statSync(path);
				if (stat.isDirectory()) queue.push(path);
				else if (stat.mtimeMs > newest) newest = stat.mtimeMs;
			} catch {
				unreadable = true;
			}
		}
	}

	return {
		mtime: newest === 0 ? null : new Date(newest).toISOString(),
		unreadable,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/streams.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

Route through `/commit`. Stage exactly:

```bash
git add apps/cli/src/streams.ts apps/cli/src/__tests__/streams.test.ts
```

Suggested message: `feat(cli): name each stream's analytical output, not its busiest directory :file_folder:`

---

### Task 5: Verdicts

**Files:**
- Modify: `apps/cli/src/streams.ts` (append)
- Test: `apps/cli/src/__tests__/streams.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `readEnablement`/`Enablement` (Task 1), `scanEvents`/`scanHooks` (Tasks 2–3), `STREAMS`/`outputFreshness`/`STALL_THRESHOLD` (Task 4).
- Produces: `type Verdict`, `type StreamSurvey`, `surveyStreams(opts: { cwd: string; home?: string; env?: NodeJS.ProcessEnv }): Promise<StreamSurvey>`.

```ts
export type Verdict =
	| { kind: "recording"; detail: string }
	| { kind: "stopped"; detail: string }
	| { kind: "unknown"; detail: string }
	| { kind: "no-rule" };

export interface StreamSurvey {
	enablement: Enablement;
	projectKeys: string[];
	verdicts: Array<{ plugin: string; verdict: Verdict }>;
	footer: Array<{ plugin: string; detail: string }>;
	faults: string[];
}
```

- [ ] **Step 1: Write the failing test**

```ts
// Append to apps/cli/src/__tests__/streams.test.ts
import { surveyStreams } from "../streams";

/**
 * Build a machine: a temp `$ONLOOKER_DIR` with both logs, plus a project tree
 * whose `.claude/settings.json` enables `plugins`.
 */
function machine(opts: {
	plugins: string[];
	events?: unknown[];
	hooks?: unknown[];
	files?: Array<[string, string]>;
}): { cwd: string; home: string; env: NodeJS.ProcessEnv } {
	const dir = mkdtempSync(join(tmpdir(), "onlooker-survey-"));
	mkdirSync(join(dir, "logs"), { recursive: true });
	const write = (name: string, lines: unknown[]) =>
		writeFileSync(
			join(dir, "logs", name),
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
		);
	write("onlooker-events.jsonl", opts.events ?? []);
	write("hook-health.jsonl", opts.hooks ?? []);
	for (const [rel, iso] of opts.files ?? []) fileAt({ ONLOOKER_DIR: dir }, rel, iso);

	const home = mkdtempSync(join(tmpdir(), "onlooker-survey-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "onlooker-survey-proj-"));
	mkdirSync(join(cwd, ".claude"), { recursive: true });
	writeFileSync(
		join(cwd, ".claude", "settings.json"),
		JSON.stringify({
			enabledPlugins: Object.fromEntries(
				opts.plugins.map((p) => [`${p}@onlooker-community`, true]),
			),
		}),
	);
	return { cwd, home, env: { ONLOOKER_DIR: dir } };
}

const verdictFor = (survey: Awaited<ReturnType<typeof surveyStreams>>, plugin: string) =>
	survey.verdicts.find((v) => v.plugin === plugin)?.verdict;

describe("surveyStreams", () => {
	// The case the acceptance criterion names. Busy input, stale output, hook
	// firing successfully throughout.
	it("reports a stream as stopped when its hook fires and its output does not move", async () => {
		const { cwd, home, env } = machine({
			plugins: ["bursar"],
			files: [
				[join("bursar", "projects", "k", "sessions.jsonl"), "2026-08-07T00:00:00Z"],
				[join("bursar", "sessions", "today.jsonl"), "2026-09-02T00:00:00Z"],
			],
			hooks: Array.from({ length: 20 }, (_, i) => ({
				hook: "bursar-session-end",
				timestamp: `2026-08-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
				status: "success",
			})),
		});
		const survey = await surveyStreams({ cwd, home, env });
		const verdict = verdictFor(survey, "bursar");
		expect(verdict?.kind).toBe("stopped");
		expect(verdict?.kind === "stopped" && verdict.detail).toContain("bursar-session-end");
	});

	it("reports a stream with no output path as recording when its events are recent", async () => {
		const { cwd, home, env } = machine({
			plugins: ["inspector"],
			events: [
				{
					event_type: "inspector.check.passed",
					timestamp: "2026-09-02T00:00:00Z",
					session_id: "s",
					payload: {},
				},
			],
		});
		expect(verdictFor(await surveyStreams({ cwd, home, env }), "inspector")?.kind).toBe(
			"recording",
		);
	});

	// The vocabulary is owned by another repo. A plugin we have no rule for
	// must be named, never silently dropped and never assumed healthy.
	it("names an enabled plugin that has no table entry", async () => {
		const { cwd, home, env } = machine({ plugins: ["brandnew"] });
		expect(verdictFor(await surveyStreams({ cwd, home, env }), "brandnew")?.kind).toBe(
			"no-rule",
		);
	});

	// Archivist on the real machine: holding data, deliberately not enabled.
	// Reporting it as a fault would cry wolf about a decision made on purpose.
	it("puts a stream that is writing but not enabled in the footer, not the verdicts", async () => {
		const { cwd, home, env } = machine({
			plugins: ["bursar"],
			files: [[join("archivist", "note.json"), "2026-08-07T00:00:00Z"]],
		});
		const survey = await surveyStreams({ cwd, home, env });
		expect(survey.footer.map((f) => f.plugin)).toContain("archivist");
		expect(survey.verdicts.map((v) => v.plugin)).not.toContain("archivist");
	});

	// A stream we could not measure does not get a clean bill.
	it("reports unknown when a stream has output but no hook to compare against", async () => {
		const { cwd, home, env } = machine({
			plugins: ["librarian"],
			files: [[join("librarian", "k", "x.json"), "2026-07-01T00:00:00Z"]],
		});
		expect(verdictFor(await surveyStreams({ cwd, home, env }), "librarian")?.kind).toBe(
			"unknown",
		);
	});

	it("carries the unknown enablement through rather than inventing an empty set", async () => {
		const bare = mkdtempSync(join(tmpdir(), "onlooker-noconf-"));
		const survey = await surveyStreams({
			cwd: bare,
			home: mkdtempSync(join(tmpdir(), "onlooker-nohome-")),
			env: { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-nodir-")) },
		});
		expect(survey.enablement.kind).toBe("unknown");
		expect(survey.verdicts).toEqual([]);
	});

	it("reports a missing event log as a fault instead of throwing", async () => {
		const survey = await surveyStreams({
			cwd: mkdtempSync(join(tmpdir(), "onlooker-nolog-")),
			home: mkdtempSync(join(tmpdir(), "onlooker-nolog-home-")),
			env: { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-nolog-dir-")) },
		});
		expect(survey.faults.join(" ")).toContain("onlooker-events.jsonl");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/streams.test.ts`
Expected: FAIL — `surveyStreams is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/cli/src/streams.ts` (and add the imports at the top of the file):

```ts
// At the top of streams.ts: EXTEND the existing `node:path` import rather
// than adding a second one - biome rejects two imports from the same module.
//   before: import { join } from "node:path";
//   after:  import { dirname, join } from "node:path";
// Then add these two new import lines:
import { type Enablement, findUp, readEnablement } from "./enablement";
import { scanEvents, scanHooks } from "./eventlog";

/**
 * What one stream's three sources add up to.
 *
 * `unknown` is deliberately distinct from `recording`. A stream we could not
 * measure has not earned a clean bill, and saying otherwise is the exact
 * failure this command exists to remove.
 */
export type Verdict =
	| { kind: "recording"; detail: string }
	| { kind: "stopped"; detail: string }
	| { kind: "unknown"; detail: string }
	| { kind: "no-rule" };

export interface StreamSurvey {
	enablement: Enablement;
	/** Project keys this repo's sessions produced, sorted. */
	projectKeys: string[];
	/** One entry per enabled plugin, alphabetical. */
	verdicts: Array<{ plugin: string; verdict: Verdict }>;
	/** Streams holding data on this machine that this project does not enable. */
	footer: Array<{ plugin: string; detail: string }>;
	/** Problems reading the sources themselves, as opposed to any one stream. */
	faults: string[];
}

/** Repo root for the session join: nearest ancestor holding a `.git`. */
function repoRoot(cwd: string): string | null {
	const dotGit = findUp(cwd, ".git");
	return dotGit === null ? null : dirname(dotGit);
}

export async function surveyStreams(opts: {
	cwd: string;
	home?: string;
	env?: NodeJS.ProcessEnv;
}): Promise<StreamSurvey> {
	const env = opts.env ?? process.env;
	const enablement = readEnablement({ cwd: opts.cwd, home: opts.home });
	const faults: string[] = [];

	const events = await scanEvents({ root: repoRoot(opts.cwd), env });
	if (events.missing) faults.push("logs/onlooker-events.jsonl could not be read");
	if (events.unreadable > 0) {
		faults.push(`${events.unreadable} event log line(s) could not be parsed`);
	}

	const enabled = enablement.kind === "found" ? enablement.plugins : [];
	const known = new Map(STREAMS.map((s) => [s.plugin, s]));

	// Mtimes first, so the hook scan can count firings *since* each output
	// last moved in one pass rather than retaining every timestamp.
	const freshness = new Map<string, ReturnType<typeof outputFreshness>>();
	const since: Record<string, string> = {};
	for (const plugin of enabled) {
		const entry = known.get(plugin);
		if (entry === undefined) continue;
		const fresh = outputFreshness(entry, env);
		freshness.set(plugin, fresh);
		if (fresh.mtime === null) continue;
		for (const hook of entry.hooks) since[hook] = fresh.mtime;
	}

	const hooks = await scanHooks({ since, env });
	if (hooks.missing) faults.push("logs/hook-health.jsonl could not be read");
	if (hooks.unreadable > 0) {
		faults.push(`${hooks.unreadable} hook-health line(s) could not be parsed`);
	}

	const verdicts = enabled.map((plugin) => ({
		plugin,
		verdict: judge(plugin, known.get(plugin), freshness.get(plugin), events, hooks),
	}));

	// Footer: table entries holding data that this project does not enable.
	// Restricted to table entries on purpose - without that rule the footer
	// fills with logs/, session-history/, and session-trackers/, which are
	// shared infrastructure rather than per-plugin streams, and the one line
	// that matters gets buried in a dozen that do not.
	const footer: Array<{ plugin: string; detail: string }> = [];
	for (const entry of STREAMS) {
		if (enabled.includes(entry.plugin)) continue;
		const fresh = outputFreshness(entry, env);
		if (fresh.mtime === null) continue;
		footer.push({ plugin: entry.plugin, detail: `last wrote ${fresh.mtime.slice(0, 10)}` });
	}

	return {
		enablement,
		projectKeys: events.projectKeys,
		verdicts,
		footer,
		faults,
	};
}

function judge(
	plugin: string,
	entry: StreamEntry | undefined,
	fresh: { mtime: string | null; unreadable: boolean } | undefined,
	events: Awaited<ReturnType<typeof scanEvents>>,
	hooks: Awaited<ReturnType<typeof scanHooks>>,
): Verdict {
	if (entry === undefined) return { kind: "no-rule" };

	const lastEvent = entry.events
		.map((prefix) => events.lastByPrefix[prefix] ?? "")
		.reduce((a, b) => (a > b ? a : b), "");

	if (fresh?.unreadable === true) {
		return { kind: "unknown", detail: `${entry.output} could not be fully listed` };
	}

	// No output path: there is no downstream to compare against, so the rule
	// degrades to event recency. Absence of a directory is expected here.
	if (entry.output === null) {
		return lastEvent === ""
			? { kind: "unknown", detail: "no events recorded yet" }
			: { kind: "recording", detail: `last event ${lastEvent.slice(0, 10)}` };
	}

	const outputAt = fresh?.mtime ?? null;
	if (outputAt === null) {
		return lastEvent === ""
			? { kind: "unknown", detail: "no output and no events recorded yet" }
			: { kind: "stopped", detail: `events since ${lastEvent.slice(0, 10)}, but no output written` };
	}

	// Output but no hook in hook-health: report the gap, verdict unknown.
	// Never healthy - a thing we could not measure does not get a clean bill.
	const measurable = entry.hooks.filter((h) => hooks.hooks[h] !== undefined);
	if (measurable.length === 0) {
		return {
			kind: "unknown",
			detail: `output last changed ${outputAt.slice(0, 10)}, no hook records to compare`,
		};
	}

	for (const hook of measurable) {
		const record = hooks.hooks[hook];
		if (record.firedSince >= STALL_THRESHOLD) {
			return {
				kind: "stopped",
				detail: `${hook} fired ${record.firedSince} times since ${entry.output} last changed on ${outputAt.slice(0, 10)}`,
			};
		}
	}

	return { kind: "recording", detail: `output last changed ${outputAt.slice(0, 10)}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/streams.test.ts`
Expected: PASS, 16 tests (9 from Task 4, 7 new).

- [ ] **Step 5: Commit**

Route through `/commit`. Stage exactly:

```bash
git add apps/cli/src/streams.ts apps/cli/src/__tests__/streams.test.ts
```

Suggested message: `feat(cli): judge each stream against its trigger rather than the clock :balance_scale:`

---

### Task 6: Rendering and exit code

**Files:**
- Modify: `apps/cli/src/streams.ts` (append)
- Test: `apps/cli/src/__tests__/streams.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `StreamSurvey`, `Verdict` (Task 5).
- Produces: `doctorLines(survey: StreamSurvey): string[]`, `exitCodeFor(survey: StreamSurvey): number`.

- [ ] **Step 1: Write the failing test**

```ts
// Append to apps/cli/src/__tests__/streams.test.ts
import { doctorLines, exitCodeFor } from "../streams";

const surveyOf = (over: Partial<Awaited<ReturnType<typeof surveyStreams>>> = {}) => ({
	enablement: { kind: "found" as const, plugins: [], source: "/x/.claude/settings.json" },
	projectKeys: [],
	verdicts: [],
	footer: [],
	faults: [],
	...over,
});

describe("doctorLines", () => {
	it("lists streams alphabetically regardless of input order", () => {
		const lines = doctorLines(
			surveyOf({
				verdicts: [
					{ plugin: "lineage", verdict: { kind: "recording", detail: "x" } },
					{ plugin: "assayer", verdict: { kind: "recording", detail: "y" } },
				],
			}),
		);
		const body = lines.filter((l) => l.includes("assayer") || l.includes("lineage"));
		expect(body[0]).toContain("assayer");
		expect(body[1]).toContain("lineage");
	});

	it("shouts about a stopped stream and names the layer", () => {
		const lines = doctorLines(
			surveyOf({
				verdicts: [
					{
						plugin: "bursar",
						verdict: { kind: "stopped", detail: "bursar-session-end fired 71 times" },
					},
				],
			}),
		).join("\n");
		expect(lines).toContain("STOPPED");
		expect(lines).toContain("bursar-session-end fired 71 times");
	});

	it("says it does not know rather than reporting nothing enabled", () => {
		const lines = doctorLines(
			surveyOf({ enablement: { kind: "unknown", reason: "no .claude/settings.json" } }),
		).join("\n");
		expect(lines).toContain("unknown");
		expect(lines).not.toContain("0 plugins enabled");
	});

	it("puts unenabled streams under their own heading", () => {
		const lines = doctorLines(
			surveyOf({ footer: [{ plugin: "archivist", detail: "last wrote 2026-08-07" }] }),
		).join("\n");
		expect(lines).toContain("Not enabled here");
		expect(lines).toContain("archivist");
	});
});

describe("exitCodeFor", () => {
	it("exits 0 when every enabled stream is recording", () => {
		expect(
			exitCodeFor(
				surveyOf({
					verdicts: [{ plugin: "lineage", verdict: { kind: "recording", detail: "x" } }],
				}),
			),
		).toBe(0);
	});

	it("exits 1 when a stream has stopped", () => {
		expect(
			exitCodeFor(
				surveyOf({
					verdicts: [{ plugin: "bursar", verdict: { kind: "stopped", detail: "x" } }],
				}),
			),
		).toBe(1);
	});

	// Not knowing is not the same as fine, and a retry fixes neither. Same
	// reasoning sync uses when it exits 1 on an unlistable directory.
	it("exits 1 when a source could not be read", () => {
		expect(exitCodeFor(surveyOf({ faults: ["logs/hook-health.jsonl could not be read"] }))).toBe(1);
	});

	it("exits 1 when the expected set is unknown", () => {
		expect(
			exitCodeFor(surveyOf({ enablement: { kind: "unknown", reason: "none" } })),
		).toBe(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/streams.test.ts`
Expected: FAIL — `doctorLines is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/cli/src/streams.ts`:

```ts
/** Column the detail text starts in, so every verdict reads down one edge. */
const DETAIL_COLUMN = 14;

function label(verdict: Verdict): string {
	switch (verdict.kind) {
		case "recording":
			return "recording";
		// Upper case earns its shout: this is the one line someone scanning
		// the output has to catch, and it is surrounded by lower-case rows.
		case "stopped":
			return "STOPPED";
		case "unknown":
			return "unknown";
		case "no-rule":
			return "no rule";
	}
}

function detail(verdict: Verdict): string {
	return verdict.kind === "no-rule"
		? "this CLI has no health rule for it"
		: verdict.detail;
}

export function doctorLines(survey: StreamSurvey): string[] {
	const lines: string[] = [];

	if (survey.enablement.kind === "unknown") {
		lines.push(`Expected: unknown - ${survey.enablement.reason}`);
	} else {
		const count = survey.enablement.plugins.length;
		const keys = survey.projectKeys.length > 0 ? ` - key ${survey.projectKeys.join(", ")}` : "";
		lines.push(
			`Expected: ${count} plugin${count === 1 ? "" : "s"} enabled from onlooker-community${keys}`,
		);
	}

	// Sorted here as well as in readEnablement: this renderer is exported and
	// a caller may hand it verdicts assembled some other way.
	const sorted = [...survey.verdicts].sort((a, b) => a.plugin.localeCompare(b.plugin));
	if (sorted.length > 0) lines.push("");
	for (const { plugin, verdict } of sorted) {
		const left = `  ${plugin.padEnd(DETAIL_COLUMN - 2)}${label(verdict).padEnd(11)}`;
		lines.push(`${left}${detail(verdict)}`);
	}

	if (survey.footer.length > 0) {
		lines.push("");
		lines.push("Not enabled here, but holding data on this machine:");
		for (const { plugin, detail: text } of [...survey.footer].sort((a, b) =>
			a.plugin.localeCompare(b.plugin),
		)) {
			lines.push(`  ${plugin.padEnd(DETAIL_COLUMN - 2)}${text}`);
		}
	}

	if (survey.faults.length > 0) {
		lines.push("");
		for (const fault of survey.faults) lines.push(`Fault:    ${fault}`);
	}

	return lines;
}

/**
 * 0 when everything enabled is recording, 1 otherwise.
 *
 * `cli.ts`'s existing convention: 1 means stop and go look, 2 means a retry
 * may fix it. Nothing here is transient - a stopped stream and an unreadable
 * log both need a person - so 2 is never returned.
 *
 * An unknown expected-set is also 1. Not knowing what should be running is
 * precisely the state this command exists to surface, and exiting 0 on it
 * would let a hook or CI job treat an unconfigured machine as a healthy one.
 */
export function exitCodeFor(survey: StreamSurvey): number {
	if (survey.enablement.kind === "unknown") return 1;
	if (survey.faults.length > 0) return 1;
	return survey.verdicts.some(
		(v) => v.verdict.kind === "stopped" || v.verdict.kind === "unknown",
	)
		? 1
		: 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/streams.test.ts`
Expected: PASS, 24 tests (16 prior, 8 new).

- [ ] **Step 5: Commit**

Route through `/commit`. Stage exactly:

```bash
git add apps/cli/src/streams.ts apps/cli/src/__tests__/streams.test.ts
```

Suggested message: `feat(cli): render stream verdicts and earn an exit code :bar_chart:`

---

### Task 7: The `doctor` command and its wiring

**Files:**
- Create: `apps/cli/src/commands/doctor.ts`
- Modify: `apps/cli/src/cli.ts` (USAGE string and the dispatch chain)
- Test: `apps/cli/src/__tests__/doctor.test.ts`
- Test: `apps/cli/src/__tests__/cli.test.ts` (append one test)

**Interfaces:**
- Consumes: `surveyStreams`, `doctorLines`, `exitCodeFor` (Tasks 5–6).
- Produces: `doctor(deps: DoctorDeps): Promise<{ text: string; code: number }>`.

**Why the return shape changes:** every other command returns a string and
`run` returns `0`. A stopped stream is not an exception, so `doctor` has to
carry its exit code back rather than throw one.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctor } from "../commands/doctor";

function bareMachine(): { cwd: string; home: string; env: NodeJS.ProcessEnv } {
	const dir = mkdtempSync(join(tmpdir(), "onlooker-doc-"));
	mkdirSync(join(dir, "logs"), { recursive: true });
	writeFileSync(join(dir, "logs", "onlooker-events.jsonl"), "");
	writeFileSync(join(dir, "logs", "hook-health.jsonl"), "");
	const cwd = mkdtempSync(join(tmpdir(), "onlooker-doc-proj-"));
	mkdirSync(join(cwd, ".claude"), { recursive: true });
	writeFileSync(
		join(cwd, ".claude", "settings.json"),
		JSON.stringify({ enabledPlugins: { "inspector@onlooker-community": true } }),
	);
	return { cwd, home: mkdtempSync(join(tmpdir(), "onlooker-doc-home-")), env: { ONLOOKER_DIR: dir } };
}

describe("doctor", () => {
	it("returns rendered text and an exit code together", async () => {
		const { cwd, home, env } = bareMachine();
		const result = await doctor({ cwd, home, env });
		expect(typeof result.text).toBe("string");
		expect([0, 1]).toContain(result.code);
		expect(result.text).toContain("Expected:");
	});

	// The contract that matters most: this is the command someone runs
	// because the machine is broken, so it must survive the broken machine.
	it("does not throw when nothing exists at all", async () => {
		const empty = mkdtempSync(join(tmpdir(), "onlooker-doc-none-"));
		await expect(
			doctor({
				cwd: empty,
				home: mkdtempSync(join(tmpdir(), "onlooker-doc-nohome-")),
				env: { ONLOOKER_DIR: empty },
			}),
		).resolves.toBeDefined();
	});

	it("exits 1 when it cannot tell what should be running", async () => {
		const empty = mkdtempSync(join(tmpdir(), "onlooker-doc-unknown-"));
		const result = await doctor({
			cwd: empty,
			home: mkdtempSync(join(tmpdir(), "onlooker-doc-unknown-home-")),
			env: { ONLOOKER_DIR: empty },
		});
		expect(result.code).toBe(1);
	});
});
```

And append to `apps/cli/src/__tests__/cli.test.ts`, inside the existing `describe("run")`:

```ts
	it("lists doctor in the usage text", async () => {
		await invoke("--help");
		expect(out.join("\n")).toContain("onlooker doctor");
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/doctor.test.ts src/__tests__/cli.test.ts`
Expected: FAIL — `Failed to resolve import "../commands/doctor"`, and the usage assertion fails.

- [ ] **Step 3: Write minimal implementation**

Create `apps/cli/src/commands/doctor.ts`:

```ts
import { doctorLines, exitCodeFor, surveyStreams } from "../streams";

export interface DoctorDeps {
	/** Where to start looking for `.claude/settings.json` and the repo root. */
	cwd?: string;
	/** Overridable so tests never read the developer's real home. */
	home?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * Which enabled streams are still recording, and which have stopped.
 *
 * Returns its exit code rather than throwing one. A stopped stream is a
 * finding, not an error: the report is the whole point, and throwing would
 * discard it in favor of a one-line message.
 */
export async function doctor(
	deps: DoctorDeps = {},
): Promise<{ text: string; code: number }> {
	const survey = await surveyStreams({
		cwd: deps.cwd ?? process.cwd(),
		home: deps.home,
		env: deps.env,
	});
	return { text: doctorLines(survey).join("\n"), code: exitCodeFor(survey) };
}
```

Then modify `apps/cli/src/cli.ts`. Add the import beside the others:

```ts
import { doctor } from "./commands/doctor";
```

Extend `USAGE` (keep the existing alignment):

```ts
export const USAGE = `onlooker - push approved lessons to app.onlooker.dev

  onlooker link     connect this machine with a token from the Machines page
  onlooker sync     push every approved lesson
  onlooker status   what is linked, and what is waiting
  onlooker doctor   which plugin streams are still recording
`;
```

Add the branch before the `--help` branch:

```ts
		} else if (command === "doctor") {
			// The only command that returns its own exit code. A stopped
			// stream is a finding rather than an exception, so it cannot
			// travel out through the catch below without losing the report.
			const report = await doctor({});
			console.log(report.text);
			return report.code;
		} else if (
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @onlooker/cli exec vitest run`
Expected: PASS — the full CLI suite, 110 prior tests plus the new ones.

- [ ] **Step 5: Full gates**

```bash
pnpm typecheck
pnpm lint
./node_modules/.bin/turbo run test --force
```

Expected: typecheck 11/11, lint 12/12 with `apps/cli` at **zero** warnings (the repo-wide baseline is 36 pre-existing warnings across `lesson-contract`, `auth-react`, `web`, and `api` — `apps/cli` must stay clean), tests 14/14.

- [ ] **Step 6: Exercise it against the real machine**

```bash
pnpm --filter @onlooker/cli build
node apps/cli/dist/onlooker.mjs doctor; echo "exit=$?"
```

Expected: five plugins listed (`assayer`, `bursar`, `ecosystem`, `inspector`, `lineage`), a footer naming `archivist` and the other streams holding data, and an exit code consistent with the verdicts. **This is a check, not a test** — if bursar now reads `recording` that is correct, since the outage was repaired on 2026-09-01.

- [ ] **Step 7: Commit**

Route through `/commit`. Stage exactly:

```bash
git add apps/cli/src/commands/doctor.ts apps/cli/src/cli.ts \
        apps/cli/src/__tests__/doctor.test.ts apps/cli/src/__tests__/cli.test.ts
```

Suggested message: `feat(cli): add doctor, which says whether the arena is still recording :stethoscope:`

---

## After the plan

1. `bd close onlooker-jy1` with a close reason recording the threshold choice and any divergence from the spec.
2. Open a PR from `feat/stream-staleness-detection`. Do **not** push to `main` — this repo's rulesets do not block it, so it has to be habit.
3. File a follow-up bead if the three-axis version proves thin, for the deferred per-stream event semantics (`bursar.rollup.skipped` × 4,739 is a stall spelled as thousands of successes).
