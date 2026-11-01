# Mail Pools Per Kind and an Inviter Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the day's 80 mails into a pool per kind (reset 45, verify 10, invite 25) and cap each inviter at 10 invites a day, so invites can never spend the mail password resets depend on.

**Architecture:** All counting stays in `apps/api/src/db/mail-sends.ts`, in the existing `mail_sends` table: no migration. `claimMailSend` keeps one entry point. An invite claim must carry `inviterId`, which overloads enforce. Counters are claimed narrowest-first (inviter, address, pool), and each refusal stops before the next counter. `apps/api/src/email/cap.ts` learns the `inviter` scope, and tags Sentry with the pool's kind.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, vitest with `@cloudflare/vitest-pool-workers`.

Spec: `docs/superpowers/specs/2026-10-31-mail-pools-design.md`. Linear: ONL-228. Bead: `onlooker-sedc1h`.

## Global Constraints

- Pools per UTC day: `reset` 45, `verify` 10, `invite` 25. They sum to 80.
- `DAILY_MAIL_CEILING` becomes `DAILY_MAIL_CEILINGS: Record<MailKind, number>`.
- Keys: `<kind>:<sha256 of address>` (unchanged), `inviter:<user id>` (24-hour fixed window, limit 10, the id stored as it is), `global:<kind>:<UTC date>`.
- Claim order: inviter (invite only), then address, then the kind's pool. A refusal stops before the next counter.
- `MailClaim`:
  ```ts
  | { ok: true }
  | { ok: false; scope: "address" | "inviter"; retryAfterMs: number }
  | { ok: false; scope: "global"; first: boolean; retryAfterMs: number }
  ```
- Signatures: `claimMailSend(db, "invite", address, { inviterId, now? })` and `claimMailSend(db, "reset" | "verify", address, { now? })`. An invite without `inviterId` must not compile.
- The inviter 429 message is exactly: `You have sent too many invites today. Try again later.`
- Log events: `mail_address_capped`, `mail_inviter_capped`, `mail_global_ceiling`. Each line is `{ event, kind }` only, never an address or a user id.
- Sentry fires only on a pool's first refusal of the day, tagged `mail_kind: <kind>`. An inviter refusal never pages.
- forgot-password still answers its usual 200 on any refusal.
- Tests: `@cloudflare/vitest-pool-workers` does not apply `vi.mock`. Run one file with `pnpm --filter @onlooker/api test <name>`, with **no `--`**.
- Edit tracked files with the Edit/Write tools, never `sed -i`, heredocs, `biome format --write` or `lint:fix`. Fix formatting by hand with Edit.
- Commits: `<type>(<scope>): <subject> :emoji:`, subject ≤72 characters, American English, a why-focused body, `Refs ONL-228`.

---

### Task 1: Pools and the inviter counter

**Files:**
- Modify: `apps/api/src/db/mail-sends.ts`
- Modify: `apps/api/src/db/mail-sends.test.ts`
- Modify: `apps/api/src/routes/orgs-invites.ts:65-73`
- Modify: `apps/api/src/email/cap.ts` (the import and the Sentry message only)
- Modify: `apps/api/src/email/cap.test.ts` (one assertion on that message)
- Modify: `apps/api/src/routes/mail-cap.test.ts` (the `spendTheDaysCeiling` helper only, so the suite compiles)

**Interfaces:**
- Produces:
  - `DAILY_MAIL_CEILINGS: Record<MailKind, number>`
  - `INVITER_LIMIT: { max: 10; windowMs: DAY_MS }`
  - `globalMailKey(kind: MailKind, now: Date): string`, which returns `global:<kind>:YYYY-MM-DD`
  - `inviterMailKey(inviterId: string): string`, which returns `inviter:<id>`
  - `MailClaim` with the `"address" | "inviter"` scope
  - `claimMailSend` overloads, as in Global Constraints

- [ ] **Step 1: Rewrite the unit tests for the new shape**

In `apps/api/src/db/mail-sends.test.ts`:

1. Change the import to:

```ts
import {
	claimMailSend,
	DAILY_MAIL_CEILINGS,
	globalMailKey,
	INVITER_LIMIT,
	inviterMailKey,
	MAIL_LIMITS,
	pruneMailSends,
} from "./mail-sends.js";
```

2. Under `const ADA = "ada@example.com";`, add:

```ts
const OWNER = "user-owner-1";
```

3. Every existing call `claimMailSend(db(), KIND, ADDRESS, NOW)` passes `NOW` positionally. Rewrite each one as `claimMailSend(db(), KIND, ADDRESS, { now: NOW })`, and give each invite call the inviter too: `claimMailSend(db(), "invite", ADDRESS, { inviterId: OWNER, now: NOW })`.

4. Replace the `describe("the limits", …)` block with:

```ts
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
```

5. Replace the `describe("claimMailSend, the daily ceiling", …)` block with:

```ts
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
```

- [ ] **Step 2: Run the file and watch it fail**

Run: `pnpm --filter @onlooker/api test mail-sends`
Expected: FAIL. The new exports (`DAILY_MAIL_CEILINGS`, `INVITER_LIMIT`, `inviterMailKey`) are undefined.

- [ ] **Step 3: Implement the counters**

In `apps/api/src/db/mail-sends.ts`:

1. Replace the module doc comment's first line with:

```ts
 * The mail cap: per recipient for each kind of mail, per inviter, and a daily
 * pool for each kind.
```

and, after the existing `See docs/superpowers/specs/2026-10-31-mail-cap-design.md …` sentence, add:

```ts
 * docs/superpowers/specs/2026-10-31-mail-pools-design.md is why the day is
 * split into pools and invites are counted per inviter (ONL-228).
```

2. Replace the `DAILY_MAIL_CEILING` constant and its comment with:

```ts
/**
 * Each kind's mail, per UTC day. Resend's free tier allows 100 a day and
 * 3,000 a month; 80 in total leaves headroom under the first, and 80 x 31 =
 * 2,480 keeps under the second without a counter of its own.
 *
 * A pool per kind, so invites - which anyone can send, since accounts are
 * free - can never spend the mail a locked-out user needs, and no kind's
 * refusal moves with another kind's traffic. Resets get the most because a
 * locked-out user has no other way back in.
 */
export const DAILY_MAIL_CEILINGS: Record<MailKind, number> = {
	reset: 45,
	verify: 10,
	invite: 25,
};

/**
 * Invites one user may send per 24 hours, to any addresses. Without it one
 * owner spends the invite pool in nine calls and nobody else can invite until
 * midnight.
 */
export const INVITER_LIMIT = { max: 10, windowMs: DAY_MS };
```

3. Replace the `MailClaim` type with:

```ts
export type MailClaim =
	| { ok: true }
	| { ok: false; scope: "address" | "inviter"; retryAfterMs: number }
	| { ok: false; scope: "global"; first: boolean; retryAfterMs: number };
```

(Keep its doc comment, but change "the count one past the ceiling" to "each pool's count one past its limit".)

4. Replace `globalMailKey` with:

```ts
/** A kind's pool for the day. A new UTC date is a new key, so it never needs resetting. */
export function globalMailKey(kind: MailKind, now: Date): string {
	return `global:${kind}:${now.toISOString().slice(0, 10)}`;
}

/**
 * One inviter's counter. A user id is an opaque identifier, not an address,
 * so it is stored as it is rather than hashed.
 */
export function inviterMailKey(inviterId: string): string {
	return `inviter:${inviterId}`;
}
```

5. Add, above `claimMailSend`:

```ts
/** When the fixed window that `row` counts in ends, from `now`. */
function msUntilWindowEnds(
	row: { window_start: string },
	windowMs: number,
	now: Date,
): number {
	return new Date(row.window_start).getTime() + windowMs - now.getTime();
}
```

6. Replace `claimMailSend` (doc comment and body) with:

```ts
/**
 * Claim one send of `kind` to `address`, or answer why not.
 *
 * Narrowest counter first, and a refusal stops before the next, so a refusal
 * never spends a counter its caller does not own: a capped inviter spends no
 * victim address's slots and no pool slot, and a capped address spends no
 * pool slot. The reverse is not true: a refusal at the address has spent the
 * inviter's own slot, and one at the pool has spent the address's and the
 * inviter's.
 * A claim counts even if the send then fails, so a Resend outage cannot be
 * retried into a burst.
 *
 * An invite must name its inviter, and the overloads make leaving it out a
 * type error rather than an uncapped invite.
 */
export function claimMailSend(
	db: D1Database,
	kind: "invite",
	address: string,
	options: { inviterId: string; now?: Date },
): Promise<MailClaim>;
export function claimMailSend(
	db: D1Database,
	kind: "reset" | "verify",
	address: string,
	options?: { now?: Date },
): Promise<MailClaim>;
export async function claimMailSend(
	db: D1Database,
	kind: MailKind,
	address: string,
	options: { inviterId?: string; now?: Date } = {},
): Promise<MailClaim> {
	const now = options.now ?? new Date();

	if (kind === "invite") {
		if (!options.inviterId) {
			throw new Error("claimMailSend: an invite claim must name its inviter");
		}
		const sent = await countSend(
			db,
			inviterMailKey(options.inviterId),
			INVITER_LIMIT.windowMs,
			now,
		);
		if (sent.count > INVITER_LIMIT.max) {
			return {
				ok: false,
				scope: "inviter",
				retryAfterMs: msUntilWindowEnds(sent, INVITER_LIMIT.windowMs, now),
			};
		}
	}

	const limit = MAIL_LIMITS[kind];
	const mine = await countSend(
		db,
		`${kind}:${await loginAttemptKey(address)}`,
		limit.windowMs,
		now,
	);
	if (mine.count > limit.max) {
		return {
			ok: false,
			scope: "address",
			retryAfterMs: msUntilWindowEnds(mine, limit.windowMs, now),
		};
	}

	const ceiling = DAILY_MAIL_CEILINGS[kind];
	const pool = await countSend(db, globalMailKey(kind, now), DAY_MS, now);
	if (pool.count > ceiling) {
		return {
			ok: false,
			scope: "global",
			first: pool.count === ceiling + 1,
			retryAfterMs: msUntilNextUtcMidnight(now),
		};
	}

	return { ok: true };
}
```

- [ ] **Step 4: Update the callers and the reporter's constant**

In `apps/api/src/routes/orgs-invites.ts`, replace the claim block with:

```ts
	// After validation, so a refused or malformed invite spends nothing, and
	// before deletePendingInvitesFor, so a refusal leaves the pending invite -
	// and the link in the invitee's inbox - working. Counted per inviter and
	// per address across every org: anyone can create an org (ONL-222,
	// ONL-228).
	const claim = await claimMailSend(env.DB, "invite", email, {
		inviterId: userId,
	});
	if (!claim.ok) {
		reportMailRefusal(claim, "invite");
		throw mailRateLimitError(claim);
	}
```

The two calls in `apps/api/src/routes/account.ts` (`"verify"` and `"reset"`) need no change.

In `apps/api/src/email/cap.ts`, change the import from `DAILY_MAIL_CEILING` to `DAILY_MAIL_CEILINGS`. Change the Sentry message to:

```ts
				`mail: the daily ${kind} pool of ${DAILY_MAIL_CEILINGS[kind]} sends is spent; refusing ${kind} mail until UTC midnight`,
```

(Task 2 does the rest of `cap.ts`.) The message no longer says "ceiling", so in `apps/api/src/email/cap.test.ts`, in the test `"raises an issue when the day's ceiling first refuses"`, change `.toContain("ceiling")` to `.toContain("reset pool")`. Task 2 replaces that test anyway.

In `apps/api/src/routes/mail-cap.test.ts`, change the import to `import { DAILY_MAIL_CEILINGS, globalMailKey, type MailKind } from "../db/mail-sends.js";` and replace `spendTheDaysCeiling` with:

```ts
const spendThePool = (kind: MailKind) =>
	db()
		.prepare(
			"INSERT INTO mail_sends (key, window_start, count) VALUES (?, ?, ?)",
		)
		.bind(
			globalMailKey(kind, new Date()),
			new Date().toISOString(),
			DAILY_MAIL_CEILINGS[kind],
		)
		.run();
```

Its two callers become `await spendThePool("reset");` (in the forgot-password test) and `await spendThePool("invite");` (in the invites test). Change the forgot-password test's name to `"sends nothing once the reset pool is spent, and answers exactly as a send"` and the invite test's name to `"refuses an invite once the invite pool is spent"`.

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter @onlooker/api test mail-sends`
Expected: PASS.

Run: `pnpm --filter @onlooker/api test mail-cap`
Expected: PASS.

Run: `pnpm --filter @onlooker/api test cap`
Expected: PASS. This file pattern also matches `mail-cap.test.ts`.

Run: `pnpm --filter @onlooker/api typecheck`
Expected: no errors.

- [ ] **Step 6: Prove the `@ts-expect-error` test by ablation**

With Edit, temporarily change the invite overload's `options: { inviterId: string; now?: Date }` to `options: { inviterId?: string; now?: Date }`. Then run `pnpm --filter @onlooker/api typecheck`.
Expected: FAIL with `Unused '@ts-expect-error' directive` at both lines in `mail-sends.test.ts`.

Revert the change with Edit and re-run typecheck. Expected: no errors. Record both outputs in the report.

- [ ] **Step 7: Lint and commit**

Run: `pnpm --filter @onlooker/api lint`. Fix any formatting findings by hand with Edit, never `lint:fix`.

Commit `apps/api/src/db/mail-sends.ts`, `apps/api/src/db/mail-sends.test.ts`, `apps/api/src/routes/orgs-invites.ts`, `apps/api/src/email/cap.ts`, `apps/api/src/email/cap.test.ts` and `apps/api/src/routes/mail-cap.test.ts`, with a message like:

```
feat(api): give each kind of mail its own daily pool :jigsaw:

Invites could fill the shared 80 a day and lock every password reset out
until midnight. Each kind now has its own pool, and each inviter may send
ten invites a day, claimed before the address so a capped owner spends
nothing of anyone else's.

Refs ONL-228
```

---

### Task 2: Report and answer the inviter scope

**Files:**
- Modify: `apps/api/src/email/cap.ts`
- Modify: `apps/api/src/email/cap.test.ts`

**Interfaces:**
- Consumes: `MailClaim` with `scope: "address" | "inviter" | "global"`, and `DAILY_MAIL_CEILINGS`, both from Task 1.
- Produces: `reportMailRefusal(refusal, kind, deps?)` and `mailRateLimitError(refusal)`. The signatures don't change.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/email/cap.test.ts`:

1. Replace the test `"raises an issue when the day's ceiling first refuses"` with:

```ts
	// A pool refusing mail means legitimate mail of that kind is being refused
	// for the rest of the day. A per-address cap firing is the system working.
	it.each([
		"reset",
		"verify",
		"invite",
	] as const)("raises an issue, tagged with the kind, when the %s pool first refuses", (kind) => {
		const recorder = createRecordingMonitor();
		const { deps } = quiet(recorder);

		reportMailRefusal(
			{ ok: false, scope: "global", first: true, retryAfterMs: 1000 },
			kind,
			deps,
		);

		expect(recorder.exceptions).toHaveLength(1);
		expect((recorder.exceptions[0]?.error as Error).message).toContain(
			`${kind} pool`,
		);
		expect(recorder.exceptions[0]?.context?.tags).toEqual({
			kind: "mail_global_ceiling",
			mail_kind: kind,
		});
	});
```

2. After the `"raises nothing when one address is capped"` test, add:

```ts
	// The inviter cap firing is the cap working, as an address cap is.
	it("raises nothing and logs mail_inviter_capped when an inviter is capped", () => {
		const recorder = createRecordingMonitor();
		const { deps, lines } = quiet(recorder);

		reportMailRefusal(
			{ ok: false, scope: "inviter", retryAfterMs: 1000 },
			"invite",
			deps,
		);

		expect(recorder.exceptions).toHaveLength(0);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] as string)).toEqual({
			event: "mail_inviter_capped",
			kind: "invite",
		});
	});
```

3. In `describe("mailRateLimitError", …)`, add:

```ts
	// The owner can already see their own invites, so saying so leaks nothing.
	it("tells a capped inviter it is their invites, with the window's Retry-After", () => {
		const error = mailRateLimitError({
			ok: false,
			scope: "inviter",
			retryAfterMs: 22 * 60 * 60_000,
		});

		expect(error.status).toBe(429);
		expect(error.code).toBe("rate_limit_exceeded");
		expect(error.message).toBe(
			"You have sent too many invites today. Try again later.",
		);
		expect(error.headers).toEqual({ "Retry-After": String(22 * 60 * 60) });
	});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @onlooker/api test cap`
Expected: FAIL. There's no `mail_kind` tag, the inviter logs `mail_address_capped`, and the inviter gets the address message.

- [ ] **Step 3: Implement**

In `apps/api/src/email/cap.ts`, replace the body of `reportMailRefusal`, and the part of its doc comment from "Log every refusal" through "Every refusal still logs its line.", with:

```ts
/**
 * Log every refusal, and raise an issue on a pool's first refusal of the day.
 *
 * Only a pool pages anybody. A capped address or inviter is the cap working;
 * a spent pool means legitimate mail of that kind is being refused until UTC
 * midnight - possibly because someone holding many valid addresses is driving
 * forgot-password - and without this it would first surface as Resend
 * refusing to send. Tagged with the kind, so a full invite pool is told apart
 * from a full reset pool.
 *
 * Once per pool per UTC day, not once per refusal: a looped invite would
 * otherwise raise an event per request. Every refusal still logs its line.
 *
 * The line names the kind and never the address or the inviter.
 */
export function reportMailRefusal(
	refusal: MailRefusal,
	kind: MailKind,
	deps: MailCapDeps = realDeps,
): void {
	deps.log(JSON.stringify({ event: REFUSAL_EVENTS[refusal.scope], kind }));
	if (refusal.scope === "global" && refusal.first) {
		deps.monitor.captureException(
			new Error(
				`mail: the daily ${kind} pool of ${DAILY_MAIL_CEILINGS[kind]} sends is spent; refusing ${kind} mail until UTC midnight`,
			),
			{ tags: { kind: "mail_global_ceiling", mail_kind: kind } },
		);
	}
}
```

Above it, after `realDeps`, add:

```ts
const REFUSAL_EVENTS: Record<MailRefusal["scope"], string> = {
	address: "mail_address_capped",
	inviter: "mail_inviter_capped",
	global: "mail_global_ceiling",
};

const REFUSAL_MESSAGES: Record<MailRefusal["scope"], string> = {
	address: "Too many emails to this address. Try again later.",
	inviter: "You have sent too many invites today. Try again later.",
	global: "Too many emails are being sent right now. Try again later.",
};
```

In `mailRateLimitError`, replace the `refusal.scope === "global" ? … : …` message expression with `REFUSAL_MESSAGES[refusal.scope],`.

- [ ] **Step 4: Run them and watch them pass**

Run: `pnpm --filter @onlooker/api test cap`
Expected: PASS. This also runs `mail-cap.test.ts`.

Run: `pnpm --filter @onlooker/api typecheck`
Expected: no errors.

- [ ] **Step 5: Lint and commit**

Fix any lint findings with Edit. Commit `apps/api/src/email/cap.ts` and `apps/api/src/email/cap.test.ts`, with a message like:

```
feat(api): tell a capped inviter it is their own invites :mailbox_closed:

The inviter cap needs its own answer and log line, and a full pool needs to
say which kind is full, so Sentry tags it with the kind. An inviter refusal
does not page, for the reason an address refusal does not.

Refs ONL-228
```

---

### Task 3: The routes under the pools, and the docs

**Files:**
- Modify: `apps/api/src/routes/mail-cap.test.ts`
- Modify: `apps/api/DEPLOYMENT.md:319-328`
- Modify: `docs/superpowers/specs/2026-10-31-mail-cap-design.md:217-228`

**Interfaces:**
- Consumes: `spendThePool(kind)` (Task 1, in `mail-cap.test.ts`), `inviterMailKey`, `globalMailKey`, and the inviter 429 message (Task 2).

- [ ] **Step 1: Write the route tests**

In `apps/api/src/routes/mail-cap.test.ts`:

1. Extend the import to `import { DAILY_MAIL_CEILINGS, globalMailKey, inviterMailKey, type MailKind } from "../db/mail-sends.js";`.

2. Add this `describe` block after the resend-verification block:

```ts
// The reason for ONL-228: anyone can sign up and invite, so invites must not
// be able to spend the mail a locked-out user needs.
describe("a spent invite pool", () => {
	let ada: SignedUpUser;
	beforeEach(async () => {
		ada = await signup(ADA);
		await spendThePool("invite");
	});

	it("still sends a password reset", async () => {
		await post("/auth/forgot-password", { email: ADA });

		expect(await tokenHashes(ada.id, "reset")).toHaveLength(1);
	});

	it("still sends a verification mail", async () => {
		expect(
			(await post("/auth/resend-verification", {}, ada.token)).status,
		).toBe(200);
		expect(await tokenHashes(ada.id, "verify")).toHaveLength(1);
	});
});
```

3. In `describe("POST /api/orgs/:id/invites under the cap", …)`, add after the cross-org test:

```ts
	// Without it one owner spends the invite pool in nine calls (ONL-228).
	it("refuses an owner's eleventh invite of the day, even to a fresh address", async () => {
		for (let i = 0; i < 10; i++) {
			expect((await invite(orgId, `n${i}@example.com`)).status).toBe(201);
		}

		const refused = await invite(orgId, "fresh@example.com");

		expect(refused.status).toBe(429);
		const body = (await refused.json()) as ErrorBody;
		expect(body.error.code).toBe("rate_limit_exceeded");
		expect(body.error.message).toBe(
			"You have sent too many invites today. Try again later.",
		);
		expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect(await inviteHash("fresh@example.com")).toBeUndefined();
	});

	it("counts invites per owner, so a second owner can still invite", async () => {
		for (let i = 0; i < 10; i++) {
			await invite(orgId, `n${i}@example.com`);
		}
		const grace = await signup("grace@example.com", "Grace");
		const created = await post("/api/orgs", { name: "Grace's" }, grace.token);
		const graceOrg = ((await created.json()) as { org: { id: string } }).org
			.id;

		const response = await post(
			`/api/orgs/${graceOrg}/invites`,
			{ email: "fresh@example.com", role: "member" },
			grace.token,
		);

		expect(response.status).toBe(201);
	});

	// Narrowest first: a capped owner spends neither the address's slots nor
	// the pool.
	it("writes no address or pool count for an invite refused at the inviter", async () => {
		await db()
			.prepare(
				"INSERT INTO mail_sends (key, window_start, count) VALUES (?, ?, ?)",
			)
			.bind(inviterMailKey(ada.id), new Date().toISOString(), 10)
			.run();

		expect((await invite(orgId, "fresh@example.com")).status).toBe(429);

		const rows = await db()
			.prepare("SELECT key FROM mail_sends WHERE key != ?")
			.bind(inviterMailKey(ada.id))
			.all<{ key: string }>();
		expect(rows.results).toEqual([]);
	});
```

4. The file's header comment already says the counting is pinned in `db/mail-sends.test.ts`, so it stays as it is.

- [ ] **Step 2: Run them**

Run: `pnpm --filter @onlooker/api test mail-cap`
Expected: PASS, since Tasks 1 and 2 already implement this. These tests pin route behavior.

Then prove the inviter test is real, by ablation. With Edit, temporarily change `INVITER_LIMIT`'s `max: 10` to `max: 1000` in `mail-sends.ts`, then re-run.
Expected: FAIL in `"refuses an owner's eleventh invite…"` (201 instead of 429). The `"the limits"` unit test isn't in this run.

Revert with Edit, re-run, and expect PASS. Record both outputs in the report.

- [ ] **Step 3: Update DEPLOYMENT.md**

In `apps/api/DEPLOYMENT.md`, replace the paragraph that starts `**Mail is capped inside the worker**` (it ends `…logged as \`mail_global_ceiling\` without raising another.`) with:

```markdown
**Mail is capped inside the worker**, per recipient, per inviter and per day,
in `src/db/mail-sends.ts` (ONL-222, ONL-228). Three resets or three
verification mails per address per hour, and three invites per address per day
across all orgs. Each user may send ten invites a day. Each kind has its own
daily pool: 45 resets, 10 verification mails and 25 invites, 80 in all, under
Resend's free-tier 100. The pools are separate so invites, which anyone can
send because accounts are free, cannot spend the mail a locked-out user needs.
The counters are a D1 table, `mail_sends`, pruned by the five-minute cron.
forgot-password answers a refusal with its usual 200, so the cap cannot say
which addresses have accounts. The other two answer 429 with `Retry-After`.
A spent pool raises a Sentry issue tagged `mail_kind`, once per pool per UTC
day, because from then until UTC midnight legitimate mail of that kind is
refused too. Every later refusal that day is logged as `mail_global_ceiling`
without raising another. Capped addresses and inviters log
`mail_address_capped` and `mail_inviter_capped` and raise nothing.
```

- [ ] **Step 4: Point the mail-cap spec's Deferred entry at the new design**

In `docs/superpowers/specs/2026-10-31-mail-cap-design.md`, replace the line:

```markdown
  Possible fixes: a per-inviter or per-org daily invite cap; reserving part of
  the 80 for reset and verify.
```

with:

```markdown
  Resolved by a pool per kind and a per-inviter cap; see
  `docs/superpowers/specs/2026-10-31-mail-pools-design.md`.
```

- [ ] **Step 5: Run the whole API suite, typecheck, the source guards and lint**

Run: `pnpm --filter @onlooker/api test`
Expected: PASS.

Run: `pnpm --filter @onlooker/api typecheck`
Expected: no errors.

Run: `bash scripts/source-guards.test.sh`
Expected: all pass, including "found the three mail-sending handlers", "found exactly three sendEmail call sites" and "each mail sender claims before it retires a token or sends".

Run: `pnpm --filter @onlooker/api lint`, and fix any findings with Edit.

- [ ] **Step 6: Commit**

Commit `apps/api/src/routes/mail-cap.test.ts`, `apps/api/DEPLOYMENT.md` and `docs/superpowers/specs/2026-10-31-mail-cap-design.md`, with a message like:

```
test(api): pin that a spent invite pool still lets resets out :shield:

The routes are where the separation matters: a reset and a verify must
still send with the invite pool spent, and one owner's eleventh invite must
be refused while another owner's goes out. The docs now describe the pools.

Refs ONL-228
```
