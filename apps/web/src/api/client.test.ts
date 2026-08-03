import { AuthApiError } from "@onlooker/auth-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client";
import type { ApiConfig } from "./config";
import { createTokenStore, type TokenStore } from "./tokenStore";

function memoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		getItem: (key: string) => map.get(key) ?? null,
		key: (index: number) => [...map.keys()][index] ?? null,
		removeItem: (key: string) => {
			map.delete(key);
		},
		setItem: (key: string, value: string) => {
			map.set(key, value);
		},
	};
}

function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
	return {
		baseUrl: "",
		useMockApi: false,
		requestTimeoutMs: 1000,
		maxRetries: 2,
		retryBaseDelayMs: 0,
		retryMaxDelayMs: 0,
		tokenStorageKey: "auth_token",
		refreshTokenStorageKey: "auth_refresh_token",
		logRequests: false,
		...overrides,
	};
}

function json(
	status: number,
	body: unknown,
	headers?: Record<string, string>,
): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

function authHeaderOf(init: RequestInit | undefined): string | null {
	return new Headers(init?.headers as HeadersInit | undefined).get(
		"Authorization",
	);
}

let store: TokenStore;

beforeEach(() => {
	store = createTokenStore("auth_token", "auth_refresh_token", memoryStorage());
});

describe("createApiClient — token refresh", () => {
	it("refreshes on 401 and replays the request with the new access token", async () => {
		store.setTokens({ accessToken: "old", refreshToken: "r1" });

		const baseFetch = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/auth/refresh")) {
				return json(200, { token: "new", refreshToken: "r2" });
			}
			return authHeaderOf(init) === "Bearer new"
				? json(200, { user: { id: "u1", email: "a@b.co" } })
				: json(401, { error: "unauthorized" });
		});

		const { apiClient } = createApiClient({
			config: testConfig(),
			tokenStore: store,
			baseFetch: baseFetch as unknown as typeof fetch,
		});

		const result = await apiClient.get<{ user: { id: string } }>("/auth/me");

		expect(result.user.id).toBe("u1");
		expect(store.getToken()).toBe("new");
		expect(store.getRefreshToken()).toBe("r2");
		// original 401, refresh, successful replay
		expect(baseFetch).toHaveBeenCalledTimes(3);
	});

	it("fails to refresh when refresh token is expired", async () => {
		const { authenticatedFetch } = createApiClient({
			config: testConfig({ useMockApi: true }),
			tokenStore: store,
		});

		// Set an access token that will trigger a refresh (we'll fail it in the refresh call)
		// and an expired refresh token
		const iat = Math.floor(Date.now() / 1000) - 300;
		const exp = iat + 60; // expired
		const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
		const payload = btoa(
			JSON.stringify({
				sub: "test@example.com",
				type: "refresh",
				iat,
				exp,
				jti: 1,
			}),
		)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		const expiredRefresh = `${header}.${payload}.mock-signature`;

		store.setTokens({ accessToken: "old", refreshToken: expiredRefresh });

		// First request will get 401 (no valid access token)
		// Then refresh attempt will fail (expired refresh token)
		const response = await authenticatedFetch("/auth/me", { method: "GET" });

		expect(response.status).toBe(401);
		expect(store.getToken()).toBeNull();
		expect(store.getRefreshToken()).toBeNull();
	});

	it("clears tokens and reports unauthorized when refresh fails", async () => {
		store.setTokens({ accessToken: "old", refreshToken: "bad" });
		const onUnauthorized = vi.fn();

		const baseFetch = vi.fn(async (url: string) => {
			if (url.endsWith("/auth/refresh")) {
				return json(401, { error: "invalid_refresh_token" });
			}
			return json(401, { error: "unauthorized" });
		});

		const { apiClient } = createApiClient({
			config: testConfig(),
			tokenStore: store,
			baseFetch: baseFetch as unknown as typeof fetch,
			onUnauthorized,
		});

		await expect(apiClient.get("/auth/me")).rejects.toBeInstanceOf(
			AuthApiError,
		);
		expect(store.getToken()).toBeNull();
		expect(store.getRefreshToken()).toBeNull();
		expect(onUnauthorized).toHaveBeenCalled();
	});

	it("coalesces concurrent 401s into a single refresh call", async () => {
		store.setTokens({ accessToken: "old", refreshToken: "r1" });
		let refreshCalls = 0;

		const baseFetch = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/auth/refresh")) {
				refreshCalls += 1;
				return json(200, { token: "new", refreshToken: "r2" });
			}
			return authHeaderOf(init) === "Bearer new"
				? json(200, { ok: true })
				: json(401, { error: "unauthorized" });
		});

		const { authenticatedFetch } = createApiClient({
			config: testConfig(),
			tokenStore: store,
			baseFetch: baseFetch as unknown as typeof fetch,
		});

		const [a, b] = await Promise.all([
			authenticatedFetch("/auth/me"),
			authenticatedFetch("/auth/me"),
		]);

		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
		expect(refreshCalls).toBe(1);
	});

	it("does not attempt refresh on login/signup 401s", async () => {
		store.setRefreshToken("r1");
		const baseFetch = vi.fn(async () =>
			json(401, { error: "invalid_credentials" }),
		);

		const { authenticatedFetch } = createApiClient({
			config: testConfig(),
			tokenStore: store,
			baseFetch: baseFetch as unknown as typeof fetch,
		});

		const response = await authenticatedFetch("/auth/login", {
			method: "POST",
		});

		expect(response.status).toBe(401);
		expect(baseFetch).toHaveBeenCalledTimes(1); // no /auth/refresh call
	});

	it("rejects expired access tokens with 401", async () => {
		// Use the real mock API which mints JWTs with exp
		const { apiClient } = createApiClient({
			config: testConfig({ useMockApi: true }),
			tokenStore: store,
		});

		// Manually set an expired access token (past exp claim)
		const expiredToken = (() => {
			const iat = Math.floor(Date.now() / 1000) - 300; // issued 5min ago
			const exp = iat + 60; // expired 4min ago
			const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"; // {alg: HS256, typ: JWT}
			const payload = btoa(
				JSON.stringify({
					sub: "test@example.com",
					type: "access",
					iat,
					exp,
					jti: 1,
				}),
			)
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");
			return `${header}.${payload}.mock-signature`;
		})();

		store.setTokens({ accessToken: expiredToken, refreshToken: "r1" });

		// Attempt to use the expired token — should fail because mockApi validates exp
		await expect(apiClient.get("/auth/me")).rejects.toBeInstanceOf(
			AuthApiError,
		);
	});

	it("emits onUnauthorized exactly once when refresh-of-refresh fails", async () => {
		const onUnauthorized = vi.fn();

		const { authenticatedFetch } = createApiClient({
			config: testConfig({ useMockApi: true }),
			tokenStore: store,
			onUnauthorized,
		});

		// Log in successfully
		let response = await authenticatedFetch("/auth/login", {
			method: "POST",
			body: JSON.stringify({
				email: "test@example.com",
				password: "password123",
			}),
		});
		expect(response.status).toBe(200);
		const loginData = (await response.json()) as {
			token: string;
			refreshToken: string;
		};
		store.setTokens({
			accessToken: loginData.token,
			refreshToken: loginData.refreshToken,
		});

		// Invalidate the refresh token to make refresh fail
		await authenticatedFetch("/auth/logout", { method: "POST" });

		// Now make a request that will 401 and try to refresh
		// The refresh will fail (refresh token is revoked), so we get a terminal 401
		response = await authenticatedFetch("/auth/me", { method: "GET" });
		expect(response.status).toBe(401);

		// onUnauthorized should be called exactly once
		expect(onUnauthorized).toHaveBeenCalledTimes(1);
		expect(store.getToken()).toBeNull();
		expect(store.getRefreshToken()).toBeNull();
	});

	it("validates tokens via owner-map (in-session) and decode fallback (reload)", async () => {
		// Use mock API which maintains both owner-map and stateless decode
		const { authenticatedFetch } = createApiClient({
			config: testConfig({ useMockApi: true }),
			tokenStore: store,
		});

		// First, log in to populate the owner-map
		let response = await authenticatedFetch("/auth/login", {
			method: "POST",
			body: JSON.stringify({
				email: "test@example.com",
				password: "password123",
			}),
		});
		expect(response.status).toBe(200);
		const loginData = (await response.json()) as {
			token: string;
			refreshToken: string;
		};
		const accessToken = loginData.token;

		// In-session: owner-map is authoritative
		store.setTokens({ accessToken, refreshToken: loginData.refreshToken });
		response = await authenticatedFetch("/auth/me", { method: "GET" });
		expect(response.status).toBe(200);

		// Simulate a reload: hand-mint a valid, unexpired token that was never
		// registered in the owner map. Because it is absent from the map, the only
		// way it can validate is through the stateless decode fallback
		// (`?? decodedEmail`) — which is exactly the reload path we want to cover.
		const newToken = (() => {
			const iat = Math.floor(Date.now() / 1000);
			const exp = iat + 3600; // valid for 1 hour (NOT expired)
			const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
			const payload = btoa(
				JSON.stringify({
					sub: "test@example.com",
					type: "access",
					iat,
					exp,
					jti: 999, // unique, never registered in the owner map
				}),
			)
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");
			return `${header}.${payload}.mock-signature`;
		})();

		const store2 = createTokenStore(
			"auth_token",
			"auth_refresh_token",
			memoryStorage(),
		);
		store2.setTokens({ accessToken: newToken, refreshToken: "fake-refresh" });

		const { authenticatedFetch: fetch2 } = createApiClient({
			config: testConfig({ useMockApi: true }),
			tokenStore: store2,
		});

		// Succeeds only if the decode fallback runs: the token is valid (not
		// expired) but absent from the owner map.
		response = await fetch2("/auth/me", { method: "GET" });
		expect(response.status).toBe(200);
	});

	it("rejects revoked tokens (logout / rotation / session invalidation)", async () => {
		const { authenticatedFetch } = createApiClient({
			config: testConfig({ useMockApi: true }),
			tokenStore: store,
		});

		// Log in to get a valid token
		let response = await authenticatedFetch("/auth/login", {
			method: "POST",
			body: JSON.stringify({
				email: "test@example.com",
				password: "password123",
			}),
		});
		expect(response.status).toBe(200);
		const loginData = (await response.json()) as {
			token: string;
			refreshToken: string;
		};
		store.setTokens({
			accessToken: loginData.token,
			refreshToken: loginData.refreshToken,
		});

		// Verify token works
		response = await authenticatedFetch("/auth/me", { method: "GET" });
		expect(response.status).toBe(200);

		// Logout invalidates sessions (revokes the token)
		response = await authenticatedFetch("/auth/logout", { method: "POST" });
		expect(response.status).toBe(200);

		// Now the revoked token should be rejected
		response = await authenticatedFetch("/auth/me", { method: "GET" });
		expect(response.status).toBe(401);
	});
});

describe("createApiClient — retry & backoff", () => {
	it("retries retryable 5xx responses up to maxRetries", async () => {
		let calls = 0;
		const baseFetch = vi.fn(async () => {
			calls += 1;
			return calls < 3
				? json(503, { error: "unavailable" })
				: json(200, { ok: true });
		});

		const { authenticatedFetch } = createApiClient({
			config: testConfig({ maxRetries: 2 }),
			tokenStore: store,
			baseFetch: baseFetch as unknown as typeof fetch,
		});

		const response = await authenticatedFetch("/data");

		expect(response.status).toBe(200);
		expect(baseFetch).toHaveBeenCalledTimes(3);
	});

	it("stops retrying after maxRetries and returns the last 5xx", async () => {
		const baseFetch = vi.fn(async () => json(500, { error: "boom" }));

		const { authenticatedFetch } = createApiClient({
			config: testConfig({ maxRetries: 1 }),
			tokenStore: store,
			baseFetch: baseFetch as unknown as typeof fetch,
		});

		const response = await authenticatedFetch("/data");

		expect(response.status).toBe(500);
		expect(baseFetch).toHaveBeenCalledTimes(2); // initial + 1 retry
	});

	it("does not retry non-retryable 4xx responses", async () => {
		const baseFetch = vi.fn(async () => json(404, { error: "not_found" }));

		const { authenticatedFetch } = createApiClient({
			config: testConfig({ maxRetries: 3 }),
			tokenStore: store,
			baseFetch: baseFetch as unknown as typeof fetch,
		});

		const response = await authenticatedFetch("/data");

		expect(response.status).toBe(404);
		expect(baseFetch).toHaveBeenCalledTimes(1);
	});
});

describe("createApiClient — timeout", () => {
	it("aborts a slow request and retries it", async () => {
		let calls = 0;
		const baseFetch = vi.fn((_: string, init?: RequestInit) => {
			calls += 1;
			if (calls === 1) {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						const err = new Error("aborted");
						err.name = "AbortError";
						reject(err);
					});
				});
			}
			return Promise.resolve(json(200, { ok: true }));
		});

		const { authenticatedFetch } = createApiClient({
			config: testConfig({ requestTimeoutMs: 20, maxRetries: 1 }),
			tokenStore: store,
			baseFetch: baseFetch as unknown as typeof fetch,
		});

		const response = await authenticatedFetch("/slow");

		expect(response.status).toBe(200);
		expect(baseFetch).toHaveBeenCalledTimes(2);
	});
});
