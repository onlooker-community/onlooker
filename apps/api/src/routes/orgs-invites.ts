import {
	createInvite,
	deleteInvite,
	deletePendingInvitesFor,
	listPendingInvites,
	normalizeEmail,
} from "../db/org-invites.js";
import { getOrgName, isOrgRole, listMembers } from "../db/orgs.js";
import type { Principal } from "../db/pool.js";
import { sendEmail } from "../email";
import { orgInviteEmail } from "../email/templates.js";
import { requireOrgRole } from "../orgs/authorize.js";
import { resolveInviteWindow } from "../orgs/invite-window.js";
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
	const email =
		typeof body.email === "string" ? normalizeEmail(body.email) : "";
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

	const expiresAt = new Date(Date.now() + window.ms).toISOString();

	await deletePendingInvitesFor(env.DB, params.id, email);
	const invite = await createInvite(env.DB, {
		orgId: params.id,
		email,
		role,
		tokenHash: await hashToken(token),
		expiresAt,
		invitedBy: userId,
	});

	const inviter = members.find((member) => member.user_id === userId);
	await sendEmail(
		env,
		orgInviteEmail(
			email,
			// Owners can rename an org, so the name is read at send time rather
			// than cached anywhere.
			(await getOrgName(env.DB, params.id)) ?? "an Onlooker org",
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
				expires_at: expiresAt,
			},
		},
		{ status: 201 },
	);
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
