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
