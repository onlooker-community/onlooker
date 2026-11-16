import { verifyMachineToken } from "../db/machine-tokens.js";
import { monitor } from "../monitoring";
import type { WorkerEnv } from "../types";
import { ApiError } from "../types";
import { extractToken } from "./auth.js";

type VerifiedMachine = {
	userId: string;
	machineId: string;
	orgId: string | null;
};

/**
 * Verifications already made, by request.
 *
 * The router verifies every `auth: "machine"` route before its handler runs,
 * and the handlers that need `machineId` or `orgId` call this again, because
 * `Principal` deliberately carries only `userId` (see db/pool.ts). Without
 * this, each of those requests read `machine_tokens` twice and wrote
 * `last_used_at` twice (ONL-223).
 *
 * Keyed on the Request object, so a verification never outlives the request
 * it was made for: a token revoked between two requests is refused by the
 * second. Only successes are kept; a refusal throws and is never reused.
 */
const verified = new WeakMap<Request, VerifiedMachine>();

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
): Promise<VerifiedMachine> {
	const already = verified.get(request);
	if (already) return already;

	const token = extractToken(request);
	if (!token) {
		throw new ApiError(401, "unauthorized", "Missing machine token");
	}

	const machine = await verifyMachineToken(env.DB, token);
	if (!machine) {
		throw new ApiError(
			401,
			"invalid_token",
			"Invalid or revoked machine token",
		);
	}

	// The account the machine belongs to, so a fault during `onlooker sync`
	// is findable from the same user as one in the browser.
	monitor.setUser({ id: machine.userId });

	verified.set(request, machine);
	return machine;
}
