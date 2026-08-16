import { SELF } from "cloudflare:test";
import {
	ACCOUNT_CONTRACT,
	anonymousCases,
	authenticatedCases,
	type ContractCase,
	forbiddenPresent,
	SESSION_LIFECYCLE,
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

	// Nested purely to group these and give them their own login. This ordering
	// once mattered on the mock side, which retired earlier tokens on every
	// issue; sessions are concurrent on both sides now, so it no longer does. The
	// structure stays so the two runners keep mirroring each other.
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

// Driven as a flow rather than independent cases, because every step depends on
// the one before it. Each test owns a throwaway account so the sequences cannot
// interfere with each other or with the cases above.
describe("apps/api session lifecycle", () => {
	let seq = 0;

	async function signUp(): Promise<{ access: string; refresh: string }> {
		seq += 1;
		const res = await SELF.fetch(`${BASE}/auth/signup`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: `lifecycle-${seq}@example.com`,
				password: PASSWORD,
			}),
		});
		const raw = await res.text();
		expect(res.ok, `fixture signup failed (${res.status}): ${raw}`).toBe(true);
		const body = JSON.parse(raw) as { token: string; refreshToken: string };
		return { access: body.token, refresh: body.refreshToken };
	}

	const me = (token: string) =>
		SELF.fetch(`${BASE}/auth/me`, {
			headers: { Authorization: `Bearer ${token}` },
		});

	const refresh = (token: string) =>
		SELF.fetch(`${BASE}/auth/refresh`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refreshToken: token }),
		});

	const logout = (session: { access: string; refresh: string }) =>
		SELF.fetch(`${BASE}/auth/logout`, {
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
		const second = await SELF.fetch(`${BASE}/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: `lifecycle-${seq}@example.com`,
				password: PASSWORD,
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

// The account surface: nine 501 stubs until now, four of which needed only
// queries. Flows rather than single cases - editing, changing a password and
// deleting are all stateful, and two of them are destructive.
describe("apps/api account management", () => {
	let seq = 0;

	async function account(): Promise<{
		email: string;
		access: string;
		refresh: string;
	}> {
		seq += 1;
		const email = `account-${seq}@example.com`;
		const res = await SELF.fetch(`${BASE}/auth/signup`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: PASSWORD }),
		});
		const raw = await res.text();
		expect(res.ok, `fixture signup failed (${res.status}): ${raw}`).toBe(true);
		const body = JSON.parse(raw) as { token: string; refreshToken: string };
		return { email, access: body.token, refresh: body.refreshToken };
	}

	const profile = (token: string) =>
		SELF.fetch(`${BASE}/auth/profile`, {
			headers: { Authorization: `Bearer ${token}` },
		});

	const patch = (token: string, changes: Record<string, string>) =>
		SELF.fetch(`${BASE}/auth/profile`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(changes),
		});

	const login = (email: string, password: string) =>
		SELF.fetch(`${BASE}/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password }),
		});

	it("serves a profile carrying what the settings page reads", async () => {
		const me = await account();

		const body = (await (await profile(me.access)).json()) as {
			user: Record<string, unknown>;
		};

		expect(body.user.email).toBe(me.email);
		expect(body.user.createdAt).toEqual(expect.any(String));
		expect(body.user.emailVerified).toBe(false);
		expect(JSON.stringify(body)).not.toContain("password");
	});

	it("renames without touching the address", async () => {
		const me = await account();

		const body = (await (await patch(me.access, { name: "Ada" })).json()) as {
			user: Record<string, unknown>;
		};

		expect(body.user.name).toBe("Ada");
		expect(body.user.email).toBe(me.email);
	});

	it("refuses an address another account holds", async () => {
		const first = await account();
		const second = await account();

		const res = await patch(second.access, { email: first.email });

		expect(res.status).toBe(ACCOUNT_CONTRACT.emailTaken);
	});

	// Submitting a form that posts every field, unchanged, is ordinary.
	it("accepts an unchanged address as a no-op", async () => {
		const me = await account();

		expect((await patch(me.access, { email: me.email })).status).toBe(200);
	});

	it("clears verification when the address changes", async () => {
		const me = await account();
		seq += 1;

		const body = (await (
			await patch(me.access, { email: `moved-${seq}@example.com` })
		).json()) as { user: Record<string, unknown> };

		expect(body.user.emailVerified).toBe(
			ACCOUNT_CONTRACT.emailChangeClearsVerification,
		);
	});

	it("rejects a password change without the current password", async () => {
		const me = await account();

		const res = await SELF.fetch(`${BASE}/auth/change-password`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${me.access}`,
			},
			body: JSON.stringify({
				current_password: "not-it",
				new_password: "brand-new-password",
			}),
		});

		expect(res.status).toBe(ACCOUNT_CONTRACT.wrongCurrentPassword);
	});

	it("changes the password, ends other sessions, keeps its own", async () => {
		const me = await account();
		const elsewhere = (await (await login(me.email, PASSWORD)).json()) as {
			refreshToken: string;
		};

		const res = await SELF.fetch(`${BASE}/auth/change-password`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${me.access}`,
			},
			body: JSON.stringify({
				current_password: PASSWORD,
				new_password: "brand-new-password",
				refreshToken: me.refresh,
			}),
		});
		expect(res.status).toBe(200);

		expect((await login(me.email, PASSWORD)).status).toBe(
			ACCOUNT_CONTRACT.loginWithOldPasswordAfterChange,
		);
		expect((await login(me.email, "brand-new-password")).status).toBe(
			ACCOUNT_CONTRACT.loginWithNewPasswordAfterChange,
		);

		const refresh = (token: string) =>
			SELF.fetch(`${BASE}/auth/refresh`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ refreshToken: token }),
			});

		expect((await refresh(elsewhere.refreshToken)).status).toBe(
			ACCOUNT_CONTRACT.otherSessionsAfterPasswordChange,
		);
		expect((await refresh(me.refresh)).status).toBe(200);
	});

	it("deletes the account, its sessions and its address", async () => {
		const me = await account();

		const res = await SELF.fetch(`${BASE}/auth/account`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${me.access}` },
		});
		expect(res.status).toBe(200);

		const refreshed = await SELF.fetch(`${BASE}/auth/refresh`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refreshToken: me.refresh }),
		});
		expect(refreshed.status).toBe(ACCOUNT_CONTRACT.refreshAfterAccountDeleted);
		expect((await login(me.email, PASSWORD)).status).toBe(
			ACCOUNT_CONTRACT.loginAfterAccountDeleted,
		);
	});
});
