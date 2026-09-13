/**
 * The one door between apps/web and a monitoring provider.
 *
 * Everything else in the app reports through `monitor`, a provider-neutral
 * `Monitor`, so changing provider is a change to this file and
 * ./monitoring.provider.ts and nothing else (scripts/source-guards.test.sh
 * fails otherwise).
 *
 * The door is split in two for weight, not for tidiness. The provider's SDK is
 * ~38.5 kB gzipped - measured at +35% on the main bundle when it was imported
 * here - and every visitor would download it before the app could render. So
 * this file imports nothing from the provider, and ./monitoring.provider.ts
 * is loaded as its own chunk once the app is running.
 */

import {
	fanout,
	type Monitor,
	type MonitorUser,
	noopMonitor,
	resolveEnvironment,
} from "@onlooker/monitoring";
import { resolveApiConfig } from "./api/config";
import { type ClientErrorKind, reportClientError } from "./lib/reportError";

const KINDS: readonly ClientErrorKind[] = [
	"render",
	"unhandled-rejection",
	"uncaught",
];

function kindOf(tag: string | undefined): ClientErrorKind {
	return KINDS.find((kind) => kind === tag) ?? "uncaught";
}

/**
 * The vendor-less path, as a `Monitor`.
 *
 * Reports still go to /api/client-errors and on to Workers Logs, where
 * client-error-monitor.yml alerts hourly. Sending to the provider instead of
 * this would leave that workflow green and blind, so both are fed until it is
 * retired on purpose (revisit 2026-10-01, onlooker-k34). Only exceptions
 * travel this way; counts, logs and spans are the provider's alone.
 *
 * It is also what catches everything in the moment before the provider's
 * chunk arrives, and everything when that chunk fails to load at all.
 */
export const clientErrorMonitor: Monitor = {
	...noopMonitor,
	captureException(error, context) {
		const componentStack = context?.extra?.componentStack;
		reportClientError({
			kind: kindOf(context?.tags?.kind),
			message: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			componentStack:
				typeof componentStack === "string" ? componentStack : undefined,
			url: window.location.href,
		});
	},
};

/**
 * A monitor that stands in until the real one arrives.
 *
 * Calls made before `attach` are dropped rather than queued - the vendor-less
 * path beside it in the fanout already has every exception from that window,
 * and a queue is a second place for a report to be lost. The one exception is
 * the user: a restored session sets it on first render, well before the
 * provider loads, and it would otherwise never be set at all.
 */
export function createDeferredMonitor() {
	let target: Monitor | null = null;
	let user: MonitorUser | null = null;

	const monitor: Monitor = {
		captureException(error, context) {
			target?.captureException(error, context);
		},
		captureMessage(message, level, context) {
			target?.captureMessage(message, level, context);
		},
		setUser(next) {
			user = next;
			target?.setUser(next);
		},
		count(name, value, attributes) {
			target?.count(name, value, attributes);
		},
		log(level, message, attributes) {
			target?.log(level, message, attributes);
		},
		startSpan(options, fn) {
			return target ? target.startSpan(options, fn) : fn();
		},
		flush(timeoutMs) {
			return target ? target.flush(timeoutMs) : Promise.resolve(true);
		},
	};

	return {
		monitor,
		attach(next: Monitor) {
			target = next;
			if (user) next.setUser(user);
		},
	};
}

const provider = createDeferredMonitor();

export const monitor: Monitor = fanout(provider.monitor, clientErrorMonitor);

/**
 * Load and start the provider. Unset VITE_MONITORING_DSN means off: nothing is
 * fetched, and errors still reach /api/client-errors through
 * `clientErrorMonitor`.
 *
 * Returns immediately. The import runs alongside the first render rather than
 * ahead of it, and a failure to load - offline, or a stale tab whose chunk a
 * deploy has replaced - leaves the vendor-less path doing the reporting.
 */
export function initMonitoring(): void {
	const dsn = import.meta.env.VITE_MONITORING_DSN;
	if (!dsn) return;

	const environment = resolveEnvironment(import.meta.env.MODE, "development");
	// Empty and unset are the same answer here. An unset VITE_* is undefined,
	// but one exported as "" by a deploy that could not work out the commit
	// arrives as the empty string, and "" is a release name Sentry accepts.
	const release = import.meta.env.VITE_MONITORING_RELEASE || undefined;
	const { baseUrl } = resolveApiConfig();

	import("./monitoring.provider")
		.then(({ startProvider }) => {
			provider.attach(
				startProvider({ dsn, environment, release, apiBaseUrl: baseUrl }),
			);
		})
		.catch(() => {
			// Nothing to report it to but the path that is already working.
		});
}

/**
 * Catch the failures no React boundary can see.
 *
 * A boundary only sees throws during render. It never sees a rejected promise
 * with no handler, an error thrown from an event listener, or a dynamic import
 * that 404s - which is the exact shape a stale tab hits after a deploy, and one
 * of the few ways a user experiences a bad release without any request of ours
 * failing.
 */
export function installGlobalErrorCapture(target: Window = window): void {
	target.addEventListener("unhandledrejection", (event) => {
		monitor.captureException((event as PromiseRejectionEvent).reason, {
			tags: { kind: "unhandled-rejection" },
		});
	});

	target.addEventListener("error", (event) => {
		const { error, message } = event as ErrorEvent;
		monitor.captureException(error ?? message ?? "unknown error", {
			tags: { kind: "uncaught" },
		});
	});
}
