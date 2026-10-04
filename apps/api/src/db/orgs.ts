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
