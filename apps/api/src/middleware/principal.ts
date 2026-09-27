import type { Principal } from "../db/pool.js";
import type { WorkerEnv } from "../types";
import { ApiError } from "../types";
import { requireAuth } from "./auth.js";
import { requireMachineToken } from "./machine-auth.js";

/**
 * How a route authenticates, declared at the route table rather than called
 * inside the handler.
 *
 * The old arrangement made this invisible: whether a route checked a credential
 * was discoverable only by reading its handler, so a forgotten call was an open
 * endpoint and nothing said so.
 */
export type RouteAuth = "none" | "session" | "machine" | "operator";

/**
 * Which origins may read a route's response.
 *
 * Separate from RouteAuth on purpose. "none" cannot drive the wildcard, because
 * login and signup are unauthenticated too and must stay origin-locked.
 */
export type RouteCors = "app" | "any";

/**
 * Who is calling, per the route's declaration.
 *
 * Returns null only for `auth: "none"`. Every other mode either produces a
 * principal or throws, so a handler never has to decide whether an absent
 * principal was allowed.
 */
export async function resolvePrincipal(
	request: Request,
	env: WorkerEnv,
	auth: RouteAuth,
): Promise<Principal | null> {
	switch (auth) {
		case "none":
			return null;

		case "session":
			return { userId: (await requireAuth(request, env)).userId };

		case "machine":
			return { userId: (await requireMachineToken(request, env)).userId };

		case "operator": {
			const { userId } = await requireAuth(request, env);
			if (!operatorIds(env).includes(userId)) {
				// 404-shaped on purpose: an operator route should not confirm
				// its own existence to a signed-in non-operator.
				throw new ApiError(404, "not_found", "Route not found");
			}
			return { userId };
		}
	}
}

/**
 * The accounts that may moderate, from the environment rather than the
 * database, so granting it is a deploy somebody reviews.
 *
 * Empty means nobody, which is the shipping default.
 */
function operatorIds(env: WorkerEnv): string[] {
	return (env.OPERATOR_USER_IDS ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0);
}
