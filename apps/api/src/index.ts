/**
 * Onlooker API Server
 * Cloudflare Workers backend for authentication, account management, and protected resources.
 *
 * Workstream integration:
 * - WS1: Database schema and D1 queries (not yet implemented)
 * - WS2: Account management endpoints (scaffold complete, awaiting WS1)
 * - WS3: Session management and refresh flow (frontend, not backend)
 * - WS4: Protected dashboard data (awaiting WS1 database)
 * - WS5: Rate limiting and security (not yet implemented)
 */

import type { ExecutionContext } from "@cloudflare/workers-types";
import { preflightResponse, withCors } from "./middleware";
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

	// Route the request
	const response = await dispatch(request, env);

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
 */
export default {
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
};
