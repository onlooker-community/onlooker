/**
 * The one door between apps/api and a monitoring provider.
 *
 * This is the only file here that imports @onlooker/monitoring-sentry.
 * Everything else takes `monitor` - a provider-neutral `Monitor` - from here,
 * so changing provider is a change to this file and nothing else in the app.
 */

import type { ExportedHandler } from "@cloudflare/workers-types";
import { resolveEnvironment } from "@onlooker/monitoring";
import { createSentryMonitor } from "@onlooker/monitoring-sentry";
import {
	PROPAGATION_HEADERS,
	withMonitoring,
} from "@onlooker/monitoring-sentry/worker";
import type { WorkerEnv } from "./types";

export const monitor = createSentryMonitor();

/** Request headers CORS must allow so a browser's trace continues here. */
export const TRACE_HEADERS: readonly string[] = PROPAGATION_HEADERS;

/**
 * Trace every request and report whatever escapes it.
 *
 * Unset MONITORING_DSN means off: the SDK initializes and sends nothing, which
 * is what local development and the test pool get.
 *
 * The casts are about types, not values. This app's `Request` and `Response`
 * come from @types/node and the provider's wrapper is typed against
 * @cloudflare/workers-types; the two describe the same runtime object and
 * disagree on `webSocket`. Kept here so no other file has to know.
 */
export function monitored<Handler>(handler: Handler): Handler {
	return withMonitoring(
		(env: WorkerEnv) => ({
			dsn: env.MONITORING_DSN,
			environment: resolveEnvironment(env.ENVIRONMENT, "development"),
		}),
		handler as unknown as ExportedHandler<WorkerEnv>,
	) as unknown as Handler;
}
