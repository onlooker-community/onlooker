import {
	activeCooldownMs,
	clearLoginAttempts,
	loginAttemptKey,
	recordLoginFailure,
} from "../db/login-attempts.js";
import type { Principal } from "../db/pool.js";
import {
	createUser,
	getRefreshToken,
	getUserByEmail,
	getUserById,
	revokeRefreshToken,
	rotateRefreshToken,
	storeRefreshToken,
} from "../db/queries";
import { ApiError } from "../middleware";
import { optionalAuth } from "../middleware/auth";
import type {
	LoginRequest,
	RefreshTokenRequest,
	RouteParams,
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

	const existing = await getUserByEmail(env.DB, body.email);
	if (existing) {
		throw new ApiError(
			409,
			"user_exists",
			"User with this email already exists",
		);
	}

	const passwordHash = await hashPassword(body.password);
	const user = await createUser(env.DB, body.email, passwordHash, body.name);

	const expiresInMinutes = parseInt(env.TOKEN_EXPIRY_MINUTES, 10);
	const refreshExpiresInDays = parseInt(env.REFRESH_TOKEN_EXPIRY_DAYS, 10);

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

	await storeRefreshToken(env.DB, user.id, refreshToken, refreshExpiresAt);

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

	const key = await loginAttemptKey(body.email);

	/**
	 * The refusal, built in one place so the 429's body and its header cannot
	 * drift between the gate below and the two failure paths.
	 *
	 * It names no count and no window beyond the header: a refusal reporting
	 * "three attempts remaining" would be telling an attacker how to pace
	 * themselves.
	 */
	const tooMany = (waitMs: number) =>
		new ApiError(
			429,
			"rate_limit_exceeded",
			"Too many failed sign-in attempts. Try again shortly.",
			undefined,
			{ "Retry-After": String(Math.ceil(waitMs / 1000)) },
		);

	// Before bcrypt, deliberately. verifyPassword is ~100ms of worker CPU at
	// cost 10, so gating after it would leave the half of the attack that costs
	// us rather than the attacker entirely intact.
	//
	// Fails open, and only around this call: a D1 failure here must not lock
	// every account out of the product, and the zone rule still caps 60 req/min
	// per IP underneath. A catch around the whole handler would instead lose the
	// password check, which is the one thing this must never do.
	const waiting = await activeCooldownMs(env.DB, key).catch(() => 0);
	if (waiting > 0) throw tooMany(waiting);

	/**
	 * Count one failure and answer with whatever it earned.
	 *
	 * The answer comes from this statement's own count rather than the read
	 * above, so the fifth consecutive failure is itself refused instead of
	 * answering 401 and refusing the sixth.
	 *
	 * Both callers below pass through here, so an address with no account and a
	 * wrong password produce the same 401 and, at the threshold, the same 429.
	 * That identity is the whole reason login_attempts keys on a hash of the
	 * address rather than on a user id.
	 */
	const refuse = async (): Promise<never> => {
		const earned = await recordLoginFailure(env.DB, key).catch(() => 0);
		if (earned > 0) throw tooMany(earned);
		throw new ApiError(401, "invalid_credentials", "Invalid email or password");
	};

	const user = await getUserByEmail(env.DB, body.email);
	if (!user) return await refuse();

	const validPassword = await verifyPassword(body.password, user.password_hash);
	if (!validPassword) return await refuse();

	// Forget the run. Otherwise yesterday's typos add to today's, and somebody
	// who has signed in successfully since is one mistake from a cooldown.
	await clearLoginAttempts(env.DB, key).catch(() => {});

	const expiresInMinutes = parseInt(env.TOKEN_EXPIRY_MINUTES, 10);
	const refreshExpiresInDays = parseInt(env.REFRESH_TOKEN_EXPIRY_DAYS, 10);

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

	await storeRefreshToken(env.DB, user.id, refreshToken, refreshExpiresAt);

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

	const stored = await getRefreshToken(env.DB, body.refreshToken);
	if (!stored) {
		throw new ApiError(
			401,
			"invalid_token",
			"Invalid or expired refresh token",
		);
	}

	const user = await getUserById(env.DB, stored.user_id);
	if (!user) {
		throw new ApiError(401, "invalid_token", "User not found");
	}

	const expiresInMinutes = parseInt(env.TOKEN_EXPIRY_MINUTES, 10);
	const refreshExpiresInDays = parseInt(env.REFRESH_TOKEN_EXPIRY_DAYS, 10);

	const newAccessToken = await signJwt(
		{
			sub: user.id,
			email: user.email,
			type: "access",
		},
		env.JWT_SECRET,
		expiresInMinutes,
	);

	const newRefreshToken = generateRefreshToken();
	const refreshExpiresAt = new Date();
	refreshExpiresAt.setDate(refreshExpiresAt.getDate() + refreshExpiresInDays);

	// One call, one round trip, and one transaction. These were a revoke followed
	// by a store, which is a rotation split into halves that can fail apart: a
	// failure between them revokes the caller's token without issuing the
	// replacement, logging them out with nothing to retry. See rotateRefreshToken
	// for why batching also removes a crossing (onlooker-1hp).
	await rotateRefreshToken(
		env.DB,
		body.refreshToken,
		user.id,
		newRefreshToken,
		refreshExpiresAt,
	);

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
	_request: Request,
	env: WorkerEnv,
	_params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	// The router resolved this from the route's `auth: "session"`, which throws
	// rather than returning null, so it cannot be null here.
	const { userId } = principal as Principal;

	const user = await getUserById(env.DB, userId);
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
 * End the session this device holds.
 *
 * Revokes the refresh token in the body and nothing else. What that buys is the
 * difference between a bounded session and an unbounded one: this handler used
 * to revoke nothing at all, so a logged-out session could call /auth/refresh
 * indefinitely, each call minting a fresh token pair with a new 30-day window.
 * "Logged out" meant only that one browser had forgotten its tokens.
 *
 * The access token is deliberately left alone. It is a stateless JWT - there is
 * no record of it to delete, and verification never looks anything up - so the
 * only way to withdraw one early is to check every request against a denylist.
 * That is a read per authenticated request forever, to close a window the token
 * lifetime already bounds. See SESSION_LIFECYCLE in packages/api-contract, and
 * TOKEN_REVOCATION in WorkerEnv if that trade is ever revisited.
 *
 * Only the session that asked is ended. Other devices keep theirs.
 */
export async function handleLogout(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	// Never fails on a bad token. The client is discarding its state either way,
	// and a 401 here would strand whoever most needs to log out.
	await optionalAuth(request, env);

	const refreshToken = await refreshTokenFromBody(request);
	if (refreshToken) {
		await revokeRefreshToken(env.DB, refreshToken);
	}

	return new Response(JSON.stringify({ success: true }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * The refresh token a logout request is asking to revoke, if it sent one.
 *
 * Absent, empty and malformed bodies are all the same answer - nothing to
 * revoke - because logout must not fail. A client that sends no refresh token
 * ends up where it was before this handler did anything: its tokens work until
 * they expire.
 */
async function refreshTokenFromBody(
	request: Request,
): Promise<string | undefined> {
	try {
		const body = (await request.json()) as RefreshTokenRequest | null;
		return body?.refreshToken || undefined;
	} catch {
		return undefined;
	}
}
