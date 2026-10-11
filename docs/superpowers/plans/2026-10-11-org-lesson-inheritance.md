# Org Lessons Outliving Their Author Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lesson shared with an org survives its author's account deletion
and stays readable, attributable and retractable by that org.

**Architecture:** Account deletion becomes a three-way decision. With no
surviving org lessons the `users` row is still deleted outright and all seven
cascades fire exactly as today. With surviving org lessons the row is kept as an
anchor, stripped of identity and credentials, and every dependent is cleaned up
explicitly in one transaction. Both paths carry their conditions in their own
`WHERE` clauses so neither can be raced.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Drizzle ORM + drizzle-kit,
Vitest with `@cloudflare/vitest-pool-workers`, React 19, Biome, pnpm + turbo.

Spec: `docs/superpowers/specs/2026-10-11-org-lesson-inheritance-design.md`.
Read D1–D5 and the atomicity section if a step's reasoning is unclear; do not
re-litigate them.

## Global Constraints

- **Only org-shared lessons survive**: `visibility = 'org' AND org_id IS NOT NULL`.
  Public and private lessons are deleted with the account. (D2)
- **The row is deleted when nothing needs it.** Anonymization happens only when
  the account has at least one surviving org lesson. (D1)
- **Anonymization sets** `email` to `deleted+<uuid>@deleted.invalid`,
  `password_hash` to a real bcrypt hash of a discarded random value, `name` and
  `email_verified` to NULL, and `anonymized_at` to an ISO timestamp. (D3)
- **`password_hash` must be a valid bcrypt hash, not a sentinel string.**
  `verifyPassword` calls `bcrypt.compare`, which has no defined answer for a
  non-hash. A hash of something nobody knows returns false for every guess.
- **Every dependent is handled explicitly on the anonymize path**, because
  nothing cascades when nothing is deleted: `sessions`, `verification_tokens`,
  `machine_tokens`, `session_summaries` and `org_memberships` are deleted;
  non-org `lessons` are deleted; `lesson_feed` rows for surviving lessons are
  **kept**; `org_invites` rows are **kept**.
- **`lesson_feed` rows for the surviving author must not be deleted.**
  `transitionLesson` allocates `MAX(seq) + 1 WHERE user_id = ?`, so those rows
  are what keeps a later org retract's sequence correct.
- **`machine_tokens` must be deleted.** Security-critical: a surviving token
  authenticates as the anonymized row.
- **The sole-owner guard stays in a `WHERE` clause** on whichever statement
  writes the user, and the delete path gains a second condition so the path
  choice cannot be raced. (Atomicity section)
- **In the disambiguation, the sole-owner check runs BEFORE the org-lesson
  check.** An account that is both would otherwise be anonymized while still
  owning an org, leaving zero owners — the invariant #198 shipped to protect.
- **The route's success shape is unchanged**: `{ success: true }` for both
  `"deleted"` and `"anonymized"`. A caller does not need to know which ran, and
  telling them leaks how many org lessons the account had.
- **`former_authors` is an array of lesson ids, always present, `[]` when
  empty**; `former_author` is a boolean on the single read, always present. A
  lesson id appears in at most one of `authors` and `former_authors`.
- **The server never sends the string "Former member".** The client renders it.
- **No new `lessons` query outside `db/lessons.ts` or `db/pool.ts`** —
  `scripts/source-guards.test.sh` enforces it, so the account-deletion path
  calls into `db/lessons.ts` rather than querying inline.
- **American English** everywhere, including comments and copy.
- **Commits route through `/git-workflow:commit`.** If it is not in your skill
  list, mirror its contract: `<type>(<scope>): <subject> :emoji:`, mood emoji
  reflecting the change rather than the type, why-focused body, subject ≤72
  chars including the emoji, body lines ≤80. Never `--no-gpg-sign`.

### Running tests — read this before your first test run

`pnpm --filter <pkg> test -- <name>` **does not filter.** The forwarded `--`
breaks vitest's matcher and it silently runs the whole suite (ONL-144). Per
file, run vitest from inside the package:

```bash
cd apps/api && pnpm exec vitest run queries.test
cd apps/web && pnpm exec vitest run lessons-page
```

Whole-suite runs take the `pnpm --filter` form with no extra arguments.

**A fresh worktree must run `pnpm build` first**, or every `apps/api` test file
fails to collect on `@onlooker-community/lesson-contract`'s missing entry. This
worktree is already built; run it again only if you see that symptom or after
changing `packages/db`.

**Task 1 changes `packages/db`, so every later task must `pnpm build` before
running `apps/api`'s suite** — a stale `packages/db/dist` makes the new column
invisible to the API's types.

### The four gates, before every commit that touches code

1. `pnpm --filter <pkg> test`
2. `pnpm --filter <pkg> typecheck`
3. `pnpm --filter <pkg> lint`
4. `bash scripts/source-guards.test.sh`

`apps/api`'s lint reports **3 pre-existing warnings** (two `useOptionalChain`
in `src/middleware/auth.ts`, one `noTemplateCurlyInString` in
`src/monitoring.test.ts`); `apps/web`'s reports **9**, all in
`src/api/mockApi.test.ts`. None are yours. Any beyond those are.

Touching `packages/api-contract` means running **both** suites.

### Two traps from the preceding branches

- `apps/api/src/router.ts` imports handlers through the **`routes/index.ts`
  barrel**, not directly from the route module. A handler added to the route
  table without a barrel re-export compiles and never wires up.
- Test files whose `beforeEach` creates `ada@example.com` / `bob@example.com`
  will collide if you add a user with the same address. `users.email` is
  UNIQUE. Use a fresh address such as `cleo@example.com`.

---

## File Structure

**Create:**
- `packages/db/migrations/00NN_<name>.sql` — generated by drizzle-kit in Task 1.

**Modify:**
- `packages/db/src/schema.ts` — one column on `users`.
- `packages/db/src/expected-schema.ts` — regenerated, not hand-edited.
- `apps/api/src/db/lessons.ts` — the two lesson-scoped helpers the deletion
  path needs, because the source guard keeps `lessons` queries here.
- `apps/api/src/db/queries.ts` — `deleteUser` becomes three-way.
- `apps/api/src/routes/account.ts` — map the third outcome.
- `apps/api/src/db/pool-page.ts` — `formerAuthors` on `LessonPage`.
- `apps/api/src/db/pool.ts` — `authorNames` returns both maps;
  `orgAuthorName` returns both facts.
- `apps/api/src/db/lessons.ts` — `getLessonForUser` carries `former_author`.
- `apps/api/src/routes/lessons-browser.ts` — serialize both fields.
- `packages/api-contract/src/index.ts` — pin both fields.
- `apps/web/src/api/mockApi.ts`, `apps/web/src/api/lessonsApi.ts`,
  `apps/web/src/pages/LessonsPage.tsx`, `apps/web/src/pages/LessonDetail.tsx`,
  `apps/web/src/pages/SettingsPage.tsx` — the client half and the copy.

No new modules. Every change lands beside its closest sibling.

---

## Task 1: The `anonymized_at` column

**Files:**
- Modify: `packages/db/src/schema.ts` (the `users` table, after `email_verified`)
- Modify: `packages/db/src/expected-schema.ts` (regenerated)
- Create: `packages/db/migrations/00NN_*.sql` (generated)
- Test: `packages/db`'s own suite, plus `apps/api/src/db/orgs-schema.test.ts`

**Interfaces:**
- Produces, for Tasks 3 and 4: `users.anonymized_at`, nullable `TEXT`, no
  foreign key, no default. NULL means a live account.

- [ ] **Step 1: Add the column**

In `packages/db/src/schema.ts`, in the `users` table, immediately after
`email_verified` and before `created_at`:

```ts
		/**
		 * When this account was anonymized, or NULL for a live account.
		 *
		 * Account deletion keeps the row only when an org lesson needs it as an
		 * anchor - `lessons.user_id` is notNull, and `transitionLesson` writes
		 * to this user's own `lesson_feed`, so a lesson cannot outlive its
		 * author without one. Identity and credentials are stripped; this
		 * column is what says so.
		 *
		 * Two readers depend on it. Attribution distinguishes a departed author
		 * from a member who never set a name, which would otherwise render
		 * identically. And a second deletion attempt answers "already gone"
		 * from this rather than by matching an email against a pattern.
		 */
		anonymized_at: text("anonymized_at"),
```

- [ ] **Step 2: Generate the migration**

```bash
pnpm --filter @onlooker/db generate:migrations
```

Expected: a new `packages/db/migrations/00NN_*.sql` containing exactly
`ALTER TABLE \`users\` ADD \`anonymized_at\` text;`.

**Read the generated SQL before continuing.** drizzle-kit v0.22.8 drops
`ON DELETE` from `ALTER TABLE ADD COLUMN`, which is why migration 0011 is
hand-completed — but that only bites a column with a foreign key, and this one
has none. If the generated file contains anything other than that single
`ALTER TABLE`, stop and report rather than editing around it.

- [ ] **Step 3: Regenerate the expected schema**

```bash
pnpm --filter @onlooker/db generate:expected-schema
```

Expected: `packages/db/src/expected-schema.ts`'s `users.columns` gains
`{ name: "anonymized_at", type: "TEXT", notnull: 0, pk: 0 }` **at the end** —
`ADD COLUMN` appends, so it lands after `updated_at` rather than where the
TypeScript declares it. Do not hand-edit this file; if the script does not
produce that, stop and report.

- [ ] **Step 4: Build and run the schema tests**

```bash
pnpm --filter @onlooker/db build
pnpm --filter @onlooker/db test
cd apps/api && pnpm exec vitest run orgs-schema
```

Expected: PASS. `apps/api`'s schema test applies the migrations to a fresh D1
and compares against the expected schema, so it is what proves the migration
and the declaration agree.

- [ ] **Step 5: Run the gates**

```bash
pnpm --filter @onlooker/db typecheck
pnpm --filter @onlooker/db lint
pnpm --filter @onlooker/api test
bash scripts/source-guards.test.sh
```

Expected: `apps/api` still 648/648 — this task changes no behavior.

- [ ] **Step 6: Commit**

Use `/git-workflow:commit`. Stage the schema, the generated migration and the
regenerated expected-schema together: a migration without its expected-schema
entry fails the schema test, so they are one change.

---

## Task 2: The lesson-scoped helpers

**Files:**
- Modify: `apps/api/src/db/lessons.ts` (append after the existing exports)
- Test: `apps/api/src/db/lessons.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 directly.
- Produces, for Task 3:
  - `export async function hasOrgSharedLessons(db: D1Database, userId: string): Promise<boolean>`
  - `export async function deleteNonOrgLessons(db: D1Database, userId: string): Promise<number>` — returns rows deleted.

Both live here rather than in `db/queries.ts` because
`scripts/source-guards.test.sh` permits a `lessons` query only in
`db/lessons.ts` and `db/pool.ts`. A query in `queries.ts` fails gate 4.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/db/lessons.test.ts`. Use that file's existing fixture
helpers; read its `beforeEach` first and reuse the user it already creates
rather than adding one with a colliding email.

```ts
describe("hasOrgSharedLessons", () => {
	it("is true for a lesson shared with an org", async () => {
		await createLessonsWithFeed(db(), author, [lesson({ visibility: "org" })], orgId);
		expect(await hasOrgSharedLessons(db(), author)).toBe(true);
	});

	it("is false for public and private lessons only", async () => {
		await createLessonsWithFeed(db(), author, [
			lesson({ visibility: "public" }),
			lesson({ visibility: "private" }),
		], null);
		expect(await hasOrgSharedLessons(db(), author)).toBe(false);
	});

	it("is false for an org lesson whose org is gone", async () => {
		// org_id is ON DELETE SET NULL, so such a row is readable by nobody and
		// must not keep an account alive as its anchor.
		await createLessonsWithFeed(db(), author, [lesson({ visibility: "org" })], orgId);
		await db().prepare("UPDATE lessons SET org_id = NULL WHERE user_id = ?").bind(author).run();
		expect(await hasOrgSharedLessons(db(), author)).toBe(false);
	});

	it("is false for another user's org lesson", async () => {
		await createLessonsWithFeed(db(), other, [lesson({ visibility: "org" })], orgId);
		expect(await hasOrgSharedLessons(db(), author)).toBe(false);
	});
});

describe("deleteNonOrgLessons", () => {
	it("deletes public and private lessons and keeps org ones", async () => {
		await createLessonsWithFeed(db(), author, [
			lesson({ visibility: "public" }),
			lesson({ visibility: "private" }),
		], null);
		const kept = lesson({ visibility: "org" });
		await createLessonsWithFeed(db(), author, [kept], orgId);

		expect(await deleteNonOrgLessons(db(), author)).toBe(2);

		const rows = await db()
			.prepare("SELECT id, visibility FROM lessons WHERE user_id = ?")
			.bind(author)
			.all<{ id: string; visibility: string }>();
		expect(rows.results?.map((r) => r.id)).toEqual([kept.id]);
	});

	it("deletes an org lesson whose org is gone", async () => {
		await createLessonsWithFeed(db(), author, [lesson({ visibility: "org" })], orgId);
		await db().prepare("UPDATE lessons SET org_id = NULL WHERE user_id = ?").bind(author).run();

		expect(await deleteNonOrgLessons(db(), author)).toBe(1);
	});

	it("takes the deleted lessons' feed rows with them", async () => {
		await createLessonsWithFeed(db(), author, [lesson({ visibility: "public" })], null);
		// lesson_feed.lesson_id cascades from lessons, so this needs no code of
		// its own - but it is the reason the anonymize path can keep the
		// author's remaining feed rows without keeping dead ones.
		expect(await deleteNonOrgLessons(db(), author)).toBe(1);
		const feed = await db()
			.prepare("SELECT COUNT(*) AS n FROM lesson_feed WHERE user_id = ?")
			.bind(author)
			.first<{ n: number }>();
		expect(feed?.n).toBe(0);
	});

	it("leaves another user's lessons alone", async () => {
		await createLessonsWithFeed(db(), other, [lesson({ visibility: "public" })], null);
		expect(await deleteNonOrgLessons(db(), author)).toBe(0);
	});
});
```

If `lessons.test.ts` has no `orgId`/`other` in scope, create them in the new
`describe`'s own `beforeEach` with `createOrgWithOwner(db(), "Acme", author)`
and `createUser(db(), "cleo@example.com", "hash", "Cleo")`.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd apps/api && pnpm exec vitest run lessons.test
```

Expected: the new block fails to import — neither function is exported yet.

- [ ] **Step 3: Implement both**

Append to `apps/api/src/db/lessons.ts`:

```ts
/**
 * Whether this user has a lesson that must outlive their account.
 *
 * The condition is the whole of ONL-136's decision: a lesson shared with an
 * org belongs to the org once its author leaves. `org_id IS NOT NULL` is not
 * redundant with `visibility = 'org'` - `lessons.org_id` is ON DELETE SET
 * NULL, so a row whose org was deleted is readable by nobody at all, and
 * keeping an account alive to anchor one would retain identity for nothing.
 */
export async function hasOrgSharedLessons(
	db: D1Database,
	userId: string,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS present FROM lessons
			 WHERE user_id = ? AND visibility = 'org' AND org_id IS NOT NULL
			 LIMIT 1`,
		)
		.bind(userId)
		.first<{ present: number }>();

	return row !== null;
}

/**
 * Delete the lessons that go with a deleted account.
 *
 * Everything except the org-shared ones: a private lesson would be
 * permanently unreadable once nobody can authenticate as its author, and a
 * public one is the author's own publication to withdraw. The inverse of
 * `hasOrgSharedLessons` above, deliberately written as the same condition
 * negated so the two cannot drift apart.
 *
 * Each lesson takes its own `lesson_feed` rows with it, because
 * `lesson_feed.lesson_id` cascades from `lessons`. The author's remaining feed
 * rows - the ones belonging to surviving lessons - stay, and they must:
 * `transitionLesson` allocates `MAX(seq) + 1` for this user, so they are what
 * keeps a later org retract's sequence correct.
 */
export async function deleteNonOrgLessons(
	db: D1Database,
	userId: string,
): Promise<number> {
	const result = await db
		.prepare(
			`DELETE FROM lessons
			 WHERE user_id = ?
			   AND NOT (visibility = 'org' AND org_id IS NOT NULL)`,
		)
		.bind(userId)
		.run();

	return result.meta.changes ?? 0;
}
```

- [ ] **Step 4: Run them to verify they pass**

```bash
cd apps/api && pnpm exec vitest run lessons.test
```

Expected: PASS.

- [ ] **Step 5: Prove the org condition is load-bearing — ablate it**

In `deleteNonOrgLessons`, change `AND NOT (visibility = 'org' AND org_id IS NOT NULL)`
to `AND NOT (visibility = 'org')`.

```bash
cd apps/api && pnpm exec vitest run lessons.test
```

Expected: **"deletes an org lesson whose org is gone" FAILS.** If it passes,
the fixture never nulled the `org_id` — fix the fixture, not the condition.

Restore it, re-run, confirm PASS. Leave no ablation applied.

- [ ] **Step 6: Run the gates**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

Gate 4 matters here specifically: it is what would catch these queries living
in the wrong file.

- [ ] **Step 7: Commit**

Use `/git-workflow:commit`. Stage `db/lessons.ts` and `db/lessons.test.ts`.

---

## Task 3: `deleteUser` becomes three-way

**Files:**
- Modify: `apps/api/src/db/queries.ts` (`AccountDeleteResult` at :283, `deleteUser` at :312)
- Modify: `apps/api/src/routes/account.ts` (the `handleDeleteAccount` result mapping)
- Test: `apps/api/src/db/queries.test.ts` and
  `apps/api/src/routes/account-deletion.test.ts`

**Interfaces:**
- Consumes from Task 1: `users.anonymized_at`. From Task 2:
  `hasOrgSharedLessons`, `deleteNonOrgLessons`.
- Produces: `AccountDeleteResult = "deleted" | "anonymized" | "sole_owner"`.
  The route answers `{ success: true }` for the first two and the existing
  `409 sole_owner` for the third.

**This is the task the spec's atomicity section is about. Read it before
starting.**

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/db/queries.test.ts`. Read its `beforeEach` first; reuse the
users it creates rather than adding colliding addresses.

```ts
describe("deleteUser when an org lesson must survive", () => {
	it("anonymizes rather than deleting, and keeps the org lesson", async () => {
		const orgId = (await createOrgWithOwner(db(), "Acme", ada)).id;
		await addMembership(db(), orgId, bob, "owner"); // so ada is not a sole owner
		const kept = lesson({ visibility: "org" });
		await createLessonsWithFeed(db(), ada, [kept], orgId);

		expect(await deleteUser(db(), ada)).toBe("anonymized");

		const row = await db()
			.prepare("SELECT email, name, email_verified, anonymized_at FROM users WHERE id = ?")
			.bind(ada)
			.first<{ email: string; name: string | null; email_verified: string | null; anonymized_at: string | null }>();
		expect(row).not.toBeNull();
		expect(row?.name).toBeNull();
		expect(row?.email_verified).toBeNull();
		expect(row?.anonymized_at).not.toBeNull();
		expect(row?.email).not.toBe("ada@example.com");

		const stored = await probeLessonId(db(), kept.id);
		expect(stored?.user_id).toBe(ada);
	});

	it("deletes the account outright when no org lesson survives", async () => {
		await createLessonsWithFeed(db(), ada, [lesson({ visibility: "public" })], null);

		expect(await deleteUser(db(), ada)).toBe("deleted");
		expect(await getUserById(db(), ada)).toBeNull();
	});

	it("destroys every credential and membership on the anonymize path", async () => {
		const orgId = (await createOrgWithOwner(db(), "Acme", ada)).id;
		await addMembership(db(), orgId, bob, "owner");
		await createLessonsWithFeed(db(), ada, [lesson({ visibility: "org" })], orgId);
		const token = await createMachineToken(db(), ada, "laptop", null);

		expect(await deleteUser(db(), ada)).toBe("anonymized");

		// The security-critical one: a surviving token authenticates AS the
		// anonymized row, which no password can reach but a bearer token would.
		expect(await findMachineTokenByHash(db(), token.tokenHash)).toBeNull();
		expect(await getMembership(db(), orgId, ada)).toBeNull();
		const sessions = await db()
			.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
			.bind(ada)
			.first<{ n: number }>();
		expect(sessions?.n).toBe(0);
	});

	it("keeps the surviving lesson's feed rows", async () => {
		const orgId = (await createOrgWithOwner(db(), "Acme", ada)).id;
		await addMembership(db(), orgId, bob, "owner");
		await createLessonsWithFeed(db(), ada, [lesson({ visibility: "org" })], orgId);

		await deleteUser(db(), ada);

		// transitionLesson allocates MAX(seq)+1 for this user. Deleting these
		// would make a later org retract reuse a sequence number.
		const feed = await db()
			.prepare("SELECT COUNT(*) AS n FROM lesson_feed WHERE user_id = ?")
			.bind(ada)
			.first<{ n: number }>();
		expect(feed?.n).toBeGreaterThan(0);
	});

	it("still refuses a sole owner, leaving nothing half-dismantled", async () => {
		const orgId = (await createOrgWithOwner(db(), "Acme", ada)).id;
		await createLessonsWithFeed(db(), ada, [lesson({ visibility: "org" })], orgId);
		const token = await createMachineToken(db(), ada, "laptop", null);

		expect(await deleteUser(db(), ada)).toBe("sole_owner");

		// The refusal must be total. A half-applied anonymization would leave
		// an account that cannot log in and an org that still has its owner.
		const row = await db()
			.prepare("SELECT name, anonymized_at FROM users WHERE id = ?")
			.bind(ada)
			.first<{ name: string | null; anonymized_at: string | null }>();
		expect(row?.name).toBe("Ada");
		expect(row?.anonymized_at).toBeNull();
		expect(await getMembership(db(), orgId, ada)).not.toBeNull();
		expect(await findMachineTokenByHash(db(), token.tokenHash)).not.toBeNull();
	});

	it("is idempotent", async () => {
		const orgId = (await createOrgWithOwner(db(), "Acme", ada)).id;
		await addMembership(db(), orgId, bob, "owner");
		await createLessonsWithFeed(db(), ada, [lesson({ visibility: "org" })], orgId);

		expect(await deleteUser(db(), ada)).toBe("anonymized");
		const first = await db()
			.prepare("SELECT anonymized_at FROM users WHERE id = ?")
			.bind(ada)
			.first<{ anonymized_at: string | null }>();

		// Reachable in practice: an access token outlives the account for up to
		// TOKEN_EXPIRY_MINUTES (ONL-146), so the same caller can call twice.
		expect(await deleteUser(db(), ada)).toBe("anonymized");
		const second = await db()
			.prepare("SELECT anonymized_at FROM users WHERE id = ?")
			.bind(ada)
			.first<{ anonymized_at: string | null }>();
		expect(second?.anonymized_at).toBe(first?.anonymized_at);
	});

	it("reports deleted for an account that is already gone", async () => {
		expect(await deleteUser(db(), "no-such-user")).toBe("deleted");
	});
});
```

If `createMachineToken` / `findMachineTokenByHash` have different names or
signatures, find the real ones with
`grep -n "export async function" apps/api/src/db/machine-tokens.ts` and use
those; report what you used.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd apps/api && pnpm exec vitest run queries.test
```

Expected: FAIL — `"anonymized"` is not a possible return value yet, so the
first test fails on the assertion and several others fail on the row still
being gone.

- [ ] **Step 3: Widen the result type**

In `apps/api/src/db/queries.ts`, replace line 283's type:

```ts
/**
 * What an account deletion did.
 *
 * "deleted" covers the row being gone, including an account that was already
 * gone - the caller wanted it gone and it is, which is the intent the original
 * unconditional handler had and this preserves.
 *
 * "anonymized" means the row was kept as an anchor for a lesson shared with an
 * org, stripped of identity and credentials. The route does not tell the two
 * apart: a caller does not need to know, and the distinction would leak
 * whether they had org lessons to anybody who could trigger the call.
 */
export type AccountDeleteResult = "deleted" | "anonymized" | "sole_owner";
```

- [ ] **Step 4: Rewrite `deleteUser`**

Replace the whole function. Add to `queries.ts`'s imports:
`import { deleteNonOrgLessons, hasOrgSharedLessons } from "./lessons.js";`,
`import { soleOwnedOrgs } from "./orgs.js";`, and `hashPassword` from
`../utils/crypto.js`.

```ts
export async function deleteUser(
	db: D1Database,
	userId: string,
): Promise<AccountDeleteResult> {
	// The delete path, unchanged from #198 except for its second condition.
	// Every one of the seven tables referencing users cascades, so a successful
	// delete needs no cleanup of its own.
	//
	// That second condition is what makes the choice between paths unraceable.
	// Deciding "this account has no org lessons" with a read and then deleting
	// would let a lesson pushed in between be cascaded away - the exact loss
	// this work exists to prevent. Refusing instead sends the retry down the
	// anonymize path.
	const deleted = await db
		.prepare(
			`DELETE FROM users
			 WHERE id = ?
			   AND NOT EXISTS (
			     SELECT 1 FROM org_memberships m
			     WHERE m.user_id = ? AND m.role = 'owner'
			       AND (SELECT COUNT(*) FROM org_memberships o
			            WHERE o.org_id = m.org_id AND o.role = 'owner') = 1)
			   AND NOT EXISTS (
			     SELECT 1 FROM lessons
			     WHERE user_id = ? AND visibility = 'org' AND org_id IS NOT NULL)`,
		)
		.bind(userId, userId, userId)
		.run();

	if ((deleted.meta.changes ?? 0) > 0) return "deleted";

	// Zero rows has three causes now, and the ORDER of these reads matters.
	// The sole-owner check must come first: an account that is both a sole
	// owner and the author of an org lesson would otherwise be anonymized
	// while still owning an org, leaving zero owners - the state #198 shipped
	// to prevent. Neither read can invert the decision; the write has already
	// refused authoritatively, and the anonymize statement below re-checks the
	// guard in its own WHERE rather than trusting what these said.
	if ((await soleOwnedOrgs(db, userId)).length > 0) return "sole_owner";

	if (!(await hasOrgSharedLessons(db, userId))) {
		// Nothing to anchor and no org to protect, so the delete's own
		// conditions did not refuse - the row was already gone.
		return "deleted";
	}

	await deleteNonOrgLessons(db, userId);

	// One batch is one transaction in D1. The UPDATE carries the sole-owner
	// guard, and every cleanup is conditioned on the UPDATE having landed,
	// which it can observe because they share the transaction. So a refused
	// guard leaves the account untouched rather than half-dismantled.
	//
	// `anonymized_at IS NULL` makes this idempotent, which is reachable: an
	// access token outlives its account for up to TOKEN_EXPIRY_MINUTES.
	const anonymized = `deleted+${crypto.randomUUID()}@deleted.invalid`;
	// A real bcrypt hash of a discarded value, not a sentinel string:
	// verifyPassword calls bcrypt.compare, which has no defined answer for a
	// non-hash, while a hash of something nobody knows returns false for every
	// guess.
	const unusable = await hashPassword(
		`${crypto.randomUUID()}${crypto.randomUUID()}`,
	);
	const now = new Date().toISOString();
	const landed = `AND EXISTS (SELECT 1 FROM users WHERE id = ? AND anonymized_at IS NOT NULL)`;

	await db.batch([
		db
			.prepare(
				`UPDATE users
				    SET email = ?, password_hash = ?, name = NULL,
				        email_verified = NULL, anonymized_at = ?
				  WHERE id = ? AND anonymized_at IS NULL
				    AND NOT EXISTS (
				      SELECT 1 FROM org_memberships m
				      WHERE m.user_id = ? AND m.role = 'owner'
				        AND (SELECT COUNT(*) FROM org_memberships o
				             WHERE o.org_id = m.org_id AND o.role = 'owner') = 1)`,
			)
			.bind(anonymized, unusable, now, userId, userId),
		db.prepare(`DELETE FROM sessions WHERE user_id = ? ${landed}`).bind(userId, userId),
		db
			.prepare(`DELETE FROM verification_tokens WHERE user_id = ? ${landed}`)
			.bind(userId, userId),
		db
			.prepare(`DELETE FROM machine_tokens WHERE user_id = ? ${landed}`)
			.bind(userId, userId),
		db
			.prepare(`DELETE FROM session_summaries WHERE user_id = ? ${landed}`)
			.bind(userId, userId),
		db
			.prepare(`DELETE FROM org_memberships WHERE user_id = ? ${landed}`)
			.bind(userId, userId),
	]);

	// Either this call anonymized the row or a previous one did. Both are the
	// same answer to the caller.
	return "anonymized";
}
```

**Note on `org_invites`:** rows whose `invited_by` is this account stay. An
invitation belongs to the org, `invited_by` is provenance only, and an org may
want a pending invitation honored after the inviter leaves. Do not add a delete
for it.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/api && pnpm exec vitest run queries.test
```

Expected: PASS.

- [ ] **Step 6: Map the route's third outcome**

In `apps/api/src/routes/account.ts`, `handleDeleteAccount` currently branches
on `result === "sole_owner"` and otherwise returns `{ success: true }`. The
only change needed is the comment, because `"deleted"` and `"anonymized"` both
fall through to the same success. Replace the comment above the final return
with:

```ts
	// Both successes answer the same shape. Whether the row was deleted or
	// kept as an anchor for an org's lessons is not the caller's business, and
	// saying which would tell anybody who can trigger this call whether the
	// account had org lessons.
```

Verify no other code switches on the old `"ok"` value:

```bash
grep -rn '"ok"' apps/api/src --include "*.ts" | grep -i "delete\|account"
```

Fix any hit; report what you found.

- [ ] **Step 7: Add the route-level test**

In `apps/api/src/routes/account-deletion.test.ts`, inside the existing
`describe`:

```ts
	it("reports success when the account is anonymized rather than deleted", async () => {
		const orgId = await createOrg(ada.token, "Acme");
		await addMembership(db(), orgId, bob.id, "owner");
		await createLessonsWithFeed(db(), ada.id, [lesson({ visibility: "org" })], orgId);

		const response = await deleteAccount(ada.token);

		// The caller cannot tell the two paths apart, by design.
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true });
	});
```

Add whatever imports that file lacks (`createLessonsWithFeed`, `lesson`, and
the lesson-table clearing in its `beforeEach`, since `resetOrgTables` does not
touch `lessons` or `lesson_feed`):

```ts
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	resetLessonCounter();
```

- [ ] **Step 8: Prove the sole-owner guard still holds — ablate it**

Remove the `AND NOT EXISTS (...)` sole-owner subquery from the **UPDATE** in
step 4 (leave the DELETE's alone), and adjust its binds.

```bash
cd apps/api && pnpm exec vitest run queries.test
```

Expected: **"still refuses a sole owner, leaving nothing half-dismantled"
FAILS** — the account would be anonymized while still owning an org. If it
passes, the fixture is not reaching the guard; fix the fixture.

Restore it, re-run, confirm PASS.

- [ ] **Step 9: Prove the machine-token delete is load-bearing — ablate it**

Remove the `machine_tokens` delete from the batch.

```bash
cd apps/api && pnpm exec vitest run queries.test
```

Expected: **"destroys every credential and membership on the anonymize path"
FAILS.** Restore it, re-run, confirm PASS. Leave no ablation applied.

- [ ] **Step 10: Write the test this whole task exists to make possible**

**The org can still retract a departed author's lesson.** The spec names this
as the test that proves the feed reasoning — everything else in this task could
be right and this could still fail, because `transitionLesson` writes to the
author's `lesson_feed` and `lesson_feed.user_id` references `users`.

It goes in `apps/api/src/routes/orgs-lessons.test.ts`, which already has the
whole fixture: an `owner`, a `member`, an org, a `sharedId` authored by the
member, the lesson-table clearing and a `call`. Add `deleteUser` to its imports
from `../db/queries.js`.

```ts
describe("after the author's account is gone", () => {
	it("an owner can still retract the lesson they left behind", async () => {
		// The member authored sharedId and shared it with the org. Promote the
		// owner's co-ownership first so deleting the member is not refused for
		// a reason unrelated to this test - the member is a plain member here,
		// so nothing blocks it, but assert the outcome rather than assuming.
		expect(await deleteUser(db(), member.id)).toBe("anonymized");

		const response = await call(
			`/api/orgs/${orgId}/lessons/${sharedId}/retract`,
			owner.token,
			{ method: "POST" },
		);

		// A 500 here is the failure mode to watch for: transitionLesson
		// allocates MAX(seq)+1 for the AUTHOR's feed and inserts under their
		// user_id, so an author whose row was deleted rather than anonymized
		// would make this violate a foreign key.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ status: "retracted" });
	});

	it("and a block on that author still applies", async () => {
		// lesson_author_blocks keys on author_key, not user_id, so a blocked
		// author cannot evade a block by deleting their account. Anonymization
		// must preserve that, and it does so only because author_key lives on
		// the lesson row rather than being resolved through users.
		const stored = await probeLessonId(db(), sharedId);
		await blockAuthor(
			db(),
			stored?.author_key ?? "",
			"ONL-136 check",
			owner.id,
		);

		expect(await deleteUser(db(), member.id)).toBe("anonymized");

		const page = await call("/api/lessons", owner.token);
		const body = (await page.json()) as { lessons: { id: string }[] };
		expect(body.lessons.map((l) => l.id)).not.toContain(sharedId);
	});
});
```

`blockAuthor(db, authorKey, reason, blockedBy)` is in
`apps/api/src/db/author-blocks.ts:18`. The assertion holds for org reads, not
only public ones: `visibilityPredicate` builds
`AND (own OR (status != 'retracted' AND NOT EXISTS (<block>)))`
(`apps/api/src/db/pool.ts:159-162`), so the block applies to every reader who
is not the author — which, after anonymization, is everybody.

- [ ] **Step 11: Ablate the feed-keeping to prove step 10's first test**

In `deleteNonOrgLessons` (Task 2, `db/lessons.ts`), temporarily widen the
delete to take every lesson — `WHERE user_id = ?` with no `NOT` clause — which
also removes the surviving lesson's feed rows via the cascade.

```bash
cd apps/api && pnpm exec vitest run orgs-lessons
```

Expected: **"an owner can still retract the lesson they left behind" FAILS**,
because the lesson itself is gone. That proves the test reaches the retract
path. Restore it.

Then the sharper ablation, which isolates the feed rather than the lesson:
after the `deleteUser` call in that test, add
`await db().prepare("DELETE FROM lesson_feed WHERE user_id = ?").bind(member.id).run();`
and re-run. Expected: the retract still returns 200, because
`COALESCE(MAX(seq), 0) + 1` falls back to 1 on an empty feed — so record in
your report that the feed rows are **belt-and-braces for sequence continuity
rather than a correctness requirement**, which is worth knowing and is not what
the spec assumed. Remove the added line.

Leave no ablation applied; confirm `git status` and `git diff` are clean.

- [ ] **Step 12: Run the gates**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

- [ ] **Step 13: Commit**

Use `/git-workflow:commit`. One commit: the type, the function, the route
comment and the test files are one deliverable — a deletion that keeps what the
org needs.

---

## Task 4: Attribution for a departed author

**Files:**
- Modify: `apps/api/src/db/pool-page.ts` (`LessonPage`, after `authors` at :107)
- Modify: `apps/api/src/db/pool.ts` (`authorNames` at :341, `orgAuthorName` at :486)
- Modify: `apps/api/src/db/lessons.ts` (`getLessonForUser`)
- Modify: `apps/api/src/routes/lessons-browser.ts` (:82 and :119)
- Test: `apps/api/src/db/pool.test.ts`, `apps/api/src/routes/lessons-browser.test.ts`

**Interfaces:**
- Consumes from Task 1: `users.anonymized_at`.
- Produces for Tasks 5 and 6: `former_authors: string[]` on the pool read,
  always present; `former_author: boolean` on the single read, always present.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/db/pool.test.ts`, using that file's existing org fixture:

```ts
describe("former_authors", () => {
	it("names the lessons whose author has been anonymized", async () => {
		const written = await seedOrgLesson(departed, orgId);
		await db()
			.prepare("UPDATE users SET name = NULL, anonymized_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), departed)
			.run();

		const page = await readPool(db(), { userId: reader }, {});

		expect(page.formerAuthors).toContain(written.id);
		// A null name emits no `authors` key, so the two cannot both describe
		// the same lesson.
		expect(page.authors[written.id]).toBeUndefined();
	});

	it("does not name a member who simply never set a name", async () => {
		const written = await seedOrgLesson(nameless, orgId);
		await db().prepare("UPDATE users SET name = NULL WHERE id = ?").bind(nameless).run();

		const page = await readPool(db(), { userId: reader }, {});

		// The distinction this field exists for: unattributed because nobody
		// set a name, versus unattributed because the author is gone.
		expect(page.formerAuthors).not.toContain(written.id);
		expect(page.authors[written.id]).toBeUndefined();
	});

	it("is present and empty for a page with no org rows", async () => {
		const page = await readPool(db(), { userId: reader }, {});
		expect(page.formerAuthors).toEqual([]);
	});
});
```

In `apps/api/src/routes/lessons-browser.test.ts`, one route-level case so the
field is observed at the layer that serializes it — the gap ONL-141 shipped
and had to fix after review:

```ts
	it("serializes former_authors and former_author", async () => {
		// Seed an org lesson by somebody else, then anonymize them by hand -
		// this test is about the serialization, not about deleteUser, so it
		// sets the column directly rather than depending on Task 3.
		const written = await seedOrgLesson(author.id, orgId);
		await db()
			.prepare("UPDATE users SET name = NULL, anonymized_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), author.id)
			.run();

		const page = await call("/api/lessons", reader.token);
		const body = (await page.json()) as {
			former_authors: string[];
			authors: Record<string, string>;
		};
		expect(body.former_authors).toContain(written.id);
		expect(body.authors[written.id]).toBeUndefined();

		const one = await call(`/api/lessons/${written.id}`, reader.token);
		expect(await one.json()).toMatchObject({ former_author: true });
	});
```

This file's fixture names may differ — read its `beforeEach` and use whatever
it calls the org, the reader and the other author, plus its own org-lesson
seeding helper. The point of the test is that **both routes serialize the
field**, which is the layer ONL-141 shipped untested and had to fix after
review, so do not substitute a db-level assertion for the route call.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd apps/api && pnpm exec vitest run pool.test
cd apps/api && pnpm exec vitest run lessons-browser
```

Expected: FAIL — `formerAuthors` is not a property of `LessonPage`.

- [ ] **Step 3: Add the field to `LessonPage`**

In `apps/api/src/db/pool-page.ts`, after `authors`:

```ts
	/**
	 * The org lessons on this page whose author's account has been anonymized.
	 *
	 * A separate list rather than a sentinel in `authors`, for the reason
	 * `authorNames` gives for emitting no key at all when a name is missing:
	 * the server does not invent labels, and a literal like "Former member" in
	 * a name field cannot be told apart from a user who set that as their
	 * actual name. The client renders the words.
	 *
	 * Disjoint from `authors` by construction - an anonymized row has a NULL
	 * name, which produces no `authors` key.
	 */
	formerAuthors: string[];
```

- [ ] **Step 4: Extend `authorNames` to return both**

In `apps/api/src/db/pool.ts`, change `authorNames`'s return type to
`Promise<{ authors: Record<string, string>; formerAuthors: string[] }>` and its
body so the existing `users` lookup also selects `anonymized_at`. **No extra
statement:** the query already reads exactly the rows this needs.

```ts
	if (orgReached.length === 0) return { authors: {}, formerAuthors: [] };

	const ids = [...new Set(orgReached.map((r) => r.userId))];
	const names = new Map<string, string>();
	const departed = new Set<string>();

	for (let at = 0; at < ids.length; at += AUTHOR_LOOKUP_CHUNK) {
		const chunk = ids.slice(at, at + AUTHOR_LOOKUP_CHUNK);
		const { results } = await db
			.prepare(
				`SELECT id, name, anonymized_at FROM users
				 WHERE id IN (${chunk.map(() => "?").join(", ")})`,
			)
			.bind(...chunk)
			.all<{ id: string; name: string | null; anonymized_at: string | null }>();

		for (const row of results ?? []) {
			// A null or empty name produces no key at all. The server does not
			// invent a label for a member who never set one.
			if (row.name) names.set(row.id, row.name);
			if (row.anonymized_at) departed.add(row.id);
		}
	}

	const authors: Record<string, string> = {};
	const formerAuthors: string[] = [];
	for (const row of orgReached) {
		const name = names.get(row.userId);
		if (name) authors[row.lesson.id] = name;
		if (departed.has(row.userId)) formerAuthors.push(row.lesson.id);
	}
	return { authors, formerAuthors };
}
```

Update its caller in `readPool` to destructure both and put `formerAuthors` on
the page.

- [ ] **Step 5: Extend `orgAuthorName`**

Rename it to `orgAuthorFacts` and return both, so no caller has to make two
queries for one row. Its signature becomes:

```ts
export async function orgAuthorFacts(
	db: D1Database,
	readerOrgIds: string[],
	lessonId: string,
): Promise<{ name: string | null; formerAuthor: boolean }> {
	if (readerOrgIds.length === 0) return { name: null, formerAuthor: false };

	const bounded = readerOrgIds.slice(0, MAX_READER_ORGS_BOUND);

	const row = await db
		.prepare(
			`SELECT u.name AS name, u.anonymized_at AS anonymized_at FROM lessons l
			 JOIN users u ON u.id = l.user_id
			 WHERE l.id = ?
			   AND l.visibility = 'org'
			   AND l.org_id IN (${bounded.map(() => "?").join(", ")})`,
		)
		.bind(lessonId, ...bounded)
		.first<{ name: string | null; anonymized_at: string | null }>();

	return { name: row?.name ?? null, formerAuthor: row?.anonymized_at != null };
}
```

Keep the existing doc comment above it — its explanation of why this function
may be called on a row already established as readable still applies — and add
a line saying the rename is because it now answers two facts.

**The rename has five references, not one.** Find them all before you finish:

```bash
grep -rn "orgAuthorName" apps/api/src --include "*.ts"
```

Expected hits: the definition (`pool.ts:486`), the one real caller's import
(`lessons.ts:6`), and **three comments** — `pool.ts:272`, `pool.ts:516`,
`pool.ts:519` — plus one in a different file, `db/orgs.ts:22`, which cites it
by name while explaining why a lesson-shaped lookup cannot be factored into
that module. A rename that updates the code and leaves those is the comment rot
this repo has twice caught in review; update every one.

Update `getLessonForUser` in `db/lessons.ts` to call it and carry
`former_author` beside `author_name`.

- [ ] **Step 6: Serialize both**

In `apps/api/src/routes/lessons-browser.ts`, beside line 82's `authors`:

```ts
			// Always present, even when empty, for the reason owned_ids is.
			former_authors: page.formerAuthors,
```

and beside line 119's `author_name`:

```ts
		former_author: found.former_author,
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd apps/api && pnpm exec vitest run pool.test
cd apps/api && pnpm exec vitest run lessons-browser
```

- [ ] **Step 8: Prove the distinction is real — ablate it**

In `authorNames`, change `if (row.anonymized_at)` to `if (true)`.

```bash
cd apps/api && pnpm exec vitest run pool.test
```

Expected: **"does not name a member who simply never set a name" FAILS.** That
is the test carrying this field's entire purpose; if it passes, the nameless
fixture is not reaching the page. Restore, re-run, confirm PASS.

- [ ] **Step 9: Run the gates**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

- [ ] **Step 10: Commit**

Use `/git-workflow:commit`.

---

## Task 5: The contract and the mock

**Files:**
- Modify: `packages/api-contract/src/index.ts`
- Modify: `apps/web/src/api/mockApi.ts`

**Interfaces:**
- Consumes from Task 4: `former_authors: string[]`, `former_author: boolean`.
- Produces for Task 6: a mock whose shapes the client can rely on.

- [ ] **Step 1: Pin both fields**

The lesson-read cases pin each sidecar with a presence symbol —
`owned_ids: expectArray`, `authors: expectObject`,
`retractable_in: expectObject` — declared at
`packages/api-contract/src/index.ts:33-35`. Add, immediately after each
`retractable_in: expectObject,` in the **pool-read** cases:

```ts
				// Pinned for the same reason `authors` is: the detail pane reads
				// it to decide whether to say an author has left, and an absent
				// key there silently says nothing rather than failing visibly.
				former_authors: expectArray,
```

Find every case that needs it:

```bash
grep -n "retractable_in: expectObject" packages/api-contract/src/index.ts
```

Each hit in a `/api/lessons` **page** case gets `former_authors`. A
single-lesson (`/api/lessons/:id`) case gets `former_author: false` instead —
a literal rather than a symbol, since the fixture's author is not anonymized
and the contract pins the concrete value the way it already pins
`has_more: false`. Report how many of each you found.

- [ ] **Step 2: Teach the mock**

In `apps/web/src/api/mockApi.ts`, find the `/api/lessons` branches that return
`owned_ids` / `authors` / `retractable_in` and add:

- `former_authors: []` on the page response
- `former_author: false` on the single-lesson response

Empty and false rather than fabricated: the mock has no anonymized author, and
inventing one would make the mock disagree with what the real API returns for
the same fixture.

- [ ] **Step 3: Run both suites**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/web test
```

- [ ] **Step 4: Run the gates and commit**

```bash
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/web typecheck
pnpm --filter @onlooker/web lint
bash scripts/source-guards.test.sh
```

Use `/git-workflow:commit`. Stage the contract and the mock together.

---

## Task 6: The browser half and the copy

**Files:**
- Modify: `apps/web/src/api/lessonsApi.ts` (`LessonPage`, `OwnedLesson`)
- Modify: `apps/web/src/pages/LessonsPage.tsx` (hold and merge the new field)
- Modify: `apps/web/src/pages/LessonDetail.tsx` (render it)
- Modify: `apps/web/src/pages/SettingsPage.tsx` (the delete-account copy)
- Test: `apps/web/src/__tests__/lessons-page.test.tsx`,
  `apps/web/src/__tests__/account-routes-in-shell.test.tsx`

**Interfaces:**
- Consumes from Task 5: the two fields, mocked.

- [ ] **Step 1: Add the types**

In `apps/web/src/api/lessonsApi.ts`, beside the existing `authors` and
`retractable_in` declarations: `former_authors: string[]` on the page type and
`former_author: boolean` on the single-lesson type.

- [ ] **Step 2: Carry it on the page**

In `apps/web/src/pages/LessonsPage.tsx`, hold `formerAuthors` beside `authors`,
merge it on "load more" the same way, default it with `?? []` on read, and
expose it on `LessonsContext`. Follow exactly what `authors` does — read those
lines first.

- [ ] **Step 3: Write the failing tests**

In `apps/web/src/__tests__/lessons-page.test.tsx`:

```tsx
	it("says a lesson's author has left", async () => {
		// Same listed/fetched split authorName uses; seed former_authors with
		// the listed lesson's id.
		expect(await screen.findByText(/former member/i)).toBeInTheDocument();
	});

	it("shows no attribution for a member who never set a name", async () => {
		// authors empty, former_authors empty: neither a name nor the label.
		expect(screen.queryByText(/former member/i)).not.toBeInTheDocument();
	});
```

Fill the fixtures from that file's existing patterns for `authors`.

For the copy: **nothing currently asserts it** — `grep -rn "all associated
data" apps/web/src` finds only `SettingsPage.tsx:347` itself. The nearest home
is `apps/web/src/__tests__/account-routes-in-shell.test.tsx`, which already
renders `/settings` inside the shell at its "renders /settings inside the
shell" case (`:106-107`) and already stubs `getProfile`. Add there:

```tsx
	it("says what deleting the account leaves behind", () => {
		renderAppAt("/settings");

		// The old copy promised "all associated data" was deleted, which
		// becomes false the moment an org lesson survives and the row is kept
		// as its anchor. A destructive confirmation that misdescribes what it
		// destroys is worse than a missing one.
		expect(screen.getByText(/stay with that org/i)).toBeInTheDocument();
		expect(screen.queryByText(/all associated data/i)).not.toBeInTheDocument();
	});
```

The second assertion is the one that matters: it fails if the old sentence
survives anywhere in that panel, which a partial edit would leave.

- [ ] **Step 4: Run them to verify they fail**

```bash
cd apps/web && pnpm exec vitest run lessons-page
```

- [ ] **Step 5: Render the label**

In `apps/web/src/pages/LessonDetail.tsx`, derive `formerAuthor` with the same
listed/fetched split `authorName` uses (`:242-246`) and for the same stated
reason, then extend the attribution block at `:569` so it renders the name when
there is one, `Former member` when the author has left, and nothing otherwise.

- [ ] **Step 6: Correct the delete-account copy**

In `apps/web/src/pages/SettingsPage.tsx`, replace

```
Permanently delete your account and all associated data. This cannot be
undone.
```

with

```
Deleting your account cannot be undone. Lessons you shared with an org stay
with that org; everything else goes, and your account can no longer be used.
```

True under both paths without the client needing to know which will run.
Naming which orgs and how many lessons belongs to `onlooker-px7ssn.5`.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd apps/web && pnpm exec vitest run lessons-page
cd apps/web && pnpm exec vitest run settings
```

- [ ] **Step 8: Prove the label is gated — ablate it**

Make the attribution render `Former member` unconditionally when there is no
name.

```bash
cd apps/web && pnpm exec vitest run lessons-page
```

Expected: **"shows no attribution for a member who never set a name" FAILS.**
Restore, re-run, confirm PASS.

- [ ] **Step 9: Run the gates**

```bash
pnpm --filter @onlooker/web test
pnpm --filter @onlooker/web typecheck
pnpm --filter @onlooker/web lint
bash scripts/source-guards.test.sh
```

- [ ] **Step 10: Commit**

Use `/git-workflow:commit`.

---

## Done when

- An org-shared lesson survives its author's account deletion, the org can
  still read it, and the org can still **retract** it — the last one proving
  the author's `lesson_feed` rows were rightly kept.
- A public and a private lesson by the same author are gone.
- A machine token belonging to the anonymized account no longer authenticates,
  with an ablation proving that test can fail.
- A blocked author's block still applies to their surviving org lesson.
- The sole-owner refusal leaves nothing half-dismantled.
- Anonymizing twice changes nothing.
- A lesson pushed between the decision and the write is not cascaded away.
- Attribution tells a departed author from a member who never set a name.
- The delete-account copy is true in both paths.
- All four gates green on `apps/api`, `apps/web` and `packages/db`.
