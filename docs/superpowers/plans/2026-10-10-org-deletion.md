# Deleting an Empty Org Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner who is the only member of an org delete it, which is the
only way out of the dead end PR #198 created — account deletion refuses while
you are the sole owner of any org, and that owner has nobody to promote.

**Architecture:** One new `DELETE /api/orgs/:id`, owner-only, whose
sole-member guard lives inside the `DELETE`'s own `WHERE` clause so it cannot
be raced by an invitee accepting. The route touches no lesson data: four
foreign keys already decide what happens to an org's contents. The browser
half is a gated `ConfirmAction` on the org's existing panel.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Drizzle ORM, Hono-less custom
router, Vitest with `@cloudflare/vitest-pool-workers`, React 19, Biome, pnpm +
turbo monorepo.

Spec: `docs/superpowers/specs/2026-10-10-org-deletion-design.md` (read the
decisions D1–D6 if a step's reasoning is unclear; do not re-litigate them).

## Global Constraints

- **Deletion is permitted only when the caller is the org's sole member.** Any
  other member present means refusal. (D1)
- **The guard goes inside the `DELETE`'s own `WHERE` clause**, with the org id
  bound twice. A count-then-delete is wrong and will be rejected in review:
  an invitee accepting between the read and the write would otherwise destroy
  an org somebody just joined. (D2)
- **Success is `200 { deleted: "<org id>" }`.** Not 204, not
  `{ success: true }` — `handleRemoveMember` answers `{ removed: ... }` and
  `handleRevokeInvite` answers `{ revoked: ... }`.
- **Refusal is `409 has_members` with `details: { member_count }`** and no
  member names. (D3)
- **Everything else is `requireOrgRole`'s own `404 not_found`**, unchanged. (D4)
- **The route must contain no query against `lessons`, `lesson_feed`, or
  `machine_tokens`.** `scripts/source-guards.test.sh` enforces the first two.
- **The browser control is gated**, rendering only when `org.role === "owner"`
  and the loaded member list has exactly one entry. (D5)
- **Exact confirm copy** (D6), used verbatim in Task 4:
  - trigger: `` `Delete ${org.name}` ``
  - question: `` `Deleting ${org.name} is permanent. Lessons you shared with it stay readable by you and by nobody else, and any pending invitations are canceled.` ``
  - confirmLabel: `Yes, delete this org`
  - pendingLabel: `Deleting...`
- **American English** everywhere, including comments and copy.
- **Commits route through `/git-workflow:commit`.** If that skill is not in
  your list, mirror its contract: `<type>(<scope>): <subject> :emoji:`, a
  why-focused body, American English. Never `git commit -m` ad hoc.
- **Never `--no-gpg-sign`.** Signing is configured; a signing failure is for
  the repo owner to resolve.

### Running tests — read this before your first test run

`pnpm --filter <pkg> test -- <name>` **does not filter.** The forwarded `--`
breaks vitest's matcher, so it silently runs the whole suite (ONL-144). To run
one file, run vitest from inside the package:

```bash
cd apps/api && pnpm exec vitest run orgs.test
cd apps/web && pnpm exec vitest run orgs-page
```

Whole-suite runs are the `pnpm --filter` form with no extra arguments:

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/web test
```

**A fresh worktree must run `pnpm build` first**, or all 48 `apps/api` test
files fail to collect on `@onlooker-community/lesson-contract`'s missing entry,
and a stale `packages/db/dist` makes `orgs` import as `undefined`. This
worktree has already been built; run `pnpm build` again only if you see either
symptom.

### The four gates, run before every commit that touches code

1. `pnpm --filter <pkg> test`
2. `pnpm --filter <pkg> typecheck`
3. `pnpm --filter <pkg> lint`
4. `bash scripts/source-guards.test.sh`

The fourth is wired into no pnpm script and runs as a bare bash step in
`.github/workflows/deploy.yml`. **Touching `packages/api-contract` means
running both the `apps/api` and `apps/web` suites.**

`apps/api`'s lint reports **3 pre-existing warnings** — two
`useOptionalChain` in `src/middleware/auth.ts` and one
`noTemplateCurlyInString` in `src/monitoring.test.ts`. They are not yours;
leave them. Any fourth warning is.

### Fixture hygiene

`apps/api/src/db/orgs.test.ts` and
`apps/api/src/routes/account-deletion.test.ts` both create `ada@example.com`
and `bob@example.com` in `beforeEach`. **Do not create a user with either
address in a new test** — `users.email` is UNIQUE and the insert will fail.
Use a fresh address such as `cleo@example.com`.

`resetOrgTables()` deliberately does **not** clear `lessons` or `lesson_feed`.
A test that seeds a lesson clears them itself:

```ts
await db().prepare("DELETE FROM lesson_feed").run();
await db().prepare("DELETE FROM lessons").run();
resetLessonCounter();
```

---

## File Structure

**Create:**
- `docs/superpowers/plans/2026-10-10-org-deletion.md` — this file.

**Modify:**
- `apps/api/src/db/orgs.ts` — add `countMembers` and `deleteOrg` at the end,
  after `soleOwnedOrgs`. Responsibility unchanged: membership and role
  questions.
- `apps/api/src/db/orgs.test.ts` — add a `describe("deleteOrg")` block.
- `apps/api/src/routes/orgs.ts` — add `handleDeleteOrg` after
  `handleRenameOrg`. Responsibility unchanged: the org itself.
- `apps/api/src/router.ts` — one route entry after `PATCH /api/orgs/:id`.
- `apps/api/src/routes/orgs-authorization.test.ts` — one `REQUIRED_ROLE` entry.
- `apps/api/src/routes/account-deletion.test.ts` — the end-to-end acceptance
  test, which belongs here because its claim is about account deletion
  becoming possible.
- `packages/api-contract/src/index.ts` — one `ORG_LIFECYCLE` case.
- `apps/web/src/api/mockApi.ts` — one DELETE branch beside the PATCH branch.
- `apps/web/src/api/orgsApi.ts` — add `deleteOrg` after `renameOrg`.
- `apps/web/src/pages/OrgsPage.tsx` — the gated control inside `OrgSection`.
- `apps/web/src/__tests__/orgs-page.test.tsx` — add `deleteOrg` to the mock
  factory, then three cases.

No new files. Every change lands beside its closest sibling, which is also how
a reviewer will find it.

---

## Task 1: `countMembers` and `deleteOrg`

**Files:**
- Modify: `apps/api/src/db/orgs.ts` (append after `soleOwnedOrgs`, which ends
  at the file's last line)
- Test: `apps/api/src/db/orgs.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. Uses the existing `client`, `and`,
  `eq`, `sql`, `org_memberships` imports already at the top of `orgs.ts`.
- Produces, for Task 2:
  - `export type OrgDeleteResult = "ok" | "has_members" | "not_found"`
  - `export async function countMembers(db: D1Database, orgId: string): Promise<number>`
  - `export async function deleteOrg(db: D1Database, orgId: string, userId: string): Promise<OrgDeleteResult>`

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/db/orgs.test.ts`. Three import changes first:

- extend the existing import from `./orgs.js` with `countMembers`, `deleteOrg`
  and `getOrgName` (used to assert the org is gone), keeping the list
  alphabetical as it already is;
- extend the existing `./org-invites.js` import with `listPendingInvites`
  (`createInvite` is already imported);
- add `hashToken` — find its module with
  `grep -rn "export.*hashToken" apps/api/src` and import it from there. It is
  what `orgs-authorization.test.ts` uses to build a real invite; `createInvite`
  requires `tokenHash` and `expiresAt`, so a call omitting them will not
  compile.

```ts
describe("deleteOrg", () => {
	it("deletes an org whose only member is the caller", async () => {
		const org = await createOrgWithOwner(db(), "Solo", ada);

		expect(await deleteOrg(db(), org.id, ada)).toBe("ok");
		expect(await getOrgName(db(), org.id)).toBeNull();
	});

	it("refuses while any other member remains", async () => {
		const org = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), org.id, bob, "member");

		// The whole point of the guard. Ablation: delete the NOT EXISTS clause
		// from deleteOrg's DELETE and this must fail - a fixture with only one
		// member could not tell the guarded statement from an unguarded one.
		expect(await deleteOrg(db(), org.id, ada)).toBe("has_members");
		expect(await getOrgName(db(), org.id)).toBe("Acme");
	});

	it("refuses while another OWNER remains", async () => {
		const org = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), org.id, bob, "owner");

		// Not a special case of the test above: a reader could reasonably
		// assume the guard counts members who are not owners, since every
		// other guard in this file counts owners.
		expect(await deleteOrg(db(), org.id, ada)).toBe("has_members");
	});

	it("reports not_found for an org that does not exist", async () => {
		expect(await deleteOrg(db(), "no-such-org", ada)).toBe("not_found");
	});

	it("takes the memberships and invites with it", async () => {
		const org = await createOrgWithOwner(db(), "Solo", ada);
		await createInvite(db(), {
			orgId: org.id,
			email: "cleo@example.com",
			role: "member",
			tokenHash: await hashToken(crypto.randomUUID()),
			expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
			invitedBy: ada,
		});
		// Established first: otherwise the assertions below pass against an
		// invite that was never written, and this test would be green on a
		// cascade that does not exist.
		expect(await listPendingInvites(db(), org.id)).toHaveLength(1);

		expect(await deleteOrg(db(), org.id, ada)).toBe("ok");

		expect(await getMembership(db(), org.id, ada)).toBeNull();
		expect(await countMembers(db(), org.id)).toBe(0);
		expect(await listPendingInvites(db(), org.id)).toHaveLength(0);
	});

	it("counts every member, not just owners", async () => {
		const org = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), org.id, bob, "member");

		expect(await countMembers(db(), org.id)).toBe(2);
		expect(await countOwners(db(), org.id)).toBe(1);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/api && pnpm exec vitest run orgs.test
```

Expected: the new block fails to even import — `countMembers` and `deleteOrg`
are not exported yet. That is the correct first failure.

- [ ] **Step 3: Implement `countMembers`**

Append to `apps/api/src/db/orgs.ts`, immediately after `soleOwnedOrgs`:

```ts
/**
 * How many people belong to this org, in any role.
 *
 * `countOwners` above answers the question every other guard in this file
 * asks. This one exists because org deletion asks a different one: not "would
 * this leave the org without an owner" but "is anybody else here at all".
 */
export async function countMembers(
	db: D1Database,
	orgId: string,
): Promise<number> {
	const rows = await client(db)
		.select({ n: sql<number>`COUNT(*)` })
		.from(org_memberships)
		.where(eq(org_memberships.org_id, orgId));
	return Number(rows[0]?.n ?? 0);
}
```

- [ ] **Step 4: Implement `deleteOrg`**

Append after `countMembers`:

```ts
export type OrgDeleteResult = "ok" | "has_members" | "not_found";

/**
 * Delete an org, but only when the caller is the only member left in it.
 *
 * Why an org can be deleted at all: #198 made account deletion refuse while
 * the account is an org's sole owner, which closed the one path to an
 * ownerless org. For an owner with other members that is a speed bump - they
 * promote somebody and then delete. For the ONLY member of an org it was a
 * dead end, with nobody to promote and no route to delete the org, so that
 * account could not be deleted at all (ONL-136).
 *
 * Why sole-member rather than any owner: a lesson shared with an org survives
 * its author's departure, by ONL-12's design, and ending a populated org
 * destroys that sharing for people who never agreed to it. An owner winding
 * down a real team org removes its members first.
 *
 * The condition is part of the DELETE's own WHERE clause for the reason
 * removeMembership and setMemberRole above both give, and here the race is
 * concrete rather than theoretical: an invitee accepting between a count and
 * an unconditional delete would leave the org destroyed and the new member
 * holding a membership row that cascaded away under them. One statement is
 * one transaction in D1.
 *
 * A zero-row result is then ambiguous - other members, or an org already gone
 * - so one read resolves it. That read cannot invert the decision: the write
 * has already succeeded or failed authoritatively, and the count only chooses
 * which answer the caller gets. requireOrgRole found a membership moments
 * earlier at the route, so a count that has since fallen to zero means the
 * org itself went, because org_memberships cascades from orgs.
 *
 * Nothing here touches `lessons`. Four foreign keys already decide an org's
 * contents: org_memberships and org_invites cascade, while lessons.org_id and
 * machine_tokens.org_id are ON DELETE SET NULL. A lesson left with a NULL
 * org_id and visibility 'org' stays readable by its author - visibilityPredicate
 * pushes `user_id = ?` as its own disjunct - and by nobody else, which is the
 * right end state for a lesson whose org no longer exists.
 */
export async function deleteOrg(
	db: D1Database,
	orgId: string,
	userId: string,
): Promise<OrgDeleteResult> {
	const result = await db
		.prepare(
			`DELETE FROM orgs
			 WHERE id = ?
			   AND NOT EXISTS (SELECT 1 FROM org_memberships
			                   WHERE org_id = ? AND user_id != ?)`,
		)
		.bind(orgId, orgId, userId)
		.run();

	if ((result.meta.changes ?? 0) > 0) return "ok";

	return (await countMembers(db, orgId)) > 1 ? "has_members" : "not_found";
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/api && pnpm exec vitest run orgs.test
```

Expected: PASS, all cases in the new block.

- [ ] **Step 6: Prove the guard can fail — run the ablation**

Delete these two lines from `deleteOrg`'s SQL:

```
			   AND NOT EXISTS (SELECT 1 FROM org_memberships
			                   WHERE org_id = ? AND user_id != ?)
```

and change `.bind(orgId, orgId, userId)` to `.bind(orgId)` so the statement
still runs.

```bash
cd apps/api && pnpm exec vitest run orgs.test
```

Expected: **"refuses while any other member remains" and "refuses while
another OWNER remains" both FAIL.** If either passes, the fixture is not
reaching the branch the guard protects — fix the fixture, not the guard. This
project has shipped eight tests across two branches that could not fail, every
one an inadequate fixture, and every one found this way rather than by reading.

**Restore both lines and the three binds, then re-run and confirm PASS before
continuing.** Leave no ablation applied.

- [ ] **Step 7: Run the gates**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

Expected: 635 + your new tests passing, typecheck silent, lint at its 3
pre-existing warnings, source-guards 42/42.

- [ ] **Step 8: Commit**

Use `/git-workflow:commit`. Stage exactly `apps/api/src/db/orgs.ts` and
`apps/api/src/db/orgs.test.ts`. The body should say why the guard is inside
the statement, and that the ablation was run and restored.

---

## Task 2: The route, the router entry, and the acceptance test

**Files:**
- Modify: `apps/api/src/routes/orgs.ts` (after `handleRenameOrg`)
- Modify: `apps/api/src/router.ts` (after the `PATCH /api/orgs/:id` entry)
- Modify: `apps/api/src/routes/orgs-authorization.test.ts` (`REQUIRED_ROLE`)
- Modify: `apps/api/src/routes/account-deletion.test.ts` (acceptance test)
- Test: `apps/api/src/routes/orgs.test.ts` — the file that already tests
  `POST /api/orgs`, `GET /api/orgs` and `PATCH /api/orgs/:id` through `call()`.

**Interfaces:**
- Consumes from Task 1: `deleteOrg`, `countMembers`, `OrgDeleteResult`.
- Produces for Task 3: the route `DELETE /api/orgs/:id` answering
  `200 { deleted: string }`, `409 has_members` with
  `details: { member_count: number }`, or `404 not_found`.

- [ ] **Step 1: Give `orgs.test.ts` the two things its fixture lacks**

That file keeps only tokens (`adaToken`, `bobToken`) and has no `db()` handle,
because nothing in it has needed a second membership before. Add both, keeping
the existing `createOrg` helper and the existing token variables so no current
test changes:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addMembership } from "../db/orgs.js";
import { call, resetOrgTables, signup } from "../test-support/orgs.js";

const db = () => env.DB;
let adaToken: string;
let bobToken: string;
let bobId: string;

beforeEach(async () => {
	await resetOrgTables();
	adaToken = (await signup("ada@example.com")).token;
	const bob = await signup("bob@example.com");
	bobToken = bob.token;
	bobId = bob.id;
});
```

`bobToken` keeps its meaning, so the existing `PATCH`/`POST`/`GET` cases are
untouched; `bobId` is new and only the delete cases read it.

- [ ] **Step 2: Write the failing route tests**

In `apps/api/src/routes/orgs.test.ts`, after the `PATCH /api/orgs/:id` block.
Note it uses this file's own fixture names — `adaToken`, `bobToken`, `bobId`,
and the existing `createOrg(token, name)` helper, which already asserts 201:

```ts
describe("DELETE /api/orgs/:id", () => {
	it("deletes an org whose only member is the owner", async () => {
		const orgId = await createOrg(adaToken, "Solo");

		const response = await call(`/api/orgs/${orgId}`, adaToken, {
			method: "DELETE",
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ deleted: orgId });

		// Gone from the caller's own list, not merely reported gone.
		const list = await call("/api/orgs", adaToken);
		const { orgs } = (await list.json()) as { orgs: { id: string }[] };
		expect(orgs.map((o) => o.id)).not.toContain(orgId);
	});

	it("refuses with 409 and the member count while anyone else remains", async () => {
		const orgId = await createOrg(adaToken, "Acme");
		await addMembership(db(), orgId, bobId, "member");

		const response = await call(`/api/orgs/${orgId}`, adaToken, {
			method: "DELETE",
		});

		expect(response.status).toBe(409);
		const body = (await response.json()) as {
			error: { code: string; details?: { member_count?: number } };
		};
		expect(body.error.code).toBe("has_members");
		// The count is what makes the refusal actionable without naming
		// people the page already lists.
		expect(body.error.details?.member_count).toBe(2);
	});

	it("gives a plain member 404, not 403", async () => {
		const orgId = await createOrg(adaToken, "Acme");
		await addMembership(db(), orgId, bobId, "member");

		const response = await call(`/api/orgs/${orgId}`, bobToken, {
			method: "DELETE",
		});

		expect(response.status).toBe(404);
	});

	it("gives 404 for an org that is already gone", async () => {
		const orgId = await createOrg(adaToken, "Solo");
		await call(`/api/orgs/${orgId}`, adaToken, { method: "DELETE" });

		const again = await call(`/api/orgs/${orgId}`, adaToken, {
			method: "DELETE",
		});

		expect(again.status).toBe(404);
	});
});
```

- [ ] **Step 3: Run them to verify they fail**

```bash
cd apps/api && pnpm exec vitest run <the file from Step 1>
```

Expected: 404 on every case — the route does not exist, so the router has no
match.

- [ ] **Step 4: Write the handler**

In `apps/api/src/routes/orgs.ts`, after `handleRenameOrg`. Extend the existing
first import to `import { countMembers, createOrgWithOwner, deleteOrg, listOrgsForUser, renameOrg } from "../db/orgs.js";`.

```ts
/**
 * Delete an org, for an owner who is its only member.
 *
 * The 409 names no members. The only page that renders this already lists
 * them - OrgsPage fetches members for every role - so the count is what it
 * cannot work out for itself. That is the same reasoning
 * MachineTokenSummary.org_id gives for carrying an id without a name.
 *
 * The 404 for an already-deleted org is deliberate, and the opposite of
 * handleDeleteAccount's choice to report success for an account that is
 * already gone. There the caller's own identity was the target and "make it
 * gone" was satisfied; here the caller is asserting something about a
 * resource that is no longer theirs to assert anything about, which is what
 * requireOrgRole would have said a moment earlier.
 */
export async function handleDeleteOrg(
	_request: Request,
	env: WorkerEnv,
	params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	await requireOrgRole(env.DB, principal, params.id, "owner");

	const outcome = await deleteOrg(
		env.DB,
		params.id,
		(principal as Principal).userId,
	);

	if (outcome === "has_members") {
		throw new ApiError(
			409,
			"has_members",
			"An org with other members cannot be deleted; remove them first",
			{ member_count: await countMembers(env.DB, params.id) },
		);
	}

	if (outcome === "not_found") {
		throw new ApiError(404, "not_found", "No such org");
	}

	return Response.json({ deleted: params.id });
}
```

- [ ] **Step 5: Add the router entry**

In `apps/api/src/router.ts`, immediately after the `PATCH /api/orgs/:id` entry
(the one whose handler is `handleRenameOrg`), add:

```ts
	{
		method: "DELETE",
		path: "/api/orgs/:id",
		auth: "session",
		cors: "app",
		handler: handleDeleteOrg,
	},
```

Add `handleDeleteOrg` to the existing import from `./routes/orgs.js`.

- [ ] **Step 6: Add the matrix entry**

In `apps/api/src/routes/orgs-authorization.test.ts`, add to `REQUIRED_ROLE`,
keeping it beside its sibling:

```ts
	"DELETE /api/orgs/:id": "owner",
```

Note what this buys without writing a test: the suite's "a non-member gets 404
from every org-scoped route" and "a plain member gets 404 from every owner
route" loops both pick the route up automatically, and `concrete()` already
substitutes a **real** `orgId`, so neither loop can pass on a handler's
incidental 404. The member-route loop does not touch owner routes, so nothing
calls this DELETE with a privileged token mid-suite.

- [ ] **Step 7: Run the matrix suite and confirm it was failing for the right reason**

Before adding the entry in Step 6, the suite's "declares a required role for
every /api/orgs route" test fails with the new route named. Confirm you saw
that. If you added the entry first, revert it, run, see the failure, then
re-add:

```bash
cd apps/api && pnpm exec vitest run orgs-authorization
```

Expected after Step 6: PASS, with the two 404 loops now covering 13 routes.

- [ ] **Step 8: Prove the role check is real — ablate `requireOrgRole`**

The enumerated matrix is only as good as the handler it calls. ONL-141 found
this suite could pass a route carrying **no role check at all**, because
`concrete()` filled a parameter with a nonexistent id and the handler's own
404 stood in for the missing guard. `:id` here is a real org, so that
particular hole is closed — but prove it rather than assume it.

Comment out the `await requireOrgRole(...)` line in `handleDeleteOrg`.

```bash
cd apps/api && pnpm exec vitest run orgs-authorization
cd apps/api && pnpm exec vitest run orgs.test
```

Expected: **both the matrix's "a plain member gets 404 from every owner route"
and your own "gives a plain member 404, not 403" FAIL.** A plain member would
reach `deleteOrg`, whose `NOT EXISTS` would then refuse on the owner's own
membership and answer 409 — so a passing test here would mean the 404 was
coming from somewhere other than the authorization check.

Restore the line, re-run, confirm PASS. Leave no ablation applied.

- [ ] **Step 9: Write the acceptance test**

In `apps/api/src/routes/account-deletion.test.ts`, inside the existing
`describe`, after "deletes the account once another owner exists":

```ts
	it("deletes the account once the sole-owned org is deleted", async () => {
		const orgId = await createOrg(ada.token, "Solo");
		expect((await deleteAccount(ada.token)).status).toBe(409);

		// The way out #198 left for an owner with no one to promote. Without
		// this route that 409 is unfollowable and the account is undeletable.
		const removed = await call(`/api/orgs/${orgId}`, ada.token, {
			method: "DELETE",
		});
		expect(removed.status).toBe(200);

		const response = await deleteAccount(ada.token);

		expect(response.status).toBe(200);
		expect(await getUserById(db(), ada.id)).toBeNull();
	});
```

- [ ] **Step 10: Test what the deletion does to the org's lessons**

This is the assertion the spec insists on: "the schema already handles the
lessons" is this design's reason for the route touching no lesson at all, and
that is a claim about behavior, so it gets a test rather than a sentence.

It goes in `apps/api/src/routes/orgs-lessons.test.ts`, which already has the
whole fixture — an `owner`, a `member`, an org, a `sharedId` lesson **authored
by the member**, the `lessons`/`lesson_feed` clearing, and a `browse(token)`
helper returning the ids `GET /api/lessons` gives that token. Add
`removeMembership` to its existing import from `../db/orgs.js`.

```ts
describe("deleting the org the lesson was shared with", () => {
	it("leaves the lesson readable by its author and by nobody else", async () => {
		// Both can read it to begin with: the member wrote it, the owner
		// reaches it through the org.
		expect(await browse(member.token)).toContain(sharedId);
		expect(await browse(owner.token)).toContain(sharedId);

		// The org can only be deleted by its sole member, so the member goes
		// first. Leaving does not unshare the lesson - that is ONL-12's
		// design - so the lesson is still visibility 'org' here.
		await removeMembership(db(), orgId, member.id);

		const deleted = await call(`/api/orgs/${orgId}`, owner.token, {
			method: "DELETE",
		});
		expect(deleted.status).toBe(200);

		// lessons.org_id is ON DELETE SET NULL, and visibilityPredicate pushes
		// `user_id = ?` as its own disjunct, so the author keeps it...
		expect(await browse(member.token)).toContain(sharedId);
		// ...while `org_id IN (...)` is never true for NULL, so the former
		// owner does not. This pair is the whole reason the route needs no
		// lesson handling of its own.
		expect(await browse(owner.token)).not.toContain(sharedId);
	});
});
```

- [ ] **Step 11: Run the three suites and verify**

```bash
cd apps/api && pnpm exec vitest run orgs
cd apps/api && pnpm exec vitest run account-deletion
cd apps/api && pnpm exec vitest run orgs-lessons
```

Expected: PASS. If the final `not.toContain` passes even before your route
exists, the test is not proving anything — check that the owner could read the
lesson at the start, which is what the first two assertions exist to establish.

- [ ] **Step 12: Run the gates**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

- [ ] **Step 13: Commit**

Use `/git-workflow:commit`. Stage the handler, the router, the matrix entry,
the route tests, the acceptance test and the org-lessons test together — they
are one deliverable: a reachable route. The body should say that the
acceptance test is the bead's done-when, expressed as a test.

---

## Task 3: The contract case and the mock

**Files:**
- Modify: `packages/api-contract/src/index.ts` (`ORG_LIFECYCLE`)
- Modify: `apps/web/src/api/mockApi.ts` (beside the PATCH branch)

**Interfaces:**
- Consumes from Task 2: the route `DELETE /api/orgs/:id`.
- Produces for Task 4: a mock that answers `{ deleted: "<id>" }`, so
  `orgsApi.deleteOrg`'s return type has something to agree with.

- [ ] **Step 1: Add the contract case**

In `packages/api-contract/src/index.ts`, in `ORG_LIFECYCLE`, after the
`"POST /api/orgs/:id/lessons/:lessonId/retract with no credential"` case:

```ts
	{
		name: "DELETE /api/orgs/:id with no credential",
		path: "/api/orgs/any",
		init: { method: "DELETE" },
		status: 401,
	},
```

`/api/orgs/any` matches the sibling cases' convention of a literal `any` where
the real id does not matter: the credential check runs before the handler, so
no org needs to exist.

- [ ] **Step 2: Teach the mock**

In `apps/web/src/api/mockApi.ts`, immediately after the
`method === "PATCH" && /^\/api\/orgs\/[^/]+$/` branch:

```ts
	if (method === "DELETE" && /^\/api\/orgs\/[^/]+$/.test(path)) {
		return json({ deleted: path.split("/").pop() });
	}
```

The anchored regex is what keeps this from swallowing
`/api/orgs/<id>/members/<uid>`, and is why it is safe to add after the
substring-matching branches above it — that file's own comment explains the
hazard.

- [ ] **Step 3: Run both suites**

Touching `packages/api-contract` means both:

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/web test
```

Expected: PASS, with the api-contract case count up by one (18 → 19).

- [ ] **Step 4: Verify the case actually runs against both implementations**

```bash
cd apps/api && pnpm exec vitest run contract
```

Expected: the new case appears by name in the output. If it does not, the case
was added to an array nothing iterates — find the right one before moving on.

- [ ] **Step 5: Run the gates**

```bash
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/web typecheck
pnpm --filter @onlooker/web lint
bash scripts/source-guards.test.sh
```

- [ ] **Step 6: Commit**

Use `/git-workflow:commit`. Stage the contract and the mock together — the
pair is the point, since a mock the contract does not pin is how this surface
previously drifted.

---

## Task 4: The browser control

**Files:**
- Modify: `apps/web/src/api/orgsApi.ts` (after `renameOrg`)
- Modify: `apps/web/src/pages/OrgsPage.tsx` (inside `OrgSection`)
- Test: `apps/web/src/__tests__/orgs-page.test.tsx`

**Interfaces:**
- Consumes from Task 3: the mock's `{ deleted: id }` shape.
- Produces: `deleteOrg(orgId: string): Promise<{ deleted: string }>`.

- [ ] **Step 1: Add the API function**

In `apps/web/src/api/orgsApi.ts`, after `renameOrg`:

```ts
export function deleteOrg(orgId: string): Promise<{ deleted: string }> {
	return apiClient.delete<{ deleted: string }>(
		`${ORG_ENDPOINTS.orgs}/${encodeURIComponent(orgId)}`,
	);
}
```

- [ ] **Step 2: Add `deleteOrg` to the test file's mock factory**

In `apps/web/src/__tests__/orgs-page.test.tsx`, add `deleteOrg: vi.fn(),` to
the `vi.mock("../api/orgsApi", ...)` factory. **Do this before Step 3** — the
factory enumerates every export the page imports, so a missing entry makes the
import fail rather than the assertion.

- [ ] **Step 3: Write the failing tests**

```ts
	it("offers deleting an owned org whose only member is you", async () => {
		vi.mocked(api.listOrgs).mockResolvedValue({ orgs: [OWNED] });
		render(<OrgsPage />);
		await screen.findByText("Acme");

		expect(
			await screen.findByRole("button", { name: /delete acme/i }),
		).toBeInTheDocument();
	});

	it("does not offer deleting an org that still has other members", async () => {
		vi.mocked(api.listOrgs).mockResolvedValue({ orgs: [OWNED] });
		vi.mocked(api.listMembers).mockResolvedValue({
			members: [
				MEMBERS[0],
				{
					user_id: "u2",
					name: "Bob",
					email: "bob@example.com",
					role: "member" as const,
					created_at: "2026-10-01T00:00:00.000Z",
				},
			],
		});
		render(<OrgsPage />);
		await screen.findByText("Acme");

		// The server refuses this with 409, and a control that reliably fails
		// is worse than no control.
		expect(
			screen.queryByRole("button", { name: /delete/i }),
		).not.toBeInTheDocument();
	});

	it("does not offer deleting an org you only belong to", async () => {
		vi.mocked(api.listOrgs).mockResolvedValue({ orgs: [JOINED] });
		render(<OrgsPage />);
		await screen.findByText("Beta");

		expect(
			screen.queryByRole("button", { name: /delete/i }),
		).not.toBeInTheDocument();
	});

	it("deletes the org and stops listing it", async () => {
		vi.mocked(api.listOrgs)
			.mockResolvedValueOnce({ orgs: [OWNED] })
			.mockResolvedValue({ orgs: [] });
		vi.mocked(api.deleteOrg).mockResolvedValue({ deleted: OWNED.id });
		render(<OrgsPage />);

		await userEvent.click(
			await screen.findByRole("button", { name: /delete acme/i }),
		);
		await userEvent.click(
			await screen.findByRole("button", { name: /yes, delete this org/i }),
		);

		await waitFor(() => expect(api.deleteOrg).toHaveBeenCalledWith(OWNED.id));
		expect(await screen.findByText(/not in any org/i)).toBeInTheDocument();
	});

	it("says what the confirmation will do", async () => {
		vi.mocked(api.listOrgs).mockResolvedValue({ orgs: [OWNED] });
		render(<OrgsPage />);

		await userEvent.click(
			await screen.findByRole("button", { name: /delete acme/i }),
		);

		// The surprising fact is that the lessons survive. If this copy drifts
		// to "deletes everything", it is wrong about the schema.
		expect(
			await screen.findByText(/stay readable by you and by nobody else/i),
		).toBeInTheDocument();
		expect(screen.getByText(/pending invitations are canceled/i))
			.toBeInTheDocument();
	});
```

- [ ] **Step 4: Run them to verify they fail**

```bash
cd apps/web && pnpm exec vitest run orgs-page
```

Expected: the four new cases that look for a Delete control FAIL (no such
button); "does not offer deleting an org you only belong to" PASSES already,
which is correct — it is a regression guard, not a new behavior.

- [ ] **Step 5: Implement the control**

In `apps/web/src/pages/OrgsPage.tsx`, inside `OrgSection`. Add `deleteOrg` to
the existing import from `../api/orgsApi`. Add state beside `leaving`:

```tsx
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);
```

Add the handler beside `leave`:

```tsx
	const remove = async () => {
		setDeleting(true);
		setDeleteError(null);
		try {
			await deleteOrg(org.id);
			onChanged();
		} catch (error) {
			setDeleteError(describeError(error, "Could not delete that org."));
		} finally {
			setDeleting(false);
		}
	};
```

Then, inside the `isOwner ? (...)` branch, after the pending-invitations
`<div>` and still inside the fragment:

```tsx
					{members?.length === 1 ? (
						<div style={{ marginTop: "1rem" }}>
							{deleteError ? (
								<FormMessage kind="error">{deleteError}</FormMessage>
							) : null}
							<ConfirmAction
								trigger={`Delete ${org.name}`}
								question={`Deleting ${org.name} is permanent. Lessons you shared with it stay readable by you and by nobody else, and any pending invitations are canceled.`}
								confirmLabel="Yes, delete this org"
								pendingLabel="Deleting..."
								pending={deleting}
								variant="danger"
								onConfirm={() => void remove()}
							/>
						</div>
					) : null}
```

`members?.length === 1` and not `members.length === 1`: `members` is
`OrgMember[] | null` and is null while loading and after a failed load. The
optional chain is what keeps the control from rendering on a count nobody has
established — a `null` members list means the page does not know how many
members there are, which is not the same as knowing there is one.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd apps/web && pnpm exec vitest run orgs-page
```

Expected: PASS, all cases.

- [ ] **Step 7: Prove the gate can fail — run the ablation**

Change `members?.length === 1` to `true`.

```bash
cd apps/web && pnpm exec vitest run orgs-page
```

Expected: **"does not offer deleting an org that still has other members"
FAILS.** If it passes, the two-member fixture is not reaching the render path
— fix the fixture.

Restore the condition, re-run, confirm PASS. Leave no ablation applied.

- [ ] **Step 8: Run the gates**

```bash
pnpm --filter @onlooker/web test
pnpm --filter @onlooker/web typecheck
pnpm --filter @onlooker/web lint
bash scripts/source-guards.test.sh
```

The fourth matters here specifically: source-guards includes an `apps/web`
loading-state check.

- [ ] **Step 9: Commit**

Use `/git-workflow:commit`. Stage `orgsApi.ts`, `OrgsPage.tsx` and the test
file. The body should say why the control is gated rather than merely
error-handled, and that the ablation was run and restored.

---

## Done when

- A sole owner of a single-member org can delete the org in the browser and
  then delete their account.
- `DELETE /api/orgs/:id` appears in `REQUIRED_ROLE` as `"owner"`, and the
  matrix's two 404 loops cover it.
- An org with any other member refuses with `409 has_members` carrying
  `member_count`, and the refusal has an ablation proving the test can fail.
- Deleting an org leaves its author's lessons readable by that author and by
  nobody else, asserted by a test rather than by the schema's say-so.
- All four gates green on both `apps/api` and `apps/web`.
