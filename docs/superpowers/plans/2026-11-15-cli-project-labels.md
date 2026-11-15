# CLI project labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `onlooker project-labels on`, `onlooker sync` names this
machine's project keys on the web as `owner/repo` (or a repo folder name), and
`off` deletes what this machine uploaded.

**Architecture:** Two PRs. PR 1 is the API: a `written_by` column, a
machine-authenticated `PUT`/`DELETE /machine/project-labels`, and a read that
prefers the user's label. PR 2 is the CLI. It collects `session.start`
directories during the event-log pass `sync` already makes, recomputes each
key from git, derives a label only when the key matches, and uploads it.

**Tech Stack:** Cloudflare Workers + D1 (drizzle schema, `vitest` with
`cloudflare:workers`), Node CLI (`vitest`, `node:child_process`
`execFileSync`, `node:crypto`).

Spec: `docs/superpowers/specs/2026-11-15-cli-project-labels-design.md`.
Linear: ONL-197. Bead: `onlooker-4n71sc`.

## Global Constraints

- Labels: at most 200 bytes UTF-8, no `\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}`, not
  empty after trimming. Same rules on both sides.
- `derivation` is `1`. The server refuses every other value with 400
  `unsupported_derivation`.
- At most 500 labels per `PUT`.
- `machine_id` is `''` for `remote` and the token's machine for `root`. It is
  never read from a machine's request body.
- No label ever contains a host, port, userinfo, `@`, `:`, or more than one
  `/`.
- The CLI never reads `~/.onlooker/project-key-cache.tsv`.
- `EventEnvelope` stays payload-free. `working_directory` reaches only the
  label code, through its own callback, and never leaves the machine.
- Edit tracked files with Edit/Write, never `sed -i`, heredocs or
  `biome --write` (CLAUDE.md, lineage). `drizzle-kit generate` and
  `generate:expected-schema` are generators and are fine.
- To run one test file: `pnpm --filter <pkg> test <name>`, with **no `--`**.
- Commits go through `/git-workflow:commit`. American English.
- PR 2's CLI version bump (`apps/cli/package.json`, minor: 2.14.1 → 2.15.0)
  is its own commit.

## File Structure

**PR 1: API**
- Modify `packages/db/src/schema.ts`: `written_by` on `project_labels`.
- Generated: `packages/db/migrations/0023_*.sql`, `meta/0023_snapshot.json`,
  `meta/_journal.json`, `packages/db/src/expected-schema.ts`.
- Modify `packages/db/src/__tests__/schema.test.ts`.
- Create `apps/api/src/routes/label-rules.ts`: `PROJECT_KEY`,
  `MAX_LABEL_BYTES`, `validLabel`, moved out of `project-labels.ts`.
- Modify `apps/api/src/routes/project-labels.ts`: import the rules; a clear
  answers with the fallback label.
- Modify `apps/api/src/db/project-labels.ts`: `listProjectLabels` prefers
  `user`, plus `labelFor`, `putCliLabels`, `deleteCliLabels`.
- Create `apps/api/src/routes/machine-project-labels.ts` and its `.test.ts`.
- Modify `apps/api/src/routes/index.ts`, `apps/api/src/router.ts`.
- Modify `apps/web/src/api/labelsApi.ts`: comment only (it now says the user
  is the only writer).

**PR 2: CLI**
- Create `apps/cli/src/project-label.ts`: pure URL/root → label.
- Create `apps/cli/src/project-key.ts`: git-based key derivation.
- Create `apps/cli/src/label-candidates.ts`: folds `session.start` records
  into candidates.
- Modify `apps/cli/src/eventlog.ts`: optional `onSessionStart` callback.
- Modify `apps/cli/src/config.ts`: `projectLabels`, `projectLabelsPending`.
- Modify `apps/cli/src/api.ts`: `putProjectLabels`, `deleteProjectLabels`.
- Create `apps/cli/src/commands/project-labels.ts`.
- Modify `apps/cli/src/cli.ts`, `apps/cli/src/commands/status.ts`,
  `apps/cli/src/commands/sync.ts`.
- Tests: `apps/cli/src/__tests__/{project-label,project-key,label-candidates,project-labels-command}.test.ts`,
  additions to `eventlog.test.ts`, `api.test.ts`, `status.test.ts`,
  `sync.test.ts`.
- Modify `apps/cli/package.json` (version, own commit).

---

# PR 1: API

### Task 1: `written_by` column

**Files:**
- Modify: `packages/db/src/schema.ts` (inside `project_labels`, after `label`)
- Modify: `packages/db/src/__tests__/schema.test.ts:304-314`
- Generated: migration 0023, snapshot, journal, `expected-schema.ts`

**Interfaces:**
- Produces: column `project_labels.written_by TEXT NOT NULL DEFAULT ''`.

- [ ] **Step 1: Write the failing test.** In `schema.test.ts`, change the
  `project_labels` column list to:

```ts
		expect(columnNames(project_labels)).toEqual([
			"label",
			"machine_id",
			"project_key",
			"source",
			"updated_at",
			"user_id",
			"written_by",
		]);
```

  Then add, inside the same `describe`:

```ts
	// Not in the key: one remote key has one CLI label, owned by whichever
	// machine wrote it last, so a second machine's upload replaces the row
	// rather than adding one beside it (ONL-197).
	it("keeps written_by out of the primary key", () => {
		const pk = getTableConfig(project_labels).primaryKeys[0];
		expect(pk?.columns.map((c) => c.name)).not.toContain("written_by");
	});
```

- [ ] **Step 2: Run it and check it fails.**
  `pnpm --filter @onlooker/db test schema`. Expected: FAIL, column list
  missing `written_by`.

- [ ] **Step 3: Add the column** to `project_labels` in `schema.ts`, after
  `label`:

```ts
		/**
		 * The machine that last wrote a `cli` row, or '' for a user row
		 * (ONL-197). Not in the key: one remote key has one CLI label, owned by
		 * whichever machine wrote it last, and `DELETE /machine/project-labels`
		 * removes only the rows this machine owns.
		 */
		written_by: text("written_by").notNull().default(""),
```

  Also update the `source` doc comment: `'user' or 'cli' (ONL-197). The
  user's label wins.`

- [ ] **Step 4: Generate.**
  `pnpm --filter @onlooker/db generate:migrations`, then
  `pnpm --filter @onlooker/db generate:expected-schema`. Check that the new
  SQL is exactly one
  `ALTER TABLE \`project_labels\` ADD \`written_by\` text DEFAULT '' NOT NULL;`
  and nothing else. Otherwise stop: the schema has drifted elsewhere.

- [ ] **Step 5: Run the db and API suites.**
  `pnpm --filter @onlooker/db test`, then
  `pnpm --filter @onlooker/api test project-labels`. Expected: PASS. The API
  tests apply migrations, so this proves 0023 applies.

- [ ] **Step 6: Commit** schema, test, migration, snapshot, journal and
  expected schema: `feat(db): record which machine wrote a CLI label`.

### Task 2: Shared label rules, preferred read, clear falls back

**Files:**
- Create: `apps/api/src/routes/label-rules.ts`
- Modify: `apps/api/src/routes/project-labels.ts` (remove the moved
  constants and `validLabel`; the clear branch)
- Modify: `apps/api/src/db/project-labels.ts` (`listProjectLabels`, new
  `labelFor`)
- Modify: `apps/web/src/api/labelsApi.ts:3-8` (comment)
- Test: `apps/api/src/routes/project-labels.test.ts`

**Interfaces:**
- Produces: `label-rules.ts` exports `PROJECT_KEY: RegExp`,
  `MAX_LABEL_BYTES = 200`, `validLabel(raw: unknown): string` (throws
  `ApiError(400, "invalid_label", …)`).
- Produces: `labelFor(db, userId, projectKey, machineId: string | null): Promise<string | null>`
  returns the effective label (user over cli).
- `listProjectLabels` keeps its signature and `ProjectLabel` shape.

- [ ] **Step 1: Write the failing tests** in `project-labels.test.ts`. Add
  this helper after `list`:

```ts
/** A CLI row as PUT /machine/project-labels would leave it. */
async function cliRow(
	userId: string,
	machineId: string,
	label: string,
	rowMachine = "",
): Promise<void> {
	await db()
		.prepare(
			`INSERT INTO project_labels (user_id, project_key, machine_id, source, label, written_by)
			 VALUES (?, ?, ?, 'cli', ?, ?)`,
		)
		.bind(userId, KEY, rowMachine, label, machineId)
		.run();
}

async function userIdOf(accessToken: string): Promise<string> {
	const response = await exports.default.fetch(`${BASE}/api/users/me`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	return ((await response.json()) as { id: string }).id;
}
```

  Check that `/api/users/me` returns `id` at the top level. If it nests it,
  for example under `user`, adjust the helper to read that path. Then add:

```ts
describe("CLI labels beside the user's (ONL-197)", () => {
	it("lists a CLI label when the user has named nothing", async () => {
		const ada = await signup("ada@example.com");
		const machine = await mint(ada, "laptop");
		await cliRow(await userIdOf(ada), machine.id, "onlooker-community/onlooker");
		expect(await list(ada)).toEqual([
			{ project_key: KEY, machine_id: null, label: "onlooker-community/onlooker" },
		]);
	});

	it("prefers the user's label over the CLI's", async () => {
		const ada = await signup("ada@example.com");
		const machine = await mint(ada, "laptop");
		await cliRow(await userIdOf(ada), machine.id, "onlooker-community/onlooker");
		await put(ada, { project_key: KEY, machine_id: null, label: "mine" });
		expect(await list(ada)).toEqual([
			{ project_key: KEY, machine_id: null, label: "mine" },
		]);
	});

	// The page shows what the PUT answers, so a clear must answer with what
	// the list will say after it, or the CLI's name reappears on reload.
	it("answers a clear with the CLI label it falls back to", async () => {
		const ada = await signup("ada@example.com");
		const machine = await mint(ada, "laptop");
		await cliRow(await userIdOf(ada), machine.id, "onlooker-community/onlooker");
		await put(ada, { project_key: KEY, machine_id: null, label: "mine" });
		const response = await put(ada, {
			project_key: KEY,
			machine_id: null,
			label: null,
		});
		expect(await response.json()).toEqual({
			project_key: KEY,
			machine_id: null,
			label: "onlooker-community/onlooker",
		});
	});
});
```

- [ ] **Step 2: Run them and check they fail.**
  `pnpm --filter @onlooker/api test project-labels`. Expected: the first
  fails (list is `[]`), and so does the third (label `null`).

- [ ] **Step 3: Move the rules.** Create
  `apps/api/src/routes/label-rules.ts` holding `PROJECT_KEY`,
  `MAX_LABEL_BYTES`, `FORBIDDEN` and `validLabel`, moved verbatim with
  their doc comments from `project-labels.ts`, with `export` added to
  `PROJECT_KEY`, `MAX_LABEL_BYTES` and `validLabel`. Add the import
  `import { ApiError } from "../types";`. In `project-labels.ts`, delete
  those definitions and add
  `import { PROJECT_KEY, validLabel } from "./label-rules";`. Head the new
  file's docstring with: "One set of rules for every writer, so a label the
  CLI derives is held to what a person may type."

- [ ] **Step 4: Prefer the user's label.** In
  `apps/api/src/db/project-labels.ts`, replace `listProjectLabels`'s query
  and mapping:

```ts
export async function listProjectLabels(
	db: D1Database,
	userId: string,
): Promise<ProjectLabel[]> {
	// 'user' sorts after 'cli', so within one (key, machine) the user's row
	// is read last and overwrites the CLI's in the map below.
	const { results } = await db
		.prepare(
			`SELECT project_key, machine_id, label FROM project_labels
			  WHERE user_id = ? AND source IN ('cli', 'user')
			  ORDER BY project_key, machine_id, source`,
		)
		.bind(userId)
		.all<{ project_key: string; machine_id: string; label: string }>();
	const byIdentity = new Map<string, ProjectLabel>();
	for (const row of results) {
		byIdentity.set(`${row.machine_id}\n${row.project_key}`, {
			project_key: row.project_key,
			machine_id: row.machine_id === "" ? null : row.machine_id,
			label: row.label,
		});
	}
	return [...byIdentity.values()];
}

/** The label the list shows for one key: the user's, else the CLI's. */
export async function labelFor(
	db: D1Database,
	userId: string,
	projectKey: string,
	machineId: string | null,
): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT label FROM project_labels
			  WHERE user_id = ? AND project_key = ? AND machine_id = ?
			    AND source IN ('cli', 'user')
			  ORDER BY source DESC LIMIT 1`,
		)
		.bind(userId, projectKey, machineId ?? "")
		.first<{ label: string }>();
	return row?.label ?? null;
}
```

  Update `listProjectLabels`'s docstring. Its line "Only `source = 'user'`:
  nothing else writes rows yet" becomes "The user's label when there is one,
  otherwise the one the CLI derived (ONL-197)".

- [ ] **Step 5: Answer a clear with the fallback.** In
  `handlePutProjectLabel`, change the clear branch's response to
  `label: await labelFor(env.DB, userId, projectKey, machineId)`. Import
  `labelFor`. Change the route's docstring line "Only the user writes here"
  to also say: "A clear answers with the label the list now shows, which is
  the CLI's when one exists."

- [ ] **Step 6: Update the web comment.** In `labelsApi.ts`, replace the
  sentence "Browser-authenticated, and the user is the only writer: …
  separate route (ONL-197)." with: "Browser-authenticated. The user writes
  here; a machine that opted in writes `owner/repo` labels through its own
  route (ONL-197), and the list prefers the user's."

- [ ] **Step 7: Run the tests.**
  `pnpm --filter @onlooker/api test project-labels`, then
  `pnpm --filter @onlooker/api test contract`. Expected: PASS. The contract
  case "project label, remote key" still expects `"onlooker"`.

- [ ] **Step 8: Commit** `feat(api): prefer the user's label over the CLI's`.

### Task 3: `PUT /machine/project-labels`

**Files:**
- Create: `apps/api/src/routes/machine-project-labels.ts`
- Create: `apps/api/src/routes/machine-project-labels.test.ts`
- Modify: `apps/api/src/db/project-labels.ts` (add `putCliLabels`)
- Modify: `apps/api/src/routes/index.ts`, `apps/api/src/router.ts` (Machine
  self-report block, after `/machine/sessions`)

**Interfaces:**
- Consumes: `PROJECT_KEY`, `validLabel` from `label-rules.ts`;
  `requireMachineToken(request, env): Promise<{ userId; machineId }>` from
  `../middleware/machine-auth.js`.
- Produces: `CliLabelInput { project_key: string; basis: "remote" | "root"; label: string }`;
  `putCliLabels(db, userId, machineId, labels: CliLabelInput[]): Promise<{ stored: number; skipped: number }>`;
  `handlePutMachineProjectLabels(request, env)`.
- Wire: request body `{ derivation: 1, labels: CliLabelInput[] }`, response
  `{ stored: number, skipped: number }`.

- [ ] **Step 1: Write the failing tests.** Create
  `machine-project-labels.test.ts`. Copy `db`, `BASE`, `PASSWORD`, `signup`
  and `mint` verbatim from `project-labels.test.ts`, then add:

```ts
const KEY = "6a7678979e31";
const OTHER = "ee2cfbe428c7";

/** Report one session touching `key`, so the machine has reported it. */
async function report(
	machineToken: string,
	key: string,
	basis: "remote" | "root",
): Promise<void> {
	const response = await exports.default.fetch(`${BASE}/machine/sessions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${machineToken}`,
		},
		body: JSON.stringify({
			schema_version: 1,
			sessions: [
				{
					session_id: `s-${key}`,
					started_at: "2026-11-15T12:00:00.000Z",
					ended_at: "2026-11-15T13:00:00.000Z",
					event_count: 25,
					counts_by_prefix: { tool: 25 },
					counts_by_project: { [key]: { basis, event_count: 25 } },
					plugins: ["onlooker"],
					prompts: 1,
					compactions: 0,
				},
			],
		}),
	});
	expect(response.status).toBe(200);
}

function putLabels(machineToken: string, body: unknown): Promise<Response> {
	return exports.default.fetch(`${BASE}/machine/project-labels`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${machineToken}`,
		},
		body: JSON.stringify(body),
	});
}

async function rows(): Promise<unknown[]> {
	const { results } = await db()
		.prepare(
			"SELECT project_key, machine_id, source, label, written_by FROM project_labels ORDER BY project_key",
		)
		.all();
	return results;
}

beforeEach(async () => {
	await db().prepare("DELETE FROM project_labels").run();
	await db().prepare("DELETE FROM session_summaries").run();
	await db().prepare("DELETE FROM machine_tokens").run();
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM users").run();
});

describe("PUT /machine/project-labels", () => {
	it("refuses a browser session", async () => {
		const ada = await signup("ada@example.com");
		const response = await putLabels(ada, { derivation: 1, labels: [] });
		expect(response.status).toBe(401);
	});

	it("stores a remote label with no machine, written by this one", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		await report(laptop.token, KEY, "remote");
		const response = await putLabels(laptop.token, {
			derivation: 1,
			labels: [{ project_key: KEY, basis: "remote", label: "onlooker-community/onlooker" }],
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ stored: 1, skipped: 0 });
		expect(await rows()).toEqual([
			{
				project_key: KEY,
				machine_id: "",
				source: "cli",
				label: "onlooker-community/onlooker",
				written_by: laptop.id,
			},
		]);
	});

	it("puts a root label on the token's machine whatever the body says", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		const desktop = await mint(ada, "desktop");
		await report(laptop.token, KEY, "root");
		await putLabels(laptop.token, {
			derivation: 1,
			labels: [
				{ project_key: KEY, basis: "root", label: "notes", machine_id: desktop.id },
			],
		});
		expect(await rows()).toMatchObject([{ machine_id: laptop.id, written_by: laptop.id }]);
	});

	// Problem 1: a machine may name only what it reported.
	it("skips a key this machine never reported", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		const desktop = await mint(ada, "desktop");
		await report(desktop.token, OTHER, "remote");
		const response = await putLabels(laptop.token, {
			derivation: 1,
			labels: [{ project_key: OTHER, basis: "remote", label: "onlooker-community/ecosystem" }],
		});
		expect(await response.json()).toEqual({ stored: 0, skipped: 1 });
		expect(await rows()).toEqual([]);
	});

	it("skips a key reported under the other basis", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		await report(laptop.token, KEY, "root");
		const response = await putLabels(laptop.token, {
			derivation: 1,
			labels: [{ project_key: KEY, basis: "remote", label: "a/b" }],
		});
		expect(await response.json()).toEqual({ stored: 0, skipped: 1 });
	});

	// Problem 7: two derivations must never alternate one key's label.
	it("refuses a derivation it does not know", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		const response = await putLabels(laptop.token, { derivation: 2, labels: [] });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "unsupported_derivation" },
		});
	});

	it("refuses a label a person could not type either", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		await report(laptop.token, KEY, "remote");
		const response = await putLabels(laptop.token, {
			derivation: 1,
			labels: [{ project_key: KEY, basis: "remote", label: "a\u202eb" }],
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "invalid_label" } });
	});

	it("refuses more than 500 labels", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		const labels = Array.from({ length: 501 }, () => ({
			project_key: KEY,
			basis: "remote",
			label: "a/b",
		}));
		const response = await putLabels(laptop.token, { derivation: 1, labels });
		expect(response.status).toBe(400);
	});

	it("lets a second machine take over a shared remote label", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		const desktop = await mint(ada, "desktop");
		await report(laptop.token, KEY, "remote");
		await report(desktop.token, KEY, "remote");
		const body = {
			derivation: 1,
			labels: [{ project_key: KEY, basis: "remote", label: "onlooker-community/onlooker" }],
		};
		await putLabels(laptop.token, body);
		await putLabels(desktop.token, body);
		expect(await rows()).toMatchObject([{ written_by: desktop.id }]);
	});

	it("never touches the user's own label", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		await report(laptop.token, KEY, "remote");
		await exports.default.fetch(`${BASE}/api/project-labels`, {
			method: "PUT",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${ada}` },
			body: JSON.stringify({ project_key: KEY, machine_id: null, label: "mine" }),
		});
		await putLabels(laptop.token, {
			derivation: 1,
			labels: [{ project_key: KEY, basis: "remote", label: "onlooker-community/onlooker" }],
		});
		expect(await rows()).toHaveLength(2);
	});
});
```

  If `POST /machine/sessions` answers 200 with a different body, keep the
  `expect(response.status)` check and nothing else about it.

- [ ] **Step 2: Run them and check they fail.**
  `pnpm --filter @onlooker/api test machine-project-labels`. Expected: FAIL
  with 404s (no route).

- [ ] **Step 3: Add `putCliLabels`** to `apps/api/src/db/project-labels.ts`:

```ts
/** One label a machine derived, before the server scopes it. */
export interface CliLabelInput {
	project_key: string;
	basis: "remote" | "root";
	label: string;
}

/**
 * Store labels the CLI derived, each only if this machine reported that key
 * under that basis (ONL-197, problem 1). Remote rows are shared, so the last
 * machine to write one owns it; root rows belong to this machine alone.
 */
export async function putCliLabels(
	db: D1Database,
	userId: string,
	machineId: string,
	labels: CliLabelInput[],
): Promise<{ stored: number; skipped: number }> {
	if (labels.length === 0) return { stored: 0, skipped: 0 };
	const { results } = await db
		.prepare(
			`SELECT DISTINCT project_key, basis FROM session_projects
			  WHERE user_id = ? AND machine_id = ?`,
		)
		.bind(userId, machineId)
		.all<{ project_key: string; basis: string }>();
	const reported = new Set(results.map((r) => `${r.basis}\n${r.project_key}`));

	const writes = labels
		.filter((l) => reported.has(`${l.basis}\n${l.project_key}`))
		.map((l) =>
			db
				.prepare(
					`INSERT INTO project_labels (user_id, project_key, machine_id, source, label, written_by)
					 VALUES (?, ?, ?, 'cli', ?, ?)
					 ON CONFLICT (user_id, project_key, machine_id, source)
					 DO UPDATE SET label = excluded.label, written_by = excluded.written_by,
					               updated_at = CURRENT_TIMESTAMP`,
				)
				.bind(
					userId,
					l.project_key,
					l.basis === "root" ? machineId : "",
					l.label,
					machineId,
				),
		);
	if (writes.length > 0) await db.batch(writes);
	return { stored: writes.length, skipped: labels.length - writes.length };
}
```

  The `ON CONFLICT` target lists the columns in the same order as
  `setProjectLabel`'s. SQLite matches the conflict target as a set, so the
  order doesn't matter, but matching `setProjectLabel` keeps them easy to
  compare.

- [ ] **Step 4: Add the handler.** Create
  `apps/api/src/routes/machine-project-labels.ts`:

```ts
import { type CliLabelInput, putCliLabels } from "../db/project-labels.js";
import { requireMachineToken } from "../middleware/machine-auth.js";
import type { WorkerEnv } from "../types";
import { ApiError } from "../types";
import { PROJECT_KEY, validLabel } from "./label-rules";

/**
 * The derivation this server accepts (ONL-197, problem 7). Remote rows are
 * last-writer-wins across machines, which is safe only while every writer
 * derives a label the same way; a CLI that derives differently must be
 * refused, not allowed to alternate a key between two names.
 */
const DERIVATION = 1;

/** A machine has tens of projects; this bounds a body, not a real one. */
const MAX_LABELS = 500;

/**
 * PUT /machine/project-labels
 *
 * Labels a machine derived from its own repositories, sent only after
 * `onlooker project-labels on`. `machine_id` is never read from the body: a
 * remote label has none, and a root label is the token's machine.
 */
export async function handlePutMachineProjectLabels(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const { userId, machineId } = await requireMachineToken(request, env);

	let body: { derivation?: unknown; labels?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		throw new ApiError(400, "invalid_labels", "Labels must be JSON");
	}
	if (body.derivation !== DERIVATION) {
		throw new ApiError(
			400,
			"unsupported_derivation",
			`This server derives labels with version ${DERIVATION}. Update the CLI.`,
		);
	}
	if (!Array.isArray(body.labels) || body.labels.length > MAX_LABELS) {
		throw new ApiError(
			400,
			"invalid_labels",
			`labels must be an array of at most ${MAX_LABELS}`,
		);
	}

	const labels: CliLabelInput[] = body.labels.map((raw: unknown) => {
		const row = (raw ?? {}) as Record<string, unknown>;
		if (typeof row.project_key !== "string" || !PROJECT_KEY.test(row.project_key)) {
			throw new ApiError(
				400,
				"invalid_project_key",
				"project_key must be 12 lowercase hex characters",
			);
		}
		if (row.basis !== "remote" && row.basis !== "root") {
			throw new ApiError(400, "invalid_basis", "basis must be remote or root");
		}
		return { project_key: row.project_key, basis: row.basis, label: validLabel(row.label) };
	});

	return Response.json(await putCliLabels(env.DB, userId, machineId, labels));
}
```

- [ ] **Step 5: Route it.** Export it from `routes/index.ts`, following the
  existing `./project-labels` export. In `router.ts`, import it and add
  this after the `/machine/sessions` entry:

```ts
	{
		method: "PUT",
		path: "/machine/project-labels",
		auth: "machine",
		cors: "app",
		handler: handlePutMachineProjectLabels,
	},
```

- [ ] **Step 6: Run the tests.**
  `pnpm --filter @onlooker/api test machine-project-labels`, then
  `pnpm --filter @onlooker/api test router`. Expected: PASS. If
  `router.test.ts` lists every route, add the new one there in the same
  shape as `/machine/sessions`.

- [ ] **Step 7: Ablation.** In `putCliLabels`, temporarily replace the
  `.filter(...)` with `.filter(() => true)` and run the suite. "skips a key
  this machine never reported" and "skips a key reported under the other
  basis" must both FAIL. Restore the filter with Edit and rerun to PASS.

- [ ] **Step 8: Commit** `feat(api): accept labels a machine derived from git`.

### Task 4: `DELETE /machine/project-labels`

**Files:**
- Modify: `apps/api/src/db/project-labels.ts` (add `deleteCliLabels`)
- Modify: `apps/api/src/routes/machine-project-labels.ts` (add handler)
- Modify: `routes/index.ts`, `router.ts`
- Test: `apps/api/src/routes/machine-project-labels.test.ts`

**Interfaces:**
- Produces: `deleteCliLabels(db, userId, machineId): Promise<number>`;
  `handleDeleteMachineProjectLabels(request, env)` → `{ deleted: number }`.

- [ ] **Step 1: Write the failing tests** at the end of
  `machine-project-labels.test.ts`:

```ts
function deleteLabels(machineToken: string): Promise<Response> {
	return exports.default.fetch(`${BASE}/machine/project-labels`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${machineToken}` },
	});
}

describe("DELETE /machine/project-labels", () => {
	it("deletes only what this machine wrote, and never the user's", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		const desktop = await mint(ada, "desktop");
		await report(laptop.token, KEY, "remote");
		await report(desktop.token, OTHER, "root");
		await putLabels(laptop.token, {
			derivation: 1,
			labels: [{ project_key: KEY, basis: "remote", label: "onlooker-community/onlooker" }],
		});
		await putLabels(desktop.token, {
			derivation: 1,
			labels: [{ project_key: OTHER, basis: "root", label: "notes" }],
		});
		await exports.default.fetch(`${BASE}/api/project-labels`, {
			method: "PUT",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${ada}` },
			body: JSON.stringify({ project_key: KEY, machine_id: null, label: "mine" }),
		});

		const response = await deleteLabels(laptop.token);
		expect(await response.json()).toEqual({ deleted: 1 });
		expect(await rows()).toMatchObject([
			{ project_key: KEY, source: "user", label: "mine" },
			{ project_key: OTHER, source: "cli", written_by: desktop.id },
		]);
	});

	it("is a no-op the second time", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		expect(await (await deleteLabels(laptop.token)).json()).toEqual({ deleted: 0 });
	});
});
```

  If `rows()`'s ordering puts the two `KEY` rows' sources differently, sort
  by `project_key, source` in `rows()`.

- [ ] **Step 2: Run them and check they fail.**
  `pnpm --filter @onlooker/api test machine-project-labels`. Expected:
  FAIL, 404 or 405 on DELETE.

- [ ] **Step 3: Implement.** In `db/project-labels.ts`:

```ts
/** Remove the CLI labels this machine wrote last; the user's stay. */
export async function deleteCliLabels(
	db: D1Database,
	userId: string,
	machineId: string,
): Promise<number> {
	const result = await db
		.prepare(
			`DELETE FROM project_labels
			  WHERE user_id = ? AND source = 'cli' AND written_by = ?`,
		)
		.bind(userId, machineId)
		.run();
	return result.meta.changes ?? 0;
}
```

  In `machine-project-labels.ts`:

```ts
/**
 * DELETE /machine/project-labels
 *
 * What `onlooker project-labels off` calls (ONL-197, problem 6). Only rows
 * this machine wrote last: another machine that still consents keeps its
 * own, and re-asserts a shared repo's label on its next sync.
 */
export async function handleDeleteMachineProjectLabels(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const { userId, machineId } = await requireMachineToken(request, env);
	return Response.json({ deleted: await deleteCliLabels(env.DB, userId, machineId) });
}
```

  Route it next to the PUT, with `method: "DELETE"`.

- [ ] **Step 4: Run the API suite.** `pnpm --filter @onlooker/api test`,
  then `pnpm typecheck` and `pnpm --filter @onlooker/api lint`. Expected:
  PASS. Fix lint findings with Edit.

- [ ] **Step 5: Commit** `feat(api): let a machine take back its labels`.

- [ ] **Step 6: Open PR 1** with `/git-workflow:pr`, titled
  `feat(api): machine-derived project labels`, body `Refs: ONL-197`. Merge
  it after CI and confirm the deploy succeeded before PR 2 merges.

---

# PR 2: CLI

Branch from `main` once PR 1 has merged:
`meagan/onl-197-cli-project-labels`.

### Task 5: URL and root → label

**Files:**
- Create: `apps/cli/src/project-label.ts`
- Test: `apps/cli/src/__tests__/project-label.test.ts`

**Interfaces:**
- Produces: `DERIVATION = 1`; `remoteLabel(url: string): string | null`;
  `rootLabel(root: string): string | null`; `isValidLabel(label: string): boolean`.

- [ ] **Step 1: Write the failing test table:**

```ts
import { describe, expect, it } from "vitest";
import { isValidLabel, remoteLabel, rootLabel } from "../project-label";

// Problem 5: every form git accepts, with and without credentials.
const REMOTES: Array<[string, string | null]> = [
	["git@github.com:onlooker-community/onlooker.git", "onlooker-community/onlooker"],
	["github.com:onlooker-community/onlooker", "onlooker-community/onlooker"],
	["ssh://git@github.com/onlooker-community/onlooker.git", "onlooker-community/onlooker"],
	["ssh://git@git.corp.example:2222/team/svc.git", "team/svc"],
	["git+ssh://git@github.com/a/b.git", "a/b"],
	["ssh+git://git@github.com/a/b.git", "a/b"],
	["git://github.com/a/b.git", "a/b"],
	["http://github.com/a/b", "a/b"],
	["https://github.com/onlooker-community/onlooker.git", "onlooker-community/onlooker"],
	["https://user:tok@git.corp.example:8443/team/svc.git", "team/svc"],
	["https://x-access-token:ghs_abc@github.com/a/b.git/", "a/b"],
	["https://gitlab.com/group/sub/proj.git", "sub/proj"],
	["https://host/a%40b/c.git", null],
	["https://host/onlyone.git", null],
	["https://host/", null],
	["file:///Users/me/src/repo.git", null],
	["/Users/me/src/repo.git", null],
	["../repo", null],
	["C:\\repos\\thing", null],
	["", null],
];

describe("remoteLabel", () => {
	it.each(REMOTES)("%s -> %s", (url, label) => {
		expect(remoteLabel(url)).toBe(label);
	});

	it("never returns a host, port or credential", () => {
		for (const [url] of REMOTES) {
			const label = remoteLabel(url);
			if (label === null) continue;
			expect(label).not.toMatch(/[@:]/);
			expect(label.split("/")).toHaveLength(2);
			for (const secret of ["github.com", "corp.example", "tok", "ghs_abc", "8443", "2222"]) {
				expect(label).not.toContain(secret);
			}
		}
	});
});

describe("rootLabel", () => {
	it("is the folder name", () => {
		expect(rootLabel("/Users/me/src/notes")).toBe("notes");
		expect(rootLabel("/Users/me/src/notes/")).toBe("notes");
	});
	it("is nothing for the filesystem root", () => {
		expect(rootLabel("/")).toBeNull();
	});
	it("is nothing for a name the server would refuse", () => {
		expect(rootLabel("/tmp/a\u202eb")).toBeNull();
	});
});

describe("isValidLabel", () => {
	it("holds the server's rules", () => {
		expect(isValidLabel("a/b")).toBe(true);
		expect(isValidLabel("  ")).toBe(false);
		expect(isValidLabel("a\nb")).toBe(false);
		expect(isValidLabel("é".repeat(101))).toBe(false); // 202 bytes
	});
});
```

- [ ] **Step 2: Run it and check it fails.**
  `pnpm --filter @onlooker/cli test project-label`. Expected: FAIL, module
  not found.

- [ ] **Step 3: Implement** `apps/cli/src/project-label.ts`:

```ts
import { basename } from "node:path";

/**
 * The label derivation this CLI implements (ONL-197, problem 7). Remote rows
 * are last-writer-wins across machines, so two CLIs that derived
 * differently would alternate a key between two names. Any change to this
 * file's output is a new number, and the server must accept it first.
 */
export const DERIVATION = 1;

const MAX_LABEL_BYTES = 200;
/** The server's FORBIDDEN, in apps/api/src/routes/label-rules.ts. */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
/** A URL scheme git understands; scp-like remotes have none. */
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
/** scp-like `[user@]host:path`, which git takes only when no slash precedes the colon. */
const SCP = /^(?:[^@/]+@)?[^/:]+:(?!\/\/)(.+)$/;

/** Whether the server would accept `label`, so a row is not spent on a refusal. */
export function isValidLabel(label: string): boolean {
	return (
		!FORBIDDEN.test(label) &&
		label.trim() !== "" &&
		new TextEncoder().encode(label).length <= MAX_LABEL_BYTES
	);
}

/**
 * `owner/repo` from an origin URL, or null.
 *
 * Only the path is ever kept, so userinfo, host and port cannot reach the
 * label whatever form the URL takes. A local remote (`file://`, a path) has
 * no name worth sending and its path would be a disclosure, so it is null.
 */
export function remoteLabel(url: string): string | null {
	let path: string;
	const scheme = SCHEME.exec(url)?.[1]?.toLowerCase();
	if (scheme !== undefined) {
		if (scheme === "file") return null;
		try {
			path = new URL(url.replace(SCHEME, "https://")).pathname;
		} catch {
			return null;
		}
	} else {
		const scp = SCP.exec(url);
		// A Windows drive (`C:\…`) matches scp's shape; a one-letter host is
		// what git itself treats as a local path.
		if (!scp || /^[a-z]:/i.test(url)) return null;
		path = scp[1] ?? "";
	}

	const segments = path
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.split("/")
		.filter(Boolean);
	if (segments.length < 2) return null;
	const owner = segments[segments.length - 2] ?? "";
	const repo = segments[segments.length - 1] ?? "";

	let label: string;
	try {
		label = `${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`;
	} catch {
		return null;
	}
	// Decoded only to check: an encoded `@`, `:` or `/` is a name that could
	// carry a credential or a second path, and none is a real repo name.
	if (/[@:]/.test(label) || label.split("/").length !== 2) return null;
	return isValidLabel(label) ? label : null;
}

/** The repo root's folder name, or null. */
export function rootLabel(root: string): string | null {
	const name = basename(root.replace(/\/+$/, ""));
	return name !== "" && isValidLabel(name) ? name : null;
}
```

- [ ] **Step 4: Run it.** `pnpm --filter @onlooker/cli test project-label`.
  Expected: PASS. If a table row fails, fix the parser, not the table. The
  table is the spec. The exception is a row that contradicts the spec's
  forms list; raise that one with the user instead of changing it.

- [ ] **Step 5: Commit** `feat(cli): derive owner/repo labels without the host`.

### Task 6: Key derivation from git

**Files:**
- Create: `apps/cli/src/project-key.ts`
- Test: `apps/cli/src/__tests__/project-key.test.ts`

**Interfaces:**
- Produces:

```ts
export type Resolved =
	| { kind: "remote"; key: string; url: string }
	| { kind: "root"; key: string; root: string }
	| { kind: "none"; why: "missing" | "not-a-repo" | "no-git" };
export function projectKey(input: string): string; // first 12 hex of sha256
export function resolveProject(dir: string): Resolved;
```

- [ ] **Step 1: Write the failing tests:**

```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectKey, resolveProject } from "../project-key";

// Parity with the ecosystem's _onlooker_sha256_first12. Each pair is a real
// key from this machine's event log, next to the origin URL it came from.
const PARITY: Array<[string, string]> = [
	["remote:git@github.com:onlooker-community/onlooker.git", "6a7678979e31"],
	["remote:git@github.com:onlooker-community/ecosystem.git", "ee2cfbe428c7"],
	["remote:git@github.com:onlooker-community/schema.git", "54460a64b16d"],
];

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, stdio: "ignore" });

function repo(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "onlooker-key-")));
	git(dir, "init", "-q");
	git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
	return dir;
}

describe("projectKey", () => {
	it.each(PARITY)("%s -> %s", (input, key) => {
		expect(projectKey(input)).toBe(key);
	});
});

describe("resolveProject", () => {
	it("keys a repo with an origin by its URL exactly as git prints it", () => {
		const dir = repo();
		git(dir, "remote", "add", "origin", "git@github.com:onlooker-community/onlooker.git");
		expect(resolveProject(dir)).toEqual({
			kind: "remote",
			key: "6a7678979e31",
			url: "git@github.com:onlooker-community/onlooker.git",
		});
	});

	it("keys a repo with no origin by its root", () => {
		const dir = repo();
		expect(resolveProject(dir)).toEqual({
			kind: "root",
			key: projectKey(`root:${dir}`),
			root: dir,
		});
	});

	// Problem 2: a session started in a subdirectory names the repo.
	it("resolves a subdirectory to the repo root", () => {
		const dir = repo();
		mkdirSync(join(dir, "src", "deep"), { recursive: true });
		expect(resolveProject(join(dir, "src", "deep"))).toMatchObject({ root: dir });
	});

	// A linked worktree shares its parent's key, as the shell's does.
	it("resolves a linked worktree to the main checkout", () => {
		const dir = repo();
		const wt = `${dir}-wt`;
		git(dir, "worktree", "add", "-q", wt);
		expect(resolveProject(wt)).toMatchObject({ kind: "root", root: dir });
	});

	it("says a deleted directory is missing", () => {
		const dir = repo();
		rmSync(dir, { recursive: true });
		expect(resolveProject(dir)).toEqual({ kind: "none", why: "missing" });
	});

	it("says a plain directory is not a repo", () => {
		const dir = mkdtempSync(join(tmpdir(), "onlooker-plain-"));
		expect(resolveProject(dir)).toEqual({ kind: "none", why: "not-a-repo" });
	});

	it("says when git is not on PATH", () => {
		const dir = repo();
		const path = process.env.PATH;
		process.env.PATH = "";
		try {
			expect(resolveProject(dir)).toEqual({ kind: "none", why: "no-git" });
		} finally {
			process.env.PATH = path;
		}
	});
});
```

- [ ] **Step 2: Run it and check it fails.**
  `pnpm --filter @onlooker/cli test project-key`. Expected: FAIL, module
  not found.

- [ ] **Step 3: Implement** `apps/cli/src/project-key.ts`:

```ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * The project key the ecosystem's hooks write, rebuilt from git (ONL-197).
 *
 * A reimplementation of `onlooker_project_resolve` in the ecosystem's
 * scripts/lib/onlooker-project-key.sh. That file warns that a JS copy which
 * drifted would stop matching, and that is why nothing here is trusted on
 * its own: a key computed here is only ever compared with the key the hook
 * recorded, and a mismatch means no label, never a wrong one.
 */
export type Resolved =
	| { kind: "remote"; key: string; url: string }
	| { kind: "root"; key: string; root: string }
	| { kind: "none"; why: "missing" | "not-a-repo" | "no-git" };

/** First 12 hex of SHA-256, as `_onlooker_sha256_first12` prints it. */
export function projectKey(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

class NoGit extends Error {}

/** Git's stdout without its trailing newline, or null when git said no. */
function git(dir: string, ...args: string[]): string | null {
	try {
		return execFileSync("git", ["-C", dir, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		}).replace(/\n$/, "");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NoGit();
		return null;
	}
}

export function resolveProject(dir: string): Resolved {
	if (!existsSync(dir)) return { kind: "none", why: "missing" };
	try {
		const url = git(dir, "remote", "get-url", "origin");
		if (url) return { kind: "remote", key: projectKey(`remote:${url}`), url };

		if (git(dir, "rev-parse", "--is-inside-work-tree") !== "true") {
			return { kind: "none", why: "not-a-repo" };
		}
		const root = repoRoot(dir);
		if (!root) return { kind: "none", why: "not-a-repo" };
		return { kind: "root", key: projectKey(`root:${root}`), root };
	} catch (error) {
		if (error instanceof NoGit) return { kind: "none", why: "no-git" };
		throw error;
	}
}

/**
 * `onlooker_project_repo_root`: the common dir's parent, real path, so a
 * linked worktree resolves to its main checkout. Falls back to
 * `--show-toplevel` as the shell does.
 */
function repoRoot(dir: string): string | null {
	const common = git(dir, "rev-parse", "--git-common-dir");
	if (common) {
		const absolute = isAbsolute(common) ? common : resolve(dir, common);
		try {
			return realpathSync(dirname(absolute));
		} catch {
			// Falls through to the toplevel, as the shell's does.
		}
	}
	const top = git(dir, "rev-parse", "--show-toplevel");
	if (!top) return null;
	try {
		return realpathSync(top);
	} catch {
		return null;
	}
}
```

  The shell resolves `"$common_dir/.."` with `cd … && pwd -P`, and
  `realpathSync(dirname(absolute))` is equivalent whenever the common dir
  isn't itself a symlink. That's true for every git layout the tests make.

- [ ] **Step 4: Run it.** `pnpm --filter @onlooker/cli test project-key`.
  Expected: PASS. On macOS, `tmpdir()` is a symlink (`/var` → `/private/var`).
  That's why `repo()` takes `realpathSync` first.

- [ ] **Step 5: Commit** `feat(cli): rebuild a project key from git to check it`.

### Task 7: Session-start directories from the event log

**Files:**
- Modify: `apps/cli/src/eventlog.ts` (`readEventEnvelopes`, `streamEnvelopes`)
- Create: `apps/cli/src/label-candidates.ts`
- Test: `apps/cli/src/__tests__/eventlog.test.ts` (add), `apps/cli/src/__tests__/label-candidates.test.ts`

**Interfaces:**
- Produces in `eventlog.ts`:

```ts
export interface SessionStart {
	timestamp: string;
	project: string;
	project_basis: "remote" | "root";
	working_directory: string;
}
export async function readEventEnvelopes(
	env?: NodeJS.ProcessEnv,
	opts?: { onSessionStart?: (start: SessionStart) => void },
): Promise<EventLogEnvelopes>;
```

- Produces in `label-candidates.ts`:

```ts
export interface Candidate {
	key: string;
	basis: "remote" | "root";
	/** Newest first. */
	dirs: string[];
}
export class CandidateCollector {
	constructor(since: string);
	add(start: SessionStart): void;
	candidates(): Candidate[];
}
```

- [ ] **Step 1: Write the failing eventlog test.** In `eventlog.test.ts`,
  using its `withEvents(lines)` (line 19) and `collect(envelopes)` helpers,
  add:

```ts
describe("readEventEnvelopes onSessionStart", () => {
	it("hands session.start directories to the callback and never to the envelope", async () => {
		const env = withEvents([
			{
				event_type: "session.start",
				session_id: "s1",
				timestamp: "2026-11-15T12:00:00.000Z",
				project: "6a7678979e31",
				project_basis: "remote",
				payload: { working_directory: "/src/onlooker" },
			},
			{
				event_type: "tool.used",
				session_id: "s1",
				timestamp: "2026-11-15T12:01:00.000Z",
				project: "6a7678979e31",
				project_basis: "remote",
				payload: { working_directory: "/elsewhere" },
			},
		]);
		const starts: unknown[] = [];
		const { envelopes } = await readEventEnvelopes(env, {
			onSessionStart: (s) => starts.push(s),
		});
		const seen = await collect(envelopes);

		expect(starts).toEqual([
			{
				timestamp: "2026-11-15T12:00:00.000Z",
				project: "6a7678979e31",
				project_basis: "remote",
				working_directory: "/src/onlooker",
			},
		]);
		expect(JSON.stringify(seen)).not.toContain("working_directory");
	});
});
```

- [ ] **Step 2: Write the failing collector test**,
  `label-candidates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CandidateCollector } from "../label-candidates";

const start = (timestamp: string, dir: string, project = "6a7678979e31") => ({
	timestamp,
	project,
	project_basis: "remote" as const,
	working_directory: dir,
});

describe("CandidateCollector", () => {
	it("groups by key and basis, newest directory first, without repeats", () => {
		const c = new CandidateCollector("2026-11-08T00:00:00.000Z");
		c.add(start("2026-11-10T00:00:00.000Z", "/a"));
		c.add(start("2026-11-12T00:00:00.000Z", "/b"));
		c.add(start("2026-11-11T00:00:00.000Z", "/a"));
		expect(c.candidates()).toEqual([
			{ key: "6a7678979e31", basis: "remote", dirs: ["/b", "/a"] },
		]);
	});

	it("drops starts before the window", () => {
		const c = new CandidateCollector("2026-11-08T00:00:00.000Z");
		c.add(start("2026-11-01T00:00:00.000Z", "/old"));
		expect(c.candidates()).toEqual([]);
	});

	it("drops a key that is not 12 hex", () => {
		const c = new CandidateCollector("2026-11-08T00:00:00.000Z");
		c.add(start("2026-11-10T00:00:00.000Z", "/a", "nope"));
		expect(c.candidates()).toEqual([]);
	});
});
```

- [ ] **Step 3: Run both and check they fail.**
  `pnpm --filter @onlooker/cli test eventlog`, then
  `pnpm --filter @onlooker/cli test label-candidates`.

- [ ] **Step 4: Implement the callback.** In `eventlog.ts`, add the
  `SessionStart` interface above `EventLogEnvelopes`:

```ts
/**
 * Where a session started, for project labels alone (ONL-197).
 *
 * The one payload field this module reads, and it does not ride on
 * `EventEnvelope`: `summarizeSessions` must still be unable to see any
 * payload, so the directory goes to a separate callback that only the label
 * code passes. It never leaves the machine. Only the label derived from the
 * repository there is sent, and only after `onlooker project-labels on`.
 */
export interface SessionStart {
	timestamp: string;
	project: string;
	project_basis: "remote" | "root";
	working_directory: string;
}
```

  Give `readEventEnvelopes` a second parameter
  `opts: { onSessionStart?: (start: SessionStart) => void } = {}`, and pass
  `opts.onSessionStart` to `streamEnvelopes(stream, path, opts.onSessionStart)`.
  In `streamEnvelopes`, accept
  `onSessionStart?: (start: SessionStart) => void`. Just before the
  `yield`, compute the narrowed basis into a local (`const basis = …`, the
  same expression the yield uses now) and add:

```ts
			if (onSessionStart && record.event_type === "session.start") {
				const payload = record.payload as Record<string, unknown> | undefined;
				const dir = payload?.working_directory;
				if (typeof record.project === "string" && basis && typeof dir === "string") {
					onSessionStart({
						timestamp: record.timestamp,
						project: record.project,
						project_basis: basis,
						working_directory: dir,
					});
				}
			}
```

  The yield then uses `project_basis: basis`. Extend the "`payload` is never
  read" paragraph of `streamEnvelopes`'s docstring: "except
  `payload.working_directory` on `session.start`, and only when a caller
  passes `onSessionStart`; see `SessionStart`."

- [ ] **Step 5: Implement the collector**, `label-candidates.ts`:

```ts
import type { SessionStart } from "./eventlog";

const KEY = /^[0-9a-f]{12}$/;

/** One key a machine reported, and the directories it was seen in. */
export interface Candidate {
	key: string;
	basis: "remote" | "root";
	/** Newest first, so a directory since deleted is tried after a live one. */
	dirs: string[];
}

/**
 * Folds `session.start` records into label candidates over the same window
 * `reportSessions` reports, fed by `readEventEnvelopes`'s `onSessionStart`
 * so the 200 MB log is read once.
 */
export class CandidateCollector {
	private readonly byKey = new Map<string, { basis: Candidate["basis"]; dirs: Map<string, string> }>();

	constructor(private readonly since: string) {}

	add(start: SessionStart): void {
		if (start.timestamp < this.since || !KEY.test(start.project)) return;
		const id = `${start.project_basis}\n${start.project}`;
		const entry = this.byKey.get(id) ?? { basis: start.project_basis, dirs: new Map() };
		const seen = entry.dirs.get(start.working_directory);
		if (seen === undefined || seen < start.timestamp) {
			entry.dirs.set(start.working_directory, start.timestamp);
		}
		this.byKey.set(id, entry);
	}

	candidates(): Candidate[] {
		return [...this.byKey].map(([id, entry]) => ({
			key: id.slice(id.indexOf("\n") + 1),
			basis: entry.basis,
			dirs: [...entry.dirs]
				.sort((a, b) => b[1].localeCompare(a[1]))
				.map(([dir]) => dir),
		}));
	}
}
```

- [ ] **Step 6: Run both.** Expected: PASS. Then run
  `pnpm --filter @onlooker/cli test sessions` to confirm summarizing is
  unchanged.

- [ ] **Step 7: Commit** `feat(cli): note where each session started, for labels only`.

### Task 8: Consent, client, and the command

**Files:**
- Modify: `apps/cli/src/config.ts`
- Modify: `apps/cli/src/api.ts` (`ApiClient`, `createClient`)
- Create: `apps/cli/src/commands/project-labels.ts`
- Modify: `apps/cli/src/cli.ts` (command list and dispatch, beside `crash-reports`)
- Modify: `apps/cli/src/commands/status.ts` (one field)
- Tests: `apps/cli/src/__tests__/project-labels-command.test.ts`, additions
  to `api.test.ts`, `status.test.ts`, `config.test.ts`

**Interfaces:**
- Consumes: `DERIVATION` from `project-label.ts`.
- Produces in `config.ts`: `CliConfig.projectLabels?: boolean`,
  `CliConfig.projectLabelsPending?: "delete"`.
- Produces in `api.ts`:

```ts
export interface LabelUpload { project_key: string; basis: "remote" | "root"; label: string }
putProjectLabels(labels: LabelUpload[]): Promise<{ stored: number; skipped: number }>;
deleteProjectLabels(): Promise<{ deleted: number }>;
```

- Produces in `commands/project-labels.ts`:
  `WHAT_IS_SENT: string`;
  `describeLabels(config: CliConfig, theme: Theme): string`;
  `projectLabels(action: string | undefined, deps?: { env?; fetchImpl?; theme? }): Promise<string>`.

- [ ] **Step 1: Write the failing tests.** In `config.test.ts`, add a case
  that `readConfig` keeps `projectLabels: true` and
  `projectLabelsPending: "delete"`, and drops `projectLabels: "yes"` and
  `projectLabelsPending: "later"` (both read back `undefined`).

  In `api.test.ts`, using its existing fetch-stub helper, assert that
  `putProjectLabels([{ project_key: "6a7678979e31", basis: "remote", label: "a/b" }])`
  sends `PUT /machine/project-labels` with body
  `{"derivation":1,"labels":[…]}`, and that `deleteProjectLabels()` sends
  `DELETE /machine/project-labels`.

  Create `project-labels-command.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectLabels, WHAT_IS_SENT } from "../commands/project-labels";
import { configPath, readConfig, writeConfig } from "../config";
import { CliError } from "../errors";

const API = "https://api.onlooker.dev";

function linked(): NodeJS.ProcessEnv {
	const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-cli-")) };
	writeConfig({ apiBaseUrl: API, machineToken: "t" }, env);
	return env;
}

function answering(status: number, body: unknown, calls: Request[] = []): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push(new Request(input, init));
		return new Response(JSON.stringify(body), { status });
	}) as typeof fetch;
}

describe("project-labels", () => {
	it("is off until turned on, and says what on sends", async () => {
		const env = linked();
		expect(await projectLabels(undefined, { env })).toMatch(/^Project labels: off/);
		const text = await projectLabels("on", { env });
		expect(readConfig(env).projectLabels).toBe(true);
		expect(text).toContain(WHAT_IS_SENT);
		expect(WHAT_IS_SENT).toMatch(/private/i);
		expect(WHAT_IS_SENT).toMatch(/never/i);
		expect(WHAT_IS_SENT).toMatch(/host/i);
	});

	it("turns off before asking the API to delete", async () => {
		const env = linked();
		await projectLabels("on", { env });
		const calls: Request[] = [];
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			// The choice is on disk before the request leaves.
			expect(readConfig(env).projectLabels).toBe(false);
			calls.push(new Request(input, init));
			return new Response(JSON.stringify({ deleted: 3 }), { status: 200 });
		}) as typeof fetch;
		const text = await projectLabels("off", { env, fetchImpl });
		expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
			"DELETE /machine/project-labels",
		]);
		expect(text).toMatch(/3/);
		expect(readConfig(env).projectLabelsPending).toBeUndefined();
	});

	it("leaves the deletion pending when the API refuses it", async () => {
		const env = linked();
		await projectLabels("on", { env });
		const text = await projectLabels("off", { env, fetchImpl: answering(503, {}) });
		expect(readConfig(env)).toMatchObject({
			projectLabels: false,
			projectLabelsPending: "delete",
		});
		expect(text).toMatch(/pending/i);
		expect(await projectLabels("status", { env })).toMatch(/deletion pending/);
	});

	it("keeps the token and refuses an unknown action", async () => {
		const env = linked();
		await projectLabels("on", { env });
		expect(readConfig(env).machineToken).toBe("t");
		await expect(projectLabels("maybe", { env })).rejects.toThrow(CliError);
		expect(readFileSync(configPath(env), "utf8")).toContain("projectLabels");
	});
});
```

  In `status.test.ts`, add a case that a config with `projectLabels: true`
  prints a `Labels:` line containing `on`.

- [ ] **Step 2: Run them and check they fail.**
  `pnpm --filter @onlooker/cli test project-labels-command`, plus `config`,
  `api` and `status`.

- [ ] **Step 3: Config.** In `CliConfig`, add:

```ts
	/**
	 * Whether `sync` may upload labels derived from this machine's git
	 * remotes (ONL-197). Absent until `onlooker project-labels on|off`;
	 * absent and false both mean nothing is sent.
	 */
	projectLabels?: boolean;
	/**
	 * Set when `off` could not delete what was uploaded. Every later sync
	 * retries the deletion, and uploads nothing, until it succeeds.
	 */
	projectLabelsPending?: "delete";
```

  In `readConfig`'s return, add:

```ts
		projectLabels:
			typeof stored.projectLabels === "boolean" ? stored.projectLabels : undefined,
		projectLabelsPending:
			stored.projectLabelsPending === "delete" ? "delete" : undefined,
```

  Change the "There are three settings" sentence to "There are a handful
  of settings".

- [ ] **Step 4: Client.** In `api.ts`, import `DERIVATION` from
  `./project-label`, add `LabelUpload`, add both methods to `ApiClient`
  with one-line docs, and add to `createClient`'s returned object:

```ts
		putProjectLabels: (labels) =>
			call<{ stored: number; skipped: number }>("/machine/project-labels", {
				method: "PUT",
				body: JSON.stringify({ derivation: DERIVATION, labels }),
			}),
		deleteProjectLabels: () =>
			call<{ deleted: number }>("/machine/project-labels", { method: "DELETE" }),
```

  Any test double that implements `ApiClient` by hand, for example in
  `sync.test.ts`, now needs the two methods. Run `pnpm typecheck` to find
  them.

- [ ] **Step 5: The command**, `commands/project-labels.ts`:

```ts
import { createClient } from "../api";
import { type CliConfig, readConfig, readStoredConfig, writeConfig } from "../config";
import { CliError } from "../errors";
import { muted, ok, PLAIN, type Theme, warn } from "../ui";

export interface ProjectLabelsDeps {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	theme?: Theme;
}

/**
 * What `on` prints, so the choice is made knowing what it sends. The
 * user-facing statement of docs/superpowers/specs/2026-11-15-cli-project-labels-design.md.
 */
export const WHAT_IS_SENT = [
	"Each sync then sends a name for each project this machine reported:",
	"  for a repository with a remote, its owner/repo, private repositories",
	"  included (git@github.com:acme/api.git is sent as acme/api)",
	"  for a repository with no remote, its folder name",
	"",
	"It never sends:",
	"  the remote's host, port or credentials, the full path, or branch names",
	"",
	"A name you give a project on the web always wins over this one.",
	"Turn it off with `onlooker project-labels off`, which also deletes the",
	"names this machine sent.",
].join("\n");

/** One line for `status` and this command. */
export function describeLabels(config: CliConfig, theme: Theme): string {
	if (config.projectLabelsPending === "delete") {
		return warn(theme, "off, deletion pending - the next sync retries it");
	}
	if (config.projectLabels === true) return ok(theme, "on");
	return `off ${muted(theme, "- `onlooker project-labels on` to name projects from git")}`;
}

/**
 * `onlooker project-labels on|off|status`. No argument means `status`.
 *
 * `off` records the choice before it asks the API to delete, so a sync that
 * runs while the request is failing still uploads nothing.
 */
export async function projectLabels(
	action: string | undefined,
	{ env = process.env, fetchImpl, theme = PLAIN }: ProjectLabelsDeps = {},
): Promise<string> {
	if (action !== undefined && !["on", "off", "status"].includes(action)) {
		throw new CliError(
			`unknown action: ${action}. Use onlooker project-labels on, off or status.`,
		);
	}
	if (action === "on") {
		writeConfig({ ...readStoredConfig(env), projectLabels: true }, env);
		return `Project labels: ${describeLabels(readConfig(env), theme)}\n\n${WHAT_IS_SENT}`;
	}
	if (action === "off") {
		writeConfig({ ...readStoredConfig(env), projectLabels: false }, env);
		const deleted = await deleteUploaded(env, fetchImpl);
		const line = `Project labels: ${describeLabels(readConfig(env), theme)}`;
		return deleted === null ? line : `${line}\n${deleted}`;
	}
	return `Project labels: ${describeLabels(readConfig(env), theme)}`;
}

/**
 * Ask the API to delete this machine's labels, and record the outcome. A
 * note to print, or null when the machine is not linked and nothing could
 * have been sent from it.
 */
export async function deleteUploaded(
	env: NodeJS.ProcessEnv,
	fetchImpl?: typeof fetch,
): Promise<string | null> {
	const config = readConfig(env);
	if (!config.machineToken) return null;
	try {
		const { deleted } = await createClient(
			config.apiBaseUrl,
			config.machineToken,
			fetchImpl,
		).deleteProjectLabels();
		const { projectLabelsPending: _done, ...rest } = readStoredConfig(env);
		writeConfig(rest, env);
		return `Deleted ${deleted} ${deleted === 1 ? "name" : "names"} this machine sent.`;
	} catch (error) {
		writeConfig({ ...readStoredConfig(env), projectLabelsPending: "delete" }, env);
		return `Could not delete the names this machine sent: ${(error as Error).message}. Deletion pending; the next sync retries it.`;
	}
}
```

- [ ] **Step 6: Wire it.** In `cli.ts`, import `projectLabels`, add
  `["project-labels", "whether sync may name your projects from git"]` after
  the `crash-reports` entry in the command list, and add a dispatch branch
  after `crash-reports`:

```ts
		} else if (command === "project-labels") {
			show("project-labels", await projectLabels(argv[3], { theme: out }));
```

  In `status.ts`, add after the `Crashes:` field:

```ts
		field("Labels:", describeLabels(config, theme)),
```

  Import `describeLabels`. If `cli.test.ts` snapshots the help text, update
  that expectation to include the new command.

- [ ] **Step 7: Run the CLI suite.** `pnpm --filter @onlooker/cli test`
  and `pnpm typecheck`. Expected: PASS.

- [ ] **Step 8: Commit** `feat(cli): add an opt-in for naming projects from git`.

### Task 9: Sync uploads, and retries a pending deletion

**Files:**
- Create: `apps/cli/src/report-labels.ts`
- Modify: `apps/cli/src/commands/sync.ts` (`reportSessions` takes the
  collector; `sync` calls `reportProjectLabels`; `withNote` adds its note)
- Test: `apps/cli/src/__tests__/report-labels.test.ts`, additions to `sync.test.ts`

**Interfaces:**
- Consumes: `resolveProject` (Task 6), `remoteLabel`/`rootLabel` (Task 5),
  `CandidateCollector`/`Candidate` (Task 7), `ApiClient.putProjectLabels`,
  `deleteUploaded` (Task 8).
- Produces:

```ts
export interface LabelPlan { labels: LabelUpload[]; skipped: Record<string, number> }
export function planLabels(candidates: Candidate[], resolve?: (dir: string) => Resolved): LabelPlan;
export async function reportProjectLabels(
	client: ApiClient,
	env: NodeJS.ProcessEnv,
	candidates: Candidate[],
	fetchImpl?: typeof fetch,
): Promise<string | null>;
```

  Skip reasons are `"directory gone"`, `"remote changed"`, `"not a repo"`,
  `"no name"`, and `"git not found"`.

- [ ] **Step 1: Write the failing `planLabels` tests**,
  `report-labels.test.ts`, with a stub resolver:

```ts
import { describe, expect, it } from "vitest";
import type { Resolved } from "../project-key";
import { planLabels } from "../report-labels";

const K = "6a7678979e31";
const table = (map: Record<string, Resolved>) => (dir: string): Resolved =>
	map[dir] ?? { kind: "none", why: "missing" };

describe("planLabels", () => {
	it("labels a remote key whose recomputed key matches", () => {
		const plan = planLabels(
			[{ key: K, basis: "remote", dirs: ["/a"] }],
			table({ "/a": { kind: "remote", key: K, url: "git@github.com:onlooker-community/onlooker.git" } }),
		);
		expect(plan).toEqual({
			labels: [{ project_key: K, basis: "remote", label: "onlooker-community/onlooker" }],
			skipped: {},
		});
	});

	// The verify step: a remote changed since the session must not be named
	// after the new remote.
	it("skips a key whose directory now resolves to another key", () => {
		const plan = planLabels(
			[{ key: K, basis: "remote", dirs: ["/a"] }],
			table({ "/a": { kind: "remote", key: "ffffffffffff", url: "git@github.com:x/y.git" } }),
		);
		expect(plan).toEqual({ labels: [], skipped: { "remote changed": 1 } });
	});

	it("skips a key whose basis no longer matches", () => {
		const plan = planLabels(
			[{ key: K, basis: "root", dirs: ["/a"] }],
			table({ "/a": { kind: "remote", key: K, url: "git@github.com:x/y.git" } }),
		);
		expect(plan.labels).toEqual([]);
	});

	it("falls back to an older directory when the newest is gone", () => {
		const plan = planLabels(
			[{ key: K, basis: "root", dirs: ["/gone", "/src/notes"] }],
			table({ "/src/notes": { kind: "root", key: K, root: "/src/notes" } }),
		);
		expect(plan.labels).toEqual([{ project_key: K, basis: "root", label: "notes" }]);
		expect(plan.skipped).toEqual({});
	});

	it("counts a key with every directory gone once", () => {
		const plan = planLabels([{ key: K, basis: "root", dirs: ["/x", "/y"] }], table({}));
		expect(plan.skipped).toEqual({ "directory gone": 1 });
	});

	it("skips a local remote that has no name to send", () => {
		const plan = planLabels(
			[{ key: K, basis: "remote", dirs: ["/a"] }],
			table({ "/a": { kind: "remote", key: K, url: "/Users/me/bare.git" } }),
		);
		expect(plan.skipped).toEqual({ "no name": 1 });
	});
});
```

- [ ] **Step 2: Write the failing sync tests.** First teach
  `sync.test.ts`'s stubs the new route. Otherwise `routed()` (line 74)
  treats `/machine/project-labels` as a lesson push and throws parsing the
  body. In `routed`, add `labels?: unknown` to `over`, and before the
  `since=` branch:

```ts
		if (path.endsWith("/machine/project-labels")) {
			return (
				over.labels ?? {
					ok: true,
					status: 200,
					json: async () =>
						init.body ? { stored: 1, skipped: 0 } : { deleted: 1 },
				}
			);
		}
```

  Add `"labels"` to `leg`'s return type, with
  `if (url.endsWith("/machine/project-labels")) return "labels";` as its
  first line. Then add a `describe("sync reports project labels", …)` after
  `"sync reports session summaries"`. Copy that block's `eventEnvelope`,
  `sessionEvents` and `withEventLog` helpers into it, and add:

```ts
	const labelCalls = (fetchImpl: { mock: { calls: unknown[][] } }): FetchCall[] =>
		fetchImpl.mock.calls.filter(([url]) =>
			String(url).endsWith("/machine/project-labels"),
		) as FetchCall[];

	/** A temp repo whose origin is onlooker's, so its key is 6a7678979e31. */
	function onlookerRepo(): string {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "onlooker-sync-repo-")));
		execFileSync("git", ["init", "-q"], { cwd: dir });
		execFileSync(
			"git",
			["remote", "add", "origin", "git@github.com:onlooker-community/onlooker.git"],
			{ cwd: dir },
		);
		return dir;
	}

	/** 25 events (the report threshold) for s1, opening with a session.start in `dir`. */
	function sessionIn(dir: string): Record<string, unknown>[] {
		const [first, ...rest] = sessionEvents("s1", 25).map((e) => ({
			...e,
			project: "6a7678979e31",
			project_basis: "remote",
		}));
		return [{ ...first, event_type: "session.start", payload: { working_directory: dir } }, ...rest];
	}

	const optIn = (env: NodeJS.ProcessEnv, extra: Record<string, unknown> = {}) =>
		writeConfig({ ...readStoredConfig(env), projectLabels: true, ...extra } as CliConfig, env);

	it("sends nothing until opted in", async () => {
		const env = linked();
		withEventLog(env, sessionIn(onlookerRepo()));
		const fetchImpl = accepts();
		await sync({ env, fetchImpl });
		expect(labelCalls(fetchImpl)).toEqual([]);
	});

	it("names a verified repo owner/repo once opted in", async () => {
		const env = linked();
		optIn(env);
		withEventLog(env, sessionIn(onlookerRepo()));
		const fetchImpl = accepts();
		await sync({ env, fetchImpl });
		const [call] = labelCalls(fetchImpl);
		expect(call?.[1].method).toBe("PUT");
		expect(JSON.parse(call?.[1].body ?? "{}")).toEqual({
			derivation: 1,
			labels: [
				{ project_key: "6a7678979e31", basis: "remote", label: "onlooker-community/onlooker" },
			],
		});
	});

	it("finishes a pending deletion instead of uploading", async () => {
		const env = linked();
		optIn(env, { projectLabels: false, projectLabelsPending: "delete" });
		withEventLog(env, sessionIn(onlookerRepo()));
		const fetchImpl = accepts();
		await sync({ env, fetchImpl });
		expect(labelCalls(fetchImpl).map(([, init]) => init.method)).toEqual(["DELETE"]);
		expect(readConfig(env).projectLabelsPending).toBeUndefined();
	});

	it("keeps the deletion pending, and says so, when it is refused", async () => {
		const env = linked();
		optIn(env, { projectLabels: false, projectLabelsPending: "delete" });
		withEventLog(env, sessionIn(onlookerRepo()));
		const fetchImpl = routed({
			labels: { ok: false, status: 503, json: async () => ({}) },
		});
		const text = await sync({ env, fetchImpl });
		expect(readConfig(env).projectLabelsPending).toBe("delete");
		expect(text).toMatch(/pending/i);
	});

	it("sends no labels when the session report was refused", async () => {
		const env = linked();
		optIn(env);
		withEventLog(env, sessionIn(onlookerRepo()));
		const fetchImpl = routed({
			sessions: { ok: false, status: 503, json: async () => ({}) },
		});
		await sync({ env, fetchImpl });
		expect(labelCalls(fetchImpl)).toEqual([]);
	});
```

  Add any imports these need that the file lacks: `execFileSync`,
  `realpathSync`, `readStoredConfig`, `readConfig`, and `type CliConfig`.
  `deleteUploaded` builds its own client from `fetchImpl`, so `sync` must
  pass its `fetchImpl` through (Step 5).

- [ ] **Step 3: Run both and check they fail.**
  `pnpm --filter @onlooker/cli test report-labels`, then
  `pnpm --filter @onlooker/cli test sync`.

- [ ] **Step 4: Implement** `report-labels.ts`:

```ts
import type { ApiClient, LabelUpload } from "./api";
import { deleteUploaded } from "./commands/project-labels";
import { readConfig } from "./config";
import type { Candidate } from "./label-candidates";
import { remoteLabel, rootLabel } from "./project-label";
import { type Resolved, resolveProject } from "./project-key";

export interface LabelPlan {
	labels: LabelUpload[];
	/** Keys not named, by why. */
	skipped: Record<string, number>;
}

const WHY: Record<Extract<Resolved, { kind: "none" }>["why"], string> = {
	missing: "directory gone",
	"not-a-repo": "not a repo",
	"no-git": "git not found",
};

/**
 * Name each candidate whose directory still resolves to the key the session
 * reported (ONL-197, problems 2 and 4). The newest directory is tried first;
 * a key is skipped, once, only when none of its directories verify, and
 * counted under the newest directory's reason.
 */
export function planLabels(
	candidates: Candidate[],
	resolve: (dir: string) => Resolved = resolveProject,
): LabelPlan {
	const plan: LabelPlan = { labels: [], skipped: {} };
	for (const candidate of candidates) {
		let why: string | null = null;
		let label: string | null = null;
		for (const dir of candidate.dirs) {
			const found = resolve(dir);
			let reason: string;
			if (found.kind === "none") {
				reason = WHY[found.why];
			} else if (found.kind !== candidate.basis || found.key !== candidate.key) {
				reason = "remote changed";
			} else {
				label = found.kind === "remote" ? remoteLabel(found.url) : rootLabel(found.root);
				if (label !== null) break;
				reason = "no name";
			}
			why ??= reason;
		}
		if (label !== null) {
			plan.labels.push({ project_key: candidate.key, basis: candidate.basis, label });
		} else if (why !== null) {
			plan.skipped[why] = (plan.skipped[why] ?? 0) + 1;
		}
	}
	return plan;
}

/**
 * Upload this machine's labels, or finish an opt-out, describing the outcome
 * rather than throwing. Non-fatal and never silent, like the other reports;
 * nothing is said when every candidate was named.
 */
export async function reportProjectLabels(
	client: ApiClient,
	env: NodeJS.ProcessEnv,
	candidates: Candidate[],
	fetchImpl?: typeof fetch,
): Promise<string | null> {
	const config = readConfig(env);
	if (config.projectLabelsPending === "delete") {
		const note = await deleteUploaded(env, fetchImpl);
		return readConfig(env).projectLabelsPending === "delete" ? note : null;
	}
	if (config.projectLabels !== true) return null;

	const plan = planLabels(candidates);
	const skipped = Object.entries(plan.skipped)
		.map(([why, n]) => `${why}: ${n}`)
		.join(", ");
	const skippedCount = Object.values(plan.skipped).reduce((a, b) => a + b, 0);
	if (plan.labels.length === 0) {
		return skippedCount === 0 ? null : `Project labels: none sent, ${skippedCount} skipped (${skipped})`;
	}
	try {
		const { stored, skipped: refused } = await client.putProjectLabels(plan.labels);
		const total = skippedCount + refused;
		if (total === 0) return null;
		const parts = refused > 0 ? [skipped, `not reported: ${refused}`].filter(Boolean).join(", ") : skipped;
		return `Project labels: ${stored} sent, ${total} skipped (${parts})`;
	} catch (error) {
		return `Project labels not sent: ${(error as Error).message}`;
	}
}
```

  `deleteUploaded` needs the API base URL and token, which it reads from
  config. That's why it takes `env` rather than the client. A test passes
  `fetchImpl` through `sync`'s deps.

- [ ] **Step 5: Wire it into sync.** In `sync.ts`:
  - give `reportSessions` a third parameter `collector: CandidateCollector`,
    pass `{ onSessionStart: (s) => collector.add(s) }` to
    `readEventEnvelopes(env, …)`, and build `since` before the read so the
    collector shares it. Move the `since` computation into `sync` and pass
    it in, so both use the same value.
  - in `sync`, after `const sessionsNote = await reportSessions(…)`:

```ts
	// Only after the sessions landed: the server names a key only if this
	// machine has reported it, and the report just sent is what says so.
	const labelsNote =
		sessionsNote === null
			? await reportProjectLabels(client, env, collector.candidates(), fetchImpl)
			: null;
```

  - add `notice(labelsNote)` to `withNote`'s array after
    `notice(sessionsNote)`.

  The pending deletion therefore also waits for a successful session
  report. That's acceptable: the deletion is retried on every sync, and a
  failing session report means the API is refusing this machine anyway.

- [ ] **Step 6: Run the CLI suite.** `pnpm --filter @onlooker/cli test`,
  `pnpm typecheck` and `pnpm --filter @onlooker/cli lint`. Expected: PASS.

- [ ] **Step 7: Ablation.** In `planLabels`, temporarily change the verify
  condition to `false`, so
  `found.kind !== candidate.basis || found.key !== candidate.key` is never
  true, and run `pnpm --filter @onlooker/cli test report-labels`. "skips a
  key whose directory now resolves to another key" must FAIL. Restore with
  Edit and rerun to PASS.

- [ ] **Step 8: Commit** `feat(cli): name projects from git on sync, once opted in`.

### Task 10: Release, then verify for real

**Files:**
- Modify: `apps/cli/package.json` (`"version": "2.15.0"`)

- [ ] **Step 1: Bump** `apps/cli/package.json` from `2.14.1` to `2.15.0`
  with Edit, then commit it alone:
  `chore(cli): release 2.15.0 with project labels`.

- [ ] **Step 2: Open PR 2** with `/git-workflow:pr`, body `Refs: ONL-197`.
  The gate "CLI released with its source" needs the bump from Step 1.

- [ ] **Step 3: After merge and release, verify against production.**
  Update the installed CLI. Per memory, a merged release isn't installed
  code: fetch, update, and confirm `onlooker --version` says 2.15.0. Then:
  1. `onlooker project-labels` prints `off`.
  2. `onlooker project-labels on`, then `onlooker sync`. The Projects page
     shows `onlooker-community/onlooker` for `6a7678979e31`.
  3. Name that key on the web. The page shows your name, not the CLI's.
     Clear it, and the CLI's comes back without a reload.
  4. `onlooker project-labels off` reports the number deleted. The Projects
     page shows the hash again for keys this machine alone named.
  5. Record the results in the bead with `bd update onlooker-4n71sc --append-notes`,
     then close ONL-197 in Linear and close the bead.
