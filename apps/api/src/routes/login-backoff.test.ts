import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it } from "vitest";
import { TEST_PASSWORD } from "../test-support/lessons.js";
import { call, resetOrgTables, signup } from "../test-support/orgs.js";
import type { WorkerEnv } from "../types";
import { handleLogin } from "./auth.js";

// Note for anyone adding a test here: this pool does not support vi.mock.
// Two attempts to count bcrypt calls from inside a test came back zero - once
// through SELF.fetch, which runs the worker's own module graph, and once on a
// direct handler call, where the factory still never ran. The gate's position
// relative to verifyPassword is therefore pinned in
// scripts/source-guards.test.sh, under "the login gate runs before bcrypt",
// which is what that file is for: invariants the Workers pool cannot check.

// handleLogin had no gate of any kind, and the only rate limiting the API has
// is one Cloudflare zone rule at 60 req/min per IP - the wrong unit for a
// login, and one an attacker answers by rotating addresses. onlooker-9s0m.
//
// What the curve and the statements do is pinned in db/login-attempts.test.ts.
// These cover what a caller actually gets.

const db = () => env.DB;
const REAL_ENV = env as unknown as WorkerEnv;
const EMAIL = "ada@example.com";
const WRONG = "not-the-password";

interface ErrorBody {
	success: false;
	error: { code: string; message: string };
}

beforeEach(async () => {
	await resetOrgTables();
	await db().prepare("DELETE FROM login_attempts").run();
	await signup(EMAIL);
});

const login = (email: string, password: string) =>
	call("/auth/login", null, {
		method: "POST",
		body: JSON.stringify({ email, password }),
	});

const failFourTimes = async (email: string) => {
	for (let i = 0; i < 4; i++) {
		expect((await login(email, WRONG)).status).toBe(401);
	}
};

describe("POST /auth/login under repeated failure", () => {
	it("answers 401 four times, then refuses with 429 and a Retry-After", async () => {
		await failFourTimes(EMAIL);

		const refused = await login(EMAIL, WRONG);

		expect(refused.status).toBe(429);
		expect(((await refused.json()) as ErrorBody).error.code).toBe(
			"rate_limit_exceeded",
		);
		// The difference between "back off" and "back off for this long".
		expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
	});

	// The cooldown is not a password check. Letting the correct password
	// through during one would make the cooldown an oracle for "that guess was
	// right", which is the opposite of the point.
	it("refuses the correct password while the cooldown is active", async () => {
		await failFourTimes(EMAIL);
		await login(EMAIL, WRONG);

		expect((await login(EMAIL, TEST_PASSWORD)).status).toBe(429);
	});

	it("lets a correct password through once the cooldown has expired", async () => {
		await failFourTimes(EMAIL);
		await login(EMAIL, WRONG);
		// Reaching into the row rather than waiting a minute: the cooldown is
		// derived from last_fail_at, so moving that back is the same thing as
		// time passing, and the suite stays fast.
		await db()
			.prepare("UPDATE login_attempts SET last_fail_at = ?")
			.bind(new Date(Date.now() - 120_000).toISOString())
			.run();

		expect((await login(EMAIL, TEST_PASSWORD)).status).toBe(200);
	});

	it("forgets the run after a successful sign-in", async () => {
		await failFourTimes(EMAIL);

		expect((await login(EMAIL, TEST_PASSWORD)).status).toBe(200);

		// Four more failures start from zero, so the fourth is still a 401
		// rather than a refusal.
		await failFourTimes(EMAIL);
	});

	// The test a later refactor is most likely to break by keying on user_id
	// for convenience. An address with no account must be counted and refused
	// exactly like one that exists, or the 429 becomes an oracle for which
	// addresses are real.
	it("refuses an address with no account identically", async () => {
		const unknown = "nobody@example.com";
		await failFourTimes(unknown);

		const refused = await login(unknown, WRONG);

		expect(refused.status).toBe(429);
		expect(((await refused.json()) as ErrorBody).error.code).toBe(
			"rate_limit_exceeded",
		);
	});

	it("counts each address separately", async () => {
		await failFourTimes(EMAIL);
		await login(EMAIL, WRONG);

		// A second address is untouched by the first one's run.
		expect((await login("bob@example.com", WRONG)).status).toBe(401);
	});

	// The property the whole keying scheme protects, asserted on the bytes
	// rather than the status: if the two 401s ever differ - a different
	// message, a details field on one - the response becomes an oracle for
	// which addresses have accounts, and no amount of counting hides it.
	it("answers an unknown address and a wrong password identically", async () => {
		const unknown = await login("nobody@example.com", WRONG);
		const wrong = await login(EMAIL, WRONG);

		expect(unknown.status).toBe(wrong.status);
		expect(await unknown.text()).toBe(await wrong.text());
	});

	// And the same at the threshold, which is the case the new 429 could break.
	it("answers both at the threshold identically", async () => {
		await failFourTimes("nobody@example.com");
		const unknown = await login("nobody@example.com", WRONG);
		await failFourTimes(EMAIL);
		const wrong = await login(EMAIL, WRONG);

		expect(unknown.status).toBe(429);
		expect(wrong.status).toBe(429);
		expect(await unknown.text()).toBe(await wrong.text());
	});

	// What this CAN check about D2: the refusal does not depend on the stored
	// hash being usable. A corrupted hash would answer 401 if the password
	// check ran and reached a verdict, so a 429 here says the handler answered
	// without consulting it.
	//
	// Weaker than "no bcrypt ran" - bcrypt.compare returns false for a
	// non-hash rather than throwing, so this cannot tell "never called" from
	// "called and returned false". The ordering itself is pinned in
	// scripts/source-guards.test.sh; see the note at the top of this file.
	it("refuses without consulting the stored hash", async () => {
		await failFourTimes(EMAIL);
		await login(EMAIL, WRONG);
		await db()
			.prepare("UPDATE users SET password_hash = 'not-a-bcrypt-hash'")
			.run();

		expect((await login(EMAIL, TEST_PASSWORD)).status).toBe(429);
	});
});

describe("POST /auth/login when the counter is unavailable", () => {
	// D6. A D1 failure must not lock every account out of the product, so the
	// backoff fails open and the zone rule still caps 60 req/min per IP
	// underneath.
	//
	// Injected at the binding rather than by dropping the table, the same way
	// account-deletion.test.ts forces its own race: the table is shared with
	// every other suite in this pool, and only the login_attempts statements
	// should break here - the user lookup still has to work.
	it("lets a correct password through", async () => {
		const brokenCounter = new Proxy(db(), {
			get(target, property, receiver) {
				if (property === "prepare") {
					return (sql: string) => {
						if (sql.includes("login_attempts")) {
							throw new Error("no such table: login_attempts");
						}
						return (target as D1Database).prepare(sql);
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as D1Database;

		const response = await handleLogin(
			new Request("https://api.onlooker.dev/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: EMAIL, password: TEST_PASSWORD }),
			}),
			{ ...REAL_ENV, DB: brokenCounter },
		);

		expect(response.status).toBe(200);
	});

	it("still refuses a wrong password, rather than failing open into a 200", async () => {
		const brokenCounter = new Proxy(db(), {
			get(target, property, receiver) {
				if (property === "prepare") {
					return (sql: string) => {
						if (sql.includes("login_attempts")) {
							throw new Error("no such table: login_attempts");
						}
						return (target as D1Database).prepare(sql);
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as D1Database;

		const thrown = await handleLogin(
			new Request("https://api.onlooker.dev/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: EMAIL, password: WRONG }),
			}),
			{ ...REAL_ENV, DB: brokenCounter },
		).then(
			() => null,
			(error: unknown) => error,
		);

		// Failing open means losing the counter, never losing the password
		// check. This is the test that would catch a catch-all wrapped around
		// the whole handler instead of around the two counter calls.
		expect((thrown as { status?: number })?.status).toBe(401);
	});
});
