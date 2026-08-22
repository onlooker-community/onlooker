/**
 * Route dispatcher - maps HTTP method + path to handler functions.
 * Organizes all endpoints by feature area (auth, account, data).
 */

import { errorHandler } from "./middleware";
import {
	handleChangePassword,
	handleClientError,
	handleCreateMachine,
	handleDeleteAccount,
	handleForgotPassword,
	handleGetDashboard,
	handleGetProfile,
	handleGetUserProfile,
	handleListMachines,
	handleLogin,
	handleLogout,
	handleMe,
	handleRefresh,
	handleResendVerification,
	handleResetPassword,
	handleRevokeMachine,
	handleSignup,
	handleUpdateProfile,
	handleVerifyEmail,
	handleVerifyResetToken,
} from "./routes";
import type { WorkerEnv } from "./types";
import { ApiError } from "./types";

interface Route {
	method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
	path: string;
	handler: (request: Request, env: WorkerEnv) => Promise<Response>;
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
	// Protected data routes (WS4 - user profile, dashboard)
	// =========================================================================
	{
		method: "GET",
		path: "/api/users/me",
		handler: handleGetUserProfile,
	},
	{
		method: "GET",
		path: "/api/dashboard",
		handler: handleGetDashboard,
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
	// =========================================================================
	{
		method: "POST",
		path: "/machines",
		handler: handleCreateMachine,
	},
	{
		method: "GET",
		path: "/machines",
		handler: handleListMachines,
	},
	{
		method: "DELETE",
		path: "/machines/:id",
		handler: handleRevokeMachine,
	},
];

/**
 * Whether a `:param`-bearing pattern matches a concrete path.
 *
 * Segment count must agree, so /machines/:id does not swallow
 * /machines/a/b. Only whole segments are parameters; there is no partial or
 * wildcard matching, because nothing here needs one.
 */
function pathMatches(pattern: string, path: string): boolean {
	const patternSegments = pattern.split("/");
	const pathSegments = path.split("/");
	if (patternSegments.length !== pathSegments.length) return false;

	return patternSegments.every(
		(segment, i) => segment.startsWith(":") || segment === pathSegments[i],
	);
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
export function resolveRoute(
	routes: Route[],
	method: string,
	path: string,
): Route | undefined {
	const exact = routes.find(
		(route) => route.method === method && route.path === path,
	);
	if (exact) return exact;

	return routes.find(
		(route) =>
			route.method === method &&
			route.path.includes(":") &&
			pathMatches(route.path, path),
	);
}

/**
 * Match a request to a route in the live route table.
 */
function findRoute(method: string, path: string): Route | undefined {
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
	const route = findRoute(method, path);

	if (!route) {
		return errorHandler(new ApiError(404, "not_found", "Route not found"));
	}

	try {
		return await route.handler(request, env);
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
