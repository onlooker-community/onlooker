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
	current_password: string;
	new_password: string;
	/**
	 * The caller's own refresh token, so its session can be spared while every
	 * other one is ended. Optional: omit it and all sessions go, including this
	 * one. Same shape as logout, for the same reason - the server cannot tell
	 * which session is asking unless it is told.
	 */
	refreshToken?: string;
}
