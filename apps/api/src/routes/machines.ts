import {
	createMachineToken,
	listMachineTokens,
	revokeMachineToken,
} from "../db/machine-tokens.js";
import { getMembership } from "../db/orgs.js";
import type { Principal } from "../db/pool.js";
import type { RouteParams, WorkerEnv } from "../types";
import { ApiError } from "../types";

/**
 * Machine management is browser-authenticated, never machine-authenticated.
 *
 * A machine token that could mint further machine tokens would make revocation
 * meaningless: revoking the stolen laptop would not reach the credentials it
 * had already issued for itself.
 */
export async function handleCreateMachine(
	request: Request,
	env: WorkerEnv,
	_params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	// The router resolved this from the route's `auth: "session"`, which throws
	// rather than returning null, so it cannot be null here.
	const { userId } = principal as Principal;
	const body = (await request.json()) as { name?: unknown; org_id?: unknown };

	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (!name) {
		throw new ApiError(400, "invalid_name", "A machine needs a name");
	}

	// Membership is checked here, at minting, rather than at push. The token
	// then carries the answer, so push reads an org the holder was a member of
	// when the credential was issued and no request parameter can change it.
	//
	// 404 rather than 403 for an org the caller is not in, matching
	// orgs/authorize.ts: a non-member cannot tell that org apart from one that
	// does not exist.
	const orgId = typeof body.org_id === "string" ? body.org_id : null;
	if (orgId !== null) {
		const membership = await getMembership(env.DB, orgId, userId);
		if (!membership) {
			throw new ApiError(404, "not_found", "No such org");
		}
	}

	const created = await createMachineToken(env.DB, userId, name, orgId);

	// The raw token appears in this response and nowhere else, ever.
	return Response.json(
		{ id: created.id, name, token: created.token, org_id: orgId },
		{ status: 201 },
	);
}

export async function handleListMachines(
	_request: Request,
	env: WorkerEnv,
	_params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	// The router resolved this from the route's `auth: "session"`, which throws
	// rather than returning null, so it cannot be null here.
	const { userId } = principal as Principal;
	return Response.json({ machines: await listMachineTokens(env.DB, userId) });
}

export async function handleRevokeMachine(
	_request: Request,
	env: WorkerEnv,
	params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	// The router resolved this from the route's `auth: "session"`, which throws
	// rather than returning null, so it cannot be null here.
	const { userId } = principal as Principal;
	const id = params.id;

	// 404 rather than 403 when the machine belongs to someone else. A 403 would
	// confirm the id exists, which is an existence oracle over other users' rows.
	if (!(await revokeMachineToken(env.DB, userId, id))) {
		throw new ApiError(404, "not_found", "No such machine");
	}

	return Response.json({ success: true });
}
