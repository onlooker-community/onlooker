/**
 * Production API client for the web app.
 *
 * Layers, from the network outward:
 *   1. timeout      — aborts a request after `requestTimeoutMs`
 *   2. retry        — exponential backoff w/ jitter for transient failures
 *   3. auth refresh — on 401, refreshes tokens once and replays the request
 *   4. logging      — records each call with tokens redacted
 *
 * `authenticatedFetch` is a drop-in `fetch` that other workstreams (e.g. the
 * authenticated data-fetching hooks) can consume directly. `apiClient` is the
 * typed convenience wrapper used by the auth layer.
 */

import { createAuthApiClient } from "@onlooker/auth-react";
import { type ApiConfig, apiConfig } from "./config";
import { createApiLogger } from "./logger";
import { createMockFetch } from "./mockApi";
import { createTokenStore, type TokenStore } from "./tokenStore";
import {
	AUTH_ENDPOINTS,
	REFRESH_EXEMPT_PATHS,
	type RefreshRequest,
	type RefreshResponse,
} from "./types";

class ApiTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`Request timed out after ${timeoutMs}ms`);
		this.name = "ApiTimeoutError";
	}
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function now(): number {
	return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function pathOf(url: string): string {
	try {
		return new URL(url, "http://local").pathname;
	} catch {
		return url;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CreateApiClientOptions {
	config?: ApiConfig;
	tokenStore?: TokenStore;
	/** Underlying fetch. Defaults to the mock or the global fetch per config. */
	baseFetch?: typeof fetch;
	/** Invoked when a session is unrecoverable (refresh failed / no refresh). */
	onUnauthorized?: () => void;
}

export interface ApiClientBundle {
	config: ApiConfig;
	tokenStore: TokenStore;
	/** Enhanced `fetch`: injects auth, retries, and refreshes transparently. */
	authenticatedFetch: typeof fetch;
	/** Typed convenience client (get/post/patch/delete) over authenticatedFetch. */
	apiClient: ReturnType<typeof createAuthApiClient>;
	/** Force a token refresh. Resolves true if a fresh token was obtained. */
	refreshTokens: () => Promise<boolean>;
}

export function createApiClient(
	options: CreateApiClientOptions = {},
): ApiClientBundle {
	const config = options.config ?? apiConfig;
	const tokenStore =
		options.tokenStore ??
		createTokenStore(config.tokenStorageKey, config.refreshTokenStorageKey);
	const logger = createApiLogger(config.logRequests);

	const baseFetch: typeof fetch =
		options.baseFetch ??
		(config.useMockApi ? (createMockFetch() as typeof fetch) : fetch);

	// --- timeout -----------------------------------------------------------
	async function fetchWithTimeout(
		url: string,
		init: RequestInit,
	): Promise<Response> {
		if (config.requestTimeoutMs <= 0) return baseFetch(url, init);

		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(new ApiTimeoutError(config.requestTimeoutMs)),
			config.requestTimeoutMs,
		);

		const caller = init.signal;
		if (caller) {
			if (caller.aborted) controller.abort(caller.reason);
			else {
				caller.addEventListener(
					"abort",
					() => controller.abort(caller.reason),
					{ once: true },
				);
			}
		}

		try {
			return await baseFetch(url, { ...init, signal: controller.signal });
		} catch (err) {
			if (controller.signal.reason instanceof ApiTimeoutError) {
				throw controller.signal.reason;
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	// --- retry / backoff ---------------------------------------------------
	function backoffDelay(attempt: number): number {
		const exp = config.retryBaseDelayMs * 2 ** attempt;
		const capped = Math.min(exp, config.retryMaxDelayMs);
		return Math.random() * capped; // full jitter
	}

	function retryAfterMs(response: Response): number | null {
		const header = response.headers.get("Retry-After");
		if (!header) return null;
		const seconds = Number(header);
		if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
		const date = Date.parse(header);
		if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
		return null;
	}

	function isRetryableError(err: unknown): boolean {
		// Our timeout, or a network-level fetch failure (thrown as TypeError).
		// A caller-initiated abort surfaces as an AbortError and is NOT retried.
		return err instanceof ApiTimeoutError || err instanceof TypeError;
	}

	async function resilientFetch(
		method: string,
		url: string,
		init: RequestInit,
	): Promise<Response> {
		let attempt = 0;
		while (true) {
			try {
				const response = await fetchWithTimeout(url, init);
				if (
					attempt < config.maxRetries &&
					RETRYABLE_STATUS.has(response.status)
				) {
					const wait = retryAfterMs(response) ?? backoffDelay(attempt);
					attempt += 1;
					logger.failure({ method, url, status: response.status, attempt });
					await sleep(wait);
					continue;
				}
				return response;
			} catch (err) {
				if (attempt < config.maxRetries && isRetryableError(err)) {
					const wait = backoffDelay(attempt);
					attempt += 1;
					logger.failure({
						method,
						url,
						attempt,
						error: err instanceof Error ? err.name : "network_error",
					});
					await sleep(wait);
					continue;
				}
				throw err;
			}
		}
	}

	// --- auth refresh (single-flight) -------------------------------------
	let refreshInFlight: Promise<boolean> | null = null;

	async function performRefresh(): Promise<boolean> {
		const refreshToken = tokenStore.getRefreshToken();
		if (!refreshToken) return false;

		try {
			const body: RefreshRequest = { refreshToken };
			const response = await fetchWithTimeout(
				`${config.baseUrl}${AUTH_ENDPOINTS.refresh}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				},
			);

			if (!response.ok) {
				// Refresh token rejected — the session cannot be recovered.
				tokenStore.clear();
				return false;
			}

			const data = (await response
				.json()
				.catch(() => null)) as RefreshResponse | null;
			if (!data?.token || !data?.refreshToken) {
				tokenStore.clear();
				return false;
			}

			tokenStore.setTokens({
				accessToken: data.token,
				refreshToken: data.refreshToken,
			});
			return true;
		} catch {
			// Transient failure (network/timeout): keep tokens, report no refresh.
			return false;
		}
	}

	function refreshTokens(): Promise<boolean> {
		if (!refreshInFlight) {
			refreshInFlight = performRefresh().finally(() => {
				refreshInFlight = null;
			});
		}
		return refreshInFlight;
	}

	// --- auth header injection --------------------------------------------
	function withAuthHeader(init: RequestInit): RequestInit {
		const token = tokenStore.getToken();
		const headers = new Headers(init.headers as HeadersInit | undefined);
		if (token) headers.set("Authorization", `Bearer ${token}`);
		else headers.delete("Authorization");
		return { ...init, headers };
	}

	// --- public authenticated fetch ---------------------------------------
	const authenticatedFetch: typeof fetch = async (input, init = {}) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		const method = (init.method ?? "GET").toUpperCase();
		const path = pathOf(url);
		const started = now();

		logger.request({ method, url });

		let response = await resilientFetch(method, url, withAuthHeader(init));

		const eligibleForRefresh =
			response.status === 401 &&
			!REFRESH_EXEMPT_PATHS.some((exempt) => path.endsWith(exempt)) &&
			tokenStore.getRefreshToken() !== null;

		if (eligibleForRefresh) {
			const refreshed = await refreshTokens();
			if (refreshed) {
				response = await resilientFetch(method, url, withAuthHeader(init));
			} else {
				tokenStore.clear();
				options.onUnauthorized?.();
			}
		}

		const durationMs = now() - started;
		if (response.ok) {
			logger.success({ method, url, status: response.status, durationMs });
		} else {
			logger.failure({ method, url, status: response.status, durationMs });
		}
		return response;
	};

	const apiClient = createAuthApiClient({
		baseUrl: config.baseUrl,
		tokenStorage: tokenStore,
		onUnauthorized: options.onUnauthorized,
		fetchImpl: authenticatedFetch,
	});

	return { config, tokenStore, authenticatedFetch, apiClient, refreshTokens };
}

let unauthorizedHandler: (() => void) | null = null;

/**
 * Register the handler invoked when the shared client hits an unrecoverable 401
 * (refresh failed or no refresh token). Wire this to session teardown — a
 * LOCAL logout that resets auth state and redirects. Registering replaces any
 * previous handler; pass `null` to clear.
 *
 * The handler MUST NOT issue another authenticated request (e.g. a network
 * logout to `/auth/logout`): that call would 401, re-enter this path, and loop.
 * Drive local state only.
 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
	unauthorizedHandler = handler;
}

/**
 * Shared client instance for the current environment. Import these directly
 * from feature code (auth layer, authenticated data hooks, etc.).
 */
export const {
	config: activeApiConfig,
	tokenStore,
	authenticatedFetch,
	apiClient,
	refreshTokens,
} = createApiClient({
	onUnauthorized: () => unauthorizedHandler?.(),
});
