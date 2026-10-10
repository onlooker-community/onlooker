# Org Retract UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an org owner retract a teammate's org lesson from the browser, through the route that already exists.

**Architecture:** The pool read gains one sidecar — `retractable_in`, mapping lesson id to `{ org_id, org_name }` — populated only for rows that reached the reader through the org disjunct **and** sit in an org where the reader's role is `owner`. The browser renders what it is handed; it makes no authorization judgment of its own. The detail pane grows a second confirm control, gated on not being the lesson's author, whose copy names the org and says the retraction is one-way.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Drizzle ORM, Vitest with `@cloudflare/vitest-pool-workers`, React 19, Biome, pnpm + turbo.

**Source spec:** `docs/superpowers/specs/2026-10-10-org-retract-ui-design.md` — decisions D1 through D7 are approved and not open for re-litigation.
**Linear:** ONL-142. **Bead:** `onlooker-6uivte`. **Base:** `4dff322` on `meagan/onl-142-org-retract-ui`.

---

## Global Constraints

Every task's requirements implicitly include this section. These are not style
preferences — each one is a failure this repository has already paid for.

1. **Four gates, not three.** For every package you touch:
   `pnpm --filter <pkg> test`, `... typecheck`, `... lint`, and
   `bash scripts/source-guards.test.sh`. The fourth is wired into no pnpm
   script — it runs as a bare bash step in `.github/workflows/deploy.yml`, so
   no local sweep reaches it.
2. **A test must be able to observe the condition it names.** For every test
   asserting a guard or a refusal: break the thing it guards, run the test,
   confirm it FAILS, restore, confirm it passes. Report both runs.
   **And when an ablation PASSES, that is information, not a formality
   cleared:** it means either the guard is redundant or the fixture cannot
   reach the state the guard exists for, and those are indistinguishable until
   you check **which branch the fixture actually reaches.** The previous stage
   produced seven such tests, every one an inadequate fixture. Say which you
   think it is rather than adjusting the assertion until it fails.
3. **Touching `@onlooker/api-contract` means running BOTH suites** —
   `apps/api` and `apps/web`. A case added without teaching
   `apps/web/src/api/mockApi.ts` the same field turns the web suite red.
4. **Never judge a suite by a piped command's exit code.** `pnpm test | tail`
   exits with `tail`'s status, and `grep -c` exits non-zero on zero matches.
   Run each suite on its own and read its summary line.
5. **Only `apps/api/src/db/lessons.ts` and `apps/api/src/db/pool.ts` may query
   `lessons` or `lesson_feed`.** `scripts/source-guards.test.sh` enforces it in
   both raw-SQL and drizzle-builder form over every `.ts` under `apps/api/src`
   except `*.test.ts`. Your new org-name query reads `orgs`, which is
   unrestricted — but it lives in `pool.ts` anyway, beside the author-name
   query it mirrors.
6. **Foreign keys are ENFORCED in the test D1.** A test writing a literal
   `org_id` fails the constraint; create real orgs with
   `createOrgWithOwner(db(), "Acme", someUserId)` and use the ids returned.
7. **`role` read out of the database is narrowed with `toOrgRole()`, never a
   bare `as OrgRole`** (`apps/api/src/db/orgs.ts`). Your resolver filters on
   role in SQL and returns ids, so it should not read a role into TypeScript at
   all.
8. **`TEST_PASSWORD` is imported from `test-support/lessons.js`, never
   retyped** — a secret-scanning hook scans the whole replacement text of an
   edit and will block the write.
9. **Edit tracked files with `Edit`/`Write`/`MultiEdit`, never `sed -i` or a
   shell heredoc.** This repo's `lineage` and `inspector` plugins hook
   `PostToolUse` on the file tools only; a shell edit moves the same bytes
   invisibly and `/lineage` then answers "no record" for a line that was
   demonstrably written.
10. **Commit through the `/git-workflow:commit` skill.** If it is not in your
    skill list, mirror its contract: `<type>(<scope>): <subject> :emoji:`,
    subject **≤72 characters including the emoji**, American English, a
    why-focused body wrapped at 80 columns, an emoji reflecting the change's
    mood rather than its type label. Stage intentionally — never `git add -A`.
11. **Commits are SSH-signed through 1Password.** If `git commit` fails with
    `1Password: agent returned an error` / `fatal: failed to write commit
    object`, the agent is locked: stop after two attempts and report it. **Do
    not use `--no-gpg-sign`** — that is the repo owner's call. Do not check
    `op whoami`; it reports "not signed in" even when signing works, because
    the CLI session and the SSH agent are separate things.
12. **Commit as soon as a coherent piece is green.** The previous stage lost
    two agents' entire working state to the machine going to sleep.
13. **American English** in code, comments, docs and commit messages.

## File Structure

**`apps/api/src/db/orgs.ts`** — gains `ownerOrgIdsForUser`, beside
`orgIdsForUser`. Already owns membership and roles.

**`apps/api/src/db/pool.ts`** — gains the `retractable_in` computation and the
org-name lookup, beside the attribution they mirror. Stays the only place a
visibility predicate is constructed.

**`apps/api/src/db/pool-page.ts`** — `LessonPage` gains `retractableIn`.

**`apps/api/src/db/lessons.ts`** — `getLessonForUser` gains the field.

**`apps/api/src/routes/lessons-browser.ts`** — both routes emit it.

**`packages/api-contract/src/index.ts`** — both fields pinned; the retract
route gains its authorized case beside the 401 one ONL-141 left.

**`apps/web/src/api/lessonsApi.ts`** — the two fields and
`retractOrgLesson`.

**`apps/web/src/api/mockApi.ts`** — the fields on both responses. Its retract
branch already exists and already returns `{ id, seq, status }`.

**`apps/web/src/pages/LessonsPage.tsx`** — `retractableIn` state, merge, and
context.

**`apps/web/src/pages/LessonDetail.tsx`** — the second control.

**Deliberately untouched:** `apps/api/src/routes/lessons-public.ts` and
`readPoolLesson`'s signature. The anonymous route shares that function, and its
contract is that no code path may widen what it sees.

---

### Task 1: The owner-org resolver

**Files:**
- Modify: `apps/api/src/db/orgs.ts` (append beside `orgIdsForUser`)
- Test: `apps/api/src/db/orgs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ownerOrgIdsForUser(db: D1Database, userId: string): Promise<string[]>`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/db/orgs.test.ts`, matching the file's existing fixture
idiom — read its `beforeEach` and reuse its `db()` helper rather than adding
your own:

```ts
describe("ownerOrgIdsForUser", () => {
	it("returns the orgs this user owns", async () => {
		const ada = (await createUser(db(), "ada@example.com", "hash", "Ada")).id;
		const a = await createOrgWithOwner(db(), "Acme", ada);
		const b = await createOrgWithOwner(db(), "Beta", ada);

		expect((await ownerOrgIdsForUser(db(), ada)).sort()).toEqual(
			[a.id, b.id].sort(),
		);
	});

	it("omits an org where the user is only a member", async () => {
		// The whole point of this resolver. A member may read the org's
		// lessons; only an owner may retract one.
		const ada = (await createUser(db(), "ada@example.com", "hash", "Ada")).id;
		const bo = (await createUser(db(), "bo@example.com", "hash", "Bo")).id;
		const org = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), org.id, bo, "member");

		expect(await ownerOrgIdsForUser(db(), bo)).toEqual([]);
	});

	it("returns an empty list for a user in no org", async () => {
		const solo = (await createUser(db(), "solo@example.com", "hash", "Mo")).id;

		expect(await ownerOrgIdsForUser(db(), solo)).toEqual([]);
	});

	it("includes an org the user was promoted to owner in", async () => {
		// Role is read at query time, not membership time, so a promotion
		// takes effect without anything else being rewritten.
		const ada = (await createUser(db(), "ada@example.com", "hash", "Ada")).id;
		const bo = (await createUser(db(), "bo@example.com", "hash", "Bo")).id;
		const org = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), org.id, bo, "member");
		await setMemberRole(db(), org.id, bo, "owner");

		expect(await ownerOrgIdsForUser(db(), bo)).toEqual([org.id]);
	});
});
```

`setMemberRole`'s real signature is in `apps/api/src/db/orgs.ts` — confirm the
parameter order before writing that last test rather than assuming it matches
this sketch.

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @onlooker/api test -- orgs.test
```

Expected: FAIL — `ownerOrgIdsForUser is not a function`.

- [ ] **Step 3: Implement**

Append to `apps/api/src/db/orgs.ts`, directly after `orgIdsForUser`:

```ts
/**
 * The ids of the orgs this user OWNS.
 *
 * Separate from `orgIdsForUser` rather than a widening of it, and the
 * separation is the point: that one feeds the visibility predicate, which must
 * stay keyed on membership. A role in that bind path has no business being
 * there, and one function answering both questions is how a later change puts
 * a role where a membership belongs.
 *
 * Filters on role in SQL and returns ids, so no role is ever narrowed into
 * TypeScript here - which is why this does not need `toOrgRole`.
 *
 * Ordered by id so one reader's list is byte-identical between runs.
 */
export async function ownerOrgIdsForUser(
	db: D1Database,
	userId: string,
): Promise<string[]> {
	const rows = await client(db)
		.select({ org_id: org_memberships.org_id })
		.from(org_memberships)
		.where(
			and(
				eq(org_memberships.user_id, userId),
				eq(org_memberships.role, "owner"),
			),
		)
		.orderBy(org_memberships.org_id);

	return rows.map((row) => row.org_id);
}
```

`and` and `eq` are already imported in that file; confirm rather than adding a
duplicate import.

- [ ] **Step 4: Run them and watch them pass**

```bash
pnpm --filter @onlooker/api test -- orgs.test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

- [ ] **Step 5: Prove the member test can fail (REQUIRED)**

Temporarily drop the `eq(org_memberships.role, "owner")` clause. Confirm
"omits an org where the user is only a member" FAILS, returning the org.
Restore, re-run, confirm green. Report both runs with their output.

This is the ablation that matters in this task: the role filter is the entire
difference between "may read" and "may retract".

- [ ] **Step 6: Commit**

---

### Task 2: The `retractable_in` sidecar on the pool read

**Files:**
- Modify: `apps/api/src/db/pool-page.ts` (`LessonPage`)
- Modify: `apps/api/src/db/pool.ts` (`readPool`, plus a new `retractableOrgs` helper)
- Modify: `apps/api/src/routes/lessons-browser.ts` (the browse response)
- Test: `apps/api/src/db/pool.test.ts`, `apps/api/src/routes/lessons-browser.test.ts`

**Interfaces:**
- Consumes: `ownerOrgIdsForUser` (Task 1).
- Produces:
  - `export interface RetractableOrg { org_id: string; org_name: string }` in `pool-page.ts`
  - `LessonPage.retractableIn: Record<string, RetractableOrg>`
  - `GET /api/lessons` emits `retractable_in`

**The laziness is a requirement, not an optimization.** `readPool` already
computes `orgReached` for attribution. The owner query and the name query run
**only** when that set is non-empty, so a private-or-public browse makes
exactly the queries it makes today. Same shape as the push gate's conditional
token-org resolution in `routes/lessons.ts`.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/db/pool.test.ts`, add a describe block. The fixture needs
three accounts because the case that matters most — a member gets nothing —
is only honest when the lesson's author is neither the reader nor the owner:

```ts
describe("retractable_in", () => {
	it("names the org for an owner reading a teammate's org lesson", async () => {
		const owner = (await createUser(db(), "owner@example.com", "hash", "Ona")).id;
		const author = (await createUser(db(), "author@example.com", "hash", "Al")).id;
		const org = await createOrgWithOwner(db(), "Acme", owner);
		await addMembership(db(), org.id, author, "member");
		const shared = await seedFor(author, { visibility: "org" }, org.id);

		const page = await readPool(db(), { userId: owner }, { limit: 50 }, async () => [
			org.id,
		]);

		expect(page.retractableIn).toEqual({
			[shared.id]: { org_id: org.id, org_name: "Acme" },
		});
	});

	// THE case this feature turns on. A member may read the lesson and must
	// not be offered a control the API would refuse.
	it("gives a MEMBER of the same org nothing", async () => {
		const owner = (await createUser(db(), "owner@example.com", "hash", "Ona")).id;
		const member = (await createUser(db(), "member@example.com", "hash", "Mem")).id;
		const author = (await createUser(db(), "author@example.com", "hash", "Al")).id;
		const org = await createOrgWithOwner(db(), "Acme", owner);
		await addMembership(db(), org.id, member, "member");
		await addMembership(db(), org.id, author, "member");
		const shared = await seedFor(author, { visibility: "org" }, org.id);

		const page = await readPool(db(), { userId: member }, { limit: 50 }, async () => [
			org.id,
		]);

		// They can read it...
		expect(idsIn(page)).toEqual([shared.id]);
		// ...and may not retract it.
		expect(page.retractableIn).toEqual({});
	});

	it("gives nothing for the reader's OWN lesson in an org they own", async () => {
		// D6: the author's bidirectional control answers for this, and two
		// controls on one lesson is worse than one.
		const owner = (await createUser(db(), "owner@example.com", "hash", "Ona")).id;
		const org = await createOrgWithOwner(db(), "Acme", owner);
		const own = await seedFor(owner, { visibility: "org" }, org.id);

		const page = await readPool(db(), { userId: owner }, { limit: 50 }, async () => [
			org.id,
		]);

		expect(idsIn(page)).toEqual([own.id]);
		expect(page.retractableIn).toEqual({});
	});

	it("gives nothing for a public lesson, whatever the reader owns", async () => {
		const owner = (await createUser(db(), "owner@example.com", "hash", "Ona")).id;
		const author = (await createUser(db(), "author@example.com", "hash", "Al")).id;
		const org = await createOrgWithOwner(db(), "Acme", owner);
		await seedFor(author, { visibility: "public" });

		const page = await readPool(db(), { userId: owner }, { limit: 50 }, async () => [
			org.id,
		]);

		expect(page.retractableIn).toEqual({});
	});

	it("is always present, even with nothing to retract", async () => {
		// Same rule as owned_ids and authors: a client must not have to tell
		// "nothing is retractable" from "this server does not say".
		const page = await readPool(db(), { userId: mine }, { limit: 50 });

		expect(page.retractableIn).toEqual({});
	});
});
```

Reuse the suite's existing `seedFor` and `idsIn` helpers and its `mine`
fixture. `seedFor(owner, overrides, orgId)` already takes the org as its third
parameter.

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @onlooker/api test -- pool
```

Expected: FAIL — `page.retractableIn` is `undefined`.

- [ ] **Step 3: Add the field to the page shape**

In `apps/api/src/db/pool-page.ts`, above `LessonPage`:

```ts
/**
 * An org a reader may retract a lesson in, named so the browser can say which.
 *
 * The name rides along rather than being resolved client-side, which is a
 * deliberate departure from `MachineTokenSummary.org_id`. That one carries an
 * id alone because the page rendering it already lists the account's orgs to
 * build a picker; the lessons page lists no orgs and has no other reason to,
 * so making it fetch the whole list to render one label would be worse than
 * sending eleven more bytes.
 */
export interface RetractableOrg {
	org_id: string;
	org_name: string;
}
```

and inside `LessonPage`:

```ts
	/**
	 * The lessons on this page the reader may retract at org level, by lesson
	 * id, each naming the org that grants it.
	 *
	 * Carried beside the documents for the reason `ownedIds` is, and populated
	 * by the same principle: the server decides what the caller may act on and
	 * the browser renders it. A key appears only when the row reached this
	 * reader through the ORG disjunct and the reader's role in that org is
	 * `owner`.
	 *
	 * Absent for the reader's own lesson even in an org they own - the
	 * author's own bidirectional control answers for that one, and the org
	 * retract is one-way.
	 *
	 * Always present, empty for an anonymous caller and for any page with no
	 * org rows on it.
	 */
	retractableIn: Record<string, RetractableOrg>;
```

- [ ] **Step 4: Compute it in `readPool`**

In `apps/api/src/db/pool.ts`, import `ownerOrgIdsForUser` from `./orgs.js`
alongside the existing import, and add a chunk constant beside
`AUTHOR_LOOKUP_CHUNK`:

```ts
/**
 * How many org ids the name lookup binds per statement. Same value and same
 * reason as AUTHOR_LOOKUP_CHUNK: D1 caps bound parameters at 100, and while a
 * reader's org count will not approach that, the two lookups should not
 * disagree about the bound they respect.
 */
const ORG_NAME_LOOKUP_CHUNK = 50;
```

Immediately after the `const authors = await authorNames(db, orgReached);`
line, add:

```ts
	// Lazy on purpose: `orgReached` being empty is the common case - every
	// anonymous read and most authenticated ones - and neither query below
	// runs for it. So an ordinary private-or-public browse makes exactly the
	// queries it made before this field existed. Same shape as the push
	// gate's conditional token-org resolution in routes/lessons.ts, for the
	// same reason: do not charge every request for what a minority needs.
	const retractableIn =
		orgReached.length === 0 || principal === null
			? {}
			: await retractableOrgs(
					db,
					orgReached,
					principal.userId,
					await ownerOrgIdsForUser(db, principal.userId),
			  );
```

and return `retractableIn` in the object alongside `authors`.

Note the `principal === null` arm: `orgReached` is already empty for an
anonymous caller, because `resolveOrgIds` returns `[]` without a principal and
the predicate then never builds the org disjunct. The check is there so a
reader of this line does not have to follow that chain to know an anonymous
request resolves no owner list.

Then add the helper below `authorNames`:

```ts
/**
 * Which of a page's org-reached rows the reader may retract, with the org
 * named.
 *
 * A second statement rather than a join, for the reason `authorNames` gives:
 * a join in the pool read would change the plan
 * `pool-query-plan.test.ts` pins, for a lookup most pages do not need.
 *
 * `ownerOrgIds` is the reader's OWNED orgs, so membership alone yields no
 * entry. The author check is what implements D6 - a reader's own lesson is
 * answered by their own control, and offering both would be worse than one.
 */
async function retractableOrgs(
	db: D1Database,
	orgReached: Array<{
		lesson: { id: string };
		userId: string;
		orgId: string | null;
	}>,
	readerUserId: string,
	ownerOrgIds: string[],
): Promise<Record<string, RetractableOrg>> {
	const bounded = ownerOrgIds.slice(0, MAX_READER_ORGS_BOUND);
	if (bounded.length === 0) return {};

	// D6 applied before the name lookup, so a page of only the reader's own
	// org lessons costs no second statement either.
	const theirs = orgReached.filter(
		(r) =>
			r.userId !== readerUserId &&
			r.orgId !== null &&
			bounded.includes(r.orgId),
	);
	if (theirs.length === 0) return {};

	const ids = [...new Set(theirs.map((r) => r.orgId as string))];
	const names = new Map<string, string>();
	for (let at = 0; at < ids.length; at += ORG_NAME_LOOKUP_CHUNK) {
		const chunk = ids.slice(at, at + ORG_NAME_LOOKUP_CHUNK);
		const { results } = await db
			.prepare(
				`SELECT id, name FROM orgs
				 WHERE id IN (${chunk.map(() => "?").join(", ")})`,
			)
			.bind(...chunk)
			.all<{ id: string; name: string }>();
		for (const row of results ?? []) names.set(row.id, row.name);
	}

	const retractable: Record<string, RetractableOrg> = {};
	for (const row of theirs) {
		const orgId = row.orgId as string;
		const name = names.get(orgId);
		// No name means the org row is gone from under a lesson that still
		// points at it, which the FK's ON DELETE SET NULL should prevent. No
		// key rather than a guessed label, the same way a nameless author
		// produces no attribution.
		if (name) retractable[row.lesson.id] = { org_id: orgId, org_name: name };
	}
	return retractable;
}
```

Pass `principal.userId` as `readerUserId` from `readPool` — the call in Step 4
above shows the argument order.

- [ ] **Step 5: Emit it from the browse route**

In `apps/api/src/routes/lessons-browser.ts`, in the browse response beside
`authors`:

```ts
			// Always present, even when empty, for the reason owned_ids is.
			retractable_in: page.retractableIn,
```

- [ ] **Step 6: Add the route-level test**

In `apps/api/src/routes/lessons-browser.test.ts`, one case through the real
route, because the sidecar crossing the HTTP boundary is a separate fact from
`readPool` computing it. Build the fixture with the suite's existing helpers
and assert `retractable_in` carries the org id and name for a teammate's
lesson. Clear `org_memberships` and `orgs` in the suite's reset if it does not
already.

- [ ] **Step 7: Run the gates**

```bash
pnpm --filter @onlooker/api test -- pool
pnpm --filter @onlooker/api test -- lessons-browser
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

- [ ] **Step 8: Prove the member test can fail (REQUIRED)**

Temporarily pass the reader's full org list where `ownerOrgIdsForUser`'s result
goes — that is, call `orgIdsForUser` instead. Confirm "gives a MEMBER of the
same org nothing" FAILS with an entry. Restore, re-run, report both runs.

Then a second ablation, because the first does not cover D6: temporarily drop
the author check. Confirm "gives nothing for the reader's OWN lesson in an org
they own" FAILS. Restore, re-run, report.

- [ ] **Step 9: Confirm the laziness, and say how (REQUIRED)**

D3 is a claim about queries not run, which no assertion above observes. Add a
test that proves it rather than trusting it: hand `readPool` a recording D1
stand-in — `pool-query-plan.test.ts` has one you can model on — and assert that
a private-only page prepares no statement against `orgs` or `org_memberships`.
If that proves impractical with the recorder's shape, say so in your report
and state what you did instead; do not quietly skip it.

- [ ] **Step 10: Commit**

---

### Task 3: The single-lesson `retractable_in`

**Files:**
- Modify: `apps/api/src/db/lessons.ts` (`getLessonForUser`)
- Modify: `apps/api/src/db/pool.ts` (a new `orgRetractableFor`)
- Modify: `apps/api/src/routes/lessons-browser.ts` (`handleGetLesson`)
- Test: `apps/api/src/db/pool.test.ts`

**Interfaces:**
- Consumes: `ownerOrgIdsForUser` (Task 1), `RetractableOrg` (Task 2).
- Produces: `getLessonForUser` returns `{ lesson, own, author_name, retractable_in }` where `retractable_in: RetractableOrg | null`.

**Why this is its own task and its own function.** The deep-linked lesson is on
no loaded page, so the sidecar cannot answer for it — exactly the split
`author_name` already has, and the split that shipped untested in ONL-141 and
had to be fixed after review. `readPoolLesson` stays untouched: the anonymous
public route shares it.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/db/pool.test.ts`, inside the `getLessonForUser` describe block
that already exists:

```ts
	it("names the org for an owner reading a teammate's org lesson", async () => {
		const owner = (await createUser(db(), "o2@example.com", "hash", "Ona")).id;
		const author = (await createUser(db(), "a2@example.com", "hash", "Al")).id;
		const org = await createOrgWithOwner(db(), "Acme Two", owner);
		await addMembership(db(), org.id, author, "member");
		const shared = await seedFor(author, { visibility: "org" }, org.id);

		const found = await getLessonForUser(db(), owner, shared.id);

		expect(found?.retractable_in).toEqual({
			org_id: org.id,
			org_name: "Acme Two",
		});
	});

	it("answers null for a member of the same org", async () => {
		const owner = (await createUser(db(), "o3@example.com", "hash", "Ona")).id;
		const member = (await createUser(db(), "m3@example.com", "hash", "Mem")).id;
		const author = (await createUser(db(), "a3@example.com", "hash", "Al")).id;
		const org = await createOrgWithOwner(db(), "Acme Three", owner);
		await addMembership(db(), org.id, member, "member");
		await addMembership(db(), org.id, author, "member");
		const shared = await seedFor(author, { visibility: "org" }, org.id);

		const found = await getLessonForUser(db(), member, shared.id);

		expect(found).not.toBeNull();
		expect(found?.retractable_in).toBeNull();
	});

	it("answers null for the reader's own lesson in an org they own", async () => {
		const owner = (await createUser(db(), "o4@example.com", "hash", "Ona")).id;
		const org = await createOrgWithOwner(db(), "Acme Four", owner);
		const own = await seedFor(owner, { visibility: "org" }, org.id);

		expect((await getLessonForUser(db(), owner, own.id))?.retractable_in).toBeNull();
	});

	it("answers null for a public lesson", async () => {
		const owner = (await createUser(db(), "o5@example.com", "hash", "Ona")).id;
		await createOrgWithOwner(db(), "Acme Five", owner);
		const pub = await seedFor(theirs, { visibility: "public" });

		expect((await getLessonForUser(db(), owner, pub.id))?.retractable_in).toBeNull();
	});
```

- [ ] **Step 2: Run them, watch them fail, then implement**

```bash
pnpm --filter @onlooker/api test -- pool
```

Add to `apps/api/src/db/pool.ts`, below `orgAuthorName`:

```ts
/**
 * The org a reader may retract ONE lesson in, or null.
 *
 * The by-id twin of `retractableOrgs`, and separate for the reason
 * `orgAuthorName` is separate from the `authors` sidecar: a deep-linked lesson
 * is on no loaded page, so the page-shaped answer cannot speak for it.
 *
 * NOT an authorization check, and the same caveat `orgAuthorName` carries
 * applies: this WHERE omits the retracted-and-blocked-author boundary that
 * `visibilityPredicate` applies, so the only reason it cannot be used to probe
 * an arbitrary lesson id is that its caller - `getLessonForUser` - has already
 * returned null for a row the reader may not read. Do not call it anywhere
 * that has not established readability first.
 *
 * The boundary is deliberately not duplicated here: `visibilityPredicate` is
 * the only place a visibility predicate is constructed.
 */
export async function orgRetractableFor(
	db: D1Database,
	readerUserId: string,
	ownerOrgIds: string[],
	lessonId: string,
): Promise<RetractableOrg | null> {
	const bounded = ownerOrgIds.slice(0, MAX_READER_ORGS_BOUND);
	if (bounded.length === 0) return null;

	const row = await db
		.prepare(
			`SELECT o.id AS org_id, o.name AS org_name FROM lessons l
			 JOIN orgs o ON o.id = l.org_id
			 WHERE l.id = ?
			   AND l.visibility = 'org'
			   AND l.user_id != ?
			   AND l.org_id IN (${bounded.map(() => "?").join(", ")})`,
		)
		.bind(lessonId, readerUserId, ...bounded)
		.first<{ org_id: string; org_name: string }>();

	return row ? { org_id: row.org_id, org_name: row.org_name } : null;
}
```

The `l.user_id != ?` clause is D6 in SQL: the author's own control answers for
their own lesson.

Then in `getLessonForUser`, widen the return type and resolve it from the same
owner list:

```ts
	// From the reader's OWNED orgs, resolved here rather than inside
	// orgRetractableFor so the two org lists this function depends on - the
	// membership list the predicate used and the owner list this uses - are
	// both visible in one place.
	const retractable_in = await orgRetractableFor(
		db,
		userId,
		await ownerOrgIdsForUser(db, userId),
		id,
	);

	return { lesson, own: owned !== null, author_name, retractable_in };
```

Import `ownerOrgIdsForUser` and `orgRetractableFor`, and `RetractableOrg` as a
type.

- [ ] **Step 3: Emit it from the route**

In `handleGetLesson` (`apps/api/src/routes/lessons-browser.ts`):

```ts
	return Response.json({
		lesson: found.lesson,
		own: found.own,
		author_name: found.author_name,
		retractable_in: found.retractable_in,
	});
```

- [ ] **Step 4: Run the gates**

```bash
pnpm --filter @onlooker/api test -- pool
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

- [ ] **Step 5: Prove two of these can fail (REQUIRED)**

First: drop `AND l.user_id != ?` (and its bind). Confirm "answers null for the
reader's own lesson in an org they own" FAILS. Restore.

Second: pass `orgIdsForUser`'s result instead of `ownerOrgIdsForUser`'s.
Confirm "answers null for a member of the same org" FAILS. Restore.

Report all four runs. Watch for the trap: if either passes under its ablation,
check which branch the fixture reaches before changing the assertion.

- [ ] **Step 6: Commit**

---

### Task 4: Contract and mock

**Files:**
- Modify: `packages/api-contract/src/index.ts`
- Modify: `apps/web/src/api/mockApi.ts`
- Test: both suites

**Interfaces:**
- Consumes: the two response fields (Tasks 2 and 3).
- Produces: `retractable_in` pinned on the lesson-pool cases and the
  single-lesson case; the mock answering with it.

**This task is where the previous stage went red.** A field pinned in the
contract that one implementation does not send turns the other suite's run into
a failure with a confusing message. Land both halves together and run both
suites.

- [ ] **Step 1: Pin the fields**

In `packages/api-contract/src/index.ts`, add `retractable_in: expectObject` to
each lesson-pool case that already pins `authors` — there are three; find them
by searching for `authors: expectObject` rather than trusting a line number.
Give each the same one-line reason the neighboring comments carry: the detail
pane reads it to decide whether to offer a control, and an absent key silently
offers nothing rather than failing visibly.

`expectObject` is exported from that file. For the single-lesson case, note
that `retractable_in` is `null` in the contract's own fixture — the contract
account owns its lessons — so pin it only if the file's matcher vocabulary can
express "present and null"; if it cannot, say so in your report rather than
pinning something weaker that reads as stronger.

- [ ] **Step 2: Add the authorized retract case**

ONL-141 left a 401 case for `POST /api/orgs/:id/lessons/:lessonId/retract`
(search for `with no credential`). The browser now calls this route for real,
so it needs the authorized shape too: `{ id, seq, status }`, matching
`handleRetractOrgLesson` in `apps/api/src/routes/orgs-lessons.ts`. Read that
handler rather than trusting this sketch.

- [ ] **Step 3: Teach the mock**

In `apps/web/src/api/mockApi.ts`:

- the lesson-pool response gains `retractable_in: {}` beside `authors: {}`
- the single-lesson response gains `retractable_in: null`
- its retract branch already exists and already returns
  `{ id, seq, status: "retracted" }` — leave it alone

The mock's pool is permanently empty by an explicit design comment in that
file, so `{}` is the honest value and no seeded lesson is wanted. Do not
contradict that comment.

- [ ] **Step 4: Run BOTH suites**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/web test
pnpm --filter @onlooker/api-contract test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/web typecheck
pnpm --filter @onlooker/api lint
pnpm --filter @onlooker/web lint
bash scripts/source-guards.test.sh
```

Each on its own. Read every summary line.

- [ ] **Step 5: Commit**

---

### Task 5: The web client and page state

**Files:**
- Modify: `apps/web/src/api/lessonsApi.ts`
- Modify: `apps/web/src/pages/LessonsPage.tsx`
- Test: `apps/web/src/__tests__/lessons-page.test.tsx`

**Interfaces:**
- Consumes: the API fields (Tasks 2–4).
- Produces:
  - `RetractableOrg` and the two fields in `lessonsApi.ts`
  - `retractOrgLesson(orgId: string, lessonId: string): Promise<{ id: string; seq: number; status: string }>`
  - `LessonsContext.retractableIn: Record<string, RetractableOrg>`

- [ ] **Step 1: Write the failing test**

The merge on "load more" is the thing worth pinning, because a wrong merge
attaches one org's authority to another lesson. ONL-141's equivalent test for
`authors` is in this file under "paging past the first page" — model on it, and
assert a first page's `retractableIn` entry survives a second page load.

- [ ] **Step 2: Extend the client**

In `apps/web/src/api/lessonsApi.ts`:

```ts
/**
 * An org the signed-in account may retract a lesson in.
 *
 * Mirrors `RetractableOrg` in apps/api's pool-page.ts. The name is sent rather
 * than resolved here because this page lists no orgs of its own.
 */
export interface RetractableOrg {
	org_id: string;
	org_name: string;
}
```

Add `retractable_in: Record<string, RetractableOrg>` to `LessonPage` and
`retractable_in: RetractableOrg | null` to `OwnedLesson`, each with a comment
giving the reason in brief: the server decides what the caller may act on, and
a key appears only for a teammate's org lesson in an org the caller owns.

Then:

```ts
/**
 * Retract a lesson at org level, on the authority of owning the org it was
 * shared with.
 *
 * A different endpoint from `setLessonStatus`, deliberately: that one is
 * owner-scoped by `WHERE id = ? AND user_id = ?` and can only ever move the
 * caller's own lesson. This one is one-way - there is no org-level route back
 * to active - and the UI says so before it is used.
 */
export function retractOrgLesson(
	orgId: string,
	lessonId: string,
): Promise<{ id: string; seq: number; status: string }> {
	return apiClient.post<{ id: string; seq: number; status: string }>(
		`/api/orgs/${encodeURIComponent(orgId)}/lessons/${encodeURIComponent(lessonId)}/retract`,
		{},
	);
}
```

Confirm `apiClient.post`'s signature before writing that call, and whether this
file routes org paths through a constant the way `LESSON_ENDPOINTS` works.

- [ ] **Step 3: Hold it on the page**

In `apps/web/src/pages/LessonsPage.tsx`, mirror `authors` exactly — there are
four sites, and missing one is how a stale entry survives a filter change:

- `const [retractableIn, setRetractableIn] = useState<Record<string, RetractableOrg>>({});`
- in the first-page load: `setRetractableIn(page.retractable_in ?? {});`
- in the reset path beside `setAuthors({})`
- in `loadMore`: `setRetractableIn((current) => ({ ...current, ...(page.retractable_in ?? {}) }));`
- on the context object, and on the `LessonsContext` interface with a doc
  comment

The `?? {}` is not defensive padding — the comment already beside `authors`
explains why an older API still rolling out can answer without the key.

- [ ] **Step 4: Run the gates and commit**

```bash
pnpm --filter @onlooker/web test
pnpm --filter @onlooker/web typecheck
pnpm --filter @onlooker/web lint
bash scripts/source-guards.test.sh
```

---

### Task 6: The control

**Files:**
- Modify: `apps/web/src/pages/LessonDetail.tsx`
- Test: `apps/web/src/__tests__/lessons-page.test.tsx`

**Interfaces:**
- Consumes: `LessonsContext.retractableIn`, `OwnedLesson.retractable_in`, `retractOrgLesson` (Task 5).
- Produces: no new API.

- [ ] **Step 1: Write the failing tests**

Four cases, in the detail-pane block:

1. An owner viewing a teammate's org lesson sees a control naming the org.
2. A **member** of the same org sees none. Its fixture needs
   `retractable_in: {}` from the mocked module while the lesson is still
   readable — otherwise it passes because nothing rendered at all.
3. The reader's own org lesson shows the ordinary author control and not this
   one, asserted by the absence of the org-naming label rather than by the
   presence of the other.
4. A successful retract patches the row: the status reads retracted without a
   refetch.

Both paths need covering — the listed lesson and the deep-fetched one — because
that split is exactly what shipped untested in ONL-141.

- [ ] **Step 2: Derive it in the component**

Beside the existing `authorName` derivation in
`apps/web/src/pages/LessonDetail.tsx`:

```ts
	/**
	 * The org this viewer may retract this lesson in, or null.
	 *
	 * Same listed/fetched split as `authorName` and for the same reason: the
	 * sidecar cannot answer for a deep-linked lesson that is on no loaded
	 * page, and a filter refetch can empty it while this pane still shows a
	 * lesson out of `fetched`.
	 */
	const retractableIn: RetractableOrg | null = listed
		? (retractableIn_[listed.id] ?? null)
		: fetched?.id === id
			? fetchedRetractableIn
			: null;
```

Name the context value and the local distinctly — do not shadow. Add
`fetchedRetractableIn` state set from the same `getLesson` response that sets
`fetched`, exactly as `fetchedAuthorName` is, so the two cannot describe
different lessons.

- [ ] **Step 3: Render it**

A second `ConfirmAction`, rendered only when
`!own && retractableIn && lesson.status !== "retracted"`. The status term
matters: it is tempting to gate this the way the author's own pair is gated,
on `status === "active"`, reasoning that the org control should not be more
permissive than the author's. That reasoning is wrong - the author's pair
offers nothing for `refuted` or `superseded` because its `next` is a
two-state toggle with nothing left to toggle there, not because retraction is
inappropriate for those statuses, and withholding the org control for
`refuted` too would leave an owner's only route for it "ask the platform
operator," the exact outcome D6 exists to prevent. `!== "retracted"` is
withheld only once the lesson is already retracted, since there is no
org-level route back to active and a second click would "succeed" again,
appending another feed row while appearing to have done nothing new. Its copy
carries D5:

```tsx
					<ConfirmAction
						trigger={`Retract for ${retractableIn.org_name}`}
						question={`This lesson is not yours. Retracting it stops ${retractableIn.org_name} from reading it, and only its author can make it active again — you cannot undo this.`}
						confirmLabel="Yes, retract for the org"
						variant="danger"
						pending={orgPending}
						resetToken={`${id}:${settleCount}`}
						onConfirm={() => void retractForOrg(retractableIn.org_id)}
					/>
```

Hold its pending state separately from the author control's `pending` — they
are different requests and one must not disable the other's spinner. On
success, `patchLesson(target, "retracted")` and update `fetched`, exactly as
`transition` does. Capture `id` into a local up front for the same reason
`transition` does, and gate the error write on `currentId.current === target`.

Errors reuse the existing `actionError` shape: a 404 is not retryable, and a
503 whose `code` is `sequence_contention` is — read it off `code`, not the
message, as `transition` already does.

- [ ] **Step 4: Run the gates**

```bash
pnpm --filter @onlooker/web test
pnpm --filter @onlooker/web typecheck
pnpm --filter @onlooker/web lint
bash scripts/source-guards.test.sh
```

- [ ] **Step 5: Prove the member case can fail (REQUIRED)**

Render the control on `retractableIn` alone, dropping `!own`. Confirm case 3
FAILS. Restore. Then render it unconditionally and confirm case 2 FAILS.
Restore, re-run, report all four runs.

- [ ] **Step 6: Commit**

---

## Self-Review

**Spec coverage.** D1 → Tasks 2, 3. D2 → the `RetractableOrg` shape in Task 2,
carried through 5. D3 → Task 2 Steps 4 and 9. D4 → Task 1. D5 → Task 6 Step 3.
D6 → the author check in Tasks 2 and 3, and the `!own` gate in Task 6. D7 →
Task 6 renders in the detail pane only; no list-row change appears anywhere.
The spec's Tests section maps onto the ablations in Tasks 1, 2, 3 and 6, and
its Errors section onto Task 6 Step 3.

**Two defects this review caught and fixed, rather than leaving for an
implementer.** `retractableOrgs` called a `readerId(orgReached)` helper that
cannot exist — `orgReached` carries no reader id — and the first draft of this
plan left it in place with a note explaining the problem. That was the wrong
instinct: a plan that hands over a known-broken line is asking someone else to
do work it could have done, and invites them to fix it differently than
intended. It now takes `readerUserId` as a parameter, applies D6 before the
name lookup so a page of only the reader's own org lessons costs no second
statement, and the call site passes `principal.userId`. Task 6's Files block
also had a mangled path, now corrected.

**Type consistency.** `RetractableOrg` is the type name in `pool-page.ts`,
`lessonsApi.ts`, and every task that touches either. `retractableIn` is the
TypeScript field on `LessonPage` and `LessonsContext`; `retractable_in` is the
wire name on both responses and on `OwnedLesson` — that split follows
`ownedIds`/`owned_ids` and `authors`, which this codebase already does.
`ownerOrgIdsForUser` is the resolver everywhere. `orgRetractableFor` is the
by-id function; `retractableOrgs` is the page-shaped one.

**Gaps I am naming rather than leaving implicit.** Nothing verifies the
control against a real org on production, for the reason the spec's Deferred
section gives: the only production org has one member, and seeding a second
needs a readable mailbox. And no test covers two orgs where the reader owns one
and is a member of the other — the bound makes that safe and the per-row
`bounded.includes(orgId)` check makes it correct, but it is untested. Add it to
Task 2 if it is cheap once the fixture exists.
