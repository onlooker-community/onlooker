import type { User } from "../auth";
import { apiClient, tokenStore } from "./client";

// Account-management API calls that live outside the core auth factory
// (which only owns login/signup/logout/session). All requests reuse the shared
// authenticated apiClient (WS1), so auth headers, refresh, retries, and base URL
// stay in one place. Endpoints are namespaced under /auth/* so the current mock
// intercepts them; the real API integration will serve the same contract.

export const ACCOUNT_ENDPOINTS = {
	profile: "/auth/profile",
	forgotPassword: "/auth/forgot-password",
	resetPasswordVerify: "/auth/reset-password/verify",
	resetPassword: "/auth/reset-password",
	changePassword: "/auth/change-password",
	deleteAccount: "/auth/account",
	resendVerification: "/auth/resend-verification",
	verifyEmail: "/auth/verify-email",
} as const;

// The auth context's User carries only id/email/name. The settings page needs a
// couple of extra read-only fields, so it fetches the fuller profile shape here.
export type AccountUser = User & {
	createdAt?: string;
	emailVerified?: boolean;
};

export function getProfile(): Promise<{ user: AccountUser }> {
	return apiClient.get<{ user: AccountUser }>(ACCOUNT_ENDPOINTS.profile);
}

export type ForgotPasswordResult = { success: boolean };

export function forgotPassword(email: string): Promise<ForgotPasswordResult> {
	return apiClient.post<ForgotPasswordResult>(
		ACCOUNT_ENDPOINTS.forgotPassword,
		{ email },
	);
}

export type ResetPasswordResult = { success: boolean };

export function resetPassword(
	token: string,
	password: string,
): Promise<ResetPasswordResult> {
	return apiClient.post<ResetPasswordResult>(ACCOUNT_ENDPOINTS.resetPassword, {
		token,
		password,
	});
}

export type VerifyResetTokenResult = { valid: boolean; email?: string };

export function verifyResetToken(
	token: string,
): Promise<VerifyResetTokenResult> {
	return apiClient.get<VerifyResetTokenResult>(
		`${ACCOUNT_ENDPOINTS.resetPasswordVerify}?token=${encodeURIComponent(token)}`,
	);
}

export type UpdateProfileInput = { name?: string; email?: string };

export function updateProfile(
	input: UpdateProfileInput,
): Promise<{ user: AccountUser }> {
	return apiClient.patch<{ user: AccountUser }>(
		ACCOUNT_ENDPOINTS.profile,
		input,
	);
}

export type ChangePasswordInput = {
	currentPassword: string;
	newPassword: string;
};

export function changePassword(
	input: ChangePasswordInput,
): Promise<{ success: boolean }> {
	return apiClient.post<{ success: boolean }>(
		ACCOUNT_ENDPOINTS.changePassword,
		{
			current_password: input.currentPassword,
			new_password: input.newPassword,
			// Changing a password ends the user's other sessions, and this names
			// the one to spare. Without it the server cannot tell which session is
			// asking, and signs this browser out along with the rest - moments
			// after the user proved they know both passwords.
			refreshToken: tokenStore.getRefreshToken() ?? undefined,
		},
	);
}

export function deleteAccount(): Promise<{ success: boolean }> {
	return apiClient.delete<{ success: boolean }>(
		ACCOUNT_ENDPOINTS.deleteAccount,
	);
}

export function resendVerificationEmail(): Promise<{ success: boolean }> {
	return apiClient.post<{ success: boolean }>(
		ACCOUNT_ENDPOINTS.resendVerification,
		{},
	);
}

export function verifyEmail(token: string): Promise<{ success: boolean }> {
	return apiClient.post<{ success: boolean }>(ACCOUNT_ENDPOINTS.verifyEmail, {
		token,
	});
}
