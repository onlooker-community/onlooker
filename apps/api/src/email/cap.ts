import {
	DAILY_MAIL_CEILINGS,
	type MailClaim,
	type MailKind,
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

/**
 * Log every refusal, and raise an issue on a pool's first refusal of the day.
 *
 * Only a pool pages anybody. A capped address or inviter is the cap working;
 * a spent pool means legitimate mail of that kind is being refused until UTC
 * midnight - possibly because someone holding many valid addresses is driving
 * forgot-password - and without this it would first surface as Resend
 * refusing to send. Tagged with the kind, so a full invite pool is told apart
 * from a full reset pool.
 *
 * Once per pool per UTC day, not once per refusal: a looped invite would
 * otherwise raise an event per request. Every refusal still logs its line.
 *
 * The line names the kind and never the address or the inviter.
 */
export function reportMailRefusal(
	refusal: MailRefusal,
	kind: MailKind,
	deps: MailCapDeps = realDeps,
): void {
	deps.log(JSON.stringify({ event: REFUSAL_EVENTS[refusal.scope], kind }));
	if (refusal.scope === "global" && refusal.first) {
		deps.monitor.captureException(
			new Error(
				`mail: the daily ${kind} pool of ${DAILY_MAIL_CEILINGS[kind]} sends is spent; refusing ${kind} mail until UTC midnight`,
			),
			{ tags: { kind: "mail_global_ceiling", mail_kind: kind } },
		);
	}
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
