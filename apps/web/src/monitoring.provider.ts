/**
 * The provider half of ./monitoring.ts, loaded as its own chunk.
 *
 * Everything that imports @sentry/* in apps/web lives here, so the SDK stays
 * out of the main bundle: ./monitoring.ts reaches this file only through a
 * dynamic import, after the app is running.
 */

import type { Monitor, MonitoringEnvironment } from "@onlooker/monitoring";
import { createSentryMonitor } from "@onlooker/monitoring-sentry";
import { browserOptions } from "@onlooker/monitoring-sentry/browser";
import * as Sentry from "@sentry/react";
import { matchPath } from "react-router-dom";

/**
 * The route patterns in App.tsx that carry a parameter, most specific first.
 *
 * A trace is named for the pattern rather than the URL, so every lesson is one
 * transaction instead of thousands, and a reset token never becomes a name.
 * Sentry's router wrapper would derive these from <Routes> itself, but only by
 * being imported where <Routes> is - which is the main bundle. A parameterized
 * route missing from this list is named by its URL, which the shared
 * transaction scrubbing still strips of tokens.
 */
export const PARAMETERIZED_ROUTES = [
	"/reset-password/:token",
	"/verify-email/:token",
	"/lessons/:id",
] as const;

export function routeName(pathname: string): string {
	return (
		PARAMETERIZED_ROUTES.find((pattern) =>
			matchPath({ path: pattern, end: true }, pathname),
		) ?? pathname
	);
}

export interface ProviderConfig {
	dsn: string;
	environment: MonitoringEnvironment;
	/**
	 * The commit this bundle was built from, or undefined for a build with no
	 * commit to claim.
	 *
	 * A bundle outlives the deploy that produced it - browsers cache it, and a
	 * tab can sit open across several releases - so "which code is this" cannot
	 * be answered by what is currently deployed. Only the build knows.
	 */
	release?: string;
	/** Traces continue into this origin and no other. */
	apiBaseUrl: string;
}

export function startProvider({
	dsn,
	environment,
	release,
	apiBaseUrl,
}: ProviderConfig): Monitor {
	Sentry.init({
		...browserOptions(
			{ dsn, environment, release },
			{
				// ./monitoring.ts installs its own window listeners and feeds both
				// destinations. Sentry's on top would report every uncaught error
				// twice.
				captureGlobalErrors: false,
				integrations: [
					Sentry.browserTracingIntegration({
						beforeStartSpan: (options) => ({
							...options,
							name: routeName(window.location.pathname),
						}),
					}),
				],
			},
		),
		// apps/api allows the trace headers in CORS; a third-party origin would
		// reject the preflight, so propagation stops at our own API.
		tracePropagationTargets: apiBaseUrl ? [apiBaseUrl] : [],
	});

	return createSentryMonitor();
}
