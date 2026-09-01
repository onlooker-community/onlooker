/**
 * Route dispatcher - maps HTTP method + path to handler functions.
 * Organizes all endpoints by feature area (auth, account, data).
 */

import { errorHandler } from "./middleware";
import {
	handleActivity,
	handleBrowseLessons,
	handleBrowserTransition,
	handleChangePassword,
	handleClientError,
	handleCreateMachine,
	handleDeleteAccount,
	handleForgotPassword,
	handleGetLesson,
	handleGetProfile,
	handleGetUserProfile,
	handleListMachines,
	handleLogin,
	handleLogout,
	handleMe,
	handlePushLessons,
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

interface Route {
	method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
	path: string;
	/**
	 * `params` is optional so the handlers on fixed paths - which is most of
	 * them - need no signature change. Only the parameterized routes read it.
	 */
	handler: (
		request: Request,
		env: WorkerEnv,
		params: RouteParams,
	) => Promise<Response>;
}

const ROUTES: Route[] = [
	// =========================================================================
	// Authentication routes (WS1 - login/signup/refresh/logout)
	// =========================================================================
	{
		method: "POST",
		path: "/auth/login",
		handler: handleLogin,
	},
	{
		method: "POST",
		path: "/auth/signup",
		handler: handleSignup,
	},
	{
		method: "POST",
		path: "/auth/refresh",
		handler: handleRefresh,
	},
	{
		method: "GET",
		path: "/auth/me",
		handler: handleMe,
	},
	{
		method: "POST",
		path: "/auth/logout",
		handler: handleLogout,
	},

	// =========================================================================
	// Account management routes (WS2 - profile, password, email verification)
	// =========================================================================
	{
		method: "GET",
		path: "/auth/profile",
		handler: handleGetProfile,
	},
	{
		method: "PATCH",
		path: "/auth/profile",
		handler: handleUpdateProfile,
	},
	{
		method: "POST",
		path: "/auth/change-password",
		handler: handleChangePassword,
	},
	{
		method: "DELETE",
		path: "/auth/account",
		handler: handleDeleteAccount,
	},
	{
		method: "POST",
		path: "/auth/verify-email",
		handler: handleVerifyEmail,
	},
	{
		method: "POST",
		path: "/auth/resend-verification",
		handler: handleResendVerification,
	},
	{
		method: "POST",
		path: "/auth/forgot-password",
		handler: handleForgotPassword,
	},
	{
		method: "GET",
		path: "/auth/reset-password/verify",
		handler: handleVerifyResetToken,
	},
	{
		method: "POST",
		path: "/auth/reset-password",
		handler: handleResetPassword,
	},

	// =========================================================================
	// Protected data routes (WS4 - user profile)
	// =========================================================================
	{
		method: "GET",
		path: "/api/users/me",
		handler: handleGetUserProfile,
	},

	// =========================================================================
	// Telemetry - where the browser reports what only it can see
	// =========================================================================
	{
		method: "POST",
		path: "/api/client-errors",
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
		handler: handleCreateMachine,
	},
	{
		method: "GET",
		path: "/api/machines",
		handler: handleListMachines,
	},
	{
		method: "DELETE",
		path: "/api/machines/:id",
		handler: handleRevokeMachine,
	},

	// =========================================================================
	// Lessons (hosted pool ingest)
	// =========================================================================
	{
		method: "POST",
		path: "/lessons",
		handler: handlePushLessons,
	},
	{
		method: "GET",
		path: "/lessons",
		handler: handleReadLessons,
	},
	{
		method: "POST",
		path: "/lessons/:id/status",
		handler: handleTransitionLesson,
	},

	// =========================================================================
	// Lessons (browsing - session-authenticated, separate from the sync routes
	// above on purpose; see routes/lessons-browser.ts)
	// =========================================================================
	{
		method: "GET",
		path: "/api/lessons",
		handler: handleBrowseLessons,
	},
	{
		method: "GET",
		path: "/api/lessons/:id",
		handler: handleGetLesson,
	},
	{
		method: "PATCH",
		path: "/api/lessons/:id/status",
		handler: handleBrowserTransition,
	},
	{
		method: "GET",
		path: "/api/activity",
		handler: handleActivity,
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
		return await matched.route.handler(request, env, matched.params);
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
