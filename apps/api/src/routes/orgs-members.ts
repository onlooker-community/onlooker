import {
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

	// The last-owner check lives inside setMemberRole's own WHERE clause now,
	// not in a read-then-write here: see db/orgs.ts for why a pre-check and a
	// separate write cannot be trusted to stay atomic.
	const result = await setMemberRole(
		env.DB,
		params.id,
		params.userId,
		body.role,
	);
	if (result === "not_member") {
		throw new ApiError(404, "not_found", "No such member");
	}
	if (result === "last_owner") {
		throw new ApiError(
			409,
			"last_owner",
			"An org needs an owner; promote somebody else first",
		);
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

	// Same reasoning as handleSetMemberRole above: the last-owner check lives
	// inside removeMembership's own WHERE clause, not in a read-then-write
	// here.
	const result = await removeMembership(env.DB, params.id, params.userId);
	if (result === "not_member") {
		throw new ApiError(404, "not_found", "No such member");
	}
	if (result === "last_owner") {
		throw new ApiError(
			409,
			"last_owner",
			"An org needs an owner; promote somebody else first",
		);
	}

	return Response.json({ removed: params.userId });
}
