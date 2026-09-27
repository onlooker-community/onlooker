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
	handlePostSessions,
	handlePushLessons,
	handlePutInventory,
	handleReadLessons,
	handleRefresh,
	handleResendVerification,
	handleResetPassword,
	handleRevokeMachine,
	handleSignup,
	handleTransitionLesson,
	handleUpdateProfile,
	handleVerifyEmail,
	handleVerifyResetToken,
} from "./routes";
import type { RouteParams, WorkerEnv } from "./types";
import { ApiError } from "./types";

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
	 * `principal` is new: every handler still ignores it today, since
	 * `resolvePrincipal` runs ahead of the handler but the handler's own
	 * `requireAuth`/`requireMachineToken` call is still what it acts on. That
	 * duplication is deliberate here - see `dispatch` - and is removed once
	 * handlers are updated to read this argument instead.
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
		// resolvePrincipal. The handler still runs its own requireAuth or
		// requireMachineToken call today, so this is verified twice for now;
		// removing the duplicate is Task 4.
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
