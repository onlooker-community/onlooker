import handler from "@astrojs/cloudflare/entrypoints/server";
import * as Sentry from "@sentry/cloudflare";

type WebsiteEnv = {
	SENTRY_DSN?: string;
	SENTRY_ENVIRONMENT?: string;
};

export default Sentry.withSentry<WebsiteEnv>(
	(env) => ({
		dsn: env.SENTRY_DSN,
		tracesSampleRate: 1.0,
		environment: env.SENTRY_ENVIRONMENT ?? "production",
		dataCollection: {
			httpBodies: [],
		},
	}),
	handler,
);
