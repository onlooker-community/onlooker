/**
 * Turn a caught API error into something worth showing a person.
 *
 * This used to carry a special case for 501. Every account endpoint - profile,
 * change password, delete account, verify email, resend verification, and the
 * whole forgot/reset password journey - was a stub in apps/api that threw
 * `not_implemented` while working perfectly against the mock, so a user
 * submitting those forms in production got "Request failed with status 501":
 * meaningless, and reading like a bug they had caused. The special case said the
 * true thing instead.
 *
 * apps/api serves all of them now and returns 501 from nowhere, so the message
 * has been removed rather than left to describe a state that no longer exists.
 * If a future endpoint ever answers 501, it should get its own honest message at
 * that point rather than inherit this one's.
 */

export function describeError(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}
