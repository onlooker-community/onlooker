/**
 * CORS policy, driven by the CORS_ORIGIN each environment declares.
 *
 * Every environment in wrangler.toml has always named an origin -
 * http://localhost:5173, https://app-staging.onlooker.dev,
 * https://app.onlooker.dev - and the worker read none of them, answering
 * `Access-Control-Allow-Origin: *` to everyone instead. The config described a
 * policy nothing enforced, which is worse than declaring none: anyone reading
 * wrangler.toml had every reason to believe production was locked to
 * app.onlooker.dev.
 *
 * CORS is a browser mechanism, so nothing here affects server-to-server callers
 * or the heartbeat. What it changes is that a hostile page can no longer read
 * the responses to unauthenticated endpoints - login and signup among them -
 * which is what made credential stuffing from arbitrary origins cheap.
 */

import type { WorkerEnv } from "../types";

const ALLOW_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const ALLOW_HEADERS = "Content-Type, Authorization";
const MAX_AGE = "86400";

/**
 * The origins this environment permits.
 *
 * Comma-separated, because one origin per environment is true today and is one
 * decision away from not being: apps/website is a separate origin from
 * app.onlooker.dev, and a developer on 127.0.0.1 is a separate origin from one
 * on localhost. Each environment still declares exactly one.
 */
function allowedOrigins(env: WorkerEnv): string[] {
	return (env.CORS_ORIGIN ?? "")
		.split(",")
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0);
}

/**
 * The origin to echo back, or null to say nothing.
 *
 * Matching is exact. Anything looser leaks the allowlist: a prefix match trusts
 * app.onlooker.dev.evil.example, and a host-only match trusts plain http.
 *
 * Returning null covers three cases that all deserve silence - no Origin at all
 * (not a browser, nothing to answer), an origin that is not allowed, and an
 * unset CORS_ORIGIN. That last one is a misconfiguration, and failing closed
 * makes it a visibly blocked front end rather than a silently open API, which
 * is the failure this whole module exists to end.
 */
function permittedOrigin(request: Request, env: WorkerEnv): string | null {
	const origin = request.headers.get("Origin");
	if (!origin) return null;

	return allowedOrigins(env).includes(origin) ? origin : null;
}

/**
 * Apply the origin policy to a response.
 *
 * Vary: Origin is not optional now that the answer depends on who asked. Without
 * it a shared cache can hand one site the response computed for another, or
 * cache the no-header refusal and lock out the real front end.
 *
 * Note what is absent: Access-Control-Allow-Credentials. Echoing an origin and
 * allowing credentials is the pairing that turns a permissive allowlist into
 * session theft, and this API has no use for it - it authenticates with Bearer
 * tokens the browser attaches deliberately, not cookies it attaches on its own.
 */
export function withCors(
	response: Response,
	request: Request,
	env: WorkerEnv,
): Response {
	response.headers.append("Vary", "Origin");

	const origin = permittedOrigin(request, env);
	if (origin) {
		response.headers.set("Access-Control-Allow-Origin", origin);
		response.headers.set("Access-Control-Allow-Methods", ALLOW_METHODS);
		response.headers.set("Access-Control-Allow-Headers", ALLOW_HEADERS);
	}

	return response;
}

/**
 * Answer a preflight.
 *
 * A refused origin gets a bare 200 and no description of the API. There is
 * nothing secret in the method list, but spelling it out for a caller being
 * turned away is answering a question it is not allowed to ask.
 */
export function preflightResponse(request: Request, env: WorkerEnv): Response {
	const response = new Response(null, { headers: { Vary: "Origin" } });

	const origin = permittedOrigin(request, env);
	if (origin) {
		response.headers.set("Access-Control-Allow-Origin", origin);
		response.headers.set("Access-Control-Allow-Methods", ALLOW_METHODS);
		response.headers.set("Access-Control-Allow-Headers", ALLOW_HEADERS);
		response.headers.set("Access-Control-Max-Age", MAX_AGE);
	}

	return response;
}
