import type { Principal } from "../db/pool.js";
import { isAnonymizedAccount } from "../db/queries.js";
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
 *
 * "session" and "operator" each pay one indexed primary-key read here, for
 * `refuseAnonymized`. Accepted because the alternative is an open window: an
 * anonymized `users` row survives as an org lesson's anchor (ONL-136), so
 * without this a session token issued before anonymization keeps authenticating
 * - and keeps WRITING - for up to TOKEN_EXPIRY_MINUTES. Deletion's older,
 * unconditional path needed no such check, because there the row was simply
 * gone and every read or write downstream failed on its own. This is the one
 * place both modes route through, so it is also the one place that pays for
 * it - a handler reusing this principal never reads the row a second time on
 * its account.
 */
export async function resolvePrincipal(
	request: Request,
	env: WorkerEnv,
	auth: RouteAuth,
): Promise<Principal | null> {
	switch (auth) {
		case "none":
			return null;

		case "session": {
			const { userId } = await requireAuth(request, env);
			await refuseAnonymized(env, userId);
			return { userId };
		}

		case "machine":
			// No row check here. A machine token is its own row in
			// machine_tokens, and deleteUser's anonymize batch deletes every
			// one for the account in the same transaction that sets
			// anonymized_at - so a token surviving to this point was minted
			// after anonymization, which the "session" case above now
			// refuses at the source.
			return { userId: (await requireMachineToken(request, env)).userId };

		case "operator": {
			const { userId } = await requireAuth(request, env);
			await refuseAnonymized(env, userId);
			if (!operatorIds(env).includes(userId)) {
				// 404-shaped on purpose. Reached only after requireAuth above
				// already succeeded, so a credential-less caller never gets
				// here - they got 401, the same as any other protected route.
				// This 404 is what a SIGNED-IN non-operator gets instead of
				// 403, specifically so they cannot tell this route apart from
				// one that does not exist.
				throw new ApiError(404, "not_found", "Route not found");
			}
			return { userId };
		}
	}
}

/**
 * Refuses a principal whose account has been anonymized.
 *
 * Same shape as `requireAuth`'s own refusal for a credential it will not
 * accept - 401 `invalid_token` - rather than a new error code, so a client
 * that already handles "your session is no longer valid" handles this too.
 * The caller cannot tell "the signature checked out but the account is gone"
 * from "the signature did not check out", which is the same non-disclosure
 * `requireAuth` already gives a bad JWT.
 */
async function refuseAnonymized(env: WorkerEnv, userId: string): Promise<void> {
	if (await isAnonymizedAccount(env.DB, userId)) {
		throw new ApiError(401, "invalid_token", "Invalid or expired token");
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
