import type { ExportedHandler } from "@cloudflare/workers-types";
import { withSentry } from "@sentry/cloudflare";
import { type MonitoringConfig, sentryOptions } from "./options";

/**
 * Headers a browser sends so its trace continues into the worker.
 *
 * Exported for CORS. apps/api allows only `Content-Type, Authorization`, so a
 * preflight carrying these fails and the browser drops the request - tracing
 * would break the call it was meant to observe.
 */
export const PROPAGATION_HEADERS = ["sentry-trace", "baggage"] as const;

/**
 * Wrap a worker's exported handler so every request is traced and every
 * uncaught throw is reported, with the shared privacy policy applied.
 *
 * Config is a function of `env` because a worker only learns its bindings
 * per request - vars differ between staging and production.
 *
 * The casts are about types, not values. `Handler` is typed against
 * @cloudflare/workers-types, but withSentry's constraint names the global
 * `ExportedHandler`, which is whatever runtime types the consuming program
 * loads. apps/api's globals are workers-types, so the two agree; apps/website's
 * are the ones `wrangler types` generates, which disagree on `Headers`, and
 * this file fails to typecheck there without them.
 */
export function withMonitoring<Env, Handler extends ExportedHandler<Env>>(
	configFor: (env: Env) => MonitoringConfig,
	handler: Handler,
): Handler {
	return withSentry<Env>(
		(env) => sentryOptions(configFor(env)),
		handler as unknown as Parameters<typeof withSentry<Env>>[1],
	) as unknown as Handler;
}
