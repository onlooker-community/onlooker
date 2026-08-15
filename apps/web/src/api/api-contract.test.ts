import {
	anonymousCases,
	authenticatedCases,
	type ContractCase,
	forbiddenPresent,
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

	// Nested so this login happens after the anonymous cases above, not before.
	// The mock revokes a user's earlier access token whenever it issues a new one
	// (onlooker-06u), so "login, correct credentials" above would kill a token
	// taken any sooner - which is how that divergence was found: these three
	// cases 401'd against a token the mock had quietly retired.
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
