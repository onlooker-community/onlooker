import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { loginAttemptKey } from "./login-attempts.js";
import {
	claimMailSend,
	DAILY_ADDRESS_LIMITS,
	DAILY_MAIL_CEILINGS,
	ESTABLISHED_AGE_MS,
	globalMailKey,
	INVITER_LIMIT,
	inviterMailKey,
	isEstablished,
	MAIL_LIMITS,
	pruneMailSends,
	RESET_POOLS,
	USER_RESET_LIMIT,
	userResetKey,
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
		expect(USER_RESET_LIMIT).toEqual({ max: 6, windowMs: DAY });
		expect(DAILY_ADDRESS_LIMITS).toEqual({
			reset: { max: 6, windowMs: DAY },
			verify: { max: 6, windowMs: DAY },
		});
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
				await claimMailSend(db(), "reset", ADA, {
					established: true,
					userId: ADA,
					now: at(i * MINUTE),
				}),
			).toEqual({
				ok: true,
			});
		}

		expect(
			await claimMailSend(db(), "reset", ADA, {
				established: true,
				userId: ADA,
				now: at(10 * MINUTE),
			}),
		).toEqual({
			ok: false,
			scope: "address",
			retryAfterMs: 50 * MINUTE,
		});
	});

	it("starts a fresh window once the hour has passed", async () => {
		for (let i = 0; i < 3; i++) {
			await claimMailSend(db(), "reset", ADA, {
				established: true,
				userId: ADA,
				now: at(i * MINUTE),
			});
		}

		expect(
			await claimMailSend(db(), "reset", ADA, {
				established: true,
				userId: ADA,
				now: at(HOUR),
			}),
		).toEqual({
			ok: true,
		});
		// The count restarted at one, so two more fit and the fourth does not.
		for (let i = 1; i <= 2; i++) {
			expect(
				await claimMailSend(db(), "reset", ADA, {
					established: true,
					userId: ADA,
					now: at(HOUR + i * MINUTE),
				}),
			).toEqual({ ok: true });
		}
		expect(
			await claimMailSend(db(), "reset", ADA, {
				established: true,
				userId: ADA,
				now: at(HOUR + 10 * MINUTE),
			}),
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
			await claimMailSend(db(), "reset", ADA, {
				established: true,
				userId: ADA,
				now: T0,
			});
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
		const options = { established: true, userId: ADA, now: T0 };
		await claimMailSend(db(), "reset", "Ada@Example.com", options);
		await claimMailSend(db(), "reset", "  ada@example.com ", options);
		await claimMailSend(db(), "reset", ADA, options);

		expect(
			(await claimMailSend(db(), "reset", "ADA@EXAMPLE.COM", options)).ok,
		).toBe(false);
	});
});

describe("claimMailSend, the daily pools", () => {
	it("refuses every address once a kind's pool is spent, until UTC midnight", async () => {
		await seed(globalMailKey("verify", T0), T0, DAILY_MAIL_CEILINGS.verify);

		expect(
			await claimMailSend(db(), "verify", "new@example.com", { now: T0 }),
		).toEqual({
			ok: false,
			scope: "global",
			pool: "verify",
			first: true,
			retryAfterMs: 12 * HOUR,
		});
	});

	// The reason for the change: invites must not spend the mail a locked-out
	// user needs (ONL-228).
	it("still sends a reset and a verify when the invite pool is spent", async () => {
		await seed(globalMailKey("invite", T0), T0, DAILY_MAIL_CEILINGS.invite);

		expect(
			await claimMailSend(db(), "reset", "a@example.com", {
				established: false,
				userId: "a@example.com",
				now: T0,
			}),
		).toEqual({ ok: true });
		expect(
			await claimMailSend(db(), "verify", "b@example.com", { now: T0 }),
		).toEqual({ ok: true });
	});

	// The atomic upsert hands limit + 1 to exactly one request per pool, so
	// each pool's first refusal of the day is the one that raises an issue.
	it.each([
		"reset-open",
		"verify",
		"invite",
	] as const)("lets the %s pool's last mail through, then marks only its first refusal as first", async (pool) => {
		const ceiling =
			pool === "reset-open" ? RESET_POOLS.open : DAILY_MAIL_CEILINGS[pool];
		await seed(globalMailKey(pool, T0), T0, ceiling - 1);
		const claim = (address: string) =>
			pool === "invite"
				? claimMailSend(db(), pool, address, { inviterId: OWNER, now: T0 })
				: pool === "verify"
					? claimMailSend(db(), pool, address, { now: T0 })
					: claimMailSend(db(), "reset", address, {
							established: false,
							userId: address,
							now: T0,
						});

		expect(await claim("a@example.com")).toEqual({ ok: true });
		expect(await claim("b@example.com")).toEqual({
			ok: false,
			scope: "global",
			pool,
			first: true,
			retryAfterMs: 12 * HOUR,
		});
		expect(await claim("c@example.com")).toEqual({
			ok: false,
			scope: "global",
			pool,
			first: false,
			retryAfterMs: 12 * HOUR,
		});
	});

	// Otherwise an attacker bombing one address would also spend the pool for
	// everybody else. The daily address cap below is what bounds one address's
	// share of the pool.
	it("does not spend a pool slot on a refused address", async () => {
		for (let i = 0; i < 4; i++) {
			await claimMailSend(db(), "reset", ADA, {
				established: false,
				userId: ADA,
				now: T0,
			});
		}

		expect(await countOf(globalMailKey("reset-open", T0))).toBe(3);
	});

	it("keys each pool on its name and the UTC date", () => {
		const late = new Date("2026-10-31T23:59:59.000Z");
		expect(globalMailKey("reset-reserved", late)).toBe(
			"global:reset-reserved:2026-10-31",
		);
		expect(globalMailKey("reset-open", late)).toBe(
			"global:reset-open:2026-10-31",
		);
		expect(globalMailKey("verify", late)).toBe("global:verify:2026-10-31");
		expect(globalMailKey("invite", new Date("2026-11-01T00:00:00.000Z"))).toBe(
			"global:invite:2026-11-01",
		);
	});
});

describe("the reset reserve", () => {
	const established = (address: string, now = T0) =>
		claimMailSend(db(), "reset", address, {
			established: true,
			userId: address,
			now,
		});
	const fresh = (address: string, now = T0) =>
		claimMailSend(db(), "reset", address, {
			established: false,
			userId: address,
			now,
		});

	it("splits the reset pool without changing its total", () => {
		expect(RESET_POOLS).toEqual({ reserved: 35, open: 10 });
		expect(RESET_POOLS.reserved + RESET_POOLS.open).toBe(
			DAILY_MAIL_CEILINGS.reset,
		);
	});

	it("lets fresh accounts spend only the open share", async () => {
		await seed(globalMailKey("reset-open", T0), T0, RESET_POOLS.open);

		expect(await fresh("fresh@example.com")).toMatchObject({
			ok: false,
			scope: "global",
			pool: "reset-open",
		});
		expect((await established(ADA)).ok).toBe(true);
	});

	it("does not touch the reserve's counter for a fresh account", async () => {
		await fresh(ADA);

		expect(await countOf(globalMailKey("reset-open", T0))).toBe(1);
		expect(await countOf(globalMailKey("reset-reserved", T0))).toBeUndefined();
	});

	it("counts an established claim against the reserve, not the open share", async () => {
		expect(await established(ADA)).toEqual({ ok: true });

		expect(await countOf(globalMailKey("reset-reserved", T0))).toBe(1);
		expect(await countOf(globalMailKey("reset-open", T0))).toBeUndefined();
	});

	it("spills into the open share once the reserve is spent, flagging only the first spill", async () => {
		await seed(globalMailKey("reset-reserved", T0), T0, RESET_POOLS.reserved);

		expect(await established("a@example.com")).toEqual({
			ok: true,
			reserveSpent: true,
		});
		expect(await established("b@example.com")).toEqual({ ok: true });
		expect(await countOf(globalMailKey("reset-reserved", T0))).toBe(
			RESET_POOLS.reserved + 2,
		);
		expect(await countOf(globalMailKey("reset-open", T0))).toBe(2);
	});

	it("refuses an established claim from the open pool when both are spent", async () => {
		await seed(globalMailKey("reset-reserved", T0), T0, RESET_POOLS.reserved);
		await seed(globalMailKey("reset-open", T0), T0, RESET_POOLS.open);

		// The reserve's first refusal rides on the request that also finds the
		// open share's first, so one request can raise both alerts.
		expect(await established("a@example.com")).toEqual({
			ok: false,
			scope: "global",
			pool: "reset-open",
			first: true,
			retryAfterMs: 12 * HOUR,
			reserveSpent: true,
		});
		expect(await established("b@example.com")).toEqual({
			ok: false,
			scope: "global",
			pool: "reset-open",
			first: false,
			retryAfterMs: 12 * HOUR,
		});
	});

	it("spends no slot in either pool on an address its own cap refuses", async () => {
		for (let i = 0; i < 4; i++) {
			await established(ADA, at(i * MINUTE));
		}

		expect(await countOf(globalMailKey("reset-reserved", T0))).toBe(3);
		expect(await countOf(globalMailKey("reset-open", T0))).toBeUndefined();
	});
});

// An account keeps its age through an email change, so the address caps
// alone let one aged account take six resets per address it can name.
describe("claimMailSend, the daily account cap", () => {
	const address = (i: number) => `ada-${i}@example.com`;
	const account = (i: number, userId = "user-ada-1") =>
		claimMailSend(db(), "reset", address(i), {
			established: true,
			userId,
			now: at(i * MINUTE),
		});

	it("refuses the seventh reset for one account across seven addresses, spending no pool slot", async () => {
		for (let i = 0; i < 6; i++) {
			expect(await account(i)).toEqual({ ok: true });
		}

		expect(await account(6)).toEqual({
			ok: false,
			scope: "address",
			retryAfterMs: DAY - 6 * MINUTE,
		});
		expect(await countOf(globalMailKey("reset-reserved", T0))).toBe(6);
		expect(await countOf(globalMailKey("reset-open", T0))).toBeUndefined();
	});

	it("keeps a separate count for each account", async () => {
		for (let i = 0; i < 6; i++) await account(i);

		expect((await account(7, "user-bob-1")).ok).toBe(true);
	});

	it("stores the account's id as it is, and starts a new window after 24 hours", async () => {
		expect(userResetKey("user-ada-1")).toBe("reset-user-day:user-ada-1");
		for (let i = 0; i < 6; i++) await account(i);

		expect(
			(
				await claimMailSend(db(), "reset", address(9), {
					established: true,
					userId: "user-ada-1",
					now: at(DAY),
				})
			).ok,
		).toBe(true);
	});

	it("will not compile a reset claim that does not name the account", () => {
		const unchecked = () =>
			// @ts-expect-error a reset claim must say whose account it is for
			claimMailSend(db(), "reset", ADA, { established: true, now: T0 });
		expect(unchecked).toBeTypeOf("function");
	});
});

describe("isEstablished", () => {
	it("counts a verified account, however new", () => {
		expect(
			isEstablished(
				{ email_verified: T0.toISOString(), created_at: T0.toISOString() },
				T0,
			),
		).toBe(true);
	});

	it("counts an unverified account at exactly seven days, not before", () => {
		const user = (age: number) => ({
			email_verified: null,
			created_at: new Date(T0.getTime() - age).toISOString(),
		});

		expect(ESTABLISHED_AGE_MS).toBe(7 * DAY);
		expect(isEstablished(user(7 * DAY), T0)).toBe(true);
		expect(isEstablished(user(7 * DAY - MINUTE), T0)).toBe(false);
		expect(isEstablished(user(6 * DAY + 23 * HOUR), T0)).toBe(false);
	});

	// The column default writes CURRENT_TIMESTAMP, which has no zone and is UTC.
	it("reads SQLite's zoneless created_at as UTC", () => {
		expect(
			isEstablished(
				{ email_verified: null, created_at: "2026-10-24 12:00:00" },
				T0,
			),
		).toBe(true);
		expect(
			isEstablished(
				{ email_verified: null, created_at: "2026-10-24 12:00:01" },
				T0,
			),
		).toBe(false);
	});

	it("does not count an unverified account whose created_at cannot be read", () => {
		expect(
			isEstablished({ email_verified: null, created_at: "not a date" }, T0),
		).toBe(false);
	});
});

// The hourly cap allows 72 a day, more than the whole 45-mail reset budget,
// so one address could spend it over 15 hours. Six a day bounds its share.
describe("claimMailSend, the daily address cap", () => {
	const dayKey = async (kind: "reset" | "verify", address: string) =>
		`${kind}-day:${await loginAttemptKey(address)}`;

	// Three an hour, for `hours` hours, so the hourly window is never the limit.
	const claim = (kind: "reset" | "verify", now: Date) =>
		kind === "reset"
			? claimMailSend(db(), kind, ADA, {
					established: true,
					userId: ADA,
					now,
				})
			: claimMailSend(db(), kind, ADA, { now });

	const spendDay = async (kind: "reset" | "verify", sends: number) => {
		for (let i = 0; i < sends; i++) {
			const result = await claim(
				kind,
				at(Math.floor(i / 3) * HOUR + (i % 3) * MINUTE),
			);
			expect(result).toEqual({ ok: true });
		}
	};

	it.each([
		"reset",
		"verify",
	] as const)("refuses the seventh %s in a day across hours, though the hour is fresh, saying when the day ends", async (kind) => {
		await spendDay(kind, 6);

		// Hour 3: its own hourly window is fresh, so only the day can refuse.
		expect(await claim(kind, at(3 * HOUR))).toEqual({
			ok: false,
			scope: "address",
			retryAfterMs: DAY - 3 * HOUR,
		});
	});

	it("spends no pool slot on the refused seventh", async () => {
		await spendDay("reset", 6);

		await claim("reset", at(3 * HOUR));

		expect(await countOf(globalMailKey("reset-reserved", T0))).toBe(6);
	});

	it("counts verify separately from reset", async () => {
		await spendDay("reset", 6);

		expect(
			await claimMailSend(db(), "verify", ADA, { now: at(3 * HOUR) }),
		).toEqual({ ok: true });
	});

	// Narrowest first: an address the hour refused must not also lose a day slot.
	it("spends no daily slot on an hourly refusal", async () => {
		for (let i = 0; i < 4; i++) {
			await claim("reset", at(i * MINUTE));
		}

		expect(await countOf(await dayKey("reset", ADA))).toBe(3);
	});

	it("keys the day on the kind and the same hash as the hour", async () => {
		await claim("reset", T0);

		expect(await countOf(await dayKey("reset", ADA))).toBe(1);
	});

	it("starts a fresh day after 24 hours", async () => {
		await spendDay("reset", 6);

		expect(await claim("reset", at(DAY + MINUTE))).toEqual({ ok: true });
	});

	it("does not apply to invites, which are already three a day", async () => {
		await claimMailSend(db(), "invite", ADA, { inviterId: OWNER, now: T0 });

		expect(
			await countOf(`invite-day:${await loginAttemptKey(ADA)}`),
		).toBeUndefined();
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

	it("starts a fresh window for an inviter after 24 hours", async () => {
		for (let i = 0; i < 10; i++) {
			await invite(`n${i}@example.com`, OWNER, T0);
		}
		expect((await invite("fresh@example.com", OWNER, at(HOUR))).ok).toBe(false);

		expect(await invite("fresh@example.com", OWNER, at(DAY + MINUTE))).toEqual({
			ok: true,
		});
		// The count restarted at one, so nine more fit and the eleventh does not.
		for (let i = 0; i < 9; i++) {
			expect(
				(await invite(`m${i}@example.com`, OWNER, at(DAY + 2 * MINUTE))).ok,
			).toBe(true);
		}
		expect(
			(await invite("late@example.com", OWNER, at(DAY + 3 * MINUTE))).ok,
		).toBe(false);
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

	// Never called: the assertion is `pnpm typecheck`. Each directive guards one
	// overload: the no-options call fails if `options` ever became optional, and
	// the options-object call fails if `inviterId` ever became optional. If
	// either did, its directive would be unused and typecheck would fail.
	it("will not compile an invite claim that does not name the inviter", () => {
		const unchecked = () => [
			// @ts-expect-error no options: an invite claim must say who is inviting
			claimMailSend(db(), "invite", ADA),
			// @ts-expect-error options without inviterId: it must say who is inviting
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
