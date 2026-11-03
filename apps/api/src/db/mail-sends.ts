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
 * Sends allowed to one address per fixed 24 hours, for the kinds an hourly cap
 * alone does not bound. The reset pool is 45 and 3 an hour allows 72 a day, so
 * one address could spend the pool over 15 hours, and every reset after that
 * would silently answer 200 until midnight. Six a day bounds one address's
 * share. Invites need none: they are already 3 per 24 hours.
 */
export const DAILY_ADDRESS_LIMITS: Record<
	"reset" | "verify",
	{ max: number; windowMs: number }
> = {
	reset: { max: 6, windowMs: DAY_MS },
	verify: { max: 6, windowMs: DAY_MS },
};

/**
 * Each kind's mail, per UTC day. Resend's free tier allows 100 a day and
 * 3,000 a month; 80 in total leaves headroom under the first, and 80 x 31 =
 * 2,480 keeps under the second without a counter of its own.
 *
 * A pool per kind, so invites - which anyone can send, since accounts are
 * free - can never spend the mail a locked-out user needs, and no kind's
 * refusal moves with another kind's traffic. Resets get the most because a
 * locked-out user has no other way back in. The reset pool is itself split in
 * two; see RESET_POOLS.
 */
export const DAILY_MAIL_CEILINGS: Record<MailKind, number> = {
	reset: 45,
	verify: 10,
	invite: 25,
};

/**
 * The reset pool, split (ONL-229). Accounts are free and signup sends no mail,
 * so a burst of fresh accounts at six resets each could spend all 45, and
 * every locked-out user after that gets a silent 200 until midnight. Fresh
 * accounts share 10. Established ones have 35 to themselves, and spill into
 * the 10 when it runs out, so they are never worse off than with one pool.
 */
export const RESET_POOLS = { reserved: 35, open: 10 } as const;

/** How old an unverified account must be to count as established. */
export const ESTABLISHED_AGE_MS = 7 * DAY_MS;

/** A counter that refuses mail once a day's ceiling is spent. */
export type MailPool = "reset-reserved" | "reset-open" | "verify" | "invite";

/**
 * Whether an account is costly enough to fake in bulk to draw on the reset
 * reserve: a verified address, which needs a real inbox and a verify send, or
 * a week of age, which needs planning.
 *
 * `created_at` is ISO from createUser but SQLite's `CURRENT_TIMESTAMP` form,
 * with no zone, from the column default. Both are UTC; the second is said so
 * rather than left to Date's guess. Unparsable means not established.
 */
export function isEstablished(
	user: { email_verified: string | null; created_at: string },
	now: Date,
): boolean {
	if (user.email_verified !== null) return true;
	const iso = /[zZ]|[+-]\d\d:\d\d$/.test(user.created_at)
		? user.created_at
		: `${user.created_at.replace(" ", "T")}Z`;
	const created = Date.parse(iso);
	return (
		!Number.isNaN(created) && now.getTime() - created >= ESTABLISHED_AGE_MS
	);
}

/**
 * Invites one user may send per 24 hours, to any addresses. Without it one
 * owner spends the 25-send invite pool in 25 calls to about nine addresses (a
 * pool slot per invite, three invites per address) and nobody else can invite
 * until midnight.
 */
export const INVITER_LIMIT = { max: 10, windowMs: DAY_MS };

/** Longer than the longest window, so a prune never forgets a live count. */
const RETENTION_MS = 2 * DAY_MS;

/**
 * A global refusal says whether it was the day's first: the upsert hands
 * each pool's count one past its limit to exactly one request, so the issue
 * is raised once a UTC day, not once per refused request.
 *
 * `reserveSpent` is set on the one reset claim a day that first finds the
 * reserve spent, whatever it then gets from the open share, so the reserve
 * alerts exactly once.
 */
export type MailClaim =
	| { ok: true; reserveSpent?: true }
	| { ok: false; scope: "address" | "inviter"; retryAfterMs: number }
	| {
			ok: false;
			scope: "global";
			pool: MailPool;
			first: boolean;
			retryAfterMs: number;
			reserveSpent?: true;
	  };

/** A pool for the day. A new UTC date is a new key, so it never needs resetting. */
export function globalMailKey(pool: MailPool, now: Date): string {
	return `global:${pool}:${now.toISOString().slice(0, 10)}`;
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
 * Narrowest counter first, and a refusal stops before the next: the inviter
 * (invite only), the address's hourly counter, its daily counter (reset and
 * verify only), then the kind's pool. A capped inviter spends no victim
 * address's slots and no pool slot, an address refused hourly spends no daily
 * slot, and a capped address spends no pool slot. The reverse is not true: a
 * refusal at an address has spent the inviter's own slot, and one at the pool
 * has spent the address's and the inviter's. A daily refusal is scope
 * "address", answering the end of that 24-hour window.
 * A claim counts even if the send then fails, so a Resend outage cannot be
 * retried into a burst.
 *
 * A reset draws on the reserve first if the account is established, and
 * spills into the open share when the reserve is spent, counting against both.
 * A fresh account draws on the open share alone. See RESET_POOLS.
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
	kind: "reset",
	address: string,
	options: { established: boolean; now?: Date },
): Promise<MailClaim>;
export function claimMailSend(
	db: D1Database,
	kind: "verify",
	address: string,
	options?: { now?: Date },
): Promise<MailClaim>;
export async function claimMailSend(
	db: D1Database,
	kind: MailKind,
	address: string,
	options: { inviterId?: string; established?: boolean; now?: Date } = {},
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

	const hash = await loginAttemptKey(address);

	const limit = MAIL_LIMITS[kind];
	const mine = await countSend(db, `${kind}:${hash}`, limit.windowMs, now);
	if (mine.count > limit.max) {
		return {
			ok: false,
			scope: "address",
			retryAfterMs: msUntilWindowEnds(mine, limit.windowMs, now),
		};
	}

	if (kind !== "invite") {
		const daily = DAILY_ADDRESS_LIMITS[kind];
		const today = await countSend(
			db,
			`${kind}-day:${hash}`,
			daily.windowMs,
			now,
		);
		if (today.count > daily.max) {
			return {
				ok: false,
				scope: "address",
				retryAfterMs: msUntilWindowEnds(today, daily.windowMs, now),
			};
		}
	}

	let reserveSpent = false;
	if (kind === "reset" && options.established) {
		const reserve = await claimPool(
			db,
			"reset-reserved",
			RESET_POOLS.reserved,
			now,
		);
		if (reserve.ok) return { ok: true };
		reserveSpent = reserve.first;
	}

	const pool: MailPool = kind === "reset" ? "reset-open" : kind;
	const ceiling =
		kind === "reset" ? RESET_POOLS.open : DAILY_MAIL_CEILINGS[kind];
	const claimed = await claimPool(db, pool, ceiling, now);
	const spent = reserveSpent ? { reserveSpent: true as const } : {};
	if (claimed.ok) return { ok: true, ...spent };

	return {
		ok: false,
		scope: "global",
		pool,
		first: claimed.first,
		retryAfterMs: msUntilNextUtcMidnight(now),
		...spent,
	};
}

/** Count one send against a pool; answer whether it fit and whether it was the first over. */
async function claimPool(
	db: D1Database,
	pool: MailPool,
	ceiling: number,
	now: Date,
): Promise<{ ok: boolean; first: boolean }> {
	const sent = await countSend(db, globalMailKey(pool, now), DAY_MS, now);
	return { ok: sent.count <= ceiling, first: sent.count === ceiling + 1 };
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
