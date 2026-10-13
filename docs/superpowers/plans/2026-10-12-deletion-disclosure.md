# Pre-Deletion Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before an account deletion runs, the settings panel says how many public lessons it will destroy and which orgs keep theirs.

**Architecture:** One new `GET /auth/account/deletion-preview` route, fetched when the user clicks "Delete my account" rather than on page load. The two counting statements live in `apps/api/src/db/lessons.ts` beside `hasOrgSharedLessons` and `nonOrgLessonsDelete`, because `scripts/source-guards.test.sh:172-201` confines every lesson query to that file and `db/pool.ts`. No schema change, no migration, no new binding.

**Tech Stack:** Cloudflare Workers + D1 (raw `db.prepare`), vitest with `@cloudflare/vitest-pool-workers` for the API, React 18 + vitest + Testing Library for the web app, biome for lint/format, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-12-deletion-disclosure-design.md`. Bead: `onlooker-px7ssn.4` (ONL-136). Branch: `meagan/onl-136-deletion-disclosure`, based on `43d0137`.

## Global Constraints

- **American English** in every comment, identifier, test name, and commit message.
- **Tabs for indentation**, in both TS and TSX. biome enforces it; run `pnpm exec biome check --write <files>` before committing.
- **Edit tracked files with the `Edit`/`Write` file tools, never `sed -i` or heredocs.** The `lineage` and `inspector` plugins hook `PostToolUse` on `Edit`/`Write`/`MultiEdit`; a shell edit moves the same bytes invisibly and `/lineage` then answers "no record" for a line that was demonstrably written. Project CLAUDE.md, and it overrides any general shell preference.
- **Commit through `/git-workflow:commit`**, every time, including one-file commits. Conventional commits, subject ≤72 chars including a mood emoji that reflects *this* change, body ≤80 cols explaining why.
- **The account route family answers in camelCase** (`publicLessons`, `orgsKeeping`), matching `accountUser` at `apps/api/src/routes/account.ts:53-64`. The lessons routes' `has_more` is a different family — do not copy it here.
- **No lesson or `lesson_feed` query outside `db/lessons.ts` and `db/pool.ts`.** The guard's matcher recognizes raw SQL and drizzle builder calls alike (`scripts/source-guards.test.sh:75-78`) and skips `*.test.ts`. Importing from `db/lessons.ts` is fine — `db/queries.ts` already does.
- **`status != 'retracted'` on both counting statements.** Spec D2. A retracted lesson is already hidden across the ownership boundary (`apps/api/src/db/pool.ts:160`), so counting one overstates the loss.
- **Four gates before any PR**, per the lesson of PR #188: `pnpm --filter <pkg> test`, `pnpm --filter <pkg> typecheck`, `pnpm --filter <pkg> lint`, and `bash scripts/source-guards.test.sh` — the fourth is wired into no pnpm script, so no local sweep runs it unless you name it.
- **A fresh worktree needs `pnpm install` and `pnpm --filter @onlooker/web... build`** before `apps/web` tests will run: `@onlooker/auth-react` resolves through its `dist/`, which is gitignored, and without it 22 test files fail to transform with "Failed to resolve import".
- **Task tracking is `bd`.** Do not use TodoWrite or markdown checklists for work items.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/api/src/db/lessons.ts` | the two counting statements, as one exported function | 1 |
| `apps/api/src/db/lessons.test.ts` | what the statements count and exclude | 1 |
| `apps/api/src/routes/account.ts` | the handler: principal → preview → JSON | 2 |
| `apps/api/src/router.ts` | one route-table entry | 2 |
| `apps/api/src/routes/account-deletion-preview.test.ts` | auth and response shape over HTTP | 2 |
| `apps/web/src/api/mockApi.ts` | the mock's answer, so dev mode shows real states | 3 |
| `apps/web/src/api/api-contract.test.ts` | the mock answers the shape the client reads | 3 |
| `apps/web/src/api/accountApi.ts` | endpoint entry, `DeletionPreview` type, `getDeletionPreview()` | 4 |
| `apps/web/src/api/accountApi.test.ts` | the client maps the payload and rejects on failure | 4 |
| `apps/web/src/pages/SettingsPage.tsx` | the four panel states and their copy | 5 |
| `apps/web/src/__tests__/settings-delete-account.test.tsx` | the states, and the D5 guard | 5 |

---

### Task 1: The counting statements

**Files:**
- Modify: `apps/api/src/db/lessons.ts` (append after `nonOrgLessonsDelete`, which ends at `:755`)
- Test: `apps/api/src/db/lessons.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `accountDeletionPreview(db: D1Database, userId: string): Promise<{ publicLessons: number; orgsKeeping: { id: string; name: string; lessons: number }[] }>` — Task 2 calls this and Tasks 4 and 5 mirror its field names exactly.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/db/lessons.test.ts`. The file already has a `lesson()` fixture builder (`:22`), a `db()` accessor (`:17`), a `userId` seeded in `beforeEach` (`:48-56`), and imports `createLessonsWithFeed` and `createOrgWithOwner`. Add `accountDeletionPreview` to the existing import block from `./lessons.js`, and `createUser` is already imported from `./queries.js`.

```typescript
describe("accountDeletionPreview", () => {
	it("counts public lessons and keeps org ones out of that count", async () => {
		const org = await createOrgWithOwner(db(), "Acme", userId);
		await createLessonsWithFeed(
			db(),
			userId,
			[lesson({ visibility: "public" }) as TLesson],
			null,
		);
		await createLessonsWithFeed(
			db(),
			userId,
			[lesson({ visibility: "org" }) as TLesson],
			org.id,
		);

		const preview = await accountDeletionPreview(db(), userId);

		expect(preview.publicLessons).toBe(1);
		expect(preview.orgsKeeping).toEqual([
			{ id: org.id, name: "Acme", lessons: 1 },
		]);
	});

	it("groups each org separately, ordered by name", async () => {
		const beta = await createOrgWithOwner(db(), "Beta", userId);
		const acme = await createOrgWithOwner(db(), "Acme", userId);
		await createLessonsWithFeed(
			db(),
			userId,
			[lesson({ visibility: "org" }) as TLesson],
			beta.id,
		);
		await createLessonsWithFeed(
			db(),
			userId,
			[
				lesson({ visibility: "org" }) as TLesson,
				lesson({ visibility: "org" }) as TLesson,
			],
			acme.id,
		);

		const preview = await accountDeletionPreview(db(), userId);

		// Acme first, matching soleOwnedOrgs' ORDER BY o.name (orgs.ts:417), so
		// the two lists somebody may see minutes apart agree.
		expect(preview.orgsKeeping).toEqual([
			{ id: acme.id, name: "Acme", lessons: 2 },
			{ id: beta.id, name: "Beta", lessons: 1 },
		]);
	});

	it("leaves retracted lessons out of both counts", async () => {
		const org = await createOrgWithOwner(db(), "Acme", userId);
		const published = lesson({ visibility: "public" }) as TLesson;
		const shared = lesson({ visibility: "org" }) as TLesson;
		await createLessonsWithFeed(db(), userId, [published], null);
		await createLessonsWithFeed(db(), userId, [shared], org.id);
		// pool.ts:160 hides a retracted lesson from everybody but its author, so
		// it is already withdrawn: counting it would overstate what deletion
		// costs anybody else, and claiming the org keeps it would be worse.
		await db()
			.prepare("UPDATE lessons SET status = 'retracted' WHERE id IN (?, ?)")
			.bind(published.id, shared.id)
			.run();

		const preview = await accountDeletionPreview(db(), userId);

		expect(preview.publicLessons).toBe(0);
		expect(preview.orgsKeeping).toEqual([]);
	});

	it("still counts a superseded lesson, which readers can still reach", async () => {
		await createLessonsWithFeed(
			db(),
			userId,
			[lesson({ visibility: "public" }) as TLesson],
			null,
		);
		await db()
			.prepare("UPDATE lessons SET status = 'superseded' WHERE user_id = ?")
			.bind(userId)
			.run();

		expect((await accountDeletionPreview(db(), userId)).publicLessons).toBe(1);
	});

	it("counts nobody else's lessons", async () => {
		const other = await createUser(db(), "bob@example.com", "hash", "Bob");
		const org = await createOrgWithOwner(db(), "Acme", other.id);
		await createLessonsWithFeed(
			db(),
			other.id,
			[lesson({ visibility: "public" }) as TLesson],
			null,
		);
		await createLessonsWithFeed(
			db(),
			other.id,
			[lesson({ visibility: "org" }) as TLesson],
			org.id,
		);

		const preview = await accountDeletionPreview(db(), userId);

		expect(preview.publicLessons).toBe(0);
		expect(preview.orgsKeeping).toEqual([]);
	});

	it("answers zero and empty for an account that has shared nothing", async () => {
		expect(await accountDeletionPreview(db(), userId)).toEqual({
			publicLessons: 0,
			orgsKeeping: [],
		});
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @onlooker/api exec vitest run src/db/lessons.test.ts -t accountDeletionPreview`
Expected: FAIL. The import of `accountDeletionPreview` does not resolve, so the suite fails to load — not an assertion failure. That is the right failure for a function that does not exist yet.

- [ ] **Step 3: Write the implementation**

Append to `apps/api/src/db/lessons.ts`, after `nonOrgLessonsDelete`:

```typescript
/**
 * What deleting this account would destroy, and what each org would keep.
 *
 * Counts only what crosses the ownership boundary. `pool.ts:160` hides a
 * retracted lesson from everybody but its author under the rule stated at
 * `:104`, so counting one here would overstate what deletion costs anybody
 * else, and naming an org as keeping a lesson it cannot read would be worse.
 * `superseded` rows stay counted: the pool serves those with their status
 * attached, so a reader holding a link still reaches them.
 *
 * Private lessons are deliberately absent. They are destroyed - the statement
 * above takes every non-org row - but a private lesson has no audience to lose
 * it, and disclosure exists for content other people can see.
 *
 * The org predicate is `hasOrgSharedLessons`' condition verbatim and the public
 * one narrows the complement that `nonOrgLessonsDelete` deletes, so a reader
 * comparing the three finds the same split each time. That is the same reason
 * those two are written as one condition negated.
 */
export async function accountDeletionPreview(
	db: D1Database,
	userId: string,
): Promise<{
	publicLessons: number;
	orgsKeeping: { id: string; name: string; lessons: number }[];
}> {
	const published = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM lessons
			 WHERE user_id = ? AND visibility = 'public' AND status != 'retracted'`,
		)
		.bind(userId)
		.first<{ n: number }>();

	const kept = await db
		.prepare(
			`SELECT o.id AS id, o.name AS name, COUNT(*) AS lessons
			   FROM lessons l JOIN orgs o ON o.id = l.org_id
			  WHERE l.user_id = ? AND l.visibility = 'org'
			    AND l.org_id IS NOT NULL AND l.status != 'retracted'
			  GROUP BY o.id, o.name
			  ORDER BY o.name`,
		)
		.bind(userId)
		.all<{ id: string; name: string; lessons: number }>();

	return { publicLessons: published?.n ?? 0, orgsKeeping: kept.results ?? [] };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @onlooker/api exec vitest run src/db/lessons.test.ts`
Expected: PASS, the whole file — the new describe block plus everything already there.

- [ ] **Step 5: Prove the retracted guard by ablation**

Drop ` AND status != 'retracted'` from the public statement only. Run the file again.
Expected: "leaves retracted lessons out of both counts" FAILS and nothing else does. Restore the clause and re-run to green. A guard whose test passes either way is not a guard — and this is the clause most likely to be dropped by a later refactor that tidies the two statements together.

- [ ] **Step 6: Run the source guard**

Run: `bash scripts/source-guards.test.sh`
Expected: `all 42 tests passed`, unamended. If "no lesson query outside db/lessons.ts and db/pool.ts" fails, the query went in the wrong file — move it, do not touch the guard.

- [ ] **Step 7: Commit**

Invoke `/git-workflow:commit` with the two files. The why: a preview is a third reading of deletion's own split, so it is written to match the other two rather than to be clever.

---

### Task 2: The route

**Files:**
- Modify: `apps/api/src/routes/account.ts` (add handler; import from `../db/lessons.js`)
- Modify: `apps/api/src/router.ts` (entry after the `DELETE /auth/account` block at `:179-185`)
- Test: `apps/api/src/routes/account-deletion-preview.test.ts` (create)

**Interfaces:**
- Consumes: `accountDeletionPreview` from Task 1.
- Produces: `GET /auth/account/deletion-preview` answering `{ publicLessons, orgsKeeping: [{ id, name, lessons }] }`, which Tasks 3, 4 and 5 all read. `handleDeletionPreview` is exported from `routes/account.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/account-deletion-preview.test.ts`. The helpers come from the two test-support modules the sibling suite uses (`routes/account-deletion.test.ts:1-17`): `call(path, token, init)` sends a request through `SELF.fetch` with the bearer token, `signup(email)` creates a real account, `resetOrgTables()` clears orgs and users.

```typescript
import { env } from "cloudflare:test";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createLessonsWithFeed } from "../db/lessons.js";
import { lesson, resetLessonCounter } from "../test-support/lessons.js";
import { call, resetOrgTables, type SignedUpUser, signup } from "../test-support/orgs.js";

// The panel asks this before it asks for confirmation, so what it answers is
// what somebody decides on. ONL-136.

const db = () => env.DB;
let ada: SignedUpUser;

interface PreviewBody {
	publicLessons: number;
	orgsKeeping: { id: string; name: string; lessons: number }[];
}

beforeEach(async () => {
	await resetOrgTables();
	// resetOrgTables deliberately leaves these two alone - see its doc comment -
	// and this suite seeds lessons, so it clears them itself.
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	resetLessonCounter();
	ada = await signup("ada@example.com");
});

const preview = (token: string | null) =>
	call("/auth/account/deletion-preview", token);

const createOrg = async (token: string, name: string): Promise<string> => {
	const response = await call("/api/orgs", token, {
		method: "POST",
		body: JSON.stringify({ name }),
	});
	return ((await response.json()) as { org: { id: string } }).org.id;
};

describe("GET /auth/account/deletion-preview", () => {
	it("refuses without a session", async () => {
		expect((await preview(null)).status).toBe(401);
	});

	it("counts the caller's public lessons and names the orgs keeping theirs", async () => {
		const orgId = await createOrg(ada.token, "Acme");
		await createLessonsWithFeed(
			db(),
			ada.id,
			[lesson({ visibility: "public" }) as TLesson],
			null,
		);
		await createLessonsWithFeed(
			db(),
			ada.id,
			[lesson({ visibility: "org" }) as TLesson],
			orgId,
		);

		const response = await preview(ada.token);

		expect(response.status).toBe(200);
		expect((await response.json()) as PreviewBody).toEqual({
			publicLessons: 1,
			orgsKeeping: [{ id: orgId, name: "Acme", lessons: 1 }],
		});
	});

	it("answers zero and empty for an account that has shared nothing", async () => {
		const body = (await (await preview(ada.token)).json()) as PreviewBody;

		expect(body).toEqual({ publicLessons: 0, orgsKeeping: [] });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @onlooker/api exec vitest run src/routes/account-deletion-preview.test.ts`
Expected: FAIL. The two authenticated cases get 404 — the router matches on exact method and path (`router.ts:608`) and no entry claims this one yet. The 401 case may already pass, because an unmatched path with no token can answer 401 before routing; that is fine, it is a guard against the route ever being registered without `auth: "session"`.

- [ ] **Step 3: Add the handler**

In `apps/api/src/routes/account.ts`, add to the import block that already pulls from `../db/orgs.js` and `../db/queries`:

```typescript
import { accountDeletionPreview } from "../db/lessons.js";
```

Then add the handler, directly above `handleDeleteAccount`:

```typescript
/**
 * GET /auth/account/deletion-preview
 * What a deletion would destroy, so the confirm step can say so beforehand.
 *
 * Fetched when somebody asks to delete rather than on every settings visit:
 * two reads on every page load would be paid for by every visitor, almost none
 * of whom are leaving, and the numbers would describe the moment the page
 * loaded rather than the moment they are read.
 *
 * Requires: Access token
 * Response: { publicLessons: number, orgsKeeping: { id, name, lessons }[] }
 * Errors: 401 (unauthorized)
 */
export async function handleDeletionPreview(
	_request: Request,
	env: WorkerEnv,
	_params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	// The router resolved this from the route's `auth: "session"`, which throws
	// rather than returning null, so it cannot be null here.
	const { userId } = principal as Principal;

	return jsonResponse(await accountDeletionPreview(env.DB, userId));
}
```

- [ ] **Step 4: Register the route**

In `apps/api/src/router.ts`, add `handleDeletionPreview` to the existing import from `./routes/account.js`, then add this entry immediately after the `DELETE /auth/account` block (`:179-185`):

```typescript
	{
		method: "GET",
		path: "/auth/account/deletion-preview",
		auth: "session",
		cors: "app",
		handler: handleDeletionPreview,
	},
```

Two segments under `/auth/account` is already a proven shape here — `/auth/reset-password/verify` sits beside `/auth/reset-password` — and matching is exact on method and path, so this cannot shadow `DELETE /auth/account`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @onlooker/api exec vitest run src/routes/account-deletion-preview.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Run the whole API suite and the gates**

Run: `pnpm --filter @onlooker/api test`, then `pnpm --filter @onlooker/api typecheck`, then `pnpm --filter @onlooker/api lint`, then `bash scripts/source-guards.test.sh`.
Expected: all green. biome may report pre-existing `noExplicitAny` warnings in `apps/api`; warnings do not fail the gate, errors do.

- [ ] **Step 7: Commit**

Invoke `/git-workflow:commit` with the three files.

---

### Task 3: The mock, and the contract

**Files:**
- Modify: `apps/web/src/api/mockApi.ts` (insert before the `DELETE /auth/account` block at `:403-410`)
- Modify: `apps/web/src/api/api-contract.test.ts` (add a case inside `describe("the mock's account management")`, which starts at `:288`)

**Interfaces:**
- Consumes: the route shape from Task 2.
- Produces: the mock answers `/auth/account/deletion-preview`, so Task 5's states are reachable in mock-mode development rather than only `unavailable`.

- [ ] **Step 1: Write the failing contract test**

Add inside `describe("the mock's account management")` in `apps/web/src/api/api-contract.test.ts`. The suite's own `account()` helper returns `{ email, access, refresh }`.

```typescript
	// The one piece of ONL-136 the mock can hold up its end of: a static
	// preview needs no ownership modeling, unlike the sole-owner 409, whose
	// refusal the mock cannot produce at all (onlooker-jws).
	it("answers the deletion preview in the shape the client reads", async () => {
		const me = await account();

		const res = await createMockFetch()("/auth/account/deletion-preview", {
			headers: { Authorization: `Bearer ${me.access}` },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			publicLessons: number;
			orgsKeeping: { id: string; name: string; lessons: number }[];
		};
		expect(typeof body.publicLessons).toBe("number");
		expect(Array.isArray(body.orgsKeeping)).toBe(true);
		for (const org of body.orgsKeeping) {
			expect(typeof org.id).toBe("string");
			expect(typeof org.name).toBe("string");
			expect(typeof org.lessons).toBe("number");
		}
	});

	it("refuses the deletion preview without a token", async () => {
		const res = await createMockFetch()("/auth/account/deletion-preview");

		expect(res.status).toBe(401);
	});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @onlooker/web exec vitest run src/api/api-contract.test.ts -t "deletion preview"`
Expected: FAIL on the first case — the mock falls through to `throw new AuthApiError(404, "not_found", ...)` at `mockApi.ts:761`, so the status is 404, not 200. The second case may already pass via that same fallthrough; it is here so the mock cannot later answer the preview without checking a token.

- [ ] **Step 3: Add the mock handler**

In `apps/web/src/api/mockApi.ts`, insert immediately before the `// DELETE /auth/account` comment block:

```typescript
	// GET /auth/account/deletion-preview — what deletion would remove.
	//
	// Static on purpose. The real counts come from two queries over `lessons`,
	// and the mock models one org as a fixture with no lesson store behind it,
	// so numbers here exist to exercise the panel's states rather than to be
	// right about any account.
	if (
		path === "/auth/account/deletion-preview" &&
		(options.method ?? "GET") === "GET"
	) {
		requireAuth(options);
		return json({
			publicLessons: 2,
			orgsKeeping: [{ id: MOCK_ORG.id, name: MOCK_ORG.name, lessons: 1 }],
		});
	}
```

`MOCK_ORG` is declared later in the module (`:448`); that is fine, because this reads it at request time rather than at module evaluation.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @onlooker/web exec vitest run src/api/api-contract.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 5: Commit**

Invoke `/git-workflow:commit` with the two files.

---

### Task 4: The web client

**Files:**
- Modify: `apps/web/src/api/accountApi.ts` (endpoint entry at `:11-20`; new type and function after `deleteAccount`, which ends at `:145`)
- Test: `apps/web/src/api/accountApi.test.ts`

**Interfaces:**
- Consumes: the route from Task 2, the mock from Task 3.
- Produces: `DeletionPreview = { publicLessons: number; orgsKeeping: { id: string; name: string; lessons: number }[] }` and `getDeletionPreview(): Promise<DeletionPreview>`, both imported by Task 5.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/api/accountApi.test.ts`. The file already mocks `./client` with a hoisted `mocks` object; extend it with a `get` and add it to the `apiClient` the mock returns, then import `getDeletionPreview` alongside `deleteAccount`.

The hoisted block and mock become:

```typescript
const mocks = vi.hoisted(() => ({
	del: vi.fn(),
	get: vi.fn(),
}));

vi.mock("./client", () => ({
	apiClient: { delete: mocks.del, get: mocks.get },
	tokenStore: { getRefreshToken: () => null },
}));

const { deleteAccount, getDeletionPreview } = await import("./accountApi");
```

Add `mocks.get.mockReset();` to the existing `beforeEach`, then:

```typescript
describe("getDeletionPreview", () => {
	it("asks the deletion-preview endpoint and returns what it answers", async () => {
		mocks.get.mockResolvedValue({
			publicLessons: 12,
			orgsKeeping: [{ id: "org-1", name: "Acme", lessons: 4 }],
		});

		expect(await getDeletionPreview()).toEqual({
			publicLessons: 12,
			orgsKeeping: [{ id: "org-1", name: "Acme", lessons: 4 }],
		});
		expect(mocks.get).toHaveBeenCalledWith("/auth/account/deletion-preview");
	});

	// Not zeros. An account that has published nothing and an account whose
	// preview failed are different facts, and a zero for the second would read
	// as "nothing will be lost" over a request that never answered.
	it("rejects when the request fails rather than resolving to zeros", async () => {
		mocks.get.mockRejectedValue(
			new AuthApiError(500, "internal_error", "Something failed"),
		);

		await expect(getDeletionPreview()).rejects.toThrow("Something failed");
	});
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @onlooker/web exec vitest run src/api/accountApi.test.ts`
Expected: FAIL — `getDeletionPreview` is not exported, so the destructuring import yields `undefined` and the calls throw "getDeletionPreview is not a function".

- [ ] **Step 3: Write the implementation**

In `apps/web/src/api/accountApi.ts`, add to `ACCOUNT_ENDPOINTS`:

```typescript
	deletionPreview: "/auth/account/deletion-preview",
```

Then, after `deleteAccount`:

```typescript
/** An org that keeps the lessons this account shared with it. */
export type OrgKeepingLessons = { id: string; name: string; lessons: number };

/**
 * What deleting this account would destroy, read before the deletion is asked
 * for rather than discovered from a dead link afterwards.
 *
 * `publicLessons` counts only what somebody else can currently read: a
 * retracted lesson is already withdrawn, so the server leaves it out of both
 * numbers. Private lessons are destroyed too and are deliberately not counted
 * here - they have no audience to lose them.
 *
 * There is no total for `orgsKeeping`. A sum the server sends and a sum the
 * names add up to are two numbers that can disagree, so the caller adds them.
 */
export type DeletionPreview = {
	publicLessons: number;
	orgsKeeping: OrgKeepingLessons[];
};

export function getDeletionPreview(): Promise<DeletionPreview> {
	return apiClient.get<DeletionPreview>(ACCOUNT_ENDPOINTS.deletionPreview);
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm --filter @onlooker/web exec vitest run src/api/accountApi.test.ts`
Expected: PASS, 7 tests — the five `deleteAccount` cases already there plus these two.

- [ ] **Step 5: Commit**

Invoke `/git-workflow:commit` with the two files.

---

### Task 5: The panel

**Files:**
- Modify: `apps/web/src/pages/SettingsPage.tsx` (`DeleteAccountSection`, `:316-430`)
- Test: `apps/web/src/__tests__/settings-delete-account.test.tsx`

**Interfaces:**
- Consumes: `getDeletionPreview` and `DeletionPreview` from Task 4.
- Produces: the finished feature. Nothing depends on it.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/__tests__/settings-delete-account.test.tsx`. The file already mocks `../api/accountApi`, `../auth` and `useNavigate`, and has an `askToDelete()` helper that renders the page, clicks "Delete my account", types the email and submits. Two changes to its setup:

Add `getDeletionPreview: vi.fn()` to the `vi.mock("../api/accountApi", ...)` factory. Then add a default to `beforeEach` so the existing tests keep a resolved preview rather than an unhandled rejection:

```typescript
	vi.mocked(api.getDeletionPreview).mockReset().mockResolvedValue({
		publicLessons: 0,
		orgsKeeping: [],
	});
```

Add a helper that stops after revealing the form, because these tests are about what the panel says *before* a deletion is confirmed:

```typescript
async function askWhatWillHappen() {
	const user = userEvent.setup();
	render(
		<MemoryRouter>
			<RevealProvider>
				<SettingsPage />
			</RevealProvider>
		</MemoryRouter>,
	);
	await user.click(
		await screen.findByRole("button", { name: /delete my account/i }),
	);
}
```

Then:

```typescript
describe("what the panel says deletion will destroy", () => {
	it("names the public count and each org that keeps its lessons", async () => {
		vi.mocked(api.getDeletionPreview).mockResolvedValue({
			publicLessons: 12,
			orgsKeeping: [
				{ id: "org-1", name: "Acme", lessons: 4 },
				{ id: "org-2", name: "Beta", lessons: 1 },
			],
		});

		await askWhatWillHappen();

		expect(await screen.findByText(/12 public lessons/i)).toBeInTheDocument();
		// 5 is summed on the client: the API sends no total, because a total it
		// computes and a total the names add up to can disagree.
		expect(screen.getByText(/5 lessons stay with their org/i)).toBeInTheDocument();
		expect(screen.getByText(/Acme \(4\)/)).toBeInTheDocument();
		expect(screen.getByText(/Beta \(1\)/)).toBeInTheDocument();
	});

	it("says plainly when there is nothing shared to lose", async () => {
		vi.mocked(api.getDeletionPreview).mockResolvedValue({
			publicLessons: 0,
			orgsKeeping: [],
		});

		await askWhatWillHappen();

		expect(
			await screen.findByText(/no shared lessons/i),
		).toBeInTheDocument();
	});

	it("admits it could not check, without claiming the deletion is blocked", async () => {
		vi.mocked(api.getDeletionPreview).mockRejectedValue(
			new Error("network down"),
		);

		await askWhatWillHappen();

		expect(
			await screen.findByText(/couldn't check what deleting will remove/i),
		).toBeInTheDocument();
	});

	// Spec D5, and the guard worth proving by ablation. Closing your own
	// account must not depend on a disclosure query succeeding - the
	// irreversible case is already guarded by the sole-owner 409.
	it("still allows deletion after a failed preview", async () => {
		vi.mocked(api.getDeletionPreview).mockRejectedValue(
			new Error("network down"),
		);
		vi.mocked(api.deleteAccount).mockResolvedValue({ success: true });
		const user = userEvent.setup();
		render(
			<MemoryRouter>
				<RevealProvider>
					<SettingsPage />
				</RevealProvider>
			</MemoryRouter>,
		);
		await user.click(
			await screen.findByRole("button", { name: /delete my account/i }),
		);
		await screen.findByText(/couldn't check what deleting will remove/i);

		await user.type(
			screen.getByLabelText(/type your email/i),
			"ada@example.com",
		);
		await user.click(
			screen.getByRole("button", { name: /permanently delete/i }),
		);

		await vi.waitFor(() => expect(api.deleteAccount).toHaveBeenCalled());
	});
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/settings-delete-account.test.tsx`
Expected: FAIL — the three copy assertions find no such text, because the panel renders no preview at all. "still allows deletion after a failed preview" fails at `findByText` for the same reason. The three tests already in the file must still pass.

- [ ] **Step 3: Add the state and the fetch**

In `apps/web/src/pages/SettingsPage.tsx`, extend the `accountApi` import with `getDeletionPreview` and `type DeletionPreview`. Inside `DeleteAccountSection`, add beside the existing `refusal` state (`:327`):

```typescript
	// Four states, because "no counts yet" and "no counts at all" are different
	// things to say. Fetched when deletion is asked for rather than on mount:
	// almost nobody visiting settings is leaving.
	const [preview, setPreview] = useState<
		| { kind: "idle" }
		| { kind: "loading" }
		| { kind: "ready"; counts: DeletionPreview }
		| { kind: "unavailable" }
	>({ kind: "idle" });

	const askToDelete = () => {
		setConfirming(true);
		setPreview({ kind: "loading" });
		getDeletionPreview()
			.then((counts) => setPreview({ kind: "ready", counts }))
			.catch(() => setPreview({ kind: "unavailable" }));
	};
```

Change the reveal button from `onClick={() => setConfirming(true)}` to `onClick={askToDelete}`.

Leave `canDelete` and the submit button's `disabled` exactly as they are. That is D5 in code: the confirm path never consults `preview`.

- [ ] **Step 4: Render the four states**

Inside the `<form>`, immediately after the `{refusal && (...)}` block, add:

```tsx
					{preview.kind === "loading" && (
						<p style={{ marginTop: 0, color: "var(--ink-dim)" }}>
							Checking what deletion will remove…
						</p>
					)}
					{preview.kind === "unavailable" && (
						// Two clauses on purpose. The first is honest about the gap;
						// the second stops the gap reading as a refusal, which is the
						// mistake the sole-owner message exists to prevent in the
						// other direction.
						<p style={{ marginTop: 0, color: "var(--ink-dim)" }}>
							Couldn't check what deleting will remove. Your account can still
							be deleted.
						</p>
					)}
					{preview.kind === "ready" && (
						<p style={{ marginTop: 0, color: "var(--ink-dim)" }}>
							{preview.counts.publicLessons === 0 &&
							preview.counts.orgsKeeping.length === 0 ? (
								"You have no shared lessons, so nothing published will be lost."
							) : (
								<>
									{preview.counts.publicLessons > 0 && (
										<>
											Deleting this account will destroy{" "}
											<strong>
												{preview.counts.publicLessons} public{" "}
												{preview.counts.publicLessons === 1
													? "lesson"
													: "lessons"}
											</strong>
											. Anyone holding a link loses it.{" "}
										</>
									)}
									{preview.counts.orgsKeeping.length > 0 && (
										<>
											<strong>
												{preview.counts.orgsKeeping.reduce(
													(n, org) => n + org.lessons,
													0,
												)}{" "}
												lessons stay with their org:
											</strong>{" "}
											{preview.counts.orgsKeeping
												.map((org) => `${org.name} (${org.lessons})`)
												.join(", ")}
											.
										</>
									)}
								</>
							)}
						</p>
					)}
```

- [ ] **Step 5: Run them to verify they pass**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/settings-delete-account.test.tsx`
Expected: PASS, 7 tests — the three from PR #201 and these four.

- [ ] **Step 6: Prove the D5 guard by ablation**

Add `|| preview.kind !== "ready"` to the submit button's `disabled` expression, so a failed preview blocks confirmation. Run the file again.
Expected: "still allows deletion after a failed preview" FAILS and the other six pass. Remove the clause and re-run to green.

This is the guard that matters most: blocking on failure is the obvious-looking change a later reader might make on purpose, and D5 says no.

- [ ] **Step 7: Run all four gates**

```bash
pnpm --filter @onlooker/web test
pnpm --filter @onlooker/web typecheck
pnpm --filter @onlooker/web lint
bash scripts/source-guards.test.sh
```

Expected: web suite **527 → 535** (+2 contract in Task 3, +2 client in Task 4, +4 panel here); the API side gains **+9** separately (6 in Task 1, 3 in Task 2), so run `pnpm --filter @onlooker/api test` too before the PR. `tsc --noEmit` silent; biome 0 errors, with the 9 pre-existing `noExplicitAny` warnings in `mockApi.test.ts` still warnings; source guards `all 42 tests passed`.

If biome reports a formatting error, run `pnpm exec biome check --write` on the files you touched and re-run the suite — the formatter rewraps JSX and test bodies, and a rewrite after the tests pass still needs a re-run.

- [ ] **Step 8: Commit**

Invoke `/git-workflow:commit` with the two files.

---

## Closing out

Not plan tasks, but do not skip them:

- `bd update onlooker-px7ssn.4 --append-notes "..."` with anything a later reader needs that is not in the spec — measurements taken, anything the ablations revealed, any copy that changed under review.
- All four gates green before the PR, including `bash scripts/source-guards.test.sh`.
- Open the PR with `/git-workflow:pr`. The body should name the two brief corrections recorded in the spec (D2 already satisfied the semantics criterion; D5 had assigned the disclosure to `.5`), because a reviewer reading the bead alone will not see them.
- `onlooker-px7ssn.4` closes when the PR merges, not when the branch is pushed. `.1` sat open for two days that way, and `.5` for a few hours.
- When `.4` merges, the parent `onlooker-px7ssn` has no open children. Check its Done-when against what actually shipped before closing it.
