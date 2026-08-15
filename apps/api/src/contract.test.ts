import { SELF } from "cloudflare:test";
import {
	anonymousCases,
	authenticatedCases,
	type ContractCase,
	forbiddenPresent,
	shapeFailures,
} from "@onlooker/api-contract";
import { beforeAll, describe, expect, it } from "vitest";

// The half of the contract that did not exist. apps/web pinned its mock to
// figures captured by hand from a running worker; nothing checked the worker
// itself, so apps/api could change a status code or a response shape and every
// test would stay green while the recorded table became fiction.
//
// SELF dispatches to the real default export - the actual router, middleware and
// D1 - so this exercises the same surface apps/web talks to, over HTTP, without
// booting `wrangler dev` or adding a CI job. That is why vitest.config.ts names
// `main`; without it SELF has no worker to reach.
//
// The database starts empty on every run, so the fixture creates its own account
// rather than assuming one. That difference from the mock, which ships seeded, is
// exactly why the shared table is written against roles instead of literals.

const PASSWORD = "correct-horse-battery";
const BASE = "https://api.onlooker.dev";

const EXISTING_EMAIL = "contract-existing@example.com";

let accessToken: string;
let counter = 0;

function freshEmail(): string {
	counter += 1;
	return `contract-fresh-${counter}@example.com`;
}

async function call(entry: ContractCase, token?: string): Promise<Response> {
	const headers = new Headers(entry.init.headers);
	if (token) headers.set("Authorization", `Bearer ${token}`);

	return SELF.fetch(`${BASE}${entry.path}`, { ...entry.init, headers });
}

beforeAll(async () => {
	const signup = await SELF.fetch(`${BASE}/auth/signup`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: EXISTING_EMAIL, password: PASSWORD }),
	});

	// Assert the fixture rather than trusting it. If signup breaks, every case
	// below fails for a reason that has nothing to do with the case, and the
	// output should say so once here instead of ten times downstream. The body
	// goes in the message because a bare "expected 500 to be 201" says nothing
	// about which binding or query actually gave way - which is exactly how this
	// suite reported its own missing TOKEN_EXPIRY_MINUTES binding.
	//
	// Any success will do. What this needs is an account to exist; whether the
	// API announces that with 201 is the contract's business, and asserting it
	// here too would mean a changed status code took the whole suite down with
	// the fixture instead of failing the one case that is actually about it.
	const raw = await signup.text();
	expect(signup.ok, `fixture signup failed (${signup.status}): ${raw}`).toBe(
		true,
	);
});

describe("apps/api serves the contract", () => {
	for (const entry of anonymousCases({
		existingEmail: EXISTING_EMAIL,
		existingPassword: PASSWORD,
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
	// (onlooker-06u), so a token taken before "login, correct credentials" runs
	// would be dead by the time these cases use it. apps/api does not rotate that
	// way and would pass either ordering - the structure matches the mock runner
	// so the two stay comparable, and so this side keeps working if that
	// difference is ever resolved in the mock's favor.
	describe("with a valid token", () => {
		beforeAll(async () => {
			const login = await SELF.fetch(`${BASE}/auth/login`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: EXISTING_EMAIL, password: PASSWORD }),
			});

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
