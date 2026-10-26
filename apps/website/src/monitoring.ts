/**
 * The browser half of apps/website's door to a monitoring provider.
 *
 * Everything else in the app reports through `monitor`, a provider-neutral
 * `Monitor`, so changing provider is a change to this file and
 * ./monitoring.worker.ts and nothing else (scripts/source-guards.test.sh fails
 * otherwise). sentry.client.config.ts, which @sentry/astro loads by name, only
 * calls `startBrowserMonitoring`.
 */

import { resolveEnvironment } from "@onlooker/monitoring";
import {
	createSentryMonitor,
	type MonitoringConfig,
} from "@onlooker/monitoring-sentry";
import { browserOptions } from "@onlooker/monitoring-sentry/browser";
import * as Sentry from "@sentry/astro";

// Public by design: a DSN is an ingest URL, not a credential. The worker copy
// lives in wrangler.jsonc vars.MONITORING_DSN, and src/__tests__/monitoring.test.ts
// holds the two to the same string - splitting them is how client and server
// events land in different projects.
export const WEBSITE_DSN =
	"https://70d0d23fb0468a859ab7977665b9b2d5@o4512074220371968.ingest.us.sentry.io/4512074226401280";

export const monitor = createSentryMonitor();

/**
 * What the browser bundle tells the provider about itself.
 *
 * `mode` is Vite's build mode. The inline config this replaced read
 * `DEV ? "development" : "production"`, which labels anything other than the
 * dev server production - a staging build included.
 *
 * `release` is the commit the bundle was built from. It MUST be the same
 * string the deploy gives the worker as MONITORING_RELEASE and the source map
 * upload files artifacts under, or a session that starts in the browser and
 * ends in the worker describes one deploy as two. deploy.yml sets all three
 * from ${{ github.sha }}; src/__tests__/monitoring.test.ts holds it there.
 */
export function browserMonitoringConfig(
	mode: string,
	release: string | undefined,
): MonitoringConfig {
	return {
		dsn: WEBSITE_DSN,
		environment: resolveEnvironment(mode, "production"),
		// Empty outside CI, and `|| undefined` rather than a stand-in: a made-up
		// release still creates a release in Sentry that no upload will ever
		// match, so every stack filed under it stays minified.
		release: release || undefined,
	};
}

export function startBrowserMonitoring(): void {
	Sentry.init({
		...browserOptions(
			browserMonitoringConfig(
				import.meta.env.MODE,
				// Inlined by Vite at build time, because nothing in the browser can
				// be told it afterwards.
				import.meta.env.PUBLIC_MONITORING_RELEASE,
			),
			{
				// This app installs no listeners of its own, so Sentry's are the
				// only thing that sees an uncaught error.
				captureGlobalErrors: true,
				integrations: [
					Sentry.browserTracingIntegration(),
					// Defaults mask all inputs and all text. Do not turn those off:
					// the waitlist field is an email address, and Replay would
					// otherwise ship it. Watching abandonment is the point; reading
					// the address is not.
					Sentry.replayIntegration(),
				],
			},
		),
		replaysSessionSampleRate: 1.0,
		replaysOnErrorSampleRate: 1.0,
	});
}
