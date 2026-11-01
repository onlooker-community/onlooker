import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	claimMailSend,
	DAILY_MAIL_CEILINGS,
	globalMailKey,
	INVITER_LIMIT,
	inviterMailKey,
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
const OWNER = "user-owner-1";

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
		expect(DAILY_MAIL_CEILINGS).toEqual({ reset: 45, verify: 10, invite: 25 });
		expect(INVITER_LIMIT).toEqual({ max: 10, windowMs: DAY });
	});

	// Under Resend's free 100 a day, and 80 x 31 stays under its 3,000 a month.
	// Pinned as a sum so raising one pool visibly raises the total.
	it("keeps the pools at 80 a day in total", () => {
		const total = Object.values(DAILY_MAIL_CEILINGS).reduce((a, b) => a + b, 0);
		expect(total).toBe(80);
	});
});

describe("claimMailSend, per address", () => {
	it("allows three resets an hour and refuses the fourth, saying how long to wait", async () => {
		for (let i = 0; i < 3; i++) {
			expect(
				await claimMailSend(db(), "reset", ADA, { now: at(i * MINUTE) }),
			).toEqual({
				ok: true,
			});
		}

		expect(
			await claimMailSend(db(), "reset", ADA, { now: at(10 * MINUTE) }),
		).toEqual({
			ok: false,
			scope: "address",
			retryAfterMs: 50 * MINUTE,
		});
	});

	it("starts a fresh window once the hour has passed", async () => {
		for (let i = 0; i < 3; i++) {
			await claimMailSend(db(), "reset", ADA, { now: at(i * MINUTE) });
		}

		expect(await claimMailSend(db(), "reset", ADA, { now: at(HOUR) })).toEqual({
			ok: true,
		});
		// The count restarted at one, so two more fit and the fourth does not.
		for (let i = 1; i <= 2; i++) {
			expect(
				await claimMailSend(db(), "reset", ADA, {
					now: at(HOUR + i * MINUTE),
				}),
			).toEqual({ ok: true });
		}
		expect(
			await claimMailSend(db(), "reset", ADA, { now: at(HOUR + 10 * MINUTE) }),
		).toEqual({
			ok: false,
			scope: "address",
			retryAfterMs: 50 * MINUTE,
		});
	});

	// Per kind, so an inviter's 429 cannot reveal password-reset traffic to the
	// address - which would say it has an account here (spec, "Decisions").
	it("keeps a separate count for each kind of mail", async () => {
		for (let i = 0; i < 3; i++) {
			await claimMailSend(db(), "reset", ADA, { now: T0 });
		}

		expect(await claimMailSend(db(), "verify", ADA, { now: T0 })).toEqual({
			ok: true,
		});
		expect(
			await claimMailSend(db(), "invite", ADA, { inviterId: OWNER, now: T0 }),
		).toEqual({ ok: true });
	});

	it("counts invites per day, not per hour", async () => {
		for (let i = 0; i < 3; i++) {
			await claimMailSend(db(), "invite", ADA, { inviterId: OWNER, now: T0 });
		}

		expect(
			await claimMailSend(db(), "invite", ADA, {
				inviterId: OWNER,
				now: at(2 * HOUR),
			}),
		).toEqual({
			ok: false,
			scope: "address",
			retryAfterMs: 22 * HOUR,
		});
	});

	it("treats case and surrounding whitespace as the same address", async () => {
		await claimMailSend(db(), "reset", "Ada@Example.com", { now: T0 });
		await claimMailSend(db(), "reset", "  ada@example.com ", { now: T0 });
		await claimMailSend(db(), "reset", ADA, { now: T0 });

		expect(
			(await claimMailSend(db(), "reset", "ADA@EXAMPLE.COM", { now: T0 })).ok,
		).toBe(false);
	});
});

describe("claimMailSend, the daily pools", () => {
	it("refuses every address once a kind's pool is spent, until UTC midnight", async () => {
		await seed(globalMailKey("reset", T0), T0, DAILY_MAIL_CEILINGS.reset);

		expect(
			await claimMailSend(db(), "reset", "new@example.com", { now: T0 }),
		).toEqual({
			ok: false,
			scope: "global",
			first: true,
			retryAfterMs: 12 * HOUR,
		});
	});

	// The reason for the change: invites must not spend the mail a locked-out
	// user needs (ONL-228).
	it("still sends a reset and a verify when the invite pool is spent", async () => {
		await seed(globalMailKey("invite", T0), T0, DAILY_MAIL_CEILINGS.invite);

		expect(
			await claimMailSend(db(), "reset", "a@example.com", { now: T0 }),
		).toEqual({ ok: true });
		expect(
			await claimMailSend(db(), "verify", "b@example.com", { now: T0 }),
		).toEqual({ ok: true });
	});

	// The atomic upsert hands limit + 1 to exactly one request per pool, so
	// each pool's first refusal of the day is the one that raises an issue.
	it.each([
		"reset",
		"verify",
		"invite",
	] as const)("lets the %s pool's last mail through, then marks only its first refusal as first", async (kind) => {
		await seed(globalMailKey(kind, T0), T0, DAILY_MAIL_CEILINGS[kind] - 1);
		const claim = (address: string) =>
			kind === "invite"
				? claimMailSend(db(), kind, address, { inviterId: OWNER, now: T0 })
				: claimMailSend(db(), kind, address, { now: T0 });

		expect(await claim("a@example.com")).toEqual({ ok: true });
		expect(await claim("b@example.com")).toEqual({
			ok: false,
			scope: "global",
			first: true,
			retryAfterMs: 12 * HOUR,
		});
		expect(await claim("c@example.com")).toEqual({
			ok: false,
			scope: "global",
			first: false,
			retryAfterMs: 12 * HOUR,
		});
	});

	// Otherwise an attacker bombing one address would also spend the pool for
	// everybody else.
	it("does not spend a pool slot on a refused address", async () => {
		for (let i = 0; i < 4; i++) {
			await claimMailSend(db(), "reset", ADA, { now: T0 });
		}

		expect(await countOf(globalMailKey("reset", T0))).toBe(3);
	});

	it("keys each pool on its kind and the UTC date", () => {
		expect(globalMailKey("reset", new Date("2026-10-31T23:59:59.000Z"))).toBe(
			"global:reset:2026-10-31",
		);
		expect(globalMailKey("invite", new Date("2026-11-01T00:00:00.000Z"))).toBe(
			"global:invite:2026-11-01",
		);
	});
});

describe("claimMailSend, per inviter", () => {
	const invite = (address: string, inviterId: string, now: Date) =>
		claimMailSend(db(), "invite", address, { inviterId, now });

	it("allows ten invites a day from one inviter and refuses the eleventh, even to a fresh address", async () => {
		for (let i = 0; i < 10; i++) {
			expect(await invite(`n${i}@example.com`, OWNER, at(i * MINUTE))).toEqual({
				ok: true,
			});
		}

		expect(await invite("fresh@example.com", OWNER, at(2 * HOUR))).toEqual({
			ok: false,
			scope: "inviter",
			retryAfterMs: 22 * HOUR,
		});
	});

	it("counts each inviter separately", async () => {
		for (let i = 0; i < 10; i++) {
			await invite(`n${i}@example.com`, OWNER, T0);
		}

		expect(await invite("fresh@example.com", "user-owner-2", T0)).toEqual({
			ok: true,
		});
	});

	// Narrowest first: a capped inviter must not spend a victim address's
	// slots or the invite pool.
	it("writes no address row and no pool slot when it refuses an inviter", async () => {
		await seed(inviterMailKey(OWNER), T0, INVITER_LIMIT.max);

		expect((await invite("fresh@example.com", OWNER, T0)).ok).toBe(false);

		const rows = await db()
			.prepare("SELECT key FROM mail_sends WHERE key != ?")
			.bind(inviterMailKey(OWNER))
			.all<{ key: string }>();
		expect(rows.results).toEqual([]);
	});

	it("stores the inviter's id as it is", () => {
		expect(inviterMailKey("user-owner-1")).toBe("inviter:user-owner-1");
	});

	// Never called: the assertion is `pnpm typecheck`. If inviterId ever became
	// optional, these directives would be unused and typecheck would fail.
	it("will not compile an invite claim that does not name the inviter", () => {
		const unchecked = () => [
			// @ts-expect-error an invite claim must say who is inviting
			claimMailSend(db(), "invite", ADA),
			// @ts-expect-error an invite claim must say who is inviting
			claimMailSend(db(), "invite", ADA, { now: T0 }),
		];
		expect(unchecked).toBeTypeOf("function");
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
