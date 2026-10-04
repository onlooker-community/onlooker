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
