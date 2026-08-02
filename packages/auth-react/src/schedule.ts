// ============================================================================
// Session expiry scheduling (pure)
// ============================================================================
//
// Extracted from the React effect so the timing math — "when do we warn, when
// do we proactively refresh" — can be unit-tested deterministically without a
// renderer or fake DOM. `null` means "don't schedule"; `0` means "act now"
// (the deadline is already at or past the current time).

export interface ExpirySchedule {
	/** ms until the expiry warning should fire, 0 = now, null = don't warn. */
	warnInMs: number | null;
	/** ms until a proactive refresh should fire, 0 = now, null = don't refresh. */
	refreshInMs: number | null;
}

export interface ExpiryScheduleInput {
	autoRefreshLeadMs: number;
	expiryWarningLeadMs: number;
	/** True once the warning has already been surfaced for this session. */
	alreadyWarned: boolean;
}

export function computeExpirySchedule(
	expiresAt: number | null,
	nowMs: number,
	input: ExpiryScheduleInput,
): ExpirySchedule {
	if (expiresAt === null) {
		return { warnInMs: null, refreshInMs: null };
	}

	const untilWarn = expiresAt - input.expiryWarningLeadMs - nowMs;
	const untilRefresh = expiresAt - input.autoRefreshLeadMs - nowMs;

	return {
		warnInMs: input.alreadyWarned ? null : Math.max(0, untilWarn),
		refreshInMs: Math.max(0, untilRefresh),
	};
}
