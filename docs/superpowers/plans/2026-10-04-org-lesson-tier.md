# Org Lesson Tier Implementation Plan (Stage 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the `org` lesson tier — a lesson pushed with a machine token bound to an org becomes readable, by name, to that org's other members and to nobody else.

**Architecture:** `lessons` gains a nullable `org_id`; the read predicate's org disjunct rekeys from `user_id IN (<the reader's org-mates>)` onto `org_id IN (<the reader's orgs>)`, which is both the capability and the fix for a real over-sharing bug. The server stamps `org_id` from the machine token rather than accepting it from the client, so a lesson contract gains no org field. Attribution and the owner-retract path hang off that column, and the push gate for `org` opens in the last task, once every read path it implies exists.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Drizzle ORM, Vitest with `@cloudflare/vitest-pool-workers`, Biome, React 19, pnpm + turbo.

**Source spec:** `docs/superpowers/specs/2026-10-04-org-visibility-tier-design.md` — Stage 2 sections, plus D2, D3, D4 and D6.
**Linear:** ONL-141. **Bead:** `onlooker-wi9ftq.2`. **Stage 1:** merged and deployed as `9d22a1a` (PR #195).

---

## Global Constraints

Every task's requirements implicitly include this section. The first six are not
style preferences — each one is a specific failure this repository has already
paid for, most of them during Stage 1.

1. **Four gates, not three.** For every package you touch:
   `pnpm --filter <pkg> test`, `pnpm --filter <pkg> typecheck`,
   `pnpm --filter <pkg> lint`, and `bash scripts/source-guards.test.sh`.
   The fourth is wired into no pnpm script — it runs as a bare bash step in
   `.github/workflows/deploy.yml`, so no local sweep and no diff review reaches
   it. PR #188 passed every local gate and failed CI on exactly this.
2. **A test must be able to observe the condition it names, and an opinion that
   it can is not evidence.** For every test asserting a guard, a refusal, or a
   leak that does not happen: break the thing it guards, run the test, confirm
   it FAILS, restore, confirm it passes. Report both runs. Stage 1 shipped five
   tests that could not fail; four were mine.
3. **Never judge a suite by a piped command's exit code.** `pnpm test | tail`
   exits with `tail`'s status, and `grep -c` exits non-zero on zero matches.
   Run each suite on its own and read its summary line.
4. **`pnpm --filter @onlooker/db build` before `generate:expected-schema`.**
   `packages/db/scripts/generate-expected-schema.mjs` imports
   `../dist/schema.js`, not `src/`. Skipping the build regenerates the schema
   you had before your edit, silently.
5. **Touching `@onlooker/api-contract` means running BOTH suites** — `apps/api`
   and `apps/web`. The contract table describes two implementations, and a case
   added without teaching `apps/web/src/api/mockApi.ts` the new field turns the
   web suite red. Stage 1's Task 4 did exactly that.
6. **A fresh worktree is red until `pnpm install && pnpm build`.** The failure
   reads `Cannot find module '../dist/schema.js'` and looks like a code defect.
7. **Only `apps/api/src/db/lessons.ts` and `apps/api/src/db/pool.ts` may query
   `lessons` or `lesson_feed`.** `scripts/source-guards.test.sh` enforces it in
   both raw-SQL and drizzle-builder forms, over every `.ts` under
   `apps/api/src` except `*.test.ts`. A third query home fails that bare bash
   step. This is why attribution and the org retract land in those two files
   rather than in a new org module.
8. **`role` read out of the database is narrowed with `toOrgRole()`, never a
   bare `as OrgRole`.** `apps/api/src/db/orgs.ts:32`.
9. **No predicted query plans.** Task 7 measures the plan and pastes captured
   output into the spec. A plan a document guesses at is the error this repo's
   own notes keep catching.
10. **`TEST_PASSWORD` is imported from `test-support/lessons.js`, never
    retyped.** A secret-scanning hook scans the entire replacement text of an
    edit and will block the write.
11. **Edit tracked files with `Edit`/`Write`/`MultiEdit`, never `sed -i` or a
    heredoc.** The `lineage` and `inspector` plugins hook `PostToolUse` on the
    file tools only; a shell edit moves the same bytes invisibly. See
    `CLAUDE.md`.
12. **Every commit routes through the `/git-workflow:commit` skill.** If it is
    not in your skill list, mirror its contract:
    `<type>(<scope>): <subject> :emoji:`, American English, why-focused body,
    subject ≤72 chars including the emoji.
13. **American English** in code, comments, docs and commit messages.
14. **Foreign keys are ENFORCED in the test D1** — measured in Task 2,
    2026-10-04. A test that writes a literal `org_id` such as `"org-a"` into
    `lessons` or `machine_tokens` fails the constraint, because `orgs` has no
    such row. Every test in Tasks 3 through 6 that stamps an org must create a
    real org first — `createOrgWithOwner(db(), "Acme", someUserId)` in a
    `beforeEach`, then use the id it returns — or insert the `orgs` row
    directly. Where a later task's code block in this plan still shows a bare
    `"org-a"`, that literal stands for a real org id obtained this way, not for
    itself. This also means Task 1's `ON DELETE SET NULL` is live behavior in
    the suite rather than a declaration nothing exercises.
15. **drizzle-kit v0.22.8 silently drops `ON DELETE` from an `ALTER TABLE ADD
    COLUMN`** — measured during Task 1, 2026-10-04. Its
    `SQLiteAlterTableAddColumnConvertor` builds the inline reference from
    `tableTo`/`columnsTo` alone and never reads `onDelete`, unlike the
    CREATE-TABLE path that produced `0010`'s correct `ON DELETE cascade`. So
    `schema.ts` and `meta/*_snapshot.json` recorded `set null` while the only
    artifact that executes said nothing, and **nothing in this repo would have
    caught it**: `generate-expected-schema.mjs` records columns and indexes but
    no foreign-key actions, so the deployed-schema drift check is blind to the
    whole class. The generated file carries drizzle's own instruction that this
    case "has to be done manually". Ruled by the repo owner on 2026-10-04:
    **hand-complete the delete action and comment why.** This is the single
    exception to "generated, never hand-written" below — a future generate
    diffs against the snapshot rather than against the SQL, so the edit
    introduces no drift. Any later migration in this plan that adds a column
    with a foreign key must check the emitted SQL for the same omission.

## File Structure

**`packages/db/src/schema.ts`** — `lessons.org_id` and `machine_tokens.org_id`,
both nullable, both `onDelete: "set null"`.
**`packages/db/migrations/0011_*.sql`** — generated, then hand-completed with the
`ON DELETE SET NULL` drizzle-kit drops on an `ALTER TABLE ADD COLUMN`. See
Global Constraint 15; that omission is the only edit a generated migration in
this plan may carry.
**`apps/api/src/db/schema-foreign-keys.test.ts`** *(new)* — `PRAGMA
foreign_key_list` against a database built from the real migrations, because no
drift check covers foreign-key actions.
**`packages/db/src/expected-schema.ts`** — regenerated; the deployed-schema
drift check reads it.

**`apps/api/src/db/orgs.ts`** — gains `orgIdsForUser`, the resolver the
predicate reads. Already owns membership and roles.
**`apps/api/src/db/pool.ts`** — the predicate rekey, and attribution. Stays the
only place a visibility predicate is constructed, and the only read that returns
lesson content to a caller.
**`apps/api/src/db/lessons.ts`** — `createLessonsWithFeed` stamps `org_id`;
`retractOrgLesson` joins `transitionLesson` and `retractAnyLesson` as a third
function; `probeLessonIds` selects `org_id`.
**`apps/api/src/db/machine-tokens.ts`** — a token carries an org.
**`apps/api/src/routes/orgs-lessons.ts`** *(new)* — the owner-retract route,
beside its five sibling org route files.
**`apps/api/src/routes/lessons.ts`** — the push gate opens, and the handler
stamps the token's org.
**`apps/api/src/routes/lessons-browser.ts`** — emits `authors`.
**`packages/api-contract/src/index.ts`** — the new response fields, pinned.
**`apps/web/src/api/{machinesApi,lessonsApi,mockApi}.ts`**,
**`apps/web/src/pages/{MachinesPage,LessonsPage}.tsx`** — the org picker and the
author line.

**Deliberately untouched:** `apps/api/src/routes/lessons-public.ts`. The
anonymous route's response shape and its `readPoolLesson(env.DB, null, ...)`
call stay byte-identical. A predicate bug on an authenticated route leaks to one
signed-in user; the same bug there leaks to the internet.

---

### Task 1: The columns

**Files:**
- Modify: `packages/db/src/schema.ts` (`lessons` ~`:173-245`, `machine_tokens` ~`:120-156`)
- Create: `packages/db/migrations/0011_<drizzle-generated-name>.sql` (generated)
- Modify: `packages/db/migrations/meta/_journal.json` (generated)
- Modify: `packages/db/src/expected-schema.ts` (generated)
- Test: `packages/db/src/__tests__/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `lessons.org_id` and `machine_tokens.org_id`, both `TEXT` nullable
  referencing `orgs(id)` with `ON DELETE set null`. Every later task reads one
  of them.

**Why nullable rather than defaulted:** SQLite refuses
`ADD COLUMN ... NOT NULL` without a non-NULL default even on an empty table —
the constraint `promoted_at` and `author_key` both document in this same file. A
nullable column needs no backfill and no `''` sentinel for a later reader to
reason about.

**Why `set null` rather than cascade:** combined with the predicate, that is the
direction that fails closed. An `org` lesson whose org is gone has a NULL
`org_id`, matches nothing, and becomes unreadable rather than orphaned into
something broader — `org_id IN (...)` is never true for NULL. A token whose org
is gone becomes private-only, which is the same shape as a token minted without
an org. Nothing exercises either path today: there is deliberately no
`DELETE /api/orgs/:id` route, but the migration has to choose.

- [ ] **Step 1: Write the failing schema test**

Append to `packages/db/src/__tests__/schema.test.ts`:

```ts
describe("the org lesson tier's columns", () => {
	it("gives lessons a nullable org_id", () => {
		const column = getTableConfig(lessons).columns.find(
			(c) => c.name === "org_id",
		);
		expect(column).toBeDefined();
		expect(column?.getSQLType().toUpperCase()).toBe("TEXT");
		// Nullable is the point, not an oversight: a private or public lesson
		// has no org, and SQLite cannot add a NOT NULL column without a
		// default to a table that already exists.
		expect(column?.notNull).toBe(false);
	});

	it("gives machine_tokens a nullable org_id", () => {
		const column = getTableConfig(machine_tokens).columns.find(
			(c) => c.name === "org_id",
		);
		expect(column).toBeDefined();
		expect(column?.getSQLType().toUpperCase()).toBe("TEXT");
		// Null means a private-only token, which is what every token minted
		// before this change is.
		expect(column?.notNull).toBe(false);
	});
});
```

Check the file's existing imports first — it already imports `getTableConfig`
and the tables it describes. Add `lessons` and `machine_tokens` to that import
only if they are not already there; do not add a second import statement for the
same module.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @onlooker/db test
```

Expected: both new cases FAIL on `expect(column).toBeDefined()`.

- [ ] **Step 3: Add the columns**

In `packages/db/src/schema.ts`, inside `machine_tokens`'s column object, after
`revoked_at`:

```ts
		/**
		 * The org this token pushes to, or null for a private-only token.
		 *
		 * Set when the token is minted and never afterward, which is what makes
		 * D3 true: the server reads the org from the credential rather than
		 * from the request, so a client cannot name an org its holder does not
		 * belong to and a stolen token cannot be retargeted. The cost is one
		 * token per org, deliberately.
		 */
		org_id: text("org_id").references(() => orgs.id, {
			onDelete: "set null",
		}),
```

In `lessons`'s column object, after `author_key`:

```ts
		/**
		 * The org this lesson was shared with, or null.
		 *
		 * Earns a column under this table's own stated rule - only the fields
		 * the server filters or orders on are lifted out of `body` - because
		 * the read predicate filters on it.
		 *
		 * Stamped by the server from the push credential, never carried in the
		 * lesson contract. Set only on a row whose visibility is 'org': a
		 * private row with an org_id would be invisible to the org but would
		 * make it reachable by the org-retract path, which authorizes on this
		 * column.
		 *
		 * NULL is the fail-closed value. `org_id IN (...)` is never true for
		 * NULL, so an 'org' row that somehow lacks an org matches nothing for
		 * every reader including its author's org-mates.
		 */
		org_id: text("org_id").references(() => orgs.id, {
			onDelete: "set null",
		}),
```

`orgs` is declared later in the file than both tables. That is fine — drizzle's
`references` takes a thunk precisely so declaration order does not matter, and
`org_memberships` already points at `users` the same way.

Do **not** add an index in this task. Whether the org disjunct wants
`(visibility, org_id, promoted_at, id)` is Task 7's measurement to settle, and
this repo's rule is that a plan is measured rather than predicted.

- [ ] **Step 4: Generate the migration**

```bash
pnpm --filter @onlooker/db generate:migrations
```

Then **read the generated file** and confirm it contains two `ALTER TABLE ... ADD`
statements and nothing else — no table rebuild, no `DROP`. SQLite's
`ALTER TABLE ADD COLUMN` cannot add a column with a `REFERENCES` clause in every
version, and drizzle-kit sometimes answers that by recreating the table. A
recreate is not acceptable here: `lessons` holds production rows.

Paste the file's actual contents into your task report. If it rebuilds a table
rather than altering it, STOP and report that — do not hand-edit a rebuild and
do not proceed.

**Then check the `REFERENCES` clause for a missing `ON DELETE SET NULL`, and
complete it by hand if it is missing.** drizzle-kit v0.22.8 drops the delete
action on an `ALTER TABLE ADD COLUMN` and says in its own emitted comment that
this case must be handled manually — the full measurement is Global Constraint
15. Add a short comment above the statements recording what was completed and
why, so a later reader does not revert it to the generator's output. This is the
only hand edit a generated migration in this plan may carry: a table rebuild
still stops the task.

Then prove the action reached the database rather than asserting it, because
`generate-expected-schema.mjs` tracks no foreign-key actions and would not
notice. Create `apps/api/src/db/schema-foreign-keys.test.ts` asserting that
`PRAGMA foreign_key_list` reports `SET NULL` for `lessons.org_id` and
`machine_tokens.org_id` against `env.DB`, which has the real migrations applied
— `apps/api/src/db/pool-query-plan.test.ts` is the nearest precedent for using a
migrated database directly. Read the PRAGMA's real output first and match its
actual column names and casing. Ablate it: drop the action from the `lessons`
statement, watch the test fail naming the wrong action, restore, re-run.

- [ ] **Step 5: Regenerate the expected schema**

```bash
pnpm --filter @onlooker/db build
pnpm --filter @onlooker/db generate:expected-schema
```

The build is not optional — the generator imports `../dist/schema.js`. Confirm
`git diff packages/db/src/expected-schema.ts` shows `org_id` added under both
`lessons` and `machine_tokens`.

- [ ] **Step 6: Run the gates**

```bash
pnpm --filter @onlooker/db test
pnpm --filter @onlooker/db typecheck
pnpm --filter @onlooker/db lint
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

Expected: the two new cases pass, every existing case still passes, 42 source
guards pass. `apps/api` is in scope because the foreign-key test lives there,
and because adding a column to `lessons` can break an existing test that
enumerates the table's columns exactly — if one does, update it in place rather
than working around it.

- [ ] **Step 7: Commit**

Route through `/git-workflow:commit`. Stage exactly:
`packages/db/src/schema.ts`, `packages/db/src/__tests__/schema.test.ts`,
`packages/db/src/expected-schema.ts`, the new `packages/db/migrations/0011_*.sql`,
`packages/db/migrations/meta/_journal.json`, the `meta/0011_snapshot.json`
drizzle wrote beside it, and
`apps/api/src/db/schema-foreign-keys.test.ts`.

Two commits rather than one: the generator's honest output first, then the
documented hand completion of the delete action with its test. That history
tells a later reader what the tool produced and what a human added, which one
squashed commit cannot.

---

### Task 2: Rekey the predicate onto the lesson's org

**Files:**
- Modify: `apps/api/src/db/orgs.ts` (append `orgIdsForUser`)
- Modify: `apps/api/src/db/pool.ts:22-118` (the type, the stub, the bound), `:145-185` (the predicate), `:194-202` and `:281-288` (the resolver call)
- Modify: `apps/api/src/db/lessons.ts:559-564` and `:575-582` (wire the real resolver)
- Test: `apps/api/src/db/pool.test.ts`, `apps/api/src/db/orgs.test.ts`

**Interfaces:**
- Consumes: `lessons.org_id` (Task 1).
- Produces:
  - `orgIdsForUser(db: D1Database, userId: string): Promise<string[]>` in `db/orgs.ts`
  - `export type OrgIds = (db: D1Database, userId: string) => Promise<string[]>` in `db/pool.ts`
  - `export const noOrgIds: OrgIds` — the fail-closed default
  - `export const MAX_READER_ORGS_BOUND = 50`
  - `readPool(db, principal, filters, orgIds?: OrgIds)` and
    `readPoolLesson(db, principal, id, orgIds?: OrgIds)` — same arity as today

**This task is deliberately indivisible.** Renaming the resolver without
rekeying the predicate, or the reverse, leaves a state where org ids are bound
as user ids — a predicate that silently authorizes on the wrong column. There is
no safe intermediate commit, so there is no sub-task boundary.

- [ ] **Step 1: Write the failing resolver test**

In `apps/api/src/db/orgs.test.ts`, append:

```ts
describe("orgIdsForUser", () => {
	it("returns every org this user belongs to", async () => {
		const ada = (await createUser(db(), "ada@example.com", "hash", "Ada")).id;
		const a = await createOrgWithOwner(db(), "Acme", ada);
		const b = await createOrgWithOwner(db(), "Beta", ada);

		expect((await orgIdsForUser(db(), ada)).sort()).toEqual([a.id, b.id].sort());
	});

	it("returns an empty list for a user in no org", async () => {
		const solo = (await createUser(db(), "solo@example.com", "hash", "Mo")).id;

		expect(await orgIdsForUser(db(), solo)).toEqual([]);
	});

	it("does not return an org the user only has an invite to", async () => {
		// Membership is the predicate's input, and an unaccepted invite is not
		// membership. If this ever returned the invited org, a pending invite
		// would read the org's lessons.
		const ada = (await createUser(db(), "ada@example.com", "hash", "Ada")).id;
		const invitee = (await createUser(db(), "bo@example.com", "hash", "Bo")).id;
		const org = await createOrgWithOwner(db(), "Acme", ada);
		await createInvite(db(), org.id, "bo@example.com", "member", "hash-x", ada);

		expect(await orgIdsForUser(db(), invitee)).toEqual([]);
	});
});
```

Match the file's existing fixture idiom — read its `beforeEach` and reuse the
`db()` helper and whatever reset it already calls rather than adding your own.
`createInvite`'s real exported name and parameter order are in
`apps/api/src/db/org-invites.ts` or `db/orgs.ts`; use the actual signature, and
if no such function exists, insert the invite row with a raw
`INSERT INTO org_invites` in the test instead.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @onlooker/api test -- orgs.test
```

Expected: FAIL — `orgIdsForUser is not a function`.

- [ ] **Step 3: Implement the resolver**

Append to `apps/api/src/db/orgs.ts`:

```ts
/**
 * The ids of the orgs this user belongs to.
 *
 * This is what the read predicate's org disjunct binds. It reads
 * `org_memberships` by `user_id`, which `org_memberships_user_id_idx` exists
 * for.
 *
 * Ordered by id so one reader's statement is byte-identical between runs, which
 * is worth having on its own: an unordered IN list makes two otherwise
 * identical reads produce two different prepared statements. Do not justify it
 * by pool-query-plan.test.ts - that test uses the default noOrgIds and binds no
 * org id at all, so the dependency would be fictitious.
 *
 * Membership only. A pending invite is not membership, and if it were counted
 * here an invitation would read the org's lessons before anybody accepted it.
 */
export async function orgIdsForUser(
	db: D1Database,
	userId: string,
): Promise<string[]> {
	const rows = await client(db)
		.select({ org_id: org_memberships.org_id })
		.from(org_memberships)
		.where(eq(org_memberships.user_id, userId))
		.orderBy(org_memberships.org_id);

	return rows.map((row) => row.org_id);
}
```

- [ ] **Step 4: Run the resolver tests and watch them pass**

```bash
pnpm --filter @onlooker/api test -- orgs.test
```

Expected: PASS.

- [ ] **Step 5: Rewrite the predicate's org disjunct**

In `apps/api/src/db/pool.ts`:

Replace the `OrgMembers` type and its doc comment (`:22-40`) with:

```ts
/**
 * The orgs the reader belongs to.
 *
 * Contract: return the ids of orgs `userId` is a member of. Never include an
 * org they do not belong to. NEVER THROW - an org list that cannot be resolved
 * must return [], so a membership outage narrows access instead of widening it.
 * `readPool` enforces that structurally by catching anything this throws, so
 * the property does not rest on a resolver's politeness.
 *
 * This used to return the ids of the reader's org-MATES, and the predicate
 * matched them against `lessons.user_id`. That authorized on who the author
 * was rather than on which org the lesson was shared with, which over-shares
 * the moment a user can belong to two orgs: Alice in orgs A and B pushes one
 * org lesson, and Bob (A only) and Carol (B only) can both read it because each
 * shares AN org with Alice. The rename is not cosmetic - a function whose name
 * says "members" and whose values are orgs is the kind of thing a later reader
 * fixes in the wrong direction.
 */
export type OrgIds = (db: D1Database, userId: string) => Promise<string[]>;
```

Replace `noOrgMembers` and its doc comment (`:42-92`) with:

```ts
/**
 * The fail-closed default: a reader in no orgs.
 *
 * Still the default parameter rather than the live resolver, deliberately. A
 * forgotten wiring then narrows a read instead of widening one, and
 * `routes/lessons-public.ts` keeps an anonymous path that resolves no orgs at
 * all. What catches a forgotten wiring is a test through the production entry
 * point - see "resolves the reader's orgs" in db/pool.test.ts - rather than a
 * default that papers over it.
 */
export const noOrgIds: OrgIds = async () => [];
```

Replace `MAX_ORG_MEMBERS_BOUND` and its doc comment (`:100-118`) with:

```ts
/**
 * The largest number of a reader's orgs this predicate will bind into one
 * query.
 *
 * D1 caps bound parameters per query at 100 - the fact `lessons.ts`'s
 * `ID_LOOKUP_CHUNK` derives from, halving it for the same reason. This query
 * carries other binds beside the org list: both `user_id` binds in
 * visibilityPredicate, up to four `statuses`, two cursor binds, and the page
 * LIMIT.
 *
 * What changed with the rekey is what this bounds. It used to limit an org's
 * SIZE - a hard ceiling on the members an `IN (...)` list could express, past
 * which the predicate silently stopped recognizing members, which is why
 * MAX_ORG_MEMBERS_BOUND was a standing ceiling on how big an org could be at
 * all. Now it limits how many orgs ONE READER may have counted in a single
 * query, which is one or two in practice and 50 at the cap. The org-size
 * ceiling is gone, not raised.
 */
export const MAX_READER_ORGS_BOUND = 50;
```

In `visibilityPredicate` (`:145-173`), change the signature's second parameter
from `orgMemberIds: string[]` to `readerOrgIds: string[]`, and replace the org
block:

```ts
		// Truncated, not thrown, for the same reason as before: this read also
		// answers the caller's own private lessons, and a reader in more orgs
		// than the bound should lose org rows rather than lose the whole page.
		// Unreachable in practice now that the bound counts the reader's orgs
		// rather than an org's members.
		const bounded = readerOrgIds.slice(0, MAX_READER_ORGS_BOUND);

		if (bounded.length > 0) {
			visible.push(
				`(visibility = 'org' AND org_id IN (${bounded
					.map(() => "?")
					.join(", ")}))`,
			);
			binds.push(...bounded);
		}
```

Also update the function's doc comment: the line reading "Note that org
membership widens `org` only. A member of your org still cannot read your
`private` lessons" stays true and stays — it is now true because the disjunct
tests `visibility = 'org'` against the lesson's org rather than against the
author's identity.

- [ ] **Step 6: Make the never-throw contract structural**

In `readPool` (`:201`) replace:

```ts
	const orgMemberIds = principal ? await orgMembers(db, principal.userId) : [];
```

with:

```ts
	const readerOrgIds = await resolveOrgIds(db, principal, orgIds);
```

and in `readPoolLesson` (`:287`) make the identical replacement. Rename both
functions' fourth parameter from `orgMembers: OrgMembers = noOrgMembers` to
`orgIds: OrgIds = noOrgIds`, and pass `readerOrgIds` into
`visibilityPredicate`.

Add above `visibilityPredicate`:

```ts
/**
 * The reader's orgs, or none - never an exception.
 *
 * The OrgIds contract says a resolver never throws. This catches anyway,
 * because "narrows on failure" is a property worth having by construction
 * rather than by agreement: a resolver is a function someone else writes, and
 * the cost of being wrong here is that a membership outage takes down a read
 * that also serves the caller's own private lessons.
 *
 * Narrowing is the only safe direction, so there is deliberately no error
 * propagated to the caller and nothing retried.
 */
async function resolveOrgIds(
	db: D1Database,
	principal: Principal | null,
	orgIds: OrgIds,
): Promise<string[]> {
	if (!principal) return [];
	try {
		return await orgIds(db, principal.userId);
	} catch {
		return [];
	}
}
```

- [ ] **Step 7: Wire the real resolver at the two production entry points**

In `apps/api/src/db/lessons.ts`, add `orgIdsForUser` to the imports from
`./orgs.js` (create the import if the file has none), then:

```ts
export async function listLessonsPage(
	db: D1Database,
	userId: string,
	opts: { statuses?: string[]; cursor?: string | null; limit: number },
): Promise<LessonPage> {
	return readPool(db, { userId }, opts, orgIdsForUser);
}
```

```ts
export async function getLessonForUser(
	db: D1Database,
	userId: string,
	id: string,
): Promise<{ lesson: unknown; own: boolean } | null> {
	const lesson = await readPoolLesson(db, { userId }, id, orgIdsForUser);
```

Leave the rest of `getLessonForUser` alone. Do **not** touch
`routes/lessons-public.ts` — its `readPoolLesson(env.DB, null, params.id)` call
resolves no orgs because the principal is null, and its comment explains why no
caller-supplied value may reach that call.

- [ ] **Step 8: Rewrite the pool tests onto the new key**

In `apps/api/src/db/pool.test.ts`:

Change the import to `import { MAX_READER_ORGS_BOUND, readPool, readPoolLesson } from "./pool.js";`

Teach the fixture to stamp an org, since `org_id` is a column rather than a
contract field and `seedFor`'s overrides go into the body:

```ts
async function seedFor(
	owner: string,
	overrides: Record<string, unknown>,
	orgId: string | null = null,
): Promise<TLesson> {
	const written = lesson(overrides) as TLesson;
	await createLessonsWithFeed(db(), owner, [written], orgId);
	return written;
}
```

Replace the four org cases (`:133-194`) with these. The names say what is
observed, because the old ones named a resolver that no longer exists:

```ts
	it("does not return another user's org lesson to a reader in no orgs", async () => {
		await seedFor(theirs, { visibility: "org" }, "org-a");
		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("returns an org lesson to a reader in that org", async () => {
		const shared = await seedFor(theirs, { visibility: "org" }, "org-a");

		const page = await readPool(db(), { userId: mine }, { limit: 50 }, async () => [
			"org-a",
		]);

		expect(idsIn(page)).toEqual([shared.id]);
	});

	it("does not return an org lesson to a reader in a different org", async () => {
		await seedFor(theirs, { visibility: "org" }, "org-a");

		const page = await readPool(db(), { userId: mine }, { limit: 50 }, async () => [
			"org-b",
		]);

		expect(idsIn(page)).toEqual([]);
	});

	// THE REGRESSION TEST for the bug this stage fixes, and the one test here
	// that must go through the PRODUCTION entry point rather than injecting a
	// resolver.
	//
	// Corrected 2026-10-04 after the Task 2 review: the first version of this
	// test injected `async () => ["org-b"]` into readPool, which made it
	// operationally identical to the "different org" case above and unable to
	// fail. The resolver's semantics are half of the bug. Reverting the
	// predicate alone, with an injected resolver, binds org ids against
	// `user_id`, matches nobody, and fails closed - so the ablation passed
	// while proving nothing. See Step 10, which now restores both halves.
	it("does not leak an org lesson to a reader who shares only a DIFFERENT org with its author", async () => {
		// Alice belongs to orgs A and B; the lesson is shared with A; Carol
		// belongs to B only. Carol and Alice share an org, which is exactly
		// what the old predicate keyed on - it bound the reader's org-MATES
		// against lessons.user_id, so sharing ANY org with the author was
		// enough to read the lesson.
		const alice = (await createUser(db(), "alice@example.com", "hash", "Alice")).id;
		const carol = (await createUser(db(), "carol@example.com", "hash", "Carol")).id;
		const bob = (await createUser(db(), "bob@example.com", "hash", "Bob")).id;
		const orgA = await createOrgWithOwner(db(), "Org A", alice);
		const orgB = await createOrgWithOwner(db(), "Org B", alice);
		await addMembership(db(), orgA.id, bob, "member");
		await addMembership(db(), orgB.id, carol, "member");

		const sharedWithA = await seedFor(alice, { visibility: "org" }, orgA.id);

		expect(idsIn(await listLessonsPage(db(), carol, { limit: 50 }))).toEqual([]);

		// The positive half, so this cannot pass by the fixture being empty or
		// the lesson being unreadable to everyone: Bob, in org A, does see it.
		expect(idsIn(await listLessonsPage(db(), bob, { limit: 50 }))).toEqual([
			sharedWithA.id,
		]);
	});

	it("matches nothing for an org lesson with a NULL org_id", async () => {
		// The fail-closed property of `org_id IN (...)`: never true for NULL.
		// An 'org' row that somehow lacks an org is unreadable rather than
		// broadly readable.
		await seedFor(theirs, { visibility: "org" }, null);

		const page = await readPool(db(), { userId: mine }, { limit: 50 }, async () => [
			"org-a",
			"org-b",
		]);

		expect(idsIn(page)).toEqual([]);
	});

	it("still hides a private lesson that carries an org_id", async () => {
		// Org membership widens `org`, never `private`.
		//
		// The column is written directly because the writer refuses this state
		// on purpose: createLessonsWithFeed stamps org_id only onto rows whose
		// visibility is 'org'. Seeding it through the writer - as the first
		// version of this test did - produces a NULL org_id and a test that
		// passes for the wrong reason, proving only that NULL matches nothing.
		// Building the row by hand is what makes this prove the real claim:
		// the predicate requires `visibility = 'org'` AND the org match, so a
		// private row that somehow acquired an org is still private.
		const priv = await seedFor(theirs, { visibility: "private" });
		await db()
			.prepare("UPDATE lessons SET org_id = ? WHERE id = ?")
			.bind(orgRow.id, priv.id)
			.run();

		const page = await readPool(
			db(),
			{ userId: mine },
			{ limit: 50 },
			async () => [orgRow.id],
		);

		expect(idsIn(page)).toEqual([]);
	});

	it("narrows rather than widens when the resolver throws", async () => {
		// The never-throw contract, observed rather than assumed. A membership
		// outage must not take down a read that also serves the caller's own
		// lessons, and must not widen one.
		const own = await seedFor(mine, { visibility: "private" });
		await seedFor(theirs, { visibility: "org" }, "org-a");

		const page = await readPool(db(), { userId: mine }, { limit: 50 }, async () => {
			throw new Error("org_memberships is unavailable");
		});

		expect(idsIn(page)).toEqual([own.id]);
	});

	it("truncates an oversized reader-org list rather than binding it all", async () => {
		// MAX_READER_ORGS_BOUND keeps the `IN (...)` list under D1's
		// bound-parameter cap. Naming the lesson's org past the bound proves
		// the excess is dropped rather than the query breaking.
		await seedFor(theirs, { visibility: "org" }, "org-a");
		const padding = Array.from(
			{ length: MAX_READER_ORGS_BOUND },
			(_, i) => `padding-${i}`,
		);

		const page = await readPool(
			db(),
			{ userId: mine },
			{ limit: 50 },
			async () => [...padding, "org-a"],
		);

		expect(idsIn(page)).toEqual([]);
	});
```

Then add the wiring test, which is what stands in for a live default:

```ts
describe("listLessonsPage", () => {
	it("resolves the reader's orgs", async () => {
		// Through the production entry point, not readPool: this is the test
		// that catches a forgotten resolver argument, which is otherwise a
		// silent narrowing nothing fails on.
		const ada = (await createUser(db(), "ada2@example.com", "hash", "Ada")).id;
		const org = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), org.id, mine, "member");
		const shared = await seedFor(ada, { visibility: "org" }, org.id);

		const page = await listLessonsPage(db(), mine, { limit: 50 });

		expect(idsIn(page)).toEqual([shared.id]);
	});
});
```

This needs `createOrgWithOwner` and `addMembership` imported from `./orgs.js`,
`listLessonsPage` from `./lessons.js`, and `org_memberships`/`orgs` cleared in
the suite's `beforeEach` — add
`await db().prepare("DELETE FROM org_memberships").run();` and
`await db().prepare("DELETE FROM orgs").run();` before the existing
`DELETE FROM users`.

**The single-lesson read needs the same three cases.** Added 2026-10-04 after
the Task 2 review found this path untested: `readPoolLesson` shares the
predicate with `readPool`, so a divergence between them means a lesson hidden
from the list is reachable by id, or the reverse, and a dropped resolver
argument at `getLessonForUser` fails nothing at all.

```ts
	it("returns an org lesson to a reader in that org", async () => {
		const shared = await seedFor(theirs, { visibility: "org" }, orgRow.id);

		const found = await readPoolLesson(db(), { userId: mine }, shared.id, async () => [
			orgRow.id,
		]);

		expect((found as { id: string } | null)?.id).toBe(shared.id);
	});

	it("returns null for an org lesson to a reader in a different org", async () => {
		const shared = await seedFor(theirs, { visibility: "org" }, orgRow.id);

		expect(
			await readPoolLesson(db(), { userId: mine }, shared.id, async () => [
				"some-other-org",
			]),
		).toBeNull();
	});
```

```ts
describe("getLessonForUser", () => {
	it("resolves the reader's orgs", async () => {
		// The by-id twin of the listLessonsPage wiring test, and the one that
		// catches a missing fourth argument on the readPoolLesson call.
		const ada = (await createUser(db(), "ada3@example.com", "hash", "Ada")).id;
		const org = await createOrgWithOwner(db(), "Acme Two", ada);
		await addMembership(db(), org.id, mine, "member");
		const shared = await seedFor(ada, { visibility: "org" }, org.id);

		const found = await getLessonForUser(db(), mine, shared.id);

		expect(found).not.toBeNull();
	});
});
```

`orgRow` is whatever real org the suite's fixture creates — foreign keys are
enforced, so a literal id will not do (Global Constraint 14). `"some-other-org"`
is a non-existent org id, which is fine: it is bound into the predicate, never
written to a column.

- [ ] **Step 9: Run every suite the rekey touches**

```bash
pnpm --filter @onlooker/api test -- pool
pnpm --filter @onlooker/api test -- orgs
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

Expected: all green. `routes/lessons.test.ts:187` and `routes/lessons.ts:107`
both mention `OrgMembers` in prose; update those two comments to name `OrgIds`
and the gate's real remaining reason, which is that the gate is still shut and
opens in Task 9. Prose wraps at ~80 columns — grep for `OrgMembers`, then read
the surrounding lines rather than trusting a single-line match.

- [ ] **Step 10: Prove the regression test can fail (REQUIRED)**

**Restore BOTH halves of the old design, not just the predicate.** This is the
correction the Task 2 review forced, and the reasoning is the point: the bug was
a predicate and a resolver agreeing on the wrong key. Reverting the predicate
alone leaves the new resolver handing it org ids, which it then binds against
`user_id`, which matches nobody — it fails closed, the test passes, and the
ablation proves nothing. Nor is hand-editing the test's injected resolver a
substitute: that measures a variant nobody ships.

First, temporarily give `orgIdsForUser` the old org-mates semantics:

```sql
SELECT DISTINCT m2.user_id AS id
FROM org_memberships m1
JOIN org_memberships m2 ON m2.org_id = m1.org_id
WHERE m1.user_id = ?
```

Second, temporarily restore the author-keyed disjunct in `visibilityPredicate`:

```ts
			visible.push(
				`(visibility = 'org' AND user_id IN (${bounded
					.map(() => "?")
					.join(", ")}))`,
			);
```

```bash
pnpm --filter @onlooker/api test -- pool
```

Expected: "does not leak an org lesson to a reader who shares only a DIFFERENT
org with its author" FAILS on its first assertion, with Carol seeing the lesson
shared with an org she does not belong to. That failure is the bug, reproduced.
Restore both edits, re-run, confirm green. Report both runs with their output.

If it does NOT leak under that pair, stop and escalate rather than adjusting the
test until it fails: that result would mean the bug's shape is misunderstood, and
every test built on that understanding needs rechecking.

- [ ] **Step 11: Commit**

Route through `/git-workflow:commit`.

---

### Task 3: Bind a machine token to an org

**Files:**
- Modify: `apps/api/src/db/machine-tokens.ts:12-41` (`MachineTokenSummary`), `:43-73` (`createMachineToken`), `:74-108` (`verifyMachineToken`), `:138+` (`listMachineTokens`)
- Modify: `apps/api/src/middleware/machine-auth.ts:16-39`
- Modify: `apps/api/src/routes/machines.ts:17-42`
- Modify: `packages/api-contract/src/index.ts`
- Modify: `apps/web/src/api/mockApi.ts`
- Test: `apps/api/src/db/machine-tokens.test.ts`, `apps/api/src/routes/machines.test.ts`

**Interfaces:**
- Consumes: `machine_tokens.org_id` (Task 1), `getMembership(db, orgId, userId)` (Stage 1, `db/orgs.ts:117`).
- Produces:
  - `createMachineToken(db, userId, name, orgId?: string | null)`
  - `verifyMachineToken` → `{ userId: string; machineId: string; orgId: string | null } | null`
  - `requireMachineToken` → `{ userId: string; machineId: string; orgId: string | null }`
  - `MachineTokenSummary.org_id: string | null`
  - `POST /api/machines` accepts an optional `org_id` in its body and echoes it

**The org is validated at minting, not at push.** `getMembership` is the check:
a caller minting a token for an org they do not belong to gets the org treatment
for a non-member, which is a 404 rather than a 403 — the convention
`orgs/authorize.ts` already sets, so a non-member cannot tell an org they are
not in from an org that does not exist.

- [ ] **Step 1: Write the failing db test**

In `apps/api/src/db/machine-tokens.test.ts`:

```ts
describe("a token bound to an org", () => {
	it("carries the org through verification", async () => {
		const created = await createMachineToken(db(), ada, "laptop", "org-a");

		const verified = await verifyMachineToken(db(), created.token);

		expect(verified).toMatchObject({ userId: ada, orgId: "org-a" });
	});

	it("verifies a token minted without an org as private-only", async () => {
		// Every token in production today is this one. Null here is what keeps
		// a deploy from changing what an existing machine may push.
		const created = await createMachineToken(db(), ada, "laptop");

		const verified = await verifyMachineToken(db(), created.token);

		expect(verified?.orgId).toBeNull();
	});

	it("reports the org in the list", async () => {
		await createMachineToken(db(), ada, "laptop", "org-a");

		const [summary] = await listMachineTokens(db(), ada);

		expect(summary.org_id).toBe("org-a");
	});
});
```

Reuse the file's existing fixture for `ada` and `db()` rather than adding new
ones. If the suite has no `orgs` row for `"org-a"` and foreign keys are enforced
in the test D1, create the org through `createOrgWithOwner` and use its id
instead of the literal — run the test to find out which, and say in your report
which it was.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @onlooker/api test -- machine-tokens
```

Expected: FAIL — `createMachineToken` takes three arguments, and `orgId` is not
on the verified result.

- [ ] **Step 3: Thread the org through the token layer**

In `apps/api/src/db/machine-tokens.ts`:

Add to `MachineTokenSummary`:

```ts
	/**
	 * The org this token pushes to, or null for a private-only token.
	 *
	 * An id rather than a name: the only page that renders this already lists
	 * the caller's orgs to offer the picker, so it can resolve the name
	 * itself, and a join here would put a second query in front of a list that
	 * does not need one.
	 */
	org_id: string | null;
```

Give `createMachineToken` a fourth parameter `orgId: string | null = null` and
write it into the insert. Default null so every existing call site keeps its
behavior.

In `verifyMachineToken`, add `org_id: machine_tokens.org_id` to the select, and
return:

```ts
	// The org travels with the credential because that is where push reads it
	// from: the server stamps the lesson's org from the token rather than from
	// the request, so a client cannot name an org its holder does not belong
	// to. Null means a private-only token.
	return { userId: row.user_id, machineId: row.id, orgId: row.org_id };
```

Add `org_id: machine_tokens.org_id` to `listMachineTokens`'s select and to the
summary it maps.

In `apps/api/src/middleware/machine-auth.ts`, widen the return type to
`Promise<{ userId: string; machineId: string; orgId: string | null }>`. The
function already returns `verified` whole, so no other change.

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm --filter @onlooker/api test -- machine-tokens
```

- [ ] **Step 5: Write the failing route test**

In `apps/api/src/routes/machines.test.ts`:

```ts
describe("minting a token for an org", () => {
	it("binds the token to an org the caller belongs to", async () => {
		const response = await call("/api/machines", token, {
			method: "POST",
			body: JSON.stringify({ name: "laptop", org_id: orgId }),
		});

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({ org_id: orgId });
	});

	it("404s an org the caller does not belong to", async () => {
		// 404 and not 403, matching orgs/authorize.ts: a non-member must not be
		// able to tell an org they are not in from an org that does not exist.
		const other = await createOrgWithOwner(db(), "Somebody Else", stranger);

		const response = await call("/api/machines", token, {
			method: "POST",
			body: JSON.stringify({ name: "laptop", org_id: other.id }),
		});

		expect(response.status).toBe(404);
	});

	it("mints a private-only token when no org is named", async () => {
		const response = await call("/api/machines", token, {
			method: "POST",
			body: JSON.stringify({ name: "laptop" }),
		});

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({ org_id: null });
	});
});
```

Use the suite's existing request helper and fixtures; `stranger` is another
signed-up account — create it the way the file already creates accounts.

- [ ] **Step 6: Run it and watch it fail, then implement**

```bash
pnpm --filter @onlooker/api test -- machines.test
```

Then in `apps/api/src/routes/machines.ts`'s `handleCreateMachine`:

```ts
	const body = (await request.json()) as { name?: unknown; org_id?: unknown };

	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (!name) {
		throw new ApiError(400, "invalid_name", "A machine needs a name");
	}

	// Membership is checked here, at minting, rather than at push. The token
	// then carries the answer, so push reads an org the holder was a member of
	// when the credential was issued and no request parameter can change it.
	//
	// 404 rather than 403 for an org the caller is not in, matching
	// orgs/authorize.ts: a non-member cannot tell that org apart from one that
	// does not exist.
	const orgId = typeof body.org_id === "string" ? body.org_id : null;
	if (orgId !== null) {
		const membership = await getMembership(env.DB, orgId, userId);
		if (!membership) {
			throw new ApiError(404, "not_found", "No such org");
		}
	}

	const created = await createMachineToken(env.DB, userId, name, orgId);

	// The raw token appears in this response and nowhere else, ever.
	return Response.json(
		{ id: created.id, name, token: created.token, org_id: orgId },
		{ status: 201 },
	);
```

Import `getMembership` from `../db/orgs.js`.

- [ ] **Step 7: Pin the new fields in the contract, and teach the mock**

In `packages/api-contract/src/index.ts`, find the machines cases. Add `org_id`
to the create case's body expectation (it is `null` for the contract's own
create, which names no org) and to the list case if that case enumerates machine
fields rather than using `expectArray`. Read the surrounding comment before
editing: the file's note at `:270` says the list case pins only
`{ machines: expectArray }`, so it may need no change at all. Say which in your
report.

In `apps/web/src/api/mockApi.ts`, add `org_id: null` to the machine objects the
mock returns from both the create and list handlers, so the two implementations
agree.

- [ ] **Step 8: Run BOTH suites**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
pnpm --filter @onlooker/web test
pnpm --filter @onlooker/web typecheck
pnpm --filter @onlooker/web lint
pnpm --filter @onlooker/api-contract test
bash scripts/source-guards.test.sh
```

Both, because you touched the contract. Read each summary line; do not pipe.

- [ ] **Step 9: Prove the 404 test can fail (REQUIRED)**

Temporarily drop the `if (!membership)` throw. Confirm "404s an org the caller
does not belong to" FAILS with a 201. Restore, re-run, report both.

- [ ] **Step 10: Commit**

---

### Task 4: Stamp `org_id` on the write

**Files:**
- Modify: `apps/api/src/db/lessons.ts:25-31` (`StoredLesson`), `:128-152` (`createLessonsWithFeed`), `:152-184` (the insert), `:243-266` (`probeLessonIds`)
- Test: `apps/api/src/db/lessons.test.ts`

**Interfaces:**
- Consumes: `lessons.org_id` (Task 1).
- Produces:
  - `createLessonsWithFeed(db, userId, lessons, orgId?: string | null)`
  - `StoredLesson` gains `org_id: string | null`

**The one subtle rule in this task.** The parameter is the TOKEN's org, and it
is stamped **only onto rows whose visibility is `'org'`**. Stamping it on every
row of a mixed batch would put an `org_id` on private lessons. That leaks
nothing through the read predicate — the org disjunct also requires
`visibility = 'org'` — but it would make a member's PRIVATE lesson reachable by
Task 6's org-retract path, which authorizes on `org_id`. An org owner being able
to retract a member's private lesson is a real defect, and this line is where it
is prevented.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/db/lessons.test.ts`:

```ts
describe("createLessonsWithFeed and the lesson's org", () => {
	const orgIdOf = async (id: string) =>
		(
			await db()
				.prepare("SELECT org_id FROM lessons WHERE id = ?")
				.bind(id)
				.first<{ org_id: string | null }>()
		)?.org_id ?? null;

	it("stamps the org on an org-visible lesson", async () => {
		const written = lesson({ visibility: "org" }) as TLesson;

		await createLessonsWithFeed(db(), ada, [written], "org-a");

		expect(await orgIdOf(written.id)).toBe("org-a");
	});

	it("leaves org_id NULL when the token names no org", async () => {
		const written = lesson({ visibility: "org" }) as TLesson;

		await createLessonsWithFeed(db(), ada, [written], null);

		expect(await orgIdOf(written.id)).toBeNull();
	});

	it("does not stamp the org onto a private lesson in the same batch", async () => {
		// The org is the TOKEN's, and a batch may mix tiers. A private row
		// carrying an org_id is invisible to the org - the predicate also
		// requires visibility = 'org' - but it would be reachable by the
		// org-retract path, which authorizes on this column. An owner must not
		// be able to retract a member's private lesson.
		const priv = lesson({ visibility: "private" }) as TLesson;
		const shared = lesson({ visibility: "org" }) as TLesson;

		await createLessonsWithFeed(db(), ada, [priv, shared], "org-a");

		expect(await orgIdOf(priv.id)).toBeNull();
		expect(await orgIdOf(shared.id)).toBe("org-a");
	});

	it("reports the org through probeLessonIds", async () => {
		const written = lesson({ visibility: "org" }) as TLesson;
		await createLessonsWithFeed(db(), ada, [written], "org-a");

		const found = await probeLessonIds(db(), [written.id]);

		expect(found.get(written.id)?.org_id).toBe("org-a");
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @onlooker/api test -- lessons.test
```

Expected: FAIL on the fourth argument, and on `org_id` being absent from
`StoredLesson`.

- [ ] **Step 3: Implement**

In `apps/api/src/db/lessons.ts`:

Add to `StoredLesson`:

```ts
	/** The org this lesson was shared with, or null. Null for every tier but 'org'. */
	org_id: string | null;
```

Change the signature:

```ts
export async function createLessonsWithFeed(
	db: D1Database,
	userId: string,
	lessons: TLesson[],
	/**
	 * The org the pushing MACHINE TOKEN is bound to, or null for a
	 * private-only token. Not a per-lesson value and not a contract field:
	 * the server reads it from the credential so a client cannot name an org
	 * its holder does not belong to.
	 */
	orgId: string | null = null,
): Promise<BatchWrite[]> {
```

In the insert, add `org_id` to the column list and a bind for it:

```ts
					.prepare(
						`INSERT INTO lessons
							(id, user_id, visibility, status, schema_version, body, promoted_at, author_key, org_id, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						lesson.id,
						userId,
						lesson.visibility,
						lesson.status,
						lesson.schema_version,
						canonicalize(lesson),
						lesson.promoted_at,
						lesson.author_key,
						// Only an org-visible row carries the token's org. A
						// private row with an org_id would be reachable by the
						// org-retract path, which authorizes on this column.
						lesson.visibility === "org" ? orgId : null,
						now,
						now,
					),
```

Count the placeholders against the column list after editing — an off-by-one
here binds `created_at` into `org_id` and the suite's failure will not say so.

In `probeLessonIds`, add `org_id` to the select list:

```ts
				`SELECT id, user_id, visibility, status, body, org_id
				 FROM lessons
				 WHERE id IN (${chunk.map(() => "?").join(", ")})`,
```

- [ ] **Step 4: Run it and watch it pass, then run the package**

```bash
pnpm --filter @onlooker/api test -- lessons.test
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

- [ ] **Step 5: Prove the private-row test can fail (REQUIRED)**

Temporarily change the bind to a bare `orgId`. Confirm "does not stamp the org
onto a private lesson in the same batch" FAILS. Restore, re-run, report both.

- [ ] **Step 6: Commit**

---

### Task 5: Attribution

**Files:**
- Modify: `apps/api/src/db/pool-page.ts:51-68` (`LessonPage`)
- Modify: `apps/api/src/db/pool.ts` (`readPool`'s select and return, plus a new `orgAuthorName`)
- Modify: `apps/api/src/db/lessons.ts:575-594` (`getLessonForUser`)
- Modify: `apps/api/src/routes/lessons-browser.ts:73-81` and `:112`
- Modify: `packages/api-contract/src/index.ts`, `apps/web/src/api/mockApi.ts`
- Test: `apps/api/src/db/pool.test.ts`, `apps/api/src/routes/lessons-browser.test.ts`

**Interfaces:**
- Consumes: the rekeyed predicate (Task 2), `lessons.org_id` (Task 1).
- Produces:
  - `LessonPage.authors: Record<string, string>` — lesson id to author name,
    always present, empty when nothing is attributed
  - `orgAuthorName(db, readerOrgIds, lessonId): Promise<string | null>` in `pool.ts`
  - `getLessonForUser` → `{ lesson, own, author_name: string | null } | null`
  - `GET /api/lessons` response gains `authors`; `GET /api/lessons/:id` gains
    `author_name`

**Three decisions this task records, because a reader cannot otherwise tell they
were considered:**

1. **Beside the documents, not inside them.** `authors` is a sidecar keyed by
   lesson id, exactly as `ownedIds` is, and for the reason
   `LessonPage.ownedIds` already gives: a lesson body is the published
   contract's shape and nothing server-computed belongs in it.
2. **A second statement, not a join.** The spec says the join "lives inside
   `readPool`", and the binding constraint behind that sentence is *location* —
   `scripts/source-guards.test.sh` forbids a new query home for `lessons`. A
   second statement inside `pool.ts` satisfies that constraint and adds no risk
   to the measured query plan, which a `LEFT JOIN users` in the main statement
   would. It is also the repo's own precedent: `getLessonForUser` already uses
   "a second statement rather than widening `readPoolLesson`'s SELECT", and
   `db/lessons.ts:583` explains why. Pages with no org rows run no second
   statement at all.
3. **A missing name is an absent key, not an invented label.** `users.name` is
   nullable. The server does not substitute an email — that is a different
   disclosure class — and does not invent "A teammate", which would be the
   server deciding copy. The web renders nothing when the key is absent.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/db/pool.test.ts`:

```ts
describe("org attribution", () => {
	it("names the author of an org lesson the reader reaches through their org", async () => {
		const shared = await seedFor(theirs, { visibility: "org" }, "org-a");

		const page = await readPool(db(), { userId: mine }, { limit: 50 }, async () => [
			"org-a",
		]);

		// `theirs` was created with the name "Bob" in this suite's beforeEach.
		expect(page.authors).toEqual({ [shared.id]: "Bob" });
	});

	it("does not name the author of a public lesson", async () => {
		// A public row carries author_key alone, so the anonymous surface's
		// disclosure is unchanged and nothing links an author across tiers.
		await seedFor(theirs, { visibility: "public" });

		const page = await readPool(db(), { userId: mine }, { limit: 50 }, async () => [
			"org-a",
		]);

		expect(page.authors).toEqual({});
	});

	it("does not name the author of a public lesson that carries an org_id", async () => {
		// Added 2026-10-05, after Task 5's implementer found that the case
		// above cannot distinguish the filter's `visibility === "org"` clause
		// from its absence. createLessonsWithFeed stamps org_id only onto
		// 'org' rows and nothing mutates visibility afterward, so a public
		// row's org_id is always NULL and the filter's `orgId !== null` clause
		// excludes it unaided.
		//
		// The state is therefore built by hand, as "still hides a private
		// lesson that carries an org_id" is. That is what makes the clause
		// load-bearing rather than merely redundant: without a test that can
		// tell its presence from its absence, a later reader deletes it as
		// dead weight with every test still green - and then any write path
		// that ever puts an org on a public row spills a real name onto the
		// one tier whose disclosure guarantee is an unlinkable author_key and
		// nothing else.
		const pub = await seedFor(theirs, { visibility: "public" });
		await db()
			.prepare("UPDATE lessons SET org_id = ? WHERE id = ?")
			.bind(orgRow.id, pub.id)
			.run();

		const page = await readPool(db(), { userId: mine }, { limit: 50 }, async () => [
			orgRow.id,
		]);

		// Still returned - it is public - and still unattributed.
		expect(idsIn(page)).toContain(pub.id);
		expect(page.authors).toEqual({});
	});

	it("does not name the author of an org lesson the reader reaches as its owner", async () => {
		// Reached through `user_id = ?` rather than through the org disjunct:
		// the reader left the org, and their own lesson is still theirs to see.
		const own = await seedFor(mine, { visibility: "org" }, "org-a");

		const page = await readPool(db(), { userId: mine }, { limit: 50 }, async () => []);

		expect(idsIn(page)).toEqual([own.id]);
		expect(page.authors).toEqual({});
	});

	it("omits the key for an author who has no name", async () => {
		const nameless = (await createUser(db(), "no@example.com", "hash", null)).id;
		const shared = await seedFor(nameless, { visibility: "org" }, "org-a");

		const page = await readPool(db(), { userId: mine }, { limit: 50 }, async () => [
			"org-a",
		]);

		expect(idsIn(page)).toEqual([shared.id]);
		expect(page.authors).toEqual({});
	});

	it("is always present, even with nothing to attribute", async () => {
		// Same rule as owned_ids: a client must not have to tell "nobody is
		// named" apart from "this server does not say".
		const page = await readPool(db(), { userId: mine }, { limit: 50 });

		expect(page.authors).toEqual({});
	});

	it("names the reader's own org lesson in an org they still belong to", async () => {
		// Added 2026-10-05: the sidecar's doc comment used to claim a row the
		// reader reached as its owner "needs no attribution", which is false
		// when BOTH disjuncts match. Attribution follows the org match, not the
		// route the row arrived by, so a reader's own org lesson carries their
		// own name - harmless, intended, and previously uncovered: the only
		// own-row case tested the reader who had LEFT the org.
		const own = await seedFor(mine, { visibility: "org" }, orgRow.id);

		const page = await readPool(db(), { userId: mine }, { limit: 50 }, async () => [
			orgRow.id,
		]);

		expect(page.authors[own.id]).toBe(nameOf(mine));
	});
});
```

If `createUser`'s fourth parameter will not take `null`, insert the user with a
raw `INSERT INTO users` in that test instead, and say so in your report.
`nameOf(mine)` stands for whatever name the suite's `beforeEach` gives that
account — read it rather than assuming.

**The single-lesson path needs its own tests.** Added 2026-10-05 after the Task 5
review found that nothing anywhere referenced `author_name` or `orgAuthorName`,
and that deleting `l.visibility = 'org'` from `orgAuthorName` left every test
green. Step 5 produced an entire output with no coverage.

```ts
describe("getLessonForUser's author_name", () => {
	it("names the author of an org lesson the reader reaches through their org", async () => {
		const ada = (await createUser(db(), "ada4@example.com", "hash", "Ada")).id;
		const org = await createOrgWithOwner(db(), "Acme Three", ada);
		await addMembership(db(), org.id, mine, "member");
		const shared = await seedFor(ada, { visibility: "org" }, org.id);

		expect((await getLessonForUser(db(), mine, shared.id))?.author_name).toBe("Ada");
	});

	it("names nobody for a public lesson", async () => {
		const pub = await seedFor(theirs, { visibility: "public" });

		expect((await getLessonForUser(db(), mine, pub.id))?.author_name).toBeNull();
	});

	it("names nobody for a public lesson that carries an org_id", async () => {
		// The ablation target, hand-built for the same reason the sidecar's
		// equivalent is: through the writer a public row's org_id is always
		// NULL, so the org_id clause alone excludes it and the visibility
		// clause stays untestable. getLessonForUser resolves REAL memberships,
		// so the reader has to actually be in this org.
		await addMembership(db(), orgRow.id, mine, "member");
		const pub = await seedFor(theirs, { visibility: "public" });
		await db()
			.prepare("UPDATE lessons SET org_id = ? WHERE id = ?")
			.bind(orgRow.id, pub.id)
			.run();

		expect((await getLessonForUser(db(), mine, pub.id))?.author_name).toBeNull();
	});

	it("names nobody for the reader's own private lesson", async () => {
		const own = await seedFor(mine, { visibility: "private" });

		expect((await getLessonForUser(db(), mine, own.id))?.author_name).toBeNull();
	});
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @onlooker/api test -- pool
```

Expected: FAIL — `page.authors` is `undefined`.

- [ ] **Step 3: Add the field to the page shape**

In `apps/api/src/db/pool-page.ts`, inside `LessonPage`:

```ts
	/**
	 * The names of the authors of the org lessons on this page, by lesson id.
	 *
	 * Carried beside the documents for the reason `ownedIds` is: a lesson body
	 * is the published contract's shape and nothing server-computed belongs in
	 * it.
	 *
	 * Attribution follows the ORG MATCH rather than the route a row arrived by,
	 * and the distinction matters where both apply. A public row carries
	 * `author_key` alone, so the anonymous surface's disclosure is unchanged and
	 * nothing links an author across tiers. A reader's OWN org lesson, in an org
	 * they still belong to, does appear here under their own name - harmless,
	 * and corrected 2026-10-05 from a comment claiming such a row "needs no
	 * attribution", which was false whenever both disjuncts matched. A row the
	 * reader kept only by authoring it, in an org they have since left, carries
	 * no name.
	 *
	 * A key is absent when the author has no name set. The server does not
	 * substitute an email - a different disclosure class - and does not invent
	 * a label.
	 *
	 * Always present, empty for an anonymous caller and for a page with no org
	 * rows on it.
	 */
	authors: Record<string, string>;
```

- [ ] **Step 4: Resolve the names in `readPool`**

In `apps/api/src/db/pool.ts`, add beside `MAX_READER_ORGS_BOUND`:

```ts
/**
 * How many author ids the name lookup binds per statement.
 *
 * Matches `lessons.ts`'s ID_LOOKUP_CHUNK rather than disagreeing with it: D1
 * caps bound parameters at 100, and a page can carry up to BROWSE_MAX_LIMIT
 * rows, so a page of 200 distinct org authors would exceed the cap in one
 * statement.
 */
const AUTHOR_LOOKUP_CHUNK = 50;
```

Widen the select (`:229`) to `SELECT body, user_id, visibility, org_id FROM lessons`,
widen its row type to
`all<{ body: string; user_id: string; visibility: string; org_id: string | null }>()`,
and carry both new fields into `kept`:

```ts
	const kept = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
		lesson: JSON.parse(r.body) as { id: string; promoted_at: string },
		userId: r.user_id,
		visibility: r.visibility,
		orgId: r.org_id,
	}));
```

Then, after `ownedIds` is computed:

```ts
	// Attributed only where the org disjunct is what matched. A row is
	// org-reached when it is an 'org' row whose org is one of the reader's: a
	// public row is not, and neither is the reader's own 'org' row once they
	// have left that org.
	const orgReached = kept.filter(
		(r) =>
			r.visibility === "org" &&
			r.orgId !== null &&
			readerOrgIds.includes(r.orgId),
	);
	const authors = await authorNames(db, orgReached);
```

and return `authors` in the object. Add the helper below `readPool`:

```ts
/**
 * Author names for the org rows on one page, by lesson id.
 *
 * A second statement rather than a join in the pool read, for two reasons. The
 * repo's own precedent is this shape - see getLessonForUser's note on not
 * widening readPoolLesson's SELECT - and a LEFT JOIN in the main statement
 * would change the plan that pool-query-plan.test.ts pins, for a lookup that
 * most pages do not need at all.
 *
 * Runs no statement when a page carries no org rows, which is every anonymous
 * read and most authenticated ones.
 */
async function authorNames(
	db: D1Database,
	orgReached: Array<{ lesson: { id: string }; userId: string }>,
): Promise<Record<string, string>> {
	if (orgReached.length === 0) return {};

	const ids = [...new Set(orgReached.map((r) => r.userId))];
	const names = new Map<string, string>();

	for (let at = 0; at < ids.length; at += AUTHOR_LOOKUP_CHUNK) {
		const chunk = ids.slice(at, at + AUTHOR_LOOKUP_CHUNK);
		const { results } = await db
			.prepare(
				`SELECT id, name FROM users
				 WHERE id IN (${chunk.map(() => "?").join(", ")})`,
			)
			.bind(...chunk)
			.all<{ id: string; name: string | null }>();

		for (const row of results ?? []) {
			// A null or empty name produces no key at all. The server does not
			// invent a label for a member who never set one.
			if (row.name) names.set(row.id, row.name);
		}
	}

	const authors: Record<string, string> = {};
	for (const row of orgReached) {
		const name = names.get(row.userId);
		if (name) authors[row.lesson.id] = name;
	}
	return authors;
}
```

- [ ] **Step 5: Attribute the single-lesson read too**

Without this, a deep link to an org lesson shows no author while the same lesson
in the list does.

Add to `pool.ts`, below `readPoolLesson`:

```ts
/**
 * The name of an org lesson's author, for a reader who reaches it through the
 * org disjunct - or null.
 *
 * A separate function from readPoolLesson rather than a widening of it. That
 * one is also the anonymous public route's read, and its contract is that no
 * code path may widen what it sees; leaving its shape and its single caller
 * list alone is worth more than saving a primary-key lookup here.
 *
 * NOT an authorization check, and corrected 2026-10-05 to stop implying it is.
 * This WHERE omits the retracted-and-blocked-author boundary that
 * visibilityPredicate applies, so the only reason it cannot be used to ask who
 * owns an arbitrary lesson id is that its single caller - getLessonForUser -
 * has already returned null for a row the reader may not read. Do not call it
 * anywhere that has not established readability first.
 *
 * The boundary is deliberately NOT duplicated here: visibilityPredicate is the
 * only place a visibility predicate is constructed, and a second copy of the
 * retracted/blocked logic would be a worse defect than this comment was.
 */
export async function orgAuthorName(
	db: D1Database,
	readerOrgIds: string[],
	lessonId: string,
): Promise<string | null> {
	// Bounded the same way visibilityPredicate bounds its own list, and for the
	// same reason: D1 caps bound parameters at 100. Added 2026-10-05 after the
	// Task 5 review found this binding the unbounded list while the predicate
	// truncated - a reader in 100+ orgs would have turned a readable deep link
	// into a 500. The three places that consume this list now agree on one
	// bounded form rather than leaving a later reader to work out why they
	// differed.
	const bounded = readerOrgIds.slice(0, MAX_READER_ORGS_BOUND);
	if (bounded.length === 0) return null;

	const row = await db
		.prepare(
			`SELECT u.name AS name FROM lessons l
			 JOIN users u ON u.id = l.user_id
			 WHERE l.id = ?
			   AND l.visibility = 'org'
			   AND l.org_id IN (${bounded.map(() => "?").join(", ")})`,
		)
		.bind(lessonId, ...bounded)
		.first<{ name: string | null }>();

	return row?.name ?? null;
}
```

Note for the reviewer: this query names `lessons`, and it is inside `pool.ts`,
which is one of the two files the source guard allows. Re-run that guard.

In `apps/api/src/db/lessons.ts`, extend `getLessonForUser`:

```ts
export async function getLessonForUser(
	db: D1Database,
	userId: string,
	id: string,
): Promise<{ lesson: unknown; own: boolean; author_name: string | null } | null> {
	const readerOrgIds = await orgIdsForUser(db, userId);
	const lesson = await readPoolLesson(db, { userId }, id, async () => readerOrgIds);
	if (!lesson) return null;

	const owned = await db
		.prepare("SELECT 1 AS own FROM lessons WHERE id = ? AND user_id = ?")
		.bind(id, userId)
		.first<{ own: number }>();

	// Resolved from the same org list the predicate used, so the name can only
	// appear for a row the org disjunct is what admitted.
	const author_name = await orgAuthorName(db, readerOrgIds, id);

	return { lesson, own: owned !== null, author_name };
}
```

Resolving the org list once and passing it as a closure keeps one membership
read per request rather than two, and guarantees the name and the predicate
cannot disagree. Import `orgAuthorName` from `./pool.js`.

- [ ] **Step 6: Emit both fields from the routes**

In `apps/api/src/routes/lessons-browser.ts`, add to the browse response:

```ts
				// Always present, even when empty, for the reason owned_ids is.
				authors: page.authors,
```

and change `handleGetLesson`'s return to:

```ts
	return Response.json({
		lesson: found.lesson,
		own: found.own,
		author_name: found.author_name,
	});
```

- [ ] **Step 7: Pin it in the contract and teach the mock**

In `packages/api-contract/src/index.ts`, add `authors: expectObject` to BOTH
lesson-pool cases (`:439` and `:460`) beside `owned_ids`, with a comment giving
the same reason the `owned_ids` comments give. `expectObject` is already
exported at `:33`.

In `apps/web/src/api/mockApi.ts`, add `authors: {}` to the pool response at
`:900`, and `author_name: null` to whatever the mock returns for a single
lesson. Search the file for `own:` to find it.

- [ ] **Step 8: Add the route-level test**

In `apps/api/src/routes/lessons-browser.test.ts`, one case through the real
route, because the sidecar crossing the HTTP boundary is a separate fact from
`readPool` computing it:

```ts
	it("names org authors in the browse response", async () => {
		// Two accounts in one org: the milestone's done-when, at the route.
		const page = (await (await call("/api/lessons", reader.token)).json()) as {
			lessons: Array<{ id: string }>;
			authors: Record<string, string>;
		};

		expect(page.authors[sharedLessonId]).toBe("Bob");
	});
```

Build the fixture with this suite's existing helpers:
`createOrgWithOwner`/`addMembership` from `db/orgs.js`, and
`createLessonsWithFeed(db(), author, [lesson({ visibility: "org" })], org.id)`
for the row. Clear `org_memberships` and `orgs` in the suite's reset.

- [ ] **Step 9: Run every gate, both suites**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
pnpm --filter @onlooker/web test
pnpm --filter @onlooker/web typecheck
pnpm --filter @onlooker/web lint
pnpm --filter @onlooker/api-contract test
bash scripts/source-guards.test.sh
```

- [ ] **Step 10: Prove the public-row test can fail (REQUIRED)**

Temporarily drop `r.visibility === "org" &&` from the `orgReached` filter.
Confirm **"does not name the author of a public lesson that carries an
org_id"** FAILS, with `authors` carrying the public lesson's id. Restore,
re-run, report both. This is the assertion that keeps attribution from reaching
the public tier.

Corrected 2026-10-05: this step originally named the plain "does not name the
author of a public lesson" case, which stays green under the ablation. A public
row written through `createLessonsWithFeed` always has a NULL `org_id`, so the
filter's `orgId !== null` clause excludes it whether or not the visibility clause
is there. The hand-built row is the only fixture that can tell the two apart —
which is the general lesson, not a detail: an ablation that passes has either
found a redundant guard or an inadequate fixture, and the two are
indistinguishable until you construct the state the writer refuses to produce.

- [ ] **Step 11: Commit**

---

### Task 6: Owner retract inside an org

**Files:**
- Create: `apps/api/src/routes/orgs-lessons.ts`
- Create: `apps/api/src/routes/orgs-lessons.test.ts`
- Modify: `apps/api/src/db/lessons.ts` (append `retractOrgLesson`)
- Modify: `apps/api/src/router.ts` (one route entry, after the members routes)
- Modify: `apps/api/src/routes/orgs-authorization.test.ts:31-45` and `:60-66`
- Modify: `apps/api/src/test-support/orgs.ts:58-64`

**Interfaces:**
- Consumes: `requireOrgRole(db, principal, orgId, required)` (Stage 1,
  `orgs/authorize.ts:25`), `transitionLesson` and `probeLessonId`
  (`db/lessons.ts`), `lessons.org_id` (Task 1).
- Produces:
  - `retractOrgLesson(db, orgId, lessonId): Promise<number | null>`
  - `POST /api/orgs/:id/lessons/:lessonId/retract`, owner only

**A third function, not a flag.** `transitionLesson`'s
`WHERE id = ? AND user_id = ?` is the user-facing guarantee that a caller cannot
touch somebody else's lesson, and `retractAnyLesson` is the operator path. A
cross-owner write must not be reachable by passing the wrong argument to the
ordinary one, so this is a third named function — the rule
`db/lessons.ts:339-348` already records.

- [ ] **Step 1: Teach the test reset about lessons**

**Corrected 2026-10-05.** This step originally said to add the lesson deletes to
`resetOrgTables` in `apps/api/src/test-support/orgs.ts`. That **fails
`scripts/source-guards.test.sh`**: the guard allows a `lessons`/`lesson_feed`
query only in `db/lessons.ts`, `db/pool.ts`, and `*.test.ts`, and
`test-support/orgs.ts` is none of those. It is a support module, not a test file,
and the guard is right to catch it.

Put the deletes in the new suite's own `beforeEach` instead, which is what
`db/lessons.test.ts`, `db/pool.test.ts` and `routes/lessons-browser.test.ts`
already do:

```ts
	// Lessons first, explicitly. They cascade from users, but a suite that
	// seeds an org lesson should not depend on cascade behavior to get a clean
	// table. Here rather than in test-support/orgs.ts because that file is not
	// a *.test.ts and the source guard forbids a lesson query there.
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
```

then call `resetOrgTables()` as the sibling org suites do. Leave
`test-support/orgs.ts` unchanged.

- [ ] **Step 2: Write the failing db test**

In `apps/api/src/db/lessons.test.ts`:

```ts
describe("retractOrgLesson", () => {
	it("retracts a lesson shared with that org", async () => {
		const written = lesson({ visibility: "org" }) as TLesson;
		await createLessonsWithFeed(db(), ada, [written], "org-a");

		const seq = await retractOrgLesson(db(), "org-a", written.id);

		expect(seq).not.toBeNull();
		expect((await probeLessonId(db(), written.id))?.status).toBe("retracted");
	});

	it("refuses a lesson shared with a different org", async () => {
		// An owner of org B must not reach inside org A.
		const written = lesson({ visibility: "org" }) as TLesson;
		await createLessonsWithFeed(db(), ada, [written], "org-a");

		expect(await retractOrgLesson(db(), "org-b", written.id)).toBeNull();
		expect((await probeLessonId(db(), written.id))?.status).toBe("active");
	});

	it("refuses a private lesson, even one carrying an org_id", async () => {
		// Defense in depth with the write-side rule in createLessonsWithFeed:
		// if a private row ever acquires an org_id, this path still refuses it.
		const written = lesson({ visibility: "private" }) as TLesson;
		await createLessonsWithFeed(db(), ada, [written], "org-a");
		await db()
			.prepare("UPDATE lessons SET org_id = ? WHERE id = ?")
			.bind("org-a", written.id)
			.run();

		expect(await retractOrgLesson(db(), "org-a", written.id)).toBeNull();
		expect((await probeLessonId(db(), written.id))?.status).toBe("active");
	});

	it("appends to the AUTHOR's feed, not the retracting owner's", async () => {
		// The author's mirror is what needs to learn the lesson is gone.
		//
		// The fixture must give the author and the owner DIFFERENT ids, or the
		// second half of this test's name is unobservable - which is how the
		// first version of it shipped: author and owner were the same account,
		// and retractOrgLesson takes no caller identity, so nothing could tell
		// the two outcomes apart. This is also the scenario the feature exists
		// for, per D6: a member writes, and an owner takes it down.
		const member = (await createUser(db(), "member@example.com", "hash", "Mo")).id;
		await addMembership(db(), orgRow.id, member, "member");
		const written = lesson({ visibility: "org" }) as TLesson;
		await createLessonsWithFeed(db(), member, [written], orgRow.id);

		await retractOrgLesson(db(), orgRow.id, written.id);

		const row = await db()
			.prepare(
				"SELECT user_id FROM lesson_feed WHERE lesson_id = ? AND kind = 'status'",
			)
			.bind(written.id)
			.first<{ user_id: string }>();
		expect(row?.user_id).toBe(member);
		// Both halves, said out loud.
		expect(row?.user_id).not.toBe(ownerId);
	});

	it("returns null for an id that does not exist", async () => {
		expect(await retractOrgLesson(db(), "org-a", "01NOPE00000000000000000000")).toBeNull();
	});
});
```

- [ ] **Step 3: Run it, watch it fail, implement**

```bash
pnpm --filter @onlooker/api test -- lessons.test
```

Append to `apps/api/src/db/lessons.ts`, below `retractAnyLesson`:

```ts
/**
 * Retract a lesson shared with one org, on that org's authority.
 *
 * THE THIRD retract function, and separate from both others on purpose.
 * `transitionLesson`'s `WHERE id = ? AND user_id = ?` is the user-facing
 * guarantee that a caller cannot touch somebody else's lesson, and
 * `retractAnyLesson` is the operator path. Widening either with an "and also
 * org owners" argument would put a cross-owner write one wrong argument away
 * from an ordinary transition. Three functions cannot be confused.
 *
 * Authorizes on the lesson's own `org_id` AND on `visibility = 'org'`. The
 * visibility check is defense in depth against the write side: createLessons-
 * WithFeed stamps the org only onto org-visible rows precisely so this path
 * cannot reach a member's private lesson, and checking here too means one
 * mistake is not enough.
 *
 * Returns the new seq, or null when the lesson does not exist, is not shared
 * with this org, or is not an org lesson at all - the caller cannot tell those
 * apart, which keeps the route from confirming another org's lesson ids.
 *
 * Appends to the AUTHOR's feed, like any other transition, so their mirror
 * learns about it on the next delta pull. D6 is deliberate here: the lesson
 * survives its author leaving the org, and this is the control that keeps that
 * from making the operator the moderation queue for every customer.
 */
export async function retractOrgLesson(
	db: D1Database,
	orgId: string,
	lessonId: string,
): Promise<number | null> {
	const stored = await probeLessonId(db, lessonId);
	if (!stored) return null;
	if (stored.visibility !== "org") return null;
	if (stored.org_id !== orgId) return null;

	return transitionLesson(db, stored.user_id, lessonId, "retracted", null);
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm --filter @onlooker/api test -- lessons.test
```

- [ ] **Step 5: Write the failing route test**

Create `apps/api/src/routes/orgs-lessons.test.ts`, modeled on the Stage 1 org
route suites (read `orgs-members.test.ts` for the fixture idiom and reuse
`call`, `signup`, `resetOrgTables` from `../test-support/orgs.js`):

```ts
describe("POST /api/orgs/:id/lessons/:lessonId/retract", () => {
	it("lets an owner retract a lesson shared with their org", async () => {
		const response = await call(
			`/api/orgs/${orgId}/lessons/${sharedId}/retract`,
			owner.token,
			{ method: "POST" },
		);

		expect(response.status).toBe(200);
		expect((await probeLessonId(db(), sharedId))?.status).toBe("retracted");
	});

	it("refuses a member", async () => {
		const response = await call(
			`/api/orgs/${orgId}/lessons/${sharedId}/retract`,
			member.token,
			{ method: "POST" },
		);

		expect(response.status).toBe(404);
		expect((await probeLessonId(db(), sharedId))?.status).toBe("active");
	});

	it("refuses an owner of another org", async () => {
		const other = await createOrgWithOwner(db(), "Beta", stranger.id);

		const response = await call(
			`/api/orgs/${other.id}/lessons/${sharedId}/retract`,
			stranger.token,
			{ method: "POST" },
		);

		expect(response.status).toBe(404);
		expect((await probeLessonId(db(), sharedId))?.status).toBe("active");
	});

	it("404s a lesson id that does not exist, indistinguishably", async () => {
		const response = await call(
			`/api/orgs/${orgId}/lessons/01NOPE00000000000000000000/retract`,
			owner.token,
			{ method: "POST" },
		);

		expect(response.status).toBe(404);
	});

	it("keeps the org's access when the author leaves, and ends the author's", async () => {
		// D6, observed. The predicate never consults the AUTHOR's membership -
		// only the reader's - so surviving a departure is the only thing it can
		// do. Asserted anyway: it is the decision most likely to be "fixed" in
		// the wrong direction by someone who reads the org disjunct and assumes
		// both sides must be members.
		//
		// Here rather than in db/pool.test.ts because this suite already
		// manipulates memberships, and because the two halves have to be seen
		// together: the lesson stays readable, and the departed author stops
		// reading the org's others.
		const authored = await seedOrgLesson(member.id, orgId);
		const byOwner = await seedOrgLesson(owner.id, orgId);

		await db()
			.prepare("DELETE FROM org_memberships WHERE org_id = ? AND user_id = ?")
			.bind(orgId, member.id)
			.run();

		const ownerSees = await browse(owner.token);
		const departedSees = await browse(member.token);

		expect(ownerSees).toContain(authored.id);
		expect(departedSees).not.toContain(byOwner.id);
		// Their own lesson is still theirs to see - through `user_id = ?`,
		// not through the org disjunct.
		expect(departedSees).toContain(authored.id);
	});
});
```

`seedOrgLesson(userId, orgId)` is a local helper wrapping
`createLessonsWithFeed(db(), userId, [lesson({ visibility: "org" })], orgId)` and
returning the written lesson; `browse(token)` calls `GET /api/lessons` and
returns the ids. Write both at the top of the suite.

- [ ] **Step 6: Implement the route**

Create `apps/api/src/routes/orgs-lessons.ts`:

```ts
import { retractOrgLesson } from "../db/lessons.js";
import type { Principal } from "../db/pool.js";
import { requireOrgRole } from "../orgs/authorize.js";
import type { RouteParams } from "../router.js";
import type { WorkerEnv } from "../types";
import { ApiError } from "../types";

/**
 * Org-level moderation of org lessons.
 *
 * Owner only, and scoped to the org in the path: requireOrgRole throws the
 * same 404 for a non-member as for an org that does not exist, and
 * retractOrgLesson refuses any lesson not shared with THIS org, so an owner of
 * one org cannot reach inside another.
 */
export async function handleRetractOrgLesson(
	_request: Request,
	env: WorkerEnv,
	params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	await requireOrgRole(env.DB, principal as Principal, params.id, "owner");

	// The catch is not optional, and this plan originally omitted it. Both
	// sibling retract routes - admin-moderation.ts and lessons-browser.ts -
	// map SequenceExhaustedError to this exact 503, because nothing was
	// written when it fires: the batch rolled back whole and no sequence
	// number was consumed, so "retry" is correct advice where a 500 would
	// leave the caller unsure whether their request landed. The message is
	// byte-identical to the siblings' on purpose.
	let seq: number | null;
	try {
		seq = await retractOrgLesson(env.DB, params.id, params.lessonId);
	} catch (error) {
		if (error instanceof SequenceExhaustedError) {
			throw new ApiError(
				503,
				"sequence_contention",
				"Could not assign a lesson sequence; nothing was written, so retry",
			);
		}
		throw error;
	}

	// 404 and not 403: a distinguishable answer would confirm that a lesson id
	// exists, which is the reasoning transitionLesson and getLessonForUser
	// both already follow.
	if (seq === null) throw new ApiError(404, "not_found", "No such lesson");

	// The retract family's shape, matching admin-moderation.ts - the closest
	// relative, being the other retract by someone who is not the author.
	return Response.json({ id: params.lessonId, seq, status: "retracted" });
}
```

Import `SequenceExhaustedError` from `../db/lessons.js` alongside
`retractOrgLesson`.

Check `requireOrgRole`'s exact parameter order in `orgs/authorize.ts:25` before
writing this, and match it.

In `apps/api/src/router.ts`, add after the members routes (around `:440`):

```ts
	{
		method: "POST",
		path: "/api/orgs/:id/lessons/:lessonId/retract",
		auth: "session",
		cors: "app",
		handler: handleRetractOrgLesson,
	},
```

with its import beside the other org route imports. Place it before the
`/api/orgs/invites/verify` entry so it sits with the `:id` routes, and confirm
the comment at `:463` about match ordering still holds — `matchPath` requires
every segment to match, and this path has five segments where
`/api/orgs/:id/invites` has four.

- [ ] **Step 7: Extend the enumerated role guard**

In `apps/api/src/routes/orgs-authorization.test.ts`, add to `REQUIRED_ROLE`:

```ts
	"POST /api/orgs/:id/lessons/:lessonId/retract": "owner",
```

and teach `concrete()` the new parameter — without this the guard calls a
literal `:lessonId` path and proves nothing:

```ts
function concrete(path: string, targetUserId: string): string {
	return path
		.replace(":inviteId", crypto.randomUUID())
		.replace(":lessonId", "01NOPE00000000000000000000")
		.replace(":userId", targetUserId)
		.replace(":id", orgId);
}
```

**Use a REAL lesson id, and this is the correction that matters most in this
task.** The step originally specified a non-existent id, reasoning that the role
refusal must happen before the lesson is looked up. Task 6's implementer proved
that reasoning backwards: with a nonexistent id, `retractOrgLesson` returns null
whatever the caller's role is, so the handler's 404-on-missing-lesson is
**indistinguishable** from the 404 the role check produces — and removing
`requireOrgRole` from the handler entirely leaves this guard green. For a
parameterized sub-resource route, the guard was proving only that the table has
an entry, not that a role check runs.

So create a real org lesson in that suite's `beforeEach` and substitute its id.
`:lessonId` appears on exactly one route, so this changes nothing else in the
table. Then confirm the guard FAILS when `requireOrgRole` is removed — that is
what makes it a guard rather than a table-completeness check.

Note while editing that fixture: the enumeration suite calls **every**
`/api/orgs` route against whatever ids `concrete()` supplies, destructive ones
included. A real lesson in the fixture means another route may now act on a real
row where it previously hit nothing. Check the suite passes for the right
reasons, not merely that it passes.

**`:inviteId` has the same blind spot and is deliberately left alone.**
`DELETE /api/orgs/:id/invites/:inviteId` is a shipped route whose enumeration
case also uses a nonexistent id, so it too cannot currently distinguish a role
refusal from a not-found. Widening a shared guard over shipped behavior is the
repo owner's call, and it is recorded for them rather than fixed here.

- [ ] **Step 8: Run the gates**

```bash
pnpm --filter @onlooker/api test -- orgs
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

The source guard matters here specifically: `orgs-lessons.ts` must contain no
lesson query. It calls `retractOrgLesson` and holds no SQL — if the guard fires,
you put a query in the wrong file.

- [ ] **Step 9: Prove the role guard and the cross-org refusal can fail (REQUIRED)**

Two ablations:

1. Remove the `requireOrgRole` call from the handler. Confirm the enumeration
   guard in `orgs-authorization.test.ts` FAILS and "refuses a member" FAILS.
2. Restore it, then change `retractOrgLesson`'s `stored.org_id !== orgId` check
   to `false`. Confirm "refuses a lesson shared with a different org" FAILS.

Restore both, re-run, report all four runs.

- [ ] **Step 10: Commit**

---

### Task 7: Re-measure the query plan

**Files:**
- Modify: `apps/api/src/db/pool-query-plan.test.ts`
- Modify: `docs/superpowers/specs/2026-10-04-org-visibility-tier-design.md` (the "index, and a plan this document will not predict" section)
- Possibly modify: `packages/db/src/schema.ts`, a new `packages/db/migrations/0012_*.sql`, `packages/db/src/expected-schema.ts`

**Interfaces:**
- Consumes: the rekeyed predicate (Task 2) and the widened select (Task 5).
- Produces: either an index plus its migration, or a recorded measurement
  saying none is warranted. Either way the spec carries captured output.

**The task is a measurement, and its outcome is genuinely open.** The spec
reserves judgment deliberately: `pool.ts:64-82` documents that a disjunction
already forces `MULTI-INDEX OR` plus `USE TEMP B-TREE FOR ORDER BY`, and a third
disjunct changes that in ways a document should not guess. Do not add the index
first and measure afterward.

- [ ] **Step 1: Add an org reader's plan to the test**

In `apps/api/src/db/pool-query-plan.test.ts`, beside
`planForAuthenticatedBrowse`:

```ts
/** What `readPool` prepares for a signed-in browse by a member of two orgs. */
async function planForOrgBrowse(): Promise<string[]> {
	const { captured, db } = recorder();
	await readPool(db, { userId: "u1" }, { limit: 50 }, async () => [
		"org-a",
		"org-b",
	]);
	expect(captured).toHaveLength(1);
	return planFor(captured[0]);
}
```

Two orgs rather than one, because one would bind a single value and SQLite can
plan `IN (?)` differently from `IN (?, ?)`.

- [ ] **Step 2: Capture the plan**

Add a temporary case that prints it:

```ts
	it("prints the org browse plan", async () => {
		console.log((await planForOrgBrowse()).join("\n"));
	});
```

```bash
pnpm --filter @onlooker/api test -- pool-query-plan
```

Copy the printed plan verbatim into your task report. This is the measurement
and it is the deliverable — a paraphrase is not.

- [ ] **Step 3: Measure the candidate index**

Add to `lessons`'s index block in `packages/db/src/schema.ts`:

```ts
		orgPromotedAtIdx: index("lessons_org_promoted_at_idx").on(
			table.org_id,
			table.promoted_at,
			table.id,
		),
```

Then:

```bash
pnpm --filter @onlooker/db generate:migrations
pnpm --filter @onlooker/db build
pnpm --filter @onlooker/db generate:expected-schema
pnpm --filter @onlooker/api test -- pool-query-plan
```

Capture the printed plan again. Note that the spec's candidate was
`(visibility, org_id, promoted_at, id)`; measure that ordering too if the
`org_id`-leading one does not help. SQLite will only fold an OR into a union of
index scans when every branch is indexed, and the org branch is
`visibility = 'org' AND org_id IN (...)` — two equalities, so which column leads
decides whether the branch is seekable.

- [ ] **Step 4: Decide, on the evidence**

Keep the index if and only if the measured plan improves — a branch that was a
scan becoming a `SEARCH`, or a `MULTI-INDEX OR` gaining the org branch. If
neither plan differs, DELETE the index, the migration it generated, its journal
entry and snapshot, and regenerate `expected-schema.ts`. An index that buys
nothing still costs every write.

Report both plans and the decision either way.

- [ ] **Step 5: Keep the permanent assertions, drop the printer**

Delete the printing case. Add assertions that match what you actually measured —
do not copy these verbatim if your measurement disagrees with them:

```ts
	it("does not scan the whole lessons table for an org member", async () => {
		const plan = await planForOrgBrowse();

		expect(plan.join("\n")).not.toMatch(/\bSCAN lessons\b/);
	});

	it("reaches the lesson rows through an index for an org member", async () => {
		// The positive half, so the guard cannot pass by the table ceasing to
		// be read at all. Matched against `lessons` specifically: the
		// blocklist's NOT EXISTS contributes its own "USING COVERING INDEX"
		// line, so a bare /USING INDEX/ passes while the table is scanned end
		// to end.
		const plan = await planForOrgBrowse();

		expect(plan.join("\n")).toMatch(/SEARCH lessons USING (COVERING )?INDEX/);
	});
```

- [ ] **Step 6: Write the measurement into the spec**

In `docs/superpowers/specs/2026-10-04-org-visibility-tier-design.md`, replace
the body of "### The index, and a plan this document will not predict" with the
captured plans in a fenced block, the date, and the decision. Retitle the
section "### The index, measured". Keep the paragraph explaining why the
prediction was withheld — the reasoning is the record, not just the number.

- [ ] **Step 7: Run every gate**

```bash
pnpm --filter @onlooker/db test
pnpm --filter @onlooker/db typecheck
pnpm --filter @onlooker/db lint
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

- [ ] **Step 8: Prove the new plan assertions can fail (REQUIRED)**

**Drop BOTH visibility-leading indexes, not one.** Corrected 2026-10-08 from
"drop `lessons_visibility_promoted_at_idx`", which stopped working the moment
this task added a second visibility-leading index: either one alone satisfies
SQLite's OR-to-index-union rewrite, so the surviving index backstops the dropped
one and no `SCAN lessons` appears. Task 7's implementer ran the literal version
anyway, reported that an unrelated test broke instead, and then ran the real one
— which is the right order of operations and worth copying.

So: temporarily drop both `lessons_visibility_promoted_at_idx` and
`lessons_visibility_org_promoted_at_idx` from `packages/db/src/schema.ts`,
regenerate the migration, and confirm every org-browse and public-browse plan
assertion FAILS with `SCAN lessons`. Restore everything — schema, migration,
journal, snapshot, `expected-schema.ts` — re-run, and confirm with `git status`
that nothing from the ablation survived. A from-scratch
`build` + `generate:expected-schema` producing a zero diff is the strongest
confirmation available and is cheap; do that too.

Note the general shape of what happened here, because it will recur: **adding a
second mechanism that satisfies the same property makes the single-mechanism
ablation stop proving anything.** It is not that the guard weakened — it is that
the fixture now has a backstop, and the ablation has to remove every path to the
property, not just the one that used to be the only one.

- [ ] **Step 9: Commit**

---

### Task 8: The web surface

**Files:**
- Modify: `apps/web/src/api/machinesApi.ts:24-41` (`Machine`), `:72-84` (`MintedMachine`, `createMachine`)
- Modify: `apps/web/src/api/lessonsApi.ts:47-64` (`LessonPage`), `:65-70` (`OwnedLesson`)
- Modify: `apps/web/src/pages/MachinesPage.tsx` (the create form, the list)
- Modify: `apps/web/src/pages/LessonsPage.tsx:423-470` (the row), and the detail pane
- Modify: `apps/web/src/api/mockApi.ts`
- Test: the suites beside each page

**Interfaces:**
- Consumes: `org_id` on machines (Task 3), `authors` and `author_name` (Task 5),
  `listOrgs()` from `apps/web/src/api/orgsApi.ts` (Stage 1).
- Produces: no new API surface.

**Two screens, and no new icon.** The machines page gains a select and a column;
the lessons page gains a text line. `packages/brand`'s `UNPLATED_ICONS` guard and
the contrast floor are not in play — do not add an icon to either surface. If you
believe one is needed, stop and report rather than adding it: that guard measures
contrast on the night panel and Stage 1 already lost one icon to it.

- [ ] **Step 1: Write the failing web tests**

In the MachinesPage suite:

```ts
	it("offers the caller's orgs when minting a token", async () => {
		renderWithProviders(<MachinesPage />);

		expect(await screen.findByLabelText(/org/i)).toBeInTheDocument();
		expect(await screen.findByRole("option", { name: "Acme" })).toBeInTheDocument();
	});

	it("defaults to no org, which mints a private-only token", async () => {
		renderWithProviders(<MachinesPage />);

		const select = await screen.findByLabelText(/org/i);
		// A token that can push to an org is the wider credential; the default
		// is the narrower one.
		expect((select as HTMLSelectElement).value).toBe("");
	});

	it("shows which org an existing machine pushes to", async () => {
		renderWithProviders(<MachinesPage />);

		expect(await screen.findByText("Acme")).toBeInTheDocument();
	});
```

In the LessonsPage suite:

```ts
	it("names the author of an org lesson", async () => {
		renderWithProviders(<LessonsPage />);

		expect(await screen.findByText("Bob")).toBeInTheDocument();
	});

	it("renders no author line when the server names nobody", async () => {
		renderWithProviders(<LessonsPage />);

		expect(screen.queryByTestId("lesson-author")).not.toBeInTheDocument();
	});
```

Match each suite's existing render helper and mock-seeding idiom rather than
introducing new ones — read the top of each file first. The mock needs an org and
an org lesson with an author name for these to have anything to find; add them
in `mockApi.ts` beside its existing seeded account.

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @onlooker/web test -- MachinesPage
pnpm --filter @onlooker/web test -- LessonsPage
```

- [ ] **Step 3: Extend the web clients**

In `apps/web/src/api/machinesApi.ts`, add to `Machine` and `MintedMachine`:

```ts
	/**
	 * The org this machine pushes to, or null for a private-only token.
	 *
	 * An id, not a name. This page already lists the account's orgs to build
	 * the picker, so it resolves the name itself rather than asking the API
	 * for a field it can derive.
	 */
	org_id: string | null;
```

and change the create call:

```ts
export function createMachine(
	name: string,
	orgId: string | null = null,
): Promise<MintedMachine> {
	return apiClient.post<MintedMachine>(MACHINE_ENDPOINTS.machines, {
		name,
		// Omitted rather than sent as null when there is no org, so the body a
		// private-only mint sends is byte-identical to the one this app sent
		// before orgs existed.
		...(orgId ? { org_id: orgId } : {}),
	});
}
```

In `apps/web/src/api/lessonsApi.ts`, add `authors: Record<string, string>` to
`LessonPage` and `author_name: string | null` to `OwnedLesson`, each with the
same reasoning the API-side comments carry, in brief.

- [ ] **Step 4: The machines page**

Add a select to the create form, labeled "Org", with a first option whose value
is `""` and whose label says the token stays private. Load the orgs with the
same hook pattern the page already uses for machines, and render nothing but the
private option when the account is in no org. In the machine list, render the
org's name resolved from that list, and nothing when `org_id` is null.

**Use a bare native `<select>` with a manual `<label>`.** Corrected 2026-10-08:
this step originally said to use `form.tsx`'s components, and `form.tsx` has no
select primitive at all. The codebase's real idiom for this is a native element
— `OrgsPage`'s role picker and `LessonsPage`'s status filter both do it that way
— so follow those two rather than inventing a primitive for one picker.

One test-design note from Task 8, so the next person does not spend time on it:
an org's name now appears twice on this page, once as a row's chip and once as
the picker's own `<option>`, so a plain `findByText` matches both. Disambiguate
with `{ selector: ":not(option)" }`, which `lessons-page.test.tsx` already uses
for the same reason.

- [ ] **Step 5: The lessons page**

In the row at `:450-470`, beside the existing `<Chip>` and `<When>`, render the
author when `authors[lesson.id]` is set:

```tsx
										{authors[lesson.id] ? (
											<span data-testid="lesson-author">
												{authors[lesson.id]}
											</span>
										) : null}
```

Hold `authors` in state beside `ownedIds`, merging on "load more" exactly as
`ownedIds` merges at `:239`, and defaulting with `?? {}` where that code uses
`?? []` — for the identical reason its comment at `:170` gives. In the detail
pane, render `author_name` when the single-lesson fetch returns one.

- [ ] **Step 6: Run the gates**

```bash
pnpm --filter @onlooker/web test
pnpm --filter @onlooker/web typecheck
pnpm --filter @onlooker/web lint
bash scripts/source-guards.test.sh
```

The source guard's "one loading state, not six" and "every route App declares
has a title" checks both cover `apps/web` — if you added a loading state for the
orgs fetch, it must be the shared one.

- [ ] **Step 7: Prove the author test can fail (REQUIRED)**

Temporarily make the row render `authors[lesson.id]` unconditionally as an empty
string. Confirm "names the author of an org lesson" FAILS. Restore, re-run,
report both.

- [ ] **Step 8: Commit**

---

### Task 9: Open the gate

**Files:**
- Modify: `apps/api/src/routes/lessons.ts:82-127` (`screen`), `:170-235` (`handlePushLessons`)
- Modify: `apps/api/src/router.ts:79-98` (the `handler` field's doc comment)
- Modify: `apps/api/src/routes/lessons.test.ts:187`
- Create: `apps/api/src/routes/lessons-org.test.ts`
- Modify: `apps/api/DEPLOYMENT.md`

**Interfaces:**
- Consumes: everything above — the resolver and predicate (Task 2), the token's
  org (Task 3), the stamping parameter (Task 4), attribution (Task 5).
- Produces: `visibility: "org"` accepted on push.

**This is last for a reason that is not sequencing.** An org lesson admitted
before its read path exists would be readable only by its author, and would
become org-visible RETROACTIVELY the day the resolver filled — a disclosure its
author never consented to, triggered by a deploy rather than by them. Tasks 2
through 5 are that read path. Nothing in this task may be done before they are
all green.

- [ ] **Step 1: Write the failing end-to-end tests**

Create `apps/api/src/routes/lessons-org.test.ts`. These four cases are the
milestone's done-when, and the first two are its text almost verbatim:

```ts
describe("the org lesson tier, end to end", () => {
	it("lets two accounts in one org read each other's org lessons", async () => {
		await push(adaToken, lesson({ visibility: "org" }));
		await push(boToken, lesson({ visibility: "org" }));

		const adaSees = await browse(ada.token);
		const boSees = await browse(bo.token);

		expect(adaSees).toHaveLength(2);
		expect(boSees).toHaveLength(2);
	});

	it("shows an account outside the org none of them", async () => {
		await push(adaToken, lesson({ visibility: "org" }));

		expect(await browse(outsider.token)).toEqual([]);
	});

	it("refuses an org push from a token bound to no org, naming the token", async () => {
		const written = lesson({ visibility: "org" });

		const result = await pushResult(privateOnlyToken, written);

		expect(result.outcome).toBe("invalid");
		// The author's mistake is WHICH CREDENTIAL they used. An error about
		// the lesson would send them to the wrong place.
		expect(result.error).toMatch(/token/i);
		expect(result.error).not.toMatch(/visibility|tier/i);
	});

	it("still lands the private lessons in a batch whose org lesson is refused", async () => {
		// Per-lesson outcomes, not a rejected request: a batch is not all or
		// nothing anywhere else in push and must not become so here.
		const priv = lesson({ visibility: "private" });
		const shared = lesson({ visibility: "org" });

		const results = await pushBoth(privateOnlyToken, [priv, shared]);

		expect(results[0].outcome).toBe("created");
		expect(results[1].outcome).toBe("invalid");
	});
});
```

Build the fixture from the real surfaces, not from the db layer: sign up two
accounts, create an org, add the second as a member, mint one machine token per
account bound to that org through `POST /api/machines`, and mint one with no org.
`push` posts to the push route with the machine token; `browse` calls
`GET /api/lessons` with the session token and returns `lessons`. Read
`routes/lessons-public.test.ts` for the push-to-read idiom this suite mirrors.

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @onlooker/api test -- lessons-org
```

Expected: every case FAILS, the first three because the gate refuses `org` with
"The org tier is not open yet".

- [ ] **Step 3: Open the gate**

In `apps/api/src/routes/lessons.ts`, give `screen` a second parameter and
replace the tier gate:

```ts
function screen(
	candidate: unknown,
	/**
	 * The org the pushing token is bound to, or null for a private-only token.
	 * Resolved by the caller only when a batch actually contains an org
	 * lesson - see handlePushLessons.
	 */
	tokenOrgId: string | null,
): { lesson: TLesson } | { result: PushResult } {
```

```ts
	// The tier gate says so explicitly. A generic validation failure here would
	// read as a client bug rather than a tier that has not opened.
	//
	// All three tiers are open as of ONL-141. public opened 2026-10-03; org
	// opened with this change, in the same commit as the read path that makes
	// it mean anything - `OrgIds` in db/pool.ts resolves the reader's orgs and
	// the predicate authorizes on the lesson's own org_id. The coupling was
	// deliberate: an org lesson admitted against an inert resolver would have
	// been readable only by its author and would have become org-visible
	// retroactively on a later deploy, which is a disclosure its author never
	// consented to.
	//
	// What a public lesson must additionally clear - a unanimous jury - is in
	// lessons/rules.ts, with the other cross-field rules, so a client is told
	// about every problem at once instead of one per round trip.
	if (
		lesson.visibility !== "private" &&
		lesson.visibility !== "public" &&
		lesson.visibility !== "org"
	) {
		return {
			result: {
				id,
				outcome: "invalid",
				error: `The ${lesson.visibility} tier is not open yet; only private, public and org lessons are accepted`,
			},
		};
	}

	// Named for the TOKEN, not the lesson. The author's mistake is which
	// credential they used: this lesson is well-formed and this account may
	// well belong to an org - the token they pushed with is simply not bound
	// to one, and no request field can change that (D3).
	if (lesson.visibility === "org" && tokenOrgId === null) {
		return {
			result: {
				id,
				outcome: "invalid",
				error:
					"This machine token is not bound to an org; mint a token for the org you want to share with",
			},
		};
	}
```

- [ ] **Step 4: Resolve the token's org, lazily**

In `handlePushLessons`, replace the screening loop (`:197-206`) with a two-pass
version. Parsing is what tells you whether the batch holds an org lesson, so the
org is resolved after a first pass and only if one does:

```ts
	// 1. Everything decidable without touching the database.
	//
	// Two passes, because the org is only needed if the batch contains an org
	// lesson and only parsing can tell. `requireMachineToken` re-verifies
	// against D1 and rewrites last_used_at, so paying it on every push - the
	// hottest machine route - to serve the minority that share with an org
	// would be the wrong trade. A private or public push runs exactly the
	// queries it ran before this change.
	// `ORG_UNRESOLVED`, not null. Corrected 2026-10-08 after Task 9's
	// implementer found that this plan's two steps contradicted each other and
	// would have shipped A GATE THAT NEVER OPENS: Step 3 has `screen` refuse
	// any org lesson when the token's org is null, and this pass called it with
	// exactly that - so no entry ever carried a parsed org lesson, `wantsOrg`
	// was never true, the org was never resolved, and the tier stayed shut
	// while every refusal test passed. The failure mode is the dangerous kind:
	// the work looks done and the feature is absent.
	//
	// So pass 1 passes a third state meaning "not asked yet", distinct from
	// both a real org id and a resolved absence. A module-level symbol rather
	// than `undefined`, because `undefined` is also what a forgotten argument
	// looks like, and conflating the two admits an org lesson unchecked:
	//
	//   const ORG_UNRESOLVED = Symbol("org not yet resolved");
	const parsed = candidates.map((candidate) => {
		try {
			return { screened: screen(candidate, ORG_UNRESOLVED) };
		} catch (error) {
			return { failed: unexpected(idOf(candidate), error) };
		}
	});

	const wantsOrg = parsed.some(
		(entry) =>
			entry.screened !== undefined &&
			"lesson" in entry.screened &&
			entry.screened.lesson.visibility === "org",
	);

	// The fourth handler that verifies its own credential, and the only one
	// that does so conditionally. See the `handler` field's doc comment in
	// router.ts: `Principal` deliberately carries only userId, so the org -
	// like machineId and email - is available on requireMachineToken's own
	// return value and nowhere else.
	const tokenOrgId = wantsOrg
		? (await requireMachineToken(request, env)).orgId
		: null;

	for (const [index, candidate] of candidates.entries()) {
		const entry = parsed[index];
		if (entry.failed) {
			results[index] = entry.failed;
			continue;
		}
		try {
			// Re-screened with the token's org now known. Screening is pure -
			// it consumes no sequence number and touches no database - so
			// running it twice for a batch that mentions an org costs nothing
			// but CPU and keeps one gate rather than two.
			const screened = screen(candidate, tokenOrgId);
			if ("result" in screened) results[index] = screened.result;
			else admitted.push({ index, lesson: screened.lesson });
		} catch (error) {
			results[index] = unexpected(idOf(candidate), error);
		}
	}
```

Import `requireMachineToken` from `../middleware/machine-auth.js`.

Then pass the org to the write (`:231`):

```ts
			const writes = await createLessonsWithFeed(
				env.DB,
				userId,
				creatable.map((item) => item.lesson),
				tokenOrgId,
			);
```

Check whether `createLessonsWithFeed` is called a second time for the `settle`
path further down the handler, and pass `tokenOrgId` there too if so. A settled
org lesson written with a null org would be invisible to its own org — a bug no
test above would catch, because `settle` only runs for an id repeated inside one
request.

- [ ] **Step 5: Update the router's doc comment**

`apps/api/src/router.ts:86-91` says "Three handlers still make their own call"
and enumerates them. It is now four. Rewrite that sentence to name
`handlePushLessons` as the fourth, say that it alone resolves conditionally and
only for a batch containing an org lesson, and keep the existing explanation of
why `Principal` carries only `userId`. An enumeration that quietly goes stale is
the failure mode this repo keeps writing guards against.

Also update `apps/api/src/routes/lessons.test.ts:187`, whose comment explains
that org stays shut because `OrgMembers` is a stub. The case it annotates
probably asserts the refusal — if so, that test now needs to assert the new
refusal (a token with no org) or be deleted in favor of the Task 9 suite.
Decide, and say which in your report.

- [ ] **Step 6: Run everything**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
pnpm --filter @onlooker/web test
pnpm --filter @onlooker/web typecheck
pnpm --filter @onlooker/web lint
pnpm --filter @onlooker/db test
pnpm --filter @onlooker/api-contract test
pnpm --filter @onlooker/brand test
bash scripts/source-guards.test.sh
```

Every package, read one summary line at a time. This is the commit that changes
what production accepts.

- [ ] **Step 7: Prove the outsider test can fail (REQUIRED)**

The most important ablation in this plan. Temporarily remove the
`org_id IN (...)` condition from the org disjunct, leaving
`visibility = 'org'`:

```ts
			visible.push("visibility = 'org'");
```

Confirm "shows an account outside the org none of them" FAILS by returning the
lesson. Restore, re-run, confirm green, report both runs.

**The outsider must belong to an org of their own, and this plan originally got
that wrong.** Corrected 2026-10-08. `pool.ts` builds the org disjunct only
inside `if (bounded.length > 0)`, so a reader in NO orgs never has it built at
all — their read is answered by "public OR mine", and removing the `org_id`
comparison cannot move that assertion by any input. The brief's outsider was in
no org, so the stage's single most important ablation was unfalsifiable as
specified.

Give the outsider their own org (`POST /api/orgs`, so the fixture goes through
the real route) and the `org_id` comparison becomes the only thing between them
and the other org's lesson. Then the ablation genuinely hands them the lesson.
Keep a **separate** case for the zero-org reader: that is a real and different
branch — refused before the disjunct is built rather than by it — and it
deserves its own assertion rather than being conflated with this one.

This was the fourth time in this stage that an ablation passed because the
fixture could not reach the state the guard exists for. The general rule, which
is now worth more than any of the four instances: **when an ablation passes, the
guard is either redundant or the fixture is inadequate, and the two are
indistinguishable until you check which branch the fixture actually reaches.**
Check the branch, not the assertion.

- [ ] **Step 8: Record the operational facts**

In `apps/api/DEPLOYMENT.md`, under the org section Stage 1 added, note that the
org tier is open, that an org lesson's visibility follows the token it was
pushed with, and that a token bound to a deleted org becomes private-only
through `ON DELETE set null`. Keep it to the facts an operator needs.

- [ ] **Step 9: Commit**

---

## Self-Review

**Spec coverage.** Stage 2's sections map to tasks as follows: Push → 4, 9. The
index → 7. Attribution → 5, 8. Owner retract → 6. The gate opens → 9. D2's
`lessons.org_id` and the predicate rekey → 1, 2. D3's server-stamped org and
one-token-per-org → 3, 4, 9. D4's named attribution → 5, 8. D6's survival of the
author's departure → 2 (the predicate never consults the author's membership)
and 6. The spec's test list maps as: the milestone's done-when → 9; the
regression test → 2 Step 10; NULL `org_id` matches nothing → 2; the last owner
cannot be removed → already shipped in Stage 1, unchanged; `OrgIds` throwing
narrows → 2; an org member cannot read a `private` lesson → 2; the anonymous
public route still 404s an org lesson → already covered by
`routes/lessons-public.test.ts`, which Task 5 Step 9 re-runs untouched; the
route-and-role enumeration → 6; the query plan → 7.

One gap found and closed inline: "an author leaves an org — the org still reads
their lesson, and they stop reading the org's others" had no assertion anywhere.
It is a property of the rekeyed predicate rather than new code, since that
predicate never consults the author's membership, which is exactly why it needed
a test: a property nothing observes is a property the next reader can
reasonably-looking "fix" away. It is now the last case in Task 6's route suite,
where memberships are already being manipulated.

Invite behaviors in the spec's test list — expiry, replay,
replace-on-reinvite, the 409, revocation — all shipped in Stage 1 and are tested
there. Nothing in this plan touches them.

**Placeholders.** None. Every code step carries the code. Where a signature must
be confirmed against the tree before writing (`requireOrgRole`'s parameter
order, `createInvite`'s real name, the mock's single-lesson handler) the step
says so explicitly and says what to do if it differs.

**Type consistency.** `OrgIds` is the type in Tasks 2, 5 and 7.
`orgIdsForUser` is the resolver everywhere. `MAX_READER_ORGS_BOUND` replaces
`MAX_ORG_MEMBERS_BOUND` in Tasks 2 and 7. `authors: Record<string, string>` is
the field name in Tasks 5 and 8; `author_name: string | null` is the
single-lesson field in both. `org_id` is the wire name on every surface — the
column, `MachineTokenSummary`, the machines request and response, and the web
`Machine` — while `orgId` is the TypeScript parameter name on
`createLessonsWithFeed`, `verifyMachineToken`'s result and `screen`. That split
is the repo's existing convention (`owned_ids` beside `ownedIds`) rather than an
inconsistency.
