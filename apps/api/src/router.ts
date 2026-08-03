/**
 * Route dispatcher - maps HTTP method + path to handler functions.
 * Organizes all endpoints by feature area (auth, account, data).
 */

import { errorHandler } from "./middleware";
import {
	handleChangePassword,
	handleDeleteAccount,
	handleForgotPassword,
	handleGetProfile,
	handleLogin,
	handleLogout,
	handleMe,
	handleRefresh,
	handleResendVerification,
	handleResetPassword,
	handleSignup,
	handleUpdateProfile,
	handleVerifyEmail,
	handleVerifyResetToken,
	handleGetUserProfile,
	handleGetDashboard,
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
];

/**
 * Match a request to a route and dispatch to the handler.
 * Returns null if no route matches.
 */
function findRoute(
	method: string,
	path: string,
): Route | undefined {
	return ROUTES.find(
		(route) => route.method === method && route.path === path,
	);
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
		return errorHandler(
			new ApiError(404, "not_found", "Route not found"),
		);
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
