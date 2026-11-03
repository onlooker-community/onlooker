# Per-Account Circuit Breaker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap every signed-in account at 1,000 requests per 60 seconds, so a
runaway script or a stolen token can't spend D1 and Worker CPU without bound.

**Architecture:** A new module, `apps/api/src/middleware/account-limit.ts`,
owns the key, the refusal and the Sentry report gate. `dispatch` in
`apps/api/src/router.ts` calls it once, after `resolvePrincipal` and before the
handler, whenever a principal resolved. Counting is done by two Workers rate
limiting bindings declared in `apps/api/wrangler.toml`.

**Tech Stack:** Cloudflare Workers, the `ratelimits` binding, TypeScript,
vitest with `@cloudflare/vitest-pool-workers`, Biome, bash source guards.

**Spec:** `docs/superpowers/specs/2026-11-03-account-rate-limit-design.md`.

## Global Constraints

- The limit: **1000 requests per 60 seconds per account**, key `user:<user id>`.
- Report gate: **1 per 60 seconds**, key `report:<user id>`.
- Binding names: `ACCOUNT_LIMITER` and `LIMIT_REPORT_GATE`.
- Namespace ids, unique per environment:
  - development: `1101` (limiter), `1102` (gate)
  - staging: `1201`, `1202`
  - production: `1301`, `1302`
- A refusal is `ApiError(429, "rate_limited", "Too many requests from this account. Try again in a minute.", undefined, { "Retry-After": "60" })`.
- Trip report fingerprint `["account_rate_limited"]`, tags
  `{ kind: "account_rate_limited", route: "<METHOD> <pattern>" }`, and
  `extra: { user_id }`.
- Limiter failure fingerprint `["account_limiter_failed"]`, tags
  `{ kind: "account_limiter_failed", route }`.
- Fail open: a missing `ACCOUNT_LIMITER` allows the request and reports
  nothing. A throwing one allows it and reports. A missing or throwing
  `LIMIT_REPORT_GATE` still refuses, but doesn't report.
- Only requests with a principal are limited. A route whose `auth` is `"none"`
  never calls the limiter.
- Run one test file with `pnpm --filter @onlooker/api test <name>`, with **no
  `--`**.
- Edit tracked files with Edit/Write only. No `sed -i`, heredocs,
  `biome format --write` or `lint:fix`, because the lineage hooks observe tool
  calls.
- Commits: `<type>(<scope>): <subject> :emoji:`, American English, a
  why-focused body, ending `Refs ONL-222`. The `/git-workflow:commit` skill is
  the route. A subagent without it mirrors the contract.
- `@cloudflare/vitest-pool-workers` doesn't apply `vi.mock`. Inject
  dependencies, or use `vi.spyOn` on the shared `monitor` and restore it in
  `finally`.

---

### Task 1: The account limit module

**Files:**
- Create: `apps/api/src/middleware/account-limit.ts`
- Create: `apps/api/src/middleware/account-limit.test.ts`
- Modify: `apps/api/src/types/index.ts`, adding two fields to `WorkerEnv` and
  `RateLimit` to the workers-types import on line 1
- Modify: `ENVIRONMENT_VARIABLES.md`, adding two rows to the "Access Bindings"
  table. `scripts/source-guards.test.sh` fails any `WorkerEnv` field missing
  from that file.

**Interfaces:**
- Produces:
  - `ACCOUNT_LIMIT: { readonly requests: 1000; readonly periodSeconds: 60 }`
  - `accountLimitKey(userId: string): string`, which returns `user:<id>`
  - `type AccountLimitDeps = { monitor: Pick<typeof monitor, "captureException"> }`
  - `enforceAccountLimit(env: WorkerEnv, userId: string, route: string, deps?: AccountLimitDeps): Promise<void>`.
    It resolves when allowed and throws the 429 `ApiError` when refused.
  - `WorkerEnv.ACCOUNT_LIMITER?: RateLimit` and
    `WorkerEnv.LIMIT_REPORT_GATE?: RateLimit`

- [ ] **Step 1: Add the two `WorkerEnv` fields**

In `apps/api/src/types/index.ts`, change line 1 to:

```ts
import type {
	D1Database,
	KVNamespace,
	RateLimit,
} from "@cloudflare/workers-types";
```

Then add these fields after `TOKEN_REVOCATION?: KVNamespace;` and before
`OPERATOR_USER_IDS`:

```ts
	// Workers rate limiting bindings for the per-account circuit breaker, see
	// middleware/account-limit.ts. ACCOUNT_LIMITER counts every signed-in
	// request per account; LIMIT_REPORT_GATE lets one refusal a minute per
	// account through to Sentry. Optional because the test pool's miniflare
	// config declares neither, and a missing limiter fails open rather than
	// taking the API down. Each environment in wrangler.toml declares both.
	ACCOUNT_LIMITER?: RateLimit;
	LIMIT_REPORT_GATE?: RateLimit;
```

- [ ] **Step 2: Document them in `ENVIRONMENT_VARIABLES.md`**

In the "Access Bindings" table, add after the `DB` row:

```markdown
| `ACCOUNT_LIMITER` | RateLimit | `[[env.*.ratelimits]]` in `wrangler.toml`, all three environments. 1,000 signed-in requests per 60 seconds per account — see [DEPLOYMENT.md](apps/api/DEPLOYMENT.md#rate-limiting) |
| `LIMIT_REPORT_GATE` | RateLimit | `[[env.*.ratelimits]]` in `wrangler.toml`, all three environments. Lets one refusal a minute per account through to Sentry |
```

- [ ] **Step 3: Write the failing tests**

Create `apps/api/src/middleware/account-limit.test.ts`:

```ts
import { env } from "cloudflare:test";
import type { RateLimit } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type WorkerEnv } from "../types";
import {
	ACCOUNT_LIMIT,
	type AccountLimitDeps,
	accountLimitKey,
	enforceAccountLimit,
} from "./account-limit";

/**
 * Unit tests against fake bindings. The real binding only counts in a
 * deployed worker, and nothing here should need 1,000 requests to see a
 * refusal.
 */

const ROUTE = "GET /api/projects";

/** A limiter that answers `success` and records every key it was asked. */
function fakeLimiter(success: boolean): RateLimit & { keys: string[] } {
	const keys: string[] = [];
	return {
		keys,
		limit: async ({ key }) => {
			keys.push(key);
			return { success };
		},
	};
}

/** A gate that allows the first call per key and refuses the rest. */
function onceGate(): RateLimit {
	const seen = new Set<string>();
	return {
		limit: async ({ key }) => {
			const success = !seen.has(key);
			seen.add(key);
			return { success };
		},
	};
}

function deps(): AccountLimitDeps & {
	captured: Array<{ error: unknown; context: unknown }>;
} {
	const captured: Array<{ error: unknown; context: unknown }> = [];
	return {
		captured,
		monitor: {
			captureException: (error, context) => {
				captured.push({ error, context });
			},
		},
	};
}

function withBindings(bindings: Partial<WorkerEnv>): WorkerEnv {
	return { ...(env as unknown as WorkerEnv), ...bindings };
}

describe("accountLimitKey", () => {
	it("keys by user id", () => {
		expect(accountLimitKey("u1")).toBe("user:u1");
	});
});

describe("enforceAccountLimit", () => {
	it("allows a request the limiter allows, and reports nothing", async () => {
		const limiter = fakeLimiter(true);
		const d = deps();
		await expect(
			enforceAccountLimit(
				withBindings({ ACCOUNT_LIMITER: limiter, LIMIT_REPORT_GATE: onceGate() }),
				"u1",
				ROUTE,
				d,
			),
		).resolves.toBeUndefined();
		expect(limiter.keys).toEqual(["user:u1"]);
		expect(d.captured).toEqual([]);
	});

	it("refuses with 429 rate_limited and Retry-After 60", async () => {
		const d = deps();
		const refused = enforceAccountLimit(
			withBindings({
				ACCOUNT_LIMITER: fakeLimiter(false),
				LIMIT_REPORT_GATE: onceGate(),
			}),
			"u1",
			ROUTE,
			d,
		);
		await expect(refused).rejects.toBeInstanceOf(ApiError);
		const error = (await refused.catch((e) => e)) as ApiError;
		expect(error.status).toBe(429);
		expect(error.code).toBe("rate_limited");
		expect(error.headers).toEqual({ "Retry-After": "60" });
		expect(ACCOUNT_LIMIT).toEqual({ requests: 1000, periodSeconds: 60 });
	});

	it("reports the first refusal through the gate, not the second", async () => {
		const d = deps();
		const bindings = withBindings({
			ACCOUNT_LIMITER: fakeLimiter(false),
			LIMIT_REPORT_GATE: onceGate(),
		});
		await enforceAccountLimit(bindings, "u1", ROUTE, d).catch(() => {});
		await enforceAccountLimit(bindings, "u1", ROUTE, d).catch(() => {});
		expect(d.captured).toHaveLength(1);
		expect(d.captured[0].context).toEqual({
			tags: { kind: "account_rate_limited", route: ROUTE },
			fingerprint: ["account_rate_limited"],
			extra: { user_id: "u1" },
		});
	});

	it("gates reports per account", async () => {
		const d = deps();
		const bindings = withBindings({
			ACCOUNT_LIMITER: fakeLimiter(false),
			LIMIT_REPORT_GATE: onceGate(),
		});
		await enforceAccountLimit(bindings, "u1", ROUTE, d).catch(() => {});
		await enforceAccountLimit(bindings, "u2", ROUTE, d).catch(() => {});
		expect(d.captured).toHaveLength(2);
	});

	it("still refuses, without reporting, when the gate is missing", async () => {
		const d = deps();
		await expect(
			enforceAccountLimit(
				withBindings({ ACCOUNT_LIMITER: fakeLimiter(false) }),
				"u1",
				ROUTE,
				d,
			),
		).rejects.toMatchObject({ status: 429 });
		expect(d.captured).toEqual([]);
	});

	it("still refuses, without reporting, when the gate throws", async () => {
		const d = deps();
		await expect(
			enforceAccountLimit(
				withBindings({
					ACCOUNT_LIMITER: fakeLimiter(false),
					LIMIT_REPORT_GATE: {
						limit: async () => {
							throw new Error("gate down");
						},
					},
				}),
				"u1",
				ROUTE,
				d,
			),
		).rejects.toMatchObject({ status: 429 });
		expect(d.captured).toEqual([]);
	});

	it("fails open, reporting nothing, when the limiter is missing", async () => {
		const d = deps();
		await expect(
			enforceAccountLimit(withBindings({}), "u1", ROUTE, d),
		).resolves.toBeUndefined();
		expect(d.captured).toEqual([]);
	});

	it("fails open and reports when the limiter throws", async () => {
		const d = deps();
		const boom = new Error("limiter down");
		await expect(
			enforceAccountLimit(
				withBindings({
					ACCOUNT_LIMITER: {
						limit: async () => {
							throw boom;
						},
					},
				}),
				"u1",
				ROUTE,
				d,
			),
		).resolves.toBeUndefined();
		expect(d.captured).toEqual([
			{
				error: boom,
				context: {
					tags: { kind: "account_limiter_failed", route: ROUTE },
					fingerprint: ["account_limiter_failed"],
				},
			},
		]);
	});

	it("uses the shared monitor when no deps are passed", async () => {
		const { monitor } = await import("../monitoring");
		const capture = vi.spyOn(monitor, "captureException");
		try {
			await enforceAccountLimit(
				withBindings({
					ACCOUNT_LIMITER: fakeLimiter(false),
					LIMIT_REPORT_GATE: onceGate(),
				}),
				"u1",
				ROUTE,
			).catch(() => {});
			expect(capture).toHaveBeenCalledTimes(1);
		} finally {
			capture.mockRestore();
		}
	});
});
```

- [ ] **Step 4: Run it to see it fail**

Run: `pnpm --filter @onlooker/api test account-limit`
Expected: FAIL. The module `./account-limit` doesn't exist yet.

- [ ] **Step 5: Write the module**

Create `apps/api/src/middleware/account-limit.ts`:

```ts
import { monitor } from "../monitoring";
import { ApiError, type WorkerEnv } from "../types";

/**
 * The per-account circuit breaker (ONL-222).
 *
 * Every signed-in request counts against one budget per account, whatever
 * credential carried it: a browser session and every machine token on the
 * account share it. It's sized as a circuit breaker, not a quota. The worst
 * legitimate sync measured is about 74 requests in 15-30 seconds, two machines
 * doing that at once come to about 600 a minute, and the limit sits above
 * both. What it stops is a runaway script or a stolen token. See
 * docs/superpowers/specs/2026-11-03-account-rate-limit-design.md.
 *
 * The Workers rate limiting binding counts approximately, per Cloudflare
 * location, which a circuit breaker can afford. It adds no D1 query, where a
 * D1 counter would add a write to every request in order to protect D1 writes.
 */
export const ACCOUNT_LIMIT = { requests: 1000, periodSeconds: 60 } as const;

/** Injectable because the Workers pool cannot mock modules. */
export type AccountLimitDeps = {
	monitor: Pick<typeof monitor, "captureException">;
};

const realDeps: AccountLimitDeps = { monitor };

export function accountLimitKey(userId: string): string {
	return `user:${userId}`;
}

/**
 * Resolve if the account may make this request, or throw a 429.
 *
 * `route` is the matched route's method and pattern, never the concrete path,
 * so a report groups by route rather than by lesson id.
 *
 * Fails open. A missing limiter, which is the test pool's and any
 * misconfigured environment's state, allows the request silently; a throwing
 * one allows it and reports. A broken limiter must not take the API down.
 */
export async function enforceAccountLimit(
	env: WorkerEnv,
	userId: string,
	route: string,
	deps: AccountLimitDeps = realDeps,
): Promise<void> {
	const limiter = env.ACCOUNT_LIMITER;
	if (!limiter) return;

	let allowed: boolean;
	try {
		({ success: allowed } = await limiter.limit({
			key: accountLimitKey(userId),
		}));
	} catch (error) {
		deps.monitor.captureException(error, {
			tags: { kind: "account_limiter_failed", route },
			fingerprint: ["account_limiter_failed"],
		});
		return;
	}
	if (allowed) return;

	await reportTrip(env, userId, route, deps);
	throw new ApiError(
		429,
		"rate_limited",
		"Too many requests from this account. Try again in a minute.",
		undefined,
		// The binding doesn't say when its window resets, so the period is the
		// honest upper bound.
		{ "Retry-After": String(ACCOUNT_LIMIT.periodSeconds) },
	);
}

/**
 * Report a refusal, at most once a minute per account per location.
 *
 * A runaway refused a thousand times a minute must not become a thousand
 * Sentry events, so the gate decides. Without a gate, or with one that throws,
 * nothing is reported: one report per refused request is exactly the flood
 * the gate exists to stop, and the refusal itself still stands.
 */
async function reportTrip(
	env: WorkerEnv,
	userId: string,
	route: string,
	deps: AccountLimitDeps,
): Promise<void> {
	const gate = env.LIMIT_REPORT_GATE;
	if (!gate) return;
	try {
		const { success } = await gate.limit({ key: `report:${userId}` });
		if (!success) return;
	} catch {
		return;
	}
	deps.monitor.captureException(
		new Error(
			`account passed ${ACCOUNT_LIMIT.requests} requests in ${ACCOUNT_LIMIT.periodSeconds}s and is being refused`,
		),
		{
			tags: { kind: "account_rate_limited", route },
			fingerprint: ["account_rate_limited"],
			// An opaque id, not an email. CaptureContext has no per-event user,
			// and setUser is global to the isolate.
			extra: { user_id: userId },
		},
	);
}
```

- [ ] **Step 6: Run the tests, typecheck and lint**

Run: `pnpm --filter @onlooker/api test account-limit`
Expected: PASS, 10 tests.

Run: `pnpm --filter @onlooker/api typecheck && pnpm --filter @onlooker/api lint && bash scripts/source-guards.test.sh`
Expected: all pass. The source guard's "every WorkerEnv field appears in
ENVIRONMENT_VARIABLES.md" check covers the two new fields. If Biome reports
formatting, fix it with Edit, matching the diff it prints.

- [ ] **Step 7: Commit**

Commit `apps/api/src/middleware/account-limit.ts`,
`apps/api/src/middleware/account-limit.test.ts`,
`apps/api/src/types/index.ts` and `ENVIRONMENT_VARIABLES.md`:

```text
feat(api): count signed-in requests per account :vertical_traffic_light:

No route that takes a credential had any limit, so a runaway script or a
stolen token could spend D1 and Worker CPU without bound. This adds the
counter and its refusal; nothing calls it yet.

It fails open, because a broken limiter must not take the API down, and
reports through a gate so a runaway refused a thousand times a minute is one
Sentry event, not a thousand.

Refs ONL-222
```

---

### Task 2: Enforce it in dispatch, bind it, document it

**Files:**
- Modify: `apps/api/src/router.ts`, in `dispatch` (around lines 691–703, the
  `try` block holding `resolvePrincipal`), plus one import
- Create: `apps/api/src/routes/account-limit.test.ts`
- Modify: `apps/api/wrangler.toml`, adding two `ratelimits` blocks per
  environment
- Modify: `scripts/source-guards.test.sh`, adding one guard
- Modify: `apps/api/DEPLOYMENT.md`, in the "Rate Limiting" section
- Modify: `apps/api/src/index.ts`, the WS5 comment (lines 10–18)

**Interfaces:**
- Consumes: `enforceAccountLimit(env, userId, route)` from Task 1, which throws
  `ApiError` 429 when refused.
- Consumes: `dispatch(request: Request, env: WorkerEnv): Promise<Response>`,
  exported from `apps/api/src/router.ts`.
- Test helpers: `signup(email)` from `../test-support/orgs.js` returns
  `{ id, token, refreshToken }`; `resetOrgTables()` from the same file;
  `mintMachine(email)` from `../test-support/lessons.js` returns
  `{ id, token, accessToken }`; `lesson()` and `BASE`
  (`https://api.onlooker.dev`) come from `../test-support/lessons.js`.

- [ ] **Step 1: Write the failing route tests**

Create `apps/api/src/routes/account-limit.test.ts`:

```ts
import { env } from "cloudflare:test";
import type { RateLimit } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it } from "vitest";
import { dispatch } from "../router";
import { BASE, lesson, mintMachine } from "../test-support/lessons.js";
import { resetOrgTables, signup } from "../test-support/orgs.js";
import type { WorkerEnv } from "../types";

/**
 * The circuit breaker as a caller meets it: through dispatch, with a fake
 * limiter on env. SELF.fetch can't carry a per-test binding, so these call
 * dispatch directly with the worker's own env plus the fake.
 */

function fakeLimiter(success: boolean): RateLimit & { keys: string[] } {
	const keys: string[] = [];
	return {
		keys,
		limit: async ({ key }) => {
			keys.push(key);
			return { success };
		},
	};
}

function envWith(limiter: RateLimit): WorkerEnv {
	return { ...(env as unknown as WorkerEnv), ACCOUNT_LIMITER: limiter };
}

function request(path: string, token: string | null, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	headers.set("Content-Type", "application/json");
	if (token) headers.set("Authorization", `Bearer ${token}`);
	return new Request(`${BASE}${path}`, { ...init, headers });
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
	const row = await env.DB.prepare(sql)
		.bind(...binds)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM lesson_feed").run();
	await env.DB.prepare("DELETE FROM lessons").run();
	await env.DB.prepare("DELETE FROM machine_tokens").run();
	await resetOrgTables();
});

describe("the per-account limit", () => {
	it("refuses a session route with 429 before its handler runs", async () => {
		const ada = await signup("ada@example.com");
		const response = await dispatch(
			request("/api/machines", ada.token, {
				method: "POST",
				body: JSON.stringify({ name: "refused" }),
			}),
			envWith(fakeLimiter(false)),
		);
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("60");
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("rate_limited");
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM machine_tokens WHERE user_id = ?",
				ada.id,
			),
		).toBe(0);
	});

	it("refuses a machine route with 429 before its handler runs", async () => {
		const machine = await mintMachine("grace@example.com");
		const response = await dispatch(
			request("/lessons", machine.token, {
				method: "POST",
				body: JSON.stringify({ lessons: [lesson()] }),
			}),
			envWith(fakeLimiter(false)),
		);
		expect(response.status).toBe(429);
		expect(await count("SELECT COUNT(*) AS n FROM lessons")).toBe(0);
	});

	it("lets an allowed request reach its handler", async () => {
		const ada = await signup("ada@example.com");
		const response = await dispatch(
			request("/api/machines", ada.token, {
				method: "POST",
				body: JSON.stringify({ name: "allowed" }),
			}),
			envWith(fakeLimiter(true)),
		);
		expect(response.status).toBeLessThan(300);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM machine_tokens WHERE user_id = ?",
				ada.id,
			),
		).toBe(1);
	});

	it("keys a session and a machine token on one account alike", async () => {
		const ada = await signup("ada@example.com");
		const minted = await dispatch(
			request("/api/machines", ada.token, {
				method: "POST",
				body: JSON.stringify({ name: "laptop" }),
			}),
			env as unknown as WorkerEnv,
		);
		const { token: machineToken } = (await minted.json()) as { token: string };

		const limiter = fakeLimiter(true);
		await dispatch(request("/api/machines", ada.token), envWith(limiter));
		await dispatch(
			request("/lessons?since=0&limit=1", machineToken),
			envWith(limiter),
		);
		expect(limiter.keys).toEqual([`user:${ada.id}`, `user:${ada.id}`]);
	});

	it("never consults the limiter on a route that takes no credential", async () => {
		const limiter = fakeLimiter(false);
		const response = await dispatch(
			request("/auth/login", null, {
				method: "POST",
				body: JSON.stringify({ email: "nobody@example.com", password: "x" }),
			}),
			envWith(limiter),
		);
		expect(response.status).not.toBe(429);
		expect(limiter.keys).toEqual([]);
	});

	it("never consults the limiter when the credential is refused", async () => {
		const limiter = fakeLimiter(false);
		const response = await dispatch(
			request("/api/machines", "not-a-token"),
			envWith(limiter),
		);
		expect(response.status).toBe(401);
		expect(limiter.keys).toEqual([]);
	});
});
```

The push body `{ lessons: [...] }` is the one the test-support
`push(token, lessons)` helper sends, and `POST /api/machines` answers 201.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @onlooker/api test account-limit`
Expected: the new route file FAILS. The refusal tests get 2xx or 201 instead
of 429, and the key test records no keys. Task 1's unit file still passes.

- [ ] **Step 3: Call the limit in `dispatch`**

In `apps/api/src/router.ts`, add to the imports:

```ts
import { enforceAccountLimit } from "./middleware/account-limit";
```

Then in `dispatch`, replace:

```ts
		const principal = await resolvePrincipal(request, env, matched.route.auth);
		return await matched.route.handler(request, env, matched.params, principal);
```

with:

```ts
		const principal = await resolvePrincipal(request, env, matched.route.auth);
		// After the principal, so the key comes from a verified credential
		// rather than a claimed one, and before the handler, which is where the
		// cost is. A route with no credential has no principal and isn't
		// counted; the zone rule covers those. See middleware/account-limit.ts.
		if (principal) {
			await enforceAccountLimit(
				env,
				principal.userId,
				`${matched.route.method} ${matched.route.path}`,
			);
		}
		return await matched.route.handler(request, env, matched.params, principal);
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @onlooker/api test account-limit`
Expected: PASS, both files.

Run: `pnpm --filter @onlooker/api test`
Expected: PASS. The test pool declares no `ACCOUNT_LIMITER`, so every other
suite fails open and runs unchanged.

- [ ] **Step 5: Pin the order with a source guard**

In `scripts/source-guards.test.sh`, directly after the "the login gate runs
before bcrypt" block (its last line is the `fi` closing the
`gate_line < bcrypt_line` check), add:

```bash
echo
echo "source-guards: the account limit runs between the principal and the handler"

# ONL-222. dispatch counts a signed-in request against its account after
# resolvePrincipal - so the key is a verified user id, not a claimed one - and
# before the handler, which is where the cost is. A limit moved above the
# principal would key on nothing; one moved below the handler would refuse
# work already done. The route tests can see a 429, but not which side of the
# handler it came from, so line order is pinned here, like the login gate.
router_file="${ROOT}/apps/api/src/router.ts"
principal_line="$(grep -n 'await resolvePrincipal(' "${router_file}" | head -1 | cut -d: -f1)"
limit_line="$(grep -n 'await enforceAccountLimit(' "${router_file}" | head -1 | cut -d: -f1)"
handler_line="$(grep -n 'await matched.route.handler(' "${router_file}" | head -1 | cut -d: -f1)"

if [[ -z "${principal_line}" || -z "${limit_line}" || -z "${handler_line}" ]]; then
	fail "dispatch still resolves a principal, enforces the account limit and calls the handler" \
		"resolvePrincipal at '${principal_line:-none}', enforceAccountLimit at '${limit_line:-none}', handler at '${handler_line:-none}'"
elif (( principal_line < limit_line && limit_line < handler_line )); then
	pass "dispatch enforces the account limit after resolvePrincipal and before the handler"
else
	fail "dispatch enforces the account limit after resolvePrincipal and before the handler" \
		"resolvePrincipal at ${principal_line}, enforceAccountLimit at ${limit_line}, handler at ${handler_line}"
fi
```

Prove it guards something: temporarily move the `enforceAccountLimit` block
below the `return await matched.route.handler(` line with Edit, run
`bash scripts/source-guards.test.sh`, and confirm this check FAILS. Then move
it back with Edit and confirm it passes. Note both results in your report.

- [ ] **Step 6: Declare the bindings in `wrangler.toml`**

Rate limit bindings aren't inherited between environments, so each
environment declares its own. Add each pair directly after that environment's
`[[env.<name>.d1_databases]]` block, including the migration lines that
follow it (the D1 blocks are at about lines 71, 147 and 232):

Development:

```toml
# The per-account circuit breaker, see apps/api/src/middleware/account-limit.ts.
# Namespace ids are unique per environment so one environment's traffic can't
# spend another's counts. The period must be 10 or 60.
[[env.development.ratelimits]]
name = "ACCOUNT_LIMITER"
namespace_id = "1101"
simple = { limit = 1000, period = 60 }

# One Sentry report per account per minute when the limiter refuses.
[[env.development.ratelimits]]
name = "LIMIT_REPORT_GATE"
namespace_id = "1102"
simple = { limit = 1, period = 60 }
```

Staging:

```toml
# See the note under [[env.development.ratelimits]].
[[env.staging.ratelimits]]
name = "ACCOUNT_LIMITER"
namespace_id = "1201"
simple = { limit = 1000, period = 60 }

[[env.staging.ratelimits]]
name = "LIMIT_REPORT_GATE"
namespace_id = "1202"
simple = { limit = 1, period = 60 }
```

Production:

```toml
# See the note under [[env.development.ratelimits]].
[[env.production.ratelimits]]
name = "ACCOUNT_LIMITER"
namespace_id = "1301"
simple = { limit = 1000, period = 60 }

[[env.production.ratelimits]]
name = "LIMIT_REPORT_GATE"
namespace_id = "1302"
simple = { limit = 1, period = 60 }
```

Validate that wrangler parses it, without deploying:

Run: `pnpm --filter @onlooker/api exec wrangler deploy --dry-run --env production --outdir "$(mktemp -d)"`
Expected: the output lists `env.ACCOUNT_LIMITER` and `env.LIMIT_REPORT_GATE`
among the bindings, with no config error. Run it for `--env staging` too. If
the dry run fails for a reason unrelated to `ratelimits` (for example, it wants
credentials), report the exact error and don't work around it.

- [ ] **Step 7: Document it**

In `apps/api/DEPLOYMENT.md`, "Rate Limiting" section: read the whole section
first. Then add a subsection after the one describing login backoff (the
paragraph starting near "WS5 that is not this zone rule"), titled
`#### Per-account limit (signed-in routes)`, covering exactly these points in
the section's existing voice:

- Every request with a credential (session, machine or operator) counts
  against one budget per account: 1,000 per 60 seconds, keyed by user id,
  shared by the browser and every machine on the account.
- Why 1,000: the worst legitimate sync measured on 2026-11-03 is about 74
  requests in 15–30 seconds, two machines at once come to about 600 a minute,
  and nothing calls the API without a person running the CLI. It's a circuit
  breaker for a runaway script or a stolen token, not a quota.
- A refusal is 429 `rate_limited` with `Retry-After: 60`.
- The mechanism is the Workers rate limiting binding, `ACCOUNT_LIMITER`:
  approximate, counted per Cloudflare location, with no D1 cost. It runs in
  `dispatch` after the principal resolves, so a flood with a valid token still
  pays the credential check, but not the handler.
- Alerting: the first refusal per account per minute raises a Sentry issue
  fingerprinted `["account_rate_limited"]`, tagged with the route, with
  `user_id` in extra. `LIMIT_REPORT_GATE` decides which refusal that is.
- It fails open. With no binding the limit is off, which is the test pool's
  state. A throwing binding is reported as `["account_limiter_failed"]`.
- The CLI doesn't yet read `Retry-After` (link the Linear follow-up if it has
  an id by then, otherwise say it's filed).

In `apps/api/src/index.ts`, change the WS5 comment sentence
"Everything else rests on ONE Cloudflare zone rule" through "Per-account
limits beyond login and mail-send throttling are still missing." so it reads:

```ts
 * WS5 is partial rather than absent, and the split is worth knowing before
 * reading this file for a rateLimit function that is not here. Login has a
 * per-account failed-attempt backoff in worker code (db/login-attempts.ts),
 * mail sends are capped per address, account and pool (db/mail-sends.ts), and
 * every signed-in request counts against a per-account circuit breaker
 * (middleware/account-limit.ts, called from dispatch). The unauthenticated
 * paths rest on ONE Cloudflare zone rule, which is committed as
 * scripts/cloudflare/ratelimit.json and applied by scripts/cloudflare/apply.sh;
 * DEPLOYMENT.md's "Rate Limiting" section carries the reasoning.
```

Keep the paragraph after it (the "An earlier version of this comment..." one)
unchanged.

- [ ] **Step 8: Full checks**

Run: `pnpm --filter @onlooker/api test && pnpm typecheck && pnpm lint && bash scripts/source-guards.test.sh`
Expected: all pass. Fix any Biome formatting with Edit, matching the diff it
prints.

- [ ] **Step 9: Commit**

Commit `apps/api/src/router.ts`, `apps/api/src/routes/account-limit.test.ts`,
`apps/api/wrangler.toml`, `scripts/source-guards.test.sh`,
`apps/api/DEPLOYMENT.md` and `apps/api/src/index.ts`:

```text
feat(api): refuse an account past 1,000 requests a minute :vertical_traffic_light:

Signed-in routes had no limit at all. dispatch now counts each one against
its account after the credential verifies and before the handler runs, so a
runaway script or a stolen token stops at about 17 requests a second
instead of whatever the network allows.

The worst real sync measured is about 300 a minute, so no person running the
CLI should meet it. A source guard pins the order, since a test can see the
429 but not which side of the handler it came from.

Refs ONL-222
```
