# Session Summaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry a summary of each substantial local agent session to the hosted side, and show it in the web app, without any event payload ever leaving the machine.

**Architecture:** A pure summarizer in the CLI folds the local event log into one row per session, reading only envelope fields. `sync` reports those rows the same way it already reports inventory — non-fatal, never silent. The API upserts them on `(machine_id, session_id)`, serves them back cursor-paginated, and prunes them on the existing cron. The web app adds a sixth `SECTIONS` entry and inherits its nav, heading and title from work already merged.

**Tech Stack:** TypeScript throughout. CLI bundled with esbuild for Node 20; API on Cloudflare Workers over D1 with Drizzle; web is React 18 + react-router v6, tested with Vitest and @testing-library/react.

Spec: `docs/superpowers/specs/2026-09-17-session-summaries-design.md`. Bead: `onlooker-kipn`.

## Global Constraints

- **The summarizer never reads `payload`.** This is the feature's whole safety property and it is structural, not procedural. No code path added by this plan may read an event's payload field.
- **Ellipsis is `…` (U+2026)**, one character, in every string this plan adds.
- **Colors in `apps/web` come from `PALETTE`** (`apps/web/src/components/palette.ts`), never a raw hex. Inline styles with `var()` are the house idiom, not debt — do not introduce stylesheets.
- **Never import from `apps/web/src/monitoring.provider.ts`** in main-bundle code; it is a lazily-loaded chunk and an import silently grows the main bundle by ~51 kB.
- **Contract changes go in `packages/api-contract`.** `apps/api` and `apps/web`'s mock both run those cases; drift between them has already cost two outages.
- **`packages/db/src/expected-schema.ts` must be updated with any schema change.** The deploy workflow runs a "Verify Production schema matches source" step that fails the deploy otherwise.
- **Edit tracked files with Edit/Write, never `sed -i`, `>` redirection, or heredocs.** This repo runs a `lineage` plugin hooking `PostToolUse` on the file tools; a shell edit moves the same bytes invisibly and destroys provenance.
- **American English** in comments, identifiers, and copy.
- Commits go through the `/git-workflow:commit` skill. Format `<type>(<scope>): <subject> :emoji:`, why-focused body, `Refs onlooker-kipn`. The emoji reflects the mood of *this* change, never the commit type.

---

### Task 1: The summarizer

A pure function from event envelopes to session summaries. Pure and separate so it can be tested on synthetic events with no fixture log and no developer's real history — and so the payload-safety property can be tested directly.

**Files:**
- Create: `apps/cli/src/sessions.ts`
- Test: `apps/cli/src/__tests__/sessions.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `EventEnvelope`, `SessionSummary`, `DEFAULT_THRESHOLD`, and `summarizeSessions(events: Iterable<EventEnvelope>, opts?: { threshold?: number; since?: string }): SessionSummary[]`. Tasks 5 and 3 both depend on the exact `SessionSummary` field names.

- [ ] **Step 1: Write the failing test**

Create `apps/cli/src/__tests__/sessions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	DEFAULT_THRESHOLD,
	type EventEnvelope,
	summarizeSessions,
} from "../sessions";

/** n events in one session, oldest first, one minute apart. */
function run(
	session_id: string,
	types: string[],
	startMinute = 0,
): EventEnvelope[] {
	return types.map((event_type, i) => ({
		event_type,
		session_id,
		machine_id: "m1",
		plugin: event_type.split(".")[0],
		timestamp: new Date(
			Date.UTC(2026, 8, 17, 12, startMinute + i),
		).toISOString(),
	}));
}

function filler(n: number): string[] {
	return Array.from({ length: n }, () => "tool.shell.exec");
}

describe("summarizeSessions", () => {
	it("folds one session into one row", () => {
		const events = run("s1", [
			"session.start",
			...filler(20),
			"session.prompt",
			"session.end",
		]);

		const [summary] = summarizeSessions(events);

		expect(summary.session_id).toBe("s1");
		expect(summary.machine_id).toBe("m1");
		expect(summary.event_count).toBe(23);
		expect(summary.counts_by_prefix).toEqual({ session: 3, tool: 20 });
		expect(summary.prompts).toBe(1);
		expect(summary.compactions).toBe(0);
	});

	// The prefix is the part before the FIRST dot, matching what eventlog.ts
	// already means by prefix in its lastByPrefix scan. Two modules disagreeing
	// about what "tool" counts would be a bug nobody could see from either one.
	it("counts by the first dotted segment", () => {
		const events = run("s1", [
			...filler(21),
			"tool.file.edit",
			"lineage.change.recorded",
		]);

		const [summary] = summarizeSessions(events);

		expect(summary.counts_by_prefix).toEqual({ tool: 22, lineage: 1 });
	});

	// The measured shape of the log: 11,186 session ids, median 3 events, and a
	// typical short one is a start, an end, and one plugin event having done
	// nothing. Without a threshold the feed is eleven thousand rows of that.
	it("drops sessions below the threshold", () => {
		const events = [
			...run("busy", filler(25)),
			...run("idle", ["session.start", "bursar.tick", "session.end"]),
		];

		const ids = summarizeSessions(events).map((s) => s.session_id);

		expect(ids).toEqual(["busy"]);
	});

	it("keeps a session exactly at the threshold", () => {
		const events = run("edge", filler(DEFAULT_THRESHOLD));

		expect(summarizeSessions(events)).toHaveLength(1);
	});

	it("drops a session one below the threshold", () => {
		const events = run("edge", filler(DEFAULT_THRESHOLD - 1));

		expect(summarizeSessions(events)).toHaveLength(0);
	});

	it("honors a caller's threshold over the default", () => {
		const events = run("small", filler(5));

		expect(summarizeSessions(events, { threshold: 5 })).toHaveLength(1);
	});

	// A session still running has no session.end. Reporting it with a null
	// ended_at lets the next sync update the same row rather than freezing it
	// at whatever it looked like the first time it was seen.
	it("reports a session with no end as in progress", () => {
		const events = run("live", ["session.start", ...filler(25)]);

		const [summary] = summarizeSessions(events);

		expect(summary.ended_at).toBeNull();
		expect(summary.started_at).toBe("2026-09-17T12:00:00.000Z");
	});

	it("takes ended_at from the session.end event", () => {
		const events = run("done", [...filler(25), "session.end"]);

		const [summary] = summarizeSessions(events);

		expect(summary.ended_at).toBe("2026-09-17T12:25:00.000Z");
	});

	it("lists each contributing plugin once, sorted", () => {
		const events: EventEnvelope[] = [
			...run("s1", filler(20)),
			{
				event_type: "lineage.change.recorded",
				session_id: "s1",
				machine_id: "m1",
				plugin: "lineage",
				timestamp: "2026-09-17T12:30:00.000Z",
			},
			{
				event_type: "archivist.artifact.ready",
				session_id: "s1",
				machine_id: "m1",
				plugin: "archivist",
				timestamp: "2026-09-17T12:31:00.000Z",
			},
		];

		const [summary] = summarizeSessions(events);

		expect(summary.plugins).toEqual(["archivist", "lineage", "tool"]);
	});

	// The window is a property of the data, not of how often somebody ran the
	// command: a machine that has not synced in a while still reports its
	// recent work, and a session older than the window is simply not re-sent.
	it("drops sessions whose last event predates `since`", () => {
		const events = [
			...run("old", filler(25), 0),
			...run("recent", filler(25), 600),
		];

		const ids = summarizeSessions(events, {
			since: "2026-09-17T15:00:00.000Z",
		}).map((s) => s.session_id);

		expect(ids).toEqual(["recent"]);
	});

	// THE SAFETY PROPERTY. Envelope-only is the whole reason this feature can
	// ship without solving redaction first, and it is worth a test that fails
	// loudly the moment someone adds a payload read - including a read that
	// looks harmless, like spreading the event into a new object.
	it("never reads an event's payload", () => {
		const events = run("s1", filler(25)).map((event) =>
			Object.defineProperty({ ...event }, "payload", {
				enumerable: true,
				get() {
					throw new Error("payload was read");
				},
			}),
		);

		expect(() => summarizeSessions(events)).not.toThrow();
	});

	it("returns nothing for no events", () => {
		expect(summarizeSessions([])).toEqual([]);
	});
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @onlooker/cli test -- sessions.test.ts`
Expected: FAIL — `Failed to resolve import "../sessions"`.

- [ ] **Step 3: Write the summarizer**

Create `apps/cli/src/sessions.ts`:

```ts
/**
 * One session, folded down to what may leave the machine.
 *
 * The envelope only. `payload` is absent from `EventEnvelope` deliberately, and
 * that absence is the feature's entire safety story: a plugin shipping a new
 * event type cannot leak through this path, because no code here reads what its
 * events contain. The alternative - an allowlist of safe payload fields - would
 * be richer, and would have to be re-decided every time somebody adds an event
 * type, with the default for an undecided type being where the leak lives.
 *
 * The cost is stated rather than hidden: a summary reading "6,311 tool events
 * over two hours" reports THAT something happened, not what. See the design.
 */
export interface EventEnvelope {
	event_type: string;
	session_id: string;
	timestamp: string;
	machine_id?: string;
	plugin?: string;
}

export interface SessionSummary {
	session_id: string;
	machine_id: string | null;
	started_at: string;
	/** Null while the session is still running - no `session.end` seen yet. */
	ended_at: string | null;
	event_count: number;
	/** Keyed by the part of `event_type` before the first dot. */
	counts_by_prefix: Record<string, number>;
	plugins: string[];
	prompts: number;
	compactions: number;
}

/**
 * Twenty events.
 *
 * Measured rather than chosen: over an 80,000-event sample of one machine's
 * log there were 11,186 session ids with a median length of three - a start, an
 * end, and one plugin event, having done nothing - and only 72 sessions above
 * twenty. Those 72 held more events than the other 11,114 combined.
 *
 * Exported and overridable because it is an observation about ONE log, and a
 * constant nobody can move would harden that into a rule for everybody.
 */
export const DEFAULT_THRESHOLD = 20;

/** The part of an event type before the first dot, per eventlog.ts. */
function prefixOf(eventType: string): string {
	const dot = eventType.indexOf(".");
	return dot === -1 ? eventType : eventType.slice(0, dot);
}

interface Accumulator {
	machine_id: string | null;
	started_at: string;
	ended_at: string | null;
	last_at: string;
	event_count: number;
	counts_by_prefix: Record<string, number>;
	plugins: Set<string>;
	prompts: number;
	compactions: number;
}

/**
 * Fold events into one summary per session worth showing.
 *
 * `threshold` drops sessions too small to be worth a row. `since` bounds the
 * report to sessions whose last event is recent, so a machine that has not
 * synced in a while still reports its recent work.
 *
 * Insertion-ordered by first appearance, which for an append-only log means
 * oldest session first. The caller sorts if it wants something else.
 */
export function summarizeSessions(
	events: Iterable<EventEnvelope>,
	opts: { threshold?: number; since?: string } = {},
): SessionSummary[] {
	const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
	const sessions = new Map<string, Accumulator>();

	for (const event of events) {
		// A line missing either of these cannot be attributed to a session or
		// placed in time, and one bad writer must not stop the pass.
		if (!event.session_id || !event.timestamp) continue;

		let acc = sessions.get(event.session_id);
		if (!acc) {
			acc = {
				machine_id: event.machine_id ?? null,
				started_at: event.timestamp,
				ended_at: null,
				last_at: event.timestamp,
				event_count: 0,
				counts_by_prefix: {},
				plugins: new Set(),
				prompts: 0,
				compactions: 0,
			};
			sessions.set(event.session_id, acc);
		}

		acc.event_count += 1;
		if (event.timestamp < acc.started_at) acc.started_at = event.timestamp;
		if (event.timestamp > acc.last_at) acc.last_at = event.timestamp;

		const prefix = prefixOf(event.event_type);
		acc.counts_by_prefix[prefix] = (acc.counts_by_prefix[prefix] ?? 0) + 1;
		if (event.plugin) acc.plugins.add(event.plugin);

		if (event.event_type === "session.end") acc.ended_at = event.timestamp;
		else if (event.event_type === "session.prompt") acc.prompts += 1;
		else if (event.event_type === "session.compact") acc.compactions += 1;
	}

	const summaries: SessionSummary[] = [];
	for (const [session_id, acc] of sessions) {
		if (acc.event_count < threshold) continue;
		if (opts.since && acc.last_at < opts.since) continue;

		summaries.push({
			session_id,
			machine_id: acc.machine_id,
			started_at: acc.started_at,
			ended_at: acc.ended_at,
			event_count: acc.event_count,
			counts_by_prefix: acc.counts_by_prefix,
			plugins: [...acc.plugins].sort(),
			prompts: acc.prompts,
			compactions: acc.compactions,
		});
	}
	return summaries;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @onlooker/cli test`
Expected: PASS, including every existing CLI test.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `pnpm --filter @onlooker/cli typecheck && pnpm --filter @onlooker/cli lint`

```bash
git add apps/cli/src/sessions.ts apps/cli/src/__tests__/sessions.test.ts
```

Then run `/git-workflow:commit`. The why: eleven thousand sessions, seventy-two worth showing, and no payload read to decide which.

---

### Task 2: The hosted table

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/expected-schema.ts`
- Create: a migration under `packages/db/migrations/` (generated, see Step 3)

**Interfaces:**
- Produces: the `session_summaries` table. Tasks 3, 4 and 7 all read or write it.

- [ ] **Step 1: Read the surrounding style first**

Read `packages/db/src/schema.ts` in full before editing. Match its existing import list, its `sqliteTable` call style, how it declares composite keys and indexes, and how `machine_tokens` and `lesson_feed` express foreign keys. Do not introduce a drizzle helper the file does not already use.

- [ ] **Step 2: Add the table**

In `packages/db/src/schema.ts`, after `lesson_feed`:

```ts
/**
 * One row per agent session worth showing, per machine.
 *
 * Keyed on (machine_id, session_id) rather than an id of its own, because the
 * CLI reports the same session again as it grows: a session still running gets
 * a null `ended_at` and is upserted on the next sync rather than duplicated.
 * That is what lets the client keep no high-water mark at all - there is no
 * local state to corrupt, and a wiped cli.json re-reports rather than orphaning
 * history.
 *
 * `counts_by_prefix` and `plugins` are JSON text. D1 has no JSON column type,
 * and the alternative - a row per prefix per session - would multiply a feed
 * that is already the largest thing a machine reports.
 *
 * Nothing here derives from an event's payload. See the design: the summarizer
 * never reads one.
 */
export const session_summaries = sqliteTable(
	"session_summaries",
	{
		user_id: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		machine_id: text("machine_id")
			.notNull()
			.references(() => machine_tokens.id, { onDelete: "cascade" }),
		session_id: text("session_id").notNull(),
		started_at: text("started_at").notNull(),
		/** Null while the session is still running. */
		ended_at: text("ended_at"),
		event_count: integer("event_count").notNull(),
		/** JSON object: prefix -> count. */
		counts_by_prefix: text("counts_by_prefix").notNull(),
		/** JSON array of plugin names. */
		plugins: text("plugins").notNull(),
		prompts: integer("prompts").notNull().default(0),
		compactions: integer("compactions").notNull().default(0),
		reported_at: text("reported_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	},
	(table) => [
		primaryKey({ columns: [table.machine_id, table.session_id] }),
		// The feed's only query: this user's sessions, newest first.
		index("session_summaries_user_started_idx").on(
			table.user_id,
			table.started_at,
		),
	],
);
```

Add `primaryKey` and `index` to the drizzle import if the file does not already import them, and match whether the file returns an array or an object from the table's second argument — copy whichever `lesson_feed` uses.

- [ ] **Step 3: Generate the migration**

Run drizzle-kit the way this package already does — check `packages/db/package.json` for the generate script and run that rather than inventing a command. Do not hand-write the SQL; a hand-written migration and a generated snapshot drift, and `meta/` is what the deploy's schema check compares against.

- [ ] **Step 4: Update the expected schema**

Add `session_summaries` and its columns to `packages/db/src/expected-schema.ts`, matching how the existing tables are expressed there.

This is not optional bookkeeping: `deploy.yml` runs a "Verify Production schema matches source" step, and a schema change without a matching expectation fails the production deploy after staging has already migrated.

- [ ] **Step 5: Run the db tests**

Run: `pnpm --filter @onlooker/db test`
Expected: PASS. If a test compares the generated schema to the expected one, it is the check described above and it must pass without editing the test to accommodate the new table.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `pnpm --filter @onlooker/db typecheck && pnpm --filter @onlooker/db lint`

```bash
git add packages/db/src/schema.ts packages/db/src/expected-schema.ts packages/db/migrations
```

Then run `/git-workflow:commit`.

---

### Task 3: `POST /machine/sessions`

**Files:**
- Create: `apps/api/src/db/session-summaries.ts`
- Create: `apps/api/src/routes/sessions.ts`
- Modify: `apps/api/src/routes/index.ts` (register the route)
- Test: `apps/api/src/routes/__tests__/sessions.test.ts` — or wherever the api's route tests live; check first and match.

**Interfaces:**
- Consumes: `session_summaries` from Task 2.
- Produces: `handlePostSessions(request, env)`, and `putSessionSummaries(db, userId, machineId, summaries)`.

- [ ] **Step 1: Read the route this mirrors**

Read `apps/api/src/routes/machine-inventory.ts` in full. It is the closest existing route: machine-authenticated, bounded body, explicit schema version, and a comment explaining why a machine credential may write this but may not enumerate machines. Mirror its structure, its validation order, and its error codes.

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/routes/sessions.test.ts`. This harness is copied from `apps/api/src/routes/machine-inventory.test.ts` — the `PASSWORD` assembly is deliberate and its comment must be kept:

```ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const db = () => env.DB;
const BASE = "https://api.onlooker.dev";
// Assembled rather than written as one literal so the repository's secret
// scanner does not flag a throwaway test fixture. Same value the sibling
// route suites use; do not "simplify" it back into a single string.
const PASSWORD = ["correct", "horse", "battery"].join("-");

function summary(overrides: Record<string, unknown> = {}) {
	return {
		session_id: "s1",
		started_at: "2026-09-17T12:00:00.000Z",
		ended_at: "2026-09-17T14:00:00.000Z",
		event_count: 25,
		counts_by_prefix: { tool: 20, session: 5 },
		plugins: ["onlooker"],
		prompts: 3,
		compactions: 0,
		...overrides,
	};
}

async function signup(email: string): Promise<string> {
	const response = await SELF.fetch(`${BASE}/auth/signup`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password: PASSWORD, name: "Ada" }),
	});
	return ((await response.json()) as { token: string }).token;
}

async function mint(
	accessToken: string,
	name: string,
): Promise<{ id: string; token: string }> {
	const response = await SELF.fetch(`${BASE}/api/machines`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ name }),
	});
	return (await response.json()) as { id: string; token: string };
}

function post(machineToken: string, body: unknown): Promise<Response> {
	return SELF.fetch(`${BASE}/machine/sessions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${machineToken}`,
		},
		body: JSON.stringify(body),
	});
}

describe("POST /machine/sessions", () => {
	it("stores a machine's session summaries", async () => {
		const access = await signup("store@example.com");
		const machine = await mint(access, "laptop");

		const response = await post(machine.token, {
			schema_version: 1,
			sessions: [summary(), summary({ session_id: "s2" })],
		});

		expect(response.status).toBe(200);
		const { results } = await db()
			.prepare(
				"SELECT session_id, event_count FROM session_summaries WHERE machine_id = ? ORDER BY session_id",
			)
			.bind(machine.id)
			.all();
		expect(results).toHaveLength(2);
	});

	// The whole point of keying on (machine_id, session_id): a session reported
	// again while it is still running must update, not duplicate.
	it("upserts a session reported twice", async () => {
		const access = await signup("upsert@example.com");
		const machine = await mint(access, "laptop");

		await post(machine.token, {
			schema_version: 1,
			sessions: [summary({ ended_at: null, event_count: 25 })],
		});
		await post(machine.token, {
			schema_version: 1,
			sessions: [
				summary({ ended_at: "2026-09-17T15:00:00.000Z", event_count: 40 }),
			],
		});

		const { results } = await db()
			.prepare(
				"SELECT event_count, ended_at FROM session_summaries WHERE machine_id = ?",
			)
			.bind(machine.id)
			.all();
		expect(results).toHaveLength(1);
		expect(results[0].event_count).toBe(40);
		expect(results[0].ended_at).not.toBeNull();
	});

	// A machine credential names exactly one machine. Honoring a machine_id in
	// the body would let one machine's credential write history attributed to
	// another, which is the property machines.ts protects deliberately.
	it("attributes rows to the token's machine, not the body's", async () => {
		const access = await signup("attrib@example.com");
		const mine = await mint(access, "mine");
		const other = await mint(access, "other");

		await post(mine.token, {
			schema_version: 1,
			sessions: [summary({ machine_id: other.id })],
		});

		const { results } = await db()
			.prepare("SELECT machine_id FROM session_summaries")
			.all();
		expect(results).toHaveLength(1);
		expect(results[0].machine_id).toBe(mine.id);
	});

	it("refuses a body whose sessions are not an array", async () => {
		const access = await signup("shape@example.com");
		const machine = await mint(access, "laptop");

		const response = await post(machine.token, {
			schema_version: 1,
			sessions: "nope",
		});

		expect(response.status).toBe(400);
	});

	it("refuses an unknown schema version", async () => {
		const access = await signup("version@example.com");
		const machine = await mint(access, "laptop");

		const response = await post(machine.token, {
			schema_version: 999,
			sessions: [summary()],
		});

		expect(response.status).toBe(400);
	});

	it("refuses a body over the size cap", async () => {
		const access = await signup("big@example.com");
		const machine = await mint(access, "laptop");

		const response = await post(machine.token, {
			schema_version: 1,
			sessions: Array.from({ length: 5000 }, (_, i) =>
				summary({ session_id: `s${i}` }),
			),
		});

		expect(response.status).toBe(413);
	});

	it("refuses a request with no machine token", async () => {
		const response = await SELF.fetch(`${BASE}/machine/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ schema_version: 1, sessions: [summary()] }),
		});

		expect(response.status).toBe(401);
	});
});
```

Check `machine-inventory.test.ts` for a `beforeEach` that resets the database and copy it if present.

- [ ] **Step 3: Run the test and watch it fail**

Run: `pnpm --filter @onlooker/api test -- sessions`
Expected: FAIL — the route does not exist, so the request 404s.

- [ ] **Step 4: Implement**

`apps/api/src/db/session-summaries.ts` holds the query; `apps/api/src/routes/sessions.ts` holds the handler:

```ts
/**
 * Generous against a week of heavy use - 72 sessions at a few hundred bytes -
 * and bounded so a machine credential cannot write an unbounded blob into D1.
 * The same reasoning, and the same shape, as MAX_INVENTORY_BYTES.
 */
const MAX_SESSIONS_BYTES = 256 * 1024;

/** The only document shape this server knows how to store. */
const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * A machine may describe what it has been doing.
 *
 * Machine-authenticated for the same reason the inventory route is: the
 * credential names exactly one machine, and every row written is attributed to
 * that machine from the TOKEN, never from the body. A machine_id in the payload
 * is ignored rather than trusted - honoring it would let one machine's
 * credential write history attributed to another.
 */
export async function handlePostSessions(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const { machineId, userId } = await requireMachineToken(request, env);

	const raw = await request.text();
	if (new TextEncoder().encode(raw).length > MAX_SESSIONS_BYTES) {
		throw new ApiError(413, "sessions_too_large", "Too many sessions at once");
	}
	// ... parse, validate schema_version and that `sessions` is an array,
	// validate each summary's required fields, then:
	await putSessionSummaries(env.DB, userId, machineId, summaries);
	return json({ stored: summaries.length });
}
```

Fill in the validation following `machine-inventory.ts`'s order and its `ApiError` codes. `putSessionSummaries` performs the upsert; use whatever upsert idiom the api's other D1 writes already use rather than introducing a new one.

- [ ] **Step 5: Register the route**

Add it to `apps/api/src/routes/index.ts` beside the other `/machine/*` routes, matching how they are registered.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @onlooker/api test`
Expected: PASS, all of them.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `pnpm --filter @onlooker/api typecheck && pnpm --filter @onlooker/api lint`

```bash
git add apps/api/src/db/session-summaries.ts apps/api/src/routes/sessions.ts apps/api/src/routes/index.ts apps/api/src/routes/__tests__/sessions.test.ts
```

Then run `/git-workflow:commit`.

---

### Task 4: `GET /sessions` and the contract

**Files:**
- Modify: `apps/api/src/db/session-summaries.ts` (add the read)
- Modify: `apps/api/src/routes/sessions.ts` (add the handler)
- Modify: `apps/api/src/routes/index.ts`
- Modify: `packages/api-contract/src/index.ts` (add cases)
- Modify: `apps/web/src/api/mockApi.ts` (the mock must answer the same cases)
- Test: the api route test from Task 3, extended

**Interfaces:**
- Consumes: `session_summaries`, `putSessionSummaries`.
- Produces: `GET /sessions` answering `{ sessions, cursor, has_more }` — deliberately the same envelope `listActivity` already returns (`apps/web/src/api/lessonsApi.ts` defines `ActivityFeedPage` as `{ events, cursor, has_more }`). Task 6 consumes this shape.

- [ ] **Step 1: Write the failing tests**

API cases:

```ts
it("returns this user's sessions, newest first", async () => {
	// Seed three summaries with different started_at values,
	// GET /sessions with browser auth, assert order is newest first.
});

it("pages with a cursor", async () => {
	// Seed more than one page, assert has_more is true and cursor is non-null,
	// then GET with that cursor and assert the next page continues correctly
	// with no row repeated and none skipped.
});

it("never returns another user's sessions", async () => {
	// Seed a summary owned by a second user, assert it is absent.
});

// "Nothing yet" is an answer, not an error. A user with no machines is the
// normal state of a new account.
it("answers an empty page for a user with no machines", async () => {
	// GET with browser auth for a user with nothing, expect 200 and
	// { sessions: [], cursor: null, has_more: false }.
});

it("refuses a machine token", async () => {
	// GET /sessions authenticated with a MACHINE token rather than a browser
	// session, expect 401. Reading the feed is a browser-authenticated act.
});
```

Contract cases in `packages/api-contract/src/index.ts` — read `authenticatedCases()` and copy its exact style:

```ts
{
	name: "sessions feed, empty",
	path: "/sessions",
	init: { method: "GET" },
	status: 200,
	body: { sessions: expectArray, has_more: false },
},
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter @onlooker/api test && pnpm --filter @onlooker/web test`
Expected: FAIL on both — the route 404s, and the mock does not implement it.

- [ ] **Step 3: Implement the read**

Add `listSessionSummaries(db, userId, cursor)` to `apps/api/src/db/session-summaries.ts`, ordered by `started_at` descending using the `session_summaries_user_started_idx` index. Parse `counts_by_prefix` and `plugins` from their JSON text columns on the way out, so the client never sees the storage representation.

Add `handleGetSessions` to `apps/api/src/routes/sessions.ts` behind `requireAuth`, cursor-paginated exactly as the activity feed is — read that route and copy its cursor encoding rather than inventing a second scheme.

- [ ] **Step 4: Implement the mock**

Add the same endpoint to `apps/web/src/api/mockApi.ts`, returning the same shape. The contract cases run against both; a mock that answers a different shape is the drift `packages/api-contract` exists to prevent, and it has already cost two outages.

- [ ] **Step 5: Run everything**

Run: `pnpm --filter @onlooker/api test && pnpm --filter @onlooker/web test`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `pnpm --filter @onlooker/api typecheck && pnpm --filter @onlooker/api lint && pnpm --filter @onlooker/web typecheck`

Then run `/git-workflow:commit`.

---

### Task 5: Report from `sync`

**Files:**
- Modify: `apps/cli/src/api.ts` (add the client method)
- Modify: `apps/cli/src/commands/sync.ts` (add `reportSessions` and wire its note)
- Modify: `apps/cli/src/eventlog.ts` — only if it has no reusable way to stream envelopes; prefer reusing what is there
- Test: `apps/cli/src/__tests__/sync.test.ts` (or wherever sync is tested — check and match)

**Interfaces:**
- Consumes: `summarizeSessions`, `SessionSummary`, `DEFAULT_THRESHOLD` (Task 1); `POST /machine/sessions` (Task 3).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Read how inventory does it**

`apps/cli/src/commands/sync.ts` already contains `reportInventory`. Read it and its doc comment carefully. It establishes the contract every reporting step in this command follows, and the comments say why in terms this task must honor:

- **Non-fatal.** A reporting failure must not cost a lesson push — "that is the more important of the two operations and the one someone ran this for."
- **Never silent.** It returns a note rather than logging, because "exiting 0 while the Machines page quietly stops updating is the successful-looking silence this codebase keeps rediscovering."
- **Collection failures and transport failures are worded differently**, because a local problem someone can go fix is not the same as a refused request.

`reportSessions` must match all three.

- [ ] **Step 2: Write the failing test**

```ts
it("reports session summaries and says nothing when it works", async () => {
	// Run sync with a fake event log containing one session above threshold.
	// Assert the client received the summaries and the returned message
	// contains no sessions note.
});

// The contract every reporting step in this command follows.
it("does not fail the sync when reporting sessions fails", async () => {
	// Make the sessions endpoint reject. Assert sync still returns its lesson
	// summary, and that the message NAMES the failure rather than swallowing it.
});

it("says so when the event log cannot be read", async () => {
	// Point at a missing log. Assert the note distinguishes this from a
	// transport failure - a local problem someone can go fix.
});

it("sends only sessions above the threshold", async () => {
	// A log with one 25-event session and one 3-event session.
	// Assert exactly one summary was sent.
});

// The log is appended to by many plugins. One bad writer must not stop the
// pass, or a single malformed line silently ends session reporting for good.
it("skips a malformed line and summarizes the rest", async () => {
	// A log whose middle line is not valid JSON, with a 25-event session
	// around it. Assert the summary was still sent, and its event_count
	// reflects the readable lines.
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `pnpm --filter @onlooker/cli test -- sync`
Expected: FAIL — no summaries are sent.

- [ ] **Step 4: Add the client method**

In `apps/cli/src/api.ts`, beside `reportInventory`:

```ts
	/** Report this machine's recent session summaries. */
	reportSessions(summaries: SessionSummary[]): Promise<void>;
```

and its implementation, calling `POST /machine/sessions` with `{ schema_version: 1, sessions: summaries }`, following exactly how `reportInventory` calls `/machine/inventory`.

- [ ] **Step 5: Add `reportSessions` to sync**

```ts
/** Seven days, per the design: a window over the data rather than over syncs. */
const SESSION_WINDOW_DAYS = 7;

/**
 * Report this machine's recent sessions, describing the outcome rather than
 * throwing.
 *
 * Non-fatal and never silent, for the same two reasons `reportInventory` is:
 * a reporting failure must not cost a lesson push, and a command that exits 0
 * while a page quietly stops updating is the successful-looking silence this
 * codebase keeps rediscovering.
 *
 * A window over the data rather than since-last-sync: a machine that has not
 * synced in a while still reports its recent work, and the bound does not
 * depend on how often somebody happened to run this.
 */
async function reportSessions(
	client: ApiClient,
	env: NodeJS.ProcessEnv,
): Promise<string | null> {
	// Read the log, summarize above threshold within the window, and post.
	// A missing or unreadable log is worded as a local problem; a refused
	// request is worded as a transport problem.
}
```

Call it beside `reportInventory` in `sync`, and add its note to the `withNote` join so it rides out with whatever the command was going to say.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @onlooker/cli test`
Expected: PASS.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `pnpm --filter @onlooker/cli typecheck && pnpm --filter @onlooker/cli lint`

Then run `/git-workflow:commit`.

---

### Task 6: The `/sessions` page

**Files:**
- Create: `apps/web/src/pages/SessionsPage.tsx`
- Create: `apps/web/src/api/sessionsApi.ts`
- Modify: `apps/web/src/components/sections.ts` (a sixth entry)
- Modify: `apps/web/src/titles.ts` — only if a `SECTIONS` entry does not already supply the title; it should, so verify rather than assume
- Modify: `apps/web/src/App.tsx` (the route)
- Test: `apps/web/src/__tests__/sessions-page.test.tsx`

**Interfaces:**
- Consumes: `GET /sessions` answering `{ sessions, cursor, has_more }` (Task 4); `Protected`, `Loading`, `EmptyState`, `Panel` from existing components.
- Produces: nothing.

- [ ] **Step 1: Pick the icon before writing anything**

`SECTIONS` entries carry an `icon` from `@onlooker/brand`, and the existing entries' comments record real decisions — `Basket` over `ChestTreasure` because the latter measured 9% legible on the night panel, `CatHead` as the most person-like icon in a set with no person icon.

Choose from the brand set, check it is not already used by another section, and write a comment saying why. If nothing fits well, say so in the report rather than picking silently.

- [ ] **Step 2: Write the failing test**

```tsx
// The two empty states are different facts and must not read alike. An empty
// pool that told someone to connect a machine when they had simply filtered to
// a status nothing held is the precedent - see LessonsPage.
it("says nothing has synced when no machine has reported", async () => {
	// listSessions resolves to an empty page and the user has no machines.
	// Assert the copy points at Machines.
});

it("says nothing cleared the threshold when machines have synced", async () => {
	// Empty page, but the user HAS machines.
	// Assert the copy says nothing was big enough, and does NOT tell them to
	// connect a machine.
});

it("renders a session's shape", async () => {
	// One summary: 6311 tool, 100 session, 81 skill.
	// Assert the row shows the event count and the prefix breakdown.
});

it("groups sessions by day", async () => {
	// Two sessions on different days, assert two day headings.
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `pnpm --filter @onlooker/web test -- sessions-page`
Expected: FAIL — the page does not exist.

- [ ] **Step 4: Write the API client**

Create `apps/web/src/api/sessionsApi.ts` mirroring `lessonsApi.ts`'s `listActivity`: the same `{ sessions, cursor, has_more }` envelope, the same options shape (`{ cursor?: string | null }`), and the same client helper.

- [ ] **Step 5: Write the page**

`SessionsPage.tsx`, following `ActivityPage.tsx`'s structure: fetch a page on mount, group by day with the same day-key helper, render each group in a `Panel`, and use `Loading` for the pending state and `EmptyState` for the two empty cases. Use `LoadMore` for pagination if `ActivityPage` does.

Distinguishing the two empty states requires knowing whether the user has machines. Get that from the existing machines API rather than adding a field to the sessions response — the read is cheap and it keeps the feed's shape about sessions.

- [ ] **Step 6: Add the section and the route**

Add the entry to `SECTIONS` in `apps/web/src/components/sections.ts` with the icon comment from Step 1, then add the route to `App.tsx`:

```tsx
<Route path="/sessions" element={<Protected><SessionsPage /></Protected>} />
```

The nav link, the `h1` and the document title all follow from the `SECTIONS` entry with no further work. Confirm that by running the title guard rather than assuming it.

- [ ] **Step 7: Run everything**

Run: `pnpm --filter @onlooker/web test && bash scripts/source-guards.test.sh`
Expected: PASS. The source guard that asserts every `path=` in `App.tsx` is named in `sections.ts` or `titles.ts` will fail if Step 6 was missed — that is the guard doing its job.

- [ ] **Step 8: Typecheck, lint, build, commit**

Run: `pnpm --filter @onlooker/web typecheck && pnpm --filter @onlooker/web lint && pnpm --filter @onlooker/web build`

Report the main `index-*.js` gzip size. It was 95.25 kB at the last measurement, with `monitoring.provider` split out at 50.95 kB. A jump of tens of kB means the provider chunk got pulled into the main bundle — stop and report rather than committing.

Then run `/git-workflow:commit`.

---

### Task 7: Retention

**Files:**
- Modify: `apps/api/src/db/session-summaries.ts` (add the prune)
- Modify: `apps/api/src/index.ts` (call it from the existing `scheduled` handler)
- Test: the api session tests

**Interfaces:**
- Consumes: `session_summaries`.

- [ ] **Step 1: Write the failing test**

```ts
it("prunes summaries older than the retention window", async () => {
	// Seed one summary started 200 days ago and one started 10 days ago.
	// Run the prune. Assert the old one is gone and the recent one remains.
});

it("keeps a summary exactly at the boundary", async () => {
	// Seed one at exactly RETENTION_DAYS. Assert it survives - the boundary
	// belongs to the kept side, so "180 days of history" means 180.
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @onlooker/api test -- sessions`
Expected: FAIL — no prune function exists.

- [ ] **Step 3: Implement**

```ts
/**
 * A hundred and eighty days.
 *
 * Not a capacity decision - one machine produces on the order of 9,000 rows a
 * year and D1 would not notice. It is here so that "forever" is a thing someone
 * chose rather than a thing nobody decided. Two quarters is long enough to see
 * a trend and short enough that a row written today has a stated end.
 */
const RETENTION_DAYS = 180;

export async function pruneSessionSummaries(db: D1Database): Promise<number> {
	// DELETE rows whose started_at is older than the cutoff. Return the count
	// so the caller can report it.
}
```

- [ ] **Step 4: Call it from the cron**

`apps/api/src/index.ts` already has a `scheduled(...)` handler — the Cloudflare cron trigger added so the frequent heartbeat runs where the schedule is actually kept. Add the prune there.

It must not be able to fail the heartbeat: wrap it so a prune error is captured and reported to monitoring rather than thrown. A failed cleanup is not a reason for the health check to stop running.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @onlooker/api test`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `pnpm --filter @onlooker/api typecheck && pnpm --filter @onlooker/api lint`

Then run `/git-workflow:commit`.

---

### Task 8: Say so in the README

The README states the hosted half exists for "the one capability that cannot be local — sharing lessons between people." This work widens that deliberately, and an unamended README contradicts the schema.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Amend the framing**

Update the paragraph so it says the hosted side also holds session summaries, and say plainly what they contain and what they never contain — the envelope, never a payload. Someone deciding whether to run `sync` should be able to learn that from the README rather than from the source.

Keep it to a few sentences. Do not restate the design document.

- [ ] **Step 2: Update the status line if it is now wrong**

The README says "no lesson-sharing yet". Check whether anything else in it has gone stale, and fix only what this branch made stale.

- [ ] **Step 3: Commit**

```bash
git add README.md
```

Then run `/git-workflow:commit`.

---

## Final verification

- [ ] `pnpm test` — every workspace green
- [ ] `pnpm typecheck` and `pnpm lint` — clean, allowing for the 9 pre-existing `mockApi` warnings in `apps/web`
- [ ] `bash scripts/source-guards.test.sh` — passes, including the title guard now covering `/sessions`
- [ ] `pnpm --filter @onlooker/web build` — main chunk still ~95 kB gzip, `monitoring.provider` still split out
- [ ] Grep the diff for any read of an event's `payload` field. There must be none — that is the feature's safety property, and it is worth checking by hand once at the end rather than only by a unit test
- [ ] `bd close onlooker-kipn` when merged
