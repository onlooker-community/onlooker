import {
	countMembers,
	createOrgWithOwner,
	deleteOrg,
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

/**
 * Delete an org, for an owner who is its only member.
 *
 * The 409 names no members. The only page that renders this already lists
 * them - OrgsPage fetches members for every role - so the count is what it
 * cannot work out for itself. That is the same reasoning
 * MachineTokenSummary.org_id gives for carrying an id without a name.
 *
 * The 404 for an already-deleted org is deliberate, and the opposite of
 * handleDeleteAccount's choice to report success for an account that is
 * already gone. There the caller's own identity was the target and "make it
 * gone" was satisfied; here the caller is asserting something about a
 * resource that is no longer theirs to assert anything about, which is what
 * requireOrgRole would have said a moment earlier.
 */
export async function handleDeleteOrg(
	_request: Request,
	env: WorkerEnv,
	params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	await requireOrgRole(env.DB, principal, params.id, "owner");

	const outcome = await deleteOrg(
		env.DB,
		params.id,
		(principal as Principal).userId,
	);

	if (outcome === "has_members") {
		throw new ApiError(
			409,
			"has_members",
			"An org with other members cannot be deleted; remove them first",
			{ member_count: await countMembers(env.DB, params.id) },
		);
	}

	if (outcome === "not_found") {
		// Reachable only by the caller's own second in-flight request racing
		// this one to delete the same org - requireOrgRole above already ruled
		// out every other principal. Byte-identical to the 404 requireOrgRole
		// itself throws (orgs/authorize.ts:31), so no test can pin behavior this
		// branch would diverge from; db/orgs.test.ts covers deleteOrg's own
		// not_found at the layer that decides it.
		throw new ApiError(404, "not_found", "No such org");
	}

	return Response.json({ deleted: params.id });
}
