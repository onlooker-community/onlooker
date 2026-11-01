# Projects Page (PR 1 of ONL-209) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give project keys a queryable shape in `session_projects`, and a `/projects` page that lists them with their names, where they were seen and their activity.

**Architecture:** A join table, written in the same D1 batch as each session summary and backfilled in its migration. `GET /api/projects` reads it and adds labeled keys. The page reads that, the labels and the machines, and shares its naming editor with Sessions.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, drizzle, React, vitest.

Spec: `docs/superpowers/specs/2026-11-01-projects-page-design.md`. Linear: ONL-209. PR 2 (Sessions filter) and PR 3 (Lessons filter) get their own plans. This PR does not close ONL-209.

## Global Constraints

- `session_projects` columns: `user_id`, `machine_id`, `session_id`, `project_key`, `basis`, `event_count`. Primary key `(machine_id, session_id, project_key)`. Composite foreign key to `session_summaries (machine_id, session_id)`, `ON DELETE CASCADE`. Index on `(user_id, project_key)`.
- `GET /api/projects` is session-authenticated and returns `{ projects: Project[] }`, where `Project` is `{ project_key, basis: "remote" | "root" | null, machine_id: string | null, sessions, events, last_seen_at: string | null }`.
- A remote key gives one row. A root key gives one row per machine. Only the viewer's data is ever listed. Names are not in this response.
- `basis: null` is reserved for PR 3's lesson-only keys. This PR never produces it, but the type and the page handle it.
- Tests: run one file with `pnpm --filter @onlooker/api test <name>` or `pnpm --filter @onlooker/web test <name>`, with **no `--`**. The API's Workers pool does not apply `vi.mock`.
- Edit tracked files with Edit/Write, never `sed -i`, heredocs, `biome format --write` or `lint:fix`. Generated migration files come from the generators below.
- Commits: `<type>(<scope>): <subject> :emoji:`, subject ≤72 characters, American English, a why-focused body, `Refs ONL-209`. Not `Fixes`: two PRs follow.

---

### Task 1: The table, the writes and the route

**Files:**
- Modify: `packages/db/src/schema.ts`, `packages/db/src/__tests__/schema.test.ts` if it lists tables exactly
- Create (generated): `packages/db/migrations/0020_*.sql`, snapshot, journal, expected schema
- Modify: `apps/api/src/db/session-summaries.ts`
- Create: `apps/api/src/db/projects.ts`, `apps/api/src/db/projects.test.ts`, `apps/api/src/routes/projects.ts`, `apps/api/src/routes/projects.test.ts`
- Modify: `apps/api/src/routes/index.ts`, `apps/api/src/router.ts`
- Modify: `packages/api-contract/src/index.ts`, `apps/web/src/api/mockApi.ts`

**Interfaces:**
- Produces: `session_projects` (drizzle table); `listProjects(db, userId): Promise<Project[]>`; `handleGetProjects`; the exported `Project` type in `apps/api/src/db/projects.ts`.

- [ ] **Step 1: Add the table and generate the migration**

In `packages/db/src/schema.ts`, directly after `session_summaries` (import `foreignKey` from `drizzle-orm/sqlite-core`), add:

```ts
/**
 * One row per project a session touched, so a project can be found without
 * reading JSON.
 *
 * counts_by_project stays the session's own record; this is its index, written
 * in the same batch by putSessionSummaries and replaced whole on each sync,
 * because a session's keys and counts both change while it runs. Cascades from
 * the summary, so pruning and account deletion need nothing of their own.
 *
 * Rows that predate counts_by_project have no keys and so no rows here, which
 * is what "no project was attributable" already means.
 */
export const session_projects = sqliteTable(
	"session_projects",
	{
		user_id: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		machine_id: text("machine_id").notNull(),
		session_id: text("session_id").notNull(),
		/** The 12-hex key, as counts_by_project carries it. */
		project_key: text("project_key").notNull(),
		/** 'remote' or 'root'. See ProjectCount in apps/api. */
		basis: text("basis").notNull(),
		event_count: integer("event_count").notNull(),
	},
	(table) => ({
		pk: primaryKey({
			columns: [table.machine_id, table.session_id, table.project_key],
		}),
		sessionFk: foreignKey({
			columns: [table.machine_id, table.session_id],
			foreignColumns: [session_summaries.machine_id, session_summaries.session_id],
		}).onDelete("cascade"),
		// /api/projects, and PR 2's filter: this user's rows for a key.
		userKeyIdx: index("session_projects_user_key_idx").on(
			table.user_id,
			table.project_key,
		),
	}),
);
```

Add `SessionProject` types beside the others if the file exports one for each table.

Run: `pnpm --filter @onlooker/db generate:migrations`, then `pnpm --filter @onlooker/db build`, then `pnpm --filter @onlooker/db generate:expected-schema`.
Expected: one new migration creating the table and its index.

Then, with Edit, append the backfill as the migration's last statement, after a `--> statement-breakpoint` line:

```sql
INSERT INTO `session_projects` (`user_id`, `machine_id`, `session_id`, `project_key`, `basis`, `event_count`)
SELECT s.`user_id`, s.`machine_id`, s.`session_id`, j.key,
       json_extract(j.value, '$.basis'), json_extract(j.value, '$.event_count')
  FROM `session_summaries` s, json_each(s.`counts_by_project`) j
 WHERE json_valid(s.`counts_by_project`);
```

`json_valid` because one malformed row would otherwise fail the whole migration, and with it the deploy.

- [ ] **Step 2: Write the failing DB tests**

Create `apps/api/src/db/projects.test.ts`. In `beforeEach`, delete `session_projects`, `session_summaries`, `project_labels`, `machine_tokens` and `users`, in that order, then create a user with `createUser` and a machine with `createMachineToken`. Add a helper that calls `putSessionSummaries` with this fixture (the `SessionSummaryInput` fields, as `machine-tokens.test.ts` builds them, about line 227), taking `session_id`, `started_at` and `counts_by_project`.

Name the keys `const REMOTE = "aaaaaaaaaaaa"`, `const ROOT = "bbbbbbbbbbbb"`. Cover:

1. `"writes a row per project a session touched"`: one session with both keys. `session_projects` holds two rows with the right `basis` and `event_count`.
2. `"replaces a session's rows on the next sync"`: sync with both keys, then the same session with only `REMOTE` and a higher count. One row, with the new count. This is why the write deletes first.
3. `"leaves other sessions' rows alone"`: re-syncing one session does not touch another's rows.
4. `"writes nothing for a session with no projects"`, including an omitted `counts_by_project`. Also `"takes a session touching twenty projects"`, which a single multi-row insert would fail on D1's parameter limit.
5. `"goes with its summary"`: delete the `session_summaries` row, and the `session_projects` rows go.
6. `listProjects`:
   - `"adds a remote key up across machines"`: two machines, one row, sessions and events summed, `machine_id` null, `last_seen_at` the latest `started_at`.
   - `"keeps a root key per machine"`: two machines, the same root key, two rows, each with its `machine_id`.
   - `"lists only this user's projects"`.
   - `"keeps a labeled key past retention"`: `setProjectLabel` with no sessions gives a row with zero sessions and events and null `last_seen_at`; a remote label has `basis: "remote"` and `machine_id: null`, a root label `basis: "root"` and its machine. A label on a key that has sessions does not add a second row.
   - `"lists the most recently seen first, and never-seen last"`.

Add a backfill test, in the style of `apps/api/src/db/backfill.test.ts`: take the statement with `env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0020_"))?.queries.at(-1)`, seed a `session_summaries` row directly with raw SQL so no `session_projects` row exists (a session with two keys, and one with `'{}'`), run it, and assert two rows for the first and none for the second.

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm --filter @onlooker/api test projects`
Expected: FAIL, because `./projects.js` does not exist. Note this pattern also matches `project-labels.test.ts`.

- [ ] **Step 4: Implement the write**

In `apps/api/src/db/session-summaries.ts`, import `session_projects`, and `and`/`eq` if needed. Keep the upsert as it is, but build the batch as a flat list. Replace `const statements = summaries.map((summary) => {` so each summary yields its upsert, then its replacement:

```ts
	const statements = summaries.flatMap((summary) => {
		// …the existing `row` object…

		const upsert = drizzle /* …the existing insert…onConflictDoUpdate */;

		// Replaced whole rather than upserted: a key can drop out of a session
		// between syncs, and an upsert would leave it behind. After the summary,
		// because the foreign key needs it on a first report.
		const clear = drizzle
			.delete(session_projects)
			.where(
				and(
					eq(session_projects.machine_id, machineId),
					eq(session_projects.session_id, summary.session_id),
				),
			);
		// One insert per key rather than one multi-row insert: six parameters
		// a row would cross D1's 100 on a session touching seventeen projects.
		const inserts = Object.entries(summary.counts_by_project ?? {}).map(
			([project_key, count]) =>
				drizzle.insert(session_projects).values({
					user_id: userId,
					machine_id: machineId,
					session_id: summary.session_id,
					project_key,
					basis: count.basis,
					event_count: count.event_count,
				}),
		);

		return [upsert, clear, ...inserts];
	});
```

Keep the existing `batch` call and its comment. If the tuple cast needs adjusting for the mixed statement types, adjust it the smallest way that typechecks. Mention `session_projects` in the function's doc comment.

- [ ] **Step 5: Implement the read and route**

Create `apps/api/src/db/projects.ts`:

```ts
import type { D1Database } from "@cloudflare/workers-types";
import { listProjectLabels } from "./project-labels.js";

/**
 * One project as the Projects page lists it (ONL-209).
 *
 * A remote key means the same repository on every machine, so it has one row.
 * A root key hashes a local path, so it has one per machine.
 *
 * `basis` is null for a key known only from a lesson, which records none.
 */
export interface Project {
	project_key: string;
	basis: "remote" | "root" | null;
	machine_id: string | null;
	sessions: number;
	events: number;
	last_seen_at: string | null;
}

/**
 * This user's projects, most recently seen first.
 *
 * Labels are read too, so a project does not vanish once its sessions pass
 * retention: the name is the user's, and it should stay findable.
 */
export async function listProjects(
	db: D1Database,
	userId: string,
): Promise<Project[]> {
	const { results } = await db
		.prepare(
			`SELECT p.project_key, p.basis,
			        CASE p.basis WHEN 'root' THEN p.machine_id END AS machine_id,
			        COUNT(*) AS sessions,
			        SUM(p.event_count) AS events,
			        MAX(s.started_at) AS last_seen_at
			   FROM session_projects p
			   JOIN session_summaries s
			     ON s.machine_id = p.machine_id AND s.session_id = p.session_id
			  WHERE p.user_id = ?
			  GROUP BY p.project_key, p.basis,
			           CASE p.basis WHEN 'root' THEN p.machine_id END`,
		)
		.bind(userId)
		.all<Project>();

	const identity = (key: string, machineId: string | null) =>
		`${machineId ?? ""}\n${key}`;
	const seen = new Set(
		results.map((row) => identity(row.project_key, row.machine_id)),
	);
	const labeled: Project[] = (await listProjectLabels(db, userId))
		.filter((label) => !seen.has(identity(label.project_key, label.machine_id)))
		.map((label) => ({
			project_key: label.project_key,
			basis: label.machine_id === null ? "remote" : "root",
			machine_id: label.machine_id,
			sessions: 0,
			events: 0,
			last_seen_at: null,
		}));

	// ISO timestamps sort as text. Never seen goes last, then by key so the
	// order is stable.
	return [...results, ...labeled].sort(
		(a, b) =>
			(b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? "") ||
			a.project_key.localeCompare(b.project_key),
	);
}
```

Create `apps/api/src/routes/projects.ts`:

```ts
import type { Principal } from "../db/pool.js";
import { listProjects } from "../db/projects.js";
import type { RouteParams, WorkerEnv } from "../types";

/**
 * GET /api/projects
 *
 * The viewer's own projects (ONL-209). Declared `auth: "session"`, like
 * GET /api/project-labels.
 */
export async function handleGetProjects(
	_request: Request,
	env: WorkerEnv,
	_params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	// The router resolved this from the route's `auth: "session"`, which throws
	// rather than returning null, so it cannot be null here.
	const { userId } = principal as Principal;
	return Response.json({ projects: await listProjects(env.DB, userId) });
}
```

Export it from `routes/index.ts`, and add to `router.ts`, before the `GET /api/project-labels` route:

```ts
	{
		method: "GET",
		path: "/api/projects",
		auth: "session",
		cors: "app",
		handler: handleGetProjects,
	},
```

- [ ] **Step 6: Add the contract and mock**

In `packages/api-contract/src/index.ts`, add beside `"project labels, no token"`:

```ts
		{
			name: "projects, no token",
			path: "/api/projects",
			init: { method: "GET" },
			status: 401,
		},
```

and beside `"project labels, valid token"`:

```ts
		{
			name: "projects, valid token",
			path: "/api/projects",
			init: { method: "GET" },
			status: 200,
			// An array even with nothing reported: the page's empty state reads
			// its length, and a missing key throws.
			body: { projects: expectArray },
			forbidden: NO_SECRETS,
		},
```

In `apps/web/src/api/mockApi.ts`, before the `/api/project-labels` GET branch, add a branch for `GET /api/projects` that maps `labelsOf(email)` to projects with zero activity, as `listProjects` does. The mock holds no sessions (see its `/api/sessions` comment), so labels are all it can list. Say so in a comment.

Create `apps/api/src/routes/projects.test.ts`, in the style of `project-labels.test.ts`: a signed-in caller gets `{ projects: [] }`, and a machine token answers `401`.

- [ ] **Step 7: Run everything this task touches**

Run: `pnpm --filter @onlooker/api test projects`, `pnpm --filter @onlooker/api test sessions`, `pnpm --filter @onlooker/api test contract`, `pnpm --filter @onlooker/api test schema`, `pnpm --filter @onlooker/db test`, `pnpm --filter @onlooker/web test api-contract`, `pnpm typecheck`, `pnpm --filter @onlooker/api lint`.
Expected: all pass.

- [ ] **Step 8: Commit**

Stage the named and generated files, with a message like:

```
feat(api): index projects by session and list them :card_index:

counts_by_project is JSON, so nothing could find a project without reading
every session. A table beside it answers the Projects page now, and the
filters next.

Refs ONL-209
```

---

### Task 2: The page

**Files:**
- Create: `apps/web/src/api/projectsApi.ts`, `apps/web/src/components/ProjectName.tsx`, `apps/web/src/pages/ProjectsPage.tsx`, `apps/web/src/__tests__/projects-page.test.tsx`
- Modify: `apps/web/src/components/RepositoriesSummary.tsx`, `apps/web/src/components/sections.ts`, `apps/web/src/App.tsx`, `apps/web/src/__tests__/shell-headings.test.tsx`
- Modify: `packages/brand/index.ts` only if Briefcase is not already in `UNPLATED_ICONS`

**Interfaces:**
- Consumes: `GET /api/projects` from Task 1; `listLabels`, `setLabel`, `labelIdentity` from `labelsApi.ts`; `listMachines`.
- Produces: `listProjects(): Promise<{ projects: Project[] }>`; `RepositoryName` and `NameEditor` exported from `components/ProjectName.tsx`.

- [ ] **Step 1: Move the naming controls**

Create `apps/web/src/components/ProjectName.tsx`, and move `RepositoryName` and `NameEditor` from `RepositoriesSummary.tsx` there unchanged, exported. Change their `project` prop's type to a new exported type:

```ts
/** What naming needs of a project: `ProjectRollup` and a listed project both fit. */
export type NamedProject = { key: string; machineId: string | null };
```

`onRename` takes `NamedProject`. Import them back in `RepositoriesSummary.tsx`, and remove imports it no longer uses.

Run: `pnpm --filter @onlooker/web test sessions-page`
Expected: PASS, unchanged. This is a move, so do it first and on its own.

- [ ] **Step 2: Write the failing page tests**

Create `apps/web/src/__tests__/projects-page.test.tsx`, mocking `../api/projectsApi`, `../api/labelsApi` (keep the real `labelIdentity`, via `vi.importActual`) and `../api/machinesApi`, in the style of `machines-page.test.tsx`. Cover:

1. A key with no name shows the key, and sessions, events and when it was last seen.
2. A named key shows its name, with the key still visible.
3. Two keys sharing a name are two rows: this page lists keys.
4. A remote key says `Every machine`. A root key says `<machine name> only`, using the same wording as the By repository panel.
5. A `basis: null` row says `Seen on a lesson`.
6. A root key on a machine with `removed_at` set still shows that machine's name.
7. Renaming calls `setLabel(key, machineId, name)` and shows the stored name. Root keys pass their machine id.
8. A failed load shows `Could not load your projects`.
9. No projects shows the empty state, title `No projects yet`.

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm --filter @onlooker/web test projects-page`
Expected: FAIL, because the modules do not exist.

- [ ] **Step 4: Implement**

Create `apps/web/src/api/projectsApi.ts`:

```ts
import { apiClient } from "./client";

// The viewer's project keys and their activity (ONL-209). Names come from
// labelsApi.ts: a name is the user's, this is what the server saw.

export const PROJECT_ENDPOINTS = {
	projects: "/api/projects",
} as const;

/** `basis` is null for a key known only from a lesson, which records none. */
export interface Project {
	project_key: string;
	basis: "remote" | "root" | null;
	machine_id: string | null;
	sessions: number;
	events: number;
	last_seen_at: string | null;
}

export function listProjects(): Promise<{ projects: Project[] }> {
	return apiClient.get<{ projects: Project[] }>(PROJECT_ENDPOINTS.projects);
}
```

Create `apps/web/src/pages/ProjectsPage.tsx`, modeled on `SessionsPage.tsx`'s loading (`EmptyState`, `Loading`, `Panel` from `../components/ui`, `describeError`, `plural` from `../lib/sessionRollup`, `When` as `MachinesPage` uses it):

- Default export `ProjectsPage`. On mount, load `listProjects()`, `listLabels()` and `listMachines()` together. A failed projects read shows `<EmptyState title="Could not load your projects">`. A failed labels or machines read is not fatal: fall back to no labels, or to `one machine`, as `SessionsPage` does.
- `projects === null` shows `<Loading label="Loading your projects…" />`.
- An empty list shows `<EmptyState title="No projects yet">`, with: `A project appears here once a machine reports a session in a repository.`
- Otherwise, a `<Panel title="Your projects" icon="Briefcase">` holding a `ul`, one `li` per project, keyed `${project.machine_id ?? ""}:${project.project_key}`. Each row has:
  - `RepositoryName` or `NameEditor`, with one row editing at a time, as in `RepositoriesSummary`.
  - The key, in `var(--font-data)`, when the row has a name. `RepositoryName` already shows it when there is none.
  - Where it was seen: `Every machine` for `remote`, `${machine name ?? "one machine"} only` for `root`, `Seen on a lesson` for `null`.
  - `plural(project.sessions, "session")`, `plural(project.events, "event")`, and `Last seen <When iso={…} />` when `last_seen_at` is set.
- `rename` calls `setLabel(project.key, project.machineId, label)`, then updates the label map with what the server stored, the way `SessionsPage`'s `rename` does. Read that function and match it.

Add to `sections.ts`, directly after the Sessions entry, with a comment saying it reuses the By repository panel's icon:

```ts
	{ to: "/projects", label: "Projects", icon: "Briefcase" },
```

In `apps/web/src/App.tsx`, lazy-load or import `ProjectsPage` the way `SessionsPage` is, and add its `<Protected>` route after `/sessions`.

In `shell-headings.test.tsx`, add a stub:

```ts
vi.mock("../api/projectsApi", () => ({
	PROJECT_ENDPOINTS: { projects: "/api/projects" },
	listProjects: () => Promise.resolve({ projects: [] }),
}));
```

If Briefcase is not in `UNPLATED_ICONS`, add it to `packages/brand/index.ts` with a comment, and let `packages/brand/assets.test.ts` decide. If it fails the coverage floor, stop and report rather than choosing another icon.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @onlooker/web test projects-page`, `pnpm --filter @onlooker/web test shell-headings`, `pnpm --filter @onlooker/web test sessions-page`.
Expected: PASS.

- [ ] **Step 6: Run the full checks**

Run: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `bash scripts/source-guards.test.sh`.
Expected: all pass. Fix any formatting by hand with Edit.

- [ ] **Step 7: Commit**

Two commits. The move (Step 1) first:

```
refactor(web): move the project naming controls out of the panel :package:

The Projects page needs them too.

Refs ONL-209
```

Then the page:

```
feat(web): list your projects on their own page :briefcase:

A name could only be found or changed on Sessions, and only for a project
in the sessions loaded there. This lists every project the server knows.

Refs ONL-209
```
