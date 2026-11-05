import { AuthApiError } from "@onlooker/auth-core";

/**
 * When a session check fails, whether the session is gone or only
 * unreachable for now (ONL-243).
 *
 * Only a 401 says the server no longer recognizes the session. A 429, a 5xx,
 * a network failure or a timeout says nothing about the session at all, and
 * signing someone out over one threw away a refresh token that still worked.
 */

/** Waits between retries when the server gave no Retry-After. */
export const RETRY_BACKOFF_MS: readonly number[] = [
	5_000, 10_000, 20_000, 40_000, 60_000,
];

export function isSessionGone(error: unknown): boolean {
	return error instanceof AuthApiError && error.status === 401;
}

/**
 * The bounds on a server-sent Retry-After. A 0 (or a past date) is a tight
 * retry loop, and anything past about 24.8 days (2^31-1 ms) overflows
 * `setTimeout`, which then fires at once. An hour is far past anything the API
 * sends: the account limit sends 60 s and a Cloudflare 429 at most a day.
 */
export const MIN_RETRY_MS = 1_000;
export const MAX_RETRY_MS = 3_600_000;

/** The server's Retry-After when it sent one, otherwise the backoff. */
export function retryDelayMs(error: unknown, failures: number): number {
	if (error instanceof AuthApiError && error.retryAfterMs !== undefined) {
		return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, error.retryAfterMs));
	}
	return RETRY_BACKOFF_MS[Math.min(failures, RETRY_BACKOFF_MS.length - 1)];
}

/**
 * Retry-After as milliseconds from `now`: delta-seconds or an HTTP date.
 * Undefined when the header is missing or unreadable, and never negative.
 *
 * Strict on both forms (ONL-247). Delta-seconds is digits only, per RFC 9110,
 * where `Number()` also took "1.5", "0x10" and "1e3". And an HTTP date always
 * names its day or month, which keeps V8's lenient Date.parse from reading
 * "1.5" or "-5" as a date in 2001 and answering a wait of zero.
 */
export function parseRetryAfter(
	header: string | null,
	now: number,
): number | undefined {
	if (header === null) return undefined;
	const value = header.trim();
	if (/^\d+$/.test(value)) return Number(value) * 1000;
	if (!/[A-Za-z]/.test(value)) return undefined;
	const date = Date.parse(value);
	if (!Number.isNaN(date)) return Math.max(0, date - now);
	return undefined;
}
