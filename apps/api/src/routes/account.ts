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

import { ApiError, requireAuth } from "../middleware";
import type {
	ChangePasswordRequest,
	UpdateProfileRequest,
	WorkerEnv,
} from "../types";

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
	await requireAuth(request, env);

	// TODO: WS1 will implement
	// const user = await db.getAccountProfile(auth.userId)

	throw new ApiError(501, "not_implemented", "Get profile not yet implemented - awaiting WS1 database integration");
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
	await requireAuth(request, env);
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

	// TODO: WS1 will implement
	// 1. Check if new email is taken: const existing = await db.findByEmail(body.email)
	// 2. Update profile: const user = await db.updateProfile(auth.userId, body)
	// 3. If email changed, reset verification: await db.setEmailVerified(auth.userId, false)
	// 4. If email changed, create verification token: await verificationStore.createVerificationToken(auth.userId, body.email)
	// 5. Queue verification email (future)

	throw new ApiError(501, "not_implemented", "Update profile not yet implemented - awaiting WS1 database integration");
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
	await requireAuth(request, env);
	const body = (await request.json()) as ChangePasswordRequest;

	// Validate input
	if (!body.current_password || !body.new_password) {
		throw new ApiError(400, "invalid_input", "Current and new password are required");
	}

	if (body.new_password.length < 8) {
		throw new ApiError(400, "invalid_password", "New password must be at least 8 characters");
	}

	// TODO: WS1 will implement
	// 1. Fetch user with password hash: const user = await db.findById(auth.userId)
	// 2. Verify current password: const validPassword = await bcrypt.compare(body.current_password, user.password_hash)
	// 3. Hash new password: const newHash = await bcrypt.hash(body.new_password, 10)
	// 4. Update password: await db.changePassword(auth.userId, newHash)
	// 5. Revoke all active tokens: await tokenStore.revokeAllForUser(auth.userId)

	throw new ApiError(501, "not_implemented", "Change password not yet implemented - awaiting WS1 database integration");
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
	await requireAuth(request, env);

	// TODO: WS1 will implement
	// 1. Delete user and all associated data: await db.deleteAccount(auth.userId)
	// 2. Revoke all tokens: await tokenStore.revokeAllForUser(auth.userId)
	// 3. Delete verification tokens: await verificationStore.deleteAllForUser(auth.userId)
	// 4. Delete reset tokens: await resetStore.deleteAllForUser(auth.userId)

	throw new ApiError(501, "not_implemented", "Delete account not yet implemented - awaiting WS1 database integration");
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

	throw new ApiError(501, "not_implemented", "Verify email not yet implemented - awaiting WS1 database integration");
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

	throw new ApiError(501, "not_implemented", "Resend verification not yet implemented - awaiting WS1 database integration");
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

	throw new ApiError(501, "not_implemented", "Forgot password not yet implemented - awaiting WS1 database integration");
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

	throw new ApiError(501, "not_implemented", "Verify reset token not yet implemented - awaiting WS1 database integration");
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
		throw new ApiError(400, "invalid_password", "Password must be at least 8 characters");
	}

	// TODO: WS1 will implement
	// 1. Get email from token: const email = await resetStore.getResetEmail(body.token)
	// 2. Hash password: const passwordHash = await bcrypt.hash(body.password, 10)
	// 3. Update password: await db.findByEmail(email).then(user => db.changePassword(user.id, passwordHash))
	// 4. Revoke all tokens: await tokenStore.revokeAllForUser(user.id)
	// 5. Consume token: await resetStore.consumeResetToken(body.token)

	throw new ApiError(501, "not_implemented", "Reset password not yet implemented - awaiting WS1 database integration");
}
