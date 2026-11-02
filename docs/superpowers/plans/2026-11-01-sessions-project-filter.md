# Sessions Project Filter (PR 2 of ONL-209) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Narrow the Sessions page to one project, answered by the server, so the filter holds across pages.

**Architecture:** `GET /api/sessions` takes repeatable `project` values and finds matching sessions through `session_projects`. The browser lists entries from `GET /api/projects`, one per name, and sends that entry's keys. Names never reach the query.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, React, vitest.

Spec: `docs/superpowers/specs/2026-11-01-projects-page-design.md`, "PR 2". Linear: ONL-209. PR 3 (Lessons) follows, so this PR does not close the issue.

## Global Constraints

- `project` is repeatable and capped at 40 values. More answers `400`. The spec said 50, but a root value binds two parameters, so 50 root values plus the query's own six cross D1's 100. The spec is amended in Task 1.
- Each value is `<key>` for a remote key or `<machine_id>:<key>` for a root key. `<key>` is `^[0-9a-f]{12}$`. Anything else answers `400 invalid_project`.
- `user_id` scopes both tables. The keyset `(started_at, machine_id, session_id)` does not change.
- A session touching two projects still shows both when one is filtered.
- Tests: run one file with `pnpm --filter @onlooker/api test <name>` or `pnpm --filter @onlooker/web test <name>`, with **no `--`**. The API's Workers pool does not apply `vi.mock`.
- Edit tracked files with Edit/Write, never `sed -i`, heredocs, `biome format --write` or `lint:fix`.
- Commits: `<type>(<scope>): <subject> :emoji:`, subject at most 72 characters counting the shortcode, American English, a why-focused body, `Refs ONL-209`.

---

### Task 1: The server answers a project filter

**Files:**
- Modify: `apps/api/src/db/session-summaries.ts`, `apps/api/src/routes/sessions.ts`, `apps/api/src/routes/sessions.test.ts`
- Modify: `apps/api/src/db/session-projects-query-plan.test.ts`
- Modify: `packages/api-contract/src/index.ts`, `apps/web/src/api/mockApi.ts`
- Modify: `docs/superpowers/specs/2026-11-01-projects-page-design.md`

**Interfaces:**
- Produces: `GET /api/sessions?project=<value>` (repeatable); `ProjectFilter`, `MAX_PROJECT_FILTERS` and `projectFilterClause` from `db/session-summaries.ts`.

- [ ] **Step 1: Write the failing route tests**

In `apps/api/src/routes/sessions.test.ts`, add a `describe("GET /api/sessions?project=")`. Use the file's `signup`, `mint` and `summary` helpers, and push through `POST /machine/sessions` as its neighbors do. Keys: `const REMOTE = "aaaaaaaaaaaa"`, `const OTHER = "bbbbbbbbbbbb"`, `const ROOT = "cccccccccccc"`.

1. `"finds a remote key's sessions on every machine"`: two machines, each with a session on `REMOTE`, and one on `OTHER`. `?project=REMOTE` returns the two.
2. `"finds a root key on its own machine only"`: the same `ROOT` on two machines. `?project=<m1>:ROOT` returns only `m1`'s session.
3. `"does not read a root key as remote, or a remote key as root"`: `?project=ROOT` returns nothing for a root-basis key, and `?project=<m1>:REMOTE` returns nothing for a remote-basis key.
4. `"matches any of several values, each session once"`: one session touching `REMOTE` and `OTHER`, then `?project=REMOTE&project=OTHER` returns it once.
5. `"keeps a session's other projects"`: that session's `counts_by_project` still has both keys when filtered to one.
6. `"pages across a filter, every match once"`: five matching sessions interleaved with five that don't, `limit=2`. Follow `cursor` to the end, and assert the five ids, in order, without repeats, and `has_more` false on the last page.
7. `"never reaches another account's sessions"`: another account's session on `REMOTE` is absent, and `?project=<their machine>:ROOT` returns nothing.
8. `"refuses more than 40 values"`: 41 answers `400` with error code `invalid_project`, and 40 answers `200`.
9. `"refuses a malformed value"`: `nope`, `AAAAAAAAAAAA`, `:aaaaaaaaaaaa` and `m1:` each answer `400`.
10. Beside the existing `counts_by_project` validation tests: a body whose project key is not 12-hex answers `400`, as the existing invalid shapes do. If an existing fixture uses a non-hex key, change the fixture.

Read how the file asserts error bodies and match it.

In `session-projects-query-plan.test.ts`, add:

```ts
describe("a project filter", () => {
	it("starts from session_projects_user_key_idx", async () => {
		const clause = projectFilterClause("u1", [
			{ key: "aaaaaaaaaaaa", machineId: null },
			{ key: "bbbbbbbbbbbb", machineId: "m1" },
		]);
		const { results } = await env.DB.prepare(
			`EXPLAIN QUERY PLAN
			 SELECT session_id FROM session_summaries
			 WHERE user_id = ? AND ${clause.sql}
			 ORDER BY started_at DESC LIMIT 200`,
		)
			.bind("u1", ...clause.binds)
			.all<{ detail: string }>();
		const plan = (results ?? []).map((row) => row.detail).join("\n");

		expect(plan).toContain("session_projects_user_key_idx");
	});
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @onlooker/api test sessions`
Expected: FAIL, because the route ignores `project`.

- [ ] **Step 3: Implement the query**

In `apps/api/src/db/session-summaries.ts`, above `listSessionSummaries`:

```ts
/**
 * How many projects one read may ask for. D1 allows 100 bound parameters: a
 * root key takes two, and the rest of the query takes six.
 */
export const MAX_PROJECT_FILTERS = 40;

/** One project to narrow to. `machineId` is null for a remote key. */
export interface ProjectFilter {
	key: string;
	machineId: string | null;
}

/**
 * Narrows session_summaries to sessions that touched these projects.
 *
 * Through session_projects rather than json_each over counts_by_project, so a
 * rarely used project costs its own rows and not the account's whole history.
 * The basis is part of the match: a root key hashes a local path, so it means
 * nothing away from its machine, and the same hex under the other basis is a
 * different project.
 */
export function projectFilterClause(
	userId: string,
	filters: ProjectFilter[],
): { sql: string; binds: string[] } {
	const remote = filters.filter((filter) => filter.machineId === null);
	const root = filters.filter((filter) => filter.machineId !== null);

	const conditions: string[] = [];
	const binds: string[] = [userId];
	if (remote.length > 0) {
		conditions.push(
			`(basis = 'remote' AND project_key IN (${remote.map(() => "?").join(", ")}))`,
		);
		binds.push(...remote.map((filter) => filter.key));
	}
	for (const filter of root) {
		conditions.push("(basis = 'root' AND machine_id = ? AND project_key = ?)");
		binds.push(filter.machineId as string, filter.key);
	}

	return {
		sql: `(machine_id, session_id) IN (
			SELECT machine_id, session_id FROM session_projects
			WHERE user_id = ? AND (${conditions.join(" OR ")})
		)`,
		binds,
	};
}
```

In `listSessionSummaries`, add `projects?: ProjectFilter[]` to `opts`, and before the cursor block:

```ts
	if (opts.projects && opts.projects.length > 0) {
		const clause = projectFilterClause(userId, opts.projects);
		where += ` AND ${clause.sql}`;
		binds.push(...clause.binds);
	}
```

- [ ] **Step 4: Implement the route**

In `apps/api/src/routes/sessions.ts`, near the top:

```ts
/** A project key as the CLI derives it: the first 12 hex of a SHA-256. */
const PROJECT_KEY = /^[0-9a-f]{12}$/;

/** `<key>` for a remote key, `<machine_id>:<key>` for a root key. */
const PROJECT_VALUE = /^(?:([^:]+):)?([0-9a-f]{12})$/;

/** The `project` values of a read, or throws 400. */
function parseProjectFilters(url: URL): ProjectFilter[] {
	const values = url.searchParams.getAll("project");
	if (values.length > MAX_PROJECT_FILTERS) {
		throw new ApiError(
			400,
			"invalid_project",
			`Ask for at most ${MAX_PROJECT_FILTERS} projects at once`,
		);
	}
	return values.map((value) => {
		const match = PROJECT_VALUE.exec(value);
		if (!match) {
			throw new ApiError(400, "invalid_project", "That is not a project");
		}
		return { key: match[2], machineId: match[1] ?? null };
	});
}
```

In `isValidCountsByProject`, check keys too, so what the filter can ask for and what can be stored agree:

```ts
	return Object.entries(value as Record<string, unknown>).every(
		([key, entry]) => {
			if (!PROJECT_KEY.test(key)) return false;
			if (typeof entry !== "object" || entry === null) return false;
			const count = entry as Record<string, unknown>;
			return (
				(count.basis === "remote" || count.basis === "root") &&
				typeof count.event_count === "number"
			);
		},
	);
```

In `handleGetSessions`, call `parseProjectFilters(url)` before the `try`, and pass `projects` to `listSessionSummaries`. Add the imports.

- [ ] **Step 5: Add the contract and mock**

In `packages/api-contract/src/index.ts`, beside the valid-token sessions case (find it by `sessions: expectArray`), add:

```ts
		{
			name: "sessions, unusable project filter",
			path: "/api/sessions?project=nope",
			init: { method: "GET" },
			status: 400,
			forbidden: NO_SECRETS,
		},
```

In `apps/web/src/api/mockApi.ts`, in the `/api/sessions` branch after the cursor check, mirror the route. It stays empty, so only the rejection needs to match:

```ts
		const projects = query.getAll("project");
		if (
			projects.length > 40 ||
			projects.some((value) => !/^(?:[^:]+:)?[0-9a-f]{12}$/.test(value))
		) {
			throw new AuthApiError(400, "invalid_project", "That is not a project");
		}
```

If the shared contract asserts a stable error code or message for that case, match it in both.

- [ ] **Step 6: Amend the spec**

In `docs/superpowers/specs/2026-11-01-projects-page-design.md`, under "PR 2", change "capped at 50 values" to "capped at 40 values", and add that a root value binds two parameters. In "Tests", change "More than 50 `project` values" to say 40 on Sessions and 50 on Lessons.

- [ ] **Step 7: Run everything this task touches**

Run: `pnpm --filter @onlooker/api test sessions`, `pnpm --filter @onlooker/api test query-plan`, `pnpm --filter @onlooker/api test contract`, `pnpm --filter @onlooker/web test api-contract`, `pnpm typecheck`, `pnpm --filter @onlooker/api lint`.
Expected: all pass.

- [ ] **Step 8: Commit**

```
feat(api): filter sessions by project on the server :mag_right:

Keys live in JSON, so a browser filter could only narrow the loaded page
and call it the history. session_projects answers it across every page.

Refs ONL-209
```

---

### Task 2: The Sessions page filters

**Files:**
- Create: `apps/web/src/lib/projectEntries.ts`, `apps/web/src/components/ProjectFilter.tsx`, `apps/web/src/__tests__/project-entries.test.ts`
- Modify: `apps/web/src/api/sessionsApi.ts`, `apps/web/src/pages/SessionsPage.tsx`, `apps/web/src/__tests__/sessions-page.test.tsx`, `apps/web/src/__tests__/sessions-api.test.ts`

**Interfaces:**
- Consumes: `GET /api/sessions?project=` from Task 1; `listProjects` and `Project` from `projectsApi.ts`; `labelIdentity`, `LabelMap`.
- Produces, for PR 3 too: `projectName`, `projectEntries`, `ProjectEntry`; `ProjectFilter` component.

- [ ] **Step 1: Write the failing helper tests**

Create `apps/web/src/__tests__/project-entries.test.ts` for `projectEntries(projects, labels)`:

1. A key with no name is its own entry, named by the key, and sends the bare key.
2. Two remote keys sharing a name are one entry, with both values.
3. A root key sends `<machine_id>:<key>`.
4. The same root key on two machines with different names is two entries.
5. Entries sort by name, ignoring case.

And for `projectName`: the label under the right identity wins, and a root label doesn't answer for the remote identity.

- [ ] **Step 2: Implement the helper**

Create `apps/web/src/lib/projectEntries.ts`:

```ts
import { type LabelMap, labelIdentity } from "../api/labelsApi";
import type { Project } from "../api/projectsApi";

// What a project filter offers (ONL-209). One entry per name, because someone
// who named an https clone and an ssh clone the same has said they are one.
// The name stops here: the server is sent keys, so a CLI label (ONL-197) can
// only change the grouping.

/** One choice in a filter. */
export interface ProjectEntry {
	name: string;
	/** What `project` carries to the API, for every key under this name. */
	values: string[];
}

/** The user's name for a key, or the key. `machineId` is null when remote. */
export function projectName(
	key: string,
	machineId: string | null,
	labels: LabelMap,
): string {
	return labels.get(labelIdentity(key, machineId)) ?? key;
}

export function projectEntries(
	projects: Project[],
	labels: LabelMap,
): ProjectEntry[] {
	const entries = new Map<string, string[]>();
	for (const { project_key: key, machine_id: machineId } of projects) {
		const name = projectName(key, machineId, labels);
		const value = machineId === null ? key : `${machineId}:${key}`;
		entries.set(name, [...(entries.get(name) ?? []), value]);
	}
	return [...entries]
		.map(([name, values]) => ({ name, values }))
		.sort((a, b) =>
			a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
		);
}
```

In `SessionsPage.tsx`, change `reposOf` to use it, so the filter and the panel cannot disagree:

```ts
		const name = projectName(key, machineId, labels);
```

- [ ] **Step 3: Add the API option**

In `apps/web/src/api/sessionsApi.ts`, add to `ListSessionsOptions`:

```ts
	/** `<key>` or `<machine_id>:<key>` values; see lib/projectEntries.ts. */
	project?: string[];
```

and in `listSessions`, after the limit: `for (const value of options.project ?? []) query.append("project", value);`. Add a case to `sessions-api.test.ts` asserting repeated `project` parameters.

- [ ] **Step 4: Create the control**

Create `apps/web/src/components/ProjectFilter.tsx`. Copy the label and `select` styling from the status filter in `LessonsPage.tsx`, about lines 417-461. Props and behavior:

```tsx
export default function ProjectFilter({
	entries,
	value,
	onChange,
}: {
	entries: ProjectEntry[];
	/** The selected entry's name, or null for every project. */
	value: string | null;
	onChange: (name: string | null) => void;
})
```

A `<label htmlFor="project-filter">Project</label>`, and a `<select id="project-filter">` with `<option value="">All projects</option>` then one option per entry. Empty string maps to null. An entry's option value is its name.

- [ ] **Step 5: Write the failing page tests**

In `sessions-page.test.tsx`, mock `../api/projectsApi` with `mocks.listProjects`, defaulting in `beforeEach` to two remote projects with sessions. Use a `changeProject(name)` helper around `fireEvent.change(screen.getByLabelText("Project"), …)`. Cover:

1. Offers `All projects` plus an entry per name, and leaves out a project with `sessions: 0`.
2. The first load sends no `project`. The existing `{ limit: 200 }` assertions still hold.
3. Choosing an entry calls `listSessions({ limit: 200, project: [KEY] })` and shows what came back.
4. Two keys sharing a name send both values.
5. Load more sends the same `project` and the cursor.
6. Choosing again clears the cursor: a Load more after it sends the new page's cursor.
7. A slow first filter's response landing after a second choice is ignored. Use deferred promises.
8. A slow Load more landing after a filter change is not appended.
9. An empty filtered result shows `No sessions in <name>`, keeps the filter, and doesn't show a machine empty state.
10. A failed filtered load shows the error, keeps the filter, and choosing `All projects` recovers.
11. Renaming the selected project so its name is gone falls back to all projects.
12. A failed `listProjects` hides the filter and leaves the page working.

- [ ] **Step 6: Implement the page**

In `SessionsPage.tsx`:

Add state, beside `labels`:

```ts
	// Empty until read, and empty if the read fails: the filter then doesn't
	// show, and the page is what it was without one.
	const [projects, setProjects] = useState<Project[]>([]);
	// A name rather than an entry, so a rename that regroups keys can't leave a
	// stale set of keys behind: `entry` below is always read from current names.
	const [selected, setSelected] = useState<string | null>(null);
	const [filterError, setFilterError] = useState<string | null>(null);
	const latestFilter = useRef("");
```

Derive, after the state. A project with no sessions has nothing to show here:

```ts
	const entries = projectEntries(
		projects.filter((project) => project.sessions > 0),
		labels,
	);
	const entry = entries.find((option) => option.name === selected) ?? null;
	// A string, so the effect below reruns when the keys change and not on
	// every render. `\n` can't appear in a value.
	const filterKey = entry?.values.join("\n") ?? "";
```

Replace the first read in the mount effect with a second effect, and add `listProjects` to the mount effect in the same quiet style as `listLabels`. Update the "this screen has no filter" comment, because it now does:

```ts
	// Reruns per filter. `active` is what drops a slow answer to the previous
	// choice. The rows stay until the new ones land, so the control keeps its
	// focus and the page doesn't flash a loading state.
	useEffect(() => {
		let active = true;
		latestFilter.current = filterKey;
		setFilterError(null);
		setMoreError(null);
		listSessions({
			limit: 200,
			...(filterKey ? { project: filterKey.split("\n") } : {}),
		})
			.then((page) => {
				if (!active) return;
				setSessions(page.sessions);
				setCursor(page.has_more ? page.cursor : null);
				setHasMore(page.has_more);
				setEnded(false);
			})
			.catch((error: unknown) => {
				if (!active) return;
				const message = describeError(error, "Could not load your sessions.");
				// Filtered, the failure belongs under the control, because a
				// full-page error would take away the way back to all projects.
				if (filterKey) {
					setSessions([]);
					setCursor(null);
					setHasMore(false);
					setFilterError(message);
				} else {
					setLoadError(message);
				}
			});
		return () => {
			active = false;
		};
	}, [filterKey]);
```

In `loadMore`, capture and compare, so a page for the previous filter is dropped:

```ts
		const requested = filterKey;
		…
			const page = await listSessions({
				cursor,
				limit: 200,
				...(requested ? { project: requested.split("\n") } : {}),
			});
			if (latestFilter.current !== requested) return;
```

Also skip the error and `setLoadingMore(false)` handling correctly for a dropped page: `finally` still clears `loadingMore`, and in `catch`, return early when `latestFilter.current !== requested`.

Clear `loadError` when a selection changes is not needed: an unfiltered load failure replaces the page, so the control isn't reachable.

Change the empty branch's condition to `if (sessions.length === 0 && !entry)`, so the machine empty states stay about an unfiltered account.

In the main return, as the first child of the grid:

```tsx
			{entries.length > 0 ? (
				<ProjectFilter
					entries={entries}
					value={entry?.name ?? null}
					onChange={setSelected}
				/>
			) : null}

			{filterError ? (
				<div role="alert" style={{ color: PALETTE.danger }}>
					{filterError}
				</div>
			) : null}

			{entry && sessions.length === 0 && !filterError ? (
				<EmptyState title={`No sessions in ${entry.name}`}>
					Sessions past the last 180 days are gone, and anything the CLI
					reported before it knew about repositories has no project.
				</EmptyState>
			) : null}
```

Render `SessionsSummary`, `RepositoriesSummary` and `LoadMore` only when `sessions.length > 0`, as those components assume rows.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @onlooker/web test project-entries`, `pnpm --filter @onlooker/web test sessions-page`, `pnpm --filter @onlooker/web test sessions-api`, `pnpm --filter @onlooker/web test shell-headings`.
Expected: PASS.

- [ ] **Step 8: Run the full checks**

Run: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `bash scripts/source-guards.test.sh`.
Expected: all pass. Fix any formatting by hand with Edit.

- [ ] **Step 9: Commit**

```
feat(web): filter sessions by project :dart:

Everything on the page is the loaded window, so finding one repository
meant loading the history. This asks the server, by name.

Refs ONL-209
```
