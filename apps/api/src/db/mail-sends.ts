import type { D1Database } from "@cloudflare/workers-types";
import { loginAttemptKey } from "./login-attempts.js";

/**
 * The mail cap: per recipient for each kind of mail, and per day for all of it.
 *
 * The whole policy and its statements live here. See
 * docs/superpowers/specs/2026-10-31-mail-cap-design.md for why the counters
 * are per kind, and why each handler claims before it touches a token rather
 * than sendEmail claiming on its way out.
 */

export type MailKind = "reset" | "verify" | "invite";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Sends allowed to one address per window, by kind. */
export const MAIL_LIMITS: Record<MailKind, { max: number; windowMs: number }> = {
	reset: { max: 3, windowMs: HOUR_MS },
	verify: { max: 3, windowMs: HOUR_MS },
	invite: { max: 3, windowMs: DAY_MS },
};

/**
 * All mail, per UTC day. Resend's free tier allows 100 a day and 3,000 a
 * month; 80 leaves headroom under the first, and 80 x 31 = 2,480 keeps under
 * the second without a counter of its own.
 */
export const DAILY_MAIL_CEILING = 80;

/** Longer than the longest window, so a prune never forgets a live count. */
const RETENTION_MS = 2 * DAY_MS;

export type MailClaim =
	| { ok: true }
	| { ok: false; scope: "address" | "global"; retryAfterMs: number };

/** The day's ceiling row. A new UTC date is a new key, so it never needs resetting. */
export function globalMailKey(now: Date): string {
	return `global:${now.toISOString().slice(0, 10)}`;
}

/**
 * Count one send against `key` and answer the count and the window it landed
 * in.
 *
 * One statement, for the reason recordLoginFailure is one: a read followed by
 * a write lets two concurrent requests each see the old count and land as one.
 * SQLite evaluates every SET expression against the row as it was, so both
 * CASEs read the old window_start.
 */
async function countSend(
	db: D1Database,
	key: string,
	windowMs: number,
	now: Date,
): Promise<{ count: number; window_start: string }> {
	const ended = new Date(now.getTime() - windowMs).toISOString();

	const row = await db
		.prepare(
			`INSERT INTO mail_sends (key, window_start, count)
			 VALUES (?, ?, 1)
			 ON CONFLICT(key) DO UPDATE SET
			   count = CASE WHEN mail_sends.window_start <= ?
			                THEN 1 ELSE mail_sends.count + 1 END,
			   window_start = CASE WHEN mail_sends.window_start <= ?
			                       THEN excluded.window_start ELSE mail_sends.window_start END
			 RETURNING count, window_start`,
		)
		.bind(key, now.toISOString(), ended, ended)
		.first<{ count: number; window_start: string }>();

	if (!row) throw new Error("mail_sends: the upsert returned no row");
	return row;
}

function msUntilNextUtcMidnight(now: Date): number {
	const next = Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate() + 1,
	);
	return next - now.getTime();
}

/**
 * Claim one send of `kind` to `address`, or answer why not.
 *
 * The address is claimed first, and a refusal there stops before the global
 * row: one bombed address must not spend the day's ceiling for everybody.
 * A claim counts even if the send then fails, so a Resend outage cannot be
 * retried into a burst.
 */
export async function claimMailSend(
	db: D1Database,
	kind: MailKind,
	address: string,
	now: Date = new Date(),
): Promise<MailClaim> {
	const limit = MAIL_LIMITS[kind];
	const mine = await countSend(
		db,
		`${kind}:${await loginAttemptKey(address)}`,
		limit.windowMs,
		now,
	);
	if (mine.count > limit.max) {
		return {
			ok: false,
			scope: "address",
			retryAfterMs:
				new Date(mine.window_start).getTime() + limit.windowMs - now.getTime(),
		};
	}

	const all = await countSend(db, globalMailKey(now), DAY_MS, now);
	if (all.count > DAILY_MAIL_CEILING) {
		return {
			ok: false,
			scope: "global",
			retryAfterMs: msUntilNextUtcMidnight(now),
		};
	}

	return { ok: true };
}

/** Drop counters old enough that no window could still be open; answer how many. */
export async function pruneMailSends(
	db: D1Database,
	now: Date = new Date(),
): Promise<number> {
	const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();

	const result = await db
		.prepare("DELETE FROM mail_sends WHERE window_start < ?")
		.bind(cutoff)
		.run();

	return result.meta.changes;
}
