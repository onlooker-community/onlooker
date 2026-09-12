/**
 * The one door between apps/web and a monitoring provider.
 *
 * This is the only file here that imports @sentry/* or
 * @onlooker/monitoring-sentry (scripts/source-guards.test.sh fails otherwise).
 * Everything else reports through `monitor`, a provider-neutral `Monitor`, so
 * changing provider is a change to this file and nothing else in the app.
 */

import {
	fanout,
	type Monitor,
	noopMonitor,
	resolveEnvironment,
} from "@onlooker/monitoring";
import { createSentryMonitor } from "@onlooker/monitoring-sentry";
import { browserOptions } from "@onlooker/monitoring-sentry/browser";
import * as Sentry from "@sentry/react";
import { useEffect } from "react";
import {
	createRoutesFromChildren,
	matchRoutes,
	Routes,
	useLocation,
	useNavigationType,
} from "react-router-dom";
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

export const monitor: Monitor = fanout(
	createSentryMonitor(),
	clientErrorMonitor,
);

/**
 * `<Routes>`, instrumented so a trace is named for the route pattern
 * (`/lessons/:id`) rather than the URL. A raw URL would make every lesson its
 * own transaction, and put reset tokens in the name for scrubbing to catch.
 */
export const MonitoredRoutes = Sentry.withSentryReactRouterV6Routing(Routes);

/**
 * Start the provider. Unset VITE_MONITORING_DSN means off: nothing starts, and
 * errors still reach /api/client-errors through `clientErrorMonitor`.
 *
 * Kept apart from `monitor` so importing it - which every test rendering App
 * does - starts nothing.
 */
export function initMonitoring(): void {
	const dsn = import.meta.env.VITE_MONITORING_DSN;
	if (!dsn) return;

	const { baseUrl } = resolveApiConfig();

	Sentry.init({
		...browserOptions(
			{
				dsn,
				environment: resolveEnvironment(import.meta.env.MODE, "development"),
			},
			{
				// installGlobalErrorCapture below feeds both destinations. Sentry's
				// own listeners on top would report every uncaught error twice.
				captureGlobalErrors: false,
				integrations: [
					Sentry.reactRouterV6BrowserTracingIntegration({
						useEffect,
						useLocation,
						useNavigationType,
						createRoutesFromChildren,
						matchRoutes,
					}),
				],
			},
		),
		// Continue traces into our own API and nowhere else. apps/api allows the
		// trace headers in CORS; a third-party origin would reject the preflight.
		tracePropagationTargets: baseUrl ? [baseUrl] : [],
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
