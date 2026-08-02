/**
 * Environment-driven API configuration.
 *
 * All values are sourced from Vite env vars (`VITE_*`) at build time, with
 * environment-aware fallbacks so the app runs with zero configuration in
 * local development. See `.env.example` for the full list of variables.
 */

export interface ApiConfig {
	/** Base URL for the API. Empty string means same-origin relative paths. */
	baseUrl: string;
	/** When true, requests are served by the in-memory mock API. */
	useMockApi: boolean;
	/** Per-request timeout in milliseconds before the request is aborted. */
	requestTimeoutMs: number;
	/** Max automatic retries for transient failures (network / 5xx / 429). */
	maxRetries: number;
	/** Base delay for exponential backoff between retries. */
	retryBaseDelayMs: number;
	/** Upper bound on any single backoff delay. */
	retryMaxDelayMs: number;
	/** localStorage key holding the short-lived access token. */
	tokenStorageKey: string;
	/** localStorage key holding the long-lived refresh token. */
	refreshTokenStorageKey: string;
	/** When true, API calls are logged to the console (tokens redacted). */
	logRequests: boolean;
}

function env(): ImportMetaEnv {
	// `import.meta.env` is inlined by Vite in the browser build and is undefined
	// under a bare Node/test runtime — fall back to an empty object either way.
	return (
		(typeof import.meta !== "undefined" && import.meta.env) ||
		({} as ImportMetaEnv)
	);
}

function readString(key: string): string | undefined {
	const value = env()[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(key: string, fallback: boolean): boolean {
	const value = readString(key);
	if (value === undefined) return fallback;
	return value === "true" || value === "1";
}

function readNumber(key: string, fallback: number): number {
	const value = readString(key);
	if (value === undefined) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isDev(): boolean {
	const e = env();
	if (typeof e.DEV === "boolean") return e.DEV;
	return e.MODE !== "production";
}

export function resolveApiConfig(): ApiConfig {
	const baseUrl = readString("VITE_API_BASE_URL") ?? "";

	// Default to the mock API whenever no real base URL is configured so the app
	// is runnable out of the box; an explicit VITE_USE_MOCK_API always wins.
	const useMockApi = readBoolean("VITE_USE_MOCK_API", baseUrl === "");

	return {
		baseUrl,
		useMockApi,
		requestTimeoutMs: readNumber("VITE_API_TIMEOUT_MS", 15_000),
		maxRetries: readNumber("VITE_API_MAX_RETRIES", 2),
		retryBaseDelayMs: readNumber("VITE_API_RETRY_BASE_DELAY_MS", 300),
		retryMaxDelayMs: readNumber("VITE_API_RETRY_MAX_DELAY_MS", 5_000),
		tokenStorageKey: readString("VITE_AUTH_TOKEN_KEY") ?? "auth_token",
		refreshTokenStorageKey:
			readString("VITE_AUTH_REFRESH_KEY") ?? "auth_refresh_token",
		logRequests: readBoolean("VITE_API_LOG_REQUESTS", isDev()),
	};
}

/** Resolved config for the current environment. */
export const apiConfig: ApiConfig = resolveApiConfig();
