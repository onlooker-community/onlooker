import type { D1Database } from "@cloudflare/workers-types";
import { org_memberships, orgs, users } from "@onlooker/db";
import { and, eq, sql } from "drizzle-orm";
import { client } from "./client.js";

/**
 * Org membership and roles: creation, renaming, who belongs, who owns.
 *
 * NOT the only home for a query against `orgs`, despite what an earlier
 * version of this comment claimed. `org_invites` never lived here at all -
 * that table is `db/org-invites.ts`'s, a sibling module, and
 * `routes/orgs-invite-accept.ts` holds its own `orgs` name lookup for
 * displaying an invitation before anyone signs in.
 *
 * `db/pool.ts` holds two more `orgs` queries of its own - `retractableOrgs`'s
 * name lookup and `orgRetractableFor`'s JOIN - and that one is load-bearing,
 * not drift. `scripts/source-guards.test.sh` lets only `db/lessons.ts` and
 * `db/pool.ts` query `lessons` or `lesson_feed`, so a lookup that has to
 * correlate an org with a lesson row - "which org may retract THIS lesson" -
 * cannot be factored out here without either querying `lessons` from a third
 * file (which the guard refuses) or duplicating `visibilityPredicate`'s
 * boundary into a second copy (which is the worse defect `orgAuthorFacts`'s
 * own doc comment already explains).
 *
 * `org_memberships` was this file's alone until ONL-136 landed. `db/queries.ts`
 * holds two now, inside `deleteUser`: the anonymize UPDATE's own sole-owner
 * subquery, and the `DELETE FROM org_memberships` gated on that UPDATE having
 * landed. Both are there for a reason of the same shape: the sole-owner guard
 * has to be part of the write against `users` to be atomic, so a membership
 * count read from here first could interleave with a concurrent demotion and
 * let the last owner go. Beyond those two and
 * `test-support/orgs.ts`'s teardown DELETE, this file is still where plain
 * membership and role questions belong. The ones that have to be atomic with
 * another table's write, or that join against a lesson, belong beside what
 * they join.
 */

export type OrgRole = "owner" | "member";

/** Whether an arbitrary string is a role this system recognizes. */
export function isOrgRole(value: unknown): value is OrgRole {
	return value === "owner" || value === "member";
}

/**
 * Narrow and validate a role read from the database.
 *
 * The `role` column is stored as plain text, not a SQL enum. A corrupted,
 * unexpected, or future value currently passes through as a typed OrgRole
 * with no error. This narrowing helper catches the problem at the read
 * boundary and fails loud and early rather than handing corrupt data to
 * routes or the web app.
 */
export function toOrgRole(value: unknown): OrgRole {
	if (isOrgRole(value)) return value;
	throw new Error(`Invalid org role: ${String(value)}`);
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
		role: toOrgRole(row.role),
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
	return row ? { role: toOrgRole(row.role) } : null;
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
		role: toOrgRole(row.role),
		created_at: row.created_at,
	}));
}

/**
 * An org's name, for a message that has to say which org.
 *
 * Returns null rather than a placeholder - the caller decides what a missing
 * org means for its own purpose (an invite email still has to say something;
 * a 404 should not).
 */
export async function getOrgName(
	db: D1Database,
	orgId: string,
): Promise<string | null> {
	const row = await db
		.prepare("SELECT name FROM orgs WHERE id = ?")
		.bind(orgId)
		.first<{ name: string }>();
	return row?.name ?? null;
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

/**
 * Outcome of a write that must not leave an org without an owner.
 *
 * A write that is refused to protect the last owner is a normal result, not
 * an exceptional one - the same way `false` meant "not a member" before
 * these had a third outcome to report.
 */
export type MembershipWriteResult = "ok" | "not_member" | "last_owner";

/**
 * Remove a member.
 *
 * The last-owner check lives in the DELETE's own WHERE clause rather than in
 * a `countOwners` read before an unconditional delete. Two round-trips give
 * two concurrent removals on a two-owner org a window to both read "2"
 * before either write lands, leaving zero - the one state no route can
 * repair. Folding the condition into the statement makes the check and the
 * write atomic, since D1 runs one statement as one transaction.
 *
 * A zero-row result is then ambiguous - not a member, or refused to protect
 * the last owner - so it is resolved with one more read. That read is not
 * itself racy: the write has already safely failed one way or the other,
 * and the read only chooses which answer the caller gets.
 */
export async function removeMembership(
	db: D1Database,
	orgId: string,
	userId: string,
): Promise<MembershipWriteResult> {
	const result = await db
		.prepare(
			`DELETE FROM org_memberships
			 WHERE org_id = ? AND user_id = ?
			   AND (role = 'member'
			        OR (SELECT COUNT(*) FROM org_memberships
			            WHERE org_id = ? AND role = 'owner') > 1)`,
		)
		.bind(orgId, userId, orgId)
		.run();

	if ((result.meta.changes ?? 0) > 0) return "ok";

	const membership = await getMembership(db, orgId, userId);
	return membership ? "last_owner" : "not_member";
}

/**
 * Change a member's role.
 *
 * Same atomicity reasoning as removeMembership just above: the last-owner
 * condition is part of the UPDATE's WHERE clause, not a separate read before
 * an unconditional write, so the two cannot interleave across concurrent
 * requests. The write is allowed when it is a promotion, when the target is
 * not currently an owner, or when another owner remains.
 */
export async function setMemberRole(
	db: D1Database,
	orgId: string,
	userId: string,
	role: OrgRole,
): Promise<MembershipWriteResult> {
	const result = await db
		.prepare(
			`UPDATE org_memberships SET role = ?
			 WHERE org_id = ? AND user_id = ?
			   AND (? = 'owner'
			        OR role = 'member'
			        OR (SELECT COUNT(*) FROM org_memberships
			            WHERE org_id = ? AND role = 'owner') > 1)`,
		)
		.bind(role, orgId, userId, role, orgId)
		.run();

	if ((result.meta.changes ?? 0) > 0) return "ok";

	const membership = await getMembership(db, orgId, userId);
	return membership ? "last_owner" : "not_member";
}

/**
 * How many owners this org has.
 *
 * No longer the last-owner guard itself - that moved into the WHERE clause
 * of setMemberRole and removeMembership above, so the check and the write
 * cannot interleave. Kept as a plain read for callers that just want the
 * count, such as a test.
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

/**
 * The ids of the orgs this user belongs to.
 *
 * This is what the read predicate's org disjunct binds. It reads
 * `org_memberships` by `user_id`, which `org_memberships_user_id_idx` exists
 * for.
 *
 * Ordered by id so a given reader's bound org list is deterministic between
 * calls - worth having on its own, independent of any query-plan test, since
 * a resolver whose output order varies would make the predicate's bind list
 * vary with it for no reason.
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

/**
 * The orgs this user owns alone.
 *
 * Explanatory only. `deleteUser` decides the refusal itself, inside its own
 * DELETE, because a decision made from a separate read can interleave with a
 * concurrent demotion. This runs only after that write has already refused,
 * to say which orgs are responsible - so a drifting answer here can misname
 * an org in an error message but can never admit a deletion the guard
 * rejected, nor reject one it allowed.
 *
 * Ordered by name so the message is stable between calls.
 */
export async function soleOwnedOrgs(
	db: D1Database,
	userId: string,
): Promise<{ id: string; name: string }[]> {
	const rows = await db
		.prepare(
			`SELECT o.id AS id, o.name AS name
			   FROM orgs o
			   JOIN org_memberships m ON m.org_id = o.id
			  WHERE m.user_id = ? AND m.role = 'owner'
			    AND (SELECT COUNT(*) FROM org_memberships c
			         WHERE c.org_id = o.id AND c.role = 'owner') = 1
			  ORDER BY o.name`,
		)
		.bind(userId)
		.all<{ id: string; name: string }>();

	return rows.results ?? [];
}

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
