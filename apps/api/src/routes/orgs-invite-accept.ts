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
