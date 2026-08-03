/**
 * Route handlers - individual endpoint implementations.
 * Each handler is a Workers request handler returning a Response.
 */

export {
	handleLogin,
	handleSignup,
	handleRefresh,
	handleMe,
	handleLogout,
} from "./auth";

export {
	handleUpdateProfile,
	handleChangePassword,
	handleGetProfile,
	handleDeleteAccount,
	handleForgotPassword,
	handleResetPassword,
	handleVerifyResetToken,
	handleResendVerification,
	handleVerifyEmail,
} from "./account";

export { handleGetUserProfile, handleGetDashboard } from "./data";
