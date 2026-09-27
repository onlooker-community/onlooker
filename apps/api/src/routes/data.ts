/**
 * Protected data routes for WS4 (authenticated, protected resources).
 * These endpoints require a valid access token and return user-specific data.
 *
 * This file once also served /api/dashboard - three numbers invented for a
 * scaffold, deleted in onlooker-yfw along with the page that read them.
 */

import { jsonResponse, requireAuth } from "../middleware";
import type { UserProfile, WorkerEnv } from "../types";

/**
 * GET /api/users/me
 * Get the user's profile information.
 * Used by the Profile page and as part of session loading.
 *
 * Requires: Access token
 * Response: UserProfile
 * Errors: 401 (unauthorized)
 */
export async function handleGetUserProfile(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	// Kept rather than reading the router-resolved principal: the stub below
	// puts `email` into a required `UserProfile` field, and `Principal`
	// deliberately does not carry it (see db/pool.ts), so only `requireAuth`'s
	// own return value has it. Not worth a DB lookup either - `requireAuth` is
	// a local JWT verify with no I/O, cheaper than the round trip a real fetch
	// would cost, and this is still the `TODO: WS1 will implement` stub below.
	const auth = await requireAuth(request, env);

	// TODO: WS1 will implement
	// const profile = await db.getUserProfile(auth.userId)

	// Stub response for type checking
	const stubProfile: UserProfile = {
		id: auth.userId,
		email: auth.email,
		name: "User Name",
		createdAt: new Date().toISOString(),
		lastLoginAt: new Date().toISOString(),
	};

	return jsonResponse(stubProfile);
}
