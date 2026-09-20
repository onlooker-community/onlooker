/**
 * Onlooker API Server
 * Cloudflare Workers backend for authentication, account management, and protected resources.
 *
 * Workstream integration:
 * - WS1: Database schema and D1 queries (not yet implemented)
 * - WS2: Account management endpoints (scaffold complete, awaiting WS1)
 * - WS3: Session management and refresh flow (frontend, not backend)
 * - WS4: Protected user data (awaiting WS1 database)
 * - WS5: Rate limiting and security (not yet implemented)
 */

import type {
	ExecutionContext,
	ScheduledController,
} from "@cloudflare/workers-types";
import { pruneSessionSummaries } from "./db/session-summaries.js";
import { timedD1 } from "./db/timing.js";
import { runHeartbeat } from "./heartbeat";
import { preflightResponse, withCors } from "./middleware";
import { monitor, monitored } from "./monitoring";
import { dispatch, listRoutes } from "./router";
import type { WorkerEnv } from "./types";

/**
 * Main request handler for Cloudflare Workers.
 * Dispatches incoming requests to route handlers.
 */
async function handleRequest(
	request: Request,
	env: WorkerEnv,
	_ctx: ExecutionContext,
): Promise<Response> {
	if (request.method === "OPTIONS") {
		return preflightResponse(request, env);
	}

	// Every handler downstream receives a DB binding that reports its own
	// timings. Wrapped once here rather than at the 42 call sites that take
	// env.DB, because a wrapper applied per call site is one someone forgets -
	// and the query they forget is exactly the one nobody measures.
	//
	// drizzle reaches D1 through the same prepare() the wrapper intercepts, so
	// this covers the query layer in db/queries.ts as well as the raw statements
	// in db/lessons.ts. See db/timing.ts for why the measurement lives here and
	// not in Workers tracing.
	const response = await dispatch(request, { ...env, DB: timedD1(env.DB) });

	return withCors(response, request, env);
}

/**
 * Root endpoint: returns API info and available routes.
 */
function handleRoot(env: WorkerEnv): Response {
	const routes = listRoutes();
	const info = {
		service: "Onlooker API",
		version: "0.0.1",
		environment: env.ENVIRONMENT || "development",
		endpoints: routes,
		documentation:
			"https://github.com/onlooker-community/onlooker/blob/main/apps/api/README.md",
	};
	return new Response(JSON.stringify(info, null, 2), {
		headers: {
			"Content-Type": "application/json",
		},
	});
}

/**
 * Cloudflare Workers export.
 * This is the entry point for all requests.
 *
 * Monitored at this level, above the router, so a throw that never reaches
 * dispatch()'s catch - in withCors, or in the D1 timing wrapper - is still
 * reported rather than lost to a bare runtime 500.
 */
export default monitored({
	async fetch(
		request: Request,
		env: WorkerEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Root endpoint. Goes through the same origin policy as everything else -
		// it used to skip CORS entirely, which made it the one response whose
		// rules were decided somewhere other than middleware/cors.ts.
		if (url.pathname === "/" && request.method === "GET") {
			return withCors(handleRoot(env), request, env);
		}

		// Route all other requests
		return handleRequest(request, env, ctx);
	},

	/**
	 * The frequent shallow heartbeat, on a cron trigger.
	 *
	 * It lives here rather than in a worker of its own because this one
	 * already holds everything it needs: the D1 binding it probes, and the
	 * monitor that turns a failure into an issue the production alert rule is
	 * already watching.
	 *
	 * Nothing awaits the result beyond logging it. A failed check reports
	 * itself through the monitor; returning normally afterwards is correct,
	 * because a cron invocation that throws is recorded as a failed
	 * invocation and tells nobody.
	 */
	async scheduled(
		_controller: ScheduledController,
		env: WorkerEnv,
		_ctx: ExecutionContext,
	): Promise<void> {
		const results = await runHeartbeat(env, {
			fetch: (url) => fetch(String(url)),
			monitor,
		});

		// One structured line, so the run is visible in Workers Logs even when
		// every check passed - "it ran and found nothing wrong" and "it did not
		// run" are different, and only this distinguishes them there.
		console.log(
			JSON.stringify({
				event: "heartbeat",
				environment: env.ENVIRONMENT ?? "unknown",
				failed: results.filter((result) => !result.ok).length,
				checks: results.map(({ label, ok }) => ({ label, ok })),
			}),
		);

		// Retention cleanup, riding the same cron for the same reason the
		// heartbeat does: this cron is outside GitHub's throttling (see
		// runHeartbeat's doc comment on GitHub's scheduled workflows drifting
		// to a three-hour cadence). Whether Cloudflare keeps its own schedule
		// has not been measured.
		//
		// Caught rather than let through: this handler's other job is the
		// production health check above, and a failed cleanup is not a reason
		// for that check to stop running. Reported the same way a failed
		// heartbeat check is - monitor.captureException, not a throw - so a
		// broken prune shows up in the same place a broken heartbeat would,
		// instead of failing this invocation silently the way an uncaught
		// throw here would (the exact failure mode runHeartbeat itself is
		// built to avoid).
		try {
			const pruned = await pruneSessionSummaries(env.DB);
			console.log(
				JSON.stringify({ event: "session_summaries_pruned", pruned }),
			);
		} catch (error) {
			monitor.captureException(
				error instanceof Error ? error : new Error(String(error)),
				{ tags: { kind: "session_summaries_prune" } },
			);
		}
	},
});
