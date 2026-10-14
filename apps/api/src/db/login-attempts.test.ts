import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	activeCooldownMs,
	clearLoginAttempts,
	cooldownFor,
	FREE_ATTEMPTS,
	loginAttemptKey,
	MAX_COOLDOWN_MS,
	recordLoginFailure,
} from "./login-attempts.js";

const MINUTE = 60_000;
const db = () => env.DB;

beforeEach(async () => {
	await db().prepare("DELETE FROM login_attempts").run();
});

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

describe("recordLoginFailure", () => {
	it("charges nothing for the first four and a minute for the fifth", async () => {
		const key = await loginAttemptKey("ada@example.com");

		for (let i = 0; i < 4; i++) {
			expect(await recordLoginFailure(db(), key)).toBe(0);
		}

		expect(await recordLoginFailure(db(), key)).toBe(1 * MINUTE);
	});

	// The reason this is one statement. Two concurrent failures that each read
	// the count, add one, and write it back would land as one.
	it("counts two simultaneous failures as two", async () => {
		const key = await loginAttemptKey("ada@example.com");

		await Promise.all([
			recordLoginFailure(db(), key),
			recordLoginFailure(db(), key),
		]);

		const row = await db()
			.prepare("SELECT fails FROM login_attempts WHERE key = ?")
			.bind(key)
			.first<{ fails: number }>();
		expect(row?.fails).toBe(2);
	});

	it("counts each address separately", async () => {
		const ada = await loginAttemptKey("ada@example.com");
		const bob = await loginAttemptKey("bob@example.com");

		for (let i = 0; i < 5; i++) await recordLoginFailure(db(), ada);

		expect(await activeCooldownMs(db(), bob)).toBe(0);
	});

	it("keys on the address case-insensitively, after trimming", async () => {
		expect(await loginAttemptKey("  Ada@Example.com ")).toBe(
			await loginAttemptKey("ada@example.com"),
		);
	});
});

describe("activeCooldownMs", () => {
	it("is zero for an address nobody has failed against", async () => {
		const key = await loginAttemptKey("new@example.com");

		expect(await activeCooldownMs(db(), key)).toBe(0);
	});

	it("counts down from the last failure", async () => {
		const key = await loginAttemptKey("ada@example.com");
		const start = new Date("2026-10-14T12:00:00.000Z");
		for (let i = 0; i < 5; i++) await recordLoginFailure(db(), key, start);

		// Forty seconds into a sixty second cooldown.
		const waited = new Date(start.getTime() + 40_000);
		expect(await activeCooldownMs(db(), key, waited)).toBe(20_000);
	});

	it("is zero once the cooldown has run out", async () => {
		const key = await loginAttemptKey("ada@example.com");
		const start = new Date("2026-10-14T12:00:00.000Z");
		for (let i = 0; i < 5; i++) await recordLoginFailure(db(), key, start);

		const later = new Date(start.getTime() + 61_000);
		expect(await activeCooldownMs(db(), key, later)).toBe(0);
	});
});

describe("clearLoginAttempts", () => {
	// Otherwise yesterday's four typos add to today's, and somebody who has
	// signed in successfully since is one mistake from a cooldown.
	it("forgets the run entirely", async () => {
		const key = await loginAttemptKey("ada@example.com");
		for (let i = 0; i < 5; i++) await recordLoginFailure(db(), key);

		await clearLoginAttempts(db(), key);

		expect(await activeCooldownMs(db(), key)).toBe(0);
		expect(await recordLoginFailure(db(), key)).toBe(0);
	});
});
