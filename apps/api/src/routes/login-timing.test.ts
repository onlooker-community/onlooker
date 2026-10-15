import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { call, resetOrgTables, signup } from "../test-support/orgs.js";

// handleLogin answers an unknown address immediately and spends bcrypt at cost
// 10 on a known one. The 401 body is identical either way, deliberately, so the
// response hides what the clock reveals: anybody who times two requests learns
// which addresses have accounts. onlooker-9s0m.1.
//
// Measured rather than mocked, because this pool leaves nothing else.
// @cloudflare/vitest-pool-workers does not apply vi.mock, so a test cannot
// count bcrypt calls (see the note atop login-backoff.test.ts), and
// bcrypt.compare answers `false` for a non-hash rather than throwing, so
// corrupting a stored hash cannot distinguish "never ran" from "ran and
// declined". The clock is the thing the attacker reads, so the clock is what
// this asserts on.
//
// A RATIO, not a millisecond budget: the absolute cost of bcryptjs varies by
// an order of magnitude between a laptop and a CI runner, but it varies the
// same way for both paths, so their ratio is the stable quantity. The floor
// assertion below keeps that ratio honest - two paths that both cost nothing
// also have a ratio of 1.

const db = () => env.DB;
const KNOWN = "ada@example.com";
const UNKNOWN = "nobody@example.com";
const WRONG = "not-the-password";

const login = (email: string) =>
	call("/auth/login", null, {
		method: "POST",
		body: JSON.stringify({ email, password: WRONG }),
	});

/**
 * Wall time of one refused sign-in, with the attempt counter cleared first.
 *
 * The clear matters: five consecutive failures trip the cooldown, and the
 * cooldown gate returns before bcrypt. A measurement taken under an active
 * cooldown would read the gate's cost, not the password check's.
 */
async function timeRefusal(email: string): Promise<number> {
	await db().prepare("DELETE FROM login_attempts").run();

	const started = performance.now();
	const response = await login(email);
	const elapsed = performance.now() - started;

	expect(response.status).toBe(401);
	return elapsed;
}

/** Median of three, so one scheduling hiccup cannot decide the result. */
async function medianRefusal(email: string): Promise<number> {
	const runs: number[] = [];
	for (let i = 0; i < 3; i++) runs.push(await timeRefusal(email));
	return runs.sort((a, b) => a - b)[1];
}

beforeEach(async () => {
	await resetOrgTables();
	await db().prepare("DELETE FROM login_attempts").run();
	await signup(KNOWN);
	// Warm up. The first bcrypt call in an isolate pays JIT that later calls do
	// not, and whichever path ran first would wear that cost as a difference.
	await timeRefusal(KNOWN);
});

describe("POST /auth/login timing", () => {
	it("spends the same bcrypt cost on an address with no account", async () => {
		const known = await medianRefusal(KNOWN);
		const unknown = await medianRefusal(UNKNOWN);

		// The floor first: if the known-account path did not reach bcrypt, the
		// ratio below is comparing two cheap paths and would pass while proving
		// nothing. bcryptjs at cost 10 is pure JavaScript and has never come in
		// under this on any machine this suite runs on.
		expect(known).toBeGreaterThan(20);

		// Half, with the headroom spent on CI rather than on sensitivity.
		// Measured locally 2026-10-15: equalized, this ratio clears 0.9 three
		// runs out of three; unequalized it was 0.05, because the unknown path
		// skipped the whole ~100ms of bcrypt. Nothing real sits between those,
		// so the threshold only has to separate them.
		expect(unknown).toBeGreaterThan(known * 0.5);
	}, 30_000);
});
