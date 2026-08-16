import { env, SELF } from "cloudflare:test";
import {
	ACCOUNT_CONTRACT,
	anonymousCases,
	authenticatedCases,
	type ContractCase,
	EMAIL_FLOW_CONTRACT,
	forbiddenPresent,
	SESSION_LIFECYCLE,
	shapeFailures,
} from "@onlooker/api-contract";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createVerificationToken, getUserByEmail } from "./db/queries";

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

// Email verification and password reset.
//
// Split deliberately. The shared expectations below are the ones both
// implementations can answer without holding a token - uniform responses,
// invalid links, who may call what - because a token only exists inside an
// email and neither side can read its own mail.
//
// The round trip that needs a real token is further down and is apps/api only,
// minting one through the query layer. The equivalent behavior in the mock is
// covered by its own suite; single use, expiry and cross-flow refusal are
// pinned at the query level in queries.test.ts for this side.
describe("apps/api email flows", () => {
	let seq = 0;

	const post = (path: string, body: unknown, token?: string) =>
		SELF.fetch(`${BASE}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(body),
		});

	async function account(): Promise<{ email: string; access: string }> {
		seq += 1;
		const email = `flow-${seq}@example.com`;
		const res = await post("/auth/signup", { email, password: PASSWORD });
		const raw = await res.text();
		expect(res.ok, `fixture signup failed (${res.status}): ${raw}`).toBe(true);
		return { email, access: (JSON.parse(raw) as { token: string }).token };
	}

	it("answers forgot-password identically for known and unknown addresses", async () => {
		const me = await account();

		const known = await post("/auth/forgot-password", { email: me.email });
		const unknown = await post("/auth/forgot-password", {
			email: "nobody-here@example.com",
		});

		expect(known.status).toBe(EMAIL_FLOW_CONTRACT.forgotPasswordKnownAddress);
		expect(unknown.status).toBe(
			EMAIL_FLOW_CONTRACT.forgotPasswordUnknownAddress,
		);
		// Bodies too. A difference here leaks precisely what matching statuses hide.
		expect(await known.text()).toBe(await unknown.text());
	});

	it("reports an unknown reset token as not valid, without erroring", async () => {
		const res = await SELF.fetch(
			`${BASE}/auth/reset-password/verify?token=invented`,
		);

		expect(res.status).toBe(EMAIL_FLOW_CONTRACT.verifyResetTokenStatus);
		expect(((await res.json()) as { valid: boolean }).valid).toBe(false);
	});

	it("rejects a reset with an unknown token", async () => {
		const res = await post("/auth/reset-password", {
			token: "invented",
			password: "brand-new-password",
		});

		expect(res.status).toBe(EMAIL_FLOW_CONTRACT.resetPasswordReplayed);
	});

	it("rejects email verification with an unknown token", async () => {
		expect(
			(await post("/auth/verify-email", { token: "invented" })).status,
		).toBe(EMAIL_FLOW_CONTRACT.verifyEmailInvalidToken);
	});

	it("issues a verification link to an authenticated caller", async () => {
		const me = await account();

		expect(
			(await post("/auth/resend-verification", {}, me.access)).status,
		).toBe(200);
	});

	it("refuses to resend for an unauthenticated caller", async () => {
		expect((await post("/auth/resend-verification", {})).status).toBe(401);
	});
});

// The half of the reset flow that needs a token in hand.
//
// apps/api only, and minting through the query layer rather than through
// forgot-password, because the token leaves the system inside an email that
// nothing here can read. What this buys over the query-level tests is the
// endpoints: that /auth/reset-password really spends the token, really writes
// the password, and really ends the sessions - as opposed to the store being
// capable of it.
describe("apps/api reset round trip", () => {
	let seq = 0;

	const post = (path: string, body: unknown) =>
		SELF.fetch(`${BASE}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

	async function accountWithResetToken(): Promise<{
		email: string;
		refresh: string;
		token: string;
	}> {
		seq += 1;
		const email = `roundtrip-${seq}@example.com`;
		const signup = await post("/auth/signup", { email, password: PASSWORD });
		const raw = await signup.text();
		expect(signup.ok, `fixture signup failed (${signup.status}): ${raw}`).toBe(
			true,
		);
		const { refreshToken } = JSON.parse(raw) as { refreshToken: string };

		const { id } = (await getUserByEmail(env.DB, email)) as { id: string };
		const token = await createVerificationToken(
			env.DB,
			id,
			"reset",
			new Date(Date.now() + 3_600_000),
		);
		return { email, refresh: refreshToken, token };
	}

	it("checks a link without spending it, then resets with it", async () => {
		const me = await accountWithResetToken();

		const check = await SELF.fetch(
			`${BASE}/auth/reset-password/verify?token=${me.token}`,
		);
		expect((await check.json()) as { valid: boolean; email: string }).toEqual({
			valid: true,
			email: me.email,
		});

		// Still spendable after the check - the page rendering must not burn it.
		expect(EMAIL_FLOW_CONTRACT.verifyResetTokenStillSpendable).toBe(true);
		const reset = await post("/auth/reset-password", {
			token: me.token,
			password: "brand-new-password",
		});
		expect(reset.status).toBe(200);

		expect(
			(
				await post("/auth/login", {
					email: me.email,
					password: "brand-new-password",
				})
			).status,
		).toBe(200);
		expect(
			(await post("/auth/login", { email: me.email, password: PASSWORD }))
				.status,
		).toBe(401);
	});

	it("refuses the same link twice", async () => {
		const me = await accountWithResetToken();

		expect(
			(
				await post("/auth/reset-password", {
					token: me.token,
					password: "brand-new-password",
				})
			).status,
		).toBe(200);

		expect(
			(
				await post("/auth/reset-password", {
					token: me.token,
					password: "another-password",
				})
			).status,
		).toBe(EMAIL_FLOW_CONTRACT.resetPasswordReplayed);
	});

	it("ends every session, sparing none", async () => {
		const me = await accountWithResetToken();

		await post("/auth/reset-password", {
			token: me.token,
			password: "brand-new-password",
		});

		expect(
			(await post("/auth/refresh", { refreshToken: me.refresh })).status,
		).toBe(EMAIL_FLOW_CONTRACT.sessionsAfterReset);
	});

	// A verification link is mailed to an address that has not yet proven it
	// belongs to anyone. If it could be spent as a password reset, sending one
	// would be handing over the account.
	it("will not spend a verification link as a password reset", async () => {
		seq += 1;
		const email = `crossflow-${seq}@example.com`;
		await post("/auth/signup", { email, password: PASSWORD });
		const { id } = (await getUserByEmail(env.DB, email)) as { id: string };
		const verifyToken = await createVerificationToken(
			env.DB,
			id,
			"verify",
			new Date(Date.now() + 3_600_000),
		);

		expect(
			(
				await post("/auth/reset-password", {
					token: verifyToken,
					password: "brand-new-password",
				})
			).status,
		).toBe(EMAIL_FLOW_CONTRACT.crossFlowTokenUse);

		// And the refusal left it usable for what it actually is.
		expect(
			(await post("/auth/verify-email", { token: verifyToken })).status,
		).toBe(200);
	});
});

// The endpoint the browser reports to. Unauthenticated on purpose - the
// failures most worth hearing about happen to people who are not signed in, or
// whose session just broke - which makes its bounds the interesting part.
describe("apps/api client error reporting", () => {
	const post = (body: string, token?: string) =>
		SELF.fetch(`${BASE}/api/client-errors`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body,
		});

	it("accepts a report from a caller with no session", async () => {
		const res = await post(
			JSON.stringify({
				kind: "render",
				message: "Cannot read properties of undefined",
				url: "https://app.onlooker.dev/dashboard",
			}),
		);

		expect(res.status).toBe(204);
	});

	// Always 204. A client reporting an error has no use for a second error, and
	// apps/web ignores the response entirely - so a status that varied would be
	// information nobody reads, and a 4xx would look like an outage in the very
	// logs this feeds.
	it("answers 204 to a malformed report rather than complaining", async () => {
		expect((await post("this is not json")).status).toBe(204);
		expect((await post(JSON.stringify({ kind: "nonsense" }))).status).toBe(204);
		expect((await post(JSON.stringify({}))).status).toBe(204);
	});

	// The client scrubs before sending. This asserts the server does not rely on
	// that, because the endpoint is unauthenticated - anyone with curl can post a
	// raw token, and a cached bundle from before the scrubbing existed does the
	// same thing without any attacker involved.
	it("scrubs a credential the caller failed to scrub", async () => {
		const token = "c".repeat(64);
		const logged: string[] = [];
		const spy = vi
			.spyOn(console, "error")
			.mockImplementation((line) => logged.push(String(line)));

		await post(
			JSON.stringify({
				kind: "render",
				message: `boom at /reset-password/${token}`,
				url: `https://app.onlooker.dev/reset-password/${token}`,
				stack: `at fetch (https://api.onlooker.dev/auth/reset-password/verify?token=${token})`,
			}),
		);
		spy.mockRestore();

		expect(logged.join("\n")).not.toContain(token);
		// Still worth reading afterwards - redaction that empties the report
		// would be its own kind of failure.
		expect(logged.join("\n")).toContain("reset-password");
	});

	it("refuses an oversized report without erroring", async () => {
		const huge = JSON.stringify({
			kind: "render",
			message: "m".repeat(20_000),
		});

		expect((await post(huge)).status).toBe(204);
	});
});
