import * as Sentry from "@sentry/astro";

// Public by design: a DSN is an ingest URL, not a credential. The worker copy
// lives in wrangler.jsonc vars.SENTRY_DSN. They must stay the same string;
// splitting them is how client and server events land in different projects.
const SENTRY_DSN =
	"https://70d0d23fb0468a859ab7977665b9b2d5@o4512074220371968.ingest.us.sentry.io/4512074226401280";

Sentry.init({
	dsn: SENTRY_DSN,
	environment: import.meta.env.DEV ? "development" : "production",
	tracesSampleRate: 1.0,
	replaysSessionSampleRate: 1.0,
	replaysOnErrorSampleRate: 1.0,
	integrations: [
		Sentry.browserTracingIntegration(),
		// Defaults mask all inputs and all text. Do not turn those off: the
		// waitlist field is an email address, and Replay would otherwise ship
		// it. Watching abandonment is the point; reading the address is not.
		Sentry.replayIntegration(),
	],
	// The waitlist POST body is `{ email }`. Empty list, not the default.
	dataCollection: {
		httpBodies: [],
	},
});
