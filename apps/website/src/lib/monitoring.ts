/**
 * What the website worker tells Sentry about itself.
 *
 * Separate from sentry.server.config.ts and exported so it can be read back in
 * a test. Every field here is the kind that fails silently: a mistyped var name
 * is still a valid var, and monitoring that labels itself wrongly is worse than
 * none, because the dashboard filtered on production looks calm.
 *
 * apps/api/src/monitoring.ts is the same idea for the API, and the shape is
 * deliberately close to it.
 */

import type { CloudflareOptions } from "@sentry/cloudflare";

/** The subset of the worker's bindings that monitoring reads. */
export type WebsiteEnv = {
	SENTRY_DSN?: string;
	SENTRY_ENVIRONMENT?: string;
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

export function websiteMonitoringConfig(env: WebsiteEnv): CloudflareOptions {
	return {
		dsn: env.SENTRY_DSN,
		tracesSampleRate: 1.0,
		// production, not apps/api's development default. The marketing site has
		// one deployed environment and no staging counterpart, so an unlabeled
		// event here did come from production. Preserved from the inline config
		// this replaced rather than chosen afresh.
		environment: env.SENTRY_ENVIRONMENT ?? "production",
		// Undefined when the deploy supplied none, never a stand-in. A made-up
		// release name still creates a release in Sentry, one no source map
		// upload will ever match, so every stack filed under it stays minified.
		release: env.MONITORING_RELEASE,
		// The waitlist POST body is `{ email }`. Empty list, not the default.
		dataCollection: {
			httpBodies: [],
		},
	};
}
