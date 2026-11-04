import { AuthApiError } from "@onlooker/auth-core";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactAuth, type StorageEventTarget } from "./index";

/**
 * A session check that fails for any reason but a 401 keeps the session and
 * retries (ONL-243). These drive the real provider with a fake loadSession
 * and fake timers. The token is opaque ("tok"), so its expiry is unknown and
 * no auto-refresh timer is scheduled underneath the tests.
 */

const USER = { id: "u1" };

function rateLimited(retryAfterMs?: number) {
	return new AuthApiError(
		429,
		"rate_limited",
		"Too many requests",
		undefined,
		retryAfterMs,
	);
}

function harness(options: {
	loadSession: () => Promise<{ user: typeof USER }>;
	refreshSession?: () => Promise<{ user: typeof USER }>;
	storageEventTarget?: StorageEventTarget | null;
}) {
	let token: string | null = "tok";
	const onLogoutCleanup = vi.fn();
	const auth = createReactAuth<typeof USER, Record<string, unknown>>({
		tokenStorage: {
			getToken: () => token,
			setToken: (next) => {
				token = next;
			},
			clearToken: () => {
				token = null;
			},
		},
		initialState: {},
		loadSession: options.loadSession,
		refreshSession: options.refreshSession,
		login: async () => ({ token: "", user: USER }),
		signup: async () => ({ token: "", user: USER }),
		onLogoutCleanup,
		tokenStorageKey: "auth_token",
		storageEventTarget: options.storageEventTarget ?? null,
	});

	let latest: ReturnType<typeof auth.useAuth> | undefined;
	function Probe() {
		latest = auth.useAuth();
		return null;
	}

	return {
		auth,
		onLogoutCleanup,
		token: () => token,
		clearStoredToken: () => {
			token = null;
		},
		state: () => {
			if (!latest) throw new Error("not rendered");
			return latest;
		},
		renderProbe: () =>
			render(
				<auth.AuthProvider>
					<Probe />
				</auth.AuthProvider>,
			),
	};
}

/** Let pending promises and zero-delay timers settle. */
async function flush() {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
}

async function advance(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("hydrating on page load", () => {
	it("signs out on a 401", async () => {
		const h = harness({
			loadSession: vi
				.fn()
				.mockRejectedValue(new AuthApiError(401, "unauthorized", "x")),
		});
		h.renderProbe();
		await flush();

		expect(h.token()).toBeNull();
		expect(h.onLogoutCleanup).toHaveBeenCalled();
		expect(h.state().user).toBeNull();
		expect(h.state().unavailable).toBeNull();
		expect(h.state().loading).toBe(false);
	});

	it("keeps the session on a 429 and retries after Retry-After", async () => {
		const loadSession = vi
			.fn()
			.mockRejectedValueOnce(rateLimited(30_000))
			.mockResolvedValue({ user: USER });
		const h = harness({ loadSession });
		h.renderProbe();
		await flush();

		expect(h.token()).toBe("tok");
		expect(h.onLogoutCleanup).not.toHaveBeenCalled();
		expect(h.state().loading).toBe(false);
		expect(h.state().unavailable).toEqual({ retryAt: 30_000 });

		await advance(29_999);
		expect(loadSession).toHaveBeenCalledTimes(1);
		await advance(1);
		expect(loadSession).toHaveBeenCalledTimes(2);
		expect(h.state().user).toEqual(USER);
		expect(h.state().unavailable).toBeNull();
	});

	it("backs off when the failure carries no Retry-After", async () => {
		const h = harness({
			loadSession: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
		});
		h.renderProbe();
		await flush();

		expect(h.state().unavailable).toEqual({ retryAt: 5_000 });
	});

	it("backs off 5, 10, 20, 40, 60, then 60 seconds", async () => {
		const h = harness({
			loadSession: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
		});
		h.renderProbe();
		await flush();

		const waits: number[] = [];
		for (let i = 0; i < 6; i++) {
			const wait = (h.state().unavailable?.retryAt ?? 0) - Date.now();
			waits.push(wait);
			await advance(wait);
		}
		expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
	});

	it("signs out when the failure leaves no token behind", async () => {
		let h: ReturnType<typeof harness>;
		const loadSession = vi.fn(async () => {
			h.clearStoredToken();
			throw new Error("Session refresh failed");
		});
		h = harness({ loadSession });
		h.renderProbe();
		await flush();

		expect(h.state().unavailable).toBeNull();
		expect(h.onLogoutCleanup).toHaveBeenCalled();
		await advance(60_000);
		expect(loadSession).toHaveBeenCalledTimes(1);
	});

	it("retries at once on retrySession, and drops the scheduled retry", async () => {
		const loadSession = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValue({ user: USER });
		const h = harness({ loadSession });
		h.renderProbe();
		await flush();

		await act(async () => {
			h.state().retrySession();
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(loadSession).toHaveBeenCalledTimes(2);
		expect(h.state().user).toEqual(USER);

		await advance(5_000);
		expect(loadSession).toHaveBeenCalledTimes(2);
	});
});

describe("the proactive refresh", () => {
	it("keeps a signed-in person signed in on a 429, and retries", async () => {
		const refreshSession = vi
			.fn()
			.mockRejectedValueOnce(rateLimited(10_000))
			.mockResolvedValue({ user: USER });
		const h = harness({
			loadSession: vi.fn().mockResolvedValue({ user: USER }),
			refreshSession,
		});
		h.renderProbe();
		await flush();

		await act(async () => {
			await h.state().refresh();
		});
		expect(h.state().user).toEqual(USER);
		expect(h.token()).toBe("tok");
		expect(h.state().unavailable).toBeNull();

		await advance(10_000);
		expect(refreshSession).toHaveBeenCalledTimes(2);
		expect(h.state().user).toEqual(USER);
	});

	it("signs out on a 401", async () => {
		const h = harness({
			loadSession: vi.fn().mockResolvedValue({ user: USER }),
			refreshSession: vi
				.fn()
				.mockRejectedValue(new AuthApiError(401, "unauthorized", "x")),
		});
		h.renderProbe();
		await flush();

		await act(async () => {
			await h.state().refresh();
		});
		expect(h.state().user).toBeNull();
		expect(h.token()).toBeNull();
	});
});

describe("re-hydrating when another tab changes the token", () => {
	it("keeps the session on a transient failure and retries", async () => {
		let listener: ((event: StorageEvent) => void) | undefined;
		const target: StorageEventTarget = {
			addEventListener: (_type, l) => {
				listener = l;
			},
			removeEventListener: () => {},
		};
		const loadSession = vi
			.fn()
			.mockResolvedValueOnce({ user: USER })
			.mockRejectedValueOnce(new AuthApiError(503, "unavailable", "x"))
			.mockResolvedValue({ user: USER });
		const h = harness({ loadSession, storageEventTarget: target });
		h.renderProbe();
		await flush();

		await act(async () => {
			listener?.(new StorageEvent("storage", { key: "auth_token" }));
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(h.token()).toBe("tok");
		expect(h.state().user).toEqual(USER);
		expect(h.onLogoutCleanup).not.toHaveBeenCalled();

		await advance(5_000);
		expect(loadSession).toHaveBeenCalledTimes(3);
	});

	it("forgets a pending refresh retry when another tab signs out", async () => {
		let listener: ((event: StorageEvent) => void) | undefined;
		const target: StorageEventTarget = {
			addEventListener: (_type, l) => {
				listener = l;
			},
			removeEventListener: () => {},
		};
		const refreshSession = vi
			.fn()
			.mockRejectedValueOnce(rateLimited(10_000))
			.mockRejectedValue(new TypeError("Failed to fetch"));
		const h = harness({
			loadSession: vi.fn().mockResolvedValue({ user: USER }),
			refreshSession,
			storageEventTarget: target,
		});
		h.renderProbe();
		await flush();

		await act(async () => {
			await h.state().refresh();
		});
		expect(refreshSession).toHaveBeenCalledTimes(1);

		await act(async () => {
			h.clearStoredToken();
			listener?.(new StorageEvent("storage", { key: "auth_token" }));
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(h.state().user).toBeNull();

		await advance(60_000);
		expect(refreshSession).toHaveBeenCalledTimes(1);
		expect(h.onLogoutCleanup).toHaveBeenCalledTimes(1);
	});
});

describe("RequireAuth while the session is unreachable", () => {
	function renderGuard(
		h: ReturnType<typeof harness>,
		props: {
			loadingFallback?: React.ReactNode;
			unavailableFallback?: (s: {
				retryAt: number;
				retry: () => void;
			}) => React.ReactNode;
		},
	) {
		return render(
			<MemoryRouter initialEntries={["/"]}>
				<h.auth.AuthProvider>
					<Routes>
						<Route
							path="/"
							element={
								<h.auth.RequireAuth {...props}>
									<p>the app</p>
								</h.auth.RequireAuth>
							}
						/>
						<Route path="/login" element={<p>the login page</p>} />
					</Routes>
				</h.auth.AuthProvider>
			</MemoryRouter>,
		);
	}

	it("renders the unavailable fallback, not a redirect", async () => {
		const h = harness({
			loadSession: vi.fn().mockRejectedValue(rateLimited(30_000)),
		});
		renderGuard(h, {
			unavailableFallback: ({ retryAt }) => <p>unreachable until {retryAt}</p>,
		});
		await flush();

		expect(screen.getByText("unreachable until 30000")).toBeDefined();
		expect(screen.queryByText("the login page")).toBeNull();
	});

	it("falls back to the loading fallback when no unavailable one is given", async () => {
		const h = harness({
			loadSession: vi.fn().mockRejectedValue(rateLimited(30_000)),
		});
		renderGuard(h, { loadingFallback: <p>loading…</p> });
		await flush();

		expect(screen.getByText("loading…")).toBeDefined();
		expect(screen.queryByText("the login page")).toBeNull();
	});

	it("still redirects to login when the session is gone", async () => {
		const h = harness({
			loadSession: vi
				.fn()
				.mockRejectedValue(new AuthApiError(401, "unauthorized", "x")),
		});
		renderGuard(h, { unavailableFallback: () => <p>unreachable</p> });
		await flush();

		expect(screen.getByText("the login page")).toBeDefined();
	});
});
