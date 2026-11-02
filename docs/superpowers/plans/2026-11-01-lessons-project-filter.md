# Lessons Project Filter (PR 3 of ONL-209) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Narrow the Lessons page to one project, answered by the server, without showing anyone a project that isn't theirs.

**Architecture:** `lessons.project_key` lifts the key out of `body`. `GET /api/lessons?project=` narrows `readPool` on top of `visibilityPredicate`, never instead of it. `GET /api/projects` gains the viewer's lesson keys, and `LessonsPage` reuses `ProjectFilter` and `projectEntries`.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Drizzle, React, vitest.

Spec: `docs/superpowers/specs/2026-11-01-projects-page-design.md`, "PR 3". Linear: ONL-209. This is the last PR, so it closes the issue.

## Global Constraints

- `project` is repeatable and capped at 39 values. More answers `400 invalid_project`. The spec said 50, but this read already binds up to 59 parameters (2 user ids, 50 orgs, 4 statuses, 2 cursor, 1 limit) and the filter adds 2 more user ids, so 39 is what fits in D1's 100. Task 2 amends the spec.
- Each value is a bare key, `^[0-9a-f]{12}$`. A lesson stores no machine, so `<machine_id>:<key>` answers `400 invalid_project` here.
- The filter is added to `visibilityPredicate`, never replaces it, and is applied in `readPool`, which stays the only path to a lesson body.
- A viewer's own lesson matches by key. Someone else's lesson matches only if the viewer's `session_projects` holds that key with basis `remote`. A root key on someone else's lesson never matches: it hashes a local path, so equal hex is not the same repository.
- `nameForKey` does not change.
- Tests: run one file with `pnpm --filter @onlooker/api test <name>` or `pnpm --filter @onlooker/web test <name>`, with **no `--`**. The API's Workers pool does not apply `vi.mock`.
- Edit tracked files with Edit/Write, never `sed -i`, heredocs, `biome format --write` or `lint:fix`. Generated migrations and schema come from their commands.
- Commits: `<type>(<scope>): <subject> :emoji:`, subject at most 72 characters counting the shortcode, American English, a why-focused body, `Refs ONL-209`.

---

### Task 1: Lessons carry their project key

**Files:**
- Modify: `packages/db/src/schema.ts`, `apps/api/src/db/lessons.ts`, `apps/api/src/db/projects.ts`
- Generated: `packages/db/migrations/0021_*.sql` and its meta, the expected schema
- Test: `apps/api/src/db/lessons.test.ts`, `apps/api/src/routes/projects.test.ts`, the migration backfill test (follow how 0020's backfill or `apps/api/src/db/backfill.test.ts` is tested)

**Interfaces:**
- Produces: `lessons.project_key` (text, nullable); index `lessons_project_key_idx` on `(project_key, promoted_at, id)`; `Project` rows with `basis: null` for lesson-only keys.

- [ ] **Step 1: Write the failing tests**

1. `createLessonsWithFeed` stores `evidence.project_key` in `lessons.project_key`.
2. Backfill: a row with `project_key` NULL and the key in `body` gets the key. A row with an unparsable `body` stays NULL and does not fail the migration.
3. In `routes/projects.test.ts`:
   - `"lists a key known only from the caller's lesson"`: one row, `basis: null`, `machine_id: null`, `sessions: 0`, `events: 0`, `last_seen_at: null`.
   - `"does not repeat a lesson's key that also has sessions"`: a lesson on a key with session rows on two machines under basis `root` gives those two rows and no third. The same for a remote key: one row.
   - `"does not repeat a lesson's key that has only a label"`: one row, the label's.
   - `"never lists another account's lesson keys"`, including a public one.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @onlooker/api test lessons`, `pnpm --filter @onlooker/api test projects`
Expected: FAIL.

- [ ] **Step 3: Add the column**

In `packages/db/src/schema.ts`, in `lessons` after `org_id`:

```ts
		// Lifted out of `body` because the project filter narrows on it (ONL-209).
		// Immutable, like promoted_at. Nullable because SQLite needs a default
		// to add a NOT NULL column, and an empty default would claim a project.
		// A row written between the migration and the API deploy stays NULL.
		project_key: text("project_key"),
```

and, beside the other indexes:

```ts
		projectKeyIdx: index("lessons_project_key_idx").on(
			table.project_key,
			table.promoted_at,
			table.id,
		),
```

Run: `pnpm --filter @onlooker/db generate:migrations`, then `pnpm --filter @onlooker/db build`. Add the backfill to the end of the generated migration with Edit, as the migration's last statement, with a `--> statement-breakpoint` before it as the file's other statements have:

```sql
UPDATE lessons
SET project_key = json_extract(body, '$.evidence.project_key')
WHERE json_valid(body);
```

Then run `pnpm --filter @onlooker/db generate:expected-schema`.

- [ ] **Step 4: Write it at ingest**

In `createLessonsWithFeed`, add `project_key` to the column list, one more `?`, and bind `lesson.evidence.project_key` after `orgId`'s value. Extend the "same value as their copy inside body" comment to cover it. Check `scripts/source-guards.test.sh`, which mentions `INSERT INTO lessons`, and update it only if the guard needs to.

- [ ] **Step 5: List lesson keys**

In `apps/api/src/db/projects.ts`, after `labeled`:

```ts
	// By key, not identity: a lesson stores no machine, so its key is already
	// listed if any machine's sessions or any label hold it.
	const listed = new Set(
		[...results, ...labeled].map((row) => row.project_key),
	);
	const { results: lessonKeys } = await db
		.prepare(
			`SELECT DISTINCT project_key FROM lessons
			  WHERE user_id = ? AND project_key IS NOT NULL`,
		)
		.bind(userId)
		.all<{ project_key: string }>();
	const fromLessons: Project[] = lessonKeys
		.filter((row) => !listed.has(row.project_key))
		.map((row) => ({
			project_key: row.project_key,
			basis: null,
			machine_id: null,
			sessions: 0,
			events: 0,
			last_seen_at: null,
		}));
```

and spread `...fromLessons` into the sorted result. Update the function's doc comment, which says labels are read too.

- [ ] **Step 6: Run everything this task touches**

Run: `pnpm --filter @onlooker/api test lessons`, `pnpm --filter @onlooker/api test projects`, `pnpm --filter @onlooker/api test schema`, `pnpm --filter @onlooker/db test`, `pnpm typecheck`.
Expected: PASS.

- [ ] **Step 7: Commit**

```
feat(db): lift a lesson's project key into a column :label:

The filter needs to narrow lessons in SQL, and a key inside the JSON can
only be read a row at a time.

Refs ONL-209
```

---

### Task 2: The server answers a project filter on lessons

**Files:**
- Modify: `apps/api/src/db/pool.ts`, `apps/api/src/db/lessons.ts`, `apps/api/src/routes/lessons-browser.ts`
- Modify: `apps/api/src/routes/lessons-browser.test.ts`, `apps/api/src/db/pool-query-plan.test.ts`
- Modify: `packages/api-contract/src/index.ts`, `apps/web/src/api/mockApi.ts`
- Modify: `docs/superpowers/specs/2026-11-01-projects-page-design.md`

**Interfaces:**
- Consumes: `lessons.project_key` from Task 1.
- Produces: `GET /api/lessons?project=<key>` (repeatable); `PoolFilters.projects?: string[]`; `MAX_LESSON_PROJECT_FILTERS`.

- [ ] **Step 1: Write the failing tests**

In `routes/lessons-browser.test.ts`, add a `describe("GET /api/lessons?project=")`, using the file's helpers:

1. `"finds the caller's own lesson by key"`, with no sessions at all on that key.
2. `"finds another account's public lesson when the caller holds the key as remote"`.
3. `"does not match another account's lesson on a key the caller holds only as root"`.
4. `"does not match another account's lesson on a key the caller doesn't hold"`.
5. `"does not reveal another account's private lesson"`, with the caller holding the key as remote.
6. `"keeps a retracted lesson of another account hidden"`.
7. `"finds an org-mate's org lesson on a shared remote key"`, and not on a root one.
8. `"matches any of several keys"`.
9. `"combines with a status filter"`.
10. `"pages across a filter, every match once"`.
11. `"refuses more than 39 values"`: 40 answers `400` with code `invalid_project`, and 39 answers `200`.
12. `"holds at the worst case"`: a reader in 50 orgs, 39 keys, four statuses and a cursor answers `200`.
13. `"refuses a malformed value"`: `nope`, `AAAAAAAAAAAA`, and `m1:aaaaaaaaaaaa` each answer `400`.
14. `"leaves the read alone without a filter"`: a lesson with NULL `project_key` still lists.

In `db/pool-query-plan.test.ts`, using its recorder so the real statement is explained: with `projects` set, the plan does not contain `SCAN lessons`, and the statement's `?` count equals its binds.

Also, in the file's pool tests or a small new case: `readPool` with a null principal and `projects` set returns nothing.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @onlooker/api test lessons-browser`
Expected: FAIL, because the route ignores `project`.

- [ ] **Step 3: Narrow the read**

In `apps/api/src/db/pool.ts`, add `projects?: string[]` to `PoolFilters`, and beside `MAX_READER_ORGS_BOUND`:

```ts
/**
 * How many project keys one read may ask for. The rest of this query can bind
 * 59 of D1's 100 (see MAX_READER_ORGS_BOUND), and the filter's two user ids
 * take two more.
 */
export const MAX_LESSON_PROJECT_FILTERS = 39;
```

Above `readPool`:

```ts
/**
 * Narrows a read to these projects, on top of visibilityPredicate.
 *
 * Your own lessons match by key. Someone else's match only where you hold the
 * key as remote: a remote key names one repository for everyone, but a root
 * key hashes a local path, so equal hex says nothing about what is in it, and
 * matching on it would tell you that someone has a path that hashes the same.
 *
 * There is no anonymous form. Nobody signed out has a project to narrow to, so
 * it matches nothing rather than leaving the read wide.
 */
function projectPredicate(
	principal: Principal | null,
	keys: string[],
): { sql: string; binds: unknown[] } {
	if (!principal) return { sql: "0", binds: [] };
	return {
		sql:
			`project_key IN (${keys.map(() => "?").join(", ")})` +
			" AND (user_id = ? OR EXISTS (SELECT 1 FROM session_projects p" +
			" WHERE p.user_id = ? AND p.project_key = lessons.project_key" +
			" AND p.basis = 'remote'))",
		binds: [...keys, principal.userId, principal.userId],
	};
}
```

In `readPool`, after the statuses block and before the cursor:

```ts
	if (filters.projects && filters.projects.length > 0) {
		const projects = projectPredicate(principal, filters.projects);
		where += ` AND ${projects.sql}`;
		binds.push(...projects.binds);
	}
```

In `apps/api/src/db/lessons.ts`, add `projects?: string[]` to `listLessonsPage`'s `opts`.

- [ ] **Step 4: Read it in the route**

In `apps/api/src/routes/lessons-browser.ts`:

```ts
/** A project key as the lesson contract defines it. */
const PROJECT_KEY = /^[0-9a-f]{12}$/;

/** The `project` values of a read, or throws 400. */
function parseProjectKeys(url: URL): string[] {
	const keys = url.searchParams.getAll("project");
	if (keys.length > MAX_LESSON_PROJECT_FILTERS) {
		throw new ApiError(
			400,
			"invalid_project",
			`Ask for at most ${MAX_LESSON_PROJECT_FILTERS} projects at once`,
		);
	}
	if (!keys.every((key) => PROJECT_KEY.test(key))) {
		throw new ApiError(400, "invalid_project", "That is not a project");
	}
	return keys;
}
```

In `handleBrowseLessons`, call it after the status loop, and pass `projects`.

- [ ] **Step 5: Add the contract and mock**

In `packages/api-contract/src/index.ts`, beside the `/api/lessons?status=banana` case, match its shape:

```ts
		{
			name: "lessons, unusable project filter",
			path: "/api/lessons?project=nope",
			init: { method: "GET" },
			status: 400,
			body: { error: { code: "invalid_project" } },
			forbidden: NO_SECRETS,
		},
		{
			name: "lessons, a machine's root value is not a lesson filter",
			path: "/api/lessons?project=m1:aaaaaaaaaaaa",
			init: { method: "GET" },
			status: 400,
			body: { error: { code: "invalid_project" } },
			forbidden: NO_SECRETS,
		},
```

Read how the existing lessons cases declare auth, and match.

In `apps/web/src/api/mockApi.ts`, in the `/api/lessons` branch after the status loop and before the cursor check, using the same messages as the route:

```ts
		const projects = query.getAll("project");
		if (projects.length > 39) {
			throw new AuthApiError(
				400,
				"invalid_project",
				"Ask for at most 39 projects at once",
			);
		}
		if (!projects.every((key) => /^[0-9a-f]{12}$/.test(key))) {
			throw new AuthApiError(400, "invalid_project", "That is not a project");
		}
```

- [ ] **Step 6: Amend the spec**

In `docs/superpowers/specs/2026-11-01-projects-page-design.md`, under "PR 3": change "capped at 50 values" to 39, and say why: the read can already bind 59 parameters. Say a root entry sends only its key, so `<machine_id>:<key>` answers 400. Under "PR 1"'s list, say a lesson key is listed only when no session row or label already holds that key. In "Tests", change the 50 to 39.

- [ ] **Step 7: Run everything this task touches**

Run: `pnpm --filter @onlooker/api test lessons-browser`, `pnpm --filter @onlooker/api test query-plan`, `pnpm --filter @onlooker/api test pool`, `pnpm --filter @onlooker/api test contract`, `pnpm --filter @onlooker/web test api-contract`, `pnpm typecheck`, `pnpm --filter @onlooker/api lint`.
Expected: PASS.

- [ ] **Step 8: Commit**

```
feat(api): filter lessons by project on the server :mag_right:

The pool mixes accounts, so the filter has to answer inside the visibility
rules. A key on someone else's lesson only counts if it names one repository.

Refs ONL-209
```

---

### Task 3: The Lessons page filters

**Files:**
- Modify: `apps/web/src/lib/projectEntries.ts`, `apps/web/src/api/lessonsApi.ts`, `apps/web/src/pages/LessonsPage.tsx`
- Modify: `apps/web/src/__tests__/project-entries.test.ts`, `apps/web/src/__tests__/lessons-page.test.tsx`, and the lessons API test if one covers `listLessons`

**Interfaces:**
- Consumes: `GET /api/lessons?project=` from Task 2; lesson keys in `GET /api/projects` from Task 1; `projectEntries`, `ProjectEntry`, `ProjectFilter`, `listProjects`, `Project`.
- Produces: `entryKeys(entry)`.

- [ ] **Step 1: Write the failing helper test**

In `project-entries.test.ts`, for `entryKeys`: bare keys pass through, a `<machine_id>:<key>` value gives its key, and the same key on two machines gives one key.

- [ ] **Step 2: Add the helper**

In `apps/web/src/lib/projectEntries.ts`:

```ts
/**
 * An entry's keys alone, for a read with no machine. A lesson stores none, so
 * the same root key on two machines is one thing to it.
 */
export function entryKeys(entry: ProjectEntry): string[] {
	return [...new Set(entry.values.map((value) => value.slice(-12)))];
}
```

- [ ] **Step 3: Add the API option**

In `apps/web/src/api/lessonsApi.ts`, add to `ListLessonsOptions`:

```ts
	/** Bare project keys; see `entryKeys` in lib/projectEntries.ts. */
	project?: string[];
```

and in `listLessons`, after the statuses: `for (const key of options.project ?? []) query.append("project", key);`

- [ ] **Step 4: Write the failing page tests**

In `lessons-page.test.tsx`, add `listProjects` to `mocks`, mock `../api/projectsApi`, and default it in `beforeEach` to `{ projects: [] }`, so existing tests see no filter. Cover:

1. Offers `All projects` plus an entry per name, including a lesson-only key and a project with no sessions.
2. No projects means no Project control. A failed `listProjects` is the same, and the pool still loads.
3. The first load sends no `project`.
4. Choosing an entry reads with its keys, and two keys sharing a name send both.
5. A root project sends the bare key, not `<machine_id>:<key>`.
6. Status and project combine, in both orders.
7. Load more carries `project` and the cursor.
8. An empty filtered result shows `No lessons in <name>`, not "Nothing has synced yet", and `role="status"` says the same.
9. With a status filter too, an empty result still names the project.
10. A failed filtered read shows the Retry state with the Project control still there, and choosing `All projects` recovers.
11. A slow answer to a first choice landing after a second is ignored.
12. Renaming the selected project away, by a `labels` change, falls back to all projects.

- [ ] **Step 5: Implement the page**

In `LessonsPage.tsx`, beside `filter`:

```ts
	// Empty until read, and empty if the read fails: the control then doesn't
	// show, and the page is what it was without one.
	const [projects, setProjects] = useState<Project[]>([]);
	// A name rather than an entry, so a rename that regroups keys can't leave a
	// stale set of keys behind.
	const [selected, setSelected] = useState<string | null>(null);
```

After `labels` and `selected` are declared:

```ts
	const entries = projectEntries(projects, labels);
	const entry = entries.find((option) => option.name === selected) ?? null;
	// A string, so `load` changes when the keys do and not on every render.
	const projectKey = entry ? entryKeys(entry).join("\n") : "";
```

These must sit above `load`, which depends on `projectKey`. Add a helper near them:

```ts
	const query = useCallback(
		() => ({
			...(filter ? { statuses: [filter] } : {}),
			...(projectKey ? { project: projectKey.split("\n") } : {}),
		}),
		[filter, projectKey],
	);
```

`load` calls `listLessons(query())` with `[query]` as its deps, and `loadMore` calls `listLessons({ ...query(), cursor })`. `load`'s existing resets and `requestSeq` handle the rest: don't add a second guard.

Add `listProjects` to the labels effect's neighbor as its own quiet effect, with the same `active` flag, because a failure here must never blank the pool:

```ts
	useEffect(() => {
		let active = true;
		listProjects()
			.then(({ projects: loaded }) => {
				if (active) setProjects(loaded);
			})
			.catch(() => {
				// Deliberately quiet: the page works without the control.
			});
		return () => {
			active = false;
		};
	}, []);
```

Render above the status filter, inside `.lessons-list`:

```tsx
				{entries.length > 0 ? (
					<div style={{ marginBottom: "1rem" }}>
						<ProjectFilter
							entries={entries}
							value={entry?.name ?? null}
							onChange={setSelected}
						/>
					</div>
				) : null}
```

Empty states, with one source for the title so the region and the heading can't disagree:

```ts
	const emptyTitle = entry
		? `No lessons in ${entry.name}`
		: filter
			? (FILTERS.find((option) => option.value === filter)?.empty ??
				"No lessons")
			: "Nothing has synced yet";
```

Use `emptyTitle` in `resultSummary`. In the empty branch, change `filter ? (` to `entry || filter ? (`, use `title={emptyTitle}`, and for the body:

```tsx
{entry
	? "Nothing you can read in the pool matches that project."
	: "Nothing in the pool holds that status right now."}
```

Keep the existing comment, and extend it to say a project is a filter too.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @onlooker/web test project-entries`, `pnpm --filter @onlooker/web test lessons-page`, `pnpm --filter @onlooker/web test lessons-api`, `pnpm --filter @onlooker/web test shell-headings`.
Expected: PASS.

- [ ] **Step 7: Run the full checks**

Run: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `bash scripts/source-guards.test.sh`.
Expected: all pass. Fix any formatting by hand with Edit.

- [ ] **Step 8: Commit**

```
feat(web): filter lessons by project :dart:

Finding what the pool knows about one repository meant reading all of it.
The same control as Sessions, sending keys only, because a lesson has no
machine.

Refs ONL-209
```
