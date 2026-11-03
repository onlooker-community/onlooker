# Reset Reserve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep most of the day's reset mail for established accounts, so a burst of fresh free accounts can't lock everyone out until midnight.

**Architecture:** The reset pool splits into two counters in `mail_sends`. `claimMailSend` takes an `established` flag on resets, claims the reserve, and spills into the open share. `handleForgotPassword` derives the flag from the user row it already reads. Alerting is per pool.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, vitest.

Spec: `docs/superpowers/specs/2026-11-02-reset-reserve-design.md`. Linear: ONL-229.

## Global Constraints

- `RESET_POOLS = { reserved: 35, open: 10 }`, summing to `DAILY_MAIL_CEILINGS.reset` (45). `DAILY_MAIL_CEILINGS` doesn't change.
- Established: `email_verified` is not null, or `created_at` is at least 7 days before now.
- An established reset claims the reserve, then spills into the open share. Any other reset claims the open share only. The per-address caps (3 an hour, 6 a day) still come first, unchanged.
- Day keys: `global:reset-reserved:YYYY-MM-DD` and `global:reset-open:YYYY-MM-DD`. Verify and invite keys don't change.
- forgot-password answers the same 200, `{"success":true}`, on every path.
- Each pool raises one Sentry issue per UTC day, fingerprinted `["mail_global_ceiling", <pool>]`. Pools: `reset-reserved`, `reset-open`, `verify`, `invite`. The verify and invite fingerprints stay what they are today.
- Log lines stay `{ event, kind }` plus, for a pool refusal, `pool`. Never an address or a user id.
- Tests: run one file with `pnpm --filter @onlooker/api test <name>`, with **no `--`**. The Workers pool does not apply `vi.mock`; `email/cap.ts` takes injectable deps for that reason.
- Edit tracked files with Edit/Write, never `sed -i`, heredocs, `biome format --write` or `lint:fix`.
- Commits: `<type>(<scope>): <subject> :emoji:`, subject at most 72 characters counting the shortcode, American English, a why-focused body, `Refs ONL-229`.

---

### Task 1: The reset pool splits

**Files:**
- Modify: `apps/api/src/db/mail-sends.ts`, `apps/api/src/email/cap.ts`
- Test: `apps/api/src/db/mail-sends.test.ts`, `apps/api/src/email/cap.test.ts`

**Interfaces:**
- Produces:
  - `RESET_POOLS`, `ESTABLISHED_AGE_MS`, `type MailPool = "reset-reserved" | "reset-open" | "verify" | "invite"`
  - `isEstablished(user: { email_verified: string | null; created_at: string }, now: Date): boolean`
  - `globalMailKey(pool: MailPool, now: Date): string`
  - `claimMailSend(db, "reset", address, { established: boolean; now?: Date })`
  - `MailClaim`'s global refusal carries `pool: MailPool`, and every reset claim, sent or refused, may carry `reserveSpent: true`
  - `reportMailClaim(claim, kind, deps?)` in `email/cap.ts`, replacing `reportMailRefusal`

- [ ] **Step 1: Write the failing tests**

In `mail-sends.test.ts`, update the existing reset calls to pass `{ established: true, now }` (or `false` where the test is about a fresh account), and the existing pool tests to seed `globalMailKey("reset-open", …)` or `("reset-reserved", …)` as their meaning requires. Then add:

```ts
describe("the reset reserve", () => {
	it("splits the reset pool without changing its total", () => {
		expect(RESET_POOLS).toEqual({ reserved: 35, open: 10 });
		expect(RESET_POOLS.reserved + RESET_POOLS.open).toBe(
			DAILY_MAIL_CEILINGS.reset,
		);
	});

	it("lets fresh accounts spend only the open share", async () => {
		await seed(globalMailKey("reset-open", T0), T0, RESET_POOLS.open);

		expect(
			await claimMailSend(db(), "reset", "fresh@example.com", {
				established: false,
				now: T0,
			}),
		).toMatchObject({ ok: false, scope: "global", pool: "reset-open" });
		expect(
			(
				await claimMailSend(db(), "reset", ADA, {
					established: true,
					now: T0,
				})
			).ok,
		).toBe(true);
	});
	// …
});
```

and, in the same `describe`:

1. A fresh account's claim doesn't touch the reserve's counter.
2. An established claim counts against the reserve and not the open share while the reserve has room.
3. With the reserve spent, an established claim spills: it succeeds, counts against both, and the first spill of the day carries `reserveSpent: true`. The second spill doesn't.
4. With both spent, an established claim is refused with `pool: "reset-open"`. If that request is also the reserve's first refusal, it carries `reserveSpent: true` too.
5. An address refused by its hourly or daily cap spends no pool slot in either pool.
6. `globalMailKey("reset-reserved", …)` and `("reset-open", …)` are `global:reset-reserved:<date>` and `global:reset-open:<date>`. Verify and invite keys are unchanged.

For `isEstablished`, beside it:

1. Verified and created now: established.
2. Unverified and created exactly 7 days ago: established. 6 days, 23 hours: not.
3. `created_at` in SQLite's `YYYY-MM-DD HH:MM:SS` form is read as UTC, so `"2026-10-24 12:00:00"` is exactly 7 days before `T0`.
4. An unparsable `created_at` on an unverified account is not established.

In `cap.test.ts`:

1. A refusal from the open pool alerts once, with fingerprint `["mail_global_ceiling", "reset-open"]`, tags `kind: "mail_global_ceiling"` and `mail_pool: "reset-open"`, and `mail_kind: "reset"`.
2. A claim with `reserveSpent: true`, sent or refused, alerts once with fingerprint `["mail_global_ceiling", "reset-reserved"]`.
3. A refused claim with `reserveSpent` and a first open refusal raises both.
4. A successful claim with no `reserveSpent` logs and raises nothing.
5. Verify and invite pool alerts keep their current fingerprints.
6. The log line carries `pool` for a pool refusal and no address.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @onlooker/api test mail-sends`, `pnpm --filter @onlooker/api test cap`
Expected: FAIL.

- [ ] **Step 3: Implement the policy**

In `apps/api/src/db/mail-sends.ts`:

```ts
/**
 * The reset pool, split (ONL-229). Accounts are free and signup sends no mail,
 * so a burst of fresh accounts at six resets each could spend all 45, and
 * every locked-out user after that gets a silent 200 until midnight. Fresh
 * accounts share 10. Established ones have 35 to themselves, and spill into
 * the 10 when it runs out, so they are never worse off than with one pool.
 */
export const RESET_POOLS = { reserved: 35, open: 10 } as const;

/** How old an unverified account must be to count as established. */
export const ESTABLISHED_AGE_MS = 7 * DAY_MS;

/** A counter that refuses mail once a day's ceiling is spent. */
export type MailPool = "reset-reserved" | "reset-open" | "verify" | "invite";
```

`isEstablished`:

```ts
/**
 * Whether an account is costly enough to fake in bulk to draw on the reset
 * reserve: a verified address, which needs a real inbox and a verify send, or
 * a week of age, which needs planning.
 *
 * `created_at` is ISO from createUser but SQLite's `CURRENT_TIMESTAMP` form,
 * with no zone, from the column default. Both are UTC; the second is said so
 * rather than left to Date's guess. Unparsable means not established.
 */
export function isEstablished(
	user: { email_verified: string | null; created_at: string },
	now: Date,
): boolean {
	if (user.email_verified !== null) return true;
	const iso = /[zZ]|[+-]\d\d:\d\d$/.test(user.created_at)
		? user.created_at
		: `${user.created_at.replace(" ", "T")}Z`;
	const created = Date.parse(iso);
	return (
		!Number.isNaN(created) && now.getTime() - created >= ESTABLISHED_AGE_MS
	);
}
```

Change `globalMailKey` to take a `MailPool`. Change `MailClaim`:

```ts
export type MailClaim =
	| { ok: true; reserveSpent?: true }
	| { ok: false; scope: "address" | "inviter"; retryAfterMs: number }
	| {
			ok: false;
			scope: "global";
			pool: MailPool;
			first: boolean;
			retryAfterMs: number;
			reserveSpent?: true;
	  };
```

and document `reserveSpent`: set on the one reset claim a day that first finds the reserve spent, whatever it then gets from the open share, so the reserve alerts exactly once.

Change the reset overload's options to `{ established: boolean; now?: Date }`. Replace the pool step at the end of `claimMailSend` with a helper that counts one pool:

```ts
async function claimPool(
	db: D1Database,
	pool: MailPool,
	ceiling: number,
	now: Date,
): Promise<{ ok: boolean; first: boolean }> {
	const sent = await countSend(db, globalMailKey(pool, now), DAY_MS, now);
	return { ok: sent.count <= ceiling, first: sent.count === ceiling + 1 };
}
```

and, for a reset:

```ts
	let reserveSpent = false;
	if (kind === "reset" && options.established) {
		const reserve = await claimPool(db, "reset-reserved", RESET_POOLS.reserved, now);
		if (reserve.ok) return { ok: true };
		reserveSpent = reserve.first;
	}
	const pool: MailPool = kind === "reset" ? "reset-open" : kind;
	const ceiling = kind === "reset" ? RESET_POOLS.open : DAILY_MAIL_CEILINGS[kind];
	const claimed = await claimPool(db, pool, ceiling, now);
	const spent = reserveSpent ? { reserveSpent: true as const } : {};
	if (claimed.ok) return { ok: true, ...spent };
	return {
		ok: false,
		scope: "global",
		pool,
		first: claimed.first,
		retryAfterMs: msUntilNextUtcMidnight(now),
		...spent,
	};
```

Update `claimMailSend`'s doc comment for the reserve and the spill, and `DAILY_MAIL_CEILINGS`' comment to point at `RESET_POOLS`.

- [ ] **Step 4: Implement the alerting**

In `apps/api/src/email/cap.ts`, replace `reportMailRefusal` with `reportMailClaim(claim: MailClaim, kind: MailKind, deps = realDeps)`:

- A refusal logs `{ event, kind }` as today, plus `pool` when the scope is global.
- A global refusal with `first` raises for its `pool`.
- Any claim with `reserveSpent` raises for `reset-reserved`.
- A successful claim with nothing to report does nothing.

One raise helper, so every pool's alert has the same shape:

```ts
	deps.monitor.captureException(
		new Error(
			`mail: the daily ${pool} pool of ${POOL_CEILINGS[pool]} sends is spent; ${CONSEQUENCES[pool]}`,
		),
		{
			tags: { kind: "mail_global_ceiling", mail_kind: kind, mail_pool: pool },
			fingerprint: ["mail_global_ceiling", pool],
		},
	);
```

where `POOL_CEILINGS` maps `reset-reserved` and `reset-open` to `RESET_POOLS`, and `verify` and `invite` to `DAILY_MAIL_CEILINGS`. `CONSEQUENCES` says what happens until UTC midnight:

- `reset-reserved`: established accounts now share the open pool.
- `reset-open`: resets for new, unverified accounts are refused.
- `verify` and `invite`: as today.

Update the doc comment, which says only a pool pages anybody, to cover the reserve.

Update the two existing callers, `handleResendVerification` and the invite route, from `reportMailRefusal(claim, kind)` to `reportMailClaim(claim, kind)` inside their existing `if (!claim.ok)` branches. `mailRateLimitError` is unchanged.

- [ ] **Step 5: Run everything this task touches**

Run: `pnpm --filter @onlooker/api test mail-sends`, `pnpm --filter @onlooker/api test cap`, `pnpm --filter @onlooker/api test invite`, `pnpm typecheck`, `pnpm --filter @onlooker/api lint`.
Expected: PASS. Typecheck fails in `handleForgotPassword` until Task 2 passes `established`; if it does, pass `established: false` there for this commit only and say so in the report.

- [ ] **Step 6: Commit**

```
feat(api): reserve most reset mail for established accounts :shield:

Fresh free accounts could spend all 45 resets, and every locked-out user
after them got a silent 200 until midnight.

Refs ONL-229
```

---

### Task 2: forgot-password knows who is established

**Files:**
- Modify: `apps/api/src/routes/account.ts`
- Test: `apps/api/src/routes/mail-cap.test.ts`

**Interfaces:**
- Consumes: `isEstablished`, `claimMailSend(db, "reset", address, { established })`, `reportMailClaim` from Task 1.

- [ ] **Step 1: Write the failing tests**

In `mail-cap.test.ts`'s `POST /auth/forgot-password under the cap` block, using the file's helpers. Set `created_at` and `email_verified` on the account with a direct `UPDATE users`:

1. `"sends a reset to an established account while fresh accounts have spent the open share"`: seed `reset-open` at 10. An account created 8 days ago gets a reset token. So does a verified account created now.
2. `"sends nothing to a fresh account once the open share is spent, and answers exactly as a send"`: seed `reset-open` at 10. A fresh unverified account gets no token and the same 200 body.
3. `"spills an established account into the open share once the reserve is spent"`: seed `reset-reserved` at 35. An established account still gets a token.
4. `"sends nothing to anyone once both are spent, and answers exactly as a send"`.
5. Update `spendThePool("reset")`, and the existing `"sends nothing once the reset pool is spent"` test, so it means both pools. Read the helper first.
6. The unregistered-address test still writes no counter, in either pool.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @onlooker/api test mail-cap`
Expected: FAIL on 1 and 3.

- [ ] **Step 3: Pass it through**

In `handleForgotPassword`:

```ts
		// A user row already read, so this costs no query. See isEstablished
		// for why these two facts, and the reset reserve for what they buy.
		const claim = await claimMailSend(env.DB, "reset", user.email, {
			established: isEstablished(user, new Date()),
		});
		reportMailClaim(claim, "reset");
		if (!claim.ok) return jsonResponse({ success: true });
```

Keep the existing comment above it. `reportMailClaim` now runs on success too, because a send that spilled is how the reserve's alert is raised.

- [ ] **Step 4: Run the full checks**

Run: `pnpm --filter @onlooker/api test mail-cap`, then `pnpm test`, `pnpm typecheck`, `pnpm lint`, `bash scripts/source-guards.test.sh`.
Expected: all pass. Fix any formatting by hand with Edit.

- [ ] **Step 5: Commit**

```
feat(api): give established accounts the reset reserve :key:

The row forgot-password already reads says whether an account is verified
or a week old. Nothing about the answer changes, so the route still says
nothing about which accounts exist.

Refs ONL-229
```
