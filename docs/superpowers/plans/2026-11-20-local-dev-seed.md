# Local dev seed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm dev` then `pnpm seed:dev` gives a local login where every signed-in view of the web app has data, in every state it has to handle.

**Architecture:** A TypeScript seed in `apps/api/scripts/seed-dev/`. Pure fixtures and SQL builders feed `runSeed`, which takes two injected functions: one runs SQL statements, one sends a request to the API. The Node runner wires those to `wrangler d1 execute --local` and `fetch("http://localhost:8787")`. The test wires them to the Workers test pool's migrated D1 and the worker itself, so the whole seed runs through real ingest in CI.

**Tech Stack:** TypeScript, `@cloudflare/vitest-pool-workers` (vitest 4), D1/SQLite, `bcryptjs`, `@onlooker-community/lesson-contract` (zod 4), `tsx` (root devDependency), wrangler 4.

**Spec:** `docs/superpowers/specs/2026-11-20-local-dev-seed-design.md`. Linear: ONL-300.

## Global Constraints

- Work in the worktree `/Users/meaganwaller/src/github.com/onlooker-community/onlooker-onl-300`, branch `meagan/onl-300-local-dev-seed`.
- Edit tracked files with the Edit/Write tools, never `sed -i`, heredocs or scripts. Never run a formatter that writes (`biome check --write`, `pnpm lint:fix`); check with `pnpm --filter @onlooker/api lint` and fix by hand. Tabs for indentation.
- One API test file: `pnpm --filter @onlooker/api test <name>` — the name straight after `test`, with **no `--`**.
- Tests under `apps/api/scripts/` run in the Workers pool (no `node:*` modules). Only `main.ts` may import `node:*`, and no test imports `main.ts`.
- Seed accounts use the `@onlooker.test` domain and nothing else does. Seed ids start with `seed-`. The reset deletes exactly `users WHERE email LIKE '%@onlooker.test'` and `orgs WHERE id LIKE 'seed-%'`.
- The seed only ever targets database `onlooker-db-local` with `--local --env development`, and the API at `http://localhost:8787`. No flag or environment variable changes either.
- Machine tokens are `onlk_` + 64 lowercase hex: `onlk_` + SHA-256 hex of `seed-token-<machine id>`. Stored `token_hash` is the SHA-256 hex of the whole token.
- Invite tokens are 64 lowercase hex: SHA-256 hex of the invite's `tokenSeed`. Stored `token_hash` is the SHA-256 hex of that token.
- Passwords: one `SEED_PASSWORD = "onlooker-dev-seed"` for all seed accounts, bcrypt cost 10.
- Lessons are immutable once pushed: always pushed `status: "active"`, `superseded_by: null`; status changes go through `POST /lessons/:id/status`. A public lesson needs `consensus.agreed === consensus.judges`.
- All timestamps are ISO strings with a trailing `Z` (`toISOString()`).
- Commits through `/git-workflow:commit`, or mirroring its contract: stage files by name, `<type>(<scope>): <subject> :emoji:` ≤72 chars, why-focused body wrapped at 80, American English, `Refs ONL-300`, never `--no-verify`.

## Files

- Modify `apps/api/tsconfig.json` (`include` adds `"scripts"`), `apps/api/package.json` (`lint` checks `scripts`).
- Create in `apps/api/scripts/seed-dev/`: `local.ts`, `fixtures.ts`, `sql.ts`, `seed.ts`, `main.ts`.
- Tests in the same directory: `local.test.ts`, `fixtures.test.ts`, `sql.test.ts`, `seed.test.ts`.
- Modify root `package.json` (`seed:dev`), `docs/development.md`, `.github/workflows/deploy.yml`.
- Delete `scripts/seed-dev-projects.sh`, `scripts/seed-dev-projects.test.sh`.

---

### Task 1: The local target, typechecked and linted

**Files:**
- Modify: `apps/api/tsconfig.json`, `apps/api/package.json`
- Create: `apps/api/scripts/seed-dev/local.ts`
- Test: `apps/api/scripts/seed-dev/local.test.ts`

**Interfaces:**
- Produces: `LOCAL_DATABASE = "onlooker-db-local"`, `LOCAL_API = "http://localhost:8787"`, `wranglerArgs(sqlFile: string): string[]` (arguments for `pnpm`).

- [ ] **Step 1: Write the failing test** `apps/api/scripts/seed-dev/local.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LOCAL_API, LOCAL_DATABASE, wranglerArgs } from "./local";

// Replaces the CI step that ran scripts/seed-dev-projects.test.sh: the seed
// must never be able to reach a database or API other than the local ones.
describe("the seed's target", () => {
	it("only ever runs wrangler against the local development database", () => {
		const args = wranglerArgs("/tmp/seed.sql");

		expect(args).toEqual([
			"--filter",
			"@onlooker/api",
			"exec",
			"wrangler",
			"d1",
			"execute",
			"onlooker-db-local",
			"--local",
			"--env",
			"development",
			"--file",
			"/tmp/seed.sql",
		]);
		expect(args).not.toContain("--remote");
		expect(LOCAL_DATABASE).toBe("onlooker-db-local");
	});

	it("only ever talks to the API on localhost", () => {
		expect(new URL(LOCAL_API).hostname).toBe("localhost");
		expect(LOCAL_API).toBe("http://localhost:8787");
	});
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @onlooker/api test local.test`
Expected: FAIL — cannot find module `./local`.

- [ ] **Step 3: Implement** `apps/api/scripts/seed-dev/local.ts`:

```ts
/**
 * Where the local dev seed writes (ONL-300), and nowhere else.
 *
 * Constants rather than options on purpose: there is no flag or environment
 * variable that points the seed at another database or API, so it cannot be
 * aimed at staging or production by a mistyped command. local.test.ts pins
 * it, in place of the CI step the old bash seed had.
 */

/** The D1 database `wrangler dev --env development` uses. */
export const LOCAL_DATABASE = "onlooker-db-local";

/** Where `pnpm dev` serves the API. */
export const LOCAL_API = "http://localhost:8787";

/** Arguments for `pnpm` that run one SQL file against the local database. */
export function wranglerArgs(sqlFile: string): string[] {
	return [
		"--filter",
		"@onlooker/api",
		"exec",
		"wrangler",
		"d1",
		"execute",
		LOCAL_DATABASE,
		"--local",
		"--env",
		"development",
		"--file",
		sqlFile,
	];
}
```

- [ ] **Step 4: Bring `scripts` under typecheck and lint.** In `apps/api/tsconfig.json`, change `"include": ["src", "test"]` to `"include": ["src", "test", "scripts"]`. In `apps/api/package.json`, change the `lint` script from `biome check src test` to `biome check src test scripts`.

- [ ] **Step 5: Run it to see it pass**

Run: `pnpm --filter @onlooker/api test local.test` — PASS, 2 tests.
Run: `pnpm --filter @onlooker/api typecheck` — exit 0.
Run: `pnpm --filter @onlooker/api lint` — no errors.

- [ ] **Step 6: Commit** the four files: `chore(api): pin the dev seed's target to the local stack`.

---

### Task 2: Fixtures — accounts, org, invites, machines, inventories, labels

**Files:**
- Create: `apps/api/scripts/seed-dev/fixtures.ts`
- Test: `apps/api/scripts/seed-dev/fixtures.test.ts`

**Interfaces:**
- Produces, from `./fixtures`:
  - `SEED_PASSWORD: string`, `SEED_DOMAIN = "onlooker.test"`, `ORG: { id: "seed-org"; name: "Onlooker Dev" }`
  - `type UserKey = "dev" | "ada" | "sam"`; `USERS: Record<UserKey, { id: string; email: string; name: string }>`
  - `MEMBERSHIPS: { id: string; user: UserKey; role: "owner" | "member" }[]`
  - `interface SeedInvite { id: string; email: string; tokenSeed: string; expiresAt: string }`; `invites(now: Date): SeedInvite[]`
  - `interface InventoryScope`, `interface Inventory` (the CLI's shape)
  - `type MachineState = "live" | "never-used" | "revoked" | "removed"`
  - `interface SeedMachine { id: string; owner: UserKey; name: string; orgId: string | null; state: MachineState; createdDaysAgo: number; lastUsedHoursAgo: number | null; retiredDaysAgo: number | null; inventory: Inventory | null }`; `machines(now: Date): SeedMachine[]`
  - `PROJECTS` (the 12-hex keys) and `interface SeedLabel { projectKey: string; machineId: string; label: string }`; `LABELS: SeedLabel[]`
  - `daysAgo(now: Date, days: number, hours?: number): string`

- [ ] **Step 1: Write the failing test** `apps/api/scripts/seed-dev/fixtures.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	invites,
	LABELS,
	machines,
	MEMBERSHIPS,
	ORG,
	SEED_DOMAIN,
	USERS,
} from "./fixtures";

const NOW = new Date("2026-11-20T15:00:00.000Z");

describe("seed accounts", () => {
	it("keeps every account on the seed domain, lowercased", () => {
		for (const user of Object.values(USERS)) {
			expect(user.email.endsWith(`@${SEED_DOMAIN}`)).toBe(true);
			expect(user.email).toBe(user.email.toLowerCase());
			expect(user.id.startsWith("seed-")).toBe(true);
		}
	});

	it("gives the org an owner and one member, and leaves sam out", () => {
		expect(ORG.id.startsWith("seed-")).toBe(true);
		expect(MEMBERSHIPS.map((m) => [m.user, m.role])).toEqual([
			["dev", "owner"],
			["ada", "member"],
		]);
	});

	it("has one pending invite, to sam, and one expired invite", () => {
		const [pending, expired] = invites(NOW);
		expect(pending.email).toBe(USERS.sam.email);
		expect(new Date(pending.expiresAt) > NOW).toBe(true);
		expect(new Date(expired.expiresAt) < NOW).toBe(true);
	});
});

describe("seed machines", () => {
	const all = machines(NOW);
	const byId = new Map(all.map((m) => [m.id, m]));

	it("covers every machine state dev's Machines page shows", () => {
		const devStates = all.filter((m) => m.owner === "dev").map((m) => m.state);
		expect(new Set(devStates)).toEqual(
			new Set(["live", "never-used", "revoked", "removed"]),
		);
	});

	it("binds dev's laptop and ada's machine to the org, and nothing else", () => {
		expect(all.filter((m) => m.orgId === ORG.id).map((m) => m.id)).toEqual([
			"seed-laptop",
			"seed-ada-machine",
		]);
	});

	it("gives the never-used machine no inventory and no use", () => {
		const spare = byId.get("seed-spare");
		expect(spare?.inventory).toBeNull();
		expect(spare?.lastUsedHoursAgo).toBeNull();
	});

	// Every branch of Home's silent line: heard, silent, never-listed
	// ecosystem, disabled everywhere, enabled-unknowable, another marketplace.
	it("reports inventories that reach every branch of the silent line", () => {
		const ids = byId
			.get("seed-desktop")
			?.inventory?.plugins.map((p) => ({ id: p.id, enabled: p.scopes.map((s) => s.enabled) }));
		expect(ids).toEqual(
			expect.arrayContaining([
				{ id: "counsel@onlooker-community", enabled: [true] },
				{ id: "customs@onlooker-community", enabled: [null] },
				{ id: "warden@onlooker-community", enabled: [false, false] },
				{ id: "ecosystem@onlooker-community", enabled: [true] },
				{ id: "superpowers@superpowers-dev", enabled: [true] },
			]),
		);
	});

	it("dates everything from now", () => {
		const later = new Date("2026-12-01T15:00:00.000Z");
		expect(invites(later)[0].expiresAt).not.toBe(invites(NOW)[0].expiresAt);
		expect(machines(later)[0].inventory?.collected_at).not.toBe(
			machines(NOW)[0].inventory?.collected_at,
		);
	});
});

describe("seed labels", () => {
	it("names one root key differently on each of two machines", () => {
		const scratch = LABELS.filter((l) => l.label.startsWith("scratch on"));
		expect(scratch.map((l) => l.machineId)).toEqual(["seed-desktop", "seed-laptop"]);
	});

	it("leaves remote keys unscoped", () => {
		const onlooker = LABELS.filter((l) => l.label === "onlooker");
		expect(onlooker.map((l) => l.machineId)).toEqual(["", ""]);
	});
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @onlooker/api test fixtures.test`
Expected: FAIL — cannot find module `./fixtures`.

- [ ] **Step 3: Implement** `apps/api/scripts/seed-dev/fixtures.ts`:

```ts
/**
 * What the local dev seed creates (ONL-300), as plain data.
 *
 * Everything dated is built from `now`, so a seed run today and one next week
 * both show "the last 7 days". Nothing here touches a database or the network;
 * sql.ts and seed.ts turn it into rows and requests.
 *
 * The cases are chosen for the states the web app has to render, not to look
 * like a real account: each one is here because some view has a branch for it.
 */

/** One password for every seed account. Local only; printed by the runner. */
export const SEED_PASSWORD = "onlooker-dev-seed";

/** The reset deletes every account on this domain, so nothing else may use it. */
export const SEED_DOMAIN = "onlooker.test";

export const ORG = { id: "seed-org", name: "Onlooker Dev" } as const;

export type UserKey = "dev" | "ada" | "sam";

export const USERS: Record<UserKey, { id: string; email: string; name: string }> = {
	// The account you log in as.
	dev: { id: "seed-user-dev", email: `dev@${SEED_DOMAIN}`, name: "Dev" },
	// In the org: the author of org lessons other than yours.
	ada: { id: "seed-user-ada", email: `ada@${SEED_DOMAIN}`, name: "Ada" },
	// Not in the org: the author of public lessons from outside it, and the
	// recipient of the pending invite.
	sam: { id: "seed-user-sam", email: `sam@${SEED_DOMAIN}`, name: "Sam" },
};

export const MEMBERSHIPS: { id: string; user: UserKey; role: "owner" | "member" }[] = [
	{ id: "seed-membership-dev", user: "dev", role: "owner" },
	{ id: "seed-membership-ada", user: "ada", role: "member" },
];

/** An ISO time `days` (and `hours`) before `now`. Negative days are ahead. */
export function daysAgo(now: Date, days: number, hours = 0): string {
	return new Date(now.getTime() - (days * 24 + hours) * 3_600_000).toISOString();
}

export interface SeedInvite {
	id: string;
	email: string;
	/** Hashed into the invite's token by seed.ts, so the link is the same every run. */
	tokenSeed: string;
	expiresAt: string;
}

export function invites(now: Date): SeedInvite[] {
	return [
		// Log in as sam and open the printed link to accept it.
		{
			id: "seed-invite-pending",
			email: USERS.sam.email,
			tokenSeed: "seed-invite-pending",
			expiresAt: daysAgo(now, -1),
		},
		{
			id: "seed-invite-expired",
			email: `former@${SEED_DOMAIN}`,
			tokenSeed: "seed-invite-expired",
			expiresAt: daysAgo(now, 2),
		},
	];
}

/** The CLI's inventory document, as PUT /machine/inventory stores it. */
export interface InventoryScope {
	scope: string;
	version: string;
	git_commit_sha: string | null;
	installed_at: string | null;
	last_updated: string | null;
	/** null: the CLI could not tell. */
	enabled: boolean | null;
}

export interface Inventory {
	schema_version: 1;
	collected_at: string;
	project: string | null;
	plugins: { id: string; scopes: InventoryScope[] }[];
}

function plugin(
	id: string,
	enabled: (boolean | null)[] = [true],
): Inventory["plugins"][number] {
	return {
		id,
		scopes: enabled.map((on, index) => ({
			scope: index === 0 ? "user" : "~/src/onlooker",
			version: "1.0.0",
			git_commit_sha: null,
			installed_at: null,
			last_updated: null,
			enabled: on,
		})),
	};
}

function inventory(now: Date, plugins: Inventory["plugins"]): Inventory {
	return {
		schema_version: 1,
		collected_at: daysAgo(now, 0, 2),
		project: null,
		plugins,
	};
}

export type MachineState = "live" | "never-used" | "revoked" | "removed";

export interface SeedMachine {
	id: string;
	owner: UserKey;
	name: string;
	/** Set for a token that pushes to the org: org lessons need one. */
	orgId: string | null;
	state: MachineState;
	createdDaysAgo: number;
	/** null for a machine that never pushed anything. */
	lastUsedHoursAgo: number | null;
	/** When a revoked or removed machine was retired. */
	retiredDaysAgo: number | null;
	inventory: Inventory | null;
}

export function machines(now: Date): SeedMachine[] {
	return [
		{
			id: "seed-desktop",
			owner: "dev",
			name: "seed desktop",
			orgId: null,
			state: "live",
			createdDaysAgo: 60,
			lastUsedHoursAgo: 1,
			retiredDaysAgo: null,
			inventory: inventory(now, [
				// Heard this week.
				plugin("historian@onlooker-community"),
				plugin("lineage@onlooker-community"),
				plugin("bursar@onlooker-community"),
				plugin("curator@onlooker-community"),
				plugin("tribunal@onlooker-community"),
				plugin("governor@onlooker-community"),
				plugin("inspector@onlooker-community"),
				plugin("librarian@onlooker-community"),
				plugin("archivist@onlooker-community"),
				// Installed, no events: listed as silent.
				plugin("counsel@onlooker-community"),
				// Enabled unknowably: still counts as installed, and silent.
				plugin("customs@onlooker-community", [null]),
				// Disabled in every scope: not installed.
				plugin("warden@onlooker-community", [false, false]),
				// Emits nothing under its own name: never listed.
				plugin("ecosystem@onlooker-community"),
				// Another marketplace: never an Onlooker plugin.
				plugin("superpowers@superpowers-dev"),
			]),
		},
		{
			id: "seed-laptop",
			owner: "dev",
			name: "seed laptop",
			orgId: ORG.id,
			state: "live",
			createdDaysAgo: 30,
			lastUsedHoursAgo: 3,
			retiredDaysAgo: null,
			inventory: inventory(now, [
				plugin("historian@onlooker-community"),
				plugin("lineage@onlooker-community"),
				plugin("counsel@onlooker-community"),
				plugin("ecosystem@onlooker-community"),
			]),
		},
		{
			id: "seed-spare",
			owner: "dev",
			name: "seed spare",
			orgId: null,
			state: "never-used",
			createdDaysAgo: 5,
			lastUsedHoursAgo: null,
			retiredDaysAgo: null,
			inventory: null,
		},
		{
			id: "seed-old-laptop",
			owner: "dev",
			name: "seed old laptop",
			orgId: null,
			state: "revoked",
			createdDaysAgo: 90,
			lastUsedHoursAgo: 20 * 24,
			retiredDaysAgo: 19,
			inventory: null,
		},
		{
			id: "seed-old-desktop",
			owner: "dev",
			name: "seed old desktop",
			orgId: null,
			state: "removed",
			createdDaysAgo: 120,
			lastUsedHoursAgo: 45 * 24,
			retiredDaysAgo: 40,
			inventory: null,
		},
		{
			id: "seed-ada-machine",
			owner: "ada",
			name: "ada's laptop",
			orgId: ORG.id,
			state: "live",
			createdDaysAgo: 30,
			lastUsedHoursAgo: 5,
			retiredDaysAgo: null,
			inventory: null,
		},
		{
			id: "seed-sam-machine",
			owner: "sam",
			name: "sam's desktop",
			orgId: null,
			state: "live",
			createdDaysAgo: 30,
			lastUsedHoursAgo: 8,
			retiredDaysAgo: null,
			inventory: null,
		},
	];
}

/** Project keys, 12 hex as the CLI derives them. Carried over from #254's seed. */
export const PROJECTS = {
	onlookerHttps: "a1b2c3d4e5f6",
	onlookerSsh: "b2c3d4e5f6a1",
	unnamed: "c3d4e5f6a1b2",
	scratch: "d4e5f6a1b2c3",
	retired: "e5f6a1b2c3d4",
	pastRetention: "f6a1b2c3d4e5",
} as const;

export interface SeedLabel {
	projectKey: string;
	/** "" for a remote key; the machine id for a root key. */
	machineId: string;
	label: string;
}

/** dev's own names for projects (`source = 'user'`). */
export const LABELS: SeedLabel[] = [
	// An https and an ssh clone of one repository: two keys, one name.
	{ projectKey: PROJECTS.onlookerHttps, machineId: "", label: "onlooker" },
	{ projectKey: PROJECTS.onlookerSsh, machineId: "", label: "onlooker" },
	// One root key on two machines: two projects, each with its own name.
	{ projectKey: PROJECTS.scratch, machineId: "seed-desktop", label: "scratch on the desktop" },
	{ projectKey: PROJECTS.scratch, machineId: "seed-laptop", label: "scratch on the laptop" },
	{ projectKey: PROJECTS.retired, machineId: "seed-old-desktop", label: "retired experiment" },
	// Named, with no sessions at all: listed with no activity.
	{ projectKey: PROJECTS.pastRetention, machineId: "", label: "archived project" },
];
```

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm --filter @onlooker/api test fixtures.test` — PASS, 9 tests. Then `pnpm --filter @onlooker/api typecheck` and `lint` — clean (wrap long lines by hand if Biome asks).

- [ ] **Step 5: Commit** both files: `feat(api): describe the dev seed's accounts and machines`.

---

### Task 3: Fixtures — a week of sessions

**Files:**
- Modify: `apps/api/scripts/seed-dev/fixtures.ts` (append)
- Test: `apps/api/scripts/seed-dev/fixtures.test.ts` (append)

**Interfaces:**
- Consumes: `daysAgo`, `PROJECTS` (Task 2).
- Produces: `interface SessionBody` (the `POST /machine/sessions` element) and `interface SeedSession { machine: string; body: SessionBody }`; `sessions(now: Date): SeedSession[]`.

- [ ] **Step 1: Write the failing test** — append to `fixtures.test.ts` (and add `sessions` to its import from `./fixtures`):

```ts
describe("seed sessions", () => {
	const all = sessions(NOW);
	const week = all.filter(
		(s) => new Date(s.body.started_at) > new Date(NOW.getTime() - 7 * 86_400_000),
	);

	it("puts about 20 sessions in the last 7 days, with one quiet day", () => {
		expect(week.length).toBeGreaterThanOrEqual(18);
		const days = new Set(week.map((s) => s.body.started_at.slice(0, 10)));
		expect(days.has("2026-11-17")).toBe(false);
	});

	it("reaches back past the week, to the removed machine's last session", () => {
		const oldest = all.map((s) => s.body.started_at).sort()[0];
		expect(oldest.slice(0, 10)).toBe("2026-10-06");
	});

	it("leaves exactly one session running", () => {
		expect(all.filter((s) => s.body.ended_at === null)).toHaveLength(1);
	});

	// Each kind of row Home's Plugins panel and the Sessions rows draw.
	it("covers every kind of plugin activity", () => {
		const types = week.flatMap((s) => Object.keys(s.body.counts_by_type ?? {}));
		expect(types).toEqual(
			expect.arrayContaining([
				"historian.retrieval.surfaced", // produced
				"historian.embedder.failed", // failed beside output
				"governor.ledger.write_failed", // failed only
				"curator.scan.complete", // found nothing
				"tribunal.gate.skipped", // skipped
				"futureplugin.signal.raised", // unclassified
				"onlooker.artifact.ready", // archivist, heard only through plugins
			]),
		);
		expect(week.some((s) => s.body.counts_by_type === undefined)).toBe(true);
		expect(week.some((s) => s.body.plugins.includes("archivist"))).toBe(true);
	});

	it("derives each session's prefixes and event count from its types", () => {
		for (const { body } of all) {
			if (!body.counts_by_type) continue;
			const sum = Object.values(body.counts_by_type).reduce((a, b) => a + b, 0);
			expect(body.event_count).toBe(sum);
			expect(Object.values(body.counts_by_prefix).reduce((a, b) => a + b, 0)).toBe(sum);
		}
	});

	it("keeps every event type in the shape ingest accepts", () => {
		const shape = /^(?=.{1,64}$)[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$/;
		for (const { body } of all)
			for (const type of Object.keys(body.counts_by_type ?? {}))
				expect(type).toMatch(shape);
	});

	it("spans two repositories in one session", () => {
		expect(all.some((s) => Object.keys(s.body.counts_by_project).length === 2)).toBe(true);
	});

	it("gives every session a unique id", () => {
		const ids = all.map((s) => s.body.session_id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @onlooker/api test fixtures.test`
Expected: FAIL — `sessions` is not exported.

- [ ] **Step 3: Implement** — append to `fixtures.ts`:

```ts
/** One element of POST /machine/sessions' `sessions` array. */
export interface SessionBody {
	session_id: string;
	started_at: string;
	ended_at: string | null;
	event_count: number;
	counts_by_prefix: Record<string, number>;
	/** Absent for a CLI older than 2.12.0. */
	counts_by_type?: Record<string, number>;
	counts_by_project: Record<string, { basis: "remote" | "root"; event_count: number }>;
	plugins: string[];
	prompts: number;
	compactions: number;
}

export interface SeedSession {
	machine: string;
	body: SessionBody;
}

/**
 * Plugin mixes, one per kind of row the web draws. `tool.*` and `session.*`
 * are the harness (observed), so they count toward a session's events and
 * never toward a plugin.
 */
const PROFILES: Record<
	string,
	{ types?: Record<string, number>; prefixes?: Record<string, number>; plugins: string[] }
> = {
	produced: {
		types: {
			"historian.retrieval.started": 3,
			"historian.retrieval.complete": 3,
			"historian.retrieval.surfaced": 2,
			"lineage.change.recorded": 14,
			"bursar.session.recorded": 1,
			"tool.file.read": 30,
			"session.start": 1,
		},
		plugins: ["historian", "lineage", "bursar"],
	},
	failedBesideOutput: {
		types: {
			"historian.retrieval.surfaced": 1,
			"historian.embedder.failed": 2,
			"lineage.change.recorded": 6,
			"tool.file.read": 18,
		},
		plugins: ["historian", "lineage"],
	},
	failedOnly: {
		types: { "governor.ledger.write_failed": 1, "tool.file.read": 9 },
		plugins: ["governor"],
	},
	foundNothing: {
		types: { "curator.scan.started": 1, "curator.scan.complete": 1, "tool.file.read": 12 },
		plugins: ["curator"],
	},
	skipped: {
		types: { "tribunal.gate.skipped": 3, "tool.file.read": 7 },
		plugins: ["tribunal"],
	},
	unclassified: {
		types: { "futureplugin.signal.raised": 2, "tool.file.read": 5 },
		plugins: ["futureplugin"],
	},
	// archivist's output goes out under another plugin's prefix, so the
	// envelope's `plugins` is the only place it is heard.
	archivist: {
		types: { "onlooker.artifact.ready": 2, "tool.file.read": 11 },
		plugins: ["archivist"],
	},
	librarian: {
		types: {
			"librarian.candidate.proposed": 2,
			"librarian.lesson.promoted": 1,
			"tool.file.read": 20,
		},
		plugins: ["librarian"],
	},
	// A CLI older than 2.12.0: prefixes only, no per-type counts.
	oldCli: {
		prefixes: { inspector: 4, tool: 16 },
		plugins: ["inspector"],
	},
};

/** [machine, days ago, hours back, minutes long (null: running), profile, projects] */
type SessionRow = [
	string,
	number,
	number,
	number | null,
	keyof typeof PROFILES,
	[string, "remote" | "root", number][],
];

const P = PROJECTS;
const SESSION_ROWS: SessionRow[] = [
	["seed-laptop", 0, 1, null, "failedBesideOutput", [[P.onlookerHttps, "remote", 318]]],
	["seed-desktop", 0, 4, 95, "produced", [[P.onlookerHttps, "remote", 1240]]],
	["seed-desktop", 0, 7, 40, "archivist", [[P.scratch, "root", 64]]],
	["seed-laptop", 1, 2, 120, "produced", [[P.onlookerSsh, "remote", 96], [P.unnamed, "remote", 41]]],
	["seed-desktop", 1, 5, 30, "foundNothing", [[P.onlookerHttps, "remote", 210]]],
	["seed-desktop", 1, 9, 15, "skipped", [[P.unnamed, "remote", 27]]],
	["seed-desktop", 2, 1, 10, "produced", [[P.onlookerHttps, "remote", 60]]],
	["seed-desktop", 2, 3, 200, "produced", [[P.onlookerHttps, "remote", 800]]],
	["seed-laptop", 2, 6, 45, "failedOnly", [[P.scratch, "root", 12]]],
	["seed-laptop", 2, 9, 60, "librarian", [[P.onlookerSsh, "remote", 140]]],
	// Nothing 3 days ago: a quiet day draws an empty bar.
	["seed-desktop", 4, 2, 75, "produced", [[P.onlookerHttps, "remote", 400]]],
	["seed-desktop", 4, 5, 20, "unclassified", [[P.unnamed, "remote", 18]]],
	["seed-laptop", 4, 8, 90, "failedBesideOutput", [[P.onlookerHttps, "remote", 260]]],
	["seed-laptop", 5, 2, 110, "produced", [[P.onlookerSsh, "remote", 300]]],
	["seed-desktop", 5, 5, 35, "oldCli", [[P.scratch, "root", 30]]],
	["seed-desktop", 5, 9, 25, "foundNothing", [[P.onlookerHttps, "remote", 90]]],
	["seed-laptop", 6, 1, 30, "produced", [[P.onlookerSsh, "remote", 70]]],
	["seed-desktop", 6, 3, 150, "produced", [[P.onlookerHttps, "remote", 520]]],
	["seed-laptop", 6, 6, 50, "skipped", [[P.unnamed, "remote", 33]]],
	["seed-desktop", 6, 9, 65, "librarian", [[P.onlookerHttps, "remote", 150]]],
	// Older than the week.
	["seed-laptop", 9, 2, 80, "produced", [[P.scratch, "root", 12]]],
	["seed-old-laptop", 20, 3, 60, "produced", [[P.onlookerHttps, "remote", 200]]],
	["seed-old-desktop", 45, 5, 120, "produced", [[P.retired, "root", 503]]],
];

function prefixesOf(types: Record<string, number>): Record<string, number> {
	const prefixes: Record<string, number> = {};
	for (const [type, count] of Object.entries(types)) {
		const prefix = type.slice(0, type.indexOf("."));
		prefixes[prefix] = (prefixes[prefix] ?? 0) + count;
	}
	return prefixes;
}

export function sessions(now: Date): SeedSession[] {
	return SESSION_ROWS.map(([machine, days, hours, minutes, profileName, projects], index) => {
		const profile = PROFILES[profileName];
		const counts_by_prefix = profile.types ? prefixesOf(profile.types) : (profile.prefixes ?? {});
		const started = daysAgo(now, days, hours);
		const body: SessionBody = {
			session_id: `seed-session-${String(index + 1).padStart(2, "0")}`,
			started_at: started,
			ended_at:
				minutes === null
					? null
					: new Date(new Date(started).getTime() + minutes * 60_000).toISOString(),
			event_count: Object.values(counts_by_prefix).reduce((a, b) => a + b, 0),
			counts_by_prefix,
			counts_by_project: Object.fromEntries(
				projects.map(([key, basis, event_count]) => [key, { basis, event_count }]),
			),
			plugins: profile.plugins,
			prompts: 2 + (index % 5),
			compactions: index % 4 === 0 ? 1 : 0,
		};
		if (profile.types) body.counts_by_type = profile.types;
		return { machine, body };
	});
}
```

Note for the test's date checks: with `NOW = 2026-11-20T15:00Z`, the quiet day is 3 days back, `2026-11-17`, and the old desktop's session at 45 days + 5 h back starts `2026-10-06`. If a check fails on the date alone, recompute it from `daysAgo` before changing a row.

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm --filter @onlooker/api test fixtures.test` — PASS, 17 tests. Typecheck and lint clean.

- [ ] **Step 5: Commit**: `feat(api): give the dev seed a week of sessions`.

---

### Task 4: Fixtures — lessons and their timeline

**Files:**
- Modify: `apps/api/scripts/seed-dev/fixtures.ts` (append)
- Test: `apps/api/scripts/seed-dev/fixtures.test.ts` (append)

**Interfaces:**
- Consumes: `daysAgo`, `PROJECTS`, `UserKey` (Task 2).
- Produces:
  - `type SeedLessonBody = TLesson` from `@onlooker-community/lesson-contract` (check the package's exported type name for a lesson; if it is not `TLesson`, use `z.infer<typeof ZLesson>`).
  - `type LessonEvent = { at: string; kind: "push"; machine: string; lesson: SeedLessonBody } | { at: string; kind: "status"; machine: string; lessonId: string; status: "refuted" | "superseded" | "retracted"; supersededBy: string | null }`
  - `lessonTimeline(now: Date): LessonEvent[]`, sorted by `at` ascending.

- [ ] **Step 1: Write the failing test** — append to `fixtures.test.ts` (add `lessonTimeline` to the import, and `import { ZLesson } from "@onlooker-community/lesson-contract";`):

```ts
describe("seed lessons", () => {
	const timeline = lessonTimeline(NOW);
	const pushes = timeline.flatMap((e) => (e.kind === "push" ? [e] : []));
	const changes = timeline.flatMap((e) => (e.kind === "status" ? [e] : []));
	const machineOwner = new Map(machines(NOW).map((m) => [m.id, m.owner]));

	it("pushes only lessons the contract accepts", () => {
		for (const { lesson } of pushes) expect(ZLesson.safeParse(lesson).success).toBe(true);
	});

	it("pushes every lesson active, and changes status only through the route", () => {
		for (const { lesson } of pushes) {
			expect(lesson.status).toBe("active");
			expect(lesson.superseded_by).toBeNull();
		}
	});

	it("ends with dev's lessons in every status and every visibility", () => {
		const finalStatus = new Map(pushes.map((p) => [p.lesson.id, "active"]));
		for (const c of changes) finalStatus.set(c.lessonId, c.status);
		const devs = pushes.filter((p) => machineOwner.get(p.machine) === "dev");
		expect(new Set(devs.map((p) => finalStatus.get(p.lesson.id)))).toEqual(
			new Set(["active", "refuted", "superseded", "retracted"]),
		);
		expect(new Set(devs.map((p) => p.lesson.visibility))).toEqual(
			new Set(["private", "org", "public"]),
		);
	});

	it("supersedes a lesson with one already pushed", () => {
		const superseded = changes.find((c) => c.status === "superseded");
		const ids = pushes.map((p) => p.lesson.id);
		expect(superseded?.supersededBy).not.toBeNull();
		const replacementPushed = timeline.findIndex(
			(e) => e.kind === "push" && e.lesson.id === superseded?.supersededBy,
		);
		expect(replacementPushed).toBeGreaterThanOrEqual(0);
		expect(replacementPushed).toBeLessThan(timeline.indexOf(superseded as LessonEvent));
		expect(ids).toContain(superseded?.supersededBy);
	});

	it("pushes org lessons only from machines bound to the org", () => {
		const orgMachines = new Set(machines(NOW).filter((m) => m.orgId).map((m) => m.id));
		for (const p of pushes)
			if (p.lesson.visibility === "org") expect(orgMachines.has(p.machine)).toBe(true);
	});

	it("gives every public lesson a unanimous jury", () => {
		for (const { lesson } of pushes)
			if (lesson.visibility === "public")
				expect(lesson.consensus.agreed).toBe(lesson.consensus.judges);
	});

	it("has lessons from all three authors", () => {
		expect(new Set(pushes.map((p) => machineOwner.get(p.machine)))).toEqual(
			new Set(["dev", "ada", "sam"]),
		);
	});

	it("runs in time order, over two weeks, with one status change per lesson at most", () => {
		const times = timeline.map((e) => e.at);
		expect([...times].sort()).toEqual(times);
		expect(new Date(times[0]) < new Date(NOW.getTime() - 12 * 86_400_000)).toBe(true);
		const changed = changes.map((c) => c.lessonId);
		expect(new Set(changed).size).toBe(changed.length);
	});

	it("never changes a lesson before it is pushed", () => {
		for (const c of changes) {
			const pushedAt = pushes.find((p) => p.lesson.id === c.lessonId)?.at ?? "";
			expect(pushedAt < c.at).toBe(true);
		}
	});
});
```

Also add `type LessonEvent` to the import from `./fixtures`.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @onlooker/api test fixtures.test`
Expected: FAIL — `lessonTimeline` is not exported.

- [ ] **Step 3: Implement** — append to `fixtures.ts` (put the new import at the top of the file with the others):

```ts
import type { TLesson } from "@onlooker-community/lesson-contract";

export type SeedLessonBody = TLesson;

export type LessonEvent =
	| { at: string; kind: "push"; machine: string; lesson: SeedLessonBody }
	| {
			at: string;
			kind: "status";
			machine: string;
			lessonId: string;
			status: "refuted" | "superseded" | "retracted";
			supersededBy: string | null;
	  };

/** Fixed per author, 32 hex as the contract requires. */
const AUTHOR_KEYS: Record<UserKey, string> = {
	dev: "d".repeat(32),
	ada: "a".repeat(32),
	sam: "5".repeat(32),
};

/** A ULID-shaped id: "01JSEED", a digit per author, then a counter. */
function ulid(digit: number, n: number): string {
	return `01JSEED${digit}${String(n).padStart(18, "0")}`;
}

const AUTHOR_DIGIT: Record<UserKey, number> = { dev: 1, ada: 2, sam: 3 };

interface LessonSpec {
	author: UserKey;
	n: number;
	machine: string;
	claim: string;
	rationale: string;
	stack: string[];
	scope: TLesson["applies_to"]["scope"];
	visibility: TLesson["visibility"];
	projectKey: string;
	/** Days, then hours, before now. */
	promoted: [number, number];
	jury: [number, number];
}

function lessonFrom(now: Date, spec: LessonSpec): SeedLessonBody {
	const promotedAt = daysAgo(now, spec.promoted[0], spec.promoted[1]);
	return {
		id: ulid(AUTHOR_DIGIT[spec.author], spec.n),
		schema_version: 2,
		claim: spec.claim,
		rationale: spec.rationale,
		evidence: {
			artifact_ids: [ulid(9, AUTHOR_DIGIT[spec.author] * 100 + spec.n)],
			session_ids: [`seed-session-${String(spec.n).padStart(2, "0")}`],
			project_key: spec.projectKey,
			observed_at: daysAgo(now, spec.promoted[0], spec.promoted[1] + 2),
			resolution: "Confirmed on the next run.",
		},
		applies_to: {
			stack: spec.stack,
			scope: spec.scope,
			file_patterns: [],
			task_kinds: [],
		},
		visibility: spec.visibility,
		consensus: { judges: spec.jury[0], agreed: spec.jury[1], decided_at: promotedAt },
		status: "active",
		superseded_by: null,
		source: spec.visibility === "private" ? "local" : spec.visibility,
		author_key: AUTHOR_KEYS[spec.author],
		promoted_at: promotedAt,
	};
}

const anyVersion = (justification: string) =>
	({ kind: "version_independent", justification }) as const;

export function lessonTimeline(now: Date): LessonEvent[] {
	const spec = (s: LessonSpec) => lessonFrom(now, s);
	const lessons: { machine: string; lesson: SeedLessonBody }[] = [
		{ machine: "seed-desktop", lesson: spec({ author: "dev", n: 1, machine: "seed-desktop", claim: "Pin rollup when vite is below 6", rationale: "Vite 5 bundles a rollup range that drifts between installs.", stack: ["vite", "rollup"], scope: { kind: "versioned", versions: { vite: "<6" } }, visibility: "private", projectKey: PROJECTS.onlookerHttps, promoted: [13, 0], jury: [3, 2] }) },
		{ machine: "seed-desktop", lesson: spec({ author: "dev", n: 2, machine: "seed-desktop", claim: "Run migrations before the worker deploys", rationale: "A worker that reads a column before it exists fails every request.", stack: ["wrangler", "d1"], scope: anyVersion("Ordering holds for any wrangler version."), visibility: "private", projectKey: PROJECTS.onlookerHttps, promoted: [12, 0], jury: [3, 2] }) },
		{ machine: "seed-desktop", lesson: spec({ author: "dev", n: 3, machine: "seed-desktop", claim: "Seed local data with wrangler d1 execute", rationale: "Raw SQL is the fastest way to fill a local database.", stack: ["wrangler", "d1"], scope: anyVersion("Applies to any local D1."), visibility: "private", projectKey: PROJECTS.scratch, promoted: [11, 0], jury: [3, 3] }) },
		{ machine: "seed-desktop", lesson: spec({ author: "dev", n: 5, machine: "seed-desktop", claim: "Cache bcrypt hashes between test runs", rationale: "Hashing at cost 10 dominates the suite's setup time.", stack: ["bcryptjs"], scope: anyVersion("Any bcryptjs."), visibility: "private", projectKey: PROJECTS.onlookerHttps, promoted: [9, 0], jury: [3, 2] }) },
		{ machine: "seed-laptop", lesson: spec({ author: "dev", n: 6, machine: "seed-laptop", claim: "Bind a machine token to the org before pushing org lessons", rationale: "Ingest stamps org lessons with the token's org and nothing else.", stack: ["onlooker-cli"], scope: anyVersion("A rule of the API, not of a version."), visibility: "org", projectKey: PROJECTS.scratch, promoted: [8, 0], jury: [3, 3] }) },
		{ machine: "seed-desktop", lesson: spec({ author: "dev", n: 8, machine: "seed-desktop", claim: "Write timestamps as ISO strings with a trailing Z", rationale: "Lexical order then matches time order, which cursors rely on.", stack: ["typescript"], scope: anyVersion("Any runtime."), visibility: "public", projectKey: PROJECTS.unnamed, promoted: [6, 0], jury: [3, 3] }) },
		{ machine: "seed-laptop", lesson: spec({ author: "dev", n: 7, machine: "seed-laptop", claim: "Org lessons reach only members of the org", rationale: "The pool reads org lessons through the reader's memberships.", stack: ["drizzle-orm"], scope: { kind: "versioned", versions: { "drizzle-orm": "<1" } }, visibility: "org", projectKey: PROJECTS.onlookerSsh, promoted: [4, 0], jury: [2, 2] }) },
		{ machine: "seed-desktop", lesson: spec({ author: "dev", n: 4, machine: "seed-desktop", claim: "Push seed data through the API's ingest routes", rationale: "Ingest validates lessons and builds the derived tables; raw SQL skips both.", stack: ["wrangler", "d1"], scope: anyVersion("Applies to any local D1."), visibility: "private", projectKey: PROJECTS.scratch, promoted: [2, 3], jury: [3, 3] }) },
		{ machine: "seed-desktop", lesson: spec({ author: "dev", n: 9, machine: "seed-desktop", claim: "Pin workerd's compatibility date in tests", rationale: "Unpinned, the test runner asks for today's date and breaks at midnight.", stack: ["cloudflare-workers"], scope: anyVersion("Any workerd."), visibility: "public", projectKey: PROJECTS.onlookerHttps, promoted: [0, 3], jury: [2, 2] }) },
		{ machine: "seed-ada-machine", lesson: spec({ author: "ada", n: 1, machine: "seed-ada-machine", claim: "Name the org in every invite email", rationale: "An invite that only names a person reads as spam.", stack: ["email"], scope: anyVersion("Any mail provider."), visibility: "org", projectKey: PROJECTS.onlookerHttps, promoted: [10, 0], jury: [3, 3] }) },
		{ machine: "seed-ada-machine", lesson: spec({ author: "ada", n: 2, machine: "seed-ada-machine", claim: "Keep invite windows short in development", rationale: "A one-day window surfaces expiry handling in a single session.", stack: ["wrangler"], scope: anyVersion("A development setting."), visibility: "org", projectKey: PROJECTS.onlookerSsh, promoted: [3, 0], jury: [2, 2] }) },
		{ machine: "seed-sam-machine", lesson: spec({ author: "sam", n: 1, machine: "seed-sam-machine", claim: "Lowercase emails before comparing them", rationale: "Mixed-case signups otherwise fail invite matching.", stack: ["typescript"], scope: anyVersion("Any runtime."), visibility: "public", projectKey: PROJECTS.unnamed, promoted: [7, 0], jury: [3, 3] }) },
		{ machine: "seed-sam-machine", lesson: spec({ author: "sam", n: 2, machine: "seed-sam-machine", claim: "Cap request bodies by bytes, not array length", rationale: "A short array of huge items passes a length cap.", stack: ["cloudflare-workers"], scope: anyVersion("Any worker."), visibility: "public", projectKey: PROJECTS.onlookerHttps, promoted: [1, 0], jury: [3, 3] }) },
	];

	const pushes: LessonEvent[] = lessons.map(({ machine, lesson }) => ({
		at: lesson.promoted_at,
		kind: "push",
		machine,
		lesson,
	}));
	const changes: LessonEvent[] = [
		{ at: daysAgo(now, 5), kind: "status", machine: "seed-desktop", lessonId: ulid(1, 2), status: "refuted", supersededBy: null },
		{ at: daysAgo(now, 2), kind: "status", machine: "seed-desktop", lessonId: ulid(1, 3), status: "superseded", supersededBy: ulid(1, 4) },
		{ at: daysAgo(now, 1), kind: "status", machine: "seed-desktop", lessonId: ulid(1, 5), status: "retracted", supersededBy: null },
	];
	return [...pushes, ...changes].sort((a, b) => a.at.localeCompare(b.at));
}
```

The `spec({...})` calls are long single lines here for density; let Biome's lint tell you where it wants them wrapped and wrap by hand. Keep every value as written.

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm --filter @onlooker/api test fixtures.test` — PASS, 26 tests. Typecheck and lint clean.

If `ZLesson.safeParse` fails for a lesson, print `ZLesson.safeParse(lesson).error.issues` in a scratch run and fix the fixture value, never the test.

- [ ] **Step 5: Commit**: `feat(api): give the dev seed lessons in every state`.

---

### Task 5: The seed's SQL

**Files:**
- Create: `apps/api/scripts/seed-dev/sql.ts`
- Test: `apps/api/scripts/seed-dev/sql.test.ts`

**Interfaces:**
- Consumes: `USERS`, `ORG`, `MEMBERSHIPS`, `invites`, `machines`, `LABELS`, `daysAgo`, `LessonEvent`, `SEED_DOMAIN` (Tasks 2-4).
- Produces:
  - `resetSql(): string[]`
  - `interface BaseInput { now: Date; passwordHash: string; tokenHashes: Record<string, string>; inviteHashes: Record<string, string> }` (keyed by machine id and invite id)
  - `baseSql(input: BaseInput): string[]`
  - `afterSql(now: Date, timeline: LessonEvent[]): string[]`

- [ ] **Step 1: Write the failing test** `apps/api/scripts/seed-dev/sql.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { invites, lessonTimeline, machines } from "./fixtures";
import { afterSql, baseSql, resetSql } from "./sql";

const NOW = new Date("2026-11-20T15:00:00.000Z");

function input() {
	return {
		now: NOW,
		passwordHash: "$2a$10$notarealhashnotarealhashnotarealhashnotarealhashnot",
		tokenHashes: Object.fromEntries(machines(NOW).map((m) => [m.id, `hash-${m.id}`])),
		inviteHashes: Object.fromEntries(invites(NOW).map((i) => [i.id, `hash-${i.id}`])),
	};
}

async function run(statements: string[]) {
	await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
}

async function count(sql: string): Promise<number> {
	const row = await env.DB.prepare(sql).first<{ n: number }>();
	return row?.n ?? 0;
}

describe("the seed's SQL", () => {
	it("deletes only seed accounts and seed orgs", () => {
		expect(resetSql()).toEqual([
			"DELETE FROM users WHERE email LIKE '%@onlooker.test';",
			"DELETE FROM orgs WHERE id LIKE 'seed-%';",
		]);
	});

	it("writes the base rows into the real schema", async () => {
		await run(resetSql());
		await run(baseSql(input()));

		expect(await count("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@onlooker.test'")).toBe(3);
		expect(await count("SELECT COUNT(*) AS n FROM org_memberships WHERE org_id = 'seed-org'")).toBe(2);
		expect(await count("SELECT COUNT(*) AS n FROM org_invites WHERE org_id = 'seed-org'")).toBe(2);
		expect(await count("SELECT COUNT(*) AS n FROM machine_tokens WHERE id LIKE 'seed-%'")).toBe(7);
		expect(await count("SELECT COUNT(*) AS n FROM project_labels WHERE user_id = 'seed-user-dev'")).toBe(6);
		expect(
			await count("SELECT COUNT(*) AS n FROM machine_tokens WHERE org_id = 'seed-org'"),
		).toBe(2);
	});

	it("can run twice, replacing its own rows and leaving other accounts alone", async () => {
		await env.DB.prepare(
			"INSERT INTO users (id, email, password_hash) VALUES ('other-user', 'other@example.com', 'x')",
		).run();
		await run(resetSql());
		await run(baseSql(input()));
		await run(resetSql());
		await run(baseSql(input()));

		expect(await count("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@onlooker.test'")).toBe(3);
		expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = 'other-user'")).toBe(1);
	});

	it("escapes quotes in names", () => {
		expect(baseSql(input()).join("\n")).toContain("'ada''s laptop'");
	});

	it("retires machines and backdates the feed after the pushes", () => {
		const after = afterSql(NOW, lessonTimeline(NOW)).join("\n");
		expect(after).toContain("UPDATE machine_tokens SET revoked_at");
		expect(after).toContain("removed_at");
		expect(after).toContain("UPDATE lesson_feed SET at");
		// The never-used machine keeps last_used_at NULL.
		expect(after).not.toMatch(/last_used_at = '[^']+' WHERE id = 'seed-spare'/);
	});
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @onlooker/api test sql.test`
Expected: FAIL — cannot find module `./sql`.

- [ ] **Step 3: Implement** `apps/api/scripts/seed-dev/sql.ts`:

```ts
/**
 * The SQL half of the dev seed (ONL-300): the rows no ingest route can write
 * without mail or a login, and the touches that come after the pushes.
 *
 * Statements, one per string, so seed.ts can hand them to D1's batch in tests
 * and to a `wrangler d1 execute --file` in the runner. Every value comes from
 * fixtures.ts or from hashes seed.ts computed, never from input, but text still
 * goes through `q` because names carry apostrophes.
 */

import {
	daysAgo,
	invites,
	LABELS,
	type LessonEvent,
	MEMBERSHIPS,
	machines,
	ORG,
	SEED_DOMAIN,
	USERS,
} from "./fixtures";

/** A SQL string literal. */
function q(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

const nullable = (value: string | null) => (value === null ? "NULL" : q(value));

/**
 * Deleting the accounts cascades to their machines, sessions, lessons, feed,
 * labels and memberships. Orgs hang off no user, so they go by id.
 */
export function resetSql(): string[] {
	return [
		`DELETE FROM users WHERE email LIKE '%@${SEED_DOMAIN}';`,
		"DELETE FROM orgs WHERE id LIKE 'seed-%';",
	];
}

export interface BaseInput {
	now: Date;
	passwordHash: string;
	/** Machine id -> SHA-256 hex of its token. */
	tokenHashes: Record<string, string>;
	/** Invite id -> SHA-256 hex of its token. */
	inviteHashes: Record<string, string>;
}

export function baseSql({ now, passwordHash, tokenHashes, inviteHashes }: BaseInput): string[] {
	const created = daysAgo(now, 120);
	const statements: string[] = [];

	for (const user of Object.values(USERS))
		statements.push(
			`INSERT INTO users (id, email, password_hash, name, email_verified, created_at, updated_at) VALUES (${q(user.id)}, ${q(user.email)}, ${q(passwordHash)}, ${q(user.name)}, ${q(created)}, ${q(created)}, ${q(created)});`,
		);

	statements.push(
		`INSERT INTO orgs (id, name, created_at, updated_at) VALUES (${q(ORG.id)}, ${q(ORG.name)}, ${q(created)}, ${q(created)});`,
	);
	for (const membership of MEMBERSHIPS)
		statements.push(
			`INSERT INTO org_memberships (id, org_id, user_id, role, created_at) VALUES (${q(membership.id)}, ${q(ORG.id)}, ${q(USERS[membership.user].id)}, ${q(membership.role)}, ${q(created)});`,
		);
	for (const invite of invites(now))
		statements.push(
			`INSERT INTO org_invites (id, org_id, email, role, token_hash, expires_at, invited_by, created_at) VALUES (${q(invite.id)}, ${q(ORG.id)}, ${q(invite.email)}, 'member', ${q(inviteHashes[invite.id])}, ${q(invite.expiresAt)}, ${q(USERS.dev.id)}, ${q(daysAgo(now, 3))});`,
		);

	for (const machine of machines(now))
		statements.push(
			`INSERT INTO machine_tokens (id, user_id, name, token_hash, org_id, created_at) VALUES (${q(machine.id)}, ${q(USERS[machine.owner].id)}, ${q(machine.name)}, ${q(tokenHashes[machine.id])}, ${nullable(machine.orgId)}, ${q(daysAgo(now, machine.createdDaysAgo))});`,
		);

	for (const label of LABELS)
		statements.push(
			`INSERT INTO project_labels (user_id, project_key, machine_id, source, label) VALUES (${q(USERS.dev.id)}, ${q(label.projectKey)}, ${q(label.machineId)}, 'user', ${q(label.label)});`,
		);

	return statements;
}

/**
 * After every push. Retiring a machine has to wait, because a revoked token
 * can no longer push; a removed machine is revoked too, as the API's own
 * remove requires. Ingest stamps last_used_at and every feed row with the
 * moment of the push, so both are moved back to the fixture's times.
 */
export function afterSql(now: Date, timeline: LessonEvent[]): string[] {
	const statements: string[] = [];

	for (const machine of machines(now)) {
		statements.push(
			`UPDATE machine_tokens SET last_used_at = ${nullable(machine.lastUsedHoursAgo === null ? null : daysAgo(now, 0, machine.lastUsedHoursAgo))} WHERE id = ${q(machine.id)};`,
		);
		if (machine.retiredDaysAgo === null) continue;
		const retired = q(daysAgo(now, machine.retiredDaysAgo));
		statements.push(
			machine.state === "removed"
				? `UPDATE machine_tokens SET revoked_at = ${retired}, removed_at = ${retired} WHERE id = ${q(machine.id)};`
				: `UPDATE machine_tokens SET revoked_at = ${retired} WHERE id = ${q(machine.id)};`,
		);
	}

	for (const event of timeline)
		statements.push(
			event.kind === "push"
				? `UPDATE lesson_feed SET at = ${q(event.at)} WHERE lesson_id = ${q(event.lesson.id)} AND kind = 'create';`
				: `UPDATE lesson_feed SET at = ${q(event.at)} WHERE lesson_id = ${q(event.lessonId)} AND kind = 'status';`,
		);

	return statements;
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm --filter @onlooker/api test sql.test` — PASS, 5 tests. Typecheck and lint clean (wrap the long template lines by hand if Biome asks; Biome does not wrap template literals, so it may not).

- [ ] **Step 5: Commit** both files: `feat(api): write the dev seed's base rows`.

---

### Task 6: `runSeed`, proven through the real worker

**Files:**
- Create: `apps/api/scripts/seed-dev/seed.ts`
- Test: `apps/api/scripts/seed-dev/seed.test.ts`

**Interfaces:**
- Consumes: everything from `./fixtures` and `./sql`.
- Produces:
  - `interface SeedRequest { method: "GET" | "POST" | "PUT"; token?: string; body?: unknown }`
  - `interface SeedDeps { now: Date; exec(statements: string[]): Promise<void>; request(path: string, init: SeedRequest): Promise<Response> }`
  - `interface SeedResult { email: string; password: string; invitePath: string }`
  - `runSeed(deps: SeedDeps): Promise<SeedResult>`
  - `sha256Hex(text: string): Promise<string>`

- [ ] **Step 1: Write the failing test** `apps/api/scripts/seed-dev/seed.test.ts`:

```ts
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sessions } from "./fixtures";
import { runSeed, type SeedDeps } from "./seed";

const BASE = "https://api.onlooker.dev";
const NOW = new Date();

function deps(now = NOW): SeedDeps {
	return {
		now,
		exec: async (statements) => {
			await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
		},
		request: (path, init) =>
			exports.default.fetch(`${BASE}${path}`, {
				method: init.method,
				headers: {
					"Content-Type": "application/json",
					...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
				},
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
			}),
	};
}

async function rows<T>(sql: string): Promise<T[]> {
	return (await env.DB.prepare(sql).all<T>()).results;
}

async function count(sql: string): Promise<number> {
	return (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;
}

// The whole seed, in-process: its SQL against the migrated schema and every
// push through the real worker. A fixture ingest would refuse fails here, in
// CI, rather than on someone's first `pnpm seed:dev`.
describe("runSeed", () => {
	it("seeds every view's data through real ingest", async () => {
		const result = await runSeed(deps());

		expect(result.email).toBe("dev@onlooker.test");
		expect(result.invitePath).toMatch(/^\/orgs\/invites\/[0-9a-f]{64}$/);

		expect(await count("SELECT COUNT(*) AS n FROM session_summaries WHERE user_id = 'seed-user-dev'")).toBe(
			sessions(NOW).length,
		);
		expect(await count("SELECT COUNT(*) AS n FROM session_projects WHERE user_id = 'seed-user-dev'")).toBeGreaterThan(0);

		const statuses = await rows<{ status: string }>(
			"SELECT DISTINCT status FROM lessons WHERE user_id = 'seed-user-dev'",
		);
		expect(new Set(statuses.map((r) => r.status))).toEqual(
			new Set(["active", "refuted", "superseded", "retracted"]),
		);
		expect(await count("SELECT COUNT(*) AS n FROM lessons WHERE org_id = 'seed-org'")).toBe(4);

		const machinesAfter = await rows<{ id: string; revoked_at: string | null; removed_at: string | null; last_used_at: string | null; inventory: string | null }>(
			"SELECT id, revoked_at, removed_at, last_used_at, inventory FROM machine_tokens WHERE id LIKE 'seed-%'",
		);
		const byId = new Map(machinesAfter.map((m) => [m.id, m]));
		expect(byId.get("seed-spare")?.last_used_at).toBeNull();
		expect(byId.get("seed-old-laptop")?.revoked_at).not.toBeNull();
		expect(byId.get("seed-old-laptop")?.removed_at).toBeNull();
		expect(byId.get("seed-old-desktop")?.removed_at).not.toBeNull();
		expect(byId.get("seed-desktop")?.inventory).not.toBeNull();

		// Activity reads seq order; backdating must keep it in time order.
		const feed = await rows<{ at: string }>(
			"SELECT at FROM lesson_feed WHERE user_id = 'seed-user-dev' ORDER BY seq",
		);
		expect(feed).toHaveLength(12);
		expect(feed.map((r) => r.at)).toEqual([...feed.map((r) => r.at)].sort());
	});

	it("logs in with the printed password", async () => {
		const result = await runSeed(deps());
		const login = await exports.default.fetch(`${BASE}/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: result.email, password: result.password }),
		});
		expect(login.status).toBe(200);
	});

	it("gives the same rows on a second run, and leaves other accounts alone", async () => {
		await env.DB.prepare(
			"INSERT INTO users (id, email, password_hash) VALUES ('bystander', 'bystander@example.com', 'x')",
		).run();
		await runSeed(deps());
		const first = await count("SELECT COUNT(*) AS n FROM lessons WHERE user_id LIKE 'seed-%'");
		await runSeed(deps(new Date(NOW.getTime() + 3_600_000)));

		expect(await count("SELECT COUNT(*) AS n FROM lessons WHERE user_id LIKE 'seed-%'")).toBe(first);
		expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = 'bystander'")).toBe(1);
	});

	it("stops, naming the endpoint, when a push is refused", async () => {
		const failing = deps();
		const refuse: SeedDeps = {
			...failing,
			request: async (path, init) =>
				path === "/machine/sessions"
					? new Response('{"error":"nope"}', { status: 400 })
					: failing.request(path, init),
		};
		await expect(runSeed(refuse)).rejects.toThrow(/POST \/machine\/sessions.*400.*nope/);
	});
});
```

Check the login route's success status in `apps/api/src/routes/auth.ts` (`handleLogin`); if it is not 200, assert the status it returns.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @onlooker/api test seed.test`
Expected: FAIL — cannot find module `./seed`.

- [ ] **Step 3: Implement** `apps/api/scripts/seed-dev/seed.ts`:

```ts
/**
 * Runs the dev seed (ONL-300) through two injected functions, so the same
 * code runs against the local stack (main.ts: wrangler and fetch) and the
 * Workers test pool (seed.test.ts: D1 and the worker itself).
 *
 * Base rows go in as SQL; sessions, inventories and lessons go through the
 * API's machine routes, so ingest validates them and builds what it builds in
 * production. Any refusal stops the run: the next run starts by deleting what
 * this one wrote, so a partial seed costs nothing.
 */

import * as bcrypt from "bcryptjs";
import {
	invites,
	lessonTimeline,
	machines,
	SEED_PASSWORD,
	sessions,
	USERS,
} from "./fixtures";
import { afterSql, baseSql, resetSql } from "./sql";

export interface SeedRequest {
	method: "GET" | "POST" | "PUT";
	token?: string;
	body?: unknown;
}

export interface SeedDeps {
	now: Date;
	exec(statements: string[]): Promise<void>;
	request(path: string, init: SeedRequest): Promise<Response>;
}

export interface SeedResult {
	email: string;
	password: string;
	/** The pending invite's page, to open logged in as sam. */
	invitePath: string;
}

/** The API's bcrypt cost (utils/crypto.ts), so seeded logins cost what real ones do. */
const BCRYPT_COST = 10;

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The API refuses any token not shaped `onlk_` + 64 hex. */
async function machineToken(machineId: string): Promise<string> {
	return `onlk_${await sha256Hex(`seed-token-${machineId}`)}`;
}

async function send(deps: SeedDeps, path: string, init: SeedRequest): Promise<unknown> {
	const response = await deps.request(path, init);
	const text = await response.text();
	if (!response.ok)
		throw new Error(`seed: ${init.method} ${path} returned ${response.status}: ${text}`);
	return text ? JSON.parse(text) : null;
}

export async function runSeed(deps: SeedDeps): Promise<SeedResult> {
	const { now } = deps;
	const allMachines = machines(now);

	const tokens: Record<string, string> = {};
	const tokenHashes: Record<string, string> = {};
	for (const machine of allMachines) {
		tokens[machine.id] = await machineToken(machine.id);
		tokenHashes[machine.id] = await sha256Hex(tokens[machine.id]);
	}
	const inviteTokens: Record<string, string> = {};
	const inviteHashes: Record<string, string> = {};
	for (const invite of invites(now)) {
		inviteTokens[invite.id] = await sha256Hex(invite.tokenSeed);
		inviteHashes[invite.id] = await sha256Hex(inviteTokens[invite.id]);
	}
	const passwordHash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_COST);

	await deps.exec(resetSql());
	await deps.exec(baseSql({ now, passwordHash, tokenHashes, inviteHashes }));

	const byMachine = new Map<string, unknown[]>();
	for (const { machine, body } of sessions(now))
		byMachine.set(machine, [...(byMachine.get(machine) ?? []), body]);
	for (const [machine, batch] of byMachine)
		await send(deps, "/machine/sessions", {
			method: "POST",
			token: tokens[machine],
			body: { schema_version: 1, sessions: batch },
		});

	for (const machine of allMachines)
		if (machine.inventory)
			await send(deps, "/machine/inventory", {
				method: "PUT",
				token: tokens[machine.id],
				body: machine.inventory,
			});

	const timeline = lessonTimeline(now);
	for (const event of timeline) {
		if (event.kind === "push") {
			const reply = (await send(deps, "/lessons", {
				method: "POST",
				token: tokens[event.machine],
				body: { lessons: [event.lesson] },
			})) as { results: { id: string; outcome: string; error?: string }[] };
			const [result] = reply.results;
			// POST /lessons answers 200 even when it refuses a lesson.
			if (result?.outcome !== "created")
				throw new Error(
					`seed: POST /lessons refused ${event.lesson.id}: ${result?.outcome} ${result?.error ?? ""}`,
				);
		} else {
			await send(deps, `/lessons/${event.lessonId}/status`, {
				method: "POST",
				token: tokens[event.machine],
				body:
					event.supersededBy === null
						? { status: event.status }
						: { status: event.status, superseded_by: event.supersededBy },
			});
		}
	}

	await deps.exec(afterSql(now, timeline));

	return {
		email: USERS.dev.email,
		password: SEED_PASSWORD,
		invitePath: `/orgs/invites/${inviteTokens["seed-invite-pending"]}`,
	};
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm --filter @onlooker/api test seed.test` — PASS, 4 tests.

If a push is refused, the thrown message names the endpoint and the response. Fix the fixture (Tasks 2-4's file) so ingest accepts it, re-run `fixtures.test` too, and report the change. Never loosen an assertion.

Then the whole API suite: `pnpm --filter @onlooker/api test` — all pass. Typecheck and lint clean.

- [ ] **Step 5: Commit** both files: `feat(api): run the dev seed through the real ingest routes`.

---

### Task 7: The runner, the command, and retiring the old seed

**Files:**
- Create: `apps/api/scripts/seed-dev/main.ts`
- Modify: root `package.json`, `docs/development.md`, `.github/workflows/deploy.yml`
- Delete: `scripts/seed-dev-projects.sh`, `scripts/seed-dev-projects.test.sh`

**Interfaces:**
- Consumes: `runSeed` (Task 6), `LOCAL_API`, `wranglerArgs` (Task 1).

- [ ] **Step 1: Implement** `apps/api/scripts/seed-dev/main.ts`:

```ts
/**
 * `pnpm seed:dev` (ONL-300): fills the local stack so every signed-in view of
 * the web app has data. Start `pnpm dev` first; this talks to the running API
 * and writes to its local database, and nowhere else (see local.ts).
 *
 * The only file in the seed that touches Node, so no test imports it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_API, wranglerArgs } from "./local";
import { runSeed } from "./seed";

const WEB = "http://localhost:5173";

async function apiAnswers(): Promise<boolean> {
	try {
		return (await fetch(`${LOCAL_API}/`)).ok;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	if (!(await apiAnswers())) {
		process.stderr.write(
			`seed:dev: the local API isn't answering at ${LOCAL_API}. Start it with \`pnpm dev\` first.\n`,
		);
		process.exit(2);
	}

	const dir = mkdtempSync(join(tmpdir(), "onlooker-seed-"));
	try {
		const result = await runSeed({
			now: new Date(),
			exec: async (statements) => {
				const file = join(dir, "seed.sql");
				writeFileSync(file, `${statements.join("\n")}\n`);
				execFileSync("pnpm", wranglerArgs(file), { stdio: ["ignore", "ignore", "inherit"] });
			},
			request: (path, init) =>
				fetch(`${LOCAL_API}${path}`, {
					method: init.method,
					headers: {
						"Content-Type": "application/json",
						...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
					},
					body: init.body === undefined ? undefined : JSON.stringify(init.body),
				}),
		});

		process.stdout.write(
			[
				"seed:dev: done.",
				`  Log in at ${WEB}/login as ${result.email} / ${result.password}`,
				"  (ada@onlooker.test and sam@onlooker.test use the same password.)",
				`  Pending invite, to open as sam: ${WEB}${result.invitePath}`,
				"  Then open Home, Lessons, Activity, Sessions, Projects, Machines and Orgs.",
				"",
			].join("\n"),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
```

Check the web dev server's port in `apps/web/vite.config.ts` (or `APP_BASE_URL` in `apps/api/wrangler.toml`, which is `http://localhost:5173`); use that for `WEB`.

- [ ] **Step 2: Point the command at it.** In root `package.json`, change `"seed:dev": "bash scripts/seed-dev-projects.sh"` to `"seed:dev": "tsx apps/api/scripts/seed-dev/main.ts"`.

- [ ] **Step 3: Retire the old seed.** Delete `scripts/seed-dev-projects.sh` and `scripts/seed-dev-projects.test.sh` with `git rm`. In `.github/workflows/deploy.yml`, remove the step:

```yaml
      # Pins that the local seed can only ever write to the local database.
      - name: Local seed script tests
        run: bash scripts/seed-dev-projects.test.sh
```

(its guarantee now lives in `local.test.ts`, which runs with the API suite). Grep the repo for `seed-dev-projects` and fix any remaining reference outside `docs/superpowers/`.

- [ ] **Step 4: Rewrite the docs.** In `docs/development.md`, replace the paragraph that begins "A local account has no sessions until a machine syncs" through "See `scripts/seed-dev-projects.sh`." with:

```markdown
A fresh local stack has nothing to look at. To fill every signed-in view, start
`pnpm dev`, then in another terminal:

```sh
pnpm seed:dev
```

Log in as `dev@onlooker.test` with the password it prints. It creates three
accounts, an org with a pending and an expired invite, machines in every state,
a week of sessions and lessons in every status, all through the running local
API. It writes only to the local database and `localhost:8787`, replaces its
own rows on each run, and leaves any other local account alone. Accounts on
`@onlooker.test` are the seed's: don't sign up with that domain. See
`apps/api/scripts/seed-dev/`.
```

- [ ] **Step 5: Gates.**

Run: `pnpm --filter @onlooker/api test` — all pass.
Run: `pnpm typecheck` — all tasks pass.
Run: `pnpm --filter @onlooker/api lint` — no errors.

- [ ] **Step 6: Commit** `main.ts`, `package.json`, `docs/development.md`, `deploy.yml` and the two deletions: `feat(dev): fill the local stack with one command`.

- [ ] **Step 7: Run it for real (controller, not a subagent).** With migrations applied (`pnpm --filter @onlooker/api exec wrangler d1 migrations apply onlooker-db-local --local --env development`) and `pnpm dev` running, run `pnpm seed:dev` twice. Log in at the printed address and open Home, Lessons, a lesson's detail, Activity, Sessions, Projects, Machines and Orgs; each must show data. Open the invite link logged in as sam. Confirm the second run printed the same and the counts didn't change.
