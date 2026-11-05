import { createReactAuth } from "@onlooker/auth-react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../api/client";
import type { ApiConfig } from "../api/config";
import { createTokenStore } from "../api/tokenStore";

/**
 * ONL-247. Each half of the unreachable-session path is tested alone: the
 * client turning a refresh 429 into a session_unavailable 503, and auth-react
 * keeping the session on a 503 and retrying. This drives both together, with
 * only fetch stubbed, so the Retry-After has to survive the hand-off.
 */

const USER = { id: "u1", email: "someone@example.com" };

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

const config: ApiConfig = {
	baseUrl: "",
	useMockApi: false,
	requestTimeoutMs: 0,
	maxRetries: 0,
	retryBaseDelayMs: 0,
	retryMaxDelayMs: 0,
	tokenStorageKey: "auth_token",
	refreshTokenStorageKey: "auth_refresh_token",
	logRequests: false,
};

function json(status: number, body: unknown, headers?: Record<string, string>) {
	return new Response(JSON.stringify(body), { status, headers });
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a 401 whose refresh is rate limited", () => {
	it("keeps the session, waits the refresh's Retry-After, then signs in", async () => {
		const store = createTokenStore(
			config.tokenStorageKey,
			config.refreshTokenStorageKey,
			memoryStorage(),
		);
		store.setTokens({ accessToken: "old", refreshToken: "rt-ok" });

		let meCalls = 0;
		const baseFetch = vi.fn(async (url: string) => {
			if (url.endsWith("/auth/refresh")) {
				return json(
					429,
					{ success: false, error: { code: "rate_limited", message: "x" } },
					{ "Retry-After": "30" },
				);
			}
			meCalls += 1;
			return meCalls === 1
				? json(401, {
						success: false,
						error: { code: "unauthorized", message: "x" },
					})
				: json(200, { user: USER });
		});

		const { apiClient } = createApiClient({
			config,
			tokenStore: store,
			baseFetch: baseFetch as unknown as typeof fetch,
		});

		const auth = createReactAuth<typeof USER, Record<string, unknown>>({
			tokenStorage: store,
			initialState: {},
			loadSession: async () => {
				const { user } = await apiClient.get<{ user: typeof USER }>("/auth/me");
				return { user };
			},
			login: async () => ({ token: "", user: USER }),
			signup: async () => ({ token: "", user: USER }),
			onLogoutCleanup: () => store.clear(),
			tokenStorageKey: config.tokenStorageKey,
			storageEventTarget: null,
		});

		let latest: ReturnType<typeof auth.useAuth> | undefined;
		function Probe() {
			latest = auth.useAuth();
			return null;
		}
		render(
			<auth.AuthProvider>
				<Probe />
			</auth.AuthProvider>,
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		expect(latest?.user).toBeNull();
		expect(latest?.unavailable).toEqual({ retryAt: 30_000 });
		expect(store.getToken()).toBe("old");
		expect(store.getRefreshToken()).toBe("rt-ok");

		await act(async () => {
			await vi.advanceTimersByTimeAsync(29_000);
		});
		expect(meCalls).toBe(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
		expect(meCalls).toBe(2);
		expect(latest?.user).toEqual(USER);
		expect(latest?.unavailable).toBeNull();
	});
});
