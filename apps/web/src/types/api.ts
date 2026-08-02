export interface UserProfile {
	id: string;
	email: string;
	name: string;
	createdAt: string;
	lastLoginAt: string;
}

export interface ActivityItem {
	id: string;
	type: string;
	description: string;
	timestamp: string;
}

export interface DashboardStats {
	totalSessions: number;
	activeProjects: number;
	unreadNotifications: number;
}

export interface DashboardData {
	user: Pick<UserProfile, "id" | "email" | "name">;
	stats: DashboardStats;
	recentActivity: ActivityItem[];
}
