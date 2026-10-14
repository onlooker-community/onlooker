import { describe, expect, it } from "vitest";
import {
	cooldownFor,
	FREE_ATTEMPTS,
	MAX_COOLDOWN_MS,
} from "./login-attempts.js";

const MINUTE = 60_000;

describe("cooldownFor", () => {
	// Four free attempts is the whole reason a legitimate user who mistypes
	// twice is never delayed. If this boundary moves, that promise moves.
	it("charges nothing for the first four failures", () => {
		expect(cooldownFor(1)).toBe(0);
		expect(cooldownFor(FREE_ATTEMPTS)).toBe(0);
	});

	it("doubles from one minute once the threshold is crossed", () => {
		expect(cooldownFor(5)).toBe(1 * MINUTE);
		expect(cooldownFor(6)).toBe(2 * MINUTE);
		expect(cooldownFor(7)).toBe(4 * MINUTE);
		expect(cooldownFor(8)).toBe(8 * MINUTE);
		expect(cooldownFor(9)).toBe(16 * MINUTE);
	});

	it("caps at thirty minutes however long the run gets", () => {
		expect(cooldownFor(10)).toBe(MAX_COOLDOWN_MS);
		expect(cooldownFor(50)).toBe(MAX_COOLDOWN_MS);
		// Doubling without a cap reaches centuries by fails=60, which is both
		// absurd and a denial of service against the account's real owner.
		expect(cooldownFor(500)).toBe(MAX_COOLDOWN_MS);
	});

	it("treats a nonsense count as no cooldown rather than a negative one", () => {
		expect(cooldownFor(0)).toBe(0);
		expect(cooldownFor(-3)).toBe(0);
	});
});
