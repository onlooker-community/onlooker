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
export {
	handlePushLessons,
	handleReadLessons,
	handleTransitionLesson,
} from "./lessons";
export {
	handleBrowseLessons,
	handleBrowserTransition,
	handleGetLesson,
} from "./lessons-browser";
export {
	handleCreateMachine,
	handleListMachines,
	handleRevokeMachine,
} from "./machines";
export { handleClientError } from "./telemetry";
