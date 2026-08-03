import {
	createUser,
	getRefreshToken,
	getUserByEmail,
	getUserById,
	revokeRefreshToken,
	storeRefreshToken,
} from "../db/queries";
import { ApiError } from "../middleware";
import { optionalAuth, requireAuth } from "../middleware/auth";
import type {
	LoginRequest,
	RefreshTokenRequest,
	SignupRequest,
	WorkerEnv,
} from "../types";
import {
	generateRefreshToken,
	hashPassword,
	signJwt,
	verifyPassword,
} from "../utils/crypto";

/**
 * POST /auth/signup
 * Register a new user account.
 */
export async function handleSignup(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const body = (await request.json()) as SignupRequest;

	if (!body.email || !body.password) {
		throw new ApiError(400, "invalid_input", "Email and password are required");
	}

	if (body.password.length < 8) {
		throw new ApiError(
			400,
			"invalid_password",
			"Password must be at least 8 characters",
		);
	}

	const existing = await getUserByEmail(env.DB!, body.email);
	if (existing) {
		throw new ApiError(
			409,
			"user_exists",
			"User with this email already exists",
		);
	}

	const passwordHash = await hashPassword(body.password);
	const user = await createUser(env.DB!, body.email, passwordHash, body.name);

	const expiresInMinutes = parseInt(env.TOKEN_EXPIRY_MINUTES);
	const refreshExpiresInDays = parseInt(env.REFRESH_TOKEN_EXPIRY_DAYS);

	const token = await signJwt(
		{
			sub: user.id,
			email: user.email,
			type: "access",
		},
		env.JWT_SECRET,
		expiresInMinutes,
	);

	const refreshToken = generateRefreshToken();
	const refreshExpiresAt = new Date();
	refreshExpiresAt.setDate(refreshExpiresAt.getDate() + refreshExpiresInDays);

	await storeRefreshToken(env.DB!, user.id, refreshToken, refreshExpiresAt);

	return new Response(
		JSON.stringify({
			token,
			refreshToken,
			user: {
				id: user.id,
				email: user.email,
				name: user.name,
			},
		}),
		{
			status: 201,
			headers: { "Content-Type": "application/json" },
		},
	);
}

/**
 * POST /auth/login
 * Authenticate with email and password.
 */
export async function handleLogin(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const body = (await request.json()) as LoginRequest;

	if (!body.email || !body.password) {
		throw new ApiError(400, "invalid_input", "Email and password are required");
	}

	const user = await getUserByEmail(env.DB!, body.email);
	if (!user) {
		throw new ApiError(401, "invalid_credentials", "Invalid email or password");
	}

	const validPassword = await verifyPassword(body.password, user.password_hash);
	if (!validPassword) {
		throw new ApiError(401, "invalid_credentials", "Invalid email or password");
	}

	const expiresInMinutes = parseInt(env.TOKEN_EXPIRY_MINUTES);
	const refreshExpiresInDays = parseInt(env.REFRESH_TOKEN_EXPIRY_DAYS);

	const token = await signJwt(
		{
			sub: user.id,
			email: user.email,
			type: "access",
		},
		env.JWT_SECRET,
		expiresInMinutes,
	);

	const refreshToken = generateRefreshToken();
	const refreshExpiresAt = new Date();
	refreshExpiresAt.setDate(refreshExpiresAt.getDate() + refreshExpiresInDays);

	await storeRefreshToken(env.DB!, user.id, refreshToken, refreshExpiresAt);

	return new Response(
		JSON.stringify({
			token,
			refreshToken,
			user: {
				id: user.id,
				email: user.email,
			},
		}),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

/**
 * POST /auth/refresh
 * Exchange a refresh token for a new access token.
 */
export async function handleRefresh(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const body = (await request.json()) as RefreshTokenRequest;

	if (!body.refreshToken) {
		throw new ApiError(400, "invalid_input", "Refresh token is required");
	}

	const stored = await getRefreshToken(env.DB!, body.refreshToken);
	if (!stored) {
		throw new ApiError(
			401,
			"invalid_token",
			"Invalid or expired refresh token",
		);
	}

	const user = await getUserById(env.DB!, stored.user_id);
	if (!user) {
		throw new ApiError(401, "invalid_token", "User not found");
	}

	const expiresInMinutes = parseInt(env.TOKEN_EXPIRY_MINUTES);
	const refreshExpiresInDays = parseInt(env.REFRESH_TOKEN_EXPIRY_DAYS);

	const newAccessToken = await signJwt(
		{
			sub: user.id,
			email: user.email,
			type: "access",
		},
		env.JWT_SECRET,
		expiresInMinutes,
	);

	await revokeRefreshToken(env.DB!, body.refreshToken);

	const newRefreshToken = generateRefreshToken();
	const refreshExpiresAt = new Date();
	refreshExpiresAt.setDate(refreshExpiresAt.getDate() + refreshExpiresInDays);

	await storeRefreshToken(env.DB!, user.id, newRefreshToken, refreshExpiresAt);

	return new Response(
		JSON.stringify({
			token: newAccessToken,
			refreshToken: newRefreshToken,
		}),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

/**
 * GET /auth/me
 * Get the current authenticated user profile.
 */
export async function handleMe(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const auth = await requireAuth(request, env);

	const user = await getUserById(env.DB!, auth.userId);
	if (!user) {
		throw new ApiError(404, "not_found", "User not found");
	}

	return new Response(JSON.stringify({ user }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * POST /auth/logout
 * Invalidate the current session.
 */
export async function handleLogout(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	// Logout doesn't fail if token is invalid - client will clear localStorage
	await optionalAuth(request, env);

	// If we had valid auth, we could revoke tokens in a production system
	// For now, just return success - client clears localStorage

	return new Response(JSON.stringify({ success: true }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}
