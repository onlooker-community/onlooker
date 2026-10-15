import type { D1Database } from "@cloudflare/workers-types";
import { hashToken } from "../utils/crypto";

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

/**
 * The key for an address: trimmed, lowercased, hashed.
 *
 * `hashToken` is this repository's one sha256, and its own comment asks to be
 * imported rather than re-declared - two copies drift apart with no symptom
 * until one changes and the other does not.
 */
export async function loginAttemptKey(email: string): Promise<string> {
	return hashToken(email.trim().toLowerCase());
}

/**
 * Milliseconds still to wait before this address may try again, or 0.
 *
 * One primary-key read, run before bcrypt so a refused attempt costs no hash.
 */
export async function activeCooldownMs(
	db: D1Database,
	key: string,
	now: Date = new Date(),
): Promise<number> {
	const row = await db
		.prepare("SELECT fails, last_fail_at FROM login_attempts WHERE key = ?")
		.bind(key)
		.first<{ fails: number; last_fail_at: string }>();

	if (!row) return 0;

	const elapsed = now.getTime() - new Date(row.last_fail_at).getTime();
	return Math.max(cooldownFor(row.fails) - elapsed, 0);
}

/**
 * Count one failure and answer the cooldown it earns, 0 while under the
 * threshold.
 *
 * One statement, for the reason db/orgs.ts records for removeMembership and
 * that #198 and #200 both followed: a read followed by a write lets two
 * concurrent failures each see the old count and land as one.
 */
export async function recordLoginFailure(
	db: D1Database,
	key: string,
	now: Date = new Date(),
): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO login_attempts (key, fails, last_fail_at)
			 VALUES (?, 1, ?)
			 ON CONFLICT(key) DO UPDATE
			   SET fails = fails + 1, last_fail_at = excluded.last_fail_at
			 RETURNING fails`,
		)
		.bind(key, now.toISOString())
		.first<{ fails: number }>();

	return cooldownFor(row?.fails ?? 0);
}

/** Forget this address's run, which a successful sign-in earns. */
export async function clearLoginAttempts(
	db: D1Database,
	key: string,
): Promise<void> {
	await db.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
}

/**
 * Drop runs old enough that no cooldown could still be active, and answer how
 * many went.
 *
 * The cutoff is MAX_COOLDOWN_MS rather than each row's own cooldown: a row
 * older than the cap can never be refusing anything whatever its count, so
 * nothing is lost by forgetting it. Reading the curve here instead would put
 * the policy in a second place, and would let a row with four failures - no
 * cooldown at all - be pruned while one with ten survived.
 *
 * An attacker whose row is forgotten starts again from zero, which is the same
 * position a legitimate user is in after a successful sign-in.
 *
 * Rides the cron the worker already declares, beside the session-summaries
 * prune. Counting every submitted address accepts unbounded distinct keys as
 * the price of not leaking which addresses exist; this bounds that price.
 */
export async function pruneLoginAttempts(
	db: D1Database,
	now: Date = new Date(),
): Promise<number> {
	const cutoff = new Date(now.getTime() - MAX_COOLDOWN_MS).toISOString();

	const result = await db
		.prepare("DELETE FROM login_attempts WHERE last_fail_at < ?")
		.bind(cutoff)
		.run();

	return result.meta.changes;
}
