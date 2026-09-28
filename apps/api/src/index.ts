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
import { timedD1 } from "./db/timing.js";
import { preflightResponse, withCors } from "./middleware";
import { monitored } from "./monitoring";
import { dispatch, ROUTES, resolveRoute } from "./router";
import { runScheduled } from "./scheduled";
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
		// The route table has no OPTIONS entries - Route.method excludes it - so
		// resolveRoute cannot find anything by request.method here. What a
		// preflight actually asks about is named in its own
		// Access-Control-Request-Method header; look the route up by that
		// instead. Missing, unparseable, or matching nothing all collapse to
		// `matched` being undefined, and preflightResponse's default parameter
		// is what fails that closed to the "app" allowlist rather than the
		// wildcard.
		const requestedMethod = request.headers.get(
			"Access-Control-Request-Method",
		);
		const path = new URL(request.url).pathname;
		const matched = requestedMethod
			? resolveRoute(ROUTES, requestedMethod, path)
			: undefined;
		return preflightResponse(request, env, matched?.route.cors);
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

	// A second, cheap lookup against the same table dispatch() already matched
	// against, rather than a return value threaded through it, so dispatch()'s
	// signature stays "a request in, a response out." An unmatched route (a
	// 404) leaves this undefined, and withCors's default parameter applies -
	// the "app" allowlist posture, same as before this route ever existed.
	const url = new URL(request.url);
	const matched = resolveRoute(ROUTES, request.method, url.pathname);

	return withCors(response, request, env, matched?.route.cors);
}

/**
 * Root endpoint: returns API info and available routes.
 *
 * Filters out `auth: "operator"` routes by that property, not by naming their
 * paths. An operator route is the only kind that hides its existence from a
 * signed-in caller who lacks operator authority. resolvePrincipal calls
 * requireAuth before the operator check, so a credential-less request still
 * gets 401 - the same as any other protected route, confirming nothing extra
 * - but a signed-in non-operator gets 404 instead of 403 (see
 * middleware/principal.ts) specifically so they cannot tell the route apart
 * from one that does not exist at all. Every other auth mode has no
 * equivalent case to hide: "session" and "machine" grant access to any
 * signed-in caller with no further permission check, and "none" routes are
 * public by definition. So operator routes are the one set a public listing
 * must omit - handing that caller the exact path defeats the entire point of
 * the 404 - and filtering on the property means a future operator route is
 * excluded automatically, with no path list here to forget to update.
 *
 * Deliberately not `listRoutes()`, which stays a full, unfiltered dump "for
 * debugging/docs" per its own doc comment - a debugging helper that silently
 * omits routes is its own trap. The filtering belongs at this point of public
 * disclosure instead.
 */
function handleRoot(env: WorkerEnv): Response {
	const routes = ROUTES.filter((route) => route.auth !== "operator").map(
		({ method, path }) => ({ method, path }),
	);
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
		// The body lives in scheduled.ts so it can be tested. This signature
		// belongs to the runtime, so there is nowhere to pass a fake through -
		// which is why the heartbeat-before-prune ordering and the prune's
		// try/catch went unverified by anything but hand inspection until
		// onlooker-kipn.2. scheduled.test.ts pins both now.
		await runScheduled(env);
	},
});
