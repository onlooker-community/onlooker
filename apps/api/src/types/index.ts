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

	// Database connection (WS1 integration)
	DB_HOST: string;
	DB_PORT: string;
	DB_NAME: string;

	// JWT configuration
	JWT_SECRET: string;
	TOKEN_EXPIRY_MINUTES: string;
	REFRESH_TOKEN_EXPIRY_DAYS: string;

	// Optional: D1 database binding (future)
	DB?: D1Database;

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
