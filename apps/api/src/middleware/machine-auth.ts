import { verifyMachineToken } from "../db/machine-tokens.js";
import type { WorkerEnv } from "../types";
import { ApiError } from "../types";
import { extractToken } from "./auth.js";

/**
 * Require a valid machine token.
 *
 * Deliberately separate from requireAuth rather than a branch inside it. The
 * two credentials authorize different things: a browser session can change the
 * account password and delete the account, and a machine token must never be
 * able to do either. Keeping them apart means that boundary is visible at every
 * route rather than buried in a conditional.
 */
export async function requireMachineToken(
	request: Request,
	env: WorkerEnv,
): Promise<{ userId: string }> {
	const token = extractToken(request);
	if (!token) {
		throw new ApiError(401, "unauthorized", "Missing machine token");
	}

	const userId = await verifyMachineToken(env.DB, token);
	if (!userId) {
		throw new ApiError(
			401,
			"invalid_token",
			"Invalid or revoked machine token",
		);
	}

	return { userId };
}
