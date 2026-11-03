import {
	DAILY_MAIL_CEILINGS,
	type MailClaim,
	type MailKind,
	type MailPool,
	RESET_POOLS,
} from "../db/mail-sends.js";
import { monitor } from "../monitoring";
import { ApiError } from "../types";

/**
 * What a handler does with a refused mail claim.
 *
 * Separate from db/mail-sends.ts so the counting stays free of Sentry and
 * HTTP, and with its dependencies injectable because the Workers pool cannot
 * mock modules - the shape runScheduled's ScheduledDeps already has.
 */

export type MailRefusal = Extract<MailClaim, { ok: false }>;

export type MailCapDeps = {
	monitor: Pick<typeof monitor, "captureException">;
	log: (line: string) => void;
};

const realDeps: MailCapDeps = {
	monitor,
	log: (line) => console.log(line),
};

const REFUSAL_EVENTS: Record<MailRefusal["scope"], string> = {
	address: "mail_address_capped",
	inviter: "mail_inviter_capped",
	global: "mail_global_ceiling",
};

const REFUSAL_MESSAGES: Record<MailRefusal["scope"], string> = {
	address: "Too many emails to this address. Try again later.",
	inviter: "You have sent too many invites today. Try again later.",
	global: "Too many emails are being sent right now. Try again later.",
};

const POOL_CEILINGS: Record<MailPool, number> = {
	"reset-reserved": RESET_POOLS.reserved,
	"reset-open": RESET_POOLS.open,
	verify: DAILY_MAIL_CEILINGS.verify,
	invite: DAILY_MAIL_CEILINGS.invite,
};

/** What a spent pool means for mail, until UTC midnight. */
const CONSEQUENCES: Record<MailPool, string> = {
	"reset-reserved": "established accounts now share the open pool",
	"reset-open": "resets for new, unverified accounts are refused",
	verify: "refusing verify mail until UTC midnight",
	invite: "refusing invite mail until UTC midnight",
};

/** One alert per pool per day, in one shape, so each pool is its own issue. */
function raisePoolSpent(
	pool: MailPool,
	kind: MailKind,
	deps: MailCapDeps,
): void {
	deps.monitor.captureException(
		new Error(
			`mail: the daily ${pool} pool of ${POOL_CEILINGS[pool]} sends is spent; ${CONSEQUENCES[pool]}`,
		),
		{
			tags: { kind: "mail_global_ceiling", mail_kind: kind, mail_pool: pool },
			fingerprint: ["mail_global_ceiling", pool],
		},
	);
}

/**
 * Log every refusal, and raise an issue on a pool's first refusal of the day
 * and on the day the reset reserve is first found spent.
 *
 * Only a pool pages anybody. A capped address or inviter is the cap working;
 * a spent pool means legitimate mail is being refused until UTC midnight -
 * possibly because someone holding many valid addresses is driving
 * forgot-password - and without this it would first surface as Resend
 * refusing to send. Tagged with the kind and the pool, so a full invite pool
 * is told apart from a full reset pool.
 *
 * The reserve spilling into the open share refuses nobody, so it arrives on a
 * claim as `reserveSpent`, sent or refused, and is the early warning that the
 * open share is next.
 *
 * Once per pool per UTC day, not once per refusal: a looped invite would
 * otherwise raise an event per request. Every refusal still logs its line.
 *
 * The line names the kind, and the pool for a pool refusal, and never the
 * address or the inviter.
 */
export function reportMailClaim(
	claim: MailClaim,
	kind: MailKind,
	deps: MailCapDeps = realDeps,
): void {
	if (!claim.ok) {
		deps.log(
			JSON.stringify({
				event: REFUSAL_EVENTS[claim.scope],
				kind,
				...(claim.scope === "global" ? { pool: claim.pool } : {}),
			}),
		);
		if (claim.scope === "global" && claim.first) {
			raisePoolSpent(claim.pool, kind, deps);
		}
	}
	if ("reserveSpent" in claim && claim.reserveSpent)
		raisePoolSpent("reset-reserved", kind, deps);
}

/**
 * The 429 for a caller who may be told: the same code and Retry-After the
 * login backoff answers. forgot-password never throws this - its refusal must
 * look exactly like a send.
 */
export function mailRateLimitError(refusal: MailRefusal): ApiError {
	return new ApiError(
		429,
		"rate_limit_exceeded",
		REFUSAL_MESSAGES[refusal.scope],
		undefined,
		{
			"Retry-After": String(
				Math.max(1, Math.ceil(refusal.retryAfterMs / 1000)),
			),
		},
	);
}
