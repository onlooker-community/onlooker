/**
 * Failed-login backoff, per submitted address.
 *
 * The whole policy and its statements live here. See
 * docs/superpowers/specs/2026-10-14-login-backoff-design.md for why this is an
 * escalating cooldown rather than a lockout, and why the key is a hash of every
 * submitted address rather than a user id.
 */

/** Failures answered normally before any cooldown applies. */
export const FREE_ATTEMPTS = 4;

/** The cooldown the first charged failure earns. */
const FIRST_COOLDOWN_MS = 60_000;

/**
 * The ceiling. Doubling without one reaches centuries within sixty failures,
 * which stops being a rate limit and becomes a denial of service against the
 * account's real owner - who may well be the person failing to log in.
 */
export const MAX_COOLDOWN_MS = 30 * 60_000;

/**
 * How long a run of `fails` consecutive failures should be refused for.
 *
 * Pure, so the policy is testable without a database, and the single place the
 * curve exists: the table stores a count and a timestamp, never a deadline, so
 * the two cannot disagree and a change here applies to records already
 * written rather than leaving a generation of rows on the old schedule.
 */
export function cooldownFor(fails: number): number {
	if (fails <= FREE_ATTEMPTS) return 0;

	const doublings = fails - FREE_ATTEMPTS - 1;
	return Math.min(FIRST_COOLDOWN_MS * 2 ** doublings, MAX_COOLDOWN_MS);
}
