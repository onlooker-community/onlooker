import { describe, expect, it } from "vitest";
import { createMockFetch } from "./mockApi";

// The mock matches endpoints on bare paths - `path === "/auth/signup"` - but
// createMockFetch is handed whatever URL the client built. With
// VITE_API_BASE_URL set, that is "http://localhost:8787/auth/signup", which
// equals nothing, and every request comes back "Mock endpoint not found".
//
// The routing check used includes("/auth/") so absolute URLs got INTO the auth
// handler and then matched none of its cases, which is why the failure named
// the URL rather than the base URL that caused it. The mock only ever worked
// with an empty base, and that happened to be the default.
//
// Hit while switching apps/web onto the mock to work around a broken dev API:
// the fix for one outage walked straight into this one.
const BASE = "http://localhost:8787";

function signup(email: string) {
	return {
		method: "POST",
		body: JSON.stringify({ email, password: "correct-horse-battery" }),
	} satisfies RequestInit;
}

describe("createMockFetch with a base URL", () => {
	it("resolves an endpoint the same way with or without one", async () => {
		const call = createMockFetch();

		const relative = await call("/auth/signup", signup("rel@example.com"));
		const absolute = await call(
			`${BASE}/auth/signup`,
			signup("abs@example.com"),
		);

		// Parity is the point, so the assertion is that the two agree and both
		// succeeded - not a specific code. The mock answers 200 here where the
		// real API answers 201, which is its own divergence and not this one.
		expect(relative.ok).toBe(true);
		expect(absolute.status).toBe(relative.status);
	});

	it("keeps the query string, which some endpoints read", async () => {
		const call = createMockFetch();

		const response = await call(
			`${BASE}/auth/reset-password/verify?token=nonsense`,
			{ method: "GET" },
		);

		// The token is junk, so `valid: false` is the right answer. What matters
		// is that the handler ran at all and read the query - a 404 here would
		// mean the search string was dropped on the way in.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ valid: false });
	});

	it("routes /api/ endpoints too, not just /auth/", async () => {
		const call = createMockFetch();

		const login = await call("/auth/login", {
			method: "POST",
			body: JSON.stringify({
				email: "test@example.com",
				password: "password123",
			}),
		});
		const { token } = (await login.json()) as { token: string };

		const response = await call(`${BASE}/api/dashboard`, {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(response.status).toBe(200);
	});

	// Fixing the base-URL case must not turn a genuine gap into silence: an
	// endpoint the mock does not implement should still say so.
	it("still reports not-found for an endpoint it does not implement", async () => {
		const call = createMockFetch();

		const response = await call(`${BASE}/auth/does-not-exist`, {
			method: "POST",
		});

		expect(response.status).toBe(404);
	});
});
