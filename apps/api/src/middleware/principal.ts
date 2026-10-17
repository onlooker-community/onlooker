import type { Principal } from "../db/pool.js";
import { isDepartedAccount } from "../db/queries.js";
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
 * `refuseDeparted`. Accepted because the alternative is an open window: a
 * token is a signed JWT that no write can withdraw, so without this a session
 * token issued before the account went away keeps authenticating - and keeps
 * WRITING - for up to TOKEN_EXPIRY_MINUTES.
 *
 * BOTH ways an account departs are refused here, and for a while only one was.
 * ONL-136 added this check for the anonymize path, where the `users` row
 * survives as an org lesson's anchor, on the reasoning that an outright
 * deletion needed no check because the row was gone and every read or write
 * downstream would fail on its own. That reasoning was wrong about reads: a
 * read scoped to a vanished user_id matches nothing and answers 200 with an
 * empty list, which is not a failure. Measured against production on
 * 2026-10-11, `GET /api/orgs` answered `200 {"orgs":[]}` to a deleted
 * account's token (ONL-146). So the same lookup now concludes "gone" for a
 * missing row too - one query, two causes, one answer.
 *
 * This is the one place both modes route through, so it is also the one place
 * that pays for it - a handler reusing this principal never reads the row a
 * second time on its account.
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
			await refuseDeparted(env, userId);
			return { userId };
		}

		case "machine":
			// No row check here, and it covers both departures. A machine token
			// is its own row in machine_tokens: the anonymize batch deletes
			// every one for the account in the same transaction that sets
			// anonymized_at, and an outright deletion takes them by
			// ON DELETE CASCADE (packages/db schema, machine_tokens.user_id).
			// Either way the credential is gone rather than merely stale, so
			// requireMachineToken below finds nothing to accept. A token
			// surviving to this point was minted after the account departed,
			// which the "session" case above refuses at the source.
			return { userId: (await requireMachineToken(request, env)).userId };

		case "operator": {
			const { userId } = await requireAuth(request, env);
			await refuseDeparted(env, userId);
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
 * Refuses a principal whose account is gone - deleted or anonymized.
 *
 * Same shape as `requireAuth`'s own refusal for a credential it will not
 * accept - 401 `invalid_token` - rather than a new error code, so a client
 * that already handles "your session is no longer valid" handles this too.
 * The caller cannot tell "the signature checked out but the account is gone"
 * from "the signature did not check out", which is the same non-disclosure
 * `requireAuth` already gives a bad JWT.
 */
async function refuseDeparted(env: WorkerEnv, userId: string): Promise<void> {
	if (await isDepartedAccount(env.DB, userId)) {
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
