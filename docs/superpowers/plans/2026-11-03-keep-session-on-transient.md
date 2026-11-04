# Keep the Session on a Transient Failure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web app signs a person out only when the server says the
session is gone (401). A 429, a 5xx or a network failure keeps the tokens,
shows a can't-reach notice on page load, and retries.

**Architecture:**
- The API exposes `Retry-After` through CORS.
- `auth-core`'s `AuthApiError` carries `retryAfterMs`.
- `auth-react` gains pure helpers (`isSessionGone`, `retryDelayMs`,
  `parseRetryAfter`), an `unavailable` state with one retry timer shared by
  hydrate, proactive refresh and cross-tab re-hydrate, and an
  `unavailableFallback` on `RequireAuth`.
- The web client stops clearing tokens on a transient refresh failure. The app
  renders the notice.

**Tech Stack:** React 18, react-router-dom, vitest with jsdom and
@testing-library/react (`packages/auth-react`, `apps/web`), vitest with
`@cloudflare/vitest-pool-workers` (`apps/api`), TypeScript, Biome.

**Spec:** `docs/superpowers/specs/2026-11-03-keep-session-on-transient-design.md`.

## Global Constraints

- **The rule:** 401 means the session is gone. A 400 from `/auth/refresh` also
  means gone. Anything else (429, 5xx, a network failure, a timeout) is
  transient. A failure that leaves no access token stored is a sign-out,
  whatever was thrown.
- **Retry delay:** `Retry-After` when the server sent one. Otherwise a backoff
  of `[5000, 10000, 20000, 40000, 60000]` ms, then 60000 thereafter. The count
  resets after a success, a sign-out or a logout.
- **Copy:** "Can't reach Onlooker right now." then "Trying again in N s." (or
  "Trying again…" at 0), and a button labeled "Try again". The status is
  `role="status"` and `aria-live="polite"`.
- **Synthesized response:** when a request 401s and the refresh fails
  transiently, the web client answers 503 with body
  `{ success: false, error: { code: "session_unavailable", message: "Can't reach Onlooker right now." } }`.
- **The CORS header:** `Access-Control-Expose-Headers: Retry-After`, on both
  `withCors` branches and not on preflight responses.
- **Test commands:**
  - One file: `pnpm --filter <pkg> test <name>`, with **no `--`**.
  - Packages: `@onlooker/api`, `@onlooker/auth-core`, `@onlooker/auth-react`,
    `@onlooker/web`.
- **Edits:** tracked files with Edit/Write only. No `sed -i`, heredocs,
  `biome format --write` or `lint:fix`, because the lineage hooks observe tool
  calls. Fix Biome formatting by hand to match the diff it prints.
- **Test fixtures:** keep quoted token values in tests under 8 characters.
  The repo's secret-scanning hook blocks a write containing a longer one.
- **Commits:** `<type>(<scope>): <subject> :emoji:`, American English, a
  why-focused body, ending `Refs ONL-243`. The `/git-workflow:commit` skill is
  the route, and a subagent without it mirrors the contract.
- **Package resolution:** `apps/web` and `packages/auth-react` import
  `@onlooker/auth-core` by workspace. Check whether consumers need `dist`
  rebuilt by running the consumer's tests. If they fail to see a new field,
  run `pnpm --filter @onlooker/auth-core build` and say so in the report.

---

### Task 1: Expose Retry-After through CORS

**Files:**
- Modify: `apps/api/src/middleware/cors.ts`, `withCors` (about lines 99–122)
  and a new constant beside `ALLOW_METHODS`
- Test: `apps/api/src/middleware/cors.test.ts`

**Interfaces:**
- Produces: browsers on the app origins, and any origin for `cors: "any"`
  routes, can read `Retry-After` on real responses.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/middleware/cors.test.ts`, inside `describe("withCors", ...)`:

```ts
	// A cross-origin page can read only the CORS-safelisted response headers
	// unless the server names more. Retry-After isn't safelisted, so without
	// this the web app read null for it on every 429 (ONL-243).
	it("exposes Retry-After to an allowed origin", () => {
		const res = withCors(
			new Response("slow down", { status: 429, headers: { "Retry-After": "60" } }),
			request(PRODUCTION),
			env(PRODUCTION),
		);

		expect(res.headers.get("Access-Control-Expose-Headers")).toBe("Retry-After");
	});

	it("exposes Retry-After on the public posture too", () => {
		const res = withCors(
			new Response("ok"),
			request("https://elsewhere.example"),
			env(PRODUCTION),
			"any",
		);

		expect(res.headers.get("Access-Control-Expose-Headers")).toBe("Retry-After");
	});

	it("exposes nothing to an origin that is not on the list", () => {
		const res = withCors(
			new Response("ok"),
			request("https://evil.example"),
			env(PRODUCTION),
		);

		expect(res.headers.get("Access-Control-Expose-Headers")).toBeNull();
	});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @onlooker/api test cors`
Expected: the first two FAIL (header is null). The third passes.

- [ ] **Step 3: Implement**

In `apps/api/src/middleware/cors.ts`, beside the other header constants
(`ALLOW_METHODS`, `ALLOW_HEADERS`), add:

```ts
/**
 * Response headers a cross-origin caller may read beyond the safelisted ones.
 * Retry-After is the one the web app acts on: the login backoff, the mail
 * caps and the per-account limit all answer 429 with it, and without this the
 * browser hands the page null (ONL-243). Not sent on preflight, where it means
 * nothing.
 */
const EXPOSE_HEADERS = "Retry-After";
```

In `withCors`, add
`response.headers.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);` in
two places: in the `cors === "any"` branch after the `Allow-Headers` line, and
inside `if (origin) { ... }` after the `Allow-Headers` line. Leave
`preflightResponse` unchanged.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @onlooker/api test cors`
Expected: PASS.

Run: `pnpm --filter @onlooker/api typecheck && pnpm --filter @onlooker/api lint`
Expected: pass. Fix Biome formatting by hand if it complains, for example
about the long `new Response(...)` line.

- [ ] **Step 5: Commit**

Commit `apps/api/src/middleware/cors.ts` and
`apps/api/src/middleware/cors.test.ts`:

```text
fix(api): let the browser read Retry-After :eyes:

Retry-After isn't a CORS-safelisted header, and the API never named it, so
the web app read null on every 429: the login backoff, the mail caps and
the new account limit all told it how long to wait and it couldn't hear.

Refs ONL-243
```

---

### Task 2: Carry Retry-After into the error, and the transient helpers

**Files:**
- Modify: `packages/auth-core/src/index.ts`, `AuthApiError` (about lines 111–126)
- Test: `packages/auth-core/src/index.test.ts`
- Create: `packages/auth-react/src/transient.ts`
- Create: `packages/auth-react/src/transient.test.ts`
- Modify: `packages/auth-react/src/index.tsx`, the `!response.ok` branch of
  `createAuthApiClient`'s `request` (about lines 102–121), plus exports at the
  end of the file
- Test: `packages/auth-react/src/api-client.test.ts`

**Interfaces:**
- Produces:
  - `AuthApiError(status, code, message, details?, retryAfterMs?)`, with
    `readonly retryAfterMs?: number`.
  - From `packages/auth-react/src/transient.ts`:
    - `RETRY_BACKOFF_MS: readonly number[]`
    - `isSessionGone(error: unknown): boolean`
    - `retryDelayMs(error: unknown, failures: number): number`
    - `parseRetryAfter(header: string | null, now: number): number | undefined`
  - `createAuthApiClient` sets `retryAfterMs` on non-401 errors.

- [ ] **Step 1: Write the failing auth-core test**

Add to `packages/auth-core/src/index.test.ts`, inside
`describe("AuthApiError", ...)`:

```ts
		it("carries retryAfterMs when given one", () => {
			const error = new AuthApiError(429, "rate_limited", "Slow down", undefined, 60_000);
			expect(error.retryAfterMs).toBe(60_000);
		});

		it("leaves retryAfterMs undefined by default", () => {
			const error = new AuthApiError(500, "internal_error", "Oops");
			expect(error.retryAfterMs).toBeUndefined();
		});
```

- [ ] **Step 2: Write the failing auth-react tests**

Create `packages/auth-react/src/transient.test.ts`:

```ts
import { AuthApiError } from "@onlooker/auth-core";
import { describe, expect, it } from "vitest";
import {
	isSessionGone,
	parseRetryAfter,
	RETRY_BACKOFF_MS,
	retryDelayMs,
} from "./transient";

describe("isSessionGone", () => {
	it("is true only for a 401", () => {
		expect(isSessionGone(new AuthApiError(401, "unauthorized", "x"))).toBe(true);
		for (const status of [400, 403, 429, 500, 503]) {
			expect(isSessionGone(new AuthApiError(status, "x", "x"))).toBe(false);
		}
	});

	it("treats a thrown non-API error as transient", () => {
		expect(isSessionGone(new TypeError("Failed to fetch"))).toBe(false);
		expect(isSessionGone(new Error("Session refresh failed"))).toBe(false);
		expect(isSessionGone(undefined)).toBe(false);
	});
});

describe("retryDelayMs", () => {
	it("uses the server's Retry-After when the error carries one", () => {
		const error = new AuthApiError(429, "rate_limited", "x", undefined, 30_000);
		expect(retryDelayMs(error, 0)).toBe(30_000);
		expect(retryDelayMs(error, 4)).toBe(30_000);
	});

	it("backs off 5, 10, 20, 40, then 60 seconds, capped", () => {
		const error = new TypeError("Failed to fetch");
		expect([0, 1, 2, 3, 4, 5, 9].map((n) => retryDelayMs(error, n))).toEqual([
			5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000,
		]);
		expect(RETRY_BACKOFF_MS).toEqual([5_000, 10_000, 20_000, 40_000, 60_000]);
	});
});

describe("parseRetryAfter", () => {
	it("reads delta-seconds", () => {
		expect(parseRetryAfter("60", 0)).toBe(60_000);
		expect(parseRetryAfter(" 2 ", 0)).toBe(2_000);
	});

	it("reads an HTTP date relative to now", () => {
		const now = Date.parse("2026-11-03T12:00:00Z");
		expect(parseRetryAfter("Tue, 03 Nov 2026 12:00:30 GMT", now)).toBe(30_000);
	});

	it("never answers a negative wait", () => {
		expect(parseRetryAfter("-5", 0)).toBe(0);
		const now = Date.parse("2026-11-03T12:00:00Z");
		expect(parseRetryAfter("Tue, 03 Nov 2026 11:00:00 GMT", now)).toBe(0);
	});

	it("is undefined for a missing, empty or unreadable header", () => {
		expect(parseRetryAfter(null, 0)).toBeUndefined();
		expect(parseRetryAfter("", 0)).toBeUndefined();
		expect(parseRetryAfter("soon", 0)).toBeUndefined();
	});
});
```

Add to `packages/auth-react/src/api-client.test.ts`:

```ts
describe("Retry-After", () => {
	it("carries the server's Retry-After on a refused request", async () => {
		const client = createAuthApiClient({
			baseUrl: "https://api.test",
			tokenStorage: noStorage,
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						success: false,
						error: { code: "rate_limited", message: "Too many requests" },
					}),
					{
						status: 429,
						headers: { "Content-Type": "application/json", "Retry-After": "60" },
					},
				),
		});

		await expect(client.get("/auth/me")).rejects.toMatchObject({
			status: 429,
			code: "rate_limited",
			retryAfterMs: 60_000,
		});
	});

	it("leaves it undefined when the server sent none", async () => {
		const client = createAuthApiClient({
			baseUrl: "https://api.test",
			tokenStorage: noStorage,
			fetchImpl: async () => new Response("{}", { status: 503 }),
		});

		const error = await client.get("/auth/me").catch((e) => e);
		expect(error.status).toBe(503);
		expect(error.retryAfterMs).toBeUndefined();
	});
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @onlooker/auth-core test index` and
`pnpm --filter @onlooker/auth-react test transient` and
`pnpm --filter @onlooker/auth-react test api-client`
Expected: FAIL. The field is missing, and `./transient` doesn't exist.

- [ ] **Step 4: Implement**

In `packages/auth-core/src/index.ts`, make `AuthApiError`:

```ts
export class AuthApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: unknown;
	/**
	 * How long the server asked the caller to wait, from Retry-After, when it
	 * sent one. Read by auth-react to schedule a retry instead of signing the
	 * person out (ONL-243).
	 */
	readonly retryAfterMs?: number;

	constructor(
		status: number,
		code: string,
		message: string,
		details?: unknown,
		retryAfterMs?: number,
	) {
		super(message);
		this.name = "AuthApiError";
		this.status = status;
		this.code = code;
		this.details = details;
		this.retryAfterMs = retryAfterMs;
	}
}
```

Keep whatever doc comment sits above the class.

Create `packages/auth-react/src/transient.ts`:

```ts
import { AuthApiError } from "@onlooker/auth-core";

/**
 * When a session check fails, whether the session is gone or only
 * unreachable for now (ONL-243).
 *
 * Only a 401 says the server no longer recognizes the session. A 429, a 5xx,
 * a network failure or a timeout says nothing about the session at all, and
 * signing someone out over one threw away a refresh token that still worked.
 */

/** Waits between retries when the server gave no Retry-After. */
export const RETRY_BACKOFF_MS: readonly number[] = [
	5_000, 10_000, 20_000, 40_000, 60_000,
];

export function isSessionGone(error: unknown): boolean {
	return error instanceof AuthApiError && error.status === 401;
}

/** The server's Retry-After when it sent one, otherwise the backoff. */
export function retryDelayMs(error: unknown, failures: number): number {
	if (error instanceof AuthApiError && error.retryAfterMs !== undefined) {
		return error.retryAfterMs;
	}
	return RETRY_BACKOFF_MS[Math.min(failures, RETRY_BACKOFF_MS.length - 1)];
}

/**
 * Retry-After as milliseconds from `now`: delta-seconds or an HTTP date.
 * Undefined when the header is missing or unreadable, and never negative.
 */
export function parseRetryAfter(
	header: string | null,
	now: number,
): number | undefined {
	if (header === null) return undefined;
	const value = header.trim();
	if (value === "") return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(value);
	if (!Number.isNaN(date)) return Math.max(0, date - now);
	return undefined;
}
```

In `packages/auth-react/src/index.tsx`, add near the top imports:

```ts
import { parseRetryAfter } from "./transient";
```

In `createAuthApiClient`'s `request`, change the `throw new AuthApiError(` in
the `!response.ok` branch to pass a fifth argument after
`envelope.error?.details`:

```ts
				envelope.error?.details,
				parseRetryAfter(response.headers.get("Retry-After"), Date.now()),
```

At the end of the file, beside the other re-exports, add:

```ts
export {
	isSessionGone,
	parseRetryAfter,
	RETRY_BACKOFF_MS,
	retryDelayMs,
} from "./transient";
```

- [ ] **Step 5: Run the tests**

Run the three commands from Step 3.
Expected: PASS. If auth-react's tests can't see `retryAfterMs`, follow the
"Package resolution" constraint.

Run: `pnpm --filter @onlooker/auth-core test && pnpm --filter @onlooker/auth-react test && pnpm --filter @onlooker/auth-core typecheck && pnpm --filter @onlooker/auth-react typecheck`
Expected: pass. Check each package's `package.json` for the exact script
names. If `typecheck` isn't defined, use what is (for example `build`).

- [ ] **Step 6: Commit**

Commit `packages/auth-core/src/index.ts`, `packages/auth-core/src/index.test.ts`,
`packages/auth-react/src/transient.ts`, `packages/auth-react/src/transient.test.ts`,
`packages/auth-react/src/index.tsx` and `packages/auth-react/src/api-client.test.ts`:

```text
feat(auth): tell a gone session from an unreachable one :mag:

Every session check treated any failure as a sign-out. These are the pieces
the next change needs to stop doing that: a predicate that only a 401 means
gone, the server's Retry-After carried on the error, and the backoff to use
when there isn't one.

Refs ONL-243
```

---

### Task 3: Keep the session, retry, and render the unavailable state

**Files:**
- Modify: `packages/auth-react/src/index.tsx`, `useAuthState` and
  `RequireAuth`
- Create: `packages/auth-react/src/session-resilience.test.tsx`

**Interfaces:**
- Consumes: `isSessionGone`, `retryDelayMs` from `./transient` (Task 2).
- Produces:
  - `ReactAuthState` gains `unavailable: { retryAt: number } | null` and
    `retrySession: () => void`.
  - `RequireAuth` gains
    `unavailableFallback?: (state: { retryAt: number; retry: () => void }) => ReactNode`.

- [ ] **Step 1: Write the failing tests**

Create `packages/auth-react/src/session-resilience.test.tsx`:

```tsx
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
	return new AuthApiError(429, "rate_limited", "Too many requests", undefined, retryAfterMs);
}

function harness(
	options: {
		loadSession: () => Promise<{ user: typeof USER }>;
		refreshSession?: () => Promise<{ user: typeof USER }>;
		storageEventTarget?: StorageEventTarget | null;
	},
) {
	let token: string | null = "tok";
	const onLogoutCleanup = vi.fn();
	const auth = createReactAuth<typeof USER, Record<string, never>>({
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
			loadSession: vi.fn().mockRejectedValue(new AuthApiError(401, "unauthorized", "x")),
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
});

describe("RequireAuth while the session is unreachable", () => {
	function renderGuard(
		h: ReturnType<typeof harness>,
		props: {
			loadingFallback?: React.ReactNode;
			unavailableFallback?: (s: { retryAt: number; retry: () => void }) => React.ReactNode;
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
		const h = harness({ loadSession: vi.fn().mockRejectedValue(rateLimited(30_000)) });
		renderGuard(h, {
			unavailableFallback: ({ retryAt }) => <p>unreachable until {retryAt}</p>,
		});
		await flush();

		expect(screen.getByText("unreachable until 30000")).toBeDefined();
		expect(screen.queryByText("the login page")).toBeNull();
	});

	it("falls back to the loading fallback when no unavailable one is given", async () => {
		const h = harness({ loadSession: vi.fn().mockRejectedValue(rateLimited(30_000)) });
		renderGuard(h, { loadingFallback: <p>loading…</p> });
		await flush();

		expect(screen.getByText("loading…")).toBeDefined();
		expect(screen.queryByText("the login page")).toBeNull();
	});

	it("still redirects to login when the session is gone", async () => {
		const h = harness({
			loadSession: vi.fn().mockRejectedValue(new AuthApiError(401, "unauthorized", "x")),
		});
		renderGuard(h, { unavailableFallback: () => <p>unreachable</p> });
		await flush();

		expect(screen.getByText("the login page")).toBeDefined();
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @onlooker/auth-react test session-resilience`
Expected: FAIL. The transient cases sign out, `unavailable` is undefined, and
`retrySession` isn't a function.

- [ ] **Step 3: Implement in `packages/auth-react/src/index.tsx`**

**Imports.** Add `useRef` to the `react` import in the factory section, and
add `isSessionGone, retryDelayMs` to the `./transient` import from Task 2.

**Types.** In `ReactAuthState`, add after `sessionExpiringSoon`:

```ts
	/**
	 * Set when the last session check failed for a reason other than a 401
	 * and a retry is scheduled. The tokens are kept; RequireAuth renders its
	 * unavailableFallback instead of redirecting (ONL-243).
	 */
	unavailable: { retryAt: number } | null;
```

Then add `retrySession: () => void;` to the action block beside `refresh`.

**State.** In `useAuthState`'s initial state, `applySession` and `resetState`,
add `unavailable: null` beside `error: null`.

**Retry machinery.** Add it after `resetState`, before `performLogout`:

```ts
		// --- ONL-243: a session that is unreachable, not gone -------------------
		// One timer for hydrate, the proactive refresh and the cross-tab
		// re-hydrate: whichever retry is pending, a newer one supersedes it.
		const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
		const failures = useRef(0);
		const mounted = useRef(true);

		const clearRetry = useCallback(() => {
			if (retryTimer.current) {
				clearTimeout(retryTimer.current);
				retryTimer.current = null;
			}
		}, []);

		useEffect(() => {
			mounted.current = true;
			return () => {
				mounted.current = false;
				clearRetry();
			};
		}, [clearRetry]);

		// A failure that leaves no token behind is a sign-out, whatever was
		// thrown: the web app's refreshSession throws a plain Error both when the
		// refresh was rejected (and it cleared the tokens) and when it was only
		// unreachable.
		const sessionGone = useCallback(
			(error: unknown) =>
				isSessionGone(error) || !options.tokenStorage.getToken(),
			[],
		);

		const scheduleRetry = useCallback(
			(error: unknown, rerun: () => void, visible: boolean) => {
				const delay = retryDelayMs(error, failures.current);
				failures.current += 1;
				clearRetry();
				retryTimer.current = setTimeout(() => {
					retryTimer.current = null;
					rerun();
				}, delay);
				if (visible) {
					setPartialState({
						loading: false,
						unavailable: { retryAt: Date.now() + delay },
					});
				}
			},
			[clearRetry, setPartialState],
		);

		const succeed = useCallback(
			(session: AuthSession<TUser, TExtra>) => {
				failures.current = 0;
				clearRetry();
				applySession(session);
			},
			[applySession, clearRetry],
		);

		const clearLocalSession = useCallback(() => {
			failures.current = 0;
			clearRetry();
			options.tokenStorage.clearToken();
			options.onLogoutCleanup?.();
			resetState();
		}, [clearRetry, resetState]);
```

**`performLogout`.** Add `failures.current = 0;` and `clearRetry();` as its
first two statements, and add `clearRetry` to its dependency array.

**`refresh`.** Replace it with:

```ts
		const refresh = useCallback(async () => {
			try {
				const session = options.refreshSession
					? await options.refreshSession()
					: await options.loadSession();
				succeed(session);
			} catch (error) {
				if (!mounted.current) return;
				// Task 3.2: a refresh the server refused forces re-login. Local-only
				// cleanup, since the refusal already proved the session is gone.
				if (sessionGone(error)) {
					await performLogout({ callApi: false });
					return;
				}
				// Anything else: the person is signed in and the access token is still
				// good for a while, so retry quietly (ONL-243).
				scheduleRetry(error, () => void refreshRef.current(), false);
			}
		}, [succeed, sessionGone, performLogout, scheduleRetry]);
		const refreshRef = useRef(refresh);
		refreshRef.current = refresh;
```

**Hydrate.** Replace the whole Task 3.1 `useEffect` (the one that defines and
calls `hydrate` with a `cancelled` flag) with:

```ts
		// --- Task 3.1: session hydration on app load ---------------------------
		const hydrate = useCallback(async (): Promise<void> => {
			const token = options.tokenStorage.getToken();
			if (!token) return;
			const expiresAt = getExpiration(token);
			const expired = expiresAt !== null && Date.now() >= expiresAt;

			// Token already expired with no way to refresh it: nothing to retry.
			if (expired && !options.refreshSession) {
				clearLocalSession();
				return;
			}

			try {
				const session =
					expired && options.refreshSession
						? await options.refreshSession()
						: await options.loadSession();
				if (mounted.current) succeed(session);
			} catch (error) {
				if (!mounted.current) return;
				if (sessionGone(error)) {
					clearLocalSession();
					return;
				}
				scheduleRetry(error, () => void hydrateRef.current(), true);
			}
		}, [clearLocalSession, succeed, sessionGone, scheduleRetry]);
		const hydrateRef = useRef(hydrate);
		hydrateRef.current = hydrate;

		useEffect(() => {
			void hydrateRef.current();
		}, []);

		const retrySession = useCallback(() => {
			clearRetry();
			void hydrateRef.current();
		}, [clearRetry]);
```

**Cross-tab.** In the Task 3.4 storage handler, replace:

```ts
				options
					.loadSession()
					.then(applySession)
					.catch(() => {
						options.tokenStorage.clearToken();
						options.onLogoutCleanup?.();
						resetState();
					});
```

with:

```ts
				options
					.loadSession()
					.then(succeed)
					.catch((error: unknown) => {
						if (sessionGone(error)) {
							clearLocalSession();
							return;
						}
						scheduleRetry(error, () => void hydrateRef.current(), true);
					});
```

Then change that effect's dependency array to include `succeed`,
`sessionGone`, `clearLocalSession`, `scheduleRetry` and `resetState`. Keep
`resetState`, which the no-token branch above still uses.

**Return.** Add `retrySession` to the object `useAuthState` returns, beside
`refresh`.

**`RequireAuth`.** Replace it with:

```tsx
	function RequireAuth({
		children,
		loadingFallback = null,
		unavailableFallback,
		redirectTo = "/login",
	}: {
		children: ReactNode;
		loadingFallback?: ReactNode;
		/**
		 * What to show while the session can't be checked but hasn't been
		 * refused - a 429, a 5xx, offline. Without one, the loading fallback
		 * shows instead: never a redirect, which would treat an unreachable
		 * session as a gone one (ONL-243).
		 */
		unavailableFallback?: (state: {
			retryAt: number;
			retry: () => void;
		}) => ReactNode;
		redirectTo?: string;
	}) {
		const auth = useAuth();
		const location = useLocation();

		if (auth.loading) return <>{loadingFallback}</>;
		if (!auth.user && auth.unavailable) {
			return (
				<>
					{unavailableFallback
						? unavailableFallback({
								retryAt: auth.unavailable.retryAt,
								retry: auth.retrySession,
							})
						: loadingFallback}
				</>
			);
		}
		if (!auth.user) {
			return <Navigate to={redirectTo} state={{ from: location }} replace />;
		}

		return <>{children}</>;
	}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @onlooker/auth-react test session-resilience`
Expected: PASS, 12 tests.

Run: `pnpm --filter @onlooker/auth-react test` and that package's typecheck
script.
Expected: pass. If `getExpiration` or other names in the replaced hydrate
differ from this plan's, use the names the file actually has, and say so in
the report.

- [ ] **Step 5: Commit**

Commit `packages/auth-react/src/index.tsx` and
`packages/auth-react/src/session-resilience.test.tsx`:

```text
fix(auth): keep the session when it can't be checked :umbrella:

A 429, a 5xx or a dropped connection on page load, on the proactive refresh,
or when another tab changed the token all cleared both tokens, so a session
the server still honored was thrown away over a moment of unavailability.
Only a 401, or a failure that already took the token with it, signs out now;
anything else keeps the tokens and retries after Retry-After or a backoff.

Refs ONL-243
```

---

### Task 4: The web client and the notice

**Files:**
- Modify: `apps/web/src/api/client.ts`: `performRefresh` (about lines
  191–230) and the refresh branch of `authenticatedFetch` (about lines
  265–279)
- Test: `apps/web/src/api/client.test.ts`
- Modify: `apps/web/src/App.tsx`: `Protected` (about lines 46–57) and a new
  `SessionUnavailable` component in the same file
- Create: `apps/web/src/__tests__/protected-unavailable.test.tsx`

**Interfaces:**
- Consumes: `RequireAuth`'s `unavailableFallback` prop from Task 3, which
  receives `{ retryAt: number; retry: () => void }`.
- Consumes: the existing `Button` (`onClick`, `children`) and `AppShell`.

- [ ] **Step 1: Write the failing client tests**

Add to `apps/web/src/api/client.test.ts`, inside
`describe("createApiClient — token refresh", ...)`. These use the existing
`store`, `json`, `apiError`, `testConfig` and `createApiClient`:

```ts
	// ONL-243: only a 400 or 401 from /auth/refresh means the refresh token
	// can't work. A 429 (the zone rule allows 6 /auth/* requests per 10s per
	// IP) or a 5xx says nothing about it, and clearing it signed people out.
	it.each([429, 503])(
		"keeps the tokens when the refresh answers %i, and answers session_unavailable",
		async (status) => {
			store.setTokens({ accessToken: "old", refreshToken: "rt-ok" });
			const onUnauthorized = vi.fn();

			const baseFetch = vi.fn(async (url: string) => {
				if (url.endsWith("/auth/refresh")) {
					return json(status, apiError("rate_limited"));
				}
				return json(401, apiError("unauthorized"));
			});

			const { apiClient } = createApiClient({
				config: testConfig({ maxRetries: 0 }),
				tokenStore: store,
				baseFetch: baseFetch as unknown as typeof fetch,
				onUnauthorized,
			});

			await expect(apiClient.get("/auth/me")).rejects.toMatchObject({
				status: 503,
				code: "session_unavailable",
			});
			expect(store.getToken()).toBe("old");
			expect(store.getRefreshToken()).toBe("rt-ok");
			expect(onUnauthorized).not.toHaveBeenCalled();
		},
	);

	it("clears the tokens when the refresh answers 400", async () => {
		store.setTokens({ accessToken: "old", refreshToken: "bad" });
		const onUnauthorized = vi.fn();

		const baseFetch = vi.fn(async (url: string) => {
			if (url.endsWith("/auth/refresh")) {
				return json(400, apiError("invalid_input"));
			}
			return json(401, apiError("unauthorized"));
		});

		const { apiClient } = createApiClient({
			config: testConfig(),
			tokenStore: store,
			baseFetch: baseFetch as unknown as typeof fetch,
			onUnauthorized,
		});

		await expect(apiClient.get("/auth/me")).rejects.toBeInstanceOf(AuthApiError);
		expect(store.getToken()).toBeNull();
		expect(store.getRefreshToken()).toBeNull();
		expect(onUnauthorized).toHaveBeenCalled();
	});
```

The existing test "clears tokens and reports unauthorized when refresh fails"
covers the 401 case and must keep passing.

- [ ] **Step 2: Write the failing notice test**

Create `apps/web/src/__tests__/protected-unavailable.test.tsx`, following
`protected-loading.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// RequireAuth honors unavailableFallback the way packages/auth-react does:
// with no user and the session unreachable, it renders the fallback with the
// retry time and the retry action. A passthrough mock would render the page
// and prove nothing.
const retry = vi.fn();
const RETRY_AT = Date.now() + 30_000;

vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({
			user: null,
			loading: false,
			unavailable: { retryAt: RETRY_AT },
			retrySession: retry,
			logout: vi.fn(),
			refresh: vi.fn(),
			sessionExpiresAt: null,
			sessionExpiringSoon: false,
		}),
		RequireAuth: ({
			unavailableFallback,
		}: {
			children: React.ReactNode;
			unavailableFallback?: (s: { retryAt: number; retry: () => void }) => React.ReactNode;
		}) => unavailableFallback?.({ retryAt: RETRY_AT, retry }) ?? null,
	},
}));

const { default: App } = await import("../App");

describe("an authenticated route while the session can't be checked", () => {
	it("says so inside the app frame and offers to try again", () => {
		render(
			<MemoryRouter initialEntries={["/machines"]}>
				<App />
			</MemoryRouter>,
		);

		expect(screen.getByRole("navigation", { name: /sections/i })).toBeDefined();
		const status = screen.getByRole("status");
		expect(status.textContent).toMatch(/can't reach onlooker right now/i);
		expect(status.textContent).toMatch(/trying again in 30 s/i);

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(retry).toHaveBeenCalledTimes(1);
	});
});
```

`vi.mock` is hoisted above the `const` declarations. The factory reads `retry`
and `RETRY_AT` only when `useAuth` or `RequireAuth` runs, which happens after
they're initialized. If vitest still refuses to reference them, wrap both in
`vi.hoisted(() => ({ retry: vi.fn(), RETRY_AT: Date.now() + 30_000 }))`. If
the countdown reads 29 or 31 because a millisecond passed, assert with
`/trying again in (29|30) s/i` rather than freezing time globally. Note either
change in the report.

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @onlooker/web test client` and
`pnpm --filter @onlooker/web test protected-unavailable`
Expected: FAIL. The client clears the tokens on 429 and 503, and calls
`onUnauthorized`. App passes no `unavailableFallback`, so the notice test
renders nothing.

- [ ] **Step 4: Implement the client**

In `apps/web/src/api/client.ts` `performRefresh`, replace:

```ts
			if (!response.ok) {
				// Refresh token rejected — the session cannot be recovered.
				tokenStore.clear();
				return false;
			}
```

with:

```ts
			if (!response.ok) {
				// Only a 400 (no refresh token) or a 401 (refused) means the session
				// cannot be recovered. A 429 - the zone rule meters /auth/* per IP -
				// or a 5xx says nothing about the token, and clearing it signed
				// people out over a moment of unavailability (ONL-243).
				if (response.status === 400 || response.status === 401) {
					tokenStore.clear();
				}
				return false;
			}
```

In `authenticatedFetch`, replace:

```ts
		if (eligibleForRefresh) {
			const refreshed = await refreshTokens();
			if (refreshed) {
				response = await resilientFetch(method, url, withAuthHeader(init));
			} else {
				tokenStore.clear();
				options.onUnauthorized?.();
			}
		}
```

with:

```ts
		if (eligibleForRefresh) {
			const refreshed = await refreshTokens();
			if (refreshed) {
				response = await resilientFetch(method, url, withAuthHeader(init));
			} else if (tokenStore.getRefreshToken() === null) {
				// performRefresh cleared it: the server refused the session.
				tokenStore.clear();
				options.onUnauthorized?.();
			} else {
				// The refresh was unreachable, not refused. Answer 503 rather than the
				// 401: auth-react clears the access token on any 401 it sees, which
				// would sign out a session the server still honors (ONL-243).
				response = new Response(
					JSON.stringify({
						success: false,
						error: {
							code: "session_unavailable",
							message: "Can't reach Onlooker right now.",
						},
					}),
					{ status: 503, headers: { "Content-Type": "application/json" } },
				);
			}
		}
```

If the surrounding code differs, for example if the branch is shaped
differently or the variable isn't `response`, keep the three outcomes
(refreshed, refused, unreachable) and report how it differed.

- [ ] **Step 5: Implement the notice**

In `apps/web/src/App.tsx`, change the React import to
`import { type ReactNode, useEffect, useState } from "react";`, and import
`Button` beside `Loading`: `import { Button, Loading } from "./components/ui";`.

Add above `Protected`:

```tsx
/**
 * What an authenticated route shows while the session can't be checked - a
 * 429, a 5xx, offline - but hasn't been refused. The tokens are kept and
 * auth-react retries at `retryAt`; Try again runs the check now (ONL-243).
 */
function SessionUnavailable({
	retryAt,
	retry,
}: {
	retryAt: number;
	retry: () => void;
}) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);
	const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));

	return (
		<div>
			<p role="status" aria-live="polite">
				Can't reach Onlooker right now.{" "}
				{seconds > 0 ? `Trying again in ${seconds} s.` : "Trying again…"}
			</p>
			<Button onClick={retry}>Try again</Button>
		</div>
	);
}
```

In `Protected`, add the prop to `auth.RequireAuth`, after `loadingFallback`:

```tsx
			unavailableFallback={({ retryAt, retry }) => (
				<AppShell>
					<SessionUnavailable retryAt={retryAt} retry={retry} />
				</AppShell>
			)}
```

Then update `Protected`'s doc comment with one sentence: the unreachable case
gets the same frame, with a notice instead of the loading line.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @onlooker/web test client` and
`pnpm --filter @onlooker/web test protected`
Expected: PASS. That runs both `protected-loading` and `protected-unavailable`.

Run: `pnpm --filter @onlooker/web test && pnpm typecheck && pnpm lint`
Expected: pass. Other `__tests__` files mock `../auth` with their own
`useAuth` shapes; those don't need `unavailable`, because their `RequireAuth`
mocks ignore it.

- [ ] **Step 7: Commit**

Commit `apps/web/src/api/client.ts`, `apps/web/src/api/client.test.ts`,
`apps/web/src/App.tsx` and
`apps/web/src/__tests__/protected-unavailable.test.tsx`:

```text
fix(web): stay signed in when Onlooker is briefly unreachable :umbrella:

The client cleared both tokens whenever /auth/refresh answered anything but
success, so a 429 from the zone rule or a 5xx signed people out, and a
request whose refresh was rate-limited reported a 401 that auth-react then
treated as a sign-out too. Now only a 400 or 401 clears them; an
unreachable refresh answers 503 session_unavailable, and the app shows a
can't-reach notice with Try again instead of the login page.

Refs ONL-243
```
