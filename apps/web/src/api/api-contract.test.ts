import {
	ACCOUNT_CONTRACT,
	anonymousCases,
	authenticatedCases,
	type ContractCase,
	EMAIL_FLOW_CONTRACT,
	forbiddenPresent,
	MACHINE_LIFECYCLE,
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

// The same account flows apps/api runs. These four endpoints were 501 stubs
// there while the mock implemented all of them, so the mock set this contract
// by default and the API has now caught up to it - except for password change
// ending other sessions, where the mock was the one that moved.
describe("the mock's account management", () => {
	let seq = 0;

	async function account(): Promise<{
		email: string;
		access: string;
		refresh: string;
	}> {
		seq += 1;
		const email = `mock-account-${seq}@example.com`;
		const res = await createMockFetch()("/auth/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: "correct-horse-battery" }),
		});
		const raw = await res.text();
		expect(res.ok, `fixture signup failed (${res.status}): ${raw}`).toBe(true);
		const body = JSON.parse(raw) as { token: string; refreshToken: string };
		return { email, access: body.token, refresh: body.refreshToken };
	}

	const profile = (token: string) =>
		createMockFetch()("/auth/profile", {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});

	const patch = (token: string, changes: Record<string, string>) =>
		createMockFetch()("/auth/profile", {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(changes),
		});

	const login = (email: string, password: string) =>
		createMockFetch()("/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password }),
		});

	const refresh = (token: string) =>
		createMockFetch()("/auth/refresh", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refreshToken: token }),
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

		expect((await patch(second.access, { email: first.email })).status).toBe(
			ACCOUNT_CONTRACT.emailTaken,
		);
	});

	it("accepts an unchanged address as a no-op", async () => {
		const me = await account();

		expect((await patch(me.access, { email: me.email })).status).toBe(200);
	});

	it("clears verification when the address changes", async () => {
		const me = await account();
		seq += 1;

		const body = (await (
			await patch(me.access, { email: `mock-moved-${seq}@example.com` })
		).json()) as { user: Record<string, unknown> };

		expect(body.user.emailVerified).toBe(
			ACCOUNT_CONTRACT.emailChangeClearsVerification,
		);
	});

	it("rejects a password change without the current password", async () => {
		const me = await account();

		const res = await createMockFetch()("/auth/change-password", {
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
		const elsewhere = (await (
			await login(me.email, "correct-horse-battery")
		).json()) as { refreshToken: string };

		const res = await createMockFetch()("/auth/change-password", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${me.access}`,
			},
			body: JSON.stringify({
				current_password: "correct-horse-battery",
				new_password: "brand-new-password",
				refreshToken: me.refresh,
			}),
		});
		expect(res.status).toBe(200);

		expect((await login(me.email, "correct-horse-battery")).status).toBe(
			ACCOUNT_CONTRACT.loginWithOldPasswordAfterChange,
		);
		expect((await login(me.email, "brand-new-password")).status).toBe(
			ACCOUNT_CONTRACT.loginWithNewPasswordAfterChange,
		);

		expect((await refresh(elsewhere.refreshToken)).status).toBe(
			ACCOUNT_CONTRACT.otherSessionsAfterPasswordChange,
		);
		expect((await refresh(me.refresh)).status).toBe(200);
	});

	it("deletes the account, its sessions and its address", async () => {
		const me = await account();

		const res = await createMockFetch()("/auth/account", {
			method: "DELETE",
			headers: { Authorization: `Bearer ${me.access}` },
		});
		expect(res.status).toBe(200);

		expect((await refresh(me.refresh)).status).toBe(
			ACCOUNT_CONTRACT.refreshAfterAccountDeleted,
		);
		expect((await login(me.email, "correct-horse-battery")).status).toBe(
			ACCOUNT_CONTRACT.loginAfterAccountDeleted,
		);
	});
});

// The shared half of the email flows - what both implementations answer without
// holding a token, since a token only exists inside an email neither side can
// read. The mock's token-dependent behavior lives in its own suite; apps/api
// pins the equivalent at the query level and in its round-trip suite.
describe("the mock's email flows", () => {
	let seq = 0;

	const post = (path: string, body: unknown, token?: string) =>
		createMockFetch()(path, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(body),
		});

	async function account(): Promise<{ email: string; access: string }> {
		seq += 1;
		const email = `mock-flow-${seq}@example.com`;
		const res = await post("/auth/signup", {
			email,
			password: "correct-horse-battery",
		});
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
		expect(await known.text()).toBe(await unknown.text());
	});

	it("reports an unknown reset token as not valid, without erroring", async () => {
		const res = await createMockFetch()(
			"/auth/reset-password/verify?token=invented",
			{ method: "GET" },
		);

		expect(res.status).toBe(EMAIL_FLOW_CONTRACT.verifyResetTokenStatus);
		expect(((await res.json()) as { valid: boolean }).valid).toBe(false);
	});

	it("rejects a reset with an unknown token", async () => {
		expect(
			(
				await post("/auth/reset-password", {
					token: "invented",
					password: "brand-new-password",
				})
			).status,
		).toBe(EMAIL_FLOW_CONTRACT.resetPasswordReplayed);
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

describe("the mock's machine credentials", () => {
	const call = createMockFetch();
	let owner: string;
	let stranger: string;

	function as(token: string, init: RequestInit = {}): RequestInit {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${token}`);
		if (init.body) headers.set("Content-Type", "application/json");
		return { ...init, headers };
	}

	async function mint(token: string, name: string) {
		return call(
			"/api/machines",
			as(token, { method: "POST", body: JSON.stringify({ name }) }),
		);
	}

	async function signup(email: string): Promise<string> {
		const response = await call("/auth/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: SEEDED_PASSWORD, name: "Grace" }),
		});
		// Asserted so a broken fixture reports itself once here rather than as
		// four confusing 401s downstream.
		expect(response.status, `fixture signup failed for ${email}`).toBe(201);
		return ((await response.json()) as { token: string }).token;
	}

	beforeAll(async () => {
		// Two fresh accounts, NOT the seeded one. The mock's machine store is
		// module state shared with the static cases above, and those run against
		// the seeded account - so an owner who is also that account makes this
		// block order-dependent on them. Task 2 paid for that lesson already:
		// nine cases sharing one account counted each other's machines.
		owner = await signup(freshEmail());
		stranger = await signup(freshEmail());
	});

	it("mints a token once and never shows it again", async () => {
		const created = await mint(owner, "work laptop");
		expect(created.status).toBe(MACHINE_LIFECYCLE.create);
		const createdBody = (await created.json()) as Record<string, unknown>;
		const { token } = createdBody as { token: string };
		expect(token.startsWith(MACHINE_LIFECYCLE.tokenPrefix)).toBe(true);
		// Pins the create response's field names, not just its status - a
		// rename here would blank TokenReveal's "the token for <name>" sentence
		// while every other check in this suite stayed green. Sorted because
		// object key order is not a promise either side has made.
		expect(Object.keys(createdBody).sort()).toEqual(
			[...MACHINE_LIFECYCLE.createFields].sort(),
		);

		const listBody = (await (
			await call("/api/machines", as(owner))
		).json()) as { machines: Array<Record<string, unknown>> };
		const serialized = JSON.stringify(listBody);
		expect(serialized.includes(token)).toBe(MACHINE_LIFECYCLE.tokenInList);
		expect(serialized.includes(MACHINE_LIFECYCLE.tokenPrefix)).toBe(
			MACHINE_LIFECYCLE.tokenInList,
		);

		const minted = listBody.machines.find((m) => m.id === createdBody.id);
		if (!minted) throw new Error("minted machine missing from its own list");
		// Pins the list response's field names, not just that `machines` is an
		// array. See MACHINE_LIFECYCLE.listFields for why nothing else in this
		// package catches a renamed select alias in listMachineTokens.
		expect(Object.keys(minted).sort()).toEqual(
			[...MACHINE_LIFECYCLE.listFields].sort(),
		);
	});

	it("rejects a name that is only whitespace", async () => {
		expect((await mint(owner, "   ")).status).toBe(MACHINE_LIFECYCLE.blankName);
	});

	it("revokes once and refuses a second time", async () => {
		const { id } = (await (await mint(owner, "stolen laptop")).json()) as {
			id: string;
		};
		expect(
			(await call(`/api/machines/${id}`, as(owner, { method: "DELETE" })))
				.status,
		).toBe(MACHINE_LIFECYCLE.revokeOwn);
		expect(
			(await call(`/api/machines/${id}`, as(owner, { method: "DELETE" })))
				.status,
		).toBe(MACHINE_LIFECYCLE.revokeTwice);
	});

	it("will not let one account revoke another's machine", async () => {
		const { id } = (await (await mint(owner, "shared name")).json()) as {
			id: string;
		};
		expect(
			(await call(`/api/machines/${id}`, as(stranger, { method: "DELETE" })))
				.status,
		).toBe(MACHINE_LIFECYCLE.revokeSomeoneElses);
	});
});
