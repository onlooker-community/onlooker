import type { D1Database, KVNamespace } from "@cloudflare/workers-types";

export * from "./requests";
export * from "./responses";

/**
 * Path parameters the router captured from a route pattern, keyed without the
 * colon: `/lessons/:id/status` matched against `/lessons/abc/status` gives
 * `{ id: "abc" }`.
 *
 * Declared here rather than in router.ts because router.ts imports every route
 * handler; handlers importing a type back from it would close a cycle. This
 * sits beside WorkerEnv, which handlers already import for the same reason.
 */
export type RouteParams = Record<string, string>;

/**
 * Worker environment variables and bindings.
 * These are injected by Cloudflare Workers runtime.
 */
export interface WorkerEnv {
	// Environment
	ENVIRONMENT?: string;

	// JWT configuration
	JWT_SECRET: string;
	TOKEN_EXPIRY_MINUTES: string;
	REFRESH_TOKEN_EXPIRY_DAYS: string;

	// Required, not optional. Every authenticated route reaches for this, and
	// typing it optional bought nothing - the call sites asserted it away with
	// `!`, so a missing binding surfaced as a runtime 500 reading
	// "Cannot read properties of undefined (reading 'prepare')" instead of a
	// compile error. Each environment in wrangler.toml must declare it.
	DB: D1Database;

	// Origins allowed to call this API from a browser, comma-separated. Required
	// for the same reason DB is: every environment in wrangler.toml declares one,
	// and this being optional is close to how it went unread for so long.
	//
	// TypeScript cannot police a wrangler.toml var, so the runtime still treats a
	// missing value as "allow nothing" rather than trusting this type. See
	// middleware/cors.ts for why that direction is the safe one.
	CORS_ORIGIN: string;

	// Resend API key, set with `wrangler secret put RESEND_API_KEY --env <env>`.
	// A secret rather than a var: it is a bearer credential for sending mail as
	// this domain.
	//
	// Optional because local development has no reason to hold one - sendEmail
	// logs the message instead, so the flows stay exercisable. In a deployed
	// environment its absence is a misconfiguration that shows up as a warning
	// per send, not an exception, since a 500 there would tell an attacker which
	// addresses are registered.
	RESEND_API_KEY?: string;

	// The From address. A var, not a secret - it is printed on every message we
	// send - and it must belong to a domain verified with the provider, or every
	// send is rejected.
	EMAIL_FROM: string;

	// Where links in those emails point. The API and the web app are different
	// hostnames, so this cannot be derived from the request.
	APP_BASE_URL: string;

	// Optional: KV namespace for token revocation (future)
	TOKEN_REVOCATION?: KVNamespace;
}

/**
 * Context for route handlers with extracted auth information.
 */
export interface AuthContext {
	userId: string;
	email: string;
	tokenType: "access" | "refresh";
	iat: number;
	exp: number;
}

/**
 * Standard API error with type-safe status and error codes.
 */
export class ApiError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
		public details?: unknown,
	) {
		super(message);
		this.name = "ApiError";
	}
}
