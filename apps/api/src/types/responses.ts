/**
 * User profile response type.
 */
export interface UserProfile {
	id: string;
	email: string;
	name: string;
	createdAt: string;
	emailVerified?: string | null;
	lastLoginAt?: string;
}

/**
 * Authentication response types.
 */
export interface AuthResponse {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
	user: UserProfile;
}

/**
 * Dashboard data response type.
 */
export interface DashboardData {
	user: UserProfile;
	stats?: {
		totalRequests?: number;
		lastActive?: string;
		totalSessions?: number;
		activeProjects?: number;
		unreadNotifications?: number;
	};
	recentActivity?: unknown[];
}
