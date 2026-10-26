import type { Monitor } from "@onlooker/monitoring";

// Counters for the coming-soon waitlist. Names are the query surface in the
// provider's metrics; changing one is a dashboard break, not a rename.
export const WAITLIST_METRICS = {
	viewed: "waitlist.viewed",
	emailStarted: "waitlist.email_started",
	submitted: "waitlist.submitted",
	submitSucceeded: "waitlist.submit_succeeded",
	submitFailed: "waitlist.submit_failed",
	abandoned: "waitlist.abandoned",
} as const;

// The monitor is injected so the state machine can be tested without talking
// to a provider. A `Monitor` never throws, so a missing SDK init cannot throw
// from a form handler either.
export function createWaitlistTelemetry(monitor: Monitor) {
	let viewed = false;
	let started = false;
	let submitted = false;
	let abandoned = false;
	let lastLooksValid = false;

	function emit(name: string, looksValid?: boolean) {
		const attributes =
			looksValid === undefined ? undefined : { looks_valid: looksValid };
		monitor.count(name, 1, attributes);
		monitor.log("info", name, attributes);
	}

	return {
		viewed() {
			if (viewed) return;
			viewed = true;
			emit(WAITLIST_METRICS.viewed);
		},

		// First non-empty input only. The address itself never leaves this
		// function: callers pass checkValidity() and a trimmed-length check.
		onEmailInput(hasValue: boolean, looksValid: boolean) {
			lastLooksValid = looksValid;
			if (started || !hasValue) return;
			started = true;
			emit(WAITLIST_METRICS.emailStarted, looksValid);
		},

		onSubmit(looksValid: boolean) {
			lastLooksValid = looksValid;
			if (submitted) return;
			submitted = true;
			emit(WAITLIST_METRICS.submitted, looksValid);
		},

		onSubmitSucceeded(looksValid: boolean) {
			emit(WAITLIST_METRICS.submitSucceeded, looksValid);
		},

		onSubmitFailed(error: unknown, looksValid: boolean) {
			emit(WAITLIST_METRICS.submitFailed, looksValid);
			monitor.captureException(error, { tags: { surface: "waitlist" } });
		},

		submitWithSpan<T>(fn: () => Promise<T>): Promise<T> {
			return monitor.startSpan(
				{ name: "waitlist.submit", op: "http.client" },
				fn,
			);
		},

		// pagehide with persisted=false is a real leave (close / navigate).
		// visibilitychange hidden is not: switching tabs would otherwise count
		// as abandoned, then a later submit would double-count the session.
		// Hidden still needs a flush so buffered metrics leave on mobile.
		maybeAbandon() {
			if (started && !submitted && !abandoned) {
				abandoned = true;
				emit(WAITLIST_METRICS.abandoned, lastLooksValid);
			}
		},

		flush() {
			return monitor.flush(2000);
		},
	};
}

export type WaitlistTelemetry = ReturnType<typeof createWaitlistTelemetry>;
