/**
 * Route handlers - individual endpoint implementations.
 * Each handler is a Workers request handler returning a Response.
 */

export {
	handleChangePassword,
	handleDeleteAccount,
	handleForgotPassword,
	handleGetProfile,
	handleResendVerification,
	handleResetPassword,
	handleUpdateProfile,
	handleVerifyEmail,
	handleVerifyResetToken,
} from "./account";
export {
	handleLogin,
	handleLogout,
	handleMe,
	handleRefresh,
	handleSignup,
} from "./auth";

export { handleGetDashboard, handleGetUserProfile } from "./data";
export { handleClientError } from "./telemetry";
