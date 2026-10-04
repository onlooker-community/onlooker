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
export { handleActivity } from "./activity";
export {
	handleBlockAuthor,
	handleOperatorRetract,
	handleUnblockAuthor,
} from "./admin-moderation";
export {
	handleLogin,
	handleLogout,
	handleMe,
	handleRefresh,
	handleSignup,
} from "./auth";

export { handleGetUserProfile } from "./data";
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
export { handlePublicLesson } from "./lessons-public";
export {
	handleGetInventory,
	handlePutInventory,
} from "./machine-inventory";
export {
	handleCreateMachine,
	handleListMachines,
	handleRevokeMachine,
} from "./machines";
export {
	handleCreateOrg,
	handleListOrgs,
	handleRenameOrg,
	ORG_NAME_MAX_LENGTH,
} from "./orgs";
export {
	handleAcceptInvite,
	handleVerifyInvite,
} from "./orgs-invite-accept";
export {
	handleCreateInvite,
	handleListInvites,
	handleRevokeInvite,
} from "./orgs-invites";
export {
	handleListMembers,
	handleRemoveMember,
	handleSetMemberRole,
} from "./orgs-members";
export { handleGetSessions, handlePostSessions } from "./sessions";
export { handleClientError } from "./telemetry";
