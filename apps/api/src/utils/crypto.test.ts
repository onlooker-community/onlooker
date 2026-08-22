import { describe, expect, it } from "vitest";
import { generateRefreshToken } from "./crypto.js";

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
