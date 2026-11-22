# Subordinate Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Session summaries carry one derived bit, `subordinate`, so "sessions per day" counts the sessions a person started and leaves out those another session or a script spawned.

**Architecture:** The CLI derives `subordinate` from `session.start`'s payload (`parent_session_id`, `attended`, written by ecosystem since #576) through a callback, the way `onSessionStart` already reads `working_directory`. `summarizeSessions` stays payload-blind and is handed the derived map. The API stores the bit in a new nullable column. The web rollup leaves `subordinate === true` out of its counts.

**Tech Stack:** TypeScript, vitest, Cloudflare Workers + D1, drizzle-orm / drizzle-kit, React.

**Spec:** `docs/superpowers/specs/2026-11-22-subordinate-sessions-design.md`

## Global Constraints

- The rule, exactly: `true` when `session.start`'s payload has a string `parent_session_id` or `attended === false`; `false` when it has `attended === true` and no `parent_session_id`; `null` when it has neither, or no `session.start` was read.
- Several `session.start` records for one session (a resume) merge with OR: once any says `true`, the session is `true`.
- `null` is not `false`. Every consumer treats `null` the way it treats a session today.
- Only the boolean leaves the machine. `parent_session_id`, `source` and `attended` are never added to `EventEnvelope`, `SessionSummary`, or any request body.
- `summarizeSessions` must never read `payload`. The existing "never reads an event's payload" test must keep passing unchanged.
- Absent, `null` and boolean are all valid on `POST /machine/sessions`. `schema_version` stays `1`.
- Edit tracked files with Edit/Write, not the shell (repo `CLAUDE.md`). No `biome check --write` or `lint:fix` steps. The only generator allowed is `drizzle-kit generate` for the migration and its snapshot.
- Run one test file with `pnpm --filter <pkg> test <name>`, with no `--`.
- Commit only through the `/git-workflow:commit` skill, never an ad hoc `git commit -m`.
- American English in code, comments and commits.
- Branch: `meagan/onl-221-subordinate-sessions` for PR 1, and `meagan/onl-221-subordinate-sessions-web` for PR 2 (cut from `main` after PR 1 merges).

## Delivery

Two PRs, following the ONL-128 precedent (#226 shipped API + CLI together):

- **PR 1 (Tasks 1–4):** db column, API, CLI read, CLI release `2.16.0`.
- **PR 2 (Tasks 5–6):** web type, rollup, Sessions headline.

Each PR deploys on its own. An API that predates PR 1 ignores the extra field, because `putSessionSummaries` builds its row field by field.

## File Map

| File | Change |
|---|---|
| `packages/db/src/schema.ts` | add nullable `subordinate` integer column |
| `packages/db/src/expected-schema.ts` | add its expectation |
| `packages/db/src/__tests__/schema.test.ts` | add to the column list |
| `packages/db/migrations/0024_*.sql`, `meta/0024_snapshot.json`, `meta/_journal.json` | generated |
| `apps/api/src/db/session-summaries.ts` | input type, upsert, read-back |
| `apps/api/src/routes/sessions.ts` | validation |
| `apps/api/src/routes/sessions.test.ts` | tests |
| `apps/cli/src/eventlog.ts` | `subordinateOf`, `onSubordinate` callback |
| `apps/cli/src/__tests__/eventlog.test.ts` | tests |
| `apps/cli/src/sessions.ts` | `SessionSummary.subordinate`, `opts.subordinate` |
| `apps/cli/src/__tests__/sessions.test.ts` | tests |
| `apps/cli/src/commands/sync.ts` | wire map from callback to fold |
| `apps/cli/src/__tests__/sync.test.ts` | end-to-end test |
| `apps/cli/src/__tests__/api.test.ts` | fixture field |
| `apps/cli/package.json` | `2.15.0` → `2.16.0` |
| `apps/web/src/api/sessionsApi.ts` | `subordinate` field |
| `apps/web/src/lib/sessionRollup.ts` | filter + `subordinate` count on `Rollup` |
| `apps/web/src/components/SessionsSummary.tsx` | one extra sentence |
| `apps/web/src/__tests__/*` fixtures | add `subordinate: null` |

---

### Task 1: Store `subordinate` in the database and the API

**Files:**
- Modify: `packages/db/src/schema.ts` (session_summaries, after `compactions`)
- Modify: `packages/db/src/expected-schema.ts` (session_summaries columns, after `compactions`)
- Modify: `packages/db/src/__tests__/schema.test.ts:247-261`
- Generate: `packages/db/migrations/0024_*.sql`, `packages/db/migrations/meta/0024_snapshot.json`, `packages/db/migrations/meta/_journal.json`
- Modify: `apps/api/src/db/session-summaries.ts`
- Modify: `apps/api/src/routes/sessions.ts` (`isValidSummary`)
- Test: `apps/api/src/routes/sessions.test.ts`

**Interfaces:**
- Produces: `SessionSummaryInput.subordinate?: boolean | null` and `SessionSummaryRow.subordinate: boolean | null` in `apps/api/src/db/session-summaries.ts`. `GET` session rows include `subordinate: boolean | null`.

- [ ] **Step 1: Write the failing schema test**

In `packages/db/src/__tests__/schema.test.ts`, the `session_summaries` column list becomes (alphabetical, as the test sorts):

```ts
		expect(columnNames(session_summaries)).toEqual([
			"compactions",
			"counts_by_prefix",
			"counts_by_project",
			"counts_by_type",
			"ended_at",
			"event_count",
			"machine_id",
			"plugins",
			"prompts",
			"reported_at",
			"session_id",
			"started_at",
			"subordinate",
			"user_id",
		]);
```

- [ ] **Step 2: Write the failing API tests**

Append to `apps/api/src/routes/sessions.test.ts`, after the `counts_by_type` describe block. It reuses the file's `summary`, `signup`, `mint`, `post`, `get` and `db` helpers:

```ts
describe("subordinate", () => {
	async function stored(machineId: string): Promise<number | null> {
		const row = await db()
			.prepare("SELECT subordinate FROM session_summaries WHERE machine_id = ?")
			.bind(machineId)
			.first<{ subordinate: number | null }>();
		return row?.subordinate ?? null;
	}

	async function readBack(access: string): Promise<unknown> {
		const read = await get(access);
		const body = (await read.json()) as {
			sessions: { subordinate: unknown }[];
		};
		return body.sessions[0].subordinate;
	}

	it.each([
		[true, 1],
		[false, 0],
	])("stores %s and reads it back", async (subordinate, column) => {
		const access = await signup(`sub-${subordinate}@example.com`);
		const machine = await mint(access, "laptop");

		const posted = await post(machine.token, {
			schema_version: 1,
			sessions: [summary({ subordinate })],
		});
		expect(posted.status).toBe(200);

		expect(await stored(machine.id)).toBe(column);
		expect(await readBack(access)).toBe(subordinate);
	});

	// Every CLI before 2.16.0 posts no such field. Unknown is not "a person
	// started it", so it is stored as null, not false.
	it.each([
		["absent", undefined],
		["null", null],
	])("stores %s as null", async (label, subordinate) => {
		const access = await signup(`sub-${label}@example.com`);
		const machine = await mint(access, "laptop");

		const posted = await post(machine.token, {
			schema_version: 1,
			sessions: [summary(subordinate === undefined ? {} : { subordinate })],
		});
		expect(posted.status).toBe(200);

		expect(await stored(machine.id)).toBeNull();
		expect(await readBack(access)).toBeNull();
	});

	it.each([
		["a string", "yes"],
		["a number", 1],
		["an object", {}],
	])("rejects %s", async (label, subordinate) => {
		const access = await signup(`sub-bad-${label.length}@example.com`);
		const machine = await mint(access, "laptop");

		const posted = await post(machine.token, {
			schema_version: 1,
			sessions: [summary({ subordinate })],
		});
		expect(posted.status).toBe(400);
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @onlooker/db test schema` and `pnpm --filter @onlooker/api test sessions`
Expected: the column-list test FAILs, missing `"subordinate"`. The API tests FAIL with `no such column: subordinate`, or with `undefined` where `true`/`null` was expected. The "rejects" cases FAIL with 200.

- [ ] **Step 4: Add the column**

In `packages/db/src/schema.ts`, inside `session_summaries`, directly after the `compactions` line:

```ts
		compactions: integer("compactions").notNull().default(0),
		/**
		 * 1 when another session or a script started this one, 0 when a person
		 * did, null when nobody knows (ONL-221). Derived on the machine from
		 * session.start's parent_session_id and attended, which never leave it.
		 *
		 * Nullable rather than defaulted to 0: every row written before this
		 * column, and every session whose start the CLI did not read, is
		 * unknown, and 0 would claim a person sat down for each of them.
		 */
		subordinate: integer("subordinate"),
```

In `packages/db/src/expected-schema.ts`, in `session_summaries`'s `columns`, directly after the `compactions` entry:

```ts
			{
				name: "subordinate",
				type: "INTEGER",
				notnull: 0,
				pk: 0,
			},
```

- [ ] **Step 5: Generate the migration**

Run: `pnpm --filter @onlooker/db generate:migrations`
Expected: new `packages/db/migrations/0024_<name>.sql` whose whole content is:

```sql
ALTER TABLE `session_summaries` ADD `subordinate` integer;
```

plus `meta/0024_snapshot.json` and a new `_journal.json` entry. If the SQL holds anything else, stop: `schema.ts` has drifted from the last snapshot, and that drift is not this task's to ship.

- [ ] **Step 6: Store and read the field in the API**

In `apps/api/src/db/session-summaries.ts`:

Add to `SessionSummaryInput`, after `compactions`:

```ts
	compactions: number;
	/**
	 * Whether another session or a script started this one (ONL-221). Absent
	 * from every CLI older than 2.16.0, and null when the CLI could not tell;
	 * both are stored as null, never as false.
	 */
	subordinate?: boolean | null;
```

In `putSessionSummaries`'s `row`, after `compactions: summary.compactions,`:

```ts
			compactions: summary.compactions,
			// null for absent as well as null: see SessionSummaryInput.
			subordinate:
				typeof summary.subordinate === "boolean"
					? Number(summary.subordinate)
					: null,
```

In the `onConflictDoUpdate` `set`, after `compactions: row.compactions,`:

```ts
					compactions: row.compactions,
					subordinate: row.subordinate,
```

Add to `SessionSummaryRow`, after `compactions: number;`:

```ts
	compactions: number;
	/** Null when unknown - see SessionSummaryInput. */
	subordinate: boolean | null;
```

In `listSessionSummaries`, the SELECT column list ends `prompts, compactions, subordinate`, the `.all<...>()` row type gains `subordinate?: number | null;`, and the mapping gains, after `compactions: r.compactions,`:

```ts
		compactions: r.compactions,
		// `== null` covers a D1 that has not run migration 0024 yet, which
		// returns the field absent rather than null.
		subordinate: r.subordinate == null ? null : r.subordinate === 1,
```

- [ ] **Step 7: Validate the field on the route**

In `apps/api/src/routes/sessions.ts`, above `isValidSummary`:

```ts
/**
 * Whether `subordinate` is absent, null or a boolean (ONL-221). Absent is
 * valid for the reason it is for `counts_by_type`: every CLI older than this
 * field posts none.
 */
function isValidSubordinate(value: unknown): boolean {
	return value === undefined || value === null || typeof value === "boolean";
}
```

In `isValidSummary`, append to the `&&` chain after the `compactions` check:

```ts
		typeof candidate.compactions === "number" &&
		isValidSubordinate(candidate.subordinate)
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @onlooker/db test` and `pnpm --filter @onlooker/api test sessions`
Expected: PASS, including `expected-schema.test.ts`'s "matches a freshly generated snapshot". If that one fails, the hand-written entry in Step 4 doesn't match drizzle. Fix the entry to match; don't regenerate the file.

- [ ] **Step 9: Typecheck the affected packages**

Run: `pnpm --filter @onlooker/db typecheck && pnpm --filter @onlooker/api typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

Use `/git-workflow:commit`, staging exactly the files listed under **Files** for this task. Suggested subject: `feat(api): store whether a session was spawned`. Body: why `null` is not `0`, and that only the derived bit is stored. `Refs ONL-221`.

---

### Task 2: Derive `subordinate` while reading the event log

**Files:**
- Modify: `apps/cli/src/eventlog.ts` (`SessionStart` docstring area, `streamEnvelopes`, `readEventEnvelopes`)
- Test: `apps/cli/src/__tests__/eventlog.test.ts`

**Interfaces:**
- Produces: `export function subordinateOf(payload: unknown): boolean | null` in `apps/cli/src/eventlog.ts`.
- Produces: `readEventEnvelopes(env, { onSessionStart?, onSubordinate?: (sessionId: string, subordinate: boolean) => void })`. It's called once per `session.start` whose `subordinateOf` is non-null, and never for any other event type.

- [ ] **Step 1: Write the failing tests**

Add `subordinateOf` to the existing `../eventlog` import in `apps/cli/src/__tests__/eventlog.test.ts`, then append:

```ts
describe("subordinateOf", () => {
	it.each([
		["a parent", { parent_session_id: "p1", attended: true }, true],
		["a parent with attended unknown", { parent_session_id: "p1" }, true],
		["an unattended start with no parent", { attended: false }, true],
		["an attended start with no parent", { attended: true }, false],
		["neither field", { working_directory: "/x" }, null],
		["a parent that is not a string", { parent_session_id: 7, attended: true }, false],
		["attended that is not a boolean", { attended: "false" }, null],
		["no payload", undefined, null],
		["a payload that is not an object", "attended", null],
	])("%s", (_label, payload, expected) => {
		expect(subordinateOf(payload)).toBe(expected);
	});
});

describe("readEventEnvelopes onSubordinate", () => {
	it("reports session.start's derived bit and never puts it on the envelope", async () => {
		const env = withEvents([
			{
				event_type: "session.start",
				session_id: "child",
				timestamp: "2026-11-22T12:00:00.000Z",
				payload: { parent_session_id: "parent-1", attended: false },
			},
			{
				event_type: "session.start",
				session_id: "person",
				timestamp: "2026-11-22T12:00:01.000Z",
				payload: { attended: true },
			},
			{
				event_type: "session.start",
				session_id: "old",
				timestamp: "2026-11-22T12:00:02.000Z",
				payload: { working_directory: "/src" },
			},
			{
				// Not a start: a tool event carrying the same fields is ignored.
				event_type: "tool.used",
				session_id: "person",
				timestamp: "2026-11-22T12:00:03.000Z",
				payload: { parent_session_id: "parent-1" },
			},
		]);
		const calls: [string, boolean][] = [];
		const { envelopes } = await readEventEnvelopes(env, {
			onSubordinate: (id, subordinate) => calls.push([id, subordinate]),
		});
		const seen = await collect(envelopes);

		expect(calls).toEqual([
			["child", true],
			["person", false],
		]);
		expect(seen).toHaveLength(4);
		const text = JSON.stringify(seen);
		expect(text).not.toContain("parent");
		expect(text).not.toContain("attended");
		expect(text).not.toContain("subordinate");
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @onlooker/cli test eventlog`
Expected: FAIL. `subordinateOf` isn't exported, and `onSubordinate` is never called.

- [ ] **Step 3: Implement**

In `apps/cli/src/eventlog.ts`, directly after the `SessionStart` interface:

```ts
/**
 * Whether another session or a script started this one, from session.start's
 * payload (ONL-221). ecosystem writes `parent_session_id` and `attended` there
 * since #576, and omits each when it cannot tell.
 *
 * A parent means another session spawned it. `attended: false` with no parent
 * is a `claude -p` from a script or cron: not spawned by a session, and still
 * not a person sitting down. Null when neither field says anything, which is
 * every start written before #576.
 *
 * The second payload read this module makes, under the same rule as the first:
 * the fields themselves never reach `EventEnvelope`. Only this boolean does,
 * through `onSubordinate`, and it leaves the machine as a summary's
 * `subordinate`.
 */
export function subordinateOf(payload: unknown): boolean | null {
	if (typeof payload !== "object" || payload === null) return null;
	const { parent_session_id, attended } = payload as Record<string, unknown>;
	if (typeof parent_session_id === "string" && parent_session_id !== "") {
		return true;
	}
	if (attended === false) return true;
	if (attended === true) return false;
	return null;
}
```

Change `streamEnvelopes`'s signature to take an options object instead of the third positional parameter:

```ts
async function* streamEnvelopes(
	stream: ReturnType<typeof createReadStream>,
	path: string,
	callbacks: {
		onSessionStart?: (start: SessionStart) => void;
		onSubordinate?: (sessionId: string, subordinate: boolean) => void;
	} = {},
): AsyncGenerator<EventEnvelope> {
```

Replace `if (onSessionStart && record.event_type === "session.start") {` and its block with:

```ts
			if (record.event_type === "session.start") {
				const payload = record.payload as Record<string, unknown> | undefined;
				const dir = payload?.working_directory;
				if (
					callbacks.onSessionStart &&
					typeof record.project === "string" &&
					basis &&
					typeof dir === "string"
				) {
					callbacks.onSessionStart({
						timestamp: record.timestamp,
						project: record.project,
						project_basis: basis,
						working_directory: dir,
					});
				}
				if (callbacks.onSubordinate) {
					const subordinate = subordinateOf(payload);
					if (subordinate !== null) {
						callbacks.onSubordinate(record.session_id, subordinate);
					}
				}
			}
```

In `streamEnvelopes`'s docstring, change the sentence "`payload` is never read, except `payload.working_directory` on `session.start`, and only when a caller passes `onSessionStart`; see `SessionStart`." to:

```ts
 * `payload` is never read, except on `session.start`: `working_directory` when
 * a caller passes `onSessionStart` (see `SessionStart`), and
 * `parent_session_id` and `attended` when it passes `onSubordinate` (see
 * `subordinateOf`).
```

In `readEventEnvelopes`, widen `opts` and pass it through:

```ts
export async function readEventEnvelopes(
	env: NodeJS.ProcessEnv = process.env,
	opts: {
		onSessionStart?: (start: SessionStart) => void;
		onSubordinate?: (sessionId: string, subordinate: boolean) => void;
	} = {},
): Promise<EventLogEnvelopes> {
```

and the return becomes `envelopes: streamEnvelopes(stream, path, opts),`.

Also update the `SessionStart` interface docstring's first paragraph: "The one payload field this module reads" becomes "One of the two payload reads this module makes (the other is `subordinateOf`)".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @onlooker/cli test eventlog`
Expected: PASS, including the existing "hands session.start directories to the callback and never to the envelope".

- [ ] **Step 5: Commit**

Use `/git-workflow:commit` with `apps/cli/src/eventlog.ts` and `apps/cli/src/__tests__/eventlog.test.ts`. Suggested subject: `feat(cli): tell a spawned session's start from a person's`. `Refs ONL-221`.

---

### Task 3: Carry the bit through the fold and the sync

**Files:**
- Modify: `apps/cli/src/sessions.ts` (`SessionSummary`, `summarizeSessions`)
- Modify: `apps/cli/src/commands/sync.ts:108-118` (`reportSessions`)
- Modify: `apps/cli/src/__tests__/api.test.ts` (the `summary` fixture)
- Test: `apps/cli/src/__tests__/sessions.test.ts`, `apps/cli/src/__tests__/sync.test.ts`

**Interfaces:**
- Consumes: `readEventEnvelopes(env, { onSubordinate })` from Task 2.
- Produces: `SessionSummary.subordinate: boolean | null`, and `summarizeSessions(events, { threshold?, since?, subordinate?: ReadonlyMap<string, boolean> })`.

- [ ] **Step 1: Write the failing fold tests**

Append to `apps/cli/src/__tests__/sessions.test.ts`. It uses the file's `run` and `filler` helpers:

```ts
describe("summarizeSessions / subordinate", () => {
	const events = [
		...run("child", filler(25)),
		...run("person", filler(25), 30),
		...run("unknown", filler(25), 60),
	];

	it("takes each session's bit from the map, null when it has none", async () => {
		const subordinate = new Map([
			["child", true],
			["person", false],
		]);
		const summaries = await summarizeSessions(events, { subordinate });

		expect(
			Object.fromEntries(summaries.map((s) => [s.session_id, s.subordinate])),
		).toEqual({ child: true, person: false, unknown: null });
	});

	it("is null for every session when no map is given", async () => {
		const summaries = await summarizeSessions(events);
		expect(summaries.map((s) => s.subordinate)).toEqual([null, null, null]);
	});

	// The map is filled while the stream is read, so it is consulted only
	// once the fold has drained it - not at each session's first event.
	it("reads the map after the events, not before", async () => {
		const subordinate = new Map<string, boolean>();
		async function* filling() {
			for (const event of run("late", filler(25))) yield event;
			subordinate.set("late", true);
		}
		const [summary] = await summarizeSessions(filling(), { subordinate });
		expect(summary.subordinate).toBe(true);
	});
});
```

- [ ] **Step 2: Write the failing sync test**

In `apps/cli/src/__tests__/sync.test.ts`, inside the same describe block as "reports session summaries and says nothing when it works" (it uses `linked`, `withEventLog`, `sessionEvents`, `routed`, `sessionReports`, `sync`), add:

```ts
	it("reports whether each session was spawned, and never why", async () => {
		const env = linked();
		const start = (session_id: string, payload: Record<string, unknown>) => ({
			...eventEnvelope(session_id, "session.start", 30),
			payload,
		});
		withEventLog(env, [
			start("child", { parent_session_id: "parent-1", attended: true }),
			...sessionEvents("child", 25),
			start("person", { attended: true }),
			// A resume of the same session that says it was unattended: once
			// any start says spawned, the session is spawned.
			start("person", { attended: false }),
			...sessionEvents("person", 25),
			...sessionEvents("unknown", 25),
		]);
		const fetchImpl = routed();

		await sync({ env, fetchImpl });

		const body = sessionReports(fetchImpl)[0][1].body;
		const sent = JSON.parse(body) as {
			sessions: { session_id: string; subordinate: boolean | null }[];
		};
		expect(
			Object.fromEntries(sent.sessions.map((s) => [s.session_id, s.subordinate])),
		).toEqual({ child: true, person: true, unknown: null });
		expect(body).not.toContain("parent-1");
		expect(body).not.toContain("attended");
	});
```

Before writing this, read `eventEnvelope` in `sync.test.ts` to confirm its `(session_id, event_type, minutesAgo)` argument order and that it doesn't already set `payload`. Adjust the `start` helper to match, but keep the assertions as written.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @onlooker/cli test sessions` and `pnpm --filter @onlooker/cli test sync`
Expected: FAIL. `subordinate` is `undefined` on every summary.

- [ ] **Step 4: Implement the fold side**

In `apps/cli/src/sessions.ts`, add to `SessionSummary` after `compactions: number;`:

```ts
	compactions: number;
	/**
	 * Whether another session or a script started this one (ONL-221), as
	 * eventlog.ts's `subordinateOf` derived it from session.start. Null when
	 * no start said: every session from before ecosystem #576, and any whose
	 * start fell outside the read.
	 *
	 * Derived, not read: the fold never sees a payload. The caller hands it
	 * the map `readEventEnvelopes`'s `onSubordinate` filled, and only this
	 * boolean leaves the machine - never the parent's id.
	 */
	subordinate: boolean | null;
```

Change the `summarizeSessions` signature's `opts`:

```ts
	opts: {
		threshold?: number;
		since?: string;
		subordinate?: ReadonlyMap<string, boolean>;
	} = {},
```

Add to its docstring, after the `since` paragraph:

```ts
 * `subordinate` is consulted only after the last event, never during the
 * fold, because the caller fills it from the same stream this reads.
```

In the `summaries.push({...})` object, after `compactions: acc.compactions,`:

```ts
			compactions: acc.compactions,
			subordinate: opts.subordinate?.get(session_id) ?? null,
```

- [ ] **Step 5: Wire it in the sync**

In `apps/cli/src/commands/sync.ts`'s `reportSessions`, replace the `readEventEnvelopes` call and the `summarizeSessions` call:

```ts
	// OR, not last-wins: a session resumed several times has several starts,
	// and one that any start calls spawned was not a person's.
	const subordinate = new Map<string, boolean>();
	const { envelopes, unavailable } = await readEventEnvelopes(env, {
		onSessionStart: (start) => collector.add(start),
		onSubordinate: (id, spawned) =>
			subordinate.set(id, spawned || (subordinate.get(id) ?? false)),
	});
```

```ts
		summaries = await summarizeSessions(envelopes, { since, subordinate });
```

- [ ] **Step 6: Fix the API fixture**

In `apps/cli/src/__tests__/api.test.ts`, the `summary` fixture gains `subordinate: null,` after `compactions`. It's typed `SessionSummary`, so typecheck requires it.

- [ ] **Step 7: Run the CLI suite and typecheck**

Run: `pnpm --filter @onlooker/cli test` and `pnpm --filter @onlooker/cli typecheck`
Expected: PASS and no errors. "never reads an event's payload" in `sessions.test.ts` still passes unchanged. If any other existing test fails on an exact-object `toEqual` over a summary, add `subordinate: null` to its expected object. Don't loosen it to `objectContaining`.

- [ ] **Step 8: Commit**

Use `/git-workflow:commit` with the four files above plus the two test files. Suggested subject: `feat(cli): report which sessions another session spawned`. `Refs ONL-221`.

---

### Task 4: Release the CLI and open PR 1

**Files:**
- Modify: `apps/cli/package.json` (`"version": "2.15.0"` → `"2.16.0"`)

- [ ] **Step 1: Bump the version**

Edit `apps/cli/package.json`: `"version": "2.16.0",`.

- [ ] **Step 2: Run the whole suite and typecheck**

Run: `pnpm test` and `pnpm typecheck`
Expected: every package passes. Also run `bash scripts/source-guards.test.sh`: expected `0 of N tests failed`.

- [ ] **Step 3: Commit**

Use `/git-workflow:commit` with `apps/cli/package.json`. Suggested subject: `chore(cli): release 2.16.0`. Body: "Releases the CLI as 2.16.0." `Refs ONL-221`.

- [ ] **Step 4: Open PR 1**

Use `/git-workflow:pr`. The body states:
- The emitter shipped in ecosystem #576.
- The rule and why `null` isn't `false`.
- Only the bit leaves the machine.
- Expect few `true` rows, because the 20-event threshold already drops most spawned sessions.

---

### Task 5: Leave subordinate sessions out of the web rollup

Starts after PR 1 is merged and deployed, on a fresh branch from `main`.

**Files:**
- Modify: `apps/web/src/api/sessionsApi.ts` (`SessionSummary`)
- Modify: `apps/web/src/lib/sessionRollup.ts` (`Rollup`, `rollupSessions`)
- Modify: every `SessionSummary` fixture builder under `apps/web/src/__tests__/` (found by typecheck: `home-failures`, `home-page`, `home-plugins-panel`, `home-sessions-panel`, `installed-plugins`, `plugin-rollup`, `project-detail-page`, `session-rollup`, `sessions-page`, `sessions-summary`)
- Test: `apps/web/src/__tests__/session-rollup.test.ts`

**Interfaces:**
- Consumes: `GET` session rows carrying `subordinate: boolean | null` (Task 1).
- Produces: `SessionSummary.subordinate: boolean | null`, and `Rollup.subordinate: number`, the count of loaded sessions left out because `subordinate === true`.

- [ ] **Step 1: Write the failing tests**

Add `subordinate: null,` to the `session()` fixture in `apps/web/src/__tests__/session-rollup.test.ts`, then append:

```ts
describe("rollupSessions / subordinate", () => {
	const person = session({ session_id: "p", subordinate: false });
	const unknown = session({
		session_id: "u",
		started_at: "2026-09-24T11:00:00Z",
		ended_at: "2026-09-24T11:10:00Z",
		subordinate: null,
	});
	const spawned = session({
		session_id: "s",
		started_at: "2026-09-24T12:00:00Z",
		ended_at: "2026-09-24T15:00:00Z",
		subordinate: true,
	});

	it("leaves spawned sessions out of every total and says how many", () => {
		const rollup = rollupSessions([person, unknown, spawned], false);

		expect(rollup.sessions).toBe(2);
		expect(rollup.subordinate).toBe(1);
		expect(rollup.durationMs).toBe(40 * 60_000);
		expect(rollup.days).toEqual([
			{ day: rollup.days[0].day, sessions: 2, durationMs: 40 * 60_000 },
		]);
		// The three-hour spawned session would be the longest if it counted.
		expect(rollup.longest?.session_id).toBe("p");
	});

	// Unknown is every row from before CLI 2.16.0. Dropping those would empty
	// the history; they count as they always have.
	it("counts unknown sessions as it did before", () => {
		const rollup = rollupSessions([unknown], false);
		expect(rollup.sessions).toBe(1);
		expect(rollup.subordinate).toBe(0);
	});

	// The list still shows them: groupSessionsByDay is what SessionsPage rows
	// come from, and spawned sessions are real work.
	it("leaves groupSessionsByDay alone", () => {
		const groups = groupSessionsByDay([person, unknown, spawned]);
		expect(groups.flatMap((g) => g.sessions).map((s) => s.session_id)).toEqual(
			["s", "u", "p"],
		);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @onlooker/web test session-rollup`
Expected: FAIL. `rollup.sessions` is 3 and `rollup.subordinate` is undefined.

- [ ] **Step 3: Add the field to the web type**

In `apps/web/src/api/sessionsApi.ts`'s `SessionSummary`, after `compactions: number;`:

```ts
	compactions: number;
	/**
	 * True when another session or a script started this one, false when a
	 * person did, null when unknown (ONL-221). Null for every session synced
	 * by a CLI older than 2.16.0. Never absent: the API defaults it on read.
	 */
	subordinate: boolean | null;
```

- [ ] **Step 4: Filter in the rollup**

In `apps/web/src/lib/sessionRollup.ts`, add to `Rollup` after `sessions: number;`:

```ts
	sessions: number;
	/**
	 * Loaded sessions left out of every other field here because another
	 * session or a script started them (ONL-221). Unknown sessions are
	 * counted, not left out.
	 */
	subordinate: number;
```

At the top of `rollupSessions`, before `let durationMs = 0;`:

```ts
	// Counted here, not in groupSessionsByDay: the Sessions page's rows still
	// list spawned sessions, since they are real work. Only "how many sessions
	// did you have" leaves them out. `=== true` so unknown counts as before.
	const counted = sessions.filter((session) => session.subordinate !== true);
```

Then in `rollupSessions` only, replace `sessions` with `counted` in the `for` loop, in `groupSessionsByDay(sessions)`, and in `sessions: sessions.length`. Add `subordinate: sessions.length - counted.length,` to the returned object after `sessions: counted.length,`.

- [ ] **Step 5: Add the field to the remaining fixtures**

Run: `pnpm --filter @onlooker/web typecheck`
Expected: errors only in test files, each a `SessionSummary` fixture missing `subordinate` or a `Rollup` fixture missing `subordinate`. Add `subordinate: null,` to each `SessionSummary` fixture builder after its `compactions` line. Add `subordinate: 0,` to `sessions-summary.test.tsx`'s `rollup()` fixture after `sessions: 41,`. Re-run until it's clean.

- [ ] **Step 6: Run the web suite**

Run: `pnpm --filter @onlooker/web test`
Expected: PASS.

- [ ] **Step 7: Commit**

Use `/git-workflow:commit`. Suggested subject: `feat(web): count only the sessions a person started`. `Refs ONL-221`.

---

### Task 6: Say what the Sessions headline left out, and open PR 2

**Files:**
- Modify: `apps/web/src/components/SessionsSummary.tsx`
- Test: `apps/web/src/__tests__/sessions-summary.test.tsx`

**Interfaces:**
- Consumes: `Rollup.subordinate: number` (Task 5).

- [ ] **Step 1: Write the failing tests**

Append inside `describe("SessionsSummary", ...)` in `apps/web/src/__tests__/sessions-summary.test.tsx`:

```ts
	// The list below shows every loaded session. Without this sentence, a
	// headline of 40 over 41 rows reads as a miscount.
	it("says how many spawned sessions it left out", () => {
		render(<SessionsSummary rollup={rollup({ subordinate: 3 })} />);
		expect(screen.getByTestId("sessions-headline").textContent).toMatch(
			/3 more were started by another session or a script and aren't counted\.$/,
		);
	});

	it("says nothing about spawned sessions when there were none", () => {
		render(<SessionsSummary rollup={rollup({ subordinate: 0 })} />);
		expect(screen.getByTestId("sessions-headline").textContent).not.toMatch(
			/started by another session/,
		);
	});

	it("still renders when every loaded session was spawned", () => {
		render(
			<SessionsSummary
				rollup={rollup({ sessions: 0, durationMs: 0, days: [], range: "", subordinate: 1 })}
			/>,
		);
		expect(screen.getByTestId("sessions-headline").textContent).toMatch(
			/1 more was started by another session or a script and isn't counted\.$/,
		);
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @onlooker/web test sessions-summary`
Expected: FAIL. No such sentence, and the last case renders nothing.

- [ ] **Step 3: Implement**

In `apps/web/src/components/SessionsSummary.tsx`, change the early return:

```tsx
	if (rollup.sessions === 0 && rollup.subordinate === 0) return null;
```

After the `failedTail` declaration, add:

```tsx
	// The rows below list every loaded session, spawned ones included, so a
	// count that leaves some out has to say so or it reads as a miscount.
	const subordinateTail =
		rollup.subordinate > 0 ? (
			<>
				{" "}
				<LeadValue>{rollup.subordinate.toLocaleString()}</LeadValue> more{" "}
				{rollup.subordinate === 1 ? "was" : "were"} started by another session
				or a script and {rollup.subordinate === 1 ? "isn't" : "aren't"}{" "}
				counted.
			</>
		) : null;
```

and render `{subordinateTail}` directly after each of the two `{failedTail}` occurrences.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @onlooker/web test sessions-summary`, then `pnpm --filter @onlooker/web test` and `pnpm --filter @onlooker/web typecheck`
Expected: PASS and no errors.

- [ ] **Step 5: Commit and open PR 2**

Use `/git-workflow:commit` with the two files. Suggested subject: `feat(web): say which sessions the count left out`. Then open the PR with `/git-workflow:pr`. `Refs ONL-221`.

- [ ] **Step 6: Close out**

After PR 2 deploys:
- Run `onlooker sync` with CLI 2.16.0.
- Confirm a `subordinate` value is non-null for a recent session by reading `GET /sessions` through the web app, signed in. That check needs the user.
- Then `bd update onlooker-kipn.5 --append-notes "<what was checked>"` and `bd close onlooker-kipn.5`.
- Confirm ONL-221 is closed in Linear.
