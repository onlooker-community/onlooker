/**
 * Account management routes: profile, password, email verification, account deletion.
 * All endpoints require authentication (access token in Authorization header).
 *
 * WS1 will implement:
 * - Profile retrieval and updates with D1 queries
 * - Password change with verification
 * - Email verification and resend logic
 * - Account deletion with cascading deletes
 */

import {
	deleteUser,
	getPasswordHash,
	getUserByEmail,
	getUserById,
	revokeAllSessionsForUserExcept,
	setEmailVerified,
	updatePassword,
	updateProfile,
} from "../db/queries";
import { ApiError, jsonResponse, requireAuth } from "../middleware";
import type {
	ChangePasswordRequest,
	UpdateProfileRequest,
	WorkerEnv,
} from "../types";
import { hashPassword, verifyPassword } from "../utils/crypto";

/**
 * The profile shape the settings page reads.
 *
 * Renames the storage columns to the names apps/web already uses - createdAt,
 * emailVerified - and turns the verification timestamp into the boolean the UI
 * wants. The date itself is not exposed because nothing asks for it, and a
 * field nobody reads is a field that drifts.
 */
function accountUser(user: {
	id: string;
	email: string;
	name?: string;
	email_verified: string | null;
	created_at: string;
}) {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		createdAt: user.created_at,
		emailVerified: user.email_verified != null,
	};
}

/**
 * GET /auth/profile
 * Get the full account profile for the settings page.
 * Includes email, name, creation date, and email verification status.
 *
 * Requires: Access token
 * Response: { user: AccountUser }
 * Errors: 401 (unauthorized)
 */
export async function handleGetProfile(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const auth = await requireAuth(request, env);

	const user = await getUserById(env.DB, auth.userId);
	if (!user) {
		// A valid token for a user who no longer exists - deleted from another
		// device, most likely. The token stays signature-valid until it expires,
		// so this is reachable and 404 is the honest answer.
		throw new ApiError(404, "not_found", "User not found");
	}

	return jsonResponse({ user: accountUser(user) });
}

/**
 * PATCH /auth/profile
 * Update user profile (name and/or email).
 * If email is changed, it must be re-verified.
 *
 * Requires: Access token
 * Request: { name?: string, email?: string }
 * Response: { user: AccountUser }
 * Errors: 400 (invalid input), 401 (unauthorized), 409 (email taken)
 */
export async function handleUpdateProfile(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const auth = await requireAuth(request, env);
	const body = (await request.json()) as UpdateProfileRequest;

	// Validate input
	if (body.name !== undefined && typeof body.name !== "string") {
		throw new ApiError(400, "invalid_input", "Name must be a string");
	}

	if (body.email !== undefined && typeof body.email !== "string") {
		throw new ApiError(400, "invalid_input", "Email must be a string");
	}

	if (body.email && !body.email.includes("@")) {
		throw new ApiError(400, "invalid_email", "Invalid email format");
	}

	const current = await getUserById(env.DB, auth.userId);
	if (!current) {
		throw new ApiError(404, "not_found", "User not found");
	}

	const name = body.name?.trim();
	const email = body.email?.trim();
	// Comparing against the stored address rather than the token's email claim,
	// which is stale for anyone who already changed it this session.
	const emailIsChanging = Boolean(email) && email !== current.email;

	if (emailIsChanging) {
		const holder = await getUserByEmail(env.DB, email as string);
		// Guarding on id, not on existence: re-submitting your own address in a
		// form that posts every field is ordinary, and should not be a conflict.
		if (holder && holder.id !== auth.userId) {
			throw new ApiError(409, "email_taken", "That email is already in use");
		}
	}

	await updateProfile(env.DB, auth.userId, {
		...(name ? { name } : {}),
		...(emailIsChanging ? { email } : {}),
	});

	if (emailIsChanging) {
		// The new address has proven nothing. Carrying the old verification
		// across would make the flag a lie, and it is the flag that decides
		// whether we trust the address enough to send anything to it.
		await setEmailVerified(env.DB, auth.userId, false);
	}

	const updated = await getUserById(env.DB, auth.userId);
	if (!updated) {
		throw new ApiError(404, "not_found", "User not found");
	}

	return jsonResponse({ user: accountUser(updated) });
}

/**
 * POST /auth/change-password
 * Change the user's password.
 * Requires providing the current password for verification.
 *
 * Requires: Access token
 * Request: { current_password: string, new_password: string }
 * Response: { success: boolean }
 * Errors: 400 (invalid input), 401 (invalid current password), 401 (unauthorized)
 */
export async function handleChangePassword(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const auth = await requireAuth(request, env);
	const body = (await request.json()) as ChangePasswordRequest;

	// Validate input
	if (!body.current_password || !body.new_password) {
		throw new ApiError(
			400,
			"invalid_input",
			"Current and new password are required",
		);
	}

	if (body.new_password.length < 8) {
		throw new ApiError(
			400,
			"invalid_password",
			"New password must be at least 8 characters",
		);
	}

	const currentHash = await getPasswordHash(env.DB, auth.userId);
	if (!currentHash) {
		throw new ApiError(404, "not_found", "User not found");
	}

	if (!(await verifyPassword(body.current_password, currentHash))) {
		throw new ApiError(
			401,
			"invalid_password",
			"Current password is incorrect",
		);
	}

	await updatePassword(
		env.DB,
		auth.userId,
		await hashPassword(body.new_password),
	);

	// Every other session goes. Someone changing a password is usually acting on
	// the belief that the old one is loose, and leaving the other sessions live
	// defeats the act. The session that made the change is spared - it just
	// proved it knows both passwords, and signing it out is pure noise.
	//
	// Their access tokens survive for the rest of their short lifetime, because
	// nothing can withdraw a stateless JWT; that residual window is why
	// TOKEN_EXPIRY_MINUTES is 15. See SESSION_LIFECYCLE in packages/api-contract.
	await revokeAllSessionsForUserExcept(env.DB, auth.userId, body.refreshToken);

	return jsonResponse({ success: true });
}

/**
 * DELETE /auth/account
 * Permanently delete the user account and all associated data.
 * Invalidates all active sessions.
 *
 * Requires: Access token
 * Response: { success: boolean }
 * Errors: 401 (unauthorized)
 */
export async function handleDeleteAccount(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const auth = await requireAuth(request, env);

	// Sessions and verification tokens both cascade from users, so this takes
	// them with it - queries.test asserts that rather than trusting it, because
	// the day the constraint changes is the day a deleted account keeps a
	// working session.
	//
	// Deliberately unconditional: deleting an already-deleted account is not an
	// error worth reporting to someone whose intent was "make it gone".
	await deleteUser(env.DB, auth.userId);

	return jsonResponse({ success: true });
}

/**
 * POST /auth/verify-email
 * Verify email address using a verification token.
 * This is typically called by clicking a link in an email.
 *
 * No auth required (token is embedded in link)
 * Request: { token: string }
 * Response: { success: boolean }
 * Errors: 400 (invalid/expired token)
 */
export async function handleVerifyEmail(
	request: Request,
	_env: WorkerEnv,
): Promise<Response> {
	const body = (await request.json()) as { token: string };

	if (!body.token) {
		throw new ApiError(400, "invalid_input", "Verification token is required");
	}

	// TODO: WS1 will implement
	// 1. Get email from token: const email = await verificationStore.getVerificationEmail(body.token)
	// 2. Find user: const user = await db.findByEmail(email)
	// 3. Mark verified: await db.setEmailVerified(user.id, true)
	// 4. Consume token: await verificationStore.consumeVerificationToken(body.token)

	throw new ApiError(
		501,
		"not_implemented",
		"Verify email not yet implemented - awaiting WS1 database integration",
	);
}

/**
 * POST /auth/resend-verification
 * Request a new verification email.
 * Invalidates previous verification tokens for this user.
 *
 * Requires: Access token
 * Response: { success: boolean }
 * Errors: 401 (unauthorized)
 */
export async function handleResendVerification(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	await requireAuth(request, env);

	// TODO: WS1 will implement
	// 1. Get user: const user = await db.findById(auth.userId)
	// 2. Create verification token: const token = await verificationStore.createVerificationToken(auth.userId, user.email)
	// 3. Queue email: send verification email (future)

	throw new ApiError(
		501,
		"not_implemented",
		"Resend verification not yet implemented - awaiting WS1 database integration",
	);
}

/**
 * POST /auth/forgot-password
 * Request a password reset link.
 * Sends a verification email with a reset token.
 * Does not fail if email doesn't exist (prevent enumeration).
 *
 * No auth required
 * Request: { email: string }
 * Response: { success: boolean }
 * Errors: 400 (invalid input)
 */
export async function handleForgotPassword(
	request: Request,
	_env: WorkerEnv,
): Promise<Response> {
	const body = (await request.json()) as { email: string };

	if (!body.email) {
		throw new ApiError(400, "invalid_input", "Email is required");
	}

	// TODO: WS1 will implement
	// 1. Check if user exists: const user = await db.findByEmail(body.email)
	// 2. If exists, create reset token: const token = await resetStore.createResetToken(body.email)
	// 3. If exists, queue email: send reset link (future)
	// Note: Always return success to prevent email enumeration

	throw new ApiError(
		501,
		"not_implemented",
		"Forgot password not yet implemented - awaiting WS1 database integration",
	);
}

/**
 * GET /auth/reset-password/verify?token=...
 * Validate a password reset token.
 * Used to check if a reset link is still valid (e.g., before showing reset form).
 *
 * Query: token (string)
 * Response: { valid: boolean, email?: string }
 * Errors: none (always returns valid/invalid)
 */
export async function handleVerifyResetToken(
	request: Request,
	_env: WorkerEnv,
): Promise<Response> {
	const url = new URL(request.url);
	const token = url.searchParams.get("token");

	if (!token) {
		throw new ApiError(400, "invalid_input", "Reset token is required");
	}

	// TODO: WS1 will implement
	// 1. Check token: const email = await resetStore.getResetEmail(token)
	// 2. Return validity

	throw new ApiError(
		501,
		"not_implemented",
		"Verify reset token not yet implemented - awaiting WS1 database integration",
	);
}

/**
 * POST /auth/reset-password
 * Reset password using a reset token.
 * This is called after the user submits a new password on the reset page.
 *
 * No auth required (token is embedded)
 * Request: { token: string, password: string }
 * Response: { success: boolean }
 * Errors: 400 (invalid token/password)
 */
export async function handleResetPassword(
	request: Request,
	_env: WorkerEnv,
): Promise<Response> {
	const body = (await request.json()) as { token: string; password: string };

	if (!body.token || !body.password) {
		throw new ApiError(400, "invalid_input", "Token and password are required");
	}

	if (body.password.length < 8) {
		throw new ApiError(
			400,
			"invalid_password",
			"Password must be at least 8 characters",
		);
	}

	// TODO: WS1 will implement
	// 1. Get email from token: const email = await resetStore.getResetEmail(body.token)
	// 2. Hash password: const passwordHash = await bcrypt.hash(body.password, 10)
	// 3. Update password: await db.findByEmail(email).then(user => db.changePassword(user.id, passwordHash))
	// 4. Revoke all tokens: await tokenStore.revokeAllForUser(user.id)
	// 5. Consume token: await resetStore.consumeResetToken(body.token)

	throw new ApiError(
		501,
		"not_implemented",
		"Reset password not yet implemented - awaiting WS1 database integration",
	);
}
