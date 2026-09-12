# Lesson Round Trip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `onlooker sync` pushes approved lessons as it does today, then reads the hosted delta and mirrors it to a CLI-owned directory, so a lesson approved on one machine can arrive on another.

**Architecture:** A pool store (`apps/cli/src/pool.ts`) owns the on-disk mirror and the cursor. A delta client method fetches one window. A pull orchestrator walks windows, checks `seq` contiguity, and advances the cursor only after each window is written. `sync` calls the orchestrator after its push.

**Tech Stack:** TypeScript, Vitest, Node `fs`.

**Spec:** `docs/superpowers/specs/2026-09-11-lesson-round-trip-design.md`. **Bead:** `onlooker-8zv8`.

## Global Constraints

Every task's requirements implicitly include these. They come from the spec and are decisions, not preferences.

- **The cursor advances only after the window it describes is durably on disk.** Never before it, never in the same step. This is the design's central rule; `ecosystem-449.55` is the same bug one layer down.
- **A gap stops the run and leaves the cursor unmoved.** Never reset to zero and re-mirror — that hides the one anomaly `seq` exists to expose.
- **Upsert by id.** The server explicitly expects this client (`apps/api/src/db/lessons.ts:326`). The same id arriving twice must leave one file.
- **Received lessons are validated with `ZLesson` before being written**, the same schema `parseLesson` applies on the way out. A lesson that fails is reported and skipped, never written.
- **The mirror is CLI-owned** — `~/.onlooker/pool/`. Never write into librarian's tree.
- **A pull failure is non-fatal to a push that already succeeded, and is never silent.**
- **Nothing reads the mirror yet.** That is accepted and stated; sync reports arrival counts every run so an empty mirror reads as empty rather than as silence.
- Run tests with `pnpm --filter @onlooker/cli test`.

## File Structure

| File | Responsibility |
|---|---|
| `apps/cli/src/pool.ts` (new) | The on-disk mirror and the cursor. Knows paths, upserts a lesson, reads and writes the cursor. Knows nothing about HTTP. |
| `apps/cli/src/api.ts` (modify) | Gains `readDelta`. Transport only, as it is for `push` and `reportInventory`. |
| `apps/cli/src/pull.ts` (new) | Walks windows, enforces contiguity, enforces the cursor rule. Knows nothing about where files go beyond calling the store. |
| `apps/cli/src/commands/sync.ts` (modify) | Calls the orchestrator after the push and folds its outcome into the report. |

The split matters: the cursor rule lives in `pull.ts` and is testable without a filesystem *or* a network by injecting the store and the client, and the traversal-safety property lives in `pool.ts` where the filename is constructed.

---

### Task 1: The pool store

**Files:**
- Create: `apps/cli/src/pool.ts`
- Create: `apps/cli/src/__tests__/pool.test.ts`

**Interfaces:**
- Consumes: `onlookerDir` from `apps/cli/src/config.ts`.
- Produces:

```ts
export function poolDir(env?: NodeJS.ProcessEnv): string;
export function cursorPath(env?: NodeJS.ProcessEnv): string;
export function readCursor(env?: NodeJS.ProcessEnv): number;
export function writeCursor(seq: number, env?: NodeJS.ProcessEnv): void;
export type PoolWrite = "created" | "updated" | "unchanged";
export function writeLesson(lesson: TLesson, env?: NodeJS.ProcessEnv): PoolWrite;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/src/__tests__/pool.test.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cursorPath, poolDir, readCursor, writeCursor, writeLesson } from "../pool";

const ID = "01KZ45MKAM734ZS7JK24D2DK0R";
const OTHER = "01KZ45MKAM734ZS7JK24D2DK0S";

function env(): NodeJS.ProcessEnv {
	return { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-pool-")) };
}

/** A lesson the contract accepts. Fields beyond id are not what these assert. */
const lesson = (id: string, claim = "because it was measured") =>
	JSON.parse(
		JSON.stringify({
			schema_version: 1,
			id,
			claim,
			evidence: [],
			applies_to: {},
			status: "promoted",
		}),
	);

describe("readCursor", () => {
	// A machine that has never pulled starts at the beginning rather than
	// skipping whatever exists - 0 is "send me everything".
	it("is 0 before anything has been pulled", () => {
		expect(readCursor(env())).toBe(0);
	});

	it("round-trips through writeCursor", () => {
		const e = env();
		writeCursor(42, e);
		expect(readCursor(e)).toBe(42);
	});

	// A cursor we cannot read is not a cursor of 0. Re-pulling from the
	// beginning is safe, but silently doing it hides a corrupt file.
	it("throws rather than resetting when the cursor file is unreadable", () => {
		const e = env();
		writeCursor(7, e);
		writeFileSync(cursorPath(e), "{ not json");
		expect(() => readCursor(e)).toThrow();
	});
});

describe("writeLesson", () => {
	it("writes one file per lesson, named by id", () => {
		const e = env();
		writeLesson(lesson(ID), e);
		const written = JSON.parse(
			readFileSync(join(poolDir(e), `${ID}.json`), "utf8"),
		);
		expect(written.id).toBe(ID);
	});

	it("reports created, then unchanged, then updated", () => {
		const e = env();
		expect(writeLesson(lesson(ID), e)).toBe("created");
		expect(writeLesson(lesson(ID), e)).toBe("unchanged");
		expect(writeLesson(lesson(ID, "because it changed"), e)).toBe("updated");
	});

	// Upsert by id: the server sends a changed lesson twice in one window and
	// expects the later one to win, not to accumulate.
	it("leaves one file when the same id arrives twice", () => {
		const e = env();
		writeLesson(lesson(ID), e);
		writeLesson(lesson(ID, "because it changed"), e);
		const written = JSON.parse(
			readFileSync(join(poolDir(e), `${ID}.json`), "utf8"),
		);
		expect(written.claim).toBe("because it changed");
	});

	it("keeps separate ids separate", () => {
		const e = env();
		writeLesson(lesson(ID), e);
		writeLesson(lesson(OTHER), e);
		expect(readFileSync(join(poolDir(e), `${OTHER}.json`), "utf8")).toContain(
			OTHER,
		);
	});

	// The filename comes from server-supplied data, so the id is validated
	// before it is ever joined to a path. ZUlid is [0-9A-HJKMNP-TV-Z]{26},
	// which cannot contain a separator or a dot - but the check is explicit
	// rather than inherited, because a future contract change must fail here
	// rather than escape the directory.
	it("refuses a lesson whose id is not a ULID", () => {
		const e = env();
		expect(() => writeLesson(lesson("../../etc/passwd"), e)).toThrow();
		expect(() => writeLesson(lesson("nope"), e)).toThrow();
	});

	it("creates the pool directory if it does not exist", () => {
		const e = env();
		expect(() => writeLesson(lesson(ID), e)).not.toThrow();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @onlooker/cli test -- pool`
Expected: FAIL — `Cannot find module '../pool'`.

- [ ] **Step 3: Implement `apps/cli/src/pool.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { onlookerDir } from "./config";

/** ULID in Crockford base32, mirroring ZUlid in the lesson contract. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * This machine's copy of the hosted pool.
 *
 * CLI-owned, deliberately not inside librarian's tree. A received lesson has
 * no project key, and sync reads librarian's `approved/` to decide what to
 * push - so a mirror written there would feed itself back.
 */
export function poolDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(onlookerDir(env), "pool");
}

export function cursorPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(poolDir(env), "cursor.json");
}

/**
 * The highest sequence this machine has durably written, or 0.
 *
 * A missing file is the first-run case and means "send me everything".
 * Anything else - malformed JSON, a permissions problem - throws, because
 * quietly restarting from 0 would re-download the world and call a corrupt
 * file a fresh machine.
 */
export function readCursor(env: NodeJS.ProcessEnv = process.env): number {
	const path = cursorPath(env);
	if (!existsSync(path)) return 0;

	const parsed = JSON.parse(readFileSync(path, "utf8")) as { seq?: unknown };
	if (typeof parsed.seq !== "number" || !Number.isInteger(parsed.seq)) {
		throw new Error(`${path} does not hold an integer seq`);
	}
	return parsed.seq;
}

export function writeCursor(
	seq: number,
	env: NodeJS.ProcessEnv = process.env,
): void {
	mkdirSync(poolDir(env), { recursive: true });
	atomicWrite(cursorPath(env), JSON.stringify({ seq }, null, 2));
}

export type PoolWrite = "created" | "updated" | "unchanged";

/**
 * Upsert one lesson by id.
 *
 * `unchanged` is distinguished from `updated` so sync can say how much of a
 * window was actually new. The server sends a lesson again whenever anything
 * about it changed, and re-sends the whole window after an interrupted run,
 * so most arrivals on a healthy machine are unchanged.
 */
export function writeLesson(
	lesson: TLesson,
	env: NodeJS.ProcessEnv = process.env,
): PoolWrite {
	// Validated before the id is joined to a path. The contract already
	// constrains it, but this is the place where a filename is built from
	// server-supplied data, so the constraint is asserted here rather than
	// assumed from a schema two packages away.
	if (!ULID.test(lesson.id)) {
		throw new Error(`refusing to write a lesson whose id is not a ULID: ${lesson.id}`);
	}

	const dir = poolDir(env);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${lesson.id}.json`);
	const next = `${JSON.stringify(lesson, null, 2)}\n`;

	if (existsSync(path)) {
		if (readFileSync(path, "utf8") === next) return "unchanged";
		atomicWrite(path, next);
		return "updated";
	}

	atomicWrite(path, next);
	return "created";
}

/**
 * Write via a temp file and rename.
 *
 * A half-written lesson is invalid JSON, and a half-written cursor is worse -
 * it is a number nobody can trust. Rename is atomic within a directory, so a
 * reader sees either the old content or the new one.
 */
function atomicWrite(path: string, contents: string): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, contents);
	renameSync(tmp, path);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @onlooker/cli test -- pool`
Expected: PASS, all ten.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/pool.ts apps/cli/src/__tests__/pool.test.ts
git commit -m "feat(cli): give received lessons somewhere of their own to land :inbox_tray:"
```

---

### Task 2: The delta client

**Files:**
- Modify: `apps/cli/src/api.ts`
- Modify: `apps/cli/src/__tests__/api.test.ts`

**Interfaces:**
- Consumes: the existing `call` helper in `api.ts`.
- Produces:

```ts
export interface DeltaEntry {
	seq: number;
	lesson: unknown;
}

export interface DeltaResponse {
	lessons: DeltaEntry[];
	cursor: number;
	has_more: boolean;
}

// on ApiClient:
readDelta(since: number, limit: number): Promise<DeltaResponse>;
```

- [ ] **Step 1: Write the failing tests**

Add to `apps/cli/src/__tests__/api.test.ts`:

```ts
describe("readDelta", () => {
	it("asks the machine-side route with the cursor and limit", async () => {
		let seen = "";
		const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
			seen = url;
			return {
				ok: true,
				status: 200,
				json: async () => ({ lessons: [], cursor: 7, has_more: false }),
			};
		});

		await createClient("https://api.test", "tok", fetchImpl).readDelta(7, 50);

		// GET /lessons, not /api/lessons - the browser route would reject a
		// machine token, the same distinction `verify` documents.
		expect(seen).toBe("https://api.test/lessons?since=7&limit=50");
	});

	it("returns the window verbatim", async () => {
		const body = {
			lessons: [{ seq: 8, lesson: { id: "01KZ45MKAM734ZS7JK24D2DK0R" } }],
			cursor: 8,
			has_more: true,
		};
		const fetchImpl = vi
			.fn()
			.mockResolvedValue({ ok: true, status: 200, json: async () => body });

		const got = await createClient("https://api.test", "tok", fetchImpl).readDelta(7, 50);

		expect(got).toEqual(body);
	});

	it("classifies a failure like every other call", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			json: async () => ({ error: "invalid_token" }),
		});

		await expect(
			createClient("https://api.test", "tok", fetchImpl).readDelta(0, 50),
		).rejects.toMatchObject({ kind: "rejected" });
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @onlooker/cli test -- api`
Expected: FAIL — `readDelta is not a function`.

- [ ] **Step 3: Add the method**

In `api.ts`, extend the interface and the returned object:

```ts
export interface DeltaEntry {
	seq: number;
	lesson: unknown;
}

export interface DeltaResponse {
	lessons: DeltaEntry[];
	cursor: number;
	has_more: boolean;
}
```

```ts
	/** One window of the machine-side delta, oldest first. */
	readDelta(since: number, limit: number): Promise<DeltaResponse>;
```

```ts
		readDelta: (since, limit) =>
			call<DeltaResponse>(`/lessons?since=${since}&limit=${limit}`),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @onlooker/cli test -- api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/api.ts apps/cli/src/__tests__/api.test.ts
git commit -m "feat(cli): give the delta read its first caller :satellite_antenna:"
```

---

### Task 3: The pull orchestrator

This is the task the design rests on. Its tests are the design's central claims.

**Files:**
- Create: `apps/cli/src/pull.ts`
- Create: `apps/cli/src/__tests__/pull.test.ts`

**Interfaces:**
- Consumes: `ApiClient.readDelta` (Task 2), the pool store (Task 1), `ZLesson` from `@onlooker-community/lesson-contract`.
- Produces:

```ts
export type PullOutcome =
	| {
			kind: "received";
			created: number;
			updated: number;
			unchanged: number;
			invalid: string[];
			cursor: number;
	  }
	| { kind: "gap"; expected: number; got: number; cursor: number }
	| { kind: "failed"; reason: string; cursor: number };

export function pull(opts: {
	client: Pick<ApiClient, "readDelta">;
	env?: NodeJS.ProcessEnv;
	limit?: number;
}): Promise<PullOutcome>;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/src/__tests__/pull.test.ts`:

```ts
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { poolDir, readCursor, writeCursor } from "../pool";
import { pull } from "../pull";

const ids = [
	"01KZ45MKAM734ZS7JK24D2DK0R",
	"01KZ45MKAM734ZS7JK24D2DK0S",
	"01KZ45MKAM734ZS7JK24D2DK0T",
];

function env(): NodeJS.ProcessEnv {
	return { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-pull-")) };
}

const lesson = (id: string, claim = "because it was measured") => ({
	schema_version: 1,
	id,
	claim,
	evidence: [],
	applies_to: {},
	status: "promoted",
});

/** A client answering fixed windows in order. */
const windows = (...pages: Array<{ lessons: Array<{ seq: number; lesson: unknown }>; has_more: boolean }>) => {
	let call = 0;
	return {
		readDelta: vi.fn().mockImplementation(async () => {
			const page = pages[call++] ?? { lessons: [], has_more: false };
			return {
				lessons: page.lessons,
				cursor: page.lessons.at(-1)?.seq ?? 0,
				has_more: page.has_more,
			};
		}),
	};
};

describe("pull", () => {
	it("writes what arrives and advances the cursor", async () => {
		const e = env();
		const client = windows({
			lessons: [
				{ seq: 1, lesson: lesson(ids[0]) },
				{ seq: 2, lesson: lesson(ids[1]) },
			],
			has_more: false,
		});

		const outcome = await pull({ client, env: e });

		expect(outcome).toMatchObject({ kind: "received", created: 2, cursor: 2 });
		expect(readdirSync(poolDir(e)).filter((f) => f.endsWith(".json"))).toHaveLength(3); // 2 lessons + cursor
		expect(readCursor(e)).toBe(2);
	});

	it("starts from the stored cursor, not from zero", async () => {
		const e = env();
		writeCursor(5, e);
		const client = windows({ lessons: [], has_more: false });

		await pull({ client, env: e });

		expect(client.readDelta).toHaveBeenCalledWith(5, expect.any(Number));
	});

	it("follows has_more across windows", async () => {
		const e = env();
		const client = windows(
			{ lessons: [{ seq: 1, lesson: lesson(ids[0]) }], has_more: true },
			{ lessons: [{ seq: 2, lesson: lesson(ids[1]) }], has_more: false },
		);

		const outcome = await pull({ client, env: e });

		expect(client.readDelta).toHaveBeenCalledTimes(2);
		expect(outcome).toMatchObject({ kind: "received", created: 2, cursor: 2 });
	});

	// THE CENTRAL CLAIM. A window that fails to write must leave the cursor
	// where it was, so the next run re-fetches it. The inverse - advancing
	// first - is ecosystem-449.55 one layer down, and its failure is silent.
	it("leaves the cursor unmoved when writing a window fails", async () => {
		const e = env();
		writeCursor(3, e);
		// A file where the pool directory belongs makes every write fail.
		writeFileSync(join(e.ONLOOKER_DIR as string, "pool"), "");
		const client = windows({
			lessons: [{ seq: 4, lesson: lesson(ids[0]) }],
			has_more: false,
		});

		const outcome = await pull({ client, env: e });

		expect(outcome.kind).toBe("failed");
		expect(outcome.cursor).toBe(3);
	});

	it("advances per window, so an interrupted run keeps its progress", async () => {
		const e = env();
		let call = 0;
		const client = {
			readDelta: vi.fn().mockImplementation(async () => {
				call += 1;
				if (call === 1) {
					return {
						lessons: [{ seq: 1, lesson: lesson(ids[0]) }],
						cursor: 1,
						has_more: true,
					};
				}
				throw new Error("network died");
			}),
		};

		const outcome = await pull({ client, env: e });

		expect(outcome.kind).toBe("failed");
		// The first window was written, so its progress is kept.
		expect(readCursor(e)).toBe(1);
	});

	// seq is dense - MAX+1 behind a unique index, collisions retried, no
	// delete path - so a hole means a row that should exist did not come back.
	it("stops on a gap and does not advance", async () => {
		const e = env();
		const client = windows({
			lessons: [
				{ seq: 1, lesson: lesson(ids[0]) },
				{ seq: 3, lesson: lesson(ids[1]) },
			],
			has_more: false,
		});

		const outcome = await pull({ client, env: e });

		expect(outcome).toMatchObject({ kind: "gap", expected: 2, got: 3, cursor: 0 });
		expect(readCursor(e)).toBe(0);
	});

	it("detects a gap against the stored cursor, not only within a window", async () => {
		const e = env();
		writeCursor(10, e);
		const client = windows({
			lessons: [{ seq: 12, lesson: lesson(ids[0]) }],
			has_more: false,
		});

		const outcome = await pull({ client, env: e });

		expect(outcome).toMatchObject({ kind: "gap", expected: 11, got: 12 });
	});

	// Never re-mirror from zero. That would paper over the anomaly seq exists
	// to expose and look like a slow but healthy run.
	it("does not restart from zero after a gap", async () => {
		const e = env();
		writeCursor(10, e);
		const client = windows({
			lessons: [{ seq: 12, lesson: lesson(ids[0]) }],
			has_more: false,
		});

		await pull({ client, env: e });

		expect(client.readDelta).toHaveBeenCalledTimes(1);
		expect(client.readDelta).toHaveBeenCalledWith(10, expect.any(Number));
	});

	it("reports a lesson the contract refuses rather than writing it", async () => {
		const e = env();
		const client = windows({
			lessons: [
				{ seq: 1, lesson: { id: "not-a-ulid", claim: "x" } },
				{ seq: 2, lesson: lesson(ids[1]) },
			],
			has_more: false,
		});

		const outcome = await pull({ client, env: e });

		expect(outcome).toMatchObject({ kind: "received", created: 1 });
		if (outcome.kind !== "received") return;
		expect(outcome.invalid).toHaveLength(1);
		// The valid lesson beside it still landed, and the cursor still moved:
		// one bad row must not wedge the mirror forever.
		expect(readCursor(e)).toBe(2);
	});

	it("counts an unchanged re-send as unchanged", async () => {
		const e = env();
		const first = windows({
			lessons: [{ seq: 1, lesson: lesson(ids[0]) }],
			has_more: false,
		});
		await pull({ client: first, env: e });

		writeCursor(0, e);
		const again = windows({
			lessons: [{ seq: 1, lesson: lesson(ids[0]) }],
			has_more: false,
		});
		const outcome = await pull({ client: again, env: e });

		expect(outcome).toMatchObject({ kind: "received", created: 0, unchanged: 1 });
	});

	it("is a no-op when nothing is waiting", async () => {
		const e = env();
		writeCursor(4, e);
		const client = windows({ lessons: [], has_more: false });

		const outcome = await pull({ client, env: e });

		expect(outcome).toMatchObject({ kind: "received", created: 0, cursor: 4 });
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @onlooker/cli test -- pull`
Expected: FAIL — `Cannot find module '../pull'`.

- [ ] **Step 3: Implement `apps/cli/src/pull.ts`**

```ts
import { ZLesson } from "@onlooker-community/lesson-contract";
import type { ApiClient } from "./api";
import { readCursor, writeCursor, writeLesson } from "./pool";

/** One window per request. The server clamps its own maximum. */
const DEFAULT_LIMIT = 100;

export type PullOutcome =
	| {
			kind: "received";
			created: number;
			updated: number;
			unchanged: number;
			invalid: string[];
			cursor: number;
	  }
	| { kind: "gap"; expected: number; got: number; cursor: number }
	| { kind: "failed"; reason: string; cursor: number };

/**
 * Mirror the hosted delta to disk, one window at a time.
 *
 * Two rules carry this function, and both are about what happens when it does
 * not finish.
 *
 * The cursor advances only after the window it describes is durably written.
 * Advancing first is `ecosystem-449.55` one layer down - librarian's watermark
 * moves through an outage and the skipped artifacts are never re-scanned -
 * and the failure is invisible, because the watermark is the thing claiming
 * everything is fine. Re-fetching a window costs one redundant request and is
 * otherwise free, since writes upsert by id.
 *
 * A gap stops the run and leaves the cursor. `seq` is dense, so a hole means a
 * row that should exist did not come back. Restarting from zero would hide
 * exactly the anomaly `seq` exists to expose.
 */
export async function pull(opts: {
	client: Pick<ApiClient, "readDelta">;
	env?: NodeJS.ProcessEnv;
	limit?: number;
}): Promise<PullOutcome> {
	const env = opts.env ?? process.env;
	const limit = opts.limit ?? DEFAULT_LIMIT;

	let cursor: number;
	try {
		cursor = readCursor(env);
	} catch (error) {
		return { kind: "failed", reason: (error as Error).message, cursor: 0 };
	}

	let created = 0;
	let updated = 0;
	let unchanged = 0;
	const invalid: string[] = [];

	for (;;) {
		let window: Awaited<ReturnType<ApiClient["readDelta"]>>;
		try {
			window = await opts.client.readDelta(cursor, limit);
		} catch (error) {
			return { kind: "failed", reason: (error as Error).message, cursor };
		}

		// Contiguity is checked against the cursor as well as within the
		// window, so a hole at the seam between two runs is caught too.
		let expected = cursor + 1;
		for (const entry of window.lessons) {
			if (entry.seq !== expected) {
				return { kind: "gap", expected, got: entry.seq, cursor };
			}
			expected += 1;
		}

		try {
			for (const entry of window.lessons) {
				const parsed = ZLesson.safeParse(entry.lesson);
				if (!parsed.success) {
					// Recorded, skipped, and not fatal. A row the contract
					// refuses must not wedge the mirror behind it forever -
					// the cursor still moves past it.
					invalid.push(
						`seq ${entry.seq}: ${parsed.error.issues[0]?.message ?? "did not match the lesson contract"}`,
					);
					continue;
				}
				switch (writeLesson(parsed.data, env)) {
					case "created":
						created += 1;
						break;
					case "updated":
						updated += 1;
						break;
					default:
						unchanged += 1;
				}
			}
		} catch (error) {
			return { kind: "failed", reason: (error as Error).message, cursor };
		}

		if (window.lessons.length === 0) break;

		// Only now. Everything this window described is on disk.
		const advanced = window.lessons[window.lessons.length - 1].seq;
		try {
			writeCursor(advanced, env);
		} catch (error) {
			return { kind: "failed", reason: (error as Error).message, cursor };
		}
		cursor = advanced;

		if (!window.has_more) break;
	}

	return { kind: "received", created, updated, unchanged, invalid, cursor };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @onlooker/cli test -- pull`
Expected: PASS, all twelve.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/pull.ts apps/cli/src/__tests__/pull.test.ts
git commit -m "feat(cli): walk the delta without ever getting ahead of the disk :footprints:"
```

---

### Task 4: Wire it into sync

**Files:**
- Modify: `apps/cli/src/commands/sync.ts`
- Modify: `apps/cli/src/__tests__/sync.test.ts`

**Interfaces:**
- Consumes: `pull` (Task 3).
- Produces: no new exports; `sync`'s returned message gains a received line.

- [ ] **Step 1: Write the failing tests**

Add to `apps/cli/src/__tests__/sync.test.ts`:

```ts
describe("sync receives as well as pushes", () => {
	it("pulls after pushing", async () => {
		const env = withPlugins(linked(), ["librarian@onlooker-community"]);
		withLessons(env, 1);
		const fetchImpl = vi.fn().mockImplementation(async (url, init) => {
			const path = String(url);
			if (path.endsWith("/machine/inventory")) {
				return { ok: true, status: 200, json: async () => ({ ok: true }) };
			}
			if (path.includes("/lessons?since=")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({ lessons: [], cursor: 0, has_more: false }),
				};
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({
					results: JSON.parse(init.body).lessons.map((l: { id: string }) => ({
						id: l.id,
						outcome: "created",
					})),
				}),
			};
		});

		await sync({ env, fetchImpl });

		const order = fetchImpl.mock.calls.map(([url]) => {
			const p = String(url);
			if (p.endsWith("/machine/inventory")) return "inventory";
			return p.includes("since=") ? "pull" : "push";
		});
		expect(order).toEqual(["inventory", "push", "pull"]);
	});

	it("says how many lessons arrived", async () => {
		const env = withPlugins(linked(), ["librarian@onlooker-community"]);
		const arrival = {
			schema_version: 1,
			id: "01KZ45MKAM734ZS7JK24D2DK0R",
			claim: "because it was measured",
			evidence: [],
			applies_to: {},
			status: "promoted",
		};
		const fetchImpl = routed({
			pull: {
				ok: true,
				status: 200,
				json: async () => ({
					lessons: [{ seq: 1, lesson: arrival }],
					cursor: 1,
					has_more: false,
				}),
			},
		});

		const message = await sync({ env, fetchImpl });

		expect(message).toMatch(/received 1 lesson/i);
		expect(message).toMatch(/1 new/i);
	});

	// The push is what someone ran the command for; a later step must not
	// erase its result.
	it("still reports a successful push when the pull fails", async () => {
		const env = withPlugins(linked(), ["librarian@onlooker-community"]);
		withLessons(env, 1);
		const fetchImpl = routed({
			pull: { ok: false, status: 500, json: async () => ({ error: "boom" }) },
		});

		const message = await sync({ env, fetchImpl });

		expect(message).toMatch(/1 lesson/);
		expect(message).toMatch(/nothing received/i);
	});

	it("reports a gap loudly rather than as a quiet no-op", async () => {
		const env = withPlugins(linked(), ["librarian@onlooker-community"]);
		const fetchImpl = routed({
			pull: {
				ok: true,
				status: 200,
				json: async () => ({
					// Starts at 2 against a cursor of 0, so 1 is missing.
					lessons: [
						{
							seq: 2,
							lesson: {
								schema_version: 1,
								id: "01KZ45MKAM734ZS7JK24D2DK0R",
								claim: "because it was measured",
								evidence: [],
								applies_to: {},
								status: "promoted",
							},
						},
					],
					cursor: 2,
					has_more: false,
				}),
			},
		});

		const message = await sync({ env, fetchImpl });

		// Both seqs named, so the anomaly is actionable rather than a shrug.
		expect(message).toMatch(/skipped/i);
		expect(message).toMatch(/\b1\b/);
		expect(message).toMatch(/\b2\b/);
	});

	it("pulls even when there was nothing to push", async () => {
		// The same reasoning as the inventory report: the no-lessons path is
		// every machine while the pool is empty, and it is exactly the machine
		// that most needs to receive.
		const env = withPlugins(linked(), ["librarian@onlooker-community"]);
		mkdirSync(join(env.ONLOOKER_DIR as string, "librarian"), {
			recursive: true,
		});
		const fetchImpl = routed({});

		const message = await sync({ env, fetchImpl });

		const pulls = fetchImpl.mock.calls.filter(([url]) =>
			String(url).includes("since="),
		);
		expect(pulls).toHaveLength(1);
		expect(message).toMatch(/nothing to sync/i);
		expect(lessonPushes(fetchImpl)).toHaveLength(0);
	});
});
```

Add this helper beside the others at the top of the file, so each test above only states the response it cares about:

```ts
/**
 * A fetch stub that routes by path: inventory, the delta read, and the push.
 *
 * Defaults answer success with nothing waiting, so a test overrides only the
 * leg it is about.
 */
const routed = (over: {
	inventory?: unknown;
	pull?: unknown;
	push?: unknown;
}) =>
	vi.fn().mockImplementation(async (url: unknown, init: { body: string }) => {
		const path = String(url);
		if (path.endsWith("/machine/inventory")) {
			return (
				over.inventory ?? { ok: true, status: 200, json: async () => ({ ok: true }) }
			);
		}
		if (path.includes("since=")) {
			return (
				over.pull ?? {
					ok: true,
					status: 200,
					json: async () => ({ lessons: [], cursor: 0, has_more: false }),
				}
			);
		}
		return (
			over.push ?? {
				ok: true,
				status: 200,
				json: async () => ({
					results: (
						JSON.parse(init.body).lessons as Array<{ id: string }>
					).map((l) => ({ id: l.id, outcome: "created" })),
				}),
			}
		);
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @onlooker/cli test -- sync`
Expected: FAIL — no request matching `since=` is made.

- [ ] **Step 3: Call pull from sync**

The push section already builds `client`. After the push's problem-collection and before the final return, add the pull and fold its outcome into the report. It must run on the no-lessons return paths too, which means restructuring those returns to pass through one exit:

```ts
	const pullOutcome = await pull({ client, env });
	const received = describePull(pullOutcome);
```

with:

```ts
/**
 * One line about what arrived, or about why nothing did.
 *
 * Never silent, for the same reason the inventory note is never silent: a
 * mirror that quietly stops updating while the command exits 0 is the
 * successful-looking silence this codebase keeps rediscovering.
 */
function describePull(outcome: PullOutcome): string {
	switch (outcome.kind) {
		case "received": {
			const counts = [
				`${outcome.created} new`,
				`${outcome.updated} updated`,
				`${outcome.unchanged} unchanged`,
			];
			const line = `Received ${outcome.created + outcome.updated + outcome.unchanged} lesson(s): ${counts.join(", ")}.`;
			return outcome.invalid.length === 0
				? line
				: `${line} ${outcome.invalid.length} were refused by the contract: ${outcome.invalid.join("; ")}`;
		}
		case "gap":
			return `Nothing received: the pool skipped from ${outcome.cursor} to ${outcome.got}, expecting ${outcome.expected}. Nothing was written and the cursor was left alone.`;
		default:
			return `Nothing received: ${outcome.reason}`;
	}
}
```

A `gap` or `failed` outcome does **not** throw on its own — the push verdict decides the exit code — but its line is always included, and when the push had nothing to report the message is the pull's line plus the inventory note.

- [ ] **Step 4: Run the whole CLI suite**

Run: `pnpm --filter @onlooker/cli test`
Expected: PASS. Pre-existing sync tests asserting exact messages will need the received line; that is the behavior change, not a broken test.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/sync.ts apps/cli/src/__tests__/sync.test.ts
git commit -m "feat(cli): close the round trip inside the command people already run :arrows_counterclockwise:"
```

---

## Final verification

- [ ] `pnpm --filter @onlooker/cli test`, `pnpm typecheck`, and `pnpm --filter @onlooker/cli lint`.
- [ ] Against production, from a linked machine: run `onlooker sync`, confirm `~/.onlooker/pool/` fills and `cursor.json` matches the highest `seq` received, then run it again and confirm the second run reports everything unchanged and makes one delta request.
- [ ] Delete `cursor.json` and re-run: the mirror rebuilds and reports `unchanged` rather than `created`, which is the upsert working.
- [ ] Bump `apps/cli/package.json` to 2.4.0 in the same PR. Without it the release never cuts and the feature ships inert — the exact gap that required `#142`.
- [ ] `bd close onlooker-8zv8` once merged and released.
