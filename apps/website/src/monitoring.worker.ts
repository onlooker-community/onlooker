/**
 * The worker half of apps/website's door to a monitoring provider.
 *
 * Split from ./monitoring.ts because the two halves use different SDKs, and
 * the browser bundle must never pull in the Workers one. Between them, these
 * two files are everything in the app that names the provider
 * (scripts/source-guards.test.sh fails otherwise).
 *
 * apps/api/src/monitoring.ts is the same idea for the API, and the shape is
 * deliberately close to it.
 */

import type { ExportedHandler as WorkersExportedHandler } from "@cloudflare/workers-types";
import { resolveEnvironment } from "@onlooker/monitoring";
import type { MonitoringConfig } from "@onlooker/monitoring-sentry";
import { withMonitoring } from "@onlooker/monitoring-sentry/worker";

/** The subset of the worker's bindings that monitoring reads. */
export type WebsiteEnv = {
	/** Must match WEBSITE_DSN in ./monitoring.ts; a test holds them together. */
	MONITORING_DSN?: string;
	ENVIRONMENT?: string;
	/**
	 * The commit this worker was deployed from.
	 *
	 * Not declared in wrangler.jsonc vars: the deploy appends it
	 * (`--var MONITORING_RELEASE:<sha>`) and wrangler merges it with the vars
	 * the file declares. Writing a placeholder here would ship that placeholder
	 * whenever the deploy forgot the flag, which is the failure this is meant
	 * to make visible.
	 */
	MONITORING_RELEASE?: string;
};

/**
 * What the website worker tells the provider about itself.
 *
 * Separate from `monitored` and exported so it can be read back in a test.
 * Every field here is the kind that fails silently: a mistyped var name is
 * still a valid var, and monitoring that labels itself wrongly is worse than
 * none, because the dashboard filtered on production looks calm.
 */
export function websiteMonitoringConfig(env: WebsiteEnv): MonitoringConfig {
	return {
		dsn: env.MONITORING_DSN,
		// production, not apps/api's development default. The marketing site has
		// one deployed environment and no staging counterpart, so an unlabeled
		// event here did come from production. Preserved from the inline config
		// this replaced rather than chosen afresh.
		environment: resolveEnvironment(env.ENVIRONMENT, "production"),
		// Undefined when the deploy supplied none, never a stand-in. A made-up
		// release name still creates a release in Sentry, one no source map
		// upload will ever match, so every stack filed under it stays minified.
		release: env.MONITORING_RELEASE,
	};
}

/**
 * Trace every request and report whatever escapes it, with the shared privacy
 * policy applied. Unset MONITORING_DSN means off.
 *
 * The casts are about types, not values, and are apps/api's for the same
 * reason. Astro's handler is typed against the runtime types wrangler
 * generates and the provider's wrapper against @cloudflare/workers-types; the
 * two describe the same runtime object and disagree on `Request`. Kept here so
 * no other file has to know.
 */
export function monitored<Handler>(handler: Handler): Handler {
	return withMonitoring(
		websiteMonitoringConfig,
		handler as unknown as WorkersExportedHandler<WebsiteEnv>,
	) as unknown as Handler;
}
