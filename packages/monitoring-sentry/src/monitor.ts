import { guarded, type Level, type Monitor } from "@onlooker/monitoring";
import * as Sentry from "@sentry/core";

const SEVERITY = {
	debug: "debug",
	info: "info",
	warn: "warning",
	error: "error",
} as const satisfies Record<Level, Sentry.SeverityLevel>;

/**
 * A `Monitor` over Sentry's global client.
 *
 * Built on @sentry/core rather than a runtime SDK, so the same monitor works
 * after `@sentry/astro`, `@sentry/react` or `@sentry/cloudflare` has
 * initialized - they all register their client with core. That holds only
 * while one copy of @sentry/core is installed, which is why every @sentry/*
 * version in the repo is pinned to the same release.
 */
export function createSentryMonitor(): Monitor {
	return guarded({
		captureException(error, context) {
			Sentry.captureException(error, context);
		},
		captureMessage(message, level = "info", context) {
			Sentry.captureMessage(message, { ...context, level: SEVERITY[level] });
		},
		setUser(user) {
			// Copied field by field. A caller holding a whole user object can
			// pass it where `{ id }` is expected, and the email would ride along.
			Sentry.setUser(user ? { id: user.id } : null);
		},
		count(name, value, attributes) {
			Sentry.metrics.count(
				name,
				value,
				attributes ? { attributes } : undefined,
			);
		},
		log(level, message, attributes) {
			Sentry.logger[level](message, attributes);
		},
		startSpan(options, fn) {
			return Sentry.startSpan(options, () => fn());
		},
		flush(timeoutMs) {
			return Sentry.flush(timeoutMs);
		},
	});
}
