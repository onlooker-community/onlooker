# Machines Page and the One-Time Token Reveal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person mint, read and revoke a machine token from the browser, so the sync protocol that shipped in #70 can finally be turned on by someone.

**Architecture:** Three handlers already exist and are already browser-authenticated. This work moves them under the `/api/` prefix so the mock and the contract can reach them, teaches `apps/web`'s mock to model the whole credential lifecycle, and builds a page over them. The raw token is returned by `POST /api/machines` and by nothing else, ever, so the reveal is built as a focus-trapping modal that yields only to an explicit act.

**Tech Stack:** Cloudflare Workers + D1 + drizzle (`apps/api`), React 18 + react-router-dom 6.28 + Vite (`apps/web`), vitest + @testing-library/react, `@cloudflare/vitest-pool-workers` for the API suite.

**Spec:** `docs/superpowers/specs/2026-08-23-lesson-pool-surface-design.md` — Section 2, plus the Amendments dated 2026-08-25. Read the amendments first; three of the four change decisions this plan implements.

**Bead:** `onlooker-k7w`

## Global Constraints

- **American English** in every comment, identifier, commit message and piece of user-facing copy.
- **Every commit routes through the `/commit` skill.** Conventional commits, mood emoji reflecting *this* change, why-focused body.
- **Branch is `feat/machines-page`.** Never commit to `main`; this repository lands everything through a PR.
- **TDD.** Every step below writes the failing test first and runs it to watch it fail before any implementation exists.
- **The raw machine token is returned by `POST /api/machines` and stored nowhere.** Only its SHA-256 reaches the database. No task may add a second place it can be read.
- **A revoke answers 404, never 403,** for a machine that does not exist *and* for one belonging to someone else. A 403 confirms the id exists, which is an existence oracle over other users' rows.
- **The token prefix is `onlk_`** and is load-bearing: secret scanners grep for it, and the contract's `forbidden` list uses it as the tripwire for a leaked credential.
- **No optimistic updates.** Create and revoke round-trip and render what the server said, for the reason Section 4 of the spec gives for retract.
- **Run the full workspace suite before every commit**, not just the file under test:
  - `pnpm --filter @onlooker/api exec vitest run`
  - `pnpm --filter @onlooker/web exec vitest run`
  - `pnpm --filter @onlooker/api-contract exec tsc --noEmit` (if the package has a typecheck script, prefer it)

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/api/src/router.ts` | Route table — three `path` strings move under `/api/` | 1 |
| `apps/api/src/routes/machines.test.ts` | API behavior for the three handlers, at the new paths | 1 |
| `apps/web/src/api/mockApi.ts` | Mock branches for the machine lifecycle | 2 |
| `apps/web/src/api/mockMachines.test.ts` | The mock's own behavior, independent of the contract | 2 |
| `packages/api-contract/src/index.ts` | Two static cases + `MACHINE_LIFECYCLE` | 3 |
| `apps/api/src/contract.test.ts` | The API's half of the lifecycle flow | 3 |
| `apps/web/src/api/api-contract.test.ts` | The mock's half of the lifecycle flow | 3 |
| `apps/web/src/api/machinesApi.ts` | Typed client, beside `accountApi.ts` | 4 |
| `apps/web/src/components/TokenReveal.tsx` | The one-time reveal modal — its own file because it owns focus, keyboard and unload behavior | 5 |
| `apps/web/src/__tests__/token-reveal.test.tsx` | That the reveal is not dismissable by accident | 5 |
| `apps/web/src/pages/MachinesPage.tsx` | List, mint form, inline revoke confirm, empty state | 6 |
| `apps/web/src/__tests__/machines-page.test.tsx` | Page behavior | 6 |
| `apps/web/src/App.tsx` | `/machines` behind `RequireAuth`, wrapped in `AppShell` | 7 |
| `apps/web/src/pages/DashboardPage.tsx` | Temporary Machines link, deleted with the page in PR 5 | 7 |

---

## Task 1: Move the machines surface under `/api/`

The three handlers are registered at `/machines`, outside the prefix every other browser-authenticated route uses. `createMockFetch` claims only `/auth/*` and `/api/*` and passes everything else to the real network, so a call to `/machines` in development reaches the Vite dev server rather than the mock. No browser could ever mint a token, so no machine token exists in production to break.

**Correction, made during execution.** This section first claimed nothing in the repository called these paths. That was wrong, and wrong for an instructive reason: the grep behind it ended in `head -30`, and thirty lines of documentation matches filled the window before any code match could appear. Two test-infrastructure files call the routes and move with them:

| File | What calls it |
|---|---|
| `apps/api/src/test-support/lessons.ts` | mints a machine token for the delta-read helpers |
| `apps/api/src/routes/lessons-delta.test.ts` | mints and revokes directly, three call sites |

Both are in scope for this task — a path move that leaves its callers behind is not finished. Stage them with the other two files.

**Files:**
- Modify: `apps/api/src/router.ts:157-171`
- Modify: `apps/api/src/test-support/lessons.ts` — mints a machine token for the delta-read helpers
- Modify: `apps/api/src/routes/lessons-delta.test.ts` — three call sites that mint and revoke
- Test: `apps/api/src/routes/machines.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the paths every later task targets — `POST /api/machines`, `GET /api/machines`, `DELETE /api/machines/:id`. Handler names are unchanged: `handleCreateMachine`, `handleListMachines`, `handleRevokeMachine`.

- [ ] **Step 1: Point the existing tests at the new paths**

Every `SELF.fetch` in `apps/api/src/routes/machines.test.ts` targets `${BASE}/machines`. Change each to `${BASE}/api/machines`, and the two `describe` titles with it:

```ts
describe("POST /api/machines", () => {
	it("returns the raw token exactly once", async () => {
		const response = await SELF.fetch(`${BASE}/api/machines`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ name: "work laptop" }),
		});
		// ...assertions unchanged
	});
});

describe("DELETE /api/machines/:id", () => {
	// ...`${BASE}/api/machines/${id}`
});
```

Do not change a single assertion. This task moves a path and must not move behavior; if an assertion needs editing, something else is wrong and you should stop.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @onlooker/api exec vitest run src/routes/machines.test.ts`

Expected: FAIL. Every case answers **404**, because the router still has the old paths and an unmatched path falls through to the not-found response.

- [ ] **Step 3: Move the three route-table entries**

In `apps/api/src/router.ts`, the machine tokens block becomes:

```ts
	// =========================================================================
	// Machine tokens (subsystem 3 - credentials for non-browser clients)
	//
	// Under /api/ with the other session-authenticated routes, not beside the
	// machine-authenticated /lessons ingest. The prefix is what createMockFetch
	// claims, so a route outside it cannot be mocked in development and cannot
	// be reached by an api-contract case - which is how this surface, the one
	// place in the product that mints a credential, spent three PRs as the only
	// one outside the drift gate built after the blanked dashboard.
	// =========================================================================
	{
		method: "POST",
		path: "/api/machines",
		handler: handleCreateMachine,
	},
	{
		method: "GET",
		path: "/api/machines",
		handler: handleListMachines,
	},
	{
		method: "DELETE",
		path: "/api/machines/:id",
		handler: handleRevokeMachine,
	},
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @onlooker/api exec vitest run src/routes/machines.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Run the whole API suite**

Run: `pnpm --filter @onlooker/api exec vitest run`
Expected: PASS. `router.test.ts` mentions `/machines/:id` only inside a comment explaining which segment holds the parameter, so nothing there should break — if it does, read the failure rather than editing the comment.

- [ ] **Step 6: Commit**

Route through `/commit`. Stage exactly:

```bash
git add apps/api/src/router.ts apps/api/src/routes/machines.test.ts
```

Subject should say why the prefix matters, not that paths moved. Something in the shape of `refactor(api): put the machine routes where the mock can see them`.

---

## Task 2: Teach the mock the machine lifecycle

Unlike the lesson pool — permanently empty in the mock, because only a machine-authenticated push can fill it — a browser is the *only* thing that can mint a machine token. So the mock can model the entire lifecycle, and must: the reveal, "never used" and revoke are otherwise unreachable in development, and this is the surface where getting them wrong costs a person their only copy of a credential.

**Files:**
- Modify: `apps/web/src/api/mockApi.ts` (add to `mockDataApi`, which starts at line 579)
- Test: `apps/web/src/api/mockMachines.test.ts` (create)

**Interfaces:**
- Consumes: the paths from Task 1.
- Produces: mock responses matching the API exactly — `POST` → 201 `{ id, name, token }`; `GET` → 200 `{ machines: MockMachine[] }` where `MockMachine` is `{ id, name, created_at, last_used_at, revoked_at }`; `DELETE` → 200 `{ success: true }` or 404. Task 3 pins these against both implementations; Task 4's client types mirror them.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/api/mockMachines.test.ts`:

```tsx
import { beforeEach, describe, expect, it } from "vitest";
import { createMockFetch } from "./mockApi";

// The mock's machine lifecycle, tested on its own rather than only through the
// shared contract. The contract pins what both implementations must agree on;
// this pins the parts that only exist so the page can be developed at all -
// that a second machine appears in the list, that a revoked one stays visible
// and marked. A contract case would have to be true of apps/api too, and
// several of these are about the mock's in-memory store specifically.

const PASSWORD = "password123";

let fetchMock: ReturnType<typeof createMockFetch>;
let token: string;
let accountCounter = 0;

async function mint(name: string) {
	return fetchMock("/api/machines", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ name }),
	});
}

async function list() {
	return fetchMock("/api/machines", {
		method: "GET",
		headers: { Authorization: `Bearer ${token}` },
	});
}

beforeEach(async () => {
	fetchMock = createMockFetch();

	// A fresh account per test, not the shared seeded one. MACHINES is module
	// state and vitest resets modules between FILES, not between tests, so any
	// case asserting an exact list length has to own its account. The store is
	// keyed by email, so this uses the mock's own isolation rather than adding
	// a reset hook that nothing in production would ever call - and a clear()
	// inside createMockFetch would break api-contract.test.ts, which builds a
	// fresh mock fetch for every case.
	accountCounter += 1;
	const signup = await fetchMock("/auth/signup", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email: `machines-${accountCounter}@example.com`,
			password: PASSWORD,
			name: "Ada",
		}),
	});
	// The mock answers 201 with { token, refreshToken, user }, matching apps/api.
	expect(signup.status).toBe(201);
	token = ((await signup.json()) as { token: string }).token;
});

describe("the mock's machine lifecycle", () => {
	it("hands back a token shaped like the one apps/api mints", async () => {
		const response = await mint("work laptop");
		expect(response.status).toBe(201);
		const created = (await response.json()) as { id: string; token: string };
		// Same shape as createMachineToken: the prefix is what secret scanners
		// grep for, and the contract's forbidden list greps for it too. A mock
		// minting a different shape would let a leak through on the one side
		// the gate cannot see.
		expect(created.token).toMatch(/^onlk_[0-9a-f]{64}$/);
		expect(created.id).toBeTruthy();
	});

	it("never returns the token again once it has been minted", async () => {
		const created = (await (await mint("work laptop")).json()) as {
			token: string;
		};
		const body = await (await list()).text();
		expect(body).not.toContain(created.token);
		expect(body).not.toContain("onlk_");
	});

	it("starts a fresh machine as never used", async () => {
		await mint("work laptop");
		const { machines } = (await (await list()).json()) as {
			machines: Array<{ name: string; last_used_at: string | null }>;
		};
		expect(machines).toHaveLength(1);
		// Null, not an empty string and not omitted. The page renders a
		// distinct "Never used" treatment off exactly this, and a "" would
		// render as a blank cell - the failure the treatment exists to prevent.
		expect(machines[0].last_used_at).toBeNull();
	});

	it("keeps every machine the account has minted", async () => {
		await mint("work laptop");
		await mint("desktop");
		const { machines } = (await (await list()).json()) as {
			machines: Array<{ name: string }>;
		};
		expect(machines.map((m) => m.name)).toEqual(["work laptop", "desktop"]);
	});

	it("rejects a name that is only whitespace", async () => {
		const response = await mint("   ");
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error?: { code?: string } };
		expect(JSON.stringify(body)).toContain("invalid_name");
	});

	it("marks a revoked machine rather than dropping it from the list", async () => {
		const { id } = (await (await mint("stolen laptop")).json()) as {
			id: string;
		};
		const revoke = await fetchMock(`/api/machines/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(revoke.status).toBe(200);

		const { machines } = (await (await list()).json()) as {
			machines: Array<{ id: string; revoked_at: string | null }>;
		};
		// listMachineTokens in apps/api selects every row for the user with no
		// filter on revoked_at, so the mock keeps them too. A user who revokes
		// a laptop should be able to see that they did.
		expect(machines).toHaveLength(1);
		expect(machines[0].revoked_at).not.toBeNull();
	});

	it("404s a second revoke of the same machine", async () => {
		const { id } = (await (await mint("stolen laptop")).json()) as {
			id: string;
		};
		await fetchMock(`/api/machines/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		const again = await fetchMock(`/api/machines/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		// revokeMachineToken filters on isNull(revoked_at) and returns false
		// when nothing matched, which handleRevokeMachine turns into a 404.
		// Answering 200 twice would tell a user the second revoke did something.
		expect(again.status).toBe(404);
	});

	it("404s a machine id that was never minted", async () => {
		const response = await fetchMock("/api/machines/does-not-exist", {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(response.status).toBe(404);
	});

	it("refuses every verb without a token", async () => {
		for (const init of [
			{ method: "GET" },
			{ method: "POST", body: JSON.stringify({ name: "x" }) },
			{ method: "DELETE" },
		] as RequestInit[]) {
			const path =
				init.method === "DELETE" ? "/api/machines/anything" : "/api/machines";
			expect((await fetchMock(path, init)).status).toBe(401);
		}
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @onlooker/web exec vitest run src/api/mockMachines.test.ts`

Expected: FAIL. `/api/machines` reaches `mockDataApi`, matches no branch, and falls through to whatever that function does with an unknown `/api/` path — read the bottom of `mockDataApi` to see the exact failure rather than assuming a 404.

- [ ] **Step 3: Add the machine store and its branches**

In `apps/web/src/api/mockApi.ts`, above `mockDataApi`, add the store:

```ts
/**
 * A machine as the mock holds it. Mirrors MachineTokenSummary in
 * apps/api/src/db/machine-tokens.ts field for field - everything the browser
 * is allowed to see, which is everything except anything that authenticates.
 */
interface MockMachine {
	id: string;
	name: string;
	created_at: string;
	last_used_at: string | null;
	revoked_at: string | null;
}

/**
 * Per-account machines, keyed by email like the rest of the mock's state.
 *
 * The lesson pool above is permanently empty because only a machine-
 * authenticated push can fill it and a browser cannot make one. Machines are
 * the opposite: a browser is the only thing that can mint one, so the mock can
 * model the whole lifecycle - and has to, because the reveal, the "never used"
 * treatment and revoke are otherwise unreachable in development.
 */
const MACHINES = new Map<string, MockMachine[]>();

function machinesOf(email: string): MockMachine[] {
	const existing = MACHINES.get(email);
	if (existing) return existing;
	const fresh: MockMachine[] = [];
	MACHINES.set(email, fresh);
	return fresh;
}

let mockMachineCounter = 0;

/**
 * `onlk_` plus 64 hex characters, the shape createMachineToken mints.
 *
 * Deterministic rather than random on purpose: the mock is not a security
 * boundary, and a predictable value is assertable. The shape still matters -
 * the contract's forbidden list greps for the prefix, so a mock minting a
 * different one would let a leaked token through on the side the gate cannot
 * see. The raw value is returned and then dropped; nothing here retains it.
 */
function mintMockMachineToken(): string {
	mockMachineCounter += 1;
	return `onlk_${mockMachineCounter.toString(16).padStart(64, "0")}`;
}
```

Then inside `mockDataApi`, beside the lesson-pool branches and using the same `poolPath` that strips the query string:

```ts
	if (poolPath === "/api/machines" && (options.method ?? "GET") === "GET") {
		const { email } = requireAuth(options);
		return json({ machines: machinesOf(email) });
	}

	if (poolPath === "/api/machines" && options.method === "POST") {
		const { email } = requireAuth(options);
		const body = readBody<{ name?: unknown }>(options);
		// Trimmed before the emptiness check, matching handleCreateMachine.
		// A mock that accepted "   " would let a machine named nothing into
		// the list in development and 400 in production.
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name) {
			throw new AuthApiError(400, "invalid_name", "A machine needs a name");
		}

		mockMachineCounter += 1;
		const id = `mock-machine-${mockMachineCounter}`;
		machinesOf(email).push({
			id,
			name,
			created_at: new Date().toISOString(),
			last_used_at: null,
			revoked_at: null,
		});

		// The raw token appears here and nowhere else, ever - the same promise
		// handleCreateMachine makes. Nothing above stored it.
		return json({ id, name, token: mintMockMachineToken() }, 201);
	}

	if (poolPath.startsWith("/api/machines/") && options.method === "DELETE") {
		const { email } = requireAuth(options);
		const id = poolPath.slice("/api/machines/".length);
		const machine = machinesOf(email).find(
			(candidate) => candidate.id === id && !candidate.revoked_at,
		);
		// 404 and not 403, matching handleRevokeMachine. A 403 would confirm
		// the id exists, which is an existence oracle over other users' rows -
		// and because the lookup is scoped to this account, "someone else's"
		// and "never existed" are already indistinguishable here.
		if (!machine) {
			throw new AuthApiError(404, "not_found", "No such machine");
		}
		machine.revoked_at = new Date().toISOString();
		return json({ success: true });
	}
```

Note the ordering: the exact-match branches come before the `startsWith` one, and only `DELETE` reaches the parameterized branch, so `/api/machines` itself can never be read as an id.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @onlooker/web exec vitest run src/api/mockMachines.test.ts`
Expected: PASS, all nine cases.

- [ ] **Step 5: Run the whole web suite**

Run: `pnpm --filter @onlooker/web exec vitest run`
Expected: PASS. `mockApi.test.ts` and `mockResources.test.ts` cover neighboring branches; if either fails, the new branch is matching a path it should not.

- [ ] **Step 6: Commit**

Route through `/commit`. Stage exactly:

```bash
git add apps/web/src/api/mockApi.ts apps/web/src/api/mockMachines.test.ts
```

---

## Task 3: Put the machines surface inside the contract gate

`packages/api-contract` exists because a mock and an API drifted apart and blanked the dashboard for every logged-in user. Machines had no case in it at all, which left the one surface in the product that mints a credential as the only one outside that gate. Two of the checks fit the static case table; the rest have to be driven as a flow, because every step needs the id or the token the step before it returned and a literal `path` cannot express "revoke the one you just made."

**Files:**
- Modify: `packages/api-contract/src/index.ts` — add to `authenticatedCases()` (starts line 285) and export `MACHINE_LIFECYCLE` beside `SESSION_LIFECYCLE` (line 189)
- Modify: `apps/api/src/contract.test.ts`
- Modify: `apps/web/src/api/api-contract.test.ts`

**Interfaces:**
- Consumes: the paths from Task 1 and the mock branches from Task 2. Both must be done, or one side of the gate fails for a reason that has nothing to do with this task.
- Produces: `MACHINE_LIFECYCLE`, a frozen object of expected statuses and flags, imported by both runners.

- [ ] **Step 1: Write the shared contract additions**

In `packages/api-contract/src/index.ts`, add two entries to the array `authenticatedCases()` returns, beside the lesson-pool case:

```ts
		{
			name: "machines list, valid token",
			path: "/api/machines",
			init: { method: "GET" },
			status: 200,
			// `machines` is an array even when the account has none. The page
			// renders its empty state from this, and a missing key throws.
			body: { machines: expectArray },
			// Not the bare word "token": a machine someone names "work token
			// laptop" would trip a substring search and fail a green suite for
			// no reason. `onlk_` is the prefix every minted token carries and
			// nothing else does, which makes it the exact tripwire for the one
			// thing that must never appear in a list response.
			forbidden: [...NO_SECRETS, "token_hash", "onlk_"],
		},
		{
			name: "machine with a blank name",
			path: "/api/machines",
			init: json({ name: "   " }),
			status: 400,
		},
```

The blank-name case is safe to run against a real database because it is rejected before anything is written, and the list case is a read — neither leaves state behind for the cases after it.

Then export the lifecycle constants beside `SESSION_LIFECYCLE`:

```ts
/**
 * Minting, listing and revoking a machine credential.
 *
 * Driven as a flow rather than as cases, because every step needs the id or
 * the token the one before it returned, and a static `path` cannot say "revoke
 * the one you just made."
 *
 * This surface had no contract of any kind until 2026-08-25. It was registered
 * outside `/api/`, so no case could reach it through the mock, which made the
 * one place in the product that mints a credential the only one outside the
 * gate this package exists to be.
 */
export const MACHINE_LIFECYCLE = {
	/** Minting answers 201 and hands back the raw token. */
	create: 201,
	/**
	 * The prefix the raw token carries. Not decoration: it makes the value
	 * recognizable in a paste and greppable by secret scanners, which is what
	 * gets a leaked credential noticed.
	 */
	tokenPrefix: "onlk_",
	/** A name that is blank or only whitespace mints nothing. */
	blankName: 400,
	/**
	 * The raw token is in the create response and nowhere else, ever. The list
	 * is where a second copy would surface if one existed, so the list is where
	 * this is asserted.
	 */
	tokenInList: false,
	/** Revoking one you own succeeds. */
	revokeOwn: 200,
	/**
	 * And revoking it again answers 404, not 200. The row is already out of the
	 * caller's reach; reporting success twice would tell a user that a second
	 * revoke did something.
	 */
	revokeTwice: 404,
	/**
	 * Another user's machine answers 404, not 403. A 403 confirms the id
	 * exists, which is an existence oracle over other users' rows.
	 */
	revokeSomeoneElses: 404,
} as const;
```

- [ ] **Step 2: Write the failing flow test for `apps/api`**

Append to `apps/api/src/contract.test.ts`, following the shape of the existing `describe("apps/api account management")` block. Import `MACHINE_LIFECYCLE` from `@onlooker/api-contract` alongside `ACCOUNT_CONTRACT`:

```ts
describe("apps/api machine credentials", () => {
	let owner: string;
	let stranger: string;

	async function signup(email: string): Promise<string> {
		const res = await SELF.fetch(`${BASE}/auth/signup`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: "correct-horse-battery", name: "Ada" }),
		});
		expect(res.status, `fixture signup failed for ${email}`).toBe(201);
		return ((await res.json()) as { token: string }).token;
	}

	function as(token: string, init: RequestInit = {}): RequestInit {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${token}`);
		if (init.body) headers.set("Content-Type", "application/json");
		return { ...init, headers };
	}

	async function mint(token: string, name: string) {
		return SELF.fetch(
			`${BASE}/api/machines`,
			as(token, { method: "POST", body: JSON.stringify({ name }) }),
		);
	}

	beforeAll(async () => {
		owner = await signup("machine-owner@example.com");
		stranger = await signup("machine-stranger@example.com");
	});

	it("mints a token once and never shows it again", async () => {
		const created = await mint(owner, "work laptop");
		expect(created.status).toBe(MACHINE_LIFECYCLE.create);
		const { token } = (await created.json()) as { token: string };
		expect(token.startsWith(MACHINE_LIFECYCLE.tokenPrefix)).toBe(true);

		const list = await SELF.fetch(`${BASE}/api/machines`, as(owner));
		const body = await list.text();
		expect(body.includes(token)).toBe(MACHINE_LIFECYCLE.tokenInList);
		expect(body.includes(MACHINE_LIFECYCLE.tokenPrefix)).toBe(
			MACHINE_LIFECYCLE.tokenInList,
		);
	});

	it("rejects a name that is only whitespace", async () => {
		expect((await mint(owner, "   ")).status).toBe(MACHINE_LIFECYCLE.blankName);
	});

	it("revokes once and refuses a second time", async () => {
		const { id } = (await (await mint(owner, "stolen laptop")).json()) as {
			id: string;
		};
		const first = await SELF.fetch(
			`${BASE}/api/machines/${id}`,
			as(owner, { method: "DELETE" }),
		);
		expect(first.status).toBe(MACHINE_LIFECYCLE.revokeOwn);

		const second = await SELF.fetch(
			`${BASE}/api/machines/${id}`,
			as(owner, { method: "DELETE" }),
		);
		expect(second.status).toBe(MACHINE_LIFECYCLE.revokeTwice);
	});

	it("will not let one account revoke another's machine", async () => {
		const { id } = (await (await mint(owner, "shared name")).json()) as {
			id: string;
		};
		const response = await SELF.fetch(
			`${BASE}/api/machines/${id}`,
			as(stranger, { method: "DELETE" }),
		);
		// 404 and not 403 - see MACHINE_LIFECYCLE.revokeSomeoneElses.
		expect(response.status).toBe(MACHINE_LIFECYCLE.revokeSomeoneElses);
	});
});
```

- [ ] **Step 3: Write the same flow against the mock**

Append the equivalent block to `apps/web/src/api/api-contract.test.ts`. It is the same assertions against `createMockFetch()` instead of `SELF.fetch`, with the mock's seeded account as `owner` and a `freshEmail()` signup as `stranger`. Repeat the assertions in full rather than sharing a helper across the two files — the point of the contract is that two implementations answer independently, and a shared driver would let one file's bug hide in the other's.

```ts
describe("the mock's machine credentials", () => {
	const call = createMockFetch();
	let owner: string;
	let stranger: string;

	function as(token: string, init: RequestInit = {}): RequestInit {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${token}`);
		if (init.body) headers.set("Content-Type", "application/json");
		return { ...init, headers };
	}

	async function mint(token: string, name: string) {
		return call(
			"/api/machines",
			as(token, { method: "POST", body: JSON.stringify({ name }) }),
		);
	}

	beforeAll(async () => {
		const login = await call("/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: SEEDED_EMAIL, password: SEEDED_PASSWORD }),
		});
		expect(login.status, "fixture login failed").toBe(200);
		owner = ((await login.json()) as { token: string }).token;

		const signup = await call("/auth/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: freshEmail(),
				password: SEEDED_PASSWORD,
				name: "Grace",
			}),
		});
		stranger = ((await signup.json()) as { token: string }).token;
	});

	it("mints a token once and never shows it again", async () => {
		const created = await mint(owner, "work laptop");
		expect(created.status).toBe(MACHINE_LIFECYCLE.create);
		const { token } = (await created.json()) as { token: string };
		expect(token.startsWith(MACHINE_LIFECYCLE.tokenPrefix)).toBe(true);

		const body = await (await call("/api/machines", as(owner))).text();
		expect(body.includes(token)).toBe(MACHINE_LIFECYCLE.tokenInList);
		expect(body.includes(MACHINE_LIFECYCLE.tokenPrefix)).toBe(
			MACHINE_LIFECYCLE.tokenInList,
		);
	});

	it("rejects a name that is only whitespace", async () => {
		expect((await mint(owner, "   ")).status).toBe(MACHINE_LIFECYCLE.blankName);
	});

	it("revokes once and refuses a second time", async () => {
		const { id } = (await (await mint(owner, "stolen laptop")).json()) as {
			id: string;
		};
		expect(
			(await call(`/api/machines/${id}`, as(owner, { method: "DELETE" })))
				.status,
		).toBe(MACHINE_LIFECYCLE.revokeOwn);
		expect(
			(await call(`/api/machines/${id}`, as(owner, { method: "DELETE" })))
				.status,
		).toBe(MACHINE_LIFECYCLE.revokeTwice);
	});

	it("will not let one account revoke another's machine", async () => {
		const { id } = (await (await mint(owner, "shared name")).json()) as {
			id: string;
		};
		expect(
			(await call(`/api/machines/${id}`, as(stranger, { method: "DELETE" })))
				.status,
		).toBe(MACHINE_LIFECYCLE.revokeSomeoneElses);
	});
});
```

`call` is a single `createMockFetch()` shared across the block on purpose: the mock's machine store is module state keyed by account, so a fresh fetch per call would still see the same machines, but reusing one makes that obvious rather than incidental.

- [ ] **Step 4: Run both sides and verify they pass**

Run: `pnpm --filter @onlooker/api exec vitest run src/contract.test.ts`
Run: `pnpm --filter @onlooker/web exec vitest run src/api/api-contract.test.ts`

Expected: PASS on both. If exactly one fails, that is the gate working — the failing side is the one that has not caught up, and the fix belongs in that implementation and not in the contract.

- [ ] **Step 5: Run every suite**

Run: `pnpm --filter @onlooker/api exec vitest run`
Run: `pnpm --filter @onlooker/web exec vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

Route through `/commit`. Stage exactly:

```bash
git add packages/api-contract/src/index.ts apps/api/src/contract.test.ts apps/web/src/api/api-contract.test.ts
```

---

## Task 4: The typed client

**Files:**
- Create: `apps/web/src/api/machinesApi.ts`

**Interfaces:**
- Consumes: `apiClient` from `./client`, which already owns the `Authorization` header, backoff retry and one refresh-and-replay on 401. None of that is re-implemented here.
- Produces: `Machine`, `MintedMachine`, `listMachines()`, `createMachine(name)`, `revokeMachine(id)` — the names Tasks 5 and 6 import.

- [ ] **Step 1: Write the file**

There is no separate test for this task. It is a thin typed surface over `apiClient` with no branching of its own; Tasks 2 and 3 pin the wire shapes it describes, and Task 6's page tests drive every function through a stubbed module. A test here would assert that `apiClient.get` was called with a string.

Create `apps/web/src/api/machinesApi.ts`:

```ts
import { apiClient } from "./client";

// Machine credentials, as the browser is allowed to see them. Beside
// accountApi.ts and deliberately the same shape: transport - auth header,
// retries, refresh-and-replay on 401 - belongs to client.ts and is not
// re-implemented here.
//
// These endpoints are browser-authenticated by design. A machine token cannot
// mint another one, which is what makes revoking a stolen laptop actually
// revoke it rather than leave behind the credentials it issued for itself.

export const MACHINE_ENDPOINTS = {
	machines: "/api/machines",
} as const;

/**
 * A machine as the list returns it: everything except anything that can be
 * used to authenticate. Mirrors MachineTokenSummary in apps/api.
 *
 * `last_used_at` is null for a machine no plugin has ever presented, and that
 * null is load-bearing - it is the difference the page renders as "Never used"
 * rather than as a blank cell.
 */
export interface Machine {
	id: string;
	name: string;
	created_at: string;
	last_used_at: string | null;
	revoked_at: string | null;
}

/**
 * The create response, and the only moment the raw token exists anywhere the
 * browser can read it. It is never stored and never re-fetchable, which is why
 * `token` is on this type and not on `Machine`.
 */
export interface MintedMachine {
	id: string;
	name: string;
	token: string;
}

export function listMachines(): Promise<{ machines: Machine[] }> {
	return apiClient.get<{ machines: Machine[] }>(MACHINE_ENDPOINTS.machines);
}

export function createMachine(name: string): Promise<MintedMachine> {
	return apiClient.post<MintedMachine>(MACHINE_ENDPOINTS.machines, { name });
}

export function revokeMachine(id: string): Promise<{ success: boolean }> {
	return apiClient.delete<{ success: boolean }>(
		`${MACHINE_ENDPOINTS.machines}/${encodeURIComponent(id)}`,
	);
}
```

- [ ] **Step 2: Verify it compiles and nothing regressed**

Run: `pnpm --filter @onlooker/web exec tsc --noEmit`
Run: `pnpm --filter @onlooker/web exec vitest run`
Expected: PASS. A failure here is almost certainly `apiClient.delete` not existing with that signature — check `createAuthApiClient` in `@onlooker/auth-react` before changing anything, since `deleteAccount` in `accountApi.ts:96` already calls it this way.

- [ ] **Step 3: Commit**

Route through `/commit`. Stage exactly:

```bash
git add apps/web/src/api/machinesApi.ts
```

---

## Task 5: The one-time reveal

`handleCreateMachine` returns the raw token in the create response and nowhere else, ever — only its SHA-256 reaches the database. This component is the entire consequence of that sentence, which is why it is its own file: it owns focus, keyboard and unload behavior, and none of that belongs in a page that also lists rows.

**Files:**
- Create: `apps/web/src/components/TokenReveal.tsx`
- Test: `apps/web/src/__tests__/token-reveal.test.tsx`

**Interfaces:**
- Consumes: `MintedMachine` from Task 4; `Button` and `Panel` from `components/ui.tsx`; `PALETTE` from `components/palette.ts`.
- Produces: `export default function TokenReveal({ machine, onDismiss }: { machine: MintedMachine; onDismiss: () => void })`. Task 6 renders it and passes `onDismiss` to clear its own state.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/__tests__/token-reveal.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TokenReveal from "../components/TokenReveal";

// Every test here is about a way the token could be lost. The component's whole
// reason to exist is that the value it displays cannot be fetched again, so
// "does it render" is the least interesting thing about it.

const MACHINE = {
	id: "m1",
	name: "work laptop",
	token: `onlk_${"a".repeat(64)}`,
};

const writeText = vi.fn();

beforeEach(() => {
	writeText.mockReset().mockResolvedValue(undefined);
	// jsdom ships no clipboard at all, so this is a definition rather than a
	// spy on something existing.
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
});

function renderReveal(onDismiss = vi.fn()) {
	const result = render(
		<TokenReveal machine={MACHINE} onDismiss={onDismiss} />,
	);
	return { ...result, onDismiss };
}

describe("TokenReveal", () => {
	it("shows the token and says it will not be shown again", () => {
		renderReveal();
		expect(screen.getByText(MACHINE.token)).toBeDefined();
		expect(screen.getByRole("dialog").textContent).toMatch(/only time|again/i);
	});

	// Escape is the reflex that closes a dialog. This is the one dialog where
	// the reflex costs the credential, so it is swallowed on purpose.
	it("does not dismiss on Escape", () => {
		const { onDismiss } = renderReveal();
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onDismiss).not.toHaveBeenCalled();
		expect(screen.getByText(MACHINE.token)).toBeDefined();
	});

	it("does not dismiss when the backdrop is clicked", () => {
		const { onDismiss, container } = renderReveal();
		// The backdrop is the fixed-position element wrapping the dialog. It
		// carries no click handler at all, which is what this asserts.
		fireEvent.click(container.firstChild as HTMLElement);
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it("dismisses only on the explicit acknowledgement", () => {
		const { onDismiss } = renderReveal();
		fireEvent.click(screen.getByRole("button", { name: /saved it/i }));
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("starts focus inside the dialog", () => {
		renderReveal();
		// Otherwise Tab begins at the top of the document and walks the nav
		// behind the modal before it ever reaches the copy button.
		expect(document.activeElement).toBe(screen.getByRole("dialog"));
	});

	it("copies the token to the clipboard", async () => {
		renderReveal();
		fireEvent.click(screen.getByRole("button", { name: /^copy/i }));
		expect(writeText).toHaveBeenCalledWith(MACHINE.token);
		expect(await screen.findByText(/copied/i)).toBeDefined();
	});

	// Claiming a copy that did not happen is the worst thing this component
	// could do: the person dismisses the only copy they will ever see, trusting
	// a clipboard that is empty.
	it("says so when the copy fails, and keeps the token on screen", async () => {
		writeText.mockRejectedValue(new Error("denied"));
		renderReveal();
		fireEvent.click(screen.getByRole("button", { name: /^copy/i }));
		expect(await screen.findByText(/copy failed/i)).toBeDefined();
		expect(screen.getByText(MACHINE.token)).toBeDefined();
	});

	// The modal covers in-app navigation by trapping focus. Reload, back and
	// closing the tab are the exits it cannot reach.
	it("warns before the page unloads while it is open", () => {
		const { unmount } = renderReveal();

		const during = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(during);
		expect(during.defaultPrevented).toBe(true);

		unmount();
		const after = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(after);
		// The listener must come off, or every later navigation in the session
		// prompts about a token that is long gone.
		expect(after.defaultPrevented).toBe(false);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/token-reveal.test.tsx`
Expected: FAIL — `Failed to resolve import "../components/TokenReveal"`.

- [ ] **Step 3: Write the component**

Create `apps/web/src/components/TokenReveal.tsx`:

```tsx
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { MintedMachine } from "../api/machinesApi";
import { PALETTE } from "./palette";
import { Button, Panel } from "./ui";

/**
 * The one-time reveal.
 *
 * `handleCreateMachine` returns the raw token in the create response and
 * nowhere else, ever - only its SHA-256 is stored - so this really is the only
 * chance. Every decision below follows from that one fact:
 *
 * - The only way out is "I've saved it". Escape does not close it and neither
 *   does the backdrop, because those are the two gestures a person makes
 *   without having decided anything.
 * - Focus is trapped, so Tab cannot walk into the nav behind the modal. That
 *   is also what makes a navigation guard unnecessary: there is nothing
 *   reachable to navigate with. The spec asked for a prompt on navigating away,
 *   which reads as `useBlocker` - unavailable here, because main.tsx mounts
 *   BrowserRouter rather than a data router. See the 2026-08-25 amendment.
 * - `beforeunload` still covers reload, back, and closing the tab, which are
 *   the exits a modal cannot reach.
 * - A failed copy says failed. Telling someone their only copy is on the
 *   clipboard when it is not is the worst outcome this component has.
 */
export default function TokenReveal({
	machine,
	onDismiss,
}: {
	machine: MintedMachine;
	onDismiss: () => void;
}) {
	const dialogRef = useRef<HTMLDivElement>(null);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
		"idle",
	);

	useEffect(() => {
		const warn = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			// preventDefault alone is the current spec; returnValue is what
			// actually raises the prompt in Chrome and Safari today.
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, []);

	useEffect(() => {
		// So a screen reader announces the dialog, and so Tab starts inside it
		// rather than at the top of the document.
		dialogRef.current?.focus();
	}, []);

	const keepFocusInside = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			return;
		}
		if (event.key !== "Tab") return;

		const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button");
		if (!focusable || focusable.length === 0) return;

		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(machine.token);
			setCopyState("copied");
		} catch {
			// Includes the case where there is no clipboard API at all - an
			// insecure context, or a browser that withholds it.
			setCopyState("failed");
		}
	};

	return (
		<div
			style={{
				position: "fixed",
				inset: 0,
				background: "rgba(0, 0, 0, 0.6)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				padding: "1rem",
				zIndex: 10,
			}}
		>
			{/*
			  No onClick on the backdrop. Click-outside-to-close would be the
			  third way to lose the token by accident, after a timeout and
			  Escape, and it is the one people trigger without noticing.
			*/}
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="token-reveal-title"
				tabIndex={-1}
				onKeyDown={keepFocusInside}
				style={{ width: "100%", maxWidth: "34rem" }}
			>
				<Panel>
					<h2
						id="token-reveal-title"
						style={{
							margin: "0 0 0.75rem",
							fontFamily: "var(--font-display)",
							fontSize: "16px",
							letterSpacing: "1px",
						}}
					>
						Save this token now
					</h2>

					<p style={{ margin: "0 0 1rem" }}>
						This is the only time the token for <strong>{machine.name}</strong>{" "}
						will be shown. It is not stored anywhere it can be read back.
					</p>

					<code
						style={{
							display: "block",
							padding: "0.75rem",
							marginBottom: "0.75rem",
							background: "var(--ground)",
							border: `2px solid ${PALETTE.border}`,
							// The value is 69 characters and must survive being
							// selected by hand when the clipboard is unavailable.
							wordBreak: "break-all",
							fontFamily: "var(--font-mono, monospace)",
						}}
					>
						{machine.token}
					</code>

					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: "0.75rem",
							flexWrap: "wrap",
							marginBottom: "1rem",
						}}
					>
						<Button onClick={copy}>Copy token</Button>
						{copyState === "copied" ? (
							<span style={{ color: PALETTE.muted }}>Copied.</span>
						) : null}
						{copyState === "failed" ? (
							<span role="alert" style={{ color: PALETTE.danger }}>
								Copy failed — select the token above and copy it by hand.
							</span>
						) : null}
					</div>

					<p style={{ color: PALETTE.muted, margin: "0 0 1rem" }}>
						Lost it? Revoke this machine and mint another. There is no way to
						recover this value.
					</p>

					<Button onClick={onDismiss}>I&apos;ve saved it</Button>
				</Panel>
			</div>
		</div>
	);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/token-reveal.test.tsx`
Expected: PASS, all eight cases.

- [ ] **Step 5: Run the whole web suite**

Run: `pnpm --filter @onlooker/web exec vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

Route through `/commit`. Stage exactly:

```bash
git add apps/web/src/components/TokenReveal.tsx apps/web/src/__tests__/token-reveal.test.tsx
```

---

## Task 6: The machines page

**Files:**
- Create: `apps/web/src/pages/MachinesPage.tsx`
- Test: `apps/web/src/__tests__/machines-page.test.tsx`

**Interfaces:**
- Consumes: `listMachines`, `createMachine`, `revokeMachine`, `Machine`, `MintedMachine` from Task 4; `TokenReveal` from Task 5; `Button`, `Chip`, `EmptyState`, `Panel` from `components/ui.tsx`; `TextField`, `SubmitButton` from `components/form.tsx`; `describeError` from `lib/apiErrors.ts`.
- Produces: `export default function MachinesPage()`, taking no props. Task 7 routes to it.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/__tests__/machines-page.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// machinesApi is the seam, matching login-page.test.tsx: stubbing the three
// functions drives every failure path without standing up an API client, and
// leaves the form, the confirm flow and the reveal real.
const mocks = vi.hoisted(() => ({
	listMachines: vi.fn(),
	createMachine: vi.fn(),
	revokeMachine: vi.fn(),
}));

vi.mock("../api/machinesApi", () => ({
	MACHINE_ENDPOINTS: { machines: "/api/machines" },
	listMachines: mocks.listMachines,
	createMachine: mocks.createMachine,
	revokeMachine: mocks.revokeMachine,
}));

const { default: MachinesPage } = await import("../pages/MachinesPage");

const USED = {
	id: "m1",
	name: "work laptop",
	created_at: "2026-08-01T10:00:00.000Z",
	last_used_at: "2026-08-20T09:30:00.000Z",
	revoked_at: null,
};
const NEVER_USED = {
	id: "m2",
	name: "desktop",
	created_at: "2026-08-02T10:00:00.000Z",
	last_used_at: null,
	revoked_at: null,
};
const REVOKED = {
	id: "m3",
	name: "stolen laptop",
	created_at: "2026-08-03T10:00:00.000Z",
	last_used_at: "2026-08-04T10:00:00.000Z",
	revoked_at: "2026-08-05T10:00:00.000Z",
};

function withMachines(...machines: unknown[]) {
	mocks.listMachines.mockResolvedValue({ machines });
}

beforeEach(() => {
	mocks.listMachines.mockReset();
	mocks.createMachine.mockReset();
	mocks.revokeMachine.mockReset();
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText: vi.fn().mockResolvedValue(undefined) },
		configurable: true,
	});
});

async function renderPage() {
	const result = render(<MachinesPage />);
	await waitFor(() => expect(mocks.listMachines).toHaveBeenCalled());
	return result;
}

describe("MachinesPage", () => {
	it("says how to recover a lost token when there are no machines", async () => {
		withMachines();
		await renderPage();
		// Recovery is revoke-and-mint-again and there is no other path, so the
		// empty state says it rather than leaving it to be discovered.
		const empty = await screen.findByText(/no machines yet/i);
		expect(empty).toBeDefined();
		expect(document.body.textContent).toMatch(/revoke/i);
	});

	it("lists machines by name", async () => {
		withMachines(USED, NEVER_USED);
		await renderPage();
		expect(await screen.findByText("work laptop")).toBeDefined();
		expect(screen.getByText("desktop")).toBeDefined();
	});

	// A dash in a column does not say "you minted this and never pointed a
	// plugin at it", which is the likeliest first-run failure in the product.
	it("renders never-used distinctly from a last-used timestamp", async () => {
		withMachines(USED, NEVER_USED);
		await renderPage();

		expect(await screen.findByText(/never used/i)).toBeDefined();
		// Asserted on the machine-readable attribute rather than the rendered
		// text, which is locale-dependent and would fail on another machine.
		const used = document.querySelector(`time[datetime="${USED.last_used_at}"]`);
		expect(used).not.toBeNull();
	});

	it("shows the token once and lets it go only on acknowledgement", async () => {
		withMachines();
		const token = `onlk_${"b".repeat(64)}`;
		mocks.createMachine.mockResolvedValue({ id: "m9", name: "new", token });
		await renderPage();

		fireEvent.change(screen.getByLabelText(/machine name/i), {
			target: { value: "new" },
		});
		fireEvent.click(screen.getByRole("button", { name: /mint token/i }));

		expect(await screen.findByText(token)).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: /saved it/i }));
		await waitFor(() => expect(screen.queryByText(token)).toBeNull());
	});

	it("surfaces the API's own message when minting fails", async () => {
		withMachines();
		mocks.createMachine.mockRejectedValue(new Error("A machine needs a name"));
		await renderPage();

		fireEvent.change(screen.getByLabelText(/machine name/i), {
			target: { value: "   x" },
		});
		fireEvent.click(screen.getByRole("button", { name: /mint token/i }));

		// The API's sentence, not "Request failed with status 400" - the whole
		// point of #85.
		expect(await screen.findByText(/a machine needs a name/i)).toBeDefined();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("asks inline before revoking, and cancelling leaves the row alone", async () => {
		withMachines(USED);
		await renderPage();

		fireEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));
		expect(screen.getByText(/revoke work laptop\?/i)).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
		expect(mocks.revokeMachine).not.toHaveBeenCalled();
		expect(screen.getByText("work laptop")).toBeDefined();
	});

	it("revokes on confirmation and reloads the list", async () => {
		withMachines(USED);
		mocks.revokeMachine.mockResolvedValue({ success: true });
		await renderPage();

		fireEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));
		mocks.listMachines.mockResolvedValue({
			machines: [{ ...USED, revoked_at: "2026-08-25T00:00:00.000Z" }],
		});
		fireEvent.click(screen.getByRole("button", { name: /yes, revoke/i }));

		await waitFor(() =>
			expect(mocks.revokeMachine).toHaveBeenCalledWith(USED.id),
		);
		expect(await screen.findByText(/revoked/i)).toBeDefined();
	});

	// No optimistic update, so there is nothing to roll back - and nothing on
	// screen claiming a credential is dead while it is still live.
	it("leaves the row untouched when a revoke fails", async () => {
		withMachines(USED);
		mocks.revokeMachine.mockRejectedValue(new Error("No such machine"));
		await renderPage();

		fireEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));
		fireEvent.click(screen.getByRole("button", { name: /yes, revoke/i }));

		expect(await screen.findByText(/no such machine/i)).toBeDefined();
		expect(screen.getByText("work laptop")).toBeDefined();
		expect(screen.queryByText(/^revoked$/i)).toBeNull();
	});

	it("keeps a revoked machine visible and gives it nothing to do", async () => {
		withMachines(REVOKED);
		await renderPage();
		expect(await screen.findByText("stolen laptop")).toBeDefined();
		expect(screen.queryByRole("button", { name: /^revoke$/i })).toBeNull();
	});

	it("offers a retry when the list cannot be loaded", async () => {
		mocks.listMachines.mockRejectedValue(new Error("Network unreachable"));
		await renderPage();

		expect(await screen.findByText(/network unreachable/i)).toBeDefined();
		withMachines(USED);
		fireEvent.click(screen.getByRole("button", { name: /retry/i }));
		expect(await screen.findByText("work laptop")).toBeDefined();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/machines-page.test.tsx`
Expected: FAIL — `Failed to resolve import "../pages/MachinesPage"`.

- [ ] **Step 3: Write the page**

Create `apps/web/src/pages/MachinesPage.tsx`:

```tsx
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
	createMachine,
	listMachines,
	type Machine,
	type MintedMachine,
	revokeMachine,
} from "../api/machinesApi";
import { SubmitButton, TextField } from "../components/form";
import { PALETTE } from "../components/palette";
import TokenReveal from "../components/TokenReveal";
import { Button, Chip, EmptyState, Panel } from "../components/ui";
import { describeError } from "../lib/apiErrors";

// Machine credentials, from the browser. POST /api/machines is browser-
// authenticated by design - a machine token cannot mint another, so revoking a
// stolen laptop actually revokes it - and until this page existed nothing in
// the browser called it, which meant nobody could turn the sync protocol on.

const cell = {
	borderBottom: `2px solid ${PALETTE.border}`,
	padding: "0.5rem",
	textAlign: "left" as const,
	verticalAlign: "top" as const,
};

/**
 * An instant, rendered so its value survives being read by a machine.
 * `toLocaleDateString` alone would make any assertion about it depend on the
 * runner's locale.
 */
function When({ iso }: { iso: string }) {
	return <time dateTime={iso}>{new Date(iso).toLocaleDateString()}</time>;
}

export default function MachinesPage() {
	const [machines, setMachines] = useState<Machine[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [minting, setMinting] = useState(false);
	const [mintError, setMintError] = useState<string | null>(null);
	const [revealed, setRevealed] = useState<MintedMachine | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [revoking, setRevoking] = useState<string | null>(null);
	const [revokeError, setRevokeError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoadError(null);
		try {
			const { machines: rows } = await listMachines();
			setMachines(rows);
		} catch (error) {
			setMachines(null);
			setLoadError(describeError(error, "Could not load your machines."));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const mint = async (event: FormEvent) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed || minting) return;

		setMinting(true);
		setMintError(null);
		try {
			const created = await createMachine(trimmed);
			// The reveal goes up before the list is reloaded. If that reload
			// throws, the person still has their token on screen - losing the
			// only copy to a failed GET would be the one unrecoverable failure
			// this page is capable of.
			setRevealed(created);
			setName("");
			await load();
		} catch (error) {
			setMintError(describeError(error, "Could not mint a token."));
		} finally {
			setMinting(false);
		}
	};

	const revoke = async (id: string) => {
		setRevoking(id);
		setRevokeError(null);
		try {
			await revokeMachine(id);
			setConfirming(null);
			await load();
		} catch (error) {
			// Nothing was marked revoked ahead of the server, so there is
			// nothing to undo. A row that claimed a credential was dead while
			// it was still live is worse than a slow button.
			setRevokeError(describeError(error, "Could not revoke that machine."));
		} finally {
			setRevoking(null);
		}
	};

	const action = (machine: Machine) => {
		// A revoked machine keeps its row - that is how a person sees that they
		// revoked it - but there is nothing left to do to it.
		if (machine.revoked_at) return null;

		if (confirming !== machine.id) {
			return (
				<Button
					variant="danger"
					onClick={() => {
						setRevokeError(null);
						setConfirming(machine.id);
					}}
				>
					Revoke
				</Button>
			);
		}

		return (
			<div
				style={{
					display: "flex",
					gap: "0.5rem",
					alignItems: "center",
					flexWrap: "wrap",
				}}
			>
				{/*
				  Inline rather than window.confirm. Revocation is the most
				  destructive act on this page, and the app should not hand it
				  to a native dialog that looks like nothing else in it.
				*/}
				<span>Revoke {machine.name}?</span>
				<Button
					variant="danger"
					loading={revoking === machine.id}
					loadingLabel="Revoking..."
					onClick={() => void revoke(machine.id)}
				>
					Yes, revoke
				</Button>
				<Button
					onClick={() => setConfirming(null)}
					disabled={revoking === machine.id}
				>
					Cancel
				</Button>
			</div>
		);
	};

	return (
		<>
			{revealed ? (
				<TokenReveal machine={revealed} onDismiss={() => setRevealed(null)} />
			) : null}

			<Panel title="Mint a machine token">
				<p style={{ marginTop: 0 }}>
					A machine token is how a plugin pushes lessons to the pool. It is
					shown once, when it is created, and never again.
				</p>
				<form onSubmit={mint}>
					<TextField
						id="machine-name"
						label="Machine name"
						value={name}
						onChange={setName}
						disabled={minting}
						placeholder="work laptop"
						hint="Something you will recognize in this list later."
						error={mintError}
					/>
					<SubmitButton
						loading={minting}
						loadingLabel="Minting..."
						disabled={!name.trim()}
					>
						Mint token
					</SubmitButton>
				</form>
			</Panel>

			<div style={{ marginTop: "1.5rem" }}>
				{loadError ? (
					<EmptyState
						title="Could not load your machines"
						action={{ label: "Retry", onClick: () => void load() }}
					>
						{loadError}
					</EmptyState>
				) : machines === null ? (
					<p style={{ color: PALETTE.muted }}>Loading machines...</p>
				) : machines.length === 0 ? (
					<EmptyState title="No machines yet">
						Mint a token above, then paste it into a plugin&apos;s config to
						start syncing. If you lose a token, revoke its machine here and mint
						another — an existing one cannot be shown again.
					</EmptyState>
				) : (
					<Panel title="Your machines">
						<table style={{ width: "100%", borderCollapse: "collapse" }}>
							<thead>
								<tr>
									<th scope="col" style={cell}>
										Name
									</th>
									<th scope="col" style={cell}>
										Created
									</th>
									<th scope="col" style={cell}>
										Last used
									</th>
									<th scope="col" style={cell}>
										<span
											style={{
												position: "absolute",
												width: 1,
												height: 1,
												overflow: "hidden",
												clip: "rect(0 0 0 0)",
											}}
										>
											Actions
										</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{machines.map((machine) => (
									<tr key={machine.id}>
										<th scope="row" style={cell}>
											<span style={{ marginRight: "0.5rem" }}>
												{machine.name}
											</span>
											{machine.revoked_at ? <Chip>Revoked</Chip> : null}
										</th>
										<td style={cell}>
											<When iso={machine.created_at} />
										</td>
										<td style={cell}>
											{machine.last_used_at ? (
												<When iso={machine.last_used_at} />
											) : (
												// Not a dash. Minting a token and never pointing
												// a plugin at it is the likeliest first-run
												// failure in the product, and a blank cell does
												// not say that - it reads as missing data.
												<Chip>Never used</Chip>
											)}
										</td>
										<td style={cell}>{action(machine)}</td>
									</tr>
								))}
							</tbody>
						</table>

						{revokeError ? (
							<p role="alert" style={{ color: PALETTE.danger }}>
								{revokeError}
							</p>
						) : null}
					</Panel>
				)}
			</div>
		</>
	);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/machines-page.test.tsx`
Expected: PASS, all ten cases.

- [ ] **Step 5: Run the whole web suite and the typechecker**

Run: `pnpm --filter @onlooker/web exec vitest run`
Run: `pnpm --filter @onlooker/web exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

Route through `/commit`. Stage exactly:

```bash
git add apps/web/src/pages/MachinesPage.tsx apps/web/src/__tests__/machines-page.test.tsx
```

---

## Task 7: Route to it

`AppShell` shipped in PR 3 and nothing routes through it yet, so this is the first page to mount it. Its nav links to `/lessons`, which does not exist until the next PR and will render the app's 404 — accepted, and recorded in the spec's amendment. `DashboardPage`'s ad-hoc nav links only to Profile and Settings, so without a temporary link here the page is reachable only by typing the URL.

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/pages/DashboardPage.tsx:29-33`
- Test: `apps/web/src/__tests__/machines-route.test.tsx` (create). Not `spa-routing.test.ts` — that file reads `wrangler.toml` and asserts `not_found_handling`, which is about the server handing unmatched paths to the SPA and says nothing about the route table.

**Interfaces:**
- Consumes: `MachinesPage` from Task 6, `AppShell` from `components/AppShell.tsx`, `auth.RequireAuth` from `../auth`.
- Produces: nothing later tasks depend on. This is the last task.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/machines-route.test.tsx`. This is the one test that renders the real `App`, so it is what proves the route, the auth guard and the shell are wired to each other rather than each working alone:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// auth and machinesApi are both stubbed; everything between them - App's route
// table, RequireAuth, AppShell - stays real. machines-page.test.tsx covers what
// the page does, so the only assertions here are about reaching it at all.
vi.mock("../auth", () => ({
	auth: {
		RequireAuth: ({ children }: { children: unknown }) => children,
		useAuth: () => ({
			user: { id: "u1", email: "someone@example.com" },
			logout: vi.fn(),
			refresh: vi.fn(),
			sessionExpiresAt: null,
			sessionExpiringSoon: false,
		}),
	},
}));

vi.mock("../api/machinesApi", () => ({
	MACHINE_ENDPOINTS: { machines: "/api/machines" },
	listMachines: vi.fn().mockResolvedValue({ machines: [] }),
	createMachine: vi.fn(),
	revokeMachine: vi.fn(),
}));

const { default: App } = await import("../App");

describe("/machines", () => {
	it("renders the machines page inside the app shell", async () => {
		render(
			<MemoryRouter initialEntries={["/machines"]}>
				<App />
			</MemoryRouter>,
		);

		expect(await screen.findByLabelText(/machine name/i)).toBeDefined();
		// The shell, not just the page: /machines is the first route to mount
		// AppShell, so this is where a missing wrapper would show up.
		expect(screen.getByRole("navigation", { name: /sections/i })).toBeDefined();
		await waitFor(() =>
			expect(
				screen
					.getByRole("link", { name: /machines/i })
					.getAttribute("aria-current"),
			).toBe("page"),
		);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/machines-route.test.tsx`
Expected: FAIL — `/machines` falls to the `path="*"` catch-all and renders `404 Not Found`, so `findByLabelText` times out.

- [ ] **Step 3: Add the route**

In `apps/web/src/App.tsx`, import both and add the route beside the other authenticated ones:

```tsx
import AppShell from "./components/AppShell";
import MachinesPage from "./pages/MachinesPage";
```

```tsx
				{/*
				  The first route to mount AppShell. The shell's Lessons link
				  goes nowhere until the next PR lands /lessons; that is the
				  accepted cost of shipping machines first, since nothing can
				  reach the pool until somebody can mint a credential.
				*/}
				<Route
					path="/machines"
					element={
						<auth.RequireAuth>
							<AppShell>
								<MachinesPage />
							</AppShell>
						</auth.RequireAuth>
					}
				/>
```

- [ ] **Step 4: Add the temporary link into the dashboard nav**

In `apps/web/src/pages/DashboardPage.tsx`, in the existing `<nav>`:

```tsx
			<nav style={{ display: "flex", gap: "1rem", margin: "1rem 0" }}>
				<Link to="/profile">Profile</Link>
				<Link to="/settings">Settings</Link>
				{/*
				  Temporary. RequireAuth still lands here, and AppShell's nav
				  is only reachable from a page that mounts it - so without
				  this, minting a token requires knowing the URL. Deleted with
				  this whole page when /lessons becomes the landing route.
				*/}
				<Link to="/machines">Machines</Link>
				<a href="#recent-activity">Activity log</a>
			</nav>
```

- [ ] **Step 5: Run everything**

Run: `pnpm --filter @onlooker/web exec vitest run`
Run: `pnpm --filter @onlooker/web exec tsc --noEmit`
Run: `pnpm --filter @onlooker/api exec vitest run`
Expected: PASS across all three.

- [ ] **Step 6: Verify it works in a browser, not only in jsdom**

Run: `pnpm --filter @onlooker/web dev`

With the mock API on (the default when `VITE_API_BASE_URL` is unset), sign in, reach `/machines` from the dashboard nav, and check by hand:
- minting shows the token, and Escape and a backdrop click both leave it up
- Copy reports success or failure honestly
- a second machine shows "Never used"
- Revoke asks inline, Cancel backs out, confirming marks the row revoked
- reloading the tab with the reveal open prompts first

This step exists because Task 2 built the mock specifically so it could be done. jsdom cannot tell you whether the modal actually covers the nav.

- [ ] **Step 7: Commit**

Route through `/commit`. Stage exactly:

```bash
git add apps/web/src/App.tsx apps/web/src/pages/DashboardPage.tsx apps/web/src/__tests__/machines-route.test.tsx
```

- [ ] **Step 8: Close the bead and open the PR**

```bash
bd close onlooker-k7w --reason="Machines page, one-time reveal, and the /api/ move shipped" --suggest-next
```

Then open the PR through the `/pr` skill. The description should lead with what the PR unblocks — the sync protocol becomes usable by a person for the first time — and name the `/api/machines` move explicitly, since it is an API path change reviewers will want to see justified.

---

## Self-Review

**Spec coverage.** Section 2's four requirements each map to a task: the reveal panel with copy and a plain statement (Task 5, Step 3); dismissal only by explicit acknowledgement (Task 5, tests 2–4); recovery stated in the empty state (Task 6, test 1); `name` / `created_at` / `last_used_at` with "never used" as its own state (Task 6, test 3); inline revoke confirmation (Task 6, tests 6–7). The Amendments' `/api/` move is Task 1 and its gate is Task 3; the modal-instead-of-`useBlocker` decision is Task 5; the reachability consequence of the PR swap is Task 7.

**Deliberately not covered.** `onlooker-mkp` (heartbeat coverage of the new read) and `onlooker-4bw` (stack filtering) stay filed rather than absorbed, as the spec says. The `last_used_at` value itself is written by `verifyMachineToken` on the ingest path, which this PR does not touch.

**Type consistency.** `Machine` and `MintedMachine` are defined in Task 4 and used under those names in Tasks 5 and 6. `MockMachine` (Task 2) is the mock's private mirror and is intentionally not shared — it lives in a different package and exporting it would let the mock's shape define the client's. Field names are snake_case (`created_at`, `last_used_at`, `revoked_at`) everywhere, matching `MachineTokenSummary`; the only camelCase in the client is the function names.

**Checked while reviewing, not left to the implementer.** Task 7 originally deferred to `spa-routing.test.ts`. That file reads `wrangler.toml` and asserts `not_found_handling = "single-page-application"` — it is about the server handing deep links to the SPA at all, and has no route list. Task 7 now creates `machines-route.test.tsx` instead, which is also the only place in this plan that renders the real `App`.
