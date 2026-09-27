import {
	createMachineToken,
	listMachineTokens,
	revokeMachineToken,
} from "../db/machine-tokens.js";
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
	const body = (await request.json()) as { name?: unknown };

	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (!name) {
		throw new ApiError(400, "invalid_name", "A machine needs a name");
	}

	const created = await createMachineToken(env.DB, userId, name);

	// The raw token appears in this response and nowhere else, ever.
	return Response.json(
		{ id: created.id, name, token: created.token },
		{
			status: 201,
		},
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
