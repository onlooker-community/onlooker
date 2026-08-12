import type { D1Database, KVNamespace } from "@cloudflare/workers-types";

export * from "./requests";
export * from "./responses";

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
