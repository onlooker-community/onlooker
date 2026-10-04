/**
 * How long an invitation stays usable.
 *
 * Configuration rather than a constant, matching TOKEN_EXPIRY_MINUTES and
 * REFRESH_TOKEN_EXPIRY_DAYS in wrangler.toml. This does NOT avoid a deploy -
 * wrangler vars change by deploying, the same as editing a constant. What it
 * buys is a value visible in environment config and able to differ per
 * environment: a one-day window in development makes expiry cheap to exercise
 * by hand.
 *
 * `orgId` is accepted and deliberately unused. Per-org windows are deferred,
 * and taking the argument now means that change is a lookup inside this
 * function rather than a new parameter threaded through every caller.
 */

/** Seven days, because an invite waits on a human who may be away. */
export const DEFAULT_INVITE_EXPIRY_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function resolveInviteWindow(
	env: { INVITE_EXPIRY_DAYS?: string },
	_orgId?: string,
): { days: number; ms: number } {
	const raw = env.INVITE_EXPIRY_DAYS;
	const parsed = Number(raw);

	// Number("") is 0 and Number("seven") is NaN, so a bare read gives a window
	// of zero or nothing and every invite is born expired. Integer and positive
	// are both required: a fractional window would render as "1.5 days".
	const usable = raw !== undefined && Number.isInteger(parsed) && parsed > 0;

	if (!usable) {
		// Warn rather than throw. A typo'd var should not take invitations down
		// for everybody - it should be loud in the logs while the flow keeps
		// working at a sane default.
		console.warn(
			JSON.stringify({
				event: "invite_window_fallback",
				configured: raw ?? null,
				using_days: DEFAULT_INVITE_EXPIRY_DAYS,
			}),
		);
		return {
			days: DEFAULT_INVITE_EXPIRY_DAYS,
			ms: DEFAULT_INVITE_EXPIRY_DAYS * MS_PER_DAY,
		};
	}

	return { days: parsed, ms: parsed * MS_PER_DAY };
}
