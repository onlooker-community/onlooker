import { AuthApiError } from "@onlooker/auth-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../api/client";
import type { ApiConfig } from "../api/config";
import { createMockFetch } from "../api/mockApi";
import { createTokenStore } from "../api/tokenStore";
import type { AuthTokenResponse, MeResponse } from "../api/types";

/**
 * Cross-stack integration coverage for the authentication data path. These
 * tests drive WS1's real composed client (`createApiClient` — auth-header
 * injection, retry/backoff, timeout, and the single-flight refresh middleware)
 * against both the Phase 2 mock API and scripted fetch stubs, asserting the
 * end-to-end HTTP contract and the token-lifecycle side effects.
 *
 * Component rendering is out of scope until a DOM test harness (jsdom +
 * @testing-library) is added to the workspace; see SECURITY.md / the test
 * README for that follow-up.
 */

const SEED_EMAIL = "test@example.com";
const SEED_PASSWORD = "password123";

/** In-memory Storage so token side effects are observable and isolated. */
function createMemoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
		key: (index: number) => Array.from(map.keys())[index] ?? null,
		removeItem: (key: string) => {
			map.delete(key);
		},
		setItem: (key: string, value: string) => {
			map.set(key, value);
		},
	};
}

/** An error body in the shape apps/api actually returns. */
function apiError(code: string, message = "Something went wrong") {
	return { success: false, error: { code, message } };
}

function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
	return {
		baseUrl: "",
		useMockApi: false,
		requestTimeoutMs: 0,
		maxRetries: 0,
		retryBaseDelayMs: 1,
		retryMaxDelayMs: 2,
		tokenStorageKey: "auth_token",
		refreshTokenStorageKey: "auth_refresh_token",
		logRequests: false,
		...overrides,
	};
}

function makeClient(
	baseFetch: typeof fetch,
	options: {
		config?: Partial<ApiConfig>;
		onUnauthorized?: () => void;
	} = {},
) {
	const storage = createMemoryStorage();
	const tokenStore = createTokenStore(
		"auth_token",
		"auth_refresh_token",
		storage,
	);
	const bundle = createApiClient({
		config: testConfig(options.config),
		tokenStore,
		baseFetch,
		onUnauthorized: options.onUnauthorized,
	});
	return { ...bundle, storage };
}

let uniqueCounter = 0;
function uniqueEmail(): string {
	uniqueCounter += 1;
	return `user-${Date.now()}-${uniqueCounter}@example.com`;
}

describe("full auth flow against the mock API", () => {
	it("signs up, stores the token, and reads the protected profile", async () => {
		const { apiClient, tokenStore } = makeClient(
			createMockFetch() as typeof fetch,
		);
		const email = uniqueEmail();

		const signup = await apiClient.post<AuthTokenResponse>("/auth/signup", {
			email,
			password: "Str0ng!Passw0rd",
			name: "New User",
		});
		expect(signup.token).toBeTruthy();
		expect(signup.user.email).toBe(email);

		tokenStore.setToken(signup.token);
		const me = await apiClient.get<MeResponse>("/auth/me");
		expect(me.user.email).toBe(email);
	});

	it("logs in an existing user, reads /auth/me, then logs out", async () => {
		const { apiClient, tokenStore } = makeClient(
			createMockFetch() as typeof fetch,
		);

		const login = await apiClient.post<AuthTokenResponse>("/auth/login", {
			email: SEED_EMAIL,
			password: SEED_PASSWORD,
		});
		expect(login.user.email).toBe(SEED_EMAIL);
		tokenStore.setToken(login.token);

		const me = await apiClient.get<MeResponse>("/auth/me");
		expect(me.user.email).toBe(SEED_EMAIL);

		await apiClient.post("/auth/logout", {});
		tokenStore.clear();
		expect(tokenStore.getToken()).toBeNull();
	});

	it("can authenticate again after logout clears the session", async () => {
		const { apiClient, tokenStore } = makeClient(
			createMockFetch() as typeof fetch,
		);

		const first = await apiClient.post<AuthTokenResponse>("/auth/login", {
			email: SEED_EMAIL,
			password: SEED_PASSWORD,
		});
		tokenStore.setToken(first.token);
		tokenStore.clear();
		expect(tokenStore.getToken()).toBeNull();

		const second = await apiClient.post<AuthTokenResponse>("/auth/login", {
			email: SEED_EMAIL,
			password: SEED_PASSWORD,
		});
		tokenStore.setToken(second.token);
		expect(tokenStore.getToken()).toBe(second.token);
	});
});

describe("auth header injection", () => {
	it("attaches the stored access token as a Bearer header", async () => {
		const seen: string[] = [];
		const spy = (async (_url: string, init: RequestInit = {}) => {
			seen.push(new Headers(init.headers).get("Authorization") ?? "none");
			return new Response(JSON.stringify({ user: { id: "1" } }), {
				status: 200,
			});
		}) as unknown as typeof fetch;

		const { authenticatedFetch, tokenStore } = makeClient(spy);
		tokenStore.setToken("token-abc");
		await authenticatedFetch("/auth/me");
		expect(seen[0]).toBe("Bearer token-abc");
	});

	it("omits the Authorization header when no token is stored", async () => {
		const seen: string[] = [];
		const spy = (async (_url: string, init: RequestInit = {}) => {
			seen.push(new Headers(init.headers).get("Authorization") ?? "none");
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		const { authenticatedFetch } = makeClient(spy);
		await authenticatedFetch("/auth/me");
		expect(seen[0]).toBe("none");
	});
});

describe("token refresh middleware", () => {
	it("refreshes on a 401 and replays the original request", async () => {
		const calls: string[] = [];
		const scripted = (async (url: string, init: RequestInit = {}) => {
			const path = String(url);
			const authz = new Headers(init.headers).get("Authorization");
			calls.push(path);
			if (path.endsWith("/auth/refresh")) {
				return new Response(
					JSON.stringify({ token: "fresh", refreshToken: "refresh-2" }),
					{ status: 200 },
				);
			}
			if (path.endsWith("/auth/me")) {
				return new Response(JSON.stringify({ user: { id: "1" } }), {
					status: authz === "Bearer fresh" ? 200 : 401,
				});
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;

		const { authenticatedFetch, tokenStore } = makeClient(scripted);
		tokenStore.setTokens({ accessToken: "stale", refreshToken: "refresh-1" });

		const res = await authenticatedFetch("/auth/me");
		expect(res.status).toBe(200);
		expect(tokenStore.getToken()).toBe("fresh");
		expect(tokenStore.getRefreshToken()).toBe("refresh-2");
		expect(calls).toContain("/auth/refresh");
	});

	it("clears tokens and calls onUnauthorized when refresh fails", async () => {
		const onUnauthorized = vi.fn();
		const scripted = (async (url: string) => {
			if (String(url).endsWith("/auth/refresh")) {
				return new Response(JSON.stringify(apiError("invalid_grant")), {
					status: 401,
				});
			}
			return new Response(JSON.stringify(apiError("unauthorized")), {
				status: 401,
			});
		}) as unknown as typeof fetch;

		const { authenticatedFetch, tokenStore } = makeClient(scripted, {
			onUnauthorized,
		});
		tokenStore.setTokens({ accessToken: "stale", refreshToken: "bad" });

		const res = await authenticatedFetch("/auth/me");
		expect(res.status).toBe(401);
		expect(onUnauthorized).toHaveBeenCalledTimes(1);
		expect(tokenStore.getToken()).toBeNull();
		expect(tokenStore.getRefreshToken()).toBeNull();
	});

	it("never triggers refresh for the login endpoint itself", async () => {
		const calls: string[] = [];
		const scripted = (async (url: string) => {
			calls.push(String(url));
			return new Response(JSON.stringify(apiError("invalid_credentials")), {
				status: 401,
			});
		}) as unknown as typeof fetch;

		const { authenticatedFetch, tokenStore } = makeClient(scripted);
		tokenStore.setTokens({ accessToken: "x", refreshToken: "present" });

		const res = await authenticatedFetch("/auth/login", { method: "POST" });
		expect(res.status).toBe(401);
		expect(calls).not.toContain("/auth/refresh");
	});
});

describe("resilience: retry and timeout", () => {
	it("retries transient 5xx responses then succeeds", async () => {
		let attempts = 0;
		const flaky = (async () => {
			attempts += 1;
			if (attempts < 3) return new Response("{}", { status: 503 });
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}) as unknown as typeof fetch;

		const { authenticatedFetch } = makeClient(flaky, {
			config: { maxRetries: 3 },
		});
		const res = await authenticatedFetch("/data");
		expect(res.status).toBe(200);
		expect(attempts).toBe(3);
	});

	it("stops retrying after maxRetries and returns the last 5xx", async () => {
		let attempts = 0;
		const alwaysDown = (async () => {
			attempts += 1;
			return new Response("{}", { status: 500 });
		}) as unknown as typeof fetch;

		const { authenticatedFetch } = makeClient(alwaysDown, {
			config: { maxRetries: 2 },
		});
		const res = await authenticatedFetch("/data");
		expect(res.status).toBe(500);
		expect(attempts).toBe(3); // initial + 2 retries
	});

	it("aborts a request that exceeds the configured timeout", async () => {
		const hangs = (async (_url: string, init: RequestInit = {}) => {
			return new Promise<Response>((_resolve, reject) => {
				const signal = init.signal;
				if (signal) {
					signal.addEventListener("abort", () =>
						reject(signal.reason ?? new Error("aborted")),
					);
				}
			});
		}) as unknown as typeof fetch;

		const { authenticatedFetch } = makeClient(hangs, {
			config: { requestTimeoutMs: 10, maxRetries: 0 },
		});
		await expect(authenticatedFetch("/slow")).rejects.toThrow(/timed out/i);
	});
});

describe("error handling via the typed client", () => {
	it("rejects invalid credentials with a 401 AuthApiError", async () => {
		const { apiClient } = makeClient(createMockFetch() as typeof fetch);
		await expect(
			apiClient.post("/auth/login", {
				email: SEED_EMAIL,
				password: "wrong-password",
			}),
		).rejects.toBeInstanceOf(AuthApiError);
	});

	it("rejects duplicate signup with a 409", async () => {
		const { apiClient } = makeClient(createMockFetch() as typeof fetch);
		await expect(
			apiClient.post("/auth/signup", {
				email: SEED_EMAIL,
				password: SEED_PASSWORD,
			}),
		).rejects.toMatchObject({ status: 409 });
	});

	it("surfaces an unknown endpoint as a 404", async () => {
		const { apiClient } = makeClient(createMockFetch() as typeof fetch);
		await expect(apiClient.get("/auth/nope")).rejects.toMatchObject({
			status: 404,
		});
	});
});

describe("token-store isolation", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps the access and refresh tokens independently addressable", () => {
		const storage = createMemoryStorage();
		const store = createTokenStore("access_k", "refresh_k", storage);
		store.setTokens({ accessToken: "a1", refreshToken: "r1" });
		expect(store.getToken()).toBe("a1");
		expect(store.getRefreshToken()).toBe("r1");
		store.clearToken();
		expect(store.getToken()).toBeNull();
		expect(store.getRefreshToken()).toBe("r1");
		store.clear();
		expect(store.getRefreshToken()).toBeNull();
	});
});
