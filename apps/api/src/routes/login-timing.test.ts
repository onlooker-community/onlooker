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

const median = (runs: number[]) =>
	[...runs].sort((a, b) => a - b)[Math.floor(runs.length / 2)];

/**
 * Both paths' timings, taken in alternating rounds rather than one path after
 * the other.
 *
 * Under a full parallel `pnpm test`, every other package competes for the
 * CPU, and that load comes in bursts. Timed back to back, a burst that covers
 * only the known-account samples moves the ratio by itself: measured
 * 2026-11-05, one of 13 full runs read known 123/139/140ms against unknown
 * 70/93/83ms, a ratio of 0.60 against a bar of 0.5. ONL-249. Interleaved, a
 * burst lands on both paths, and the median of five absorbs the round it
 * lands on. The order flips each round so neither path always goes first.
 */
async function interleavedRefusals(): Promise<{
	known: number[];
	unknown: number[];
}> {
	const known: number[] = [];
	const unknown: number[] = [];
	for (let i = 0; i < 5; i++) {
		if (i % 2 === 0) {
			known.push(await timeRefusal(KNOWN));
			unknown.push(await timeRefusal(UNKNOWN));
		} else {
			unknown.push(await timeRefusal(UNKNOWN));
			known.push(await timeRefusal(KNOWN));
		}
	}
	return { known, unknown };
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
		const samples = await interleavedRefusals();
		const known = median(samples.known);
		const unknown = median(samples.unknown);
		// Every sample, so a failure says which side moved.
		const seen = `known ${samples.known.map(Math.round).join("/")}ms, unknown ${samples.unknown.map(Math.round).join("/")}ms`;

		// The floor first: if the known-account path did not reach bcrypt, the
		// ratio below is comparing two cheap paths and would pass while proving
		// nothing. bcryptjs at cost 10 is pure JavaScript and has never come in
		// under this on any machine this suite runs on.
		expect(known, seen).toBeGreaterThan(20);

		// Half, with the headroom spent on CI rather than on sensitivity.
		// Measured locally 2026-10-15: equalized, this ratio clears 0.9 three
		// runs out of three; unequalized it was 0.05, because the unknown path
		// skipped the whole ~100ms of bcrypt. Nothing real sits between those,
		// so the threshold only has to separate them.
		expect(unknown, seen).toBeGreaterThan(known * 0.5);
	}, 30_000);
});
