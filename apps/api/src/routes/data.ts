/**
 * Protected data routes for WS4 (authenticated, protected resources).
 * These endpoints require a valid access token and return user-specific data.
 *
 * WS1 will connect these to D1 queries.
 * WS4 will define dashboard data schema and UI needs.
 */

import { jsonResponse, requireAuth } from "../middleware";
import type {
	DashboardData,
	UserProfile,
	WorkerEnv,
} from "../types";

/**
 * GET /api/users/me
 * Get the user's profile information.
 * Used by the Profile page and as part of session loading.
 *
 * Requires: Access token
 * Response: UserProfile
 * Errors: 401 (unauthorized)
 */
export async function handleGetUserProfile(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const auth = await requireAuth(request, env);

	// TODO: WS1 will implement
	// const profile = await db.getUserProfile(auth.userId)

	// Stub response for type checking
	const stubProfile: UserProfile = {
		id: auth.userId,
		email: auth.email,
		name: "User Name",
		createdAt: new Date().toISOString(),
		lastLoginAt: new Date().toISOString(),
	};

	return jsonResponse(stubProfile);
}

/**
 * GET /api/dashboard
 * Get the user's dashboard data including stats and recent activity.
 * Used by the Dashboard page for displaying user insights.
 *
 * Requires: Access token
 * Response: DashboardData
 * Errors: 401 (unauthorized)
 */
export async function handleGetDashboard(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const auth = await requireAuth(request, env);

	// TODO: WS1 will implement with D1 queries
	// 1. Fetch user: const user = await db.findById(auth.userId)
	// 2. Fetch stats: const stats = await db.getDashboardStats(auth.userId)
	// 3. Fetch activity: const activity = await db.getRecentActivity(auth.userId, limit: 10)

	// Stub response for type checking
	const stubDashboard: DashboardData = {
		user: {
			id: auth.userId,
			email: auth.email,
			name: "User Name",
		},
		stats: {
			totalSessions: 0,
			activeProjects: 0,
			unreadNotifications: 0,
		},
		recentActivity: [],
	};

	return jsonResponse(stubDashboard);
}
