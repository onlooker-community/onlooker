import type { D1Database } from "@cloudflare/workers-types";
import { loginAttemptKey } from "./login-attempts.js";

/**
 * The mail cap: per recipient for each kind of mail, per inviter, and a daily
 * pool for each kind.
 *
 * The whole policy and its statements live here. See
 * docs/superpowers/specs/2026-10-31-mail-cap-design.md for why the counters
 * are per kind, and why each handler claims before it touches a token rather
 * than sendEmail claiming on its way out.
 * docs/superpowers/specs/2026-10-31-mail-pools-design.md is why the day is
 * split into pools and invites are counted per inviter (ONL-228).
 */

export type MailKind = "reset" | "verify" | "invite";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Sends allowed to one address per window, by kind. */
export const MAIL_LIMITS: Record<MailKind, { max: number; windowMs: number }> =
	{
		reset: { max: 3, windowMs: HOUR_MS },
		verify: { max: 3, windowMs: HOUR_MS },
		invite: { max: 3, windowMs: DAY_MS },
	};

/**
 * Each kind's mail, per UTC day. Resend's free tier allows 100 a day and
 * 3,000 a month; 80 in total leaves headroom under the first, and 80 x 31 =
 * 2,480 keeps under the second without a counter of its own.
 *
 * A pool per kind, so invites - which anyone can send, since accounts are
 * free - can never spend the mail a locked-out user needs, and no kind's
 * refusal moves with another kind's traffic. Resets get the most because a
 * locked-out user has no other way back in.
 */
export const DAILY_MAIL_CEILINGS: Record<MailKind, number> = {
	reset: 45,
	verify: 10,
	invite: 25,
};

/**
 * Invites one user may send per 24 hours, to any addresses. Without it one
 * owner spends the invite pool in nine calls and nobody else can invite until
 * midnight.
 */
export const INVITER_LIMIT = { max: 10, windowMs: DAY_MS };

/** Longer than the longest window, so a prune never forgets a live count. */
const RETENTION_MS = 2 * DAY_MS;

/**
 * A global refusal says whether it was the day's first: the upsert hands
 * each pool's count one past its limit to exactly one request, so the issue
 * is raised once a UTC day, not once per refused request.
 */
export type MailClaim =
	| { ok: true }
	| { ok: false; scope: "address" | "inviter"; retryAfterMs: number }
	| { ok: false; scope: "global"; first: boolean; retryAfterMs: number };

/** A kind's pool for the day. A new UTC date is a new key, so it never needs resetting. */
export function globalMailKey(kind: MailKind, now: Date): string {
	return `global:${kind}:${now.toISOString().slice(0, 10)}`;
}

/**
 * One inviter's counter. A user id is an opaque identifier, not an address,
 * so it is stored as it is rather than hashed.
 */
export function inviterMailKey(inviterId: string): string {
	return `inviter:${inviterId}`;
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

/** When the fixed window that `row` counts in ends, from `now`. */
function msUntilWindowEnds(
	row: { window_start: string },
	windowMs: number,
	now: Date,
): number {
	return new Date(row.window_start).getTime() + windowMs - now.getTime();
}

/**
 * Claim one send of `kind` to `address`, or answer why not.
 *
 * Narrowest counter first, and a refusal stops before the next, so a refusal
 * never spends a counter its caller does not own: a capped inviter spends no
 * victim address's slots and no pool slot, and a capped address spends no
 * pool slot. The reverse is not true: a refusal at the address has spent the
 * inviter's own slot, and one at the pool has spent the address's and the
 * inviter's.
 * A claim counts even if the send then fails, so a Resend outage cannot be
 * retried into a burst.
 *
 * An invite must name its inviter, and the overloads make leaving it out a
 * type error rather than an uncapped invite.
 */
export function claimMailSend(
	db: D1Database,
	kind: "invite",
	address: string,
	options: { inviterId: string; now?: Date },
): Promise<MailClaim>;
export function claimMailSend(
	db: D1Database,
	kind: "reset" | "verify",
	address: string,
	options?: { now?: Date },
): Promise<MailClaim>;
export async function claimMailSend(
	db: D1Database,
	kind: MailKind,
	address: string,
	options: { inviterId?: string; now?: Date } = {},
): Promise<MailClaim> {
	const now = options.now ?? new Date();

	if (kind === "invite") {
		if (!options.inviterId) {
			throw new Error("claimMailSend: an invite claim must name its inviter");
		}
		const sent = await countSend(
			db,
			inviterMailKey(options.inviterId),
			INVITER_LIMIT.windowMs,
			now,
		);
		if (sent.count > INVITER_LIMIT.max) {
			return {
				ok: false,
				scope: "inviter",
				retryAfterMs: msUntilWindowEnds(sent, INVITER_LIMIT.windowMs, now),
			};
		}
	}

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
			retryAfterMs: msUntilWindowEnds(mine, limit.windowMs, now),
		};
	}

	const ceiling = DAILY_MAIL_CEILINGS[kind];
	const pool = await countSend(db, globalMailKey(kind, now), DAY_MS, now);
	if (pool.count > ceiling) {
		return {
			ok: false,
			scope: "global",
			first: pool.count === ceiling + 1,
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
