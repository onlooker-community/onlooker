import type { D1Database } from "@cloudflare/workers-types";
import { org_invites } from "@onlooker/db";
import { and, eq, isNull } from "drizzle-orm";
import { client } from "./client.js";
import { type OrgRole, toOrgRole } from "./orgs.js";

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
		.where(and(eq(org_invites.org_id, orgId), isNull(org_invites.accepted_at)))
		.orderBy(org_invites.created_at);

	return rows.map((row) => ({
		id: row.id,
		email: row.email,
		role: toOrgRole(row.role),
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
		role: toOrgRole(row.role),
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
