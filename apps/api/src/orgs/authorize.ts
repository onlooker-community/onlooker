import type { D1Database } from "@cloudflare/workers-types";
import { getMembership, type OrgRole } from "../db/orgs.js";
import type { Principal } from "../db/pool.js";
import { ApiError } from "../types";

/**
 * The one place an org role is checked.
 *
 * Why this is a function and not a `RouteAuth` value: `dispatch` resolves a
 * principal from the credential alone, before the handler runs. "Owner of the
 * org named in this path" needs a path parameter and a database read, so
 * declaring it in the route table would make that table look authoritative for
 * a question it cannot answer.
 *
 * What keeps this from being the auth-by-omission the shared read path existed
 * to end is not this function - it is the enumerated contract test in
 * routes/orgs-authorization.test.ts, which lists every /api/orgs route with
 * the role it requires and fails when a route is added without an entry.
 *
 * 404, never 403, and the SAME 404 for every refusal: an org you do not belong
 * to should not confirm that it exists, and a non-member must not be able to
 * tell an org they cannot see from one that was never there. That matches the
 * operator surface - see router.ts:372.
 */
export async function requireOrgRole(
	db: D1Database,
	principal: Principal | null,
	orgId: string,
	required: OrgRole,
): Promise<OrgRole> {
	const refuse = () => new ApiError(404, "not_found", "No such org");

	// Routes carrying `auth: "session"` cannot reach here with a null
	// principal, since resolvePrincipal throws first. Handled anyway, because
	// the alternative is a non-null assertion that becomes wrong the day
	// somebody declares an org route `auth: "none"`.
	if (!principal) throw refuse();

	const membership = await getMembership(db, orgId, principal.userId);
	if (!membership) throw refuse();
	if (required === "owner" && membership.role !== "owner") throw refuse();

	return membership.role;
}
