import { describe, expect, it } from "vitest";
import { createMockFetch } from "./mockApi";

// What apps/api answers for the same requests, recorded by running the worker
// locally and calling it - not read off the source, and not guessed.
//
// This exists because nothing compares the two. apps/web was built against the
// mock, so wherever they disagree the mock wins in development and reality
// wins in production, silently. That gap has already cost twice: /api/dashboard
// wrapped its payload where the mock did not, which blanked the dashboard, and
// the mock's own base-URL assumption differed from the client's, which broke
// signup outright.
//
// LIMIT, stated plainly: this asserts one side. It pins the mock to figures
// captured from the real API, so the mock cannot drift on its own - but nothing
// here re-checks apps/api, so if IT moves, this suite stays green and the table
// below quietly becomes fiction. Closing that needs the real worker running in
// CI, which is filed rather than done.
//
// Two endpoints are deliberately absent because the two sides genuinely
// disagree today, and pinning either answer would be inventing a decision:
//   - forgot-password: 501 from apps/api, 200 from the mock, which implements
//     the whole reset flow. Filed.
//   - anything after logout: the mock revokes the access token, apps/api
//     leaves it valid until expiry. Filed.
const CONTRACT = [
	{
		name: "signup, new account",
		path: "/auth/signup",
		init: (email: string) => ({
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: "correct-horse-battery" }),
		}),
		status: 201,
	},
	{
		name: "signup, address already taken",
		path: "/auth/signup",
		init: () => ({
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "test@example.com",
				password: "correct-horse-battery",
			}),
		}),
		status: 409,
	},
	{
		name: "login, correct credentials",
		path: "/auth/login",
		init: () => ({
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "test@example.com",
				password: "password123",
			}),
		}),
		status: 200,
	},
	{
		name: "login, wrong password",
		path: "/auth/login",
		init: () => ({
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "test@example.com", password: "wrong" }),
		}),
		status: 401,
	},
	{
		name: "me, no token",
		path: "/auth/me",
		init: () => ({ method: "GET" }),
		status: 401,
	},
] as const;

describe("mock matches the contract apps/api actually serves", () => {
	for (const entry of CONTRACT) {
		it(`${entry.name} answers ${entry.status}`, async () => {
			const call = createMockFetch();
			// Unique per run so the new-account case stays new.
			const email = `contract-${entry.name.replace(/\W+/g, "-")}@example.com`;

			const response = await call(entry.path, entry.init(email));

			expect(response.status).toBe(entry.status);
		});
	}
});
