/**
 * Authentication request types.
 */
export interface SignupRequest {
	email: string;
	password: string;
	name?: string;
}

export interface LoginRequest {
	email: string;
	password: string;
}

export interface RefreshTokenRequest {
	refreshToken: string;
}

/**
 * Account management request types.
 */
export interface UpdateProfileRequest {
	name?: string;
	email?: string;
}

export interface ChangePasswordRequest {
	currentPassword: string;
	newPassword: string;
}
