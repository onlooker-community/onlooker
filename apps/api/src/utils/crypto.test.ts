import { describe, expect, it } from "vitest";
import { TEST_PASSWORD } from "../test-support/lessons.js";
import {
	decoyPasswordHash,
	generateRefreshToken,
	hashPassword,
	verifyPassword,
} from "./crypto.js";

describe("generateRefreshToken", () => {
	// The only assertion here that can catch the defect this task exists to fix.
	//
	// Predictability is not observable from output. An implementation that hex
	// encodes 32 bytes derived from Math.random() passes both behavioral tests
	// below - the format is right and the values do not repeat - while remaining
	// exactly as predictable as before. So the guard has to read the source.
	//
	// Function.prototype.toString() rather than readFileSync: apps/api's vitest
	// runs in the Cloudflare Workers pool, where node:fs throws
	// (node-internal:internal_fs_sync). toString() needs no filesystem and was
	// verified to return the real function body in that pool on 2026-08-22.
	//
	// Known limit: this sees only this function. Moving the randomness into a
	// helper would evade it. That is acceptable - the guard exists to catch a
	// revert of this specific function, not to prove the whole codebase clean.
	it("does not use Math.random", () => {
		expect(generateRefreshToken.toString()).not.toContain("Math.random");
	});

	it("draws from crypto.getRandomValues", () => {
		expect(generateRefreshToken.toString()).toContain("getRandomValues");
	});

	it("returns 64 hex characters, the same length as before", () => {
		expect(generateRefreshToken()).toMatch(/^[0-9a-f]{64}$/);
	});

	it("does not repeat", () => {
		const seen = new Set(
			Array.from({ length: 100 }, () => generateRefreshToken()),
		);

		expect(seen.size).toBe(100);
	});
});

// Exists so handleLogin can spend bcrypt on an address that has no account,
// and stop answering "no such account" on the clock. onlooker-9s0m.1; the
// behavior it serves is measured in routes/login-timing.test.ts.
describe("decoyPasswordHash", () => {
	// The cost is the whole point. A hash at cost 4 would equalize the two
	// paths at the wrong number and leave most of the difference intact, and
	// nothing else in the suite would notice - so this reads the real hasher's
	// cost rather than restating 10, and tracks it if it ever moves.
	it("carries the same bcrypt cost as a stored password", async () => {
		const cost = (hash: string) => hash.split("$").slice(0, 3).join("$");

		expect(cost(await decoyPasswordHash())).toBe(
			cost(await hashPassword(TEST_PASSWORD)),
		);
	});

	// A real hash of a discarded value, not a sentinel string: bcrypt.compare
	// has no defined answer for a non-hash, while a hash of something nobody
	// knows declines every guess. Same reasoning db/queries.ts records for the
	// anonymized account's unusable password.
	it("declines the guess it is handed", async () => {
		await expect(
			verifyPassword(TEST_PASSWORD, await decoyPasswordHash()),
		).resolves.toBe(false);
	});

	// Without the cache every refused sign-in pays a hash AND a compare, which
	// is twice the bcrypt the path is meant to spend.
	it("hashes once per isolate", async () => {
		expect(await decoyPasswordHash()).toBe(await decoyPasswordHash());
	});
});
