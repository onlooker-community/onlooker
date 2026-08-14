/**
 * Turn a caught API error into something worth showing a person.
 *
 * The reason this exists is 501. Every account endpoint - profile, change
 * password, delete account, verify email, resend verification, and the whole
 * forgot/reset password journey - is a stub in apps/api that throws
 * `not_implemented`. All of them are fully implemented in the mock, so the
 * features work in development and answer 501 in production.
 *
 * Left alone, a user submitting those forms gets "Request failed with status
 * 501", which tells them nothing and reads like a bug they caused. This says
 * the true thing instead: the feature is not built yet.
 *
 * The status is read structurally rather than through `instanceof`, because
 * apps/web depends on @onlooker/auth-react and the error class lives in
 * auth-core underneath it. Duck-typing the field avoids reaching past the
 * dependency it actually declares.
 */
const NOT_IMPLEMENTED = 501;

function statusOf(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const status = (error as { status?: unknown }).status;
	return typeof status === "number" ? status : undefined;
}

/** True when the server answered "this endpoint exists but does nothing yet". */
export function isNotImplemented(error: unknown): boolean {
	return statusOf(error) === NOT_IMPLEMENTED;
}

export function describeError(error: unknown, fallback: string): string {
	if (isNotImplemented(error)) {
		return "This isn't available yet. It's built and working against the development server, but the production API hasn't implemented it.";
	}
	return error instanceof Error ? error.message : fallback;
}
