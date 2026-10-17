# Account and Org Deletion Follow-Ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three follow-ups the deletion work opened — a 500 on a race, a duplicate feed row on a redundant retract, and a comment that promises something the cascade cannot buy.

**Architecture:** Three independent changes in `apps/api`, each its own branch and PR. ONL-147 adds a foreign-key error matcher and a scoped catch in one route. ONL-145 moves a precondition into `transitionLesson`, the single writer all three retract paths delegate to, so they agree without any of them learning about the others. ONL-146 changes no behavior at all: it corrects documentation, records a deliberate mock divergence, and adds the test that was missing in both directions.

**Tech Stack:** TypeScript on Cloudflare Workers, D1 (SQLite) via drizzle, vitest with `@cloudflare/vitest-pool-workers`, biome, pnpm workspaces.

**Design:** `docs/superpowers/specs/2026-10-17-deletion-followups-design.md`. Decisions D1–D5 there are settled; this plan implements them and does not revisit them.

## Global Constraints

- **American English** in every comment, identifier, test name and commit message.
- **Edit tracked files with `Edit`/`Write`/`MultiEdit` only, never the shell.** The `lineage` and `inspector` plugins hook `PostToolUse` on those tools; a `sed -i` or heredoc moves the same bytes invisibly and `/lineage <file>:<line>` then answers "no record" for a line that was demonstrably written. See the repo CLAUDE.md.
- **Every commit goes through `/git-workflow:commit`.** Never craft `git commit -m` by hand, not even for a one-line change.
- **Never push to `main`.** Each task starts on its own branch and ends in a PR. `main` is governed by a ruleset whose bypass list includes this account, so a direct push succeeds and is still wrong.
- **All four gates before every PR.** The fourth is wired into no pnpm script — it runs as a bare bash step in `.github/workflows/deploy.yml`, so no local `test`/`typecheck`/`lint` sweep reaches it:
  ```bash
  pnpm --filter @onlooker/api test
  pnpm --filter @onlooker/api typecheck
  pnpm --filter @onlooker/api lint
  bash scripts/source-guards.test.sh
  ```
- **To run one test file**, use `pnpm --filter @onlooker/api exec vitest run <path>`. The `pnpm --filter @onlooker/api test -- <name>` form does **not** filter to one file (ONL-144).
- **`vi.mock` does not work in this test pool.** Failure injection goes through a `Proxy` around `env.DB`, the pattern established in `apps/api/src/routes/lessons-push-failure.test.ts`.
- **Biome emits 9 pre-existing `noExplicitAny` warnings in `apps/web` and 3 in `apps/api`.** Warnings do not fail the gate; only errors do. Do not "fix" them here.

## File Structure

| File | Task | Responsibility |
| --- | --- | --- |
| `apps/api/src/db/constraints.ts` | 1 | **New.** D1 constraint-error vocabulary. Holds `isForeignKeyViolation` and nothing that queries a table, which is what keeps it outside the lesson-visibility boundary the source guard enforces. |
| `apps/api/src/routes/orgs-invite-accept.ts` | 1 | Modify `:126-129` — the membership write gains a scoped catch. |
| `apps/api/src/routes/orgs-invite-accept-race.test.ts` | 1 | **New.** The race, driven rather than assumed. Separate from `orgs-invite-accept.test.ts` because it calls the handler directly with a proxied binding, the way `lessons-push-failure.test.ts` does, and that file explains at its top why it is not a `SELF.fetch` suite. |
| `apps/api/src/db/lessons.ts` | 2 | Modify `transitionLesson` (`:310`) — the no-op precondition; add a private `currentFeedSeq` helper. |
| `apps/api/src/db/lessons.test.ts` | 2 | Extend — four cases for the precondition. |
| `apps/api/src/routes/account.ts` | 3 | Modify the comment at `:291-294`. |
| `apps/api/src/db/queries.test.ts` | 3 | Modify the comment at `:350-352` — the same claim, narrowed to renewal, which is what its assertion actually protects. |
| `packages/api-contract/src/index.ts` | 3 | Extend the `SESSION_LIFECYCLE` preamble — the anonymize predicate, and the recorded mock divergence. |
| `ENVIRONMENT_VARIABLES.md` | 3 | Extend the `TOKEN_REVOCATION` note at `:327-332` with the same predicate. |
| `apps/web/src/api/mockApi.ts` | 3 | Comment the delete branch at `:420-427` to point at the recorded divergence. No behavior change. |
| `apps/api/src/test-support/orgs.ts` | 3 | `signup()` also returns the refresh token. Purely additive. |
| `apps/api/src/routes/account-deletion.test.ts` | 3 | Extend — the window as an asserted property. |

---

### Task 1: ONL-147 — the invitation race answers 400

Bead `onlooker-wrdnd4`. Spec decision D5.

**Files:**
- Create: `apps/api/src/db/constraints.ts`
- Create: `apps/api/src/routes/orgs-invite-accept-race.test.ts`
- Modify: `apps/api/src/routes/orgs-invite-accept.ts:126-129`
- Also commits: `docs/superpowers/specs/2026-10-17-deletion-followups-design.md` and this plan, which have not been committed yet and land with this first PR.

**Interfaces:**
- Produces: `isForeignKeyViolation(error: unknown): boolean` from `apps/api/src/db/constraints.ts`. Nothing in Tasks 2 and 3 consumes it.
- Consumes: `addMembership(db, orgId, userId, role)` from `../db/orgs.js` — note that argument order; `handleAcceptInvite(request, env, params, principal)` from `./orgs-invite-accept.js`.

- [ ] **Step 1: Branch**

```bash
git switch -c meagan/onl-147-invite-accept-race
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/routes/orgs-invite-accept-race.test.ts`:

```ts
import { env } from "cloudflare:test";
import type {
	D1Database,
	D1PreparedStatement,
} from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it } from "vitest";
import { isForeignKeyViolation } from "../db/constraints.js";
import { createInvite } from "../db/org-invites.js";
import { addMembership, createOrgWithOwner } from "../db/orgs.js";
import type { Principal } from "../db/pool.js";
import { createUser } from "../db/queries.js";
import { errorHandler } from "../middleware/error.js";
import { BASE } from "../test-support/lessons.js";
import {
	resetOrgTables,
	type SignedUpUser,
	signup,
} from "../test-support/orgs.js";
import { ApiError, type WorkerEnv } from "../types";
import { hashToken } from "../utils/crypto.js";
import { handleAcceptInvite } from "./orgs-invite-accept.js";

/**
 * What an accept is told when the org is deleted underneath it.
 *
 * Calls the handler directly against a proxied binding, the way
 * routes/lessons-push-failure.test.ts does and for the same reason: the window
 * this covers opens between two statements inside ONE request, and no sequence
 * of requests through SELF can open it. Deleting the org before the request
 * cascades the invitation away with it, so the handler refuses at
 * findInviteByTokenHash and never reaches the path under test.
 */
const db = () => env.DB;
const REAL_ENV = env as unknown as WorkerEnv;

let ada: string;
let bob: SignedUpUser;
let orgId: string;

/**
 * The real binding, with the membership insert failing the way D1 fails it.
 *
 * Replaces `run`/`all`/`first` on the membership INSERT only, and re-wraps
 * `bind` because drizzle prepares, binds and only then runs - the statement
 * that actually executes is the one `bind` returned, not the one `prepare` did.
 */
function membershipInsertFailsWith(error: Error): WorkerEnv {
	const rejecting = (statement: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(statement, {
			get(target, property, receiver) {
				if (property === "bind") {
					return (...args: unknown[]) => rejecting(target.bind(...args));
				}
				if (property === "run" || property === "all" || property === "first") {
					return () => Promise.reject(error);
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as D1PreparedStatement;

	const broken = new Proxy(REAL_ENV.DB, {
		get(target, property, receiver) {
			if (property === "prepare") {
				return (sql: string) => {
					const statement = target.prepare(sql);
					return /insert\s+into\s+.?org_memberships/i.test(sql)
						? rejecting(statement)
						: statement;
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as D1Database;

	return { ...REAL_ENV, DB: broken };
}

/** Seed an invitation directly, so the test holds the raw token. */
async function seedInvite(email: string): Promise<string> {
	const token = crypto.randomUUID().replace(/-/g, "");
	await createInvite(db(), {
		orgId,
		email,
		role: "member",
		tokenHash: await hashToken(token),
		expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
		invitedBy: ada,
	});
	return token;
}

function acceptRequest(token: string): Request {
	return new Request(`${BASE}/api/orgs/invites/accept`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token }),
	});
}

/** Run a handler and hand back whatever it threw, if anything. */
async function thrownBy(work: Promise<Response>): Promise<unknown> {
	return work.then(
		() => null,
		(error) => error,
	);
}

beforeEach(async () => {
	await resetOrgTables();
	ada = (await createUser(db(), "ada@example.com", "hash", "Ada")).id;
	bob = await signup("bob@example.com", "Bob");
	orgId = (await createOrgWithOwner(db(), "Acme", ada)).id;
});

describe("isForeignKeyViolation", () => {
	// Pins the matcher against what D1 ACTUALLY throws rather than against a
	// string this file made up. Without this case, the injected error below
	// would prove only that the handler maps the error it was handed - true
	// even if D1 worded a real violation differently and the catch never fired
	// in production.
	it("recognizes a real D1 foreign-key failure", async () => {
		const error = await addMembership(
			db(),
			"no-such-org",
			bob.id,
			"member",
		).then(
			() => null,
			(thrown: unknown) => thrown,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/FOREIGN KEY constraint failed/i);
		expect(isForeignKeyViolation(error)).toBe(true);
	});

	it("does not match a unique violation", () => {
		expect(
			isForeignKeyViolation(
				new Error("D1_ERROR: UNIQUE constraint failed: lesson_feed.seq"),
			),
		).toBe(false);
	});
});

describe("POST /api/orgs/invites/accept when the org is deleted mid-request", () => {
	it("answers 400 invalid_invitation rather than 500", async () => {
		const token = await seedInvite("bob@example.com");
		const principal: Principal = { userId: bob.id };

		const error = await thrownBy(
			handleAcceptInvite(
				acceptRequest(token),
				membershipInsertFailsWith(
					new Error(
						"D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT",
					),
				),
				{},
				principal,
			),
		);

		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(400);
		expect((error as ApiError).code).toBe("invalid_invitation");
		// The mapped response too, not only the thrown class - the same pair
		// routes/lessons-push-failure.test.ts asserts, because a thrown
		// ApiError nobody maps is still a 500 to the caller.
		expect(errorHandler(error).status).toBe(400);
	});

	it("lets any other write failure surface as itself", async () => {
		// The catch is scoped to one statement AND one error class on purpose:
		// an unscoped catch would report a disk error as a bad invitation.
		const token = await seedInvite("bob@example.com");
		const principal: Principal = { userId: bob.id };
		const disk = new Error("D1_ERROR: database is locked");

		const error = await thrownBy(
			handleAcceptInvite(
				acceptRequest(token),
				membershipInsertFailsWith(disk),
				{},
				principal,
			),
		);

		expect(error).toBe(disk);
	});
});
```

- [ ] **Step 3: Run it and watch it fail for the right reasons**

```bash
pnpm --filter @onlooker/api exec vitest run src/routes/orgs-invite-accept-race.test.ts
```

Expected: the two `isForeignKeyViolation` cases fail to resolve the import (`Failed to resolve import "../db/constraints.js"`), and the two route cases fail because the raw D1 error escapes the handler — the error is an `Error`, not an `ApiError`, which is the 500 ONL-147 reports.

Note what the first case prints for the real message. If D1 words it differently from `FOREIGN KEY constraint failed`, the regex in `constraints.ts` is what must change — not the assertion.

- [ ] **Step 4: Write `apps/api/src/db/constraints.ts`**

```ts
/**
 * Does this error report a foreign-key violation?
 *
 * NO TABLE ARGUMENT, unlike `isUniqueViolationOn` in db/lessons.ts, and the
 * asymmetry is SQLite's rather than an omission: a unique violation names the
 * index and its columns in the message, while a foreign-key failure is the
 * bare string "FOREIGN KEY constraint failed" with nothing to scope a match to.
 *
 * So a caller CANNOT ask "did this table's constraint fail", and the only safe
 * way to use this is around a single statement whose foreign keys are known by
 * reading it. A catch spanning several writes cannot tell which one failed, and
 * would answer for the wrong one.
 *
 * Lives here rather than beside `isUniqueViolationOn` because a route needs it:
 * importing it out of db/lessons.ts would pass the lesson-visibility source
 * guard, which matches queries rather than imports, and would still read as a
 * route reaching into the lesson-query home. This file queries nothing.
 */
export function isForeignKeyViolation(error: unknown): boolean {
	return (
		error instanceof Error &&
		/FOREIGN KEY constraint failed/i.test(error.message)
	);
}
```

- [ ] **Step 5: Add the cross-reference to `isUniqueViolationOn`**

In `apps/api/src/db/lessons.ts`, immediately above `export function isUniqueViolationOn` (`:93`), add to the existing doc comment:

```ts
 * Its foreign-key counterpart is `isForeignKeyViolation` in db/constraints.ts,
 * which deliberately takes no table: SQLite names one in this message and not
 * in that one. This one stays here, beside its only caller.
```

- [ ] **Step 6: Scope the catch in the route**

In `apps/api/src/routes/orgs-invite-accept.ts`, add to the imports:

```ts
import { isForeignKeyViolation } from "../db/constraints.js";
```

Then replace the membership write at `:126-129`:

```ts
	// Already a member - possible if somebody was added directly while an
	// invitation was outstanding. The invitation is spent either way, and this
	// is a success rather than a conflict: the caller asked to be in the org,
	// and they are.
	if (!(await getMembership(env.DB, invite.org_id, userId))) {
		try {
			await addMembership(env.DB, invite.org_id, userId, invite.role);
		} catch (error) {
			if (!isForeignKeyViolation(error)) throw error;

			// The org was deleted between markInviteAccepted above and this
			// write. An outstanding invitation does not block org deletion -
			// deleteOrg counts memberships, and an invitation is not one - so a
			// sole member may delete an org with invitations outstanding, which
			// is correct and is what makes this window reachable (ONL-147).
			//
			// The ordering above is not what to fix: spending the token first
			// is what makes two concurrent accepts resolve to one membership.
			// The foreign key already protects integrity here; this is only
			// about what the caller is told, and a 500 told them to retry
			// something that cannot succeed.
			//
			// The same bare error answers a concurrently deleted ACCOUNT, and
			// SQLite's message names neither table, so this answer has to be
			// true for both. It is: the invitation cannot be used either way.
			// A message naming the org would not be.
			throw new ApiError(
				400,
				"invalid_invitation",
				"That invitation cannot be used",
			);
		}
	}
```

- [ ] **Step 7: Run the test file and watch it pass**

```bash
pnpm --filter @onlooker/api exec vitest run src/routes/orgs-invite-accept-race.test.ts
```

Expected: 4 passed.

- [ ] **Step 8: All four gates**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

Expected: all pass. The source guard matters specifically here — a new file under `src/db/` is exactly what its lesson-visibility check watches for, and `constraints.ts` passes only because it queries nothing.

- [ ] **Step 9: Commit**

Stage precisely these, then invoke `/git-workflow:commit` — do not write the message by hand:

```bash
git add apps/api/src/db/constraints.ts \
        apps/api/src/db/lessons.ts \
        apps/api/src/routes/orgs-invite-accept.ts \
        apps/api/src/routes/orgs-invite-accept-race.test.ts \
        docs/superpowers/specs/2026-10-17-deletion-followups-design.md \
        docs/superpowers/plans/2026-10-17-deletion-followups.md
```

The commit body should say `Fixes onlooker-wrdnd4` and reference ONL-147.

- [ ] **Step 10: PR**

Invoke `/git-workflow:pr`. Branch name carries `onl-147`, so Linear links itself.

- [ ] **Step 11: Close the bead**

```bash
bd close onlooker-wrdnd4 --reason="Shipped in PR <number>"
```

---

### Task 2: ONL-145 — a redundant transition writes nothing

Bead `onlooker-4lgc3z`. Spec decision D4.

**Files:**
- Modify: `apps/api/src/db/lessons.ts` — `transitionLesson` (`:310`), plus a new private `currentFeedSeq`
- Modify: `apps/api/src/db/lessons.test.ts` — add `transitionLesson` to the existing import block and append one `describe`

**Interfaces:**
- Consumes: `probeLessonId(db, id): Promise<StoredLesson | null>` where `StoredLesson` is `{ id, user_id, visibility, status, body, org_id }`. **There is no `superseded_by` column** anywhere in the schema — it lives only inside the `body` JSON. Confirmed in `packages/db/src/schema.ts:229-280`.
- Produces: `transitionLesson`'s signature is unchanged — `(db, userId, id, status, supersededBy) => Promise<number | null>`. `null` keeps meaning "no such lesson, or not yours". Callers `retractAnyLesson` (`:372`) and `retractOrgLesson` (`:406`) need no edit; they inherit this.

- [ ] **Step 1: Branch**

```bash
git switch -c meagan/onl-145-redundant-retract
```

- [ ] **Step 2: Write the failing tests**

In `apps/api/src/db/lessons.test.ts`, add `transitionLesson` to the import block from `./lessons.js` (keep the list alphabetical — it currently runs `accountDeletionPreview, createLessonsWithFeed, hasOrgSharedLessons, isUniqueViolationOn, nonOrgLessonsDelete, probeLessonId, probeLessonIds, readLessonDelta, retractOrgLesson`, so `transitionLesson` goes last).

Then append:

```ts
/** How many feed rows exist for one lesson, and the newest seq among them. */
async function feedFor(lessonId: string): Promise<{
	rows: number;
	latest: number | null;
}> {
	const row = await db()
		.prepare(
			"SELECT COUNT(*) AS rows, MAX(seq) AS latest FROM lesson_feed WHERE lesson_id = ?",
		)
		.bind(lessonId)
		.first<{ rows: number; latest: number | null }>();
	return { rows: row?.rows ?? 0, latest: row?.latest ?? null };
}

describe("a transition that changes nothing", () => {
	it("writes no second feed row and answers with the existing seq", async () => {
		const org = await createOrgWithOwner(db(), "Acme", userId);
		const written = lesson({ visibility: "org" }) as TLesson;
		await createLessonsWithFeed(db(), userId, [written], org.id);

		const first = await retractOrgLesson(db(), org.id, written.id);
		const afterFirst = await feedFor(written.id);

		const second = await retractOrgLesson(db(), org.id, written.id);

		// The point of the issue: the author's mirror must not learn about a
		// retraction twice.
		expect(second).toBe(first);
		expect(await feedFor(written.id)).toEqual(afterFirst);
	});

	it("answers with the latest status entry, not the earliest", async () => {
		// Distinguishes MAX(seq) from a first-row read. A lesson retracted,
		// reactivated and retracted again has three status entries, and the one
		// describing the state the caller asked for is the last.
		const written = lesson() as TLesson;
		await createLessonsWithFeed(db(), userId, [written]);

		await transitionLesson(db(), userId, written.id, "retracted", null);
		await transitionLesson(db(), userId, written.id, "active", null);
		const third = await transitionLesson(
			db(),
			userId,
			written.id,
			"retracted",
			null,
		);

		const redundant = await transitionLesson(
			db(),
			userId,
			written.id,
			"retracted",
			null,
		);

		expect(redundant).toBe(third);
		expect((await feedFor(written.id)).latest).toBe(third);
	});

	it("still writes when only superseded_by differs", async () => {
		// `retracted` with a superseder and `retracted` with none are different
		// states, and only one of them is what a retract asks for.
		const written = lesson() as TLesson;
		await createLessonsWithFeed(db(), userId, [written]);

		await transitionLesson(db(), userId, written.id, "retracted", "01OTHER");
		const before = await feedFor(written.id);

		const seq = await transitionLesson(
			db(),
			userId,
			written.id,
			"retracted",
			null,
		);

		expect(seq).not.toBe(before.latest);
		expect((await feedFor(written.id)).rows).toBe(before.rows + 1);
		const stored = await probeLessonId(db(), written.id);
		expect(
			(JSON.parse(stored?.body ?? "{}") as { superseded_by: string | null })
				.superseded_by,
		).toBeNull();
	});

	it("repairs a body whose status has drifted from its column", async () => {
		// Before this precondition existed, a redundant call happened to fix a
		// drifted body. Skipping on the column alone would preserve the drift
		// instead, so the skip requires both copies to already agree.
		const written = lesson() as TLesson;
		await createLessonsWithFeed(db(), userId, [written]);
		await transitionLesson(db(), userId, written.id, "retracted", null);

		const drifted = await probeLessonId(db(), written.id);
		const body = JSON.parse(drifted?.body ?? "{}") as Record<string, unknown>;
		body.status = "active";
		await db()
			.prepare("UPDATE lessons SET body = ? WHERE id = ?")
			.bind(JSON.stringify(body), written.id)
			.run();

		await transitionLesson(db(), userId, written.id, "retracted", null);

		const repaired = await probeLessonId(db(), written.id);
		expect(repaired?.status).toBe("retracted");
		expect(
			(JSON.parse(repaired?.body ?? "{}") as { status: string }).status,
		).toBe("retracted");
	});
});
```

- [ ] **Step 3: Run them and watch the right ones fail**

```bash
pnpm --filter @onlooker/api exec vitest run src/db/lessons.test.ts
```

Expected: the first two cases FAIL — `second` is a new seq rather than `first`, and the feed has grown a row. The third and fourth PASS already; they pin behavior that must survive the change, which is why they are written now rather than after.

- [ ] **Step 4: Add `currentFeedSeq` to `apps/api/src/db/lessons.ts`**

Place it directly above `transitionLesson` (`:310`), after that function's doc comment block ends:

```ts
/**
 * The seq of the newest feed entry for one lesson, or null if it has none.
 *
 * Scoped by user_id as well as lesson_id: `lesson_feed_lesson_id_idx` is not
 * unique, and the feed's own key is (user_id, seq), so a question about one
 * person's lesson must not be answered out of anybody else's stream.
 *
 * MAX rather than the first row. A lesson retracted, reactivated and retracted
 * again has several status entries, and the one describing the state a caller
 * just asked for is the latest of them.
 */
async function currentFeedSeq(
	db: D1Database,
	userId: string,
	lessonId: string,
): Promise<number | null> {
	const row = await db
		.prepare(
			"SELECT MAX(seq) AS seq FROM lesson_feed WHERE user_id = ? AND lesson_id = ?",
		)
		.bind(userId, lessonId)
		.first<{ seq: number | null }>();
	return row?.seq ?? null;
}
```

- [ ] **Step 5: Add the precondition inside `transitionLesson`**

Replace the two lines that parse the body (`:320-322`) with:

```ts
	const body = JSON.parse(existing.body) as Record<string, unknown>;

	// Nothing to change, so nothing is written. All three retract paths arrive
	// here - the author's own transition, retractAnyLesson for the operator and
	// retractOrgLesson for an org owner - and before this, a redundant call
	// from any of them appended a second lesson_feed row for a state change
	// that did not happen, telling the author's mirror about one retraction
	// twice (ONL-145). No second click is needed to reach it: an operator
	// retract landing while an owner holds a loaded page leaves that page
	// offering a control whose precondition has since stopped holding.
	//
	// BOTH copies of the state have to agree before this skips. `status` is a
	// column AND a field inside the stored body, and a redundant call used to
	// repair a body that had drifted from its column - skipping on the column
	// alone would quietly preserve the drift. `superseded_by` has no column at
	// all, only the body, so it is read from there.
	if (
		existing.status === status &&
		body.status === status &&
		(body.superseded_by ?? null) === supersededBy
	) {
		const seq = await currentFeedSeq(db, userId, id);
		// A lesson with no feed entry cannot be reported as idempotent: null is
		// this function's "no such lesson" answer and the routes turn it into a
		// 404, which would be a lie about a lesson that demonstrably exists.
		// createLessonsWithFeed always writes one, so this is unreachable
		// today; if it ever happens, falling through writes the entry the
		// author's mirror is missing instead of hiding the lesson.
		if (seq !== null) return seq;
	}

	body.status = status;
	body.superseded_by = supersededBy;
```

- [ ] **Step 6: Run the tests and watch all four pass**

```bash
pnpm --filter @onlooker/api exec vitest run src/db/lessons.test.ts
```

Expected: PASS, including the two that were already green in Step 3.

- [ ] **Step 7: Prove the skip is load-bearing (ablation)**

Temporarily change `body.status === status` in the new condition to `true`, then re-run Step 6. Expected: the "repairs a body whose status has drifted" case FAILS. Revert the change immediately and re-run to confirm green.

This is the step that distinguishes a test that passes because the code is right from one that would pass either way.

- [ ] **Step 8: All four gates**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

The full suite matters more than usual here: `transitionLesson` is also the author's `PATCH /api/lessons/:id/status` path, so `routes/lessons-status.test.ts`, `routes/admin-moderation.test.ts`, `routes/orgs-lessons.test.ts` and `db/lessons-browser.test.ts` all exercise the function just changed. If any of them asserted that a redundant transition mints a new seq, that assertion was describing the defect — update it and say so in the commit body.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/db/lessons.ts apps/api/src/db/lessons.test.ts
```

Then `/git-workflow:commit`. Body says `Fixes onlooker-4lgc3z`, references ONL-145, and names the two conditions (`superseded_by` has no column; the body counts as well as the column).

- [ ] **Step 10: PR and close**

`/git-workflow:pr`, then:

```bash
bd close onlooker-4lgc3z --reason="Shipped in PR <number>"
```

---

### Task 3: ONL-146 — the window, stated and asserted

Bead `onlooker-80b1o8`. Spec decisions D1, D2, D3. **No behavior changes in this task.**

**Files:**
- Modify: `apps/api/src/routes/account.ts:291-294`
- Modify: `apps/api/src/db/queries.test.ts:350-352` — comment only
- Modify: `packages/api-contract/src/index.ts` — the `SESSION_LIFECYCLE` preamble (`:177-208`)
- Modify: `ENVIRONMENT_VARIABLES.md:327-332`
- Modify: `apps/web/src/api/mockApi.ts:420-427` — comment only
- Modify: `apps/api/src/test-support/orgs.ts` — `signup()` returns the refresh token
- Modify: `apps/api/src/routes/account-deletion.test.ts` — the new assertions

**Interfaces:**
- Produces: `SignedUpUser` gains `refreshToken: string`. Additive, so existing destructuring of `{ id, token }` across the org suites keeps compiling.
- Consumes: `call(path, token, init)` and `signup(email, name)` from `../test-support/orgs.js`; `deleteAccount(token)`, already defined locally in `account-deletion.test.ts:45`.

- [ ] **Step 1: Branch**

```bash
git switch -c meagan/onl-146-deleted-token-window
```

- [ ] **Step 2: Extend the test-support `signup` helper**

In `apps/api/src/test-support/orgs.ts`, change the interface (`:11-14`) and the return (`:33-37`):

```ts
export interface SignedUpUser {
	id: string;
	token: string;
	/**
	 * The refresh token signup handed back. Needed by suites that assert what
	 * a session survives: the access token cannot be withdrawn, so the refresh
	 * token is the half of the pair that deletion actually ends.
	 */
	refreshToken: string;
}
```

```ts
	const body = (await response.json()) as {
		token: string;
		refreshToken: string;
		user: { id: string };
	};
	return { id: body.user.id, token: body.token, refreshToken: body.refreshToken };
```

- [ ] **Step 3: Write the failing test**

Append to `apps/api/src/routes/account-deletion.test.ts`:

```ts
describe("what a deleted account's credentials can still do", () => {
	// A RECORDED DECISION, not an accident, and asserted here because nothing
	// said it in either direction before. packages/api-contract's
	// SESSION_LIFECYCLE preamble argues it out: a stateless JWT cannot be
	// withdrawn without a per-request lookup, so the access token stays valid
	// for the rest of its short life and TOKEN_EXPIRY_MINUTES (15) is the
	// bound. ONL-146 asked whether deletion should be the exception. It should
	// not, for the same cost reason - so this test exists to make the window a
	// property somebody chose rather than a surprise somebody finds in
	// production.
	it("still authenticates with the access token, and cannot refresh", async () => {
		const response = await deleteAccount(ada.token);
		expect(response.status).toBe(200);

		// The window. Reads scoped to a user_id that no longer exists come back
		// empty rather than erroring, which is why the impact is a 200 with
		// nothing in it rather than access to anything.
		const during = await call("/api/orgs", ada.token);
		expect(during.status).toBe(200);
		expect(await during.json()).toMatchObject({ orgs: [] });

		// And the bound: sessions cascade with the user, so the pair cannot
		// renew itself and the window cannot be extended past the access
		// token's own lifetime.
		const refresh = await call("/auth/refresh", null, {
			method: "POST",
			body: JSON.stringify({ refreshToken: ada.refreshToken }),
		});
		expect(refresh.status).toBe(401);
	});

	it("keeps authenticating after an anonymizing deletion too", async () => {
		// The case an existence check would have missed. An account holding an
		// org-shared lesson is anonymized rather than deleted - the users row
		// survives as the lesson's anchor - so "does the subject still exist"
		// answers yes here and would close nothing. See D2 in the design.
		// bob owns the org, so ada is a member rather than a sole owner and the
		// delete is not refused with 409 - it takes the anonymize path instead.
		const orgId = await createOrg(bob.token, "Globex");
		await addMembership(db(), orgId, ada.id, "member");
		await createLessonsWithFeed(
			db(),
			ada.id,
			[lesson({ visibility: "org" }) as TLesson],
			orgId,
		);

		const response = await deleteAccount(ada.token);
		expect(response.status).toBe(200);

		const after = await call("/api/orgs", ada.token);
		expect(after.status).toBe(200);
	});
});
```

Every import this needs — `call`, `signup`, `addMembership`, `createLessonsWithFeed`, `lesson`, `TLesson`, `db` — is already at the top of that file, as is the local `deleteAccount` helper (`:45`) and `createOrg` (`:48`). Only `ada.refreshToken` is new, and Step 2 supplies it.

- [ ] **Step 4: Run it**

```bash
pnpm --filter @onlooker/api exec vitest run src/routes/account-deletion.test.ts
```

Expected: PASS on the first run, because this task asserts behavior that already exists. That is the point and also the risk — a test that passes immediately proves nothing until you have seen it able to fail. Do Step 5 before believing it.

- [ ] **Step 5: Prove the test can fail (ablation)**

Temporarily add to `requireAuth` in `apps/api/src/middleware/auth.ts`, right after the payload check:

```ts
	const subject = await env.DB.prepare("SELECT id FROM users WHERE id = ?")
		.bind(payload.sub)
		.first();
	if (!subject) throw new ApiError(401, "invalid_token", "ablation");
```

Re-run Step 4. Expected: the first case FAILS at `expect(during.status).toBe(200)` with 401 — which also demonstrates the rejected D1 option working. The second case still PASSES, which is the anonymize wrinkle made visible: the row survives, so an existence check lets that token through.

Remove the ablation and re-run to confirm green. **Do not commit it.**

- [ ] **Step 6: Rewrite both over-promising comments**

Two files say a version of the same wrong thing. Fix them together — they are one claim in two places, and fixing one would leave the other as the authority a reader finds first.

**6a.** In `apps/api/src/db/queries.test.ts`, replace the comment above `it("takes the user's sessions with it")` (`:350-352`). It currently ends "if the foreign key ever loses ON DELETE CASCADE, a deleted account keeps working sessions", and the test under it stores a *refresh* token and asserts that token is gone:

```ts
	// The schema cascades sessions from users. Asserted because it is the whole
	// reason deletion does not need to sweep them itself - if the foreign key
	// ever loses ON DELETE CASCADE, a deleted account could go on RENEWING.
	//
	// Renewing is the whole of what this protects, and it is worth saying so
	// precisely: the access token already in the caller's hand is a stateless
	// JWT that this cascade does not touch and no write can withdraw. It keeps
	// authenticating for up to TOKEN_EXPIRY_MINUTES either way. That window is
	// deliberate (SESSION_LIFECYCLE in packages/api-contract) and asserted in
	// routes/account-deletion.test.ts. ONL-146.
```

**6b.** In `apps/api/src/routes/account.ts`, replace the first paragraph of the comment inside `handleDeleteAccount` (`:291-294`):

```ts
	// Sessions and verification tokens both cascade from users, so this takes
	// them with it - queries.test asserts the constraint rather than trusting
	// it. What that buys is bounded, and the old wording here implied more: a
	// session is a REFRESH token, and the access token the caller is holding is
	// a stateless JWT that no write can withdraw. So this call ends the
	// account's ability to RENEW, and the token in the caller's hand keeps
	// authenticating for the rest of TOKEN_EXPIRY_MINUTES (15).
	//
	// That residual window is a decision, not an oversight - see
	// SESSION_LIFECYCLE in packages/api-contract, which weighed a denylist
	// against a per-request lookup and took the short lifetime instead.
	// routes/account-deletion.test.ts asserts both halves, so neither can
	// change silently. ONL-146.
```

- [ ] **Step 7: Record the anonymize predicate in the contract**

In `packages/api-contract/src/index.ts`, extend the `SESSION_LIFECYCLE` preamble immediately after the existing sentence ending "TOKEN_REVOCATION in WorkerEnv is where a denylist would go if that trade ever changes." (`:199-203`):

```
 *
 *   Account deletion does not change this, and the check it tempts you toward
 *   is the wrong one. "Does the subject still exist" looks like a cheap
 *   denylist and is not one: deleteUser ANONYMIZES rather than deletes when the
 *   account holds a lesson shared with an org, because the org's lessons need
 *   an anchor, so the users row survives with anonymized_at set and an
 *   existence check waves that token straight through. Anything built here
 *   needs `exists AND anonymized_at IS NULL`. ONL-146.
 *
 *   ONE KNOWN DIVERGENCE, deliberate. apps/web's mock deletes its user record
 *   on DELETE /auth/account and its requireAuth resolves the user from that
 *   record, so the mock answers 401 where the API answers 200 for up to fifteen
 *   minutes. No contract case pins this, because there is no shared number to
 *   pin. Teaching the mock to match would mean honoring a deleted user's token
 *   for the rest of the dev session: the mock has no clock, cannot express
 *   "valid for 15 more minutes", and would be lying in the other direction.
```

- [ ] **Step 8: Record the same predicate where the binding is documented**

In `ENVIRONMENT_VARIABLES.md`, extend the `TOKEN_REVOCATION` paragraph at `:327-332` with:

```markdown
If that trade is ever revisited, note that the predicate is not simply "the
subject exists": `deleteUser` anonymizes rather than deletes an account that
holds a lesson shared with an org, so the `users` row survives with
`anonymized_at` set. A revocation check keyed on existence alone closes the
window for hard deletes and silently misses every anonymized account. ONL-146.
```

- [ ] **Step 9: Point the mock at the recorded divergence**

In `apps/web/src/api/mockApi.ts`, replace the comment above the delete branch (`:420`):

```ts
	// DELETE /auth/account — remove the user and end all sessions.
	//
	// STRICTER THAN THE API ON PURPOSE. requireAuth above resolves the user
	// from MOCK_USERS, so deleting the record makes the next authenticated call
	// 401 here, while apps/api keeps honoring that access token for up to
	// TOKEN_EXPIRY_MINUTES (15) because a stateless JWT cannot be withdrawn.
	// The divergence is recorded beside SESSION_LIFECYCLE in
	// packages/api-contract, with the reason: this mock has no clock, so
	// matching the API would mean honoring the token for the whole dev session.
	// ONL-146.
```

- [ ] **Step 10: Gates, across three packages**

```bash
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
pnpm --filter @onlooker/web test
pnpm --filter @onlooker/web typecheck
pnpm --filter @onlooker/web lint
pnpm --filter @onlooker/api-contract test
pnpm --filter @onlooker/api-contract typecheck
pnpm --filter @onlooker/api-contract lint
bash scripts/source-guards.test.sh
```

All three workspaces declare `test`, `typecheck` and `lint`, so every command above runs something real. `@onlooker/api-contract` is the one to watch: its suite drives both the mock and `SELF` against the same case list, so a change to its preamble that accidentally touched a `SESSION_LIFECYCLE` value would fail there rather than in `apps/api`.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/routes/account.ts \
        apps/api/src/routes/account-deletion.test.ts \
        apps/api/src/db/queries.test.ts \
        apps/api/src/test-support/orgs.ts \
        packages/api-contract/src/index.ts \
        apps/web/src/api/mockApi.ts \
        ENVIRONMENT_VARIABLES.md
```

Then `/git-workflow:commit`. The body carries the reasoning: the window stays, the comment stopped over-promising, the anonymize predicate is now recorded in both places a future denylist author would look, and the mock divergence is deliberate. `Fixes onlooker-80b1o8`, references ONL-146.

Verify nothing from Step 5's ablation is staged: `git diff --cached apps/api/src/middleware/auth.ts` must print nothing.

- [ ] **Step 12: PR and close**

`/git-workflow:pr`, then:

```bash
bd close onlooker-80b1o8 --reason="Shipped in PR <number>"
```

---

## After all three

- [ ] Confirm the three Linear issues moved to Done by their PR links; if not, move them by hand.
- [ ] `bd ready` to see what the closures unblocked.
- [ ] ONL-148 and ONL-149 are the two remaining deletion follow-ups, both P4, deliberately out of scope here.
