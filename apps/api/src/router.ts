/**
 * Route dispatcher - maps HTTP method + path to handler functions.
 * Organizes all endpoints by feature area (auth, account, data).
 */

import type { Principal } from "./db/pool.js";
import { errorHandler } from "./middleware";
import type { RouteAuth, RouteCors } from "./middleware/principal.js";
import { resolvePrincipal } from "./middleware/principal.js";
import {
	handleActivity,
	handleBlockAuthor,
	handleBrowseLessons,
	handleBrowserTransition,
	handleChangePassword,
	handleClientError,
	handleCreateMachine,
	handleDeleteAccount,
	handleForgotPassword,
	handleGetInventory,
	handleGetLesson,
	handleGetProfile,
	handleGetSessions,
	handleGetUserProfile,
	handleListMachines,
	handleLogin,
	handleLogout,
	handleMe,
	handleOperatorRetract,
	handlePostSessions,
	handlePublicLesson,
	handlePushLessons,
	handlePutInventory,
	handleReadLessons,
	handleRefresh,
	handleResendVerification,
	handleResetPassword,
	handleRevokeMachine,
	handleSignup,
	handleTransitionLesson,
	handleUnblockAuthor,
	handleUpdateProfile,
	handleVerifyEmail,
	handleVerifyResetToken,
} from "./routes";
import type { RouteParams, WorkerEnv } from "./types";
import { ApiError } from "./types";

/**
 * `auth` and `cors` are required, not merely conventional, and that
 * requiredness is enforced by the compiler: an entry in `ROUTES` missing
 * either field fails to typecheck. Deliberately not a test - a required
 * field on an object literal cannot fail to be present at runtime, so a test
 * asserting it would only ever pass, which is not evidence of anything.
 */
export interface Route {
	method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
	path: string;
	/**
	 * How this route authenticates. Required, so a new route cannot be added
	 * without the author choosing - which is the whole point of the field.
	 * Resolved centrally in `dispatch`, before the handler runs, via
	 * `resolvePrincipal`.
	 */
	auth: RouteAuth;
	/** Which origins may read the response. The default posture is "app". */
	cors: RouteCors;
	/**
	 * `params` is optional so the handlers on fixed paths - which is most of
	 * them - need no signature change. Only the parameterized routes read it.
	 *
	 * `principal` is what a handler acts on: `dispatch` resolves it from the
	 * route's declared `auth` before the handler runs, via `resolvePrincipal`,
	 * and almost every handler reads `userId` off it rather than verifying its
	 * own credential. Three handlers still make their own call because each
	 * needs a field `Principal` deliberately does not carry (see `db/pool.ts`):
	 * `handlePutInventory` and `handlePostSessions` need `machineId`, and
	 * `handleGetUserProfile` needs `email`. The two `machineId` ones re-verify
	 * against D1 and re-write `last_used_at` on every request; the `email` one
	 * is a local HMAC verify with no I/O.
	 */
	handler: (
		request: Request,
		env: WorkerEnv,
		params: RouteParams,
		principal: Principal | null,
	) => Promise<Response>;
}

export const ROUTES: Route[] = [
	// =========================================================================
	// Authentication routes (WS1 - login/signup/refresh/logout)
	// =========================================================================
	{
		method: "POST",
		path: "/auth/login",
		auth: "none",
		cors: "app",
		handler: handleLogin,
	},
	{
		method: "POST",
		path: "/auth/signup",
		auth: "none",
		cors: "app",
		handler: handleSignup,
	},
	{
		method: "POST",
		path: "/auth/refresh",
		auth: "none",
		cors: "app",
		handler: handleRefresh,
	},
	{
		method: "GET",
		path: "/auth/me",
		auth: "session",
		cors: "app",
		handler: handleMe,
	},
	{
		// Unauthenticated: handleLogout calls optionalAuth, which never throws,
		// because a logout request must not fail on a token that is already bad
		// - that is the caller it most needs to let through.
		method: "POST",
		path: "/auth/logout",
		auth: "none",
		cors: "app",
		handler: handleLogout,
	},

	// =========================================================================
	// Account management routes (WS2 - profile, password, email verification)
	// =========================================================================
	{
		method: "GET",
		path: "/auth/profile",
		auth: "session",
		cors: "app",
		handler: handleGetProfile,
	},
	{
		method: "PATCH",
		path: "/auth/profile",
		auth: "session",
		cors: "app",
		handler: handleUpdateProfile,
	},
	{
		method: "POST",
		path: "/auth/change-password",
		auth: "session",
		cors: "app",
		handler: handleChangePassword,
	},
	{
		method: "DELETE",
		path: "/auth/account",
		auth: "session",
		cors: "app",
		handler: handleDeleteAccount,
	},
	{
		// Unauthenticated: the credential here is the verification token in the
		// request body, not a session.
		method: "POST",
		path: "/auth/verify-email",
		auth: "none",
		cors: "app",
		handler: handleVerifyEmail,
	},
	{
		method: "POST",
		path: "/auth/resend-verification",
		auth: "session",
		cors: "app",
		handler: handleResendVerification,
	},
	{
		method: "POST",
		path: "/auth/forgot-password",
		auth: "none",
		cors: "app",
		handler: handleForgotPassword,
	},
	{
		method: "GET",
		path: "/auth/reset-password/verify",
		auth: "none",
		cors: "app",
		handler: handleVerifyResetToken,
	},
	{
		// Unauthenticated: the credential is the reset token in the body, the
		// same as verify-email above.
		method: "POST",
		path: "/auth/reset-password",
		auth: "none",
		cors: "app",
		handler: handleResetPassword,
	},

	// =========================================================================
	// Protected data routes (WS4 - user profile)
	// =========================================================================
	{
		method: "GET",
		path: "/api/users/me",
		auth: "session",
		cors: "app",
		handler: handleGetUserProfile,
	},

	// =========================================================================
	// Telemetry - where the browser reports what only it can see
	// =========================================================================
	{
		method: "POST",
		path: "/api/client-errors",
		auth: "none",
		cors: "app",
		handler: handleClientError,
	},

	// =========================================================================
	// Machine tokens (subsystem 3 - credentials for non-browser clients)
	//
	// Under /api/ with the other session-authenticated routes, not beside the
	// machine-authenticated /lessons ingest. The prefix is what createMockFetch
	// claims, so a route outside it cannot be mocked in development and cannot
	// be reached by an api-contract case - which is how this surface, the one
	// place in the product that mints a credential, spent three PRs as the only
	// one outside the drift gate built after the blanked dashboard.
	// =========================================================================
	{
		method: "POST",
		path: "/api/machines",
		auth: "session",
		cors: "app",
		handler: handleCreateMachine,
	},
	{
		method: "GET",
		path: "/api/machines",
		auth: "session",
		cors: "app",
		handler: handleListMachines,
	},
	{
		method: "DELETE",
		path: "/api/machines/:id",
		auth: "session",
		cors: "app",
		handler: handleRevokeMachine,
	},
	{
		method: "GET",
		path: "/api/machines/:id/inventory",
		auth: "session",
		cors: "app",
		handler: handleGetInventory,
	},

	// =========================================================================
	// Machine self-report
	//
	// Machine-authenticated, so it lives outside /api/ beside /lessons rather
	// than with the browser-authenticated machine routes above. A machine may
	// describe itself; it still may not name, mint, or revoke any other.
	// =========================================================================
	{
		method: "PUT",
		path: "/machine/inventory",
		auth: "machine",
		cors: "app",
		handler: handlePutInventory,
	},
	{
		method: "POST",
		path: "/machine/sessions",
		auth: "machine",
		cors: "app",
		handler: handlePostSessions,
	},

	// =========================================================================
	// Lessons (hosted pool ingest)
	// =========================================================================
	{
		method: "POST",
		path: "/lessons",
		auth: "machine",
		cors: "app",
		handler: handlePushLessons,
	},
	{
		method: "GET",
		path: "/lessons",
		auth: "machine",
		cors: "app",
		handler: handleReadLessons,
	},
	{
		method: "POST",
		path: "/lessons/:id/status",
		auth: "machine",
		cors: "app",
		handler: handleTransitionLesson,
	},

	// =========================================================================
	// Lessons (browsing - session-authenticated, separate from the sync routes
	// above on purpose; see routes/lessons-browser.ts)
	// =========================================================================
	{
		method: "GET",
		path: "/api/lessons",
		auth: "session",
		cors: "app",
		handler: handleBrowseLessons,
	},
	{
		method: "GET",
		path: "/api/lessons/:id",
		auth: "session",
		cors: "app",
		handler: handleGetLesson,
	},
	{
		method: "PATCH",
		path: "/api/lessons/:id/status",
		auth: "session",
		cors: "app",
		handler: handleBrowserTransition,
	},
	{
		method: "GET",
		path: "/api/activity",
		auth: "session",
		cors: "app",
		handler: handleActivity,
	},
	{
		method: "GET",
		path: "/api/sessions",
		auth: "session",
		cors: "app",
		handler: handleGetSessions,
	},

	// =========================================================================
	// Public lessons (anonymous, one by id)
	//
	// Inside /api/ despite taking no credential: outside that prefix a route
	// cannot be mocked by createMockFetch and cannot be reached by an
	// api-contract case, which is how the machine-token surface spent three PRs
	// as the only one outside the drift gate. The `public` segment is the marker
	// for a human; auth: "none" is the marker for a machine.
	// =========================================================================
	{
		method: "GET",
		path: "/api/public/lessons/:id",
		auth: "none",
		cors: "any",
		handler: handlePublicLesson,
	},

	// =========================================================================
	// Operator moderation
	//
	// auth: "operator" 404s a signed-in non-operator rather than 403ing, so
	// this surface does not confirm its existence to them specifically. A
	// credential-less request still gets 401 first, the same as any other
	// protected route - resolvePrincipal calls requireAuth before the operator
	// check runs. OPERATOR_USER_IDS is empty in every environment until
	// somebody is deliberately granted it.
	// =========================================================================
	{
		method: "POST",
		path: "/api/admin/lessons/:id/retract",
		auth: "operator",
		cors: "app",
		handler: handleOperatorRetract,
	},
	{
		method: "POST",
		path: "/api/admin/author-blocks",
		auth: "operator",
		cors: "app",
		handler: handleBlockAuthor,
	},
	{
		method: "DELETE",
		path: "/api/admin/author-blocks/:authorKey",
		auth: "operator",
		cors: "app",
		handler: handleUnblockAuthor,
	},
];

/**
 * Whether a `:param`-bearing pattern matches a concrete path.
 *
 * Segment count must agree, so /machines/:id does not swallow
 * /machines/a/b. Only whole segments are parameters; there is no partial or
 * wildcard matching, because nothing here needs one.
 */
/**
 * Match a `:param`-bearing pattern against a concrete path, returning the
 * captured parameters, or null when it does not match.
 *
 * Returning the captures rather than a boolean is the whole point. The router
 * already works out which segment was the parameter; discarding that forced
 * every handler to re-derive it positionally, and they did it differently -
 * `.pop()` for `/machines/:id`, `[length - 2]` for `/lessons/:id/status`. Both
 * were correct only for their own shape, and a third route of a different shape
 * would have read the wrong segment and failed silently, as a 404 or a mutation
 * applied to nothing.
 *
 * Segment count must agree, so `/machines/:id` does not swallow
 * `/machines/a/b`. Only whole segments are parameters; there is no partial or
 * wildcard matching, because nothing here needs one.
 */
function matchPath(pattern: string, path: string): RouteParams | null {
	const patternSegments = pattern.split("/");
	const pathSegments = path.split("/");
	if (patternSegments.length !== pathSegments.length) return null;

	const params: RouteParams = {};

	for (const [i, segment] of patternSegments.entries()) {
		if (segment.startsWith(":")) {
			params[segment.slice(1)] = pathSegments[i];
			continue;
		}
		if (segment !== pathSegments[i]) return null;
	}

	return params;
}

/**
 * Resolve a request to a route within a given table.
 *
 * Exact routes win over parameterized ones. Without that ordering, a literal
 * route registered after a parameterized one of the same shape would become
 * unreachable, and the symptom would be a working endpoint quietly answering
 * from the wrong handler.
 *
 * Takes `routes` explicitly, rather than reading the module's ROUTES itself,
 * so this ordering is exercisable against a table built for the test - a
 * shape collision like /machines/settings beside /machines/:id doesn't have
 * to exist in production for the precedence rule to be checked.
 */
/** A resolved route together with whatever its pattern captured. */
export interface ResolvedRoute {
	route: Route;
	params: RouteParams;
}

export function resolveRoute(
	routes: Route[],
	method: string,
	path: string,
): ResolvedRoute | undefined {
	const exact = routes.find(
		(route) => route.method === method && route.path === path,
	);
	if (exact) return { route: exact, params: {} };

	for (const route of routes) {
		if (route.method !== method || !route.path.includes(":")) continue;

		const params = matchPath(route.path, path);
		if (params) return { route, params };
	}

	return undefined;
}

/**
 * Match a request to a route in the live route table.
 */
function findRoute(method: string, path: string): ResolvedRoute | undefined {
	return resolveRoute(ROUTES, method, path);
}

/**
 * Route a request to the appropriate handler.
 * Handles errors consistently across all routes.
 */
export async function dispatch(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const url = new URL(request.url);
	const method = request.method;
	const path = url.pathname;

	// Find matching route
	const matched = findRoute(method, path);

	if (!matched) {
		return errorHandler(new ApiError(404, "not_found", "Route not found"));
	}

	try {
		// Before the handler, so a handler cannot run unauthenticated even if it
		// forgets to check. This is what the required `auth` field buys - see
		// resolvePrincipal. Almost every handler acts on this principal instead
		// of verifying its own credential; the three that still call
		// requireAuth/requireMachineToken themselves (handlePutInventory,
		// handlePostSessions, handleGetUserProfile) do so because each needs a
		// field Principal does not carry - see the `handler` field's doc
		// comment on `Route`, above.
		const principal = await resolvePrincipal(request, env, matched.route.auth);
		return await matched.route.handler(request, env, matched.params, principal);
	} catch (error) {
		return errorHandler(error);
	}
}

/**
 * List all registered routes (for debugging/docs).
 */
export function listRoutes(): Array<{ method: string; path: string }> {
	return ROUTES.map(({ method, path }) => ({ method, path }));
}
