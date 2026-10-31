import {
	DAILY_MAIL_CEILING,
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

/**
 * Log every refusal, and raise an issue on the day's first one at the ceiling.
 *
 * Only the ceiling pages anybody. A capped address is the cap working; the
 * ceiling means legitimate mail is being refused until UTC midnight - possibly
 * because someone holding many valid addresses is driving forgot-password -
 * and without this it would first surface as Resend refusing to send.
 *
 * Once a UTC day, not once per refusal: a looped invite would otherwise raise
 * an event per request. Every refusal still logs its line.
 *
 * The line names the kind and never the address.
 */
export function reportMailRefusal(
	refusal: MailRefusal,
	kind: MailKind,
	deps: MailCapDeps = realDeps,
): void {
	const global = refusal.scope === "global";
	deps.log(
		JSON.stringify({
			event: global ? "mail_global_ceiling" : "mail_address_capped",
			kind,
		}),
	);
	if (refusal.scope === "global" && refusal.first) {
		deps.monitor.captureException(
			new Error(
				`mail: the daily ceiling of ${DAILY_MAIL_CEILING} sends is spent; refusing ${kind} mail until UTC midnight`,
			),
			{ tags: { kind: "mail_global_ceiling" } },
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
		refusal.scope === "global"
			? "Too many emails are being sent right now. Try again later."
			: "Too many emails to this address. Try again later.",
		undefined,
		{
			"Retry-After": String(
				Math.max(1, Math.ceil(refusal.retryAfterMs / 1000)),
			),
		},
	);
}
