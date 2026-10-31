import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	claimMailSend,
	DAILY_MAIL_CEILING,
	globalMailKey,
	MAIL_LIMITS,
	pruneMailSends,
} from "./mail-sends.js";

const db = () => env.DB;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Noon UTC, so "until midnight" is a round twelve hours.
const T0 = new Date("2026-10-31T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const ADA = "ada@example.com";

const seed = (key: string, windowStart: Date, count: number) =>
	db()
		.prepare(
			"INSERT INTO mail_sends (key, window_start, count) VALUES (?, ?, ?)",
		)
		.bind(key, windowStart.toISOString(), count)
		.run();

const countOf = async (key: string) =>
	(
		await db()
			.prepare("SELECT count FROM mail_sends WHERE key = ?")
			.bind(key)
			.first<{ count: number }>()
	)?.count;

beforeEach(async () => {
	await db().prepare("DELETE FROM mail_sends").run();
});

describe("the limits", () => {
	// The approved numbers (spec, "Decisions"). A change here is a policy
	// change and should be one on purpose.
	it("are the ones the design settled on", () => {
		expect(MAIL_LIMITS.reset).toEqual({ max: 3, windowMs: HOUR });
		expect(MAIL_LIMITS.verify).toEqual({ max: 3, windowMs: HOUR });
		expect(MAIL_LIMITS.invite).toEqual({ max: 3, windowMs: DAY });
		// Under Resend's free 100 a day, and 80 x 31 stays under its 3,000 a month.
		expect(DAILY_MAIL_CEILING).toBe(80);
	});
});

describe("claimMailSend, per address", () => {
	it("allows three resets an hour and refuses the fourth, saying how long to wait", async () => {
		for (let i = 0; i < 3; i++) {
			expect(await claimMailSend(db(), "reset", ADA, at(i * MINUTE))).toEqual({
				ok: true,
			});
		}

		expect(await claimMailSend(db(), "reset", ADA, at(10 * MINUTE))).toEqual({
			ok: false,
			scope: "address",
			retryAfterMs: 50 * MINUTE,
		});
	});

	it("starts a fresh window once the hour has passed", async () => {
		for (let i = 0; i < 3; i++) {
			await claimMailSend(db(), "reset", ADA, at(i * MINUTE));
		}

		expect(await claimMailSend(db(), "reset", ADA, at(HOUR))).toEqual({
			ok: true,
		});
	});

	// Per kind, so an inviter's 429 cannot reveal password-reset traffic to the
	// address - which would say it has an account here (spec, "Decisions").
	it("keeps a separate count for each kind of mail", async () => {
		for (let i = 0; i < 3; i++) {
			await claimMailSend(db(), "reset", ADA, T0);
		}

		expect(await claimMailSend(db(), "verify", ADA, T0)).toEqual({ ok: true });
		expect(await claimMailSend(db(), "invite", ADA, T0)).toEqual({ ok: true });
	});

	it("counts invites per day, not per hour", async () => {
		for (let i = 0; i < 3; i++) {
			await claimMailSend(db(), "invite", ADA, T0);
		}

		expect(await claimMailSend(db(), "invite", ADA, at(2 * HOUR))).toEqual({
			ok: false,
			scope: "address",
			retryAfterMs: 22 * HOUR,
		});
	});

	it("treats case and surrounding whitespace as the same address", async () => {
		await claimMailSend(db(), "reset", "Ada@Example.com", T0);
		await claimMailSend(db(), "reset", "  ada@example.com ", T0);
		await claimMailSend(db(), "reset", ADA, T0);

		expect((await claimMailSend(db(), "reset", "ADA@EXAMPLE.COM", T0)).ok).toBe(
			false,
		);
	});
});

describe("claimMailSend, the daily ceiling", () => {
	it("refuses every address once the day's ceiling is spent, until UTC midnight", async () => {
		await seed(globalMailKey(T0), T0, DAILY_MAIL_CEILING);

		expect(await claimMailSend(db(), "reset", "new@example.com", T0)).toEqual({
			ok: false,
			scope: "global",
			retryAfterMs: 12 * HOUR,
		});
	});

	it("lets the eightieth mail of the day through and refuses the eighty-first", async () => {
		await seed(globalMailKey(T0), T0, DAILY_MAIL_CEILING - 1);

		expect(await claimMailSend(db(), "reset", "a@example.com", T0)).toEqual({
			ok: true,
		});
		expect((await claimMailSend(db(), "reset", "b@example.com", T0)).ok).toBe(
			false,
		);
	});

	// Otherwise an attacker bombing one address would also spend the day's
	// ceiling for everybody else.
	it("does not spend a global slot on a refused address", async () => {
		for (let i = 0; i < 4; i++) {
			await claimMailSend(db(), "reset", ADA, T0);
		}

		expect(await countOf(globalMailKey(T0))).toBe(3);
	});

	it("keys the ceiling on the UTC date", () => {
		expect(globalMailKey(new Date("2026-10-31T23:59:59.000Z"))).toBe(
			"global:2026-10-31",
		);
		expect(globalMailKey(new Date("2026-11-01T00:00:00.000Z"))).toBe(
			"global:2026-11-01",
		);
	});
});

describe("pruneMailSends", () => {
	it("drops rows older than two days and keeps current ones", async () => {
		await seed("reset:old", new Date(T0.getTime() - 3 * DAY), 3);
		await seed("reset:fresh", T0, 1);

		expect(await pruneMailSends(db(), T0)).toBe(1);
		expect(await countOf("reset:old")).toBeUndefined();
		expect(await countOf("reset:fresh")).toBe(1);
	});
});
