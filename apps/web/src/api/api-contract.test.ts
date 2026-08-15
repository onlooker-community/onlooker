import {
	anonymousCases,
	authenticatedCases,
	type ContractCase,
	forbiddenPresent,
	SESSION_LIFECYCLE,
	shapeFailures,
} from "@onlooker/api-contract";
import { beforeAll, describe, expect, it } from "vitest";
import { createMockFetch } from "./mockApi";

// The mock's half of the shared contract. apps/api runs the same table against
// the real worker in apps/api/src/contract.test.ts.
//
// This file used to carry the table itself, as figures captured by hand from a
// running worker. That pinned the mock so it could not drift on its own, but
// nothing re-checked apps/api - so the real API could move and this suite would
// stay green while the recorded numbers quietly became fiction. The table now
// lives in @onlooker/api-contract and both sides answer to it, which is what
// makes a one-sided change impossible: whichever implementation has not caught
// up is the one that fails.
//
// The mock ships with a seeded account; apps/api starts from an empty database
// and creates its own. That is why the shared cases are written against a
// fixture rather than literal credentials.

const SEEDED_EMAIL = "test@example.com";
const SEEDED_PASSWORD = "password123";

let accessToken: string;
let counter = 0;

function freshEmail(): string {
	counter += 1;
	return `contract-fresh-${counter}@example.com`;
}

async function call(entry: ContractCase, token?: string): Promise<Response> {
	const headers = new Headers(entry.init.headers);
	if (token) headers.set("Authorization", `Bearer ${token}`);

	return createMockFetch()(entry.path, { ...entry.init, headers });
}

describe("the mock serves the contract", () => {
	for (const entry of anonymousCases({
		existingEmail: SEEDED_EMAIL,
		existingPassword: SEEDED_PASSWORD,
		freshEmail,
	})) {
		it(`${entry.name} answers ${entry.status}`, async () => {
			const response = await call(entry);

			expect(response.status).toBe(entry.status);

			if (entry.body || entry.forbidden) {
				const payload = await response.json();
				if (entry.body) {
					expect(shapeFailures(payload, entry.body)).toEqual([]);
				}
				if (entry.forbidden) {
					expect(forbiddenPresent(payload, entry.forbidden)).toEqual([]);
				}
			}
		});
	}

	// Nested purely to group these and give them their own login. The ordering
	// used to be load-bearing - the mock retired a user's earlier token whenever
	// it issued a new one, so "login, correct credentials" above would kill a
	// token taken any sooner, which is how that divergence was found. Sessions
	// are concurrent now, so any order works; the grouping stays because it reads
	// better and mirrors the apps/api runner.
	describe("with a valid token", () => {
		beforeAll(async () => {
			const login = await createMockFetch()("/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: SEEDED_EMAIL,
					password: SEEDED_PASSWORD,
				}),
			});

			// Same reasoning as the apps/api runner: assert the fixture so a broken
			// login reports itself once, not as three confusing failures downstream.
			const raw = await login.text();
			expect(login.status, `fixture login failed: ${raw}`).toBe(200);

			const body = JSON.parse(raw) as { token?: string };
			expect(typeof body.token, "fixture login returned no token").toBe(
				"string",
			);
			accessToken = body.token as string;
		});

		for (const entry of authenticatedCases()) {
			it(`${entry.name} answers ${entry.status}`, async () => {
				const response = await call(entry, accessToken);

				expect(response.status).toBe(entry.status);

				const payload = await response.json();
				if (entry.body) {
					expect(shapeFailures(payload, entry.body)).toEqual([]);
				}
				if (entry.forbidden) {
					expect(forbiddenPresent(payload, entry.forbidden)).toEqual([]);
				}
			});
		}
	});
});

// The same flow apps/api runs in its own contract suite. Driven step by step
// rather than as independent cases, because each step depends on the last, and
// each test signs up its own account so the sequences cannot collide.
//
// Both of the behaviors pinned here were mock inventions until now: it revoked
// the presented access token on logout, which the real server cannot do, and it
// retired a user's previous tokens whenever it issued new ones, which the real
// server does not do. Anything built against the old mock believed logging out
// ended access immediately and that a second device signed the first one out.
describe("the mock's session lifecycle", () => {
	let seq = 0;

	async function signUp(): Promise<{ access: string; refresh: string }> {
		seq += 1;
		const res = await createMockFetch()("/auth/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: `mock-lifecycle-${seq}@example.com`,
				password: "correct-horse-battery",
			}),
		});
		const raw = await res.text();
		expect(res.ok, `fixture signup failed (${res.status}): ${raw}`).toBe(true);
		const body = JSON.parse(raw) as { token: string; refreshToken: string };
		return { access: body.token, refresh: body.refreshToken };
	}

	const me = (token: string) =>
		createMockFetch()("/auth/me", {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});

	const refresh = (token: string) =>
		createMockFetch()("/auth/refresh", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refreshToken: token }),
		});

	const logout = (session: { access: string; refresh: string }) =>
		createMockFetch()("/auth/logout", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${session.access}`,
			},
			body: JSON.stringify({ refreshToken: session.refresh }),
		});

	it("logout leaves the access token alone and kills the refresh token", async () => {
		const session = await signUp();
		expect((await me(session.access)).status).toBe(200);

		expect((await logout(session)).status).toBe(200);

		expect((await me(session.access)).status).toBe(
			SESSION_LIFECYCLE.accessTokenAfterLogout,
		);
		expect((await refresh(session.refresh)).status).toBe(
			SESSION_LIFECYCLE.refreshAfterLogout,
		);
	});

	it("a second login leaves the first session usable, and separately closable", async () => {
		const first = await signUp();
		const second = await createMockFetch()("/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: `mock-lifecycle-${seq}@example.com`,
				password: "correct-horse-battery",
			}),
		});
		expect(second.status).toBe(200);
		const secondSession = (await second.json()) as {
			token: string;
			refreshToken: string;
		};

		expect((await me(first.access)).status).toBe(
			SESSION_LIFECYCLE.firstSessionAfterSecondLogin,
		);

		// Closing the first must not take the second down with it.
		expect((await logout(first)).status).toBe(200);
		expect((await refresh(first.refresh)).status).toBe(
			SESSION_LIFECYCLE.refreshAfterLoggingOutTheFirstSession,
		);
		expect((await refresh(secondSession.refreshToken)).status).toBe(200);
	});
});
