# Org Accounts Implementation Plan — Stage 1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build organizations, membership with roles, and email invitations, so that `OrgIds` has something real to resolve in Stage 2.

**Architecture:** Three new tables (`orgs`, `org_memberships`, `org_invites`) behind one data module (`apps/api/src/db/orgs.ts`) and one authorization chokepoint (`apps/api/src/orgs/authorize.ts`). Eleven routes under `/api/orgs`, each declaring `auth` and `cors` in the route table and calling `requireOrgRole` as its first statement. Invitations reuse the existing hashed-token and `sendEmail` primitives. **This stage touches nothing about lessons and discloses no lesson content** — an org with members but no lesson tier shares nothing.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (SQLite), Drizzle ORM, Vitest with `@cloudflare/vitest-pool-workers`, Biome, React (apps/web).

Spec: `docs/superpowers/specs/2026-10-04-org-visibility-tier-design.md`
Bead: `onlooker-wi9ftq` ([ONL-12](https://linear.app/onlooker/issue/ONL-12))

## Global Constraints

- **Four gates, not three.** `pnpm --filter <pkg> test`, `pnpm --filter <pkg> typecheck`, `pnpm --filter <pkg> lint`, and `bash scripts/source-guards.test.sh`. The fourth is wired into no pnpm script — it runs as a bare bash step in `.github/workflows/deploy.yml`, so no local sweep and no diff review reaches it. It is what failed PR #188 after six reviews passed it.
- **Commits route through the `/git-workflow:commit` skill**, never an ad hoc `git commit -m`. This applies to subagents too. If that skill is not in your list, mirror its contract manually: `<type>(<scope>): <subject> :emoji:`, American English, why-focused body — and say that you did so.
- **American English** in commits, comments, identifiers and docs.
- **Edit tracked files with `Edit`/`Write`/`MultiEdit`, never `sed -i` or a heredoc.** The `lineage` and `inspector` plugins hook `PostToolUse` on those tools specifically; a shell edit moves the same bytes invisibly and `/lineage <file>:<line>` then answers "no record" for a line that was demonstrably written.
- **Never retype the value of `TEST_PASSWORD`.** Import it from `apps/api/src/test-support/lessons.ts`. The secret-scanning hook blocks any write containing the literal, and it scans the whole `new_string` of an `Edit` — so even an untouched credential line used as surrounding context fails the write.
- **This stage must not touch `lessons`, `lesson_feed`, `pool.ts`, or `routes/lessons.ts`.** `scripts/source-guards.test.sh` enforces that no file under `apps/api/src` outside the named owners queries `lessons` or `lesson_feed`. Stage 1 has no reason to, and a stray join fails CI.
- **`role` is `"owner" | "member"`.** Stored as text; validated at every boundary.
- **404, never 403, for an org you may not touch.** Matching the operator surface at `router.ts:372`: an org you do not belong to should not confirm that it exists.
- Migrations are read from `packages/db/migrations` at vitest config time and applied per suite by `apps/api/test/apply-migrations.ts`, so a newly generated migration is picked up with no test-harness change.
- Table state persists between tests within a file. Every test file clears what it writes in `beforeEach`, via `resetOrgTables()` from `apps/api/src/test-support/orgs.ts` (created in Task 1).
- **Shared org test helpers live in `apps/api/src/test-support/orgs.ts`** — `signup()`, `call()`, `resetOrgTables()`. Import them; do not redefine them per test file. Task 1 creates the module.
- **`pnpm build` before the first test run in a fresh checkout.** `packages/db`'s tests import `../dist/schema.js`, and `dist/` is gitignored, so a fresh worktree fails 34 api files and 1 db file with `Cannot find module` until `pnpm build` runs at the repo root. Measured 2026-10-04 on this branch's worktree.
- **Never judge a suite by a piped command's exit code.** `pnpm test | tail` exits with `tail`'s status, so a failing suite reads as success and an `&&` chain walks straight past it. Read the `Tests` line, or run the command unpiped.
- **`pnpm --filter @onlooker/db build` before `generate:expected-schema`.** That script reads `packages/db/dist/`, not `src/`, so regenerating against an unbuilt package silently writes a snapshot of the *previous* schema — and the deployed-schema drift check then passes against stale truth, which is worse than failing. Measured 2026-10-04 during Task 1.
- `env` and `SELF` from `cloudflare:test` are marked `@deprecated` by the installed `@cloudflare/vitest-pool-workers` types. 27 files in `apps/api/src` already import them that way; follow that pattern. Migrating off it is a repo-wide change and explicitly not this plan's work.

---

### Task 1: Schema — orgs, memberships, invites

**Files:**
- Modify: `packages/db/src/schema.ts` (append after `session_summaries`)
- Modify: `packages/db/src/expected-schema.ts` (regenerated, not hand-edited)
- Create: `packages/db/migrations/0010_*.sql` (generated)
- Create: `apps/api/src/test-support/orgs.ts`
- Create: `apps/api/src/db/orgs-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - the Drizzle tables `orgs`, `org_memberships`, `org_invites`, exported from `@onlooker/db`. Columns exactly as written in Step 3.
  - `apps/api/src/test-support/orgs.ts` exporting `signup(email, name?): Promise<{ id: string; token: string }>`, `call(path, token, init?): Promise<Response>`, and `resetOrgTables(): Promise<void>`. **Every later task imports these rather than redefining them.**

- [ ] **Step 0: Create the shared test helpers**

Five later test files need the same signup-over-HTTP and authenticated-call helpers. They live in one module so a change to the signup response shape is one edit rather than five.

Create `apps/api/src/test-support/orgs.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { BASE, TEST_PASSWORD } from "./lessons.js";

/**
 * Shared fixtures for the org suites.
 *
 * `TEST_PASSWORD` is imported, never retyped - the secret-scanning hook blocks
 * any write containing its literal value.
 */

export interface SignedUpUser {
	id: string;
	token: string;
}

/** Create an account through the real signup route; return its id and access token. */
export async function signup(
	email: string,
	name = "Ada",
): Promise<SignedUpUser> {
	const response = await SELF.fetch(`${BASE}/auth/signup`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password: TEST_PASSWORD, name }),
	});
	const body = (await response.json()) as {
		token: string;
		user: { id: string };
	};
	return { id: body.user.id, token: body.token };
}

/** A JSON request. Pass null for `token` to call anonymously. */
export function call(
	path: string,
	token: string | null,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Content-Type", "application/json");
	if (token) headers.set("Authorization", `Bearer ${token}`);
	return SELF.fetch(`${BASE}${path}`, { ...init, headers });
}

/**
 * Clear the org tables and users, in foreign-key order.
 *
 * Table state persists between tests within a file, so every org suite calls
 * this in beforeEach.
 */
export async function resetOrgTables(): Promise<void> {
	const db = env.DB;
	await db.prepare("DELETE FROM org_invites").run();
	await db.prepare("DELETE FROM org_memberships").run();
	await db.prepare("DELETE FROM orgs").run();
	await db.prepare("DELETE FROM users").run();
}
```

This file is not `*.test.ts`, so `scripts/source-guards.test.sh` does scan it — but its matcher only recognizes queries against `lessons` and `lesson_feed`, and nothing here touches either.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/db/orgs-schema.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetOrgTables } from "../test-support/orgs.js";

const db = () => env.DB;

beforeEach(resetOrgTables);

async function seedOrgAndUser(): Promise<{ orgId: string; userId: string }> {
	const orgId = crypto.randomUUID();
	const userId = crypto.randomUUID();
	await db()
		.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)")
		.bind(orgId, "Acme")
		.run();
	await db()
		.prepare(
			"INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)",
		)
		.bind(userId, "member@example.com", "hash")
		.run();
	return { orgId, userId };
}

describe("org schema", () => {
	it("holds one membership per (org, user) pair", async () => {
		const { orgId, userId } = await seedOrgAndUser();
		const insert = (id: string) =>
			db()
				.prepare(
					"INSERT INTO org_memberships (id, org_id, user_id, role) VALUES (?, ?, ?, ?)",
				)
				.bind(id, orgId, userId, "member")
				.run();

		await insert(crypto.randomUUID());

		// A second row for the same pair would let a removal leave someone a
		// member, so the constraint is the correctness mechanism rather than a
		// tidiness preference.
		await expect(insert(crypto.randomUUID())).rejects.toThrow();
	});

	it("cascades memberships when the org goes", async () => {
		const { orgId, userId } = await seedOrgAndUser();
		await db()
			.prepare(
				"INSERT INTO org_memberships (id, org_id, user_id, role) VALUES (?, ?, ?, ?)",
			)
			.bind(crypto.randomUUID(), orgId, userId, "owner")
			.run();

		await db().prepare("DELETE FROM orgs WHERE id = ?").bind(orgId).run();

		const left = await db()
			.prepare("SELECT COUNT(*) AS n FROM org_memberships")
			.first<{ n: number }>();
		expect(left?.n).toBe(0);
	});

	it("rejects two invites sharing a token hash", async () => {
		const { orgId, userId } = await seedOrgAndUser();
		const insert = (id: string, email: string) =>
			db()
				.prepare(
					"INSERT INTO org_invites (id, org_id, email, role, token_hash, expires_at, invited_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(id, orgId, email, "member", "same-hash", "2030-01-01T00:00:00.000Z", userId)
				.run();

		await insert(crypto.randomUUID(), "one@example.com");
		await expect(
			insert(crypto.randomUUID(), "two@example.com"),
		).rejects.toThrow();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @onlooker/api test src/db/orgs-schema.test.ts`
Expected: FAIL — `no such table: org_invites`.

- [ ] **Step 3: Add the tables**

Append to `packages/db/src/schema.ts`. `index` and `uniqueIndex` are already imported at the top of that file.

```ts
/**
 * An organization - the unit a lesson can be shared with.
 *
 * Deliberately thin. `name` is all a member ever sees: there is no slug,
 * because nothing addresses an org by URL, and no settings column, because the
 * only tunable - the invite window - is environment configuration. See
 * docs/superpowers/specs/2026-10-04-org-visibility-tier-design.md.
 */
export const orgs = sqliteTable(
	"orgs",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
		updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	},
	(table) => ({
		createdAtIdx: index("orgs_created_at_idx").on(table.created_at),
	}),
);

/**
 * Who belongs to an org, and with what authority.
 *
 * UNIQUE(org_id, user_id) is what makes membership a fact rather than a count:
 * two rows for the same pair would let one removal leave somebody still a
 * member, and the role read would depend on which row came back first.
 *
 * INDEX(user_id) is the read the visibility predicate will depend on in stage
 * 2 - resolving "which orgs is this caller in" happens on every authenticated
 * pool read, so it must not scan.
 *
 * `role` holds 'owner' or 'member'. Not an enum, because SQLite has none; the
 * values are validated at every boundary that writes them.
 */
export const org_memberships = sqliteTable(
	"org_memberships",
	{
		id: text("id").primaryKey(),
		org_id: text("org_id")
			.notNull()
			.references(() => orgs.id, { onDelete: "cascade" }),
		user_id: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text("role").notNull(),
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	},
	(table) => ({
		orgUserIdx: uniqueIndex("org_memberships_org_user_idx").on(
			table.org_id,
			table.user_id,
		),
		userIdIdx: index("org_memberships_user_id_idx").on(table.user_id),
	}),
);

/**
 * A pending invitation to join an org.
 *
 * Its own table rather than a `verification_tokens` row, because that table is
 * keyed to a `user_id` and an invitee may have no account yet.
 *
 * `token_hash`, never the token: whoever holds the raw value can join an org,
 * so a read of this table must not produce working invitations. Same
 * discipline as `sessions` and `verification_tokens`.
 *
 * The token is NOT the whole credential. Accepting also requires a session
 * whose email matches `email`, so a forwarded or leaked link does nothing for
 * anyone but the addressee. See routes/orgs-invites.ts.
 *
 * `expires_at` is an ISO string, so expiry is compared in TypeScript rather
 * than SQL - the same reason db/queries.ts:180 gives, since a SQL comparison
 * here would be lexicographic.
 */
export const org_invites = sqliteTable(
	"org_invites",
	{
		id: text("id").primaryKey(),
		org_id: text("org_id")
			.notNull()
			.references(() => orgs.id, { onDelete: "cascade" }),
		email: text("email").notNull(),
		role: text("role").notNull(),
		token_hash: text("token_hash").notNull(),
		expires_at: text("expires_at").notNull(),
		invited_by: text("invited_by")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		accepted_at: text("accepted_at"),
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	},
	(table) => ({
		tokenHashIdx: uniqueIndex("org_invites_token_hash_idx").on(
			table.token_hash,
		),
		orgEmailIdx: index("org_invites_org_email_idx").on(
			table.org_id,
			table.email,
		),
	}),
);
```

- [ ] **Step 4: Generate the migration and the expected schema**

Run:
```bash
pnpm --filter @onlooker/db generate:migrations
pnpm --filter @onlooker/db generate:expected-schema
```
Expected: a new `packages/db/migrations/0010_*.sql` creating three tables and five indexes (one on `orgs`, two on `org_memberships`, two on `org_invites`), and a modified `expected-schema.ts`. Read the generated SQL before continuing — confirm it creates `orgs`, `org_memberships`, `org_invites` and does **not** alter `lessons`.

`generate:expected-schema` reads `packages/db/dist/`, **not** `src/` — so build the package first (`pnpm --filter @onlooker/db build`) or it silently writes a snapshot of the previous schema and the drift check passes against stale truth. Measured 2026-10-04 during Task 1.

`packages/db/src/__tests__/schema.test.ts` carries a whole-schema table count ("declares only the N tables in use"), deliberately, so a deferred table cannot reappear by accident. Three new tables means that number moves from 8 to 11, with the reason in its comment. It is not in this task's Files list above because the count is a consequence of the schema edit rather than a separate decision — but the db gate fails until it is updated.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @onlooker/api test src/db/orgs-schema.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Run the full gates**

Run:
```bash
pnpm --filter @onlooker/db test && pnpm --filter @onlooker/db typecheck && pnpm --filter @onlooker/db lint
pnpm --filter @onlooker/api test && pnpm --filter @onlooker/api typecheck && pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```
Expected: all pass. Biome emits 9 pre-existing `noExplicitAny` warnings in apps/web and 3 in apps/api — warnings do not fail the gate, only errors do.

- [ ] **Step 7: Commit**

Stage `packages/db/src/schema.ts`, `packages/db/src/expected-schema.ts`, the new migration and its meta snapshot, and `apps/api/src/db/orgs-schema.test.ts`. Then run `/git-workflow:commit`.

---

### Task 2: The org data layer

**Files:**
- Create: `apps/api/src/db/orgs.ts`
- Create: `apps/api/src/db/orgs.test.ts`

**Interfaces:**
- Consumes: the tables from Task 1; `client` from `./client.js`.
- Produces:
  - `type OrgRole = "owner" | "member"`
  - `isOrgRole(value: unknown): value is OrgRole`
  - `interface OrgSummary { id: string; name: string; role: OrgRole }`
  - `interface OrgMemberRow { user_id: string; name: string | null; email: string; role: OrgRole; created_at: string }`
  - `createOrgWithOwner(db, name, userId): Promise<{ id: string; name: string }>`
  - `listOrgsForUser(db, userId): Promise<OrgSummary[]>`
  - `getMembership(db, orgId, userId): Promise<{ role: OrgRole } | null>`
  - `listMembers(db, orgId): Promise<OrgMemberRow[]>`
  - `renameOrg(db, orgId, name): Promise<boolean>`
  - `addMembership(db, orgId, userId, role): Promise<void>`
  - `removeMembership(db, orgId, userId): Promise<boolean>`
  - `setMemberRole(db, orgId, userId, role): Promise<boolean>`
  - `countOwners(db, orgId): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/db/orgs.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	addMembership,
	countOwners,
	createOrgWithOwner,
	getMembership,
	listMembers,
	listOrgsForUser,
	removeMembership,
	renameOrg,
	setMemberRole,
} from "./orgs.js";
import { createUser } from "./queries.js";
import { resetOrgTables } from "../test-support/orgs.js";

const db = () => env.DB;
let ada: string;
let bob: string;

beforeEach(async () => {
	await resetOrgTables();
	ada = (await createUser(db(), "ada@example.com", "hash", "Ada")).id;
	bob = (await createUser(db(), "bob@example.com", "hash", "Bob")).id;
});

describe("createOrgWithOwner", () => {
	it("makes the creator an owner", async () => {
		const org = await createOrgWithOwner(db(), "Acme", ada);
		expect(await getMembership(db(), org.id, ada)).toEqual({ role: "owner" });
	});

	it("writes the org and its owner atomically", async () => {
		// A bare pair of inserts can leave an org with no owner, which nobody can
		// administer and no route can repair. The batch is the guard, so this
		// asserts the invariant rather than the implementation: every org that
		// exists has at least one owner.
		await createOrgWithOwner(db(), "Acme", ada);
		const orphans = await db()
			.prepare(
				"SELECT COUNT(*) AS n FROM orgs o WHERE NOT EXISTS (SELECT 1 FROM org_memberships m WHERE m.org_id = o.id AND m.role = 'owner')",
			)
			.first<{ n: number }>();
		expect(orphans?.n).toBe(0);
	});
});

describe("listOrgsForUser", () => {
	it("returns each org with the caller's own role", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		const beta = await createOrgWithOwner(db(), "Beta", bob);
		await addMembership(db(), beta.id, ada, "member");

		const mine = await listOrgsForUser(db(), ada);
		expect(mine).toEqual(
			expect.arrayContaining([
				{ id: acme.id, name: "Acme", role: "owner" },
				{ id: beta.id, name: "Beta", role: "member" },
			]),
		);
		expect(mine).toHaveLength(2);
	});

	it("returns nothing for a user in no org", async () => {
		await createOrgWithOwner(db(), "Acme", ada);
		expect(await listOrgsForUser(db(), bob)).toEqual([]);
	});
});

describe("getMembership", () => {
	it("is null across an org boundary", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		expect(await getMembership(db(), acme.id, bob)).toBeNull();
	});
});

describe("listMembers", () => {
	it("names each member", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), acme.id, bob, "member");

		const members = await listMembers(db(), acme.id);
		expect(members.map((m) => [m.email, m.role, m.name])).toEqual(
			expect.arrayContaining([
				["ada@example.com", "owner", "Ada"],
				["bob@example.com", "member", "Bob"],
			]),
		);
	});
});

describe("renameOrg", () => {
	it("renames, and reports an unknown org", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		expect(await renameOrg(db(), acme.id, "Acme Inc")).toBe(true);
		expect((await listOrgsForUser(db(), ada))[0].name).toBe("Acme Inc");
		expect(await renameOrg(db(), crypto.randomUUID(), "Ghost")).toBe(false);
	});
});

describe("setMemberRole and countOwners", () => {
	it("promotes, demotes, and counts owners", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), acme.id, bob, "member");
		expect(await countOwners(db(), acme.id)).toBe(1);

		expect(await setMemberRole(db(), acme.id, bob, "owner")).toBe(true);
		expect(await countOwners(db(), acme.id)).toBe(2);

		expect(await setMemberRole(db(), acme.id, bob, "member")).toBe(true);
		expect(await countOwners(db(), acme.id)).toBe(1);
	});

	it("reports a non-member", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		expect(await setMemberRole(db(), acme.id, bob, "owner")).toBe(false);
	});
});

describe("removeMembership", () => {
	it("removes a member, and reports one who was not there", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), acme.id, bob, "member");

		expect(await removeMembership(db(), acme.id, bob)).toBe(true);
		expect(await getMembership(db(), acme.id, bob)).toBeNull();
		expect(await removeMembership(db(), acme.id, bob)).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @onlooker/api test src/db/orgs.test.ts`
Expected: FAIL — cannot resolve `./orgs.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/db/orgs.ts`:

```ts
import type { D1Database } from "@cloudflare/workers-types";
import { org_memberships, orgs, users } from "@onlooker/db";
import { and, eq, sql } from "drizzle-orm";
import { client } from "./client.js";

/**
 * Org membership and roles. The only home for a query against `orgs`,
 * `org_memberships` or `org_invites`.
 *
 * Note what is NOT here: anything touching `lessons`. Stage 2 adds the org
 * disjunct to db/pool.ts, which is the only module allowed to return lesson
 * content - scripts/source-guards.test.sh enforces that boundary, and a join
 * from this file would fail it.
 */

export type OrgRole = "owner" | "member";

/** Whether an arbitrary string is a role this system recognizes. */
export function isOrgRole(value: unknown): value is OrgRole {
	return value === "owner" || value === "member";
}

export interface OrgSummary {
	id: string;
	name: string;
	role: OrgRole;
}

export interface OrgMemberRow {
	user_id: string;
	name: string | null;
	email: string;
	role: OrgRole;
	created_at: string;
}

/**
 * Create an org and make `userId` its first owner, in one batch.
 *
 * The batch is load-bearing rather than an optimization. Two separate inserts
 * can leave an org with no owner if the second fails - and an ownerless org is
 * unadministerable, since every owner route requires an owner to already
 * exist. drizzle's batch() hands its statements to the D1 binding's own
 * batch(), which runs them in one transaction; db/queries.ts:121-133 documents
 * the same reasoning for session rotation.
 */
export async function createOrgWithOwner(
	db: D1Database,
	name: string,
	userId: string,
): Promise<{ id: string; name: string }> {
	const orgId = crypto.randomUUID();
	const now = new Date().toISOString();
	const drizzle = client(db);

	// batch() requires a non-empty tuple rather than a plain array, which is
	// why these are written inline - see db/session-summaries.ts:84.
	await drizzle.batch([
		drizzle
			.insert(orgs)
			.values({ id: orgId, name, created_at: now, updated_at: now }),
		drizzle.insert(org_memberships).values({
			id: crypto.randomUUID(),
			org_id: orgId,
			user_id: userId,
			role: "owner",
			created_at: now,
		}),
	]);

	return { id: orgId, name };
}

/** The orgs this user belongs to, each carrying the user's own role in it. */
export async function listOrgsForUser(
	db: D1Database,
	userId: string,
): Promise<OrgSummary[]> {
	const rows = await client(db)
		.select({
			id: orgs.id,
			name: orgs.name,
			role: org_memberships.role,
		})
		.from(org_memberships)
		.innerJoin(orgs, eq(orgs.id, org_memberships.org_id))
		.where(eq(org_memberships.user_id, userId))
		.orderBy(orgs.name);

	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		role: row.role as OrgRole,
	}));
}

/**
 * This user's role in this org, or null if they are not a member.
 *
 * Null is the only answer for a non-member, and callers turn it into a 404
 * rather than a 403 - see orgs/authorize.ts.
 */
export async function getMembership(
	db: D1Database,
	orgId: string,
	userId: string,
): Promise<{ role: OrgRole } | null> {
	const rows = await client(db)
		.select({ role: org_memberships.role })
		.from(org_memberships)
		.where(
			and(
				eq(org_memberships.org_id, orgId),
				eq(org_memberships.user_id, userId),
			),
		)
		.limit(1);

	const row = rows[0];
	return row ? { role: row.role as OrgRole } : null;
}

/** Everyone in this org, named. */
export async function listMembers(
	db: D1Database,
	orgId: string,
): Promise<OrgMemberRow[]> {
	const rows = await client(db)
		.select({
			user_id: users.id,
			name: users.name,
			email: users.email,
			role: org_memberships.role,
			created_at: org_memberships.created_at,
		})
		.from(org_memberships)
		.innerJoin(users, eq(users.id, org_memberships.user_id))
		.where(eq(org_memberships.org_id, orgId))
		.orderBy(org_memberships.created_at);

	return rows.map((row) => ({
		user_id: row.user_id,
		name: row.name ?? null,
		email: row.email,
		role: row.role as OrgRole,
		created_at: row.created_at,
	}));
}

/** Rename an org. False means no such org. */
export async function renameOrg(
	db: D1Database,
	orgId: string,
	name: string,
): Promise<boolean> {
	const result = await db
		.prepare("UPDATE orgs SET name = ?, updated_at = ? WHERE id = ?")
		.bind(name, new Date().toISOString(), orgId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

/** Add a member. The UNIQUE(org_id, user_id) index rejects a duplicate pair. */
export async function addMembership(
	db: D1Database,
	orgId: string,
	userId: string,
	role: OrgRole,
): Promise<void> {
	await client(db).insert(org_memberships).values({
		id: crypto.randomUUID(),
		org_id: orgId,
		user_id: userId,
		role,
		created_at: new Date().toISOString(),
	});
}

/** Remove a member. False means they were not one. */
export async function removeMembership(
	db: D1Database,
	orgId: string,
	userId: string,
): Promise<boolean> {
	const result = await db
		.prepare("DELETE FROM org_memberships WHERE org_id = ? AND user_id = ?")
		.bind(orgId, userId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

/** Change a member's role. False means they are not a member. */
export async function setMemberRole(
	db: D1Database,
	orgId: string,
	userId: string,
	role: OrgRole,
): Promise<boolean> {
	const result = await db
		.prepare(
			"UPDATE org_memberships SET role = ? WHERE org_id = ? AND user_id = ?",
		)
		.bind(role, orgId, userId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

/**
 * How many owners this org has.
 *
 * Read before a removal or a demotion, so the last owner cannot be taken away
 * and leave the org unadministerable.
 */
export async function countOwners(
	db: D1Database,
	orgId: string,
): Promise<number> {
	const rows = await client(db)
		.select({ n: sql<number>`COUNT(*)` })
		.from(org_memberships)
		.where(
			and(eq(org_memberships.org_id, orgId), eq(org_memberships.role, "owner")),
		);
	return Number(rows[0]?.n ?? 0);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @onlooker/api test src/db/orgs.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the gates and commit**

Run: `pnpm --filter @onlooker/api test && pnpm --filter @onlooker/api typecheck && pnpm --filter @onlooker/api lint && bash scripts/source-guards.test.sh`
Expected: all pass.

Stage `apps/api/src/db/orgs.ts` and `apps/api/src/db/orgs.test.ts`, then run `/git-workflow:commit`.

---

### Task 3: The role chokepoint

**Files:**
- Create: `apps/api/src/orgs/authorize.ts`
- Create: `apps/api/src/orgs/authorize.test.ts`

**Interfaces:**
- Consumes: `getMembership`, `OrgRole` from `../db/orgs.js`; `Principal` from `../db/pool.js`; `ApiError` from `../types`.
- Produces: `requireOrgRole(db, principal, orgId, required): Promise<OrgRole>` — returns the caller's actual role, or throws `ApiError(404, "not_found", …)`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/orgs/authorize.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addMembership, createOrgWithOwner } from "../db/orgs.js";
import { createUser } from "../db/queries.js";
import { resetOrgTables } from "../test-support/orgs.js";
import { ApiError } from "../types";
import { requireOrgRole } from "./authorize.js";

const db = () => env.DB;
let ada: string;
let bob: string;

beforeEach(async () => {
	await resetOrgTables();
	ada = (await createUser(db(), "ada@example.com", "hash", "Ada")).id;
	bob = (await createUser(db(), "bob@example.com", "hash", "Bob")).id;
});

describe("requireOrgRole", () => {
	it("returns the caller's role when it suffices", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		expect(
			await requireOrgRole(db(), { userId: ada }, acme.id, "owner"),
		).toBe("owner");
		expect(
			await requireOrgRole(db(), { userId: ada }, acme.id, "member"),
		).toBe("owner");
	});

	it("404s a non-member rather than confirming the org exists", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		await expect(
			requireOrgRole(db(), { userId: bob }, acme.id, "member"),
		).rejects.toMatchObject({ status: 404 });
	});

	it("404s a plain member asked for owner authority", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), acme.id, bob, "member");
		await expect(
			requireOrgRole(db(), { userId: bob }, acme.id, "owner"),
		).rejects.toMatchObject({ status: 404 });
	});

	it("404s an org that does not exist", async () => {
		await expect(
			requireOrgRole(db(), { userId: ada }, crypto.randomUUID(), "member"),
		).rejects.toBeInstanceOf(ApiError);
	});

	it("404s a null principal", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		await expect(
			requireOrgRole(db(), null, acme.id, "member"),
		).rejects.toMatchObject({ status: 404 });
	});

	it("is byte-identical across every refusal", async () => {
		// A non-member must not be able to tell an org they cannot see from one
		// that does not exist. Comparing the messages is the only way to notice
		// a later edit that makes one of them more specific.
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		const refusals = await Promise.all([
			requireOrgRole(db(), { userId: bob }, acme.id, "member").catch(
				(error: ApiError) => `${error.status} ${error.code} ${error.message}`,
			),
			requireOrgRole(db(), { userId: bob }, crypto.randomUUID(), "member").catch(
				(error: ApiError) => `${error.status} ${error.code} ${error.message}`,
			),
		]);
		expect(refusals[0]).toBe(refusals[1]);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @onlooker/api test src/orgs/authorize.test.ts`
Expected: FAIL — cannot resolve `./authorize.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/orgs/authorize.ts`:

```ts
import type { D1Database } from "@cloudflare/workers-types";
import { getMembership, type OrgRole } from "../db/orgs.js";
import type { Principal } from "../db/pool.js";
import { ApiError } from "../types";

/**
 * The one place an org role is checked.
 *
 * Why this is a function and not a `RouteAuth` value: `dispatch` resolves a
 * principal from the credential alone, before the handler runs. "Owner of the
 * org named in this path" needs a path parameter and a database read, so
 * declaring it in the route table would make that table look authoritative for
 * a question it cannot answer.
 *
 * What keeps this from being the auth-by-omission the shared read path existed
 * to end is not this function - it is the enumerated contract test in
 * routes/orgs-authorization.test.ts, which lists every /api/orgs route with
 * the role it requires and fails when a route is added without an entry.
 *
 * 404, never 403, and the SAME 404 for every refusal: an org you do not belong
 * to should not confirm that it exists, and a non-member must not be able to
 * tell an org they cannot see from one that was never there. That matches the
 * operator surface - see router.ts:372.
 */
export async function requireOrgRole(
	db: D1Database,
	principal: Principal | null,
	orgId: string,
	required: OrgRole,
): Promise<OrgRole> {
	const refuse = () => new ApiError(404, "not_found", "No such org");

	// Routes carrying `auth: "session"` cannot reach here with a null
	// principal, since resolvePrincipal throws first. Handled anyway, because
	// the alternative is a non-null assertion that becomes wrong the day
	// somebody declares an org route `auth: "none"`.
	if (!principal) throw refuse();

	const membership = await getMembership(db, orgId, principal.userId);
	if (!membership) throw refuse();
	if (required === "owner" && membership.role !== "owner") throw refuse();

	return membership.role;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @onlooker/api test src/orgs/authorize.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the gates and commit**

Run: `pnpm --filter @onlooker/api test && pnpm --filter @onlooker/api typecheck && pnpm --filter @onlooker/api lint && bash scripts/source-guards.test.sh`

Stage `apps/api/src/orgs/authorize.ts` and its test, then run `/git-workflow:commit`.

---

### Task 4: Org routes — create, list, rename

**Files:**
- Create: `apps/api/src/routes/orgs.ts`
- Create: `apps/api/src/routes/orgs.test.ts`
- Modify: `apps/api/src/routes/index.ts` (add exports)
- Modify: `apps/api/src/router.ts` (add three route entries and their imports)
- Modify: `packages/api-contract/src/index.ts` (add the org contract cases)

**Interfaces:**
- Consumes: `createOrgWithOwner`, `listOrgsForUser`, `renameOrg` from `../db/orgs.js`; `requireOrgRole` from `../orgs/authorize.js`.
- Produces: `handleCreateOrg`, `handleListOrgs`, `handleRenameOrg`; exported `ORG_NAME_MAX_LENGTH = 100`; the contract case group `ORG_LIFECYCLE`.

- [ ] **Step 0: Harden the shared `signup()` helper**

Carried from Task 1's review as a Minor finding, actioned here because this is the first task that depends on the helper and four more follow.

`signup()` in `apps/api/src/test-support/orgs.ts` parses `response.json()` unconditionally and destructures `{ token, user: { id } }`. When a signup fails — a duplicate address because a suite did not isolate, a 400 from a changed contract — the failure surfaces much later as `Cannot read properties of undefined`, in a different test, pointing nowhere near the cause.

Add a status check that fails at the point of failure:

```ts
	if (!response.ok) {
		throw new Error(
			`signup(${email}) failed: ${response.status} ${await response.text()}`,
		);
	}
```

Place it immediately after the `SELF.fetch` call, before the `response.json()`. Nothing else about the helper changes, and no existing test should change behavior — if one does, it was depending on a silently failed signup and that is worth knowing.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/orgs.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { call, resetOrgTables, signup } from "../test-support/orgs.js";

let adaToken: string;
let bobToken: string;

beforeEach(async () => {
	await resetOrgTables();
	adaToken = (await signup("ada@example.com")).token;
	bobToken = (await signup("bob@example.com")).token;
});

async function createOrg(token: string, name = "Acme"): Promise<string> {
	const response = await call("/api/orgs", token, {
		method: "POST",
		body: JSON.stringify({ name }),
	});
	expect(response.status).toBe(201);
	const body = (await response.json()) as { org: { id: string } };
	return body.org.id;
}

describe("POST /api/orgs", () => {
	it("creates an org with the caller as owner", async () => {
		const response = await call("/api/orgs", adaToken, {
			method: "POST",
			body: JSON.stringify({ name: "Acme" }),
		});
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			org: { name: "Acme", role: "owner" },
		});
	});

	it("401s without a credential", async () => {
		const response = await call("/api/orgs", null, {
			method: "POST",
			body: JSON.stringify({ name: "Acme" }),
		});
		expect(response.status).toBe(401);
	});

	it("400s an empty or absent name", async () => {
		for (const body of [{}, { name: "" }, { name: "   " }]) {
			const response = await call("/api/orgs", adaToken, {
				method: "POST",
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
		}
	});

	it("400s a name past the length cap", async () => {
		const response = await call("/api/orgs", adaToken, {
			method: "POST",
			body: JSON.stringify({ name: "a".repeat(101) }),
		});
		expect(response.status).toBe(400);
	});
});

describe("GET /api/orgs", () => {
	it("lists only the caller's orgs", async () => {
		await createOrg(adaToken, "Acme");
		const mine = await call("/api/orgs", adaToken);
		expect(await mine.json()).toMatchObject({
			orgs: [{ name: "Acme", role: "owner" }],
		});

		const theirs = await call("/api/orgs", bobToken);
		expect(await theirs.json()).toEqual({ orgs: [] });
	});
});

describe("PATCH /api/orgs/:id", () => {
	it("renames for an owner", async () => {
		const orgId = await createOrg(adaToken);
		const response = await call(`/api/orgs/${orgId}`, adaToken, {
			method: "PATCH",
			body: JSON.stringify({ name: "Acme Inc" }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			org: { id: orgId, name: "Acme Inc" },
		});
	});

	it("404s a non-member", async () => {
		const orgId = await createOrg(adaToken);
		const response = await call(`/api/orgs/${orgId}`, bobToken, {
			method: "PATCH",
			body: JSON.stringify({ name: "Hostile Takeover" }),
		});
		expect(response.status).toBe(404);
	});

	it("404s an org that does not exist", async () => {
		const response = await call(`/api/orgs/${crypto.randomUUID()}`, adaToken, {
			method: "PATCH",
			body: JSON.stringify({ name: "Ghost" }),
		});
		expect(response.status).toBe(404);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @onlooker/api test src/routes/orgs.test.ts`
Expected: FAIL — every request answers 404, because no route is registered.

- [ ] **Step 3: Write the handlers**

Create `apps/api/src/routes/orgs.ts`:

```ts
import {
	createOrgWithOwner,
	listOrgsForUser,
	renameOrg,
} from "../db/orgs.js";
import type { Principal } from "../db/pool.js";
import { requireOrgRole } from "../orgs/authorize.js";
import type { RouteParams, WorkerEnv } from "../types";
import { ApiError } from "../types";

/**
 * The org itself: create, list, rename.
 *
 * Every handler that names an org in its path calls requireOrgRole first, and
 * the enumerated test in orgs-authorization.test.ts is what makes that a rule
 * rather than a habit.
 */

/** Long enough for a real company name, short enough to render in a list. */
export const ORG_NAME_MAX_LENGTH = 100;

/**
 * Read and validate a name from a request body.
 *
 * Trimmed before the emptiness check, so a name of spaces is refused rather
 * than stored and rendered as blank.
 */
async function readName(request: Request): Promise<string> {
	const body = (await request.json().catch(() => ({}))) as { name?: unknown };
	const name = typeof body.name === "string" ? body.name.trim() : "";

	if (name.length === 0) {
		throw new ApiError(400, "name_required", "An org needs a name");
	}
	if (name.length > ORG_NAME_MAX_LENGTH) {
		throw new ApiError(
			400,
			"name_too_long",
			`A name can be at most ${ORG_NAME_MAX_LENGTH} characters`,
		);
	}
	return name;
}

export async function handleCreateOrg(
	request: Request,
	env: WorkerEnv,
	_params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	// The router resolved this from the route's `auth: "session"`, which throws
	// rather than returning null, so it cannot be null here.
	const { userId } = principal as Principal;
	const name = await readName(request);

	const org = await createOrgWithOwner(env.DB, name, userId);
	return Response.json(
		{ org: { id: org.id, name: org.name, role: "owner" } },
		{ status: 201 },
	);
}

export async function handleListOrgs(
	_request: Request,
	env: WorkerEnv,
	_params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	const { userId } = principal as Principal;
	return Response.json({ orgs: await listOrgsForUser(env.DB, userId) });
}

export async function handleRenameOrg(
	request: Request,
	env: WorkerEnv,
	params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	await requireOrgRole(env.DB, principal, params.id, "owner");
	const name = await readName(request);

	// requireOrgRole already proved the org exists by finding a membership in
	// it, so a false here is a row deleted between the two statements. The 404
	// is the same refusal either way.
	if (!(await renameOrg(env.DB, params.id, name))) {
		throw new ApiError(404, "not_found", "No such org");
	}

	return Response.json({ org: { id: params.id, name } });
}
```

- [ ] **Step 4: Register the routes**

In `apps/api/src/routes/index.ts`, add alongside the other exports (keeping the file's alphabetical grouping):

```ts
export {
	handleCreateOrg,
	handleListOrgs,
	handleRenameOrg,
	ORG_NAME_MAX_LENGTH,
} from "./orgs";
```

In `apps/api/src/router.ts`, add `handleCreateOrg`, `handleListOrgs` and `handleRenameOrg` to the existing import from `./routes`, then add this block to `ROUTES` before the operator-moderation block:

```ts
	// =========================================================================
	// Orgs
	//
	// Every route here carries `auth: "session"`, and the org role it needs is
	// checked by requireOrgRole inside the handler - RouteAuth cannot express
	// "owner of the org named in this path", since that needs a path parameter
	// and a D1 read. routes/orgs-authorization.test.ts enumerates every route
	// below with its required role and fails if one is added without an entry.
	// =========================================================================
	{
		method: "POST",
		path: "/api/orgs",
		auth: "session",
		cors: "app",
		handler: handleCreateOrg,
	},
	{
		method: "GET",
		path: "/api/orgs",
		auth: "session",
		cors: "app",
		handler: handleListOrgs,
	},
	{
		method: "PATCH",
		path: "/api/orgs/:id",
		auth: "session",
		cors: "app",
		handler: handleRenameOrg,
	},
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @onlooker/api test src/routes/orgs.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Add the contract cases**

In `packages/api-contract/src/index.ts`, add a group beside the existing ones. Follow the shape of the groups already there — `name`, `path`, `init`, `status`, and `body` where the shape is worth pinning.

```ts
/**
 * Orgs. Authenticated cases run with the fixture's own access token; the
 * runner supplies it, because the two implementations cannot share one.
 *
 * Only the cases whose shape apps/web reads are pinned here. The role matrix
 * lives in apps/api's own orgs-authorization.test.ts, which can seed two
 * accounts in one org - something a contract case cannot express.
 */
export const ORG_LIFECYCLE: ContractCase[] = [
	{
		name: "GET /api/orgs with no credential",
		path: "/api/orgs",
		init: { method: "GET" },
		status: 401,
	},
	{
		name: "POST /api/orgs with no name",
		path: "/api/orgs",
		init: {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		},
		status: 401,
	},
];
```

Then add `ORG_LIFECYCLE` to the `anonymousCases` aggregate in the same file, following how the existing groups are composed there.

- [ ] **Step 7: Run every gate**

Run:
```bash
pnpm --filter @onlooker/api-contract test
pnpm --filter @onlooker/api test && pnpm --filter @onlooker/api typecheck && pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```
Expected: all pass. `source-guards` has a check on route titles and one on the lesson boundary — neither should be affected, and if either fails, read its message before changing anything.

- [ ] **Step 8: Commit**

Stage `apps/api/src/routes/orgs.ts`, its test, `apps/api/src/routes/index.ts`, `apps/api/src/router.ts`, `packages/api-contract/src/index.ts`. Run `/git-workflow:commit`.

---

### Task 5: Member routes — list, promote, remove, leave

**Files:**
- Create: `apps/api/src/routes/orgs-members.ts`
- Create: `apps/api/src/routes/orgs-members.test.ts`
- Modify: `apps/api/src/routes/index.ts`
- Modify: `apps/api/src/router.ts`

**Interfaces:**
- Consumes: `listMembers`, `setMemberRole`, `removeMembership`, `countOwners`, `isOrgRole`, `getMembership` from `../db/orgs.js`; `requireOrgRole`.
- Produces: `handleListMembers`, `handleSetMemberRole`, `handleRemoveMember`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/orgs-members.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addMembership, getMembership } from "../db/orgs.js";
import {
	call,
	resetOrgTables,
	signup,
	type SignedUpUser,
} from "../test-support/orgs.js";

const db = () => env.DB;
let ada: SignedUpUser;
let bob: SignedUpUser;
let orgId: string;

beforeEach(async () => {
	await resetOrgTables();
	ada = await signup("ada@example.com");
	bob = await signup("bob@example.com");

	const created = await call("/api/orgs", ada.token, {
		method: "POST",
		body: JSON.stringify({ name: "Acme" }),
	});
	orgId = ((await created.json()) as { org: { id: string } }).org.id;
});

describe("GET /api/orgs/:id/members", () => {
	it("lists members to a member", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		const response = await call(`/api/orgs/${orgId}/members`, bob.token);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			members: { email: string; role: string }[];
		};
		expect(body.members.map((m) => [m.email, m.role])).toEqual(
			expect.arrayContaining([
				["ada@example.com", "owner"],
				["bob@example.com", "member"],
			]),
		);
	});

	it("404s a non-member", async () => {
		const response = await call(`/api/orgs/${orgId}/members`, bob.token);
		expect(response.status).toBe(404);
	});
});

describe("PATCH /api/orgs/:id/members/:userId", () => {
	it("promotes a member for an owner", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		const response = await call(
			`/api/orgs/${orgId}/members/${bob.id}`,
			ada.token,
			{ method: "PATCH", body: JSON.stringify({ role: "owner" }) },
		);
		expect(response.status).toBe(200);
		expect(await getMembership(db(), orgId, bob.id)).toEqual({ role: "owner" });
	});

	it("404s a plain member trying to promote themselves", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		const response = await call(
			`/api/orgs/${orgId}/members/${bob.id}`,
			bob.token,
			{ method: "PATCH", body: JSON.stringify({ role: "owner" }) },
		);
		expect(response.status).toBe(404);
		expect(await getMembership(db(), orgId, bob.id)).toEqual({ role: "member" });
	});

	it("400s an unknown role", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		const response = await call(
			`/api/orgs/${orgId}/members/${bob.id}`,
			ada.token,
			{ method: "PATCH", body: JSON.stringify({ role: "admin" }) },
		);
		expect(response.status).toBe(400);
	});

	it("409s demoting the last owner", async () => {
		const response = await call(
			`/api/orgs/${orgId}/members/${ada.id}`,
			ada.token,
			{ method: "PATCH", body: JSON.stringify({ role: "member" }) },
		);
		expect(response.status).toBe(409);
		expect(await getMembership(db(), orgId, ada.id)).toEqual({ role: "owner" });
	});

	it("allows demoting an owner once there are two", async () => {
		await addMembership(db(), orgId, bob.id, "owner");
		const response = await call(
			`/api/orgs/${orgId}/members/${bob.id}`,
			ada.token,
			{ method: "PATCH", body: JSON.stringify({ role: "member" }) },
		);
		expect(response.status).toBe(200);
	});
});

describe("DELETE /api/orgs/:id/members/:userId", () => {
	it("removes a member for an owner", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		const response = await call(
			`/api/orgs/${orgId}/members/${bob.id}`,
			ada.token,
			{ method: "DELETE" },
		);
		expect(response.status).toBe(200);
		expect(await getMembership(db(), orgId, bob.id)).toBeNull();
	});

	// The documented exception to the role enumeration: this route's required
	// role depends on its arguments.
	it("lets a plain member remove their own id - that is leaving", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		const response = await call(
			`/api/orgs/${orgId}/members/${bob.id}`,
			bob.token,
			{ method: "DELETE" },
		);
		expect(response.status).toBe(200);
		expect(await getMembership(db(), orgId, bob.id)).toBeNull();
	});

	it("404s a plain member removing somebody else", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		const response = await call(
			`/api/orgs/${orgId}/members/${ada.id}`,
			bob.token,
			{ method: "DELETE" },
		);
		expect(response.status).toBe(404);
		expect(await getMembership(db(), orgId, ada.id)).toEqual({ role: "owner" });
	});

	it("409s the last owner leaving", async () => {
		const response = await call(
			`/api/orgs/${orgId}/members/${ada.id}`,
			ada.token,
			{ method: "DELETE" },
		);
		expect(response.status).toBe(409);
		expect(await getMembership(db(), orgId, ada.id)).toEqual({ role: "owner" });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @onlooker/api test src/routes/orgs-members.test.ts`
Expected: FAIL — 404 on every member route, since none is registered.

- [ ] **Step 3: Write the handlers**

Create `apps/api/src/routes/orgs-members.ts`:

```ts
import {
	countOwners,
	getMembership,
	isOrgRole,
	listMembers,
	removeMembership,
	setMemberRole,
} from "../db/orgs.js";
import type { Principal } from "../db/pool.js";
import { requireOrgRole } from "../orgs/authorize.js";
import type { RouteParams, WorkerEnv } from "../types";
import { ApiError } from "../types";

/**
 * Membership: who is in an org, with what role, and who may change that.
 *
 * Two of these three routes are plain owner routes. The third - DELETE - is the
 * one route in this surface whose required role depends on its arguments: an
 * owner may remove anyone, and a plain member may remove only themselves,
 * because that is what leaving an org is. It is written down here and in
 * orgs-authorization.test.ts rather than left to the blanket rule, since a
 * single route quietly failing the enumeration's general claim is how an
 * allowlist stops meaning anything.
 */

export async function handleListMembers(
	_request: Request,
	env: WorkerEnv,
	params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	await requireOrgRole(env.DB, principal, params.id, "member");
	return Response.json({ members: await listMembers(env.DB, params.id) });
}

export async function handleSetMemberRole(
	request: Request,
	env: WorkerEnv,
	params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	await requireOrgRole(env.DB, principal, params.id, "owner");

	const body = (await request.json().catch(() => ({}))) as { role?: unknown };
	if (!isOrgRole(body.role)) {
		throw new ApiError(400, "invalid_role", "role must be 'owner' or 'member'");
	}

	const target = await getMembership(env.DB, params.id, params.userId);
	if (!target) {
		throw new ApiError(404, "not_found", "No such member");
	}

	// Checked before the write, and only when the change would actually remove
	// an owner: demoting the last one leaves an org nobody can administer, and
	// no route could repair it afterward.
	if (
		target.role === "owner" &&
		body.role === "member" &&
		(await countOwners(env.DB, params.id)) <= 1
	) {
		throw new ApiError(
			409,
			"last_owner",
			"An org needs an owner; promote somebody else first",
		);
	}

	if (!(await setMemberRole(env.DB, params.id, params.userId, body.role))) {
		throw new ApiError(404, "not_found", "No such member");
	}

	return Response.json({
		member: { user_id: params.userId, role: body.role },
	});
}

export async function handleRemoveMember(
	_request: Request,
	env: WorkerEnv,
	params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	const { userId } = principal as Principal;
	const removingSelf = params.userId === userId;

	// The argument-dependent case. Asking for "member" when removing yourself
	// and "owner" otherwise is the whole rule, and it is one line because
	// requireOrgRole returns the caller's actual role rather than a boolean.
	await requireOrgRole(
		env.DB,
		principal,
		params.id,
		removingSelf ? "member" : "owner",
	);

	const target = await getMembership(env.DB, params.id, params.userId);
	if (!target) {
		throw new ApiError(404, "not_found", "No such member");
	}

	if (target.role === "owner" && (await countOwners(env.DB, params.id)) <= 1) {
		throw new ApiError(
			409,
			"last_owner",
			"An org needs an owner; promote somebody else first",
		);
	}

	if (!(await removeMembership(env.DB, params.id, params.userId))) {
		throw new ApiError(404, "not_found", "No such member");
	}

	return Response.json({ removed: params.userId });
}
```

- [ ] **Step 4: Register the routes**

Add to `apps/api/src/routes/index.ts`:

```ts
export {
	handleListMembers,
	handleRemoveMember,
	handleSetMemberRole,
} from "./orgs-members";
```

Add the three handlers to `router.ts`'s import from `./routes`, then add to `ROUTES` inside the Orgs block created in Task 4:

```ts
	{
		method: "GET",
		path: "/api/orgs/:id/members",
		auth: "session",
		cors: "app",
		handler: handleListMembers,
	},
	{
		method: "PATCH",
		path: "/api/orgs/:id/members/:userId",
		auth: "session",
		cors: "app",
		handler: handleSetMemberRole,
	},
	{
		// Owner for anyone; any member for their own id, which is "leave". The
		// only route in this surface whose required role depends on its
		// arguments - see orgs-members.ts.
		method: "DELETE",
		path: "/api/orgs/:id/members/:userId",
		auth: "session",
		cors: "app",
		handler: handleRemoveMember,
	},
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @onlooker/api test src/routes/orgs-members.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Run the gates and commit**

Run: `pnpm --filter @onlooker/api test && pnpm --filter @onlooker/api typecheck && pnpm --filter @onlooker/api lint && bash scripts/source-guards.test.sh`

Stage the new files, `routes/index.ts` and `router.ts`. Run `/git-workflow:commit`.

---

### Task 6: The invite window and the invite email

**Files:**
- Modify: `apps/api/src/types/index.ts` (add `INVITE_EXPIRY_DAYS` to `WorkerEnv`)
- Modify: `apps/api/wrangler.toml` (three `[env.*.vars]` blocks)
- Modify: `apps/api/vitest.config.ts` (the test bindings)
- Modify: `ENVIRONMENT_VARIABLES.md`
- Create: `apps/api/src/orgs/invite-window.ts`
- Create: `apps/api/src/orgs/invite-window.test.ts`
- Modify: `apps/api/src/email/templates.ts` (add `orgInviteEmail`)
- Create: `apps/api/src/email/org-invite.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `DEFAULT_INVITE_EXPIRY_DAYS = 7`
  - `resolveInviteWindow(env, _orgId?): { days: number; ms: number }`
  - `orgInviteEmail(to, orgName, inviterName, link, days): EmailMessage`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/orgs/invite-window.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_INVITE_EXPIRY_DAYS,
	resolveInviteWindow,
} from "./invite-window.js";

const env = (value?: string) =>
	({ INVITE_EXPIRY_DAYS: value }) as { INVITE_EXPIRY_DAYS?: string };

describe("resolveInviteWindow", () => {
	it("reads a configured value", () => {
		expect(resolveInviteWindow(env("3")).days).toBe(3);
		expect(resolveInviteWindow(env("3")).ms).toBe(3 * 24 * 60 * 60 * 1000);
	});

	// Every one of these produces a number from Number() without throwing, and
	// a window of 0 or NaN means every invite is born expired - a flow that
	// fails silently for everybody. onlooker-nsow87 is an open bug of exactly
	// this shape, where a typo'd var name yields a monitor that is green
	// forever.
	it.each([
		["unset", undefined],
		["empty", ""],
		["not a number", "seven"],
		["zero", "0"],
		["negative", "-5"],
		["fractional", "1.5"],
	])("falls back to the default when %s", (_label, value) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(resolveInviteWindow(env(value)).days).toBe(
			DEFAULT_INVITE_EXPIRY_DAYS,
		);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("does not warn when the value is good", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		resolveInviteWindow(env("7"));
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
```

Create `apps/api/src/email/org-invite.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { orgInviteEmail } from "./templates.js";

describe("orgInviteEmail", () => {
	it("states the window it was given, in both bodies", () => {
		// The window is configuration, so the prose cannot restate it as a
		// literal. verifyEmailEmail says "expires in a day" because its TTL is a
		// constant beside it; this one's is not, and a template that disagreed
		// with the enforced value would be an email that lies.
		const message = orgInviteEmail(
			"invitee@example.com",
			"Acme",
			"Ada",
			"https://app.onlooker.dev/orgs/invites/abc",
			3,
		);
		expect(message.text).toContain("3 days");
		expect(message.html).toContain("3 days");
	});

	it("says one day without pluralizing", () => {
		const message = orgInviteEmail(
			"invitee@example.com",
			"Acme",
			"Ada",
			"https://app.onlooker.dev/orgs/invites/abc",
			1,
		);
		expect(message.text).toContain("1 day");
		expect(message.text).not.toContain("1 days");
	});

	it("names the org and the inviter", () => {
		const message = orgInviteEmail(
			"invitee@example.com",
			"Acme",
			"Ada",
			"https://app.onlooker.dev/orgs/invites/abc",
			7,
		);
		expect(message.text).toContain("Acme");
		expect(message.text).toContain("Ada");
		expect(message.subject).toContain("Acme");
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @onlooker/api test src/orgs/invite-window.test.ts src/email/org-invite.test.ts`
Expected: FAIL — neither module nor export exists.

- [ ] **Step 3: Write the resolver**

Create `apps/api/src/orgs/invite-window.ts`:

```ts
/**
 * How long an invitation stays usable.
 *
 * Configuration rather than a constant, matching TOKEN_EXPIRY_MINUTES and
 * REFRESH_TOKEN_EXPIRY_DAYS in wrangler.toml. This does NOT avoid a deploy -
 * wrangler vars change by deploying, the same as editing a constant. What it
 * buys is a value visible in environment config and able to differ per
 * environment: a one-day window in development makes expiry cheap to exercise
 * by hand.
 *
 * `orgId` is accepted and deliberately unused. Per-org windows are deferred,
 * and taking the argument now means that change is a lookup inside this
 * function rather than a new parameter threaded through every caller.
 */

/** Seven days, because an invite waits on a human who may be away. */
export const DEFAULT_INVITE_EXPIRY_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function resolveInviteWindow(
	env: { INVITE_EXPIRY_DAYS?: string },
	_orgId?: string,
): { days: number; ms: number } {
	const raw = env.INVITE_EXPIRY_DAYS;
	const parsed = Number(raw);

	// Number("") is 0 and Number("seven") is NaN, so a bare read gives a window
	// of zero or nothing and every invite is born expired. Integer and positive
	// are both required: a fractional window would render as "1.5 days".
	const usable =
		raw !== undefined && Number.isInteger(parsed) && parsed > 0;

	if (!usable) {
		// Warn rather than throw. A typo'd var should not take invitations down
		// for everybody - it should be loud in the logs while the flow keeps
		// working at a sane default.
		console.warn(
			JSON.stringify({
				event: "invite_window_fallback",
				configured: raw ?? null,
				using_days: DEFAULT_INVITE_EXPIRY_DAYS,
			}),
		);
		return {
			days: DEFAULT_INVITE_EXPIRY_DAYS,
			ms: DEFAULT_INVITE_EXPIRY_DAYS * MS_PER_DAY,
		};
	}

	return { days: parsed, ms: parsed * MS_PER_DAY };
}
```

- [ ] **Step 4: Write the email template**

Append to `apps/api/src/email/templates.ts`:

```ts
/**
 * The invitation to join an org.
 *
 * `days` is a parameter, not a literal in the prose. The other templates here
 * can say "expires in a day" because their TTL is a constant on line 18 and
 * line 24 of this same file; this window is environment configuration, so a
 * hardcoded sentence would disagree with the enforced value the first time
 * anybody changed it.
 *
 * The link alone is not enough to join: accepting requires signing in as the
 * invited address. The copy says so, because somebody forwarding this to a
 * colleague should understand why it does not work for them.
 */
export function orgInviteEmail(
	to: string,
	orgName: string,
	inviterName: string,
	link: string,
	days: number,
): EmailMessage {
	const window = `${days} ${days === 1 ? "day" : "days"}`;
	const lead = `${inviterName} invited you to join ${orgName} on Onlooker.`;

	return {
		to,
		subject: `Join ${orgName} on Onlooker`,
		text: [
			lead,
			"",
			`Accept here: ${link}`,
			"",
			`The invitation expires in ${window}, and works only when you are signed in as ${to}.`,
			"If you weren't expecting this, ignore this email.",
		].join("\n"),
		html: [
			`<p style="font-family:system-ui,sans-serif">${lead}</p>`,
			button(link, `Join ${orgName}`),
			`<p style="font-family:system-ui,sans-serif;font-size:13px">The invitation expires in ${window}, and works only when you are signed in as ${to}. If you weren't expecting this, ignore this email.</p>`,
		].join("\n"),
	};
}
```

- [ ] **Step 5: Declare the binding in all four places**

In `apps/api/src/types/index.ts`, add to `WorkerEnv` after `APP_BASE_URL`:

```ts
	// How many days an org invitation stays usable, as a decimal string. A var
	// beside TOKEN_EXPIRY_MINUTES rather than a constant, so the window is
	// visible in environment config and can differ per environment.
	//
	// Optional because a missing value is survivable: orgs/invite-window.ts
	// falls back to DEFAULT_INVITE_EXPIRY_DAYS and warns, rather than taking
	// invitations down over a typo.
	INVITE_EXPIRY_DAYS?: string;
```

In `apps/api/wrangler.toml`, add to each of the three `[env.*.vars]` blocks. Development gets a short window precisely so expiry is exercisable by hand:

```toml
INVITE_EXPIRY_DAYS = "1"    # in [env.development.vars]
INVITE_EXPIRY_DAYS = "7"    # in [env.staging.vars]
INVITE_EXPIRY_DAYS = "7"    # in [env.production.vars]
```

In `apps/api/vitest.config.ts`, add to `miniflare.bindings`, mirroring `[env.development]` as that block's comment says it does:

```ts
						INVITE_EXPIRY_DAYS: "7",
```

In `ENVIRONMENT_VARIABLES.md`, add a row documenting `INVITE_EXPIRY_DAYS`. The guard at `scripts/source-guards.test.sh:217` greps for the name wrapped in backticks, so it must appear as `` `INVITE_EXPIRY_DAYS` ``. Follow the formatting of the rows already there.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @onlooker/api test src/orgs/invite-window.test.ts src/email/org-invite.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 7: Prove the documentation guard actually guards**

Run: `bash scripts/source-guards.test.sh`
Expected: PASS, including "every WorkerEnv field appears in ENVIRONMENT_VARIABLES.md".

Now ablate it: temporarily remove the `` `INVITE_EXPIRY_DAYS` `` line from `ENVIRONMENT_VARIABLES.md`, re-run the guard, and confirm it **fails**. Restore the line and confirm it passes again. A guard nobody has watched fail is not evidence that it guards anything — and this is the specific guard that failed PR #188 after six reviews missed it.

- [ ] **Step 8: Run the gates and commit**

Run: `pnpm --filter @onlooker/api test && pnpm --filter @onlooker/api typecheck && pnpm --filter @onlooker/api lint && bash scripts/source-guards.test.sh`

Stage all eight files. Run `/git-workflow:commit`.

---

### Task 7: Invite routes — create, list, revoke

**Files:**
- Create: `apps/api/src/db/org-invites.ts`
- Create: `apps/api/src/routes/orgs-invites.ts`
- Create: `apps/api/src/routes/orgs-invites.test.ts`
- Modify: `apps/api/src/routes/index.ts`
- Modify: `apps/api/src/router.ts`

**Interfaces:**
- Consumes: `resolveInviteWindow`, `orgInviteEmail`, `requireOrgRole`, `getMembership`, `isOrgRole`; `hashToken` from `../utils/crypto.js`; `sendEmail` from `../email`.
- Produces:
  - `interface PendingInvite { id: string; email: string; role: OrgRole; expires_at: string; created_at: string }`
  - `interface InviteRecord { id: string; org_id: string; email: string; role: OrgRole; expires_at: string; accepted_at: string | null }`
  - `createInvite(db, { orgId, email, role, tokenHash, expiresAt, invitedBy }): Promise<{ id: string }>`
  - `listPendingInvites(db, orgId): Promise<PendingInvite[]>`
  - `deletePendingInvitesFor(db, orgId, email): Promise<void>`
  - `deleteInvite(db, orgId, inviteId): Promise<boolean>`
  - `findInviteByTokenHash(db, tokenHash): Promise<InviteRecord | null>` — used by Task 8
  - `markInviteAccepted(db, inviteId): Promise<boolean>` — used by Task 8; false means already spent
  - `normalizeEmail(value): string`
  - `handleCreateInvite`, `handleListInvites`, `handleRevokeInvite`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/orgs-invites.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addMembership } from "../db/orgs.js";
import {
	call,
	resetOrgTables,
	signup,
	type SignedUpUser,
} from "../test-support/orgs.js";

const db = () => env.DB;
let ada: SignedUpUser;
let bob: SignedUpUser;
let orgId: string;

function invite(token: string, email: string, role = "member") {
	return call(`/api/orgs/${orgId}/invites`, token, {
		method: "POST",
		body: JSON.stringify({ email, role }),
	});
}

beforeEach(async () => {
	await resetOrgTables();
	ada = await signup("ada@example.com");
	bob = await signup("bob@example.com");

	const created = await call("/api/orgs", ada.token, {
		method: "POST",
		body: JSON.stringify({ name: "Acme" }),
	});
	orgId = ((await created.json()) as { org: { id: string } }).org.id;
});

describe("POST /api/orgs/:id/invites", () => {
	it("creates a pending invite for an owner", async () => {
		const response = await invite(ada.token, "new@example.com");
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			invite: { email: "new@example.com", role: "member" },
		});
	});

	it("never returns the raw token", async () => {
		// The token is a bearer credential for joining an org. It belongs in the
		// email and nowhere else, so a response body carrying it would put it in
		// every log and proxy between here and the browser.
		const response = await invite(ada.token, "new@example.com");
		const text = await response.text();
		expect(text).not.toMatch(/[0-9a-f]{64}/);
	});

	it("stores only a hash", async () => {
		await invite(ada.token, "new@example.com");
		const row = await db()
			.prepare("SELECT token_hash FROM org_invites")
			.first<{ token_hash: string }>();
		expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("404s a plain member", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		expect((await invite(bob.token, "new@example.com")).status).toBe(404);
	});

	it("404s a non-member", async () => {
		expect((await invite(bob.token, "new@example.com")).status).toBe(404);
	});

	it("409s an address already in the org", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		expect((await invite(ada.token, "bob@example.com")).status).toBe(409);
	});

	it("400s a malformed address and an unknown role", async () => {
		expect((await invite(ada.token, "not-an-email")).status).toBe(400);
		expect((await invite(ada.token, "new@example.com", "admin")).status).toBe(
			400,
		);
	});

	it("replaces an outstanding invite to the same address", async () => {
		await invite(ada.token, "new@example.com");
		await invite(ada.token, "new@example.com");

		// One inbox must never hold two live invitations - the same reasoning
		// account.ts:332 applies to verification links.
		const count = await db()
			.prepare("SELECT COUNT(*) AS n FROM org_invites WHERE email = ?")
			.bind("new@example.com")
			.first<{ n: number }>();
		expect(count?.n).toBe(1);
	});

	it("normalizes the address, so case cannot duplicate an invite", async () => {
		await invite(ada.token, "New@Example.com");
		const row = await db()
			.prepare("SELECT email FROM org_invites")
			.first<{ email: string }>();
		expect(row?.email).toBe("new@example.com");
	});
});

describe("GET /api/orgs/:id/invites", () => {
	it("lists pending invites to an owner, without tokens", async () => {
		await invite(ada.token, "new@example.com");
		const response = await call(`/api/orgs/${orgId}/invites`, ada.token);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain("new@example.com");
		expect(text).not.toMatch(/[0-9a-f]{64}/);
	});

	it("404s a plain member", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		expect(
			(await call(`/api/orgs/${orgId}/invites`, bob.token)).status,
		).toBe(404);
	});
});

describe("DELETE /api/orgs/:id/invites/:inviteId", () => {
	it("revokes a pending invite", async () => {
		const created = await invite(ada.token, "new@example.com");
		const { invite: made } = (await created.json()) as {
			invite: { id: string };
		};

		const response = await call(
			`/api/orgs/${orgId}/invites/${made.id}`,
			ada.token,
			{ method: "DELETE" },
		);
		expect(response.status).toBe(200);

		const count = await db()
			.prepare("SELECT COUNT(*) AS n FROM org_invites")
			.first<{ n: number }>();
		expect(count?.n).toBe(0);
	});

	it("404s an unknown invite", async () => {
		const response = await call(
			`/api/orgs/${orgId}/invites/${crypto.randomUUID()}`,
			ada.token,
			{ method: "DELETE" },
		);
		expect(response.status).toBe(404);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @onlooker/api test src/routes/orgs-invites.test.ts`
Expected: FAIL — 404 on every invite route.

- [ ] **Step 3: Write the invite data layer**

Create `apps/api/src/db/org-invites.ts`:

```ts
import type { D1Database } from "@cloudflare/workers-types";
import { org_invites } from "@onlooker/db";
import { and, eq, isNull } from "drizzle-orm";
import { client } from "./client.js";
import type { OrgRole } from "./orgs.js";

/**
 * Pending invitations.
 *
 * Only `token_hash` is ever stored, and nothing in this module returns it -
 * whoever holds the raw token can join an org, so a read of this table must
 * not produce working invitations.
 */

export interface PendingInvite {
	id: string;
	email: string;
	role: OrgRole;
	expires_at: string;
	created_at: string;
}

export interface InviteRecord {
	id: string;
	org_id: string;
	email: string;
	role: OrgRole;
	expires_at: string;
	accepted_at: string | null;
}

/**
 * Case-fold and trim an address.
 *
 * Addresses arrive from a human typing into a form, and `Ada@Example.com`
 * inviting the same person twice would make two live invitations where the
 * replace-on-reinvite rule promises one.
 */
export function normalizeEmail(value: string): string {
	return value.trim().toLowerCase();
}

export async function createInvite(
	db: D1Database,
	input: {
		orgId: string;
		email: string;
		role: OrgRole;
		tokenHash: string;
		expiresAt: string;
		invitedBy: string;
	},
): Promise<{ id: string }> {
	const id = crypto.randomUUID();
	await client(db).insert(org_invites).values({
		id,
		org_id: input.orgId,
		email: input.email,
		role: input.role,
		token_hash: input.tokenHash,
		expires_at: input.expiresAt,
		invited_by: input.invitedBy,
		created_at: new Date().toISOString(),
	});
	return { id };
}

/** Invitations not yet accepted. Never includes a token hash. */
export async function listPendingInvites(
	db: D1Database,
	orgId: string,
): Promise<PendingInvite[]> {
	const rows = await client(db)
		.select({
			id: org_invites.id,
			email: org_invites.email,
			role: org_invites.role,
			expires_at: org_invites.expires_at,
			created_at: org_invites.created_at,
		})
		.from(org_invites)
		.where(
			and(eq(org_invites.org_id, orgId), isNull(org_invites.accepted_at)),
		)
		.orderBy(org_invites.created_at);

	return rows.map((row) => ({
		id: row.id,
		email: row.email,
		role: row.role as OrgRole,
		expires_at: row.expires_at,
		created_at: row.created_at,
	}));
}

/**
 * Retire every outstanding invitation to this address in this org.
 *
 * Called before writing a new one, so re-inviting replaces rather than
 * accumulates - the same discipline account.ts:332 applies to verification
 * links, and for the same reason: a trail of live links in somebody's inbox is
 * a trail of working credentials.
 */
export async function deletePendingInvitesFor(
	db: D1Database,
	orgId: string,
	email: string,
): Promise<void> {
	await db
		.prepare(
			"DELETE FROM org_invites WHERE org_id = ? AND email = ? AND accepted_at IS NULL",
		)
		.bind(orgId, email)
		.run();
}

/** Revoke one pending invitation. False means no such invitation here. */
export async function deleteInvite(
	db: D1Database,
	orgId: string,
	inviteId: string,
): Promise<boolean> {
	const result = await db
		.prepare("DELETE FROM org_invites WHERE org_id = ? AND id = ?")
		.bind(orgId, inviteId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

/**
 * Find an invitation by the hash of its token.
 *
 * Returns the row whatever its state - expired or already accepted included -
 * because the caller decides what each failure says. Nothing here reveals
 * which: see routes/orgs-invites.ts.
 */
export async function findInviteByTokenHash(
	db: D1Database,
	tokenHash: string,
): Promise<InviteRecord | null> {
	const rows = await client(db)
		.select({
			id: org_invites.id,
			org_id: org_invites.org_id,
			email: org_invites.email,
			role: org_invites.role,
			expires_at: org_invites.expires_at,
			accepted_at: org_invites.accepted_at,
		})
		.from(org_invites)
		.where(eq(org_invites.token_hash, tokenHash))
		.limit(1);

	const row = rows[0];
	if (!row) return null;
	return {
		id: row.id,
		org_id: row.org_id,
		email: row.email,
		role: row.role as OrgRole,
		expires_at: row.expires_at,
		accepted_at: row.accepted_at ?? null,
	};
}

/** Stamp an invitation accepted. False means somebody else just accepted it. */
export async function markInviteAccepted(
	db: D1Database,
	inviteId: string,
): Promise<boolean> {
	const result = await db
		.prepare(
			"UPDATE org_invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL",
		)
		.bind(new Date().toISOString(), inviteId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}
```

- [ ] **Step 4: Write the handlers**

Create `apps/api/src/routes/orgs-invites.ts`:

```ts
import {
	createInvite,
	deleteInvite,
	deletePendingInvitesFor,
	listPendingInvites,
	normalizeEmail,
} from "../db/org-invites.js";
import { getMembership, isOrgRole, listMembers } from "../db/orgs.js";
import type { Principal } from "../db/pool.js";
import { sendEmail } from "../email";
import { orgInviteEmail } from "../email/templates.js";
import { resolveInviteWindow } from "../orgs/invite-window.js";
import { requireOrgRole } from "../orgs/authorize.js";
import type { RouteParams, WorkerEnv } from "../types";
import { ApiError } from "../types";
import { hashToken } from "../utils/crypto.js";

/**
 * Creating, listing and revoking invitations. Acceptance is in
 * orgs-invite-accept.ts, because it is the only one of these that an
 * unauthenticated caller touches.
 */

/**
 * Deliberately permissive. The authoritative check on an address is whether
 * mail to it arrives, and a stricter pattern rejects valid addresses - so this
 * catches a typo like a missing @ without pretending to validate RFC 5322.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handleCreateInvite(
	request: Request,
	env: WorkerEnv,
	params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	await requireOrgRole(env.DB, principal, params.id, "owner");
	const { userId } = principal as Principal;

	const body = (await request.json().catch(() => ({}))) as {
		email?: unknown;
		role?: unknown;
	};
	const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
	const role = body.role ?? "member";

	if (!EMAIL_SHAPE.test(email)) {
		throw new ApiError(400, "invalid_email", "That is not an email address");
	}
	if (!isOrgRole(role)) {
		throw new ApiError(400, "invalid_role", "role must be 'owner' or 'member'");
	}

	// An address already in the org is told so plainly. This is not an
	// enumeration leak: the caller is an owner, who can already read the full
	// member list from GET /api/orgs/:id/members.
	const members = await listMembers(env.DB, params.id);
	if (members.some((member) => normalizeEmail(member.email) === email)) {
		throw new ApiError(409, "already_member", "They are already in this org");
	}

	const window = resolveInviteWindow(env, params.id);
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const token = [...bytes]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");

	await deletePendingInvitesFor(env.DB, params.id, email);
	const invite = await createInvite(env.DB, {
		orgId: params.id,
		email,
		role,
		tokenHash: await hashToken(token),
		expiresAt: new Date(Date.now() + window.ms).toISOString(),
		invitedBy: userId,
	});

	const inviter = members.find((member) => member.user_id === userId);
	await sendEmail(
		env,
		orgInviteEmail(
			email,
			// Owners can rename an org, so the name is read at send time rather
			// than cached anywhere.
			await orgName(env, params.id),
			inviter?.name ?? inviter?.email ?? "Somebody",
			`${env.APP_BASE_URL}/orgs/invites/${token}`,
			window.days,
		),
	);

	// The raw token is in the email and nowhere else. Returning it here would
	// put a working credential into every log and proxy on the way back - the
	// expiry and the address are safe to echo, the token is not.
	return Response.json(
		{
			invite: {
				id: invite.id,
				email,
				role,
				expires_at: new Date(Date.now() + window.ms).toISOString(),
			},
		},
		{ status: 201 },
	);
}

/** The org's name, for a message that has to say which org. */
async function orgName(env: WorkerEnv, orgId: string): Promise<string> {
	const row = await env.DB.prepare("SELECT name FROM orgs WHERE id = ?")
		.bind(orgId)
		.first<{ name: string }>();
	return row?.name ?? "an Onlooker org";
}

export async function handleListInvites(
	_request: Request,
	env: WorkerEnv,
	params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	await requireOrgRole(env.DB, principal, params.id, "owner");
	return Response.json({
		invites: await listPendingInvites(env.DB, params.id),
	});
}

export async function handleRevokeInvite(
	_request: Request,
	env: WorkerEnv,
	params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	await requireOrgRole(env.DB, principal, params.id, "owner");

	// Scoped to the org in the path, so an owner of one org cannot revoke
	// another org's invitation by guessing an id.
	if (!(await deleteInvite(env.DB, params.id, params.inviteId))) {
		throw new ApiError(404, "not_found", "No such invitation");
	}

	return Response.json({ revoked: params.inviteId });
}
```

- [ ] **Step 5: Register the routes**

Add to `apps/api/src/routes/index.ts`:

```ts
export {
	handleCreateInvite,
	handleListInvites,
	handleRevokeInvite,
} from "./orgs-invites";
```

Add the handlers to `router.ts`'s import, then add to the Orgs block:

```ts
	{
		method: "POST",
		path: "/api/orgs/:id/invites",
		auth: "session",
		cors: "app",
		handler: handleCreateInvite,
	},
	{
		method: "GET",
		path: "/api/orgs/:id/invites",
		auth: "session",
		cors: "app",
		handler: handleListInvites,
	},
	{
		method: "DELETE",
		path: "/api/orgs/:id/invites/:inviteId",
		auth: "session",
		cors: "app",
		handler: handleRevokeInvite,
	},
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @onlooker/api test src/routes/orgs-invites.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 7: Run the gates and commit**

Run: `pnpm --filter @onlooker/api test && pnpm --filter @onlooker/api typecheck && pnpm --filter @onlooker/api lint && bash scripts/source-guards.test.sh`

Stage the new files, `routes/index.ts` and `router.ts`. Run `/git-workflow:commit`.

---

### Task 8: Invite acceptance — verify and accept

**Files:**
- Create: `apps/api/src/routes/orgs-invite-accept.ts`
- Create: `apps/api/src/routes/orgs-invite-accept.test.ts`
- Modify: `apps/api/src/routes/index.ts`
- Modify: `apps/api/src/router.ts`

**Interfaces:**
- Consumes: `findInviteByTokenHash`, `markInviteAccepted`, `normalizeEmail` from `../db/org-invites.js`; `addMembership`, `getMembership` from `../db/orgs.js`; `getUserById` from `../db/queries.js`; `hashToken`.
- Produces: `handleVerifyInvite`, `handleAcceptInvite`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/orgs-invite-accept.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createInvite } from "../db/org-invites.js";
import { createOrgWithOwner, getMembership } from "../db/orgs.js";
import { createUser } from "../db/queries.js";
import {
	call,
	resetOrgTables,
	signup,
	type SignedUpUser,
} from "../test-support/orgs.js";
import { hashToken } from "../utils/crypto.js";

const db = () => env.DB;
let ada: string;
let bob: SignedUpUser;
let orgId: string;

/** Seed an invitation directly, so the test holds the raw token. */
async function seedInvite(
	email: string,
	expiresAt = new Date(Date.now() + 86_400_000).toISOString(),
): Promise<string> {
	const token = crypto.randomUUID().replace(/-/g, "");
	await createInvite(db(), {
		orgId,
		email,
		role: "member",
		tokenHash: await hashToken(token),
		expiresAt,
		invitedBy: ada,
	});
	return token;
}

beforeEach(async () => {
	await resetOrgTables();
	ada = (await createUser(db(), "ada@example.com", "hash", "Ada")).id;
	bob = await signup("bob@example.com", "Bob");
	orgId = (await createOrgWithOwner(db(), "Acme", ada)).id;
});

describe("GET /api/orgs/invites/verify", () => {
	it("names the org for a valid token, with no credential", async () => {
		const token = await seedInvite("bob@example.com");
		const response = await call(
			`/api/orgs/invites/verify?token=${token}`,
			null,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			valid: true,
			org: { name: "Acme" },
			email: "bob@example.com",
		});
	});

	it("reports invalid for an unknown, expired or spent token", async () => {
		const expired = await seedInvite(
			"bob@example.com",
			new Date(Date.now() - 1000).toISOString(),
		);
		for (const token of [crypto.randomUUID(), expired]) {
			const response = await call(
				`/api/orgs/invites/verify?token=${token}`,
				null,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ valid: false });
		}
	});

	it("400s a request with no token at all", async () => {
		expect((await call("/api/orgs/invites/verify", null)).status).toBe(400);
	});
});

describe("POST /api/orgs/invites/accept", () => {
	it("joins the org at the invited role", async () => {
		const token = await seedInvite("bob@example.com");
		const response = await call("/api/orgs/invites/accept", bob.token, {
			method: "POST",
			body: JSON.stringify({ token }),
		});
		expect(response.status).toBe(200);
		expect(await getMembership(db(), orgId, bob.id)).toEqual({
			role: "member",
		});
	});

	it("401s without a session, even holding a valid token", async () => {
		const token = await seedInvite("bob@example.com");
		const response = await call("/api/orgs/invites/accept", null, {
			method: "POST",
			body: JSON.stringify({ token }),
		});
		expect(response.status).toBe(401);
	});

	it("refuses a valid token held by the wrong account", async () => {
		// The email binding is what keeps this from being membership-by-link: a
		// forwarded invitation must do nothing for anybody but the addressee.
		const token = await seedInvite("someone-else@example.com");
		const response = await call("/api/orgs/invites/accept", bob.token, {
			method: "POST",
			body: JSON.stringify({ token }),
		});
		expect(response.status).toBe(403);
		expect(await getMembership(db(), orgId, bob.id)).toBeNull();
	});

	it("matches the address case-insensitively", async () => {
		const token = await seedInvite("BOB@example.com");
		const response = await call("/api/orgs/invites/accept", bob.token, {
			method: "POST",
			body: JSON.stringify({ token }),
		});
		expect(response.status).toBe(200);
	});

	it("400s an expired token", async () => {
		const token = await seedInvite(
			"bob@example.com",
			new Date(Date.now() - 1000).toISOString(),
		);
		const response = await call("/api/orgs/invites/accept", bob.token, {
			method: "POST",
			body: JSON.stringify({ token }),
		});
		expect(response.status).toBe(400);
		expect(await getMembership(db(), orgId, bob.id)).toBeNull();
	});

	it("spends the token, so a replay fails", async () => {
		const token = await seedInvite("bob@example.com");
		expect(
			(
				await call("/api/orgs/invites/accept", bob.token, {
					method: "POST",
					body: JSON.stringify({ token }),
				})
			).status,
		).toBe(200);
		expect(
			(
				await call("/api/orgs/invites/accept", bob.token, {
					method: "POST",
					body: JSON.stringify({ token }),
				})
			).status,
		).toBe(400);
	});

	it("400s an unknown token", async () => {
		const response = await call("/api/orgs/invites/accept", bob.token, {
			method: "POST",
			body: JSON.stringify({ token: crypto.randomUUID() }),
		});
		expect(response.status).toBe(400);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @onlooker/api test src/routes/orgs-invite-accept.test.ts`
Expected: FAIL — 404 on both routes.

- [ ] **Step 3: Write the handlers**

Create `apps/api/src/routes/orgs-invite-accept.ts`:

```ts
import {
	findInviteByTokenHash,
	type InviteRecord,
	markInviteAccepted,
	normalizeEmail,
} from "../db/org-invites.js";
import { addMembership, getMembership } from "../db/orgs.js";
import type { Principal } from "../db/pool.js";
import { getUserById } from "../db/queries.js";
import type { RouteParams, WorkerEnv } from "../types";
import { ApiError } from "../types";
import { hashToken } from "../utils/crypto.js";

/**
 * Accepting an invitation.
 *
 * THE TOKEN IS NOT THE WHOLE CREDENTIAL. Accepting requires a session whose
 * email matches the invited address, which is what keeps this from being the
 * membership-by-link the design rejected: a forwarded or leaked invitation does
 * nothing for anybody but the addressee.
 *
 * `verify` takes no credential, for the reason /auth/reset-password/verify does
 * not: the credential is the token in the request. It exists so the web app can
 * show "Ada invited you to Acme" before asking somebody to sign up, and it
 * therefore reveals an org name to whoever holds a valid invitation - which is
 * the person it was mailed to.
 */

/** Whether an invitation is still usable, without saying why it is not. */
function usable(invite: InviteRecord): boolean {
	if (invite.accepted_at !== null) return false;
	// Compared here rather than in SQL: expires_at is an ISO string, so a SQL
	// comparison would be lexicographic. Same reason db/queries.ts:180 gives.
	return new Date(invite.expires_at) >= new Date();
}

export async function handleVerifyInvite(
	request: Request,
	env: WorkerEnv,
	_params: RouteParams,
	_principal: Principal | null,
): Promise<Response> {
	const token = new URL(request.url).searchParams.get("token");
	if (!token) {
		throw new ApiError(400, "token_required", "No invitation token");
	}

	const invite = await findInviteByTokenHash(env.DB, await hashToken(token));

	// One shape for every way a token can fail - unknown, expired, already
	// accepted - because the caller has nothing useful to do with the
	// distinction and naming it is a hint to whoever is guessing. The same
	// reasoning db/queries.ts gives for spending a verification token.
	if (!invite || !usable(invite)) {
		return Response.json({ valid: false });
	}

	const org = await env.DB.prepare("SELECT name FROM orgs WHERE id = ?")
		.bind(invite.org_id)
		.first<{ name: string }>();
	if (!org) return Response.json({ valid: false });

	return Response.json({
		valid: true,
		org: { id: invite.org_id, name: org.name },
		email: invite.email,
		role: invite.role,
	});
}

export async function handleAcceptInvite(
	request: Request,
	env: WorkerEnv,
	_params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	const { userId } = principal as Principal;

	const body = (await request.json().catch(() => ({}))) as { token?: unknown };
	const token = typeof body.token === "string" ? body.token : "";
	if (token.length === 0) {
		throw new ApiError(400, "token_required", "No invitation token");
	}

	const invite = await findInviteByTokenHash(env.DB, await hashToken(token));
	if (!invite || !usable(invite)) {
		throw new ApiError(
			400,
			"invalid_invitation",
			"That invitation cannot be used",
		);
	}

	// Principal deliberately carries only userId (see db/pool.ts), so the
	// address comes from D1. A query, not a second credential.
	const user = await getUserById(env.DB, userId);
	if (!user) {
		throw new ApiError(401, "unauthorized", "No such account");
	}

	// The binding. 403 rather than 400, because the invitation is perfectly
	// valid - it is simply not this account's, and saying so is what tells
	// somebody who forwarded a link why it did not work.
	if (normalizeEmail(user.email) !== normalizeEmail(invite.email)) {
		throw new ApiError(
			403,
			"wrong_account",
			`That invitation was sent to ${invite.email}. Sign in as that address to accept it.`,
		);
	}

	// Spend the token first. Two concurrent accepts both pass the checks above,
	// and this UPDATE's `accepted_at IS NULL` is what makes exactly one of them
	// proceed to write a membership.
	if (!(await markInviteAccepted(env.DB, invite.id))) {
		throw new ApiError(
			400,
			"invalid_invitation",
			"That invitation cannot be used",
		);
	}

	// Already a member - possible if somebody was added directly while an
	// invitation was outstanding. The invitation is spent either way, and this
	// is a success rather than a conflict: the caller asked to be in the org,
	// and they are.
	if (!(await getMembership(env.DB, invite.org_id, userId))) {
		await addMembership(env.DB, invite.org_id, userId, invite.role);
	}

	return Response.json({ org_id: invite.org_id, role: invite.role });
}
```

- [ ] **Step 4: Register the routes**

Add to `apps/api/src/routes/index.ts`:

```ts
export {
	handleAcceptInvite,
	handleVerifyInvite,
} from "./orgs-invite-accept";
```

Add both to `router.ts`'s import, then add to the Orgs block:

```ts
	{
		// Unauthenticated: the credential is the token in the query string, the
		// same as /auth/reset-password/verify. Its literal `invites` segment
		// cannot be swallowed by /api/orgs/:id/invites - matchPath requires every
		// non-parameter segment to match, so that pattern fails at `verify`, and
		// resolve prefers exact routes over parameterized ones regardless.
		method: "GET",
		path: "/api/orgs/invites/verify",
		auth: "none",
		cors: "app",
		handler: handleVerifyInvite,
	},
	{
		// Session required ON TOP of the token: accepting checks that the
		// invited address is this account's, so a forwarded link is inert.
		method: "POST",
		path: "/api/orgs/invites/accept",
		auth: "session",
		cors: "app",
		handler: handleAcceptInvite,
	},
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @onlooker/api test src/routes/orgs-invite-accept.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Run the gates and commit**

Run: `pnpm --filter @onlooker/api test && pnpm --filter @onlooker/api typecheck && pnpm --filter @onlooker/api lint && bash scripts/source-guards.test.sh`

Stage the new files, `routes/index.ts` and `router.ts`. Run `/git-workflow:commit`.

---

### Task 9: The enumeration guard

**Files:**
- Create: `apps/api/src/routes/orgs-authorization.test.ts`

**Interfaces:**
- Consumes: `ROUTES` from `../router.js`; every route registered in Tasks 4, 5, 7, 8.
- Produces: nothing. This task adds only a guard.

This is the task that makes `requireOrgRole` a rule rather than a habit. It is the whole reason the design put role authorization in a function instead of the route table — without this test, the function is exactly the auth-by-omission that the shared read path existed to end.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/orgs-authorization.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addMembership, createOrgWithOwner } from "../db/orgs.js";
import { createUser } from "../db/queries.js";
import { ROUTES } from "../router.js";
import {
	call,
	resetOrgTables,
	signup,
	type SignedUpUser,
} from "../test-support/orgs.js";

const db = () => env.DB;
let ada: string;
let member: SignedUpUser;
let outsider: SignedUpUser;
let orgId: string;

/**
 * Every /api/orgs route, with the role it requires.
 *
 * This table is the guard. A route added to the router without an entry here
 * fails the first test below, which is what stops the next org route from
 * reaching production with no role check at all - RouteAuth cannot express
 * these roles, so nothing else would notice.
 *
 * "argument-dependent" is the one documented exception: DELETE on a member
 * needs owner for somebody else and member for your own id, which is what
 * leaving an org is. Its two cases are pinned in orgs-members.test.ts.
 */
const REQUIRED_ROLE: Record<string, "owner" | "member" | "argument-dependent" | "none"> = {
	"POST /api/orgs": "none",
	"GET /api/orgs": "none",
	"PATCH /api/orgs/:id": "owner",
	"GET /api/orgs/:id/members": "member",
	"PATCH /api/orgs/:id/members/:userId": "owner",
	"DELETE /api/orgs/:id/members/:userId": "argument-dependent",
	"POST /api/orgs/:id/invites": "owner",
	"GET /api/orgs/:id/invites": "owner",
	"DELETE /api/orgs/:id/invites/:inviteId": "owner",
	"GET /api/orgs/invites/verify": "none",
	"POST /api/orgs/invites/accept": "none",
};

const orgRoutes = () =>
	ROUTES.filter((route) => route.path.startsWith("/api/orgs"));

beforeEach(async () => {
	await resetOrgTables();
	ada = (await createUser(db(), "ada@example.com", "hash", "Ada")).id;
	member = await signup("member@example.com");
	outsider = await signup("outsider@example.com");
	orgId = (await createOrgWithOwner(db(), "Acme", ada)).id;
	await addMembership(db(), orgId, member.id, "member");
});

/** Fill a route pattern with concrete ids for this fixture. */
function concrete(path: string, targetUserId: string): string {
	return path
		.replace(":inviteId", crypto.randomUUID())
		.replace(":userId", targetUserId)
		.replace(":id", orgId);
}

async function callRoute(
	method: string,
	path: string,
	token: string,
): Promise<number> {
	const init: RequestInit = { method };
	if (method !== "GET" && method !== "DELETE") {
		// A body every handler can parse, so a 400 never masks the 404 this
		// test is looking for.
		init.body = JSON.stringify({
			name: "Probe",
			role: "member",
			email: "probe@example.com",
			token: crypto.randomUUID(),
		});
	}
	return (await call(path, token, init)).status;
}

describe("the org route table", () => {
	it("declares a required role for every /api/orgs route", () => {
		const missing = orgRoutes()
			.map((route) => `${route.method} ${route.path}`)
			.filter((key) => REQUIRED_ROLE[key] === undefined);

		expect(
			missing,
			"Add each new /api/orgs route to REQUIRED_ROLE in this file, then give it a case below. A route with no entry has no role check anybody has verified.",
		).toEqual([]);
	});

	it("has no stale entries", () => {
		const live = new Set(
			orgRoutes().map((route) => `${route.method} ${route.path}`),
		);
		const stale = Object.keys(REQUIRED_ROLE).filter((key) => !live.has(key));
		expect(stale).toEqual([]);
	});

	it("declares auth and cors on every org route", () => {
		for (const route of orgRoutes()) {
			expect(route.auth, `${route.method} ${route.path}`).toBeDefined();
			expect(route.cors, `${route.method} ${route.path}`).toBe("app");
		}
	});
});

describe("a non-member", () => {
	it("gets 404 from every org-scoped route", async () => {
		for (const route of orgRoutes()) {
			const required = REQUIRED_ROLE[`${route.method} ${route.path}`];
			if (required === "none") continue;

			const status = await callRoute(
				route.method,
				concrete(route.path, ada),
				outsider.token,
			);
			expect(status, `${route.method} ${route.path}`).toBe(404);
		}
	});
});

describe("a plain member", () => {
	it("gets 404 from every owner route", async () => {
		for (const route of orgRoutes()) {
			const key = `${route.method} ${route.path}`;
			if (REQUIRED_ROLE[key] !== "owner") continue;

			const status = await callRoute(
				route.method,
				concrete(route.path, ada),
				member.token,
			);
			expect(status, key).toBe(404);
		}
	});

	it("reaches every member route", async () => {
		for (const route of orgRoutes()) {
			const key = `${route.method} ${route.path}`;
			if (REQUIRED_ROLE[key] !== "member") continue;

			const status = await callRoute(
				route.method,
				concrete(route.path, member.id),
				member.token,
			);
			// 200 specifically, not merely "not 404". This is the positive half
			// of the guard - without it the whole suite would pass trivially if
			// requireOrgRole started refusing everybody - and an exact status is
			// the evidence that a member route actually SERVED a member, where
			// not-404 would also be satisfied by a 500.
			expect(status, key).toBe(200);
		}
	});
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @onlooker/api test src/routes/orgs-authorization.test.ts`
Expected: PASS, 6 tests. If `ROUTES` is not exported from `router.ts`, export it — it is already a module-level `const`, so this is adding `export` to its declaration and nothing else.

- [ ] **Step 3: Prove the guard fails when it should**

Three ablations, each restored immediately. A guard nobody has watched fail is not evidence that it guards anything.

1. Add a throwaway route `{ method: "GET", path: "/api/orgs/:id/probe", auth: "session", cors: "app", handler: handleListOrgs }` to `ROUTES`. Re-run. Expected: FAIL on "declares a required role for every /api/orgs route", naming `GET /api/orgs/:id/probe`. Remove the route.
2. In `routes/orgs-members.ts`, change `handleListMembers`'s `requireOrgRole(..., "member")` to not be called at all. Re-run. Expected: FAIL — the non-member case gets a 200 where it expected 404. Restore it.
3. Change `requireOrgRole` to throw for everybody. Re-run. Expected: FAIL on "reaches every member route". Restore it.

- [ ] **Step 4: Run the gates and commit**

Run: `pnpm --filter @onlooker/api test && pnpm --filter @onlooker/api typecheck && pnpm --filter @onlooker/api lint && bash scripts/source-guards.test.sh`

Stage `apps/api/src/routes/orgs-authorization.test.ts` and `apps/api/src/router.ts` if `ROUTES` needed exporting. Run `/git-workflow:commit`.

---

### Task 10: The web client, its mock, and the contract cases

**Files:**
- Create: `apps/web/src/api/orgsApi.ts`
- Modify: `apps/web/src/api/mockApi.ts` (add `mockOrgsApi` and dispatch to it)
- Modify: `packages/api-contract/src/index.ts` (complete `ORG_LIFECYCLE`)
- Modify: `apps/api/src/contract.test.ts` (run the new cases)

**Interfaces:**
- Consumes: the eleven routes from Tasks 4, 5, 7, 8. `apiClient` from `./client`, whose surface is `get<T>(path)`, `post<T>(path, body)`, `patch<T>(path, body)`, `delete<T>(path)` — there is no `put`.
- Produces: `ORG_ENDPOINTS`; the types `Org`, `OrgMember`, `PendingInvite`, `InviteCheck`; and `listOrgs`, `createOrg`, `renameOrg`, `listMembers`, `setMemberRole`, `removeMember`, `listInvites`, `createInvite`, `revokeInvite`, `verifyInvite`, `acceptInvite`.

This task closes the contract-case obligation for every route added in Tasks 4, 5, 7 and 8. The spec requires each new route to get an `@onlooker/api-contract` entry; they land here rather than route-by-route because the table's purpose is keeping the mock and the worker from drifting, so it belongs beside the mock it pins.

- [ ] **Step 1: Write the client**

Create `apps/web/src/api/orgsApi.ts`:

```ts
import { apiClient } from "./client";

// Org management. Mirrors apps/api/src/routes/orgs*.ts field for field.
//
// Every path is under /api/orgs rather than /auth/*: router.ts:355 records that
// a route outside /api/ cannot be mocked by createMockFetch and cannot be
// reached by an api-contract case, which is how the machine-token surface spent
// three PRs outside the drift gate.

export const ORG_ENDPOINTS = {
	orgs: "/api/orgs",
	inviteVerify: "/api/orgs/invites/verify",
	inviteAccept: "/api/orgs/invites/accept",
} as const;

export type OrgRole = "owner" | "member";

export interface Org {
	id: string;
	name: string;
	role: OrgRole;
}

export interface OrgMember {
	user_id: string;
	name: string | null;
	email: string;
	role: OrgRole;
	created_at: string;
}

export interface PendingInvite {
	id: string;
	email: string;
	role: OrgRole;
	expires_at: string;
	created_at: string;
}

/**
 * What `verify` says about an invitation.
 *
 * One `valid: false` covers unknown, expired and already-accepted, because the
 * API deliberately does not distinguish them - naming which is a hint to
 * whoever is guessing. The UI must not invent a distinction either.
 */
export interface InviteCheck {
	valid: boolean;
	org?: { id: string; name: string };
	email?: string;
	role?: OrgRole;
}

export function listOrgs(): Promise<{ orgs: Org[] }> {
	return apiClient.get<{ orgs: Org[] }>(ORG_ENDPOINTS.orgs);
}

export function createOrg(name: string): Promise<{ org: Org }> {
	return apiClient.post<{ org: Org }>(ORG_ENDPOINTS.orgs, { name });
}

export function renameOrg(
	orgId: string,
	name: string,
): Promise<{ org: { id: string; name: string } }> {
	return apiClient.patch<{ org: { id: string; name: string } }>(
		`${ORG_ENDPOINTS.orgs}/${encodeURIComponent(orgId)}`,
		{ name },
	);
}

export function listMembers(orgId: string): Promise<{ members: OrgMember[] }> {
	return apiClient.get<{ members: OrgMember[] }>(
		`${ORG_ENDPOINTS.orgs}/${encodeURIComponent(orgId)}/members`,
	);
}

export function setMemberRole(
	orgId: string,
	userId: string,
	role: OrgRole,
): Promise<{ member: { user_id: string; role: OrgRole } }> {
	return apiClient.patch<{ member: { user_id: string; role: OrgRole } }>(
		`${ORG_ENDPOINTS.orgs}/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
		{ role },
	);
}

/** Also how a member leaves: pass your own user id. */
export function removeMember(
	orgId: string,
	userId: string,
): Promise<{ removed: string }> {
	return apiClient.delete<{ removed: string }>(
		`${ORG_ENDPOINTS.orgs}/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
	);
}

export function listInvites(
	orgId: string,
): Promise<{ invites: PendingInvite[] }> {
	return apiClient.get<{ invites: PendingInvite[] }>(
		`${ORG_ENDPOINTS.orgs}/${encodeURIComponent(orgId)}/invites`,
	);
}

export function createInvite(
	orgId: string,
	email: string,
	role: OrgRole = "member",
): Promise<{ invite: PendingInvite }> {
	return apiClient.post<{ invite: PendingInvite }>(
		`${ORG_ENDPOINTS.orgs}/${encodeURIComponent(orgId)}/invites`,
		{ email, role },
	);
}

export function revokeInvite(
	orgId: string,
	inviteId: string,
): Promise<{ revoked: string }> {
	return apiClient.delete<{ revoked: string }>(
		`${ORG_ENDPOINTS.orgs}/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}`,
	);
}

export function verifyInvite(value: string): Promise<InviteCheck> {
	return apiClient.get<InviteCheck>(
		`${ORG_ENDPOINTS.inviteVerify}?token=${encodeURIComponent(value)}`,
	);
}

export function acceptInvite(
	value: string,
): Promise<{ org_id: string; role: OrgRole }> {
	return apiClient.post<{ org_id: string; role: OrgRole }>(
		ORG_ENDPOINTS.inviteAccept,
		{ token: value },
	);
}
```

- [ ] **Step 2: Add the mock**

`mockApi.ts` intercepts by path and returns `Response | null`, the way `mockAccountApi` does at line 294 — it is not an object of methods. Add this beside it, using the file's existing `json` and `readBody` helpers:

```ts
/** One org, two members, one pending invitation - enough for the page to render. */
const MOCK_ORG = { id: "org-acme", name: "Acme", role: "owner" as const };
const MOCK_ORG_MEMBERS = [
	{
		user_id: "user-ada",
		name: "Ada",
		email: "ada@example.com",
		role: "owner" as const,
		created_at: "2026-10-01T00:00:00.000Z",
	},
	{
		user_id: "user-bob",
		name: "Bob",
		email: "bob@example.com",
		role: "member" as const,
		created_at: "2026-10-02T00:00:00.000Z",
	},
];
const MOCK_ORG_INVITES = [
	{
		id: "invite-1",
		email: "carol@example.com",
		role: "member" as const,
		expires_at: "2026-10-11T00:00:00.000Z",
		created_at: "2026-10-04T00:00:00.000Z",
	},
];

async function mockOrgsApi(
	path: string,
	options: RequestInit,
): Promise<Response | null> {
	const method = options.method ?? "GET";

	// GET /api/orgs/invites/verify?token=... - matched before the parameterized
	// paths below, because this file matches on prefixes rather than on the
	// router's segment rules.
	if (method === "GET" && path.startsWith("/api/orgs/invites/verify")) {
		const query = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
		const supplied = new URLSearchParams(query).get("token") ?? "";
		if (supplied === "" || supplied === "stale") return json({ valid: false });
		return json({
			valid: true,
			org: { id: MOCK_ORG.id, name: MOCK_ORG.name },
			email: "carol@example.com",
			role: "member",
		});
	}

	if (method === "POST" && path === "/api/orgs/invites/accept") {
		return json({ org_id: MOCK_ORG.id, role: "member" });
	}

	if (path === "/api/orgs" && method === "GET") {
		return json({ orgs: [MOCK_ORG] });
	}

	if (path === "/api/orgs" && method === "POST") {
		const { name } = readBody<{ name: string }>(options);
		return new Response(
			JSON.stringify({ org: { id: "org-new", name, role: "owner" } }),
			{ status: 201, headers: { "Content-Type": "application/json" } },
		);
	}

	if (path.endsWith("/members") && method === "GET") {
		return json({ members: MOCK_ORG_MEMBERS });
	}

	if (path.endsWith("/invites") && method === "GET") {
		return json({ invites: MOCK_ORG_INVITES });
	}

	if (path.endsWith("/invites") && method === "POST") {
		const { email, role } = readBody<{ email: string; role: OrgRole }>(options);
		return new Response(
			JSON.stringify({
				invite: {
					id: "invite-new",
					email,
					role,
					expires_at: "2026-10-11T00:00:00.000Z",
					created_at: "2026-10-04T00:00:00.000Z",
				},
			}),
			{ status: 201, headers: { "Content-Type": "application/json" } },
		);
	}

	if (path.includes("/members/") && method === "PATCH") {
		const { role } = readBody<{ role: OrgRole }>(options);
		return json({ member: { user_id: path.split("/members/")[1], role } });
	}

	if (path.includes("/members/") && method === "DELETE") {
		return json({ removed: path.split("/members/")[1] });
	}

	if (path.includes("/invites/") && method === "DELETE") {
		return json({ revoked: path.split("/invites/")[1] });
	}

	if (method === "PATCH" && /^\/api\/orgs\/[^/]+$/.test(path)) {
		const { name } = readBody<{ name: string }>(options);
		return json({ org: { id: path.split("/").pop(), name } });
	}

	return null;
}
```

Import `OrgRole` from `./orgsApi` at the top of `mockApi.ts`, then dispatch to it immediately before the final 404 throw, the same shape the account dispatch uses:

```ts
	const orgResponse = await mockOrgsApi(path, options);
	if (orgResponse) return orgResponse;

	const accountResponse = await mockAccountApi(path, options);
	if (accountResponse) return accountResponse;
```

- [ ] **Step 3: Complete the contract cases**

Replace the `ORG_LIFECYCLE` group added in Task 4 with the full set. These are the anonymous cases — every org route refusing a credential-less caller, which is the one claim that holds without a fixture seeding two accounts in one org.

```ts
export const ORG_LIFECYCLE: ContractCase[] = [
	{
		name: "GET /api/orgs with no credential",
		path: "/api/orgs",
		init: { method: "GET" },
		status: 401,
	},
	{
		name: "POST /api/orgs with no credential",
		path: "/api/orgs",
		init: {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Acme" }),
		},
		status: 401,
	},
	{
		name: "GET /api/orgs/:id/members with no credential",
		path: "/api/orgs/any/members",
		init: { method: "GET" },
		status: 401,
	},
	{
		name: "POST /api/orgs/:id/invites with no credential",
		path: "/api/orgs/any/invites",
		init: {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "new@example.com", role: "member" }),
		},
		status: 401,
	},
	{
		// The value is irrelevant - 401 lands before the body is read - so this
		// is deliberately a single character rather than anything resembling a
		// credential.
		name: "POST /api/orgs/invites/accept with no credential",
		path: "/api/orgs/invites/accept",
		init: {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: "x" }),
		},
		status: 401,
	},
	{
		// The one org route that takes no credential by design. An absent token
		// is 400, which is a different claim from an invalid one answering
		// { valid: false } - worth pinning, because a handler that 400s both
		// would make the web app show an error page where it should show
		// "this invitation is no longer valid".
		name: "GET /api/orgs/invites/verify with nothing to check",
		path: "/api/orgs/invites/verify",
		init: { method: "GET" },
		status: 400,
	},
];
```

Add `ORG_LIFECYCLE` to the `anonymousCases` aggregate, and import and run it in `apps/api/src/contract.test.ts` alongside the existing groups.

- [ ] **Step 4: Run both sides of the contract**

Run:
```bash
pnpm --filter @onlooker/api-contract test
pnpm --filter @onlooker/api test src/contract.test.ts
pnpm --filter @onlooker/web test
```
Expected: all pass. The table is asserted against the real worker and against the mock, so a disagreement fails here rather than in a browser.

- [ ] **Step 5: Run the gates and commit**

Run:
```bash
pnpm --filter @onlooker/web test && pnpm --filter @onlooker/web typecheck && pnpm --filter @onlooker/web lint
pnpm --filter @onlooker/api-contract test && pnpm --filter @onlooker/api-contract typecheck && pnpm --filter @onlooker/api-contract lint
pnpm --filter @onlooker/api test && bash scripts/source-guards.test.sh
```
Expected: pass. Biome emits 9 pre-existing `noExplicitAny` warnings in apps/web; warnings do not fail the gate.

Stage `apps/web/src/api/orgsApi.ts`, `apps/web/src/api/mockApi.ts`, `packages/api-contract/src/index.ts`, `apps/api/src/contract.test.ts`. Run `/git-workflow:commit`.

---

### Task 11: The org pages

**Files:**
- Create: `apps/web/src/pages/OrgsPage.tsx`
- Create: `apps/web/src/pages/AcceptInvitePage.tsx`
- Create: `apps/web/src/__tests__/orgs-page.test.tsx`
- Create: `apps/web/src/__tests__/accept-invite-page.test.tsx`
- Modify: `apps/web/src/App.tsx` (two routes)
- Modify: `apps/web/src/pages/SettingsPage.tsx` (a link)

**Interfaces:**
- Consumes: everything `orgsApi.ts` exports from Task 10.
- Produces: `OrgsPage`, `AcceptInvitePage`.

- [ ] **Step 1: Read the pages you are about to imitate**

```bash
cat apps/web/src/pages/MachinesPage.tsx
cat apps/web/src/pages/VerifyEmailPage.tsx
cat apps/web/src/__tests__/machines-page.test.tsx
```

`MachinesPage` is the closest existing shape — a list fetched on mount, a create form, a destructive action per row. `VerifyEmailPage` is the closest shape for `AcceptInvitePage`: a token read from the route, verified on mount, three terminal states. Follow their loading, error and empty-state conventions rather than inventing new ones. `onlooker-ht7` and `onlooker-bcn` are open beads about query-lifecycle duplication in exactly this area, so matching the existing pattern matters more than improving on it here.

- [ ] **Step 2: Write the page tests first**

Create `apps/web/src/__tests__/orgs-page.test.tsx`, following `machines-page.test.tsx`'s setup for mocking the api module and rendering with the app's providers:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrgsPage from "../pages/OrgsPage";

vi.mock("../api/orgsApi", () => ({
	listOrgs: vi.fn(),
	createOrg: vi.fn(),
	listMembers: vi.fn(),
	listInvites: vi.fn(),
	createInvite: vi.fn(),
	revokeInvite: vi.fn(),
	setMemberRole: vi.fn(),
	removeMember: vi.fn(),
}));

const api = await import("../api/orgsApi");

const OWNED = { id: "org-1", name: "Acme", role: "owner" as const };
const JOINED = { id: "org-2", name: "Beta", role: "member" as const };
const MEMBERS = [
	{
		user_id: "u1",
		name: "Ada",
		email: "ada@example.com",
		role: "owner" as const,
		created_at: "2026-10-01T00:00:00.000Z",
	},
];

beforeEach(() => {
	vi.mocked(api.listMembers).mockResolvedValue({ members: MEMBERS });
	vi.mocked(api.listInvites).mockResolvedValue({ invites: [] });
});

describe("OrgsPage", () => {
	it("lists the orgs the caller belongs to", async () => {
		vi.mocked(api.listOrgs).mockResolvedValue({ orgs: [OWNED, JOINED] });
		render(<OrgsPage />);
		expect(await screen.findByText("Acme")).toBeInTheDocument();
		expect(screen.getByText("Beta")).toBeInTheDocument();
	});

	it("says so when the caller is in no org", async () => {
		vi.mocked(api.listOrgs).mockResolvedValue({ orgs: [] });
		render(<OrgsPage />);
		expect(await screen.findByText(/not in any org/i)).toBeInTheDocument();
	});

	it("offers inviting only for an org the caller owns", async () => {
		vi.mocked(api.listOrgs).mockResolvedValue({ orgs: [JOINED] });
		render(<OrgsPage />);
		await screen.findByText("Beta");

		// A control that always 404s is worse than no control: the API refuses an
		// owner action from a plain member, so the page must not offer one.
		expect(
			screen.queryByRole("button", { name: /invite/i }),
		).not.toBeInTheDocument();
		expect(
			await screen.findByRole("button", { name: /leave/i }),
		).toBeInTheDocument();
	});

	it("creates an org and shows it", async () => {
		vi.mocked(api.listOrgs).mockResolvedValue({ orgs: [] });
		vi.mocked(api.createOrg).mockResolvedValue({
			org: { id: "org-new", name: "Gamma", role: "owner" },
		});
		render(<OrgsPage />);

		await userEvent.type(await screen.findByLabelText(/org name/i), "Gamma");
		await userEvent.click(screen.getByRole("button", { name: /create/i }));

		await waitFor(() => expect(api.createOrg).toHaveBeenCalledWith("Gamma"));
		expect(await screen.findByText("Gamma")).toBeInTheDocument();
	});

	it("surfaces a failed load instead of rendering an empty list", async () => {
		vi.mocked(api.listOrgs).mockRejectedValue(new Error("network"));
		render(<OrgsPage />);
		expect(await screen.findByRole("alert")).toBeInTheDocument();
		expect(screen.queryByText(/not in any org/i)).not.toBeInTheDocument();
	});
});
```

Create `apps/web/src/__tests__/accept-invite-page.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AcceptInvitePage from "../pages/AcceptInvitePage";

vi.mock("../api/orgsApi", () => ({
	verifyInvite: vi.fn(),
	acceptInvite: vi.fn(),
}));

const api = await import("../api/orgsApi");

const VALID = {
	valid: true,
	org: { id: "org-1", name: "Acme" },
	email: "carol@example.com",
	role: "member" as const,
};

function renderAt(routeToken: string) {
	return render(
		<MemoryRouter initialEntries={[`/orgs/invites/${routeToken}`]}>
			<Routes>
				<Route path="/orgs/invites/:token" element={<AcceptInvitePage />} />
			</Routes>
		</MemoryRouter>,
	);
}

beforeEach(() => {
	vi.mocked(api.acceptInvite).mockResolvedValue({
		org_id: "org-1",
		role: "member",
	});
});

describe("AcceptInvitePage", () => {
	it("names the org for a valid invitation", async () => {
		vi.mocked(api.verifyInvite).mockResolvedValue(VALID);
		renderAt("good");
		expect(await screen.findByText(/Acme/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /accept/i })).toBeInTheDocument();
	});

	it("gives one message for every unusable invitation", async () => {
		// The API deliberately does not distinguish unknown, expired and spent -
		// naming which is a hint to whoever is guessing - so the UI must not
		// invent a distinction it was never given.
		vi.mocked(api.verifyInvite).mockResolvedValue({ valid: false });
		renderAt("stale");
		expect(
			await screen.findByText(/no longer valid|cannot be used/i),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /accept/i }),
		).not.toBeInTheDocument();
	});

	it("accepts the invitation it was shown", async () => {
		vi.mocked(api.verifyInvite).mockResolvedValue(VALID);
		renderAt("good");
		await userEvent.click(
			await screen.findByRole("button", { name: /accept/i }),
		);
		expect(api.acceptInvite).toHaveBeenCalledWith("good");
	});

	it("explains a wrong-account refusal by naming the invited address", async () => {
		vi.mocked(api.verifyInvite).mockResolvedValue(VALID);
		vi.mocked(api.acceptInvite).mockRejectedValue(
			Object.assign(new Error("wrong_account"), {
				status: 403,
				code: "wrong_account",
			}),
		);
		renderAt("good");
		await userEvent.click(
			await screen.findByRole("button", { name: /accept/i }),
		);
		// Somebody who was forwarded a link needs to be told why it did not work.
		expect(await screen.findByText(/carol@example.com/)).toBeInTheDocument();
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @onlooker/web test orgs-page accept-invite-page`
Expected: FAIL — neither page module exists.

- [ ] **Step 4: Build the pages against those tests**

`OrgsPage.tsx` renders, in order: an error alert if the list failed; a create form whose input is labeled "Org name"; then one section per org.

An org where `role === "owner"` gets the member list with a role control and a remove control per row, an invite form, and the pending-invitation list with a revoke control. An org where `role === "member"` gets the member list read-only and a single "Leave" button calling `removeMember(orgId, myUserId)`.

Two rules the tests encode, both load-bearing:
- **Never render an owner control for a non-owner.** The API answers 404, so the control could only ever fail.
- **A failed load must not render as an empty list.** "You are not in any org" and "we could not find out" are different claims, and showing the first for the second is how somebody concludes their org vanished.

`AcceptInvitePage.tsx` reads `token` from the route, calls `verifyInvite` on mount, and renders exactly one of: a loading state; an invalid state with one message covering every unusable case; or a valid state naming the org with an Accept button. On a 403 from `acceptInvite`, show the invited address from the `verifyInvite` result and offer to sign out — that is the one failure a user can act on. If nobody is signed in, send them to signup with a return path back here.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @onlooker/web test orgs-page accept-invite-page`
Expected: PASS, 9 tests.

- [ ] **Step 6: Register the routes**

In `apps/web/src/App.tsx`, add beside the existing entries. `/orgs` is protected the way `/settings` at line 128 is; `/orgs/invites/:token` is **not**, because an invitee may arrive with no session and needs to see which org invited them before signing up:

```tsx
						<Route
							path="/orgs/invites/:token"
							element={<AcceptInvitePage />}
						/>
```

and `/orgs` inside the protected group, mirroring how `/settings` is wrapped.

- [ ] **Step 7: Link it from settings**

Add a link to `/orgs` from `SettingsPage.tsx`, following that page's existing navigation.

- [ ] **Step 8: Look at it in the real app**

Click through: create an org, invite an address, accept as that address. `sendEmail` has no `RESEND_API_KEY` locally and logs the message instead, so read the invitation link out of the worker's console.

Use the `run` skill if it covers launching this project; otherwise `pnpm --filter @onlooker/api dev` and `pnpm --filter @onlooker/web dev`.

- [ ] **Step 9: Run the gates and commit**

Run: `pnpm --filter @onlooker/web test && pnpm --filter @onlooker/web typecheck && pnpm --filter @onlooker/web lint`

Stage the two pages, the two tests, `App.tsx` and `SettingsPage.tsx`. Run `/git-workflow:commit`.

---

### Task 12: The full sweep, and the handoff

**Files:**
- Modify: `apps/api/DEPLOYMENT.md` or `ENVIRONMENT_VARIABLES.md` if either misstates anything after this stage
- No new code.

- [ ] **Step 1: Run all four gates across every touched package**

```bash
pnpm --filter @onlooker/db test && pnpm --filter @onlooker/db typecheck && pnpm --filter @onlooker/db lint
pnpm --filter @onlooker/api-contract test && pnpm --filter @onlooker/api-contract typecheck && pnpm --filter @onlooker/api-contract lint
pnpm --filter @onlooker/api test && pnpm --filter @onlooker/api typecheck && pnpm --filter @onlooker/api lint
pnpm --filter @onlooker/web test && pnpm --filter @onlooker/web typecheck && pnpm --filter @onlooker/web lint
bash scripts/source-guards.test.sh
```

Record the actual counts. "Tests pass" is not a result; `api 451/451` is.

- [ ] **Step 2: Confirm this stage touched no lesson code**

```bash
git diff --stat main -- apps/api/src/db/pool.ts apps/api/src/db/lessons.ts apps/api/src/routes/lessons.ts
```
Expected: empty. Stage 1 has no business in any of those, and a diff here means something leaked across the stage boundary.

- [ ] **Step 3: Confirm the push gate is still shut for org**

```bash
pnpm --filter @onlooker/api test src/routes/lessons.test.ts
```
Expected: PASS, including "rejects org with a message naming the tier". Stage 1 must not open the tier — orgs now exist, but no lesson can be shared with one until Stage 2 lands the predicate. If this test fails, the stage boundary has been crossed and the retroactive-disclosure problem the whole design avoids is now live.

- [ ] **Step 4: Update the bead**

```bash
bd update onlooker-wi9ftq --append-notes "STAGE 1 COMPLETE <date>: org accounts landed. <N> tests, four gates green. Push gate still shut for org, verified by routes/lessons.test.ts. Stage 2 plan next."
```

Use `--append-notes`, never `--notes`: `--notes` overwrites the entire NOTES body and only warns afterward.

- [ ] **Step 5: Hand off**

Report: files changed, the actual gate counts, what is deployed versus merged, and the fact that Stage 2 is unstarted. Do not claim the org tier works — nothing can be shared with an org until Stage 2.

---

## Deferred to the Stage 2 plan

Written after Stage 1 lands, because two of its tasks cannot be specified honestly before then:

- `lessons.org_id` and `machine_tokens.org_id`, the predicate rekey from `OrgMembers` to `OrgIds`, attribution, owner retract, and the push gate opening.
- **The index and its query plan.** `pool-query-plan.test.ts` EXPLAINs the real prepared statement, and a third disjunct changes that plan in ways a document should not guess. It gets measured against a database built from the real migrations, and the measured output goes into the spec.
- **The regression test for the author-keyed predicate bug**, which needs two orgs to exist before it can be written — so it needs Stage 1.
