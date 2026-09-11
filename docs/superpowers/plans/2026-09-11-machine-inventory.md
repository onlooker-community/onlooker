# Machine Plugin Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `onlooker sync` reports this machine's plugin inventory to the API before doing any lesson work, and the Machines page renders it.

**Architecture:** The CLI joins two local files — `installed_plugins.json` (what is on disk, per scope) and `settings.json` (what is enabled) — into one JSON document, and `PUT`s it to a machine-authenticated endpoint that replaces one column on the reporting machine's own row. The browser reads a summary in the machines list and the full document from a per-machine route.

**Tech Stack:** TypeScript, Vitest, Drizzle ORM on Cloudflare D1, React (`apps/web`), Cloudflare Workers (`apps/api`).

**Spec:** `docs/superpowers/specs/2026-09-11-machine-inventory-design.md`. **Bead:** `onlooker-sbgh`.

## Global Constraints

Every task's requirements implicitly include these. They come from the spec and are decisions, not preferences.

- **Purpose is fleet visibility only.** No drift detection, no advisories, no history, no `applies_to` targeting. Each report replaces the last.
- **Project paths travel home-relative** (`~/src/github.com/…`), never absolute. The OS username must not reach the server.
- **All marketplaces are reported**, not just `@onlooker-community`. `doctor` filters to one marketplace; the inventory must not.
- **The config directory comes from `userConfigDir`** (`apps/cli/src/enablement.ts:146`), never a new resolver and never a hardcoded `$HOME/.claude`. This defect has shipped twice in this stack.
- **A failed report is non-fatal and never silent.** Sync still does the lesson work and still exits on the lesson verdict, and the failure is always printed.
- **The write is idempotent replacement.** Running sync twice must not accumulate anything.
- **Unknown is distinct from false.** Where enablement cannot be known for a scope, it is `null`, not `false` — matching the existing `Enablement` type's `unknown` kind.
- **Every new endpoint gets a contract case** in `packages/api-contract`, and `apps/web`'s mock must satisfy it. Mock/API drift is already an open defect (`onlooker-jws`).
- Run tests with `pnpm --filter <package> test` (all packages use `vitest run`).

---

### Task 1: Expose the unfiltered enabled map

`readEnablement` merges the user and project settings layers, then filters to `@onlooker-community` and strips the suffix (`enablement.ts:225-226`). The inventory needs the merged map *before* that filter, and needs `userConfigDir`, which is currently private. This task splits the merge from the filter and changes no behavior.

**Files:**
- Modify: `apps/cli/src/enablement.ts`
- Test: `apps/cli/src/__tests__/enablement.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function userConfigDir(env: NodeJS.ProcessEnv, home: string, override?: string): string`
  - `export type EnabledMap = { kind: "unknown"; reason: string } | { kind: "found"; enabled: Record<string, boolean>; source: string }`
  - `export function readEnabledMap(opts: { cwd: string; home?: string; configDir?: string; env?: NodeJS.ProcessEnv }): EnabledMap`
  - `readEnablement` keeps its existing signature and return type exactly.

- [ ] **Step 1: Write the failing test**

Add to `apps/cli/src/__tests__/enablement.test.ts`:

```ts
import { readEnabledMap, userConfigDir } from "../enablement";

describe("readEnabledMap", () => {
	it("keeps plugins from every marketplace, unlike readEnablement", () => {
		const configDir = mkdtempSync(join(tmpdir(), "onlooker-enabled-"));
		writeFileSync(
			join(configDir, "settings.json"),
			JSON.stringify({
				enabledPlugins: {
					"librarian@onlooker-community": true,
					"superpowers@superpowers-dev": true,
					"archivist@onlooker-community": false,
				},
			}),
		);

		const map = readEnabledMap({ cwd: configDir, configDir });

		expect(map.kind).toBe("found");
		if (map.kind !== "found") return;
		// The whole point: a foreign marketplace survives here.
		expect(map.enabled).toEqual({
			"librarian@onlooker-community": true,
			"superpowers@superpowers-dev": true,
			"archivist@onlooker-community": false,
		});
	});

	it("reports unknown when a layer cannot be parsed", () => {
		const configDir = mkdtempSync(join(tmpdir(), "onlooker-enabled-"));
		writeFileSync(join(configDir, "settings.json"), "{ not json");

		expect(readEnabledMap({ cwd: configDir, configDir }).kind).toBe("unknown");
	});
});

describe("userConfigDir", () => {
	it("prefers CLAUDE_HOME, then CLAUDE_CONFIG_DIR, then the default", () => {
		expect(userConfigDir({ CLAUDE_HOME: "/a", CLAUDE_CONFIG_DIR: "/b" }, "/h")).toBe("/a");
		expect(userConfigDir({ CLAUDE_CONFIG_DIR: "/b" }, "/h")).toBe("/b");
		expect(userConfigDir({}, "/h")).toBe("/h/.claude");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @onlooker/cli test -- enablement`
Expected: FAIL — `readEnabledMap is not a function`, `userConfigDir is not a function`.

- [ ] **Step 3: Refactor `enablement.ts`**

Change `function userConfigDir` to `export function userConfigDir` (line 146). Then extract everything in `readEnablement` from the top through the `problems`/`sources` checks into a new exported function, and leave `readEnablement` as the filter over it:

```ts
export type EnabledMap =
	| { kind: "unknown"; reason: string }
	| { kind: "found"; enabled: Record<string, boolean>; source: string };

/**
 * The merged `enabledPlugins` map, before any marketplace filter.
 *
 * Split out of `readEnablement` because the inventory reports every
 * marketplace while `doctor` judges only its own. Both need the identical
 * layering - global, then project, then `settings.local.json` - and a second
 * copy of that merge would be a second thing to get wrong.
 */
export function readEnabledMap(opts: {
	cwd: string;
	home?: string;
	configDir?: string;
	env?: NodeJS.ProcessEnv;
}): EnabledMap {
	// ...body moved verbatim from readEnablement, returning
	// { kind: "found", enabled: merged as Record<string, boolean>, source: sources.join(", ") }
}

export function readEnablement(opts: {
	cwd: string;
	home?: string;
	configDir?: string;
	env?: NodeJS.ProcessEnv;
}): Enablement {
	const map = readEnabledMap(opts);
	if (map.kind === "unknown") return map;

	const plugins = Object.entries(map.enabled)
		.filter(([name, on]) => on === true && name.endsWith(MARKETPLACE))
		.map(([name]) => name.slice(0, -MARKETPLACE.length))
		.sort((a, b) => a.localeCompare(b));

	return { kind: "found", plugins, source: map.source };
}
```

- [ ] **Step 4: Run the whole CLI suite**

Run: `pnpm --filter @onlooker/cli test`
Expected: PASS — including every pre-existing `readEnablement` and `doctor` test. This task is a refactor; a changed assertion anywhere else means behavior moved and must be put back.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/enablement.ts apps/cli/src/__tests__/enablement.test.ts
git commit -m "refactor(cli): split the enabled merge from the marketplace filter :scissors:"
```

---

### Task 2: Collect the inventory document

**Files:**
- Create: `apps/cli/src/inventory.ts`
- Create: `apps/cli/src/__tests__/inventory.test.ts`

**Interfaces:**
- Consumes: `userConfigDir`, `readEnabledMap`, `repoRoot` from Task 1's `enablement.ts`.
- Produces:

```ts
export interface InventoryScope {
	/** "user", or a home-relative project path like "~/src/foo". */
	scope: string;
	version: string;
	git_commit_sha: string | null;
	installed_at: string | null;
	last_updated: string | null;
	/** null means unknowable - a project other than the one sync ran in. */
	enabled: boolean | null;
}

export interface InventoryPlugin {
	/** As keyed in installed_plugins.json, e.g. "librarian@onlooker-community". */
	id: string;
	scopes: InventoryScope[];
}

export interface Inventory {
	schema_version: 1;
	collected_at: string;
	/** Home-relative path of the project sync ran in, or null outside a repo. */
	project: string | null;
	plugins: InventoryPlugin[];
}

export type Collected =
	| { kind: "collected"; inventory: Inventory }
	| { kind: "unavailable"; reason: string };

export function collectInventory(opts: {
	cwd: string;
	home?: string;
	configDir?: string;
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
}): Collected;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/src/__tests__/inventory.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectInventory } from "../inventory";

const HOME = "/Users/tester";

function configDirWith(installed: unknown, settings?: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "onlooker-inv-"));
	mkdirSync(join(dir, "plugins"), { recursive: true });
	writeFileSync(
		join(dir, "plugins", "installed_plugins.json"),
		JSON.stringify(installed),
	);
	if (settings !== undefined) {
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	}
	return dir;
}

const TWO_SCOPES = {
	version: 1,
	plugins: {
		"librarian@onlooker-community": [
			{
				scope: "user",
				projectPath: null,
				version: "0.18.1",
				gitCommitSha: "abc123",
				installedAt: "2026-09-05T18:39:27.969Z",
				lastUpdated: "2026-09-09T21:50:18.733Z",
			},
			{
				scope: "project",
				projectPath: `${HOME}/src/ecosystem`,
				version: "0.18.0",
				gitCommitSha: "def456",
				installedAt: "2026-09-05T18:39:27.969Z",
				lastUpdated: "2026-09-09T21:50:18.733Z",
			},
		],
	},
};

describe("collectInventory", () => {
	it("keeps every scope a plugin is installed at, with its own version", () => {
		const configDir = configDirWith(TWO_SCOPES);

		const result = collectInventory({ cwd: HOME, home: HOME, configDir });

		expect(result.kind).toBe("collected");
		if (result.kind !== "collected") return;
		const librarian = result.inventory.plugins.find(
			(p) => p.id === "librarian@onlooker-community",
		);
		// The failure this test exists for: an implementation that keeps only
		// the last scope it read passes a one-install fixture and fails here.
		expect(librarian?.scopes).toHaveLength(2);
		expect(librarian?.scopes.map((s) => s.version).sort()).toEqual([
			"0.18.0",
			"0.18.1",
		]);
	});

	it("sends project paths home-relative, never absolute", () => {
		const configDir = configDirWith(TWO_SCOPES);

		const result = collectInventory({ cwd: HOME, home: HOME, configDir });

		if (result.kind !== "collected") throw new Error("expected collected");
		const serialized = JSON.stringify(result.inventory);
		expect(serialized).toContain("~/src/ecosystem");
		expect(serialized).not.toContain(HOME);
	});

	it("keeps plugins from marketplaces doctor ignores", () => {
		const configDir = configDirWith({
			version: 1,
			plugins: {
				"superpowers@superpowers-dev": [
					{ scope: "user", projectPath: null, version: "6.2.0" },
				],
			},
		});

		const result = collectInventory({ cwd: HOME, home: HOME, configDir });

		if (result.kind !== "collected") throw new Error("expected collected");
		expect(result.inventory.plugins.map((p) => p.id)).toEqual([
			"superpowers@superpowers-dev",
		]);
	});

	it("marks an install enabled, disabled, or unknown", () => {
		const configDir = configDirWith(TWO_SCOPES, {
			enabledPlugins: { "librarian@onlooker-community": true },
		});

		// cwd is the user config dir, so the "project" scope above is NOT the
		// project sync ran in, and its enablement is unknowable.
		const result = collectInventory({ cwd: configDir, home: HOME, configDir });

		if (result.kind !== "collected") throw new Error("expected collected");
		const scopes = result.inventory.plugins[0].scopes;
		expect(scopes.find((s) => s.scope === "user")?.enabled).toBe(true);
		expect(scopes.find((s) => s.scope !== "user")?.enabled).toBeNull();
	});

	it("is unavailable, not empty, when the file is missing", () => {
		const configDir = mkdtempSync(join(tmpdir(), "onlooker-inv-"));

		const result = collectInventory({ cwd: HOME, home: HOME, configDir });

		// "No plugins installed" and "we could not look" are different claims.
		expect(result.kind).toBe("unavailable");
	});

	it("is unavailable when the file is not valid JSON", () => {
		const dir = mkdtempSync(join(tmpdir(), "onlooker-inv-"));
		mkdirSync(join(dir, "plugins"), { recursive: true });
		writeFileSync(join(dir, "plugins", "installed_plugins.json"), "{ nope");

		expect(collectInventory({ cwd: HOME, home: HOME, configDir: dir }).kind).toBe(
			"unavailable",
		);
	});

	it("stamps collected_at from the injected clock", () => {
		const configDir = configDirWith(TWO_SCOPES);

		const result = collectInventory({
			cwd: HOME,
			home: HOME,
			configDir,
			now: () => new Date("2026-09-11T12:00:00.000Z"),
		});

		if (result.kind !== "collected") throw new Error("expected collected");
		expect(result.inventory.collected_at).toBe("2026-09-11T12:00:00.000Z");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @onlooker/cli test -- inventory`
Expected: FAIL — `Cannot find module '../inventory'`.

- [ ] **Step 3: Implement `apps/cli/src/inventory.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnabledMap, repoRoot, userConfigDir } from "./enablement";

export interface InventoryScope {
	scope: string;
	version: string;
	git_commit_sha: string | null;
	installed_at: string | null;
	last_updated: string | null;
	enabled: boolean | null;
}

export interface InventoryPlugin {
	id: string;
	scopes: InventoryScope[];
}

export interface Inventory {
	schema_version: 1;
	collected_at: string;
	project: string | null;
	plugins: InventoryPlugin[];
}

export type Collected =
	| { kind: "collected"; inventory: Inventory }
	| { kind: "unavailable"; reason: string };

/** `~/src/foo` for a path under home; the path unchanged otherwise. */
function homeRelative(path: string, home: string): string {
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function collectInventory(opts: {
	cwd: string;
	home?: string;
	configDir?: string;
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
}): Collected {
	const home = opts.home ?? homedir();
	const env = opts.env ?? process.env;
	const dir = userConfigDir(env, home, opts.configDir);
	const file = join(dir, "plugins", "installed_plugins.json");

	if (!existsSync(file)) {
		return {
			kind: "unavailable",
			reason: `${homeRelative(file, home)} does not exist, so no plugin is installed for this config directory.`,
		};
	}

	let parsed: { plugins?: Record<string, unknown[]> };
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return {
			kind: "unavailable",
			reason: `${homeRelative(file, home)} could not be read: ${(error as Error).message}`,
		};
	}

	// The project sync ran in. Its enablement is the only project-scope
	// enablement this machine can answer for; every other project's settings
	// live in a tree we are not looking at.
	const project = repoRoot(opts.cwd);
	const enabled = readEnabledMap({
		cwd: opts.cwd,
		home,
		configDir: opts.configDir,
		env,
	});
	const enabledFor = (scope: string, id: string): boolean | null => {
		if (enabled.kind === "unknown") return null;
		if (scope === "user") return enabled.enabled[id] === true;
		if (project !== null && scope === homeRelative(project, home)) {
			return enabled.enabled[id] === true;
		}
		return null;
	};

	const plugins: InventoryPlugin[] = Object.entries(parsed.plugins ?? {})
		.map(([id, entries]) => ({
			id,
			scopes: (Array.isArray(entries) ? entries : []).map((raw) => {
				const e = raw as Record<string, unknown>;
				const scope =
					e.scope === "project" && typeof e.projectPath === "string"
						? homeRelative(e.projectPath, home)
						: "user";
				return {
					scope,
					version: typeof e.version === "string" ? e.version : "unknown",
					git_commit_sha:
						typeof e.gitCommitSha === "string" ? e.gitCommitSha : null,
					installed_at:
						typeof e.installedAt === "string" ? e.installedAt : null,
					last_updated:
						typeof e.lastUpdated === "string" ? e.lastUpdated : null,
					enabled: enabledFor(scope, id),
				};
			}),
		}))
		// Sorted here so the stored document is stable between runs and a
		// diff between two reports means something changed.
		.sort((a, b) => a.id.localeCompare(b.id));

	return {
		kind: "collected",
		inventory: {
			schema_version: 1,
			collected_at: (opts.now?.() ?? new Date()).toISOString(),
			project: project === null ? null : homeRelative(project, home),
			plugins,
		},
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @onlooker/cli test -- inventory`
Expected: PASS, all seven.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/inventory.ts apps/cli/src/__tests__/inventory.test.ts
git commit -m "feat(cli): collect what is installed, per scope :clipboard:"
```

---

### Task 3: Carry the machine id through machine auth

`verifyMachineToken` already selects the row `id` and returns only `user_id` (`apps/api/src/db/machine-tokens.ts:70`). The inventory write needs to know which machine is reporting, and widening the return costs no extra query.

**Files:**
- Modify: `apps/api/src/db/machine-tokens.ts`
- Modify: `apps/api/src/middleware/machine-auth.ts`
- Test: `apps/api/src/middleware/__tests__/machine-auth.test.ts` (or the existing location for that module's tests)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `verifyMachineToken(db, token): Promise<{ userId: string; machineId: string } | null>`
  - `requireMachineToken(request, env): Promise<{ userId: string; machineId: string }>`
  - Existing call sites destructure `{ userId }` and keep working unchanged.

- [ ] **Step 1: Write the failing test**

```ts
it("identifies which machine the token belongs to, not just the owner", async () => {
	const { db, userId } = await seedUser();
	const created = await createMachineToken(db, userId, "laptop");

	const verified = await verifyMachineToken(db, created.token);

	expect(verified).toEqual({ userId, machineId: created.id });
});

it("returns null for a revoked token", async () => {
	const { db, userId } = await seedUser();
	const created = await createMachineToken(db, userId, "laptop");
	await revokeMachineToken(db, userId, created.id);

	expect(await verifyMachineToken(db, created.token)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @onlooker/api test -- machine`
Expected: FAIL — received the bare `userId` string, expected an object.

- [ ] **Step 3: Widen both functions**

In `machine-tokens.ts`, change the return type and the final two returns:

```ts
export async function verifyMachineToken(
	db: D1Database,
	token: string,
): Promise<{ userId: string; machineId: string } | null> {
	// ...unchanged through the `rows` query and the `if (!row) return null;`

	await client(db)
		.update(machine_tokens)
		.set({ last_used_at: new Date().toISOString() })
		.where(eq(machine_tokens.id, row.id));

	return { userId: row.user_id, machineId: row.id };
}
```

In `machine-auth.ts`:

```ts
export async function requireMachineToken(
	request: Request,
	env: WorkerEnv,
): Promise<{ userId: string; machineId: string }> {
	const token = extractToken(request);
	if (!token) {
		throw new ApiError(401, "unauthorized", "Missing machine token");
	}

	const verified = await verifyMachineToken(env.DB, token);
	if (!verified) {
		throw new ApiError(401, "invalid_token", "Invalid or revoked machine token");
	}

	return verified;
}
```

- [ ] **Step 4: Run the whole API suite**

Run: `pnpm --filter @onlooker/api test`
Expected: PASS. `lessons.ts:160` and `lessons.ts:429` destructure `{ userId }`, which still resolves; a failure there means something read the old string return directly.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/machine-tokens.ts apps/api/src/middleware/machine-auth.ts apps/api/src/middleware/__tests__/machine-auth.test.ts
git commit -m "feat(api): let a verified token say which machine it is :id:"
```

---

### Task 4: Schema columns and migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/expected-schema.ts` (regenerated, not hand-edited)
- Create: `packages/db/migrations/0006_*.sql` (generated)

**Interfaces:**
- Consumes: nothing.
- Produces: `machine_tokens.inventory` (TEXT, nullable) and `machine_tokens.inventory_at` (TEXT, nullable).

- [ ] **Step 1: Add the columns**

In `packages/db/src/schema.ts`, inside `machine_tokens`, after `revoked_at`:

```ts
		/**
		 * The machine's reported plugin inventory, as the CLI's own JSON.
		 *
		 * A document rather than a `machine_plugins` table, for the reason the
		 * `lessons` table gives above: only fields the server filters or orders
		 * on earn a column. The server never reads inside this one - it stores
		 * what the machine sent and hands it back. Querying across machines
		 * ("who still runs librarian 0.6.1") is the drift feature, which is out
		 * of scope, and is what would justify normalizing this later.
		 */
		inventory: text("inventory"),
		/** When the row above was last replaced. Null means never reported. */
		inventory_at: text("inventory_at"),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @onlooker/db generate:migrations`
Expected: a new `migrations/0006_*.sql` containing two `ALTER TABLE machine_tokens ADD` statements. Read it before continuing — a generated migration that drops or recreates the table is wrong and must not be committed.

- [ ] **Step 3: Regenerate the expected schema**

Run: `pnpm --filter @onlooker/db generate:expected-schema`
Expected: `expected-schema.ts` gains the two columns under `machine_tokens`.

- [ ] **Step 4: Run the schema tests**

Run: `pnpm --filter @onlooker/db test`
Expected: PASS — the schema assertion matches the regenerated expectation.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/expected-schema.ts packages/db/migrations
git commit -m "feat(db): give a machine somewhere to say what it runs :floppy_disk:"
```

---

### Task 5: Inventory persistence

**Files:**
- Create: `apps/api/src/db/machine-inventory.ts`
- Modify: `apps/api/src/db/machine-tokens.ts` (`listMachineTokens` summary fields)
- Create: `apps/api/src/db/__tests__/machine-inventory.test.ts`

**Interfaces:**
- Consumes: Task 4's columns.
- Produces:
  - `putMachineInventory(db: D1Database, machineId: string, document: string, at: string): Promise<void>`
  - `getMachineInventory(db: D1Database, userId: string, machineId: string): Promise<{ inventory: string; inventory_at: string } | null>`
  - `listMachineTokens` rows gain `inventory_at: string | null` and `plugin_count: number | null`.

- [ ] **Step 1: Write the failing tests**

```ts
it("replaces the document rather than accumulating", async () => {
	const { db, userId } = await seedUser();
	const m = await createMachineToken(db, userId, "laptop");

	await putMachineInventory(db, m.id, '{"schema_version":1,"plugins":[]}', "2026-09-11T00:00:00.000Z");
	await putMachineInventory(db, m.id, '{"schema_version":1,"plugins":[{"id":"a","scopes":[]}]}', "2026-09-11T01:00:00.000Z");

	const got = await getMachineInventory(db, userId, m.id);
	expect(JSON.parse(got!.inventory).plugins).toHaveLength(1);
	expect(got!.inventory_at).toBe("2026-09-11T01:00:00.000Z");
});

it("will not hand a machine's inventory to another account", async () => {
	const { db, userId } = await seedUser();
	const other = await seedUser(db);
	const m = await createMachineToken(db, userId, "laptop");
	await putMachineInventory(db, m.id, "{}", "2026-09-11T00:00:00.000Z");

	expect(await getMachineInventory(db, other.userId, m.id)).toBeNull();
});

it("reports a never-reported machine as null, not as empty", async () => {
	const { db, userId } = await seedUser();
	const m = await createMachineToken(db, userId, "laptop");

	expect(await getMachineInventory(db, userId, m.id)).toBeNull();

	const [row] = await listMachineTokens(db, userId);
	expect(row.inventory_at).toBeNull();
	expect(row.plugin_count).toBeNull();
});

it("summarizes plugin count in the list without sending the document", async () => {
	const { db, userId } = await seedUser();
	const m = await createMachineToken(db, userId, "laptop");
	await putMachineInventory(
		db,
		m.id,
		JSON.stringify({ schema_version: 1, plugins: [{ id: "a", scopes: [] }, { id: "b", scopes: [] }] }),
		"2026-09-11T00:00:00.000Z",
	);

	const [row] = await listMachineTokens(db, userId);
	expect(row.plugin_count).toBe(2);
	expect(JSON.stringify(row)).not.toContain("scopes");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @onlooker/api test -- machine-inventory`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/db/machine-inventory.ts`:

```ts
import { and, eq, isNull } from "drizzle-orm";
import { machine_tokens } from "@onlooker/db";
import { client } from "./client.js";

export async function putMachineInventory(
	db: D1Database,
	machineId: string,
	document: string,
	at: string,
): Promise<void> {
	await client(db)
		.update(machine_tokens)
		.set({ inventory: document, inventory_at: at })
		.where(eq(machine_tokens.id, machineId));
}

/**
 * Scoped by `userId` as well as id, so a guessed machine id belonging to
 * someone else reads as absent rather than as forbidden - the same existence
 * oracle `revokeMachineToken` already avoids.
 */
export async function getMachineInventory(
	db: D1Database,
	userId: string,
	machineId: string,
): Promise<{ inventory: string; inventory_at: string } | null> {
	const rows = await client(db)
		.select({
			inventory: machine_tokens.inventory,
			inventory_at: machine_tokens.inventory_at,
		})
		.from(machine_tokens)
		.where(
			and(
				eq(machine_tokens.id, machineId),
				eq(machine_tokens.user_id, userId),
				isNull(machine_tokens.revoked_at),
			),
		)
		.limit(1);

	const row = rows[0];
	if (!row?.inventory || !row.inventory_at) return null;
	return { inventory: row.inventory, inventory_at: row.inventory_at };
}
```

In `listMachineTokens`, select `inventory` and `inventory_at`, and map `inventory` to a count without returning the document:

```ts
	// The count, never the document. A machines list carrying every machine's
	// full inventory is the response this split exists to avoid.
	return rows.map(({ inventory, ...row }) => ({
		...row,
		plugin_count: pluginCount(inventory),
	}));
```

```ts
/** Plugin count from a stored document, or null when unreported or unreadable. */
function pluginCount(document: string | null): number | null {
	if (!document) return null;
	try {
		const parsed = JSON.parse(document) as { plugins?: unknown };
		return Array.isArray(parsed.plugins) ? parsed.plugins.length : null;
	} catch {
		return null;
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @onlooker/api test -- machine`
Expected: PASS, including the pre-existing machine-token tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/machine-inventory.ts apps/api/src/db/machine-tokens.ts apps/api/src/db/__tests__/machine-inventory.test.ts
git commit -m "feat(api): store one inventory per machine, replacing not appending :package:"
```

---

### Task 6: `PUT /machine/inventory`

**Files:**
- Create: `apps/api/src/routes/machine-inventory.ts`
- Modify: `apps/api/src/routes/index.ts` (export)
- Modify: `apps/api/src/router.ts` (route entry)
- Create: `apps/api/src/routes/machine-inventory.test.ts`

**Interfaces:**
- Consumes: `requireMachineToken` (Task 3), `putMachineInventory` (Task 5).
- Produces: `handlePutInventory(request, env): Promise<Response>`, responding `{ ok: true }` at 200.

- [ ] **Step 1: Write the failing tests**

```ts
const DOC = { schema_version: 1, collected_at: "2026-09-11T00:00:00.000Z", project: null, plugins: [] };

const put = (token: string, body: unknown) =>
	new Request("https://api.test/machine/inventory", {
		method: "PUT",
		headers: { Authorization: `Bearer ${token}` },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

it("stores the document and answers ok", async () => {
	const { env, userId } = await seedEnv();
	const m = await createMachineToken(env.DB, userId, "laptop");

	const response = await handlePutInventory(put(m.token, DOC), env);

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ ok: true });
	expect(await getMachineInventory(env.DB, userId, m.id)).not.toBeNull();
});

it("rejects a body that is not an inventory document", async () => {
	const { env, userId } = await seedEnv();
	const m = await createMachineToken(env.DB, userId, "laptop");

	await expect(
		handlePutInventory(put(m.token, { schema_version: 1, plugins: "nope" }), env),
	).rejects.toMatchObject({ status: 400, code: "invalid_inventory" });
});

it("rejects an unknown schema_version", async () => {
	const { env, userId } = await seedEnv();
	const m = await createMachineToken(env.DB, userId, "laptop");

	await expect(
		handlePutInventory(put(m.token, { schema_version: 99, plugins: [] }), env),
	).rejects.toMatchObject({ status: 400, code: "unsupported_schema_version" });
});

it("rejects a document over the size cap", async () => {
	const { env, userId } = await seedEnv();
	const m = await createMachineToken(env.DB, userId, "laptop");
	const huge = {
		...DOC,
		plugins: Array.from({ length: 20_000 }, (_, i) => ({ id: `p${i}`, scopes: [] })),
	};

	await expect(handlePutInventory(put(m.token, huge), env)).rejects.toMatchObject({
		status: 413,
		code: "inventory_too_large",
	});
});

it("rejects a request with no machine token", async () => {
	const { env } = await seedEnv();

	await expect(
		handlePutInventory(
			new Request("https://api.test/machine/inventory", {
				method: "PUT",
				body: JSON.stringify(DOC),
			}),
			env,
		),
	).rejects.toMatchObject({ status: 401 });
});

it("writes only the reporting machine's row", async () => {
	const { env, userId } = await seedEnv();
	const reporter = await createMachineToken(env.DB, userId, "laptop");
	const bystander = await createMachineToken(env.DB, userId, "desktop");

	await handlePutInventory(put(reporter.token, DOC), env);

	// A token that could write another machine's row would make the Machines
	// page unable to say who reported what.
	expect(await getMachineInventory(env.DB, userId, bystander.id)).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @onlooker/api test -- machine-inventory`
Expected: FAIL — handler not found.

- [ ] **Step 3: Implement the handler**

```ts
import { putMachineInventory } from "../db/machine-inventory.js";
import { requireMachineToken } from "../middleware/machine-auth.js";
import type { WorkerEnv } from "../types";
import { ApiError } from "../types";

/** Generous against the ~22 KB a 28-plugin machine produces, bounded against a runaway. */
const MAX_INVENTORY_BYTES = 256 * 1024;
const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * A machine may describe itself.
 *
 * `machines.ts` states that machine management is browser-authenticated so a
 * stolen token cannot mint successors. That rule governs minting and
 * enumerating. This route does neither: the token names exactly one machine,
 * the write targets only that machine's own row, and nothing here can read or
 * name another.
 */
export async function handlePutInventory(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const { machineId } = await requireMachineToken(request, env);

	const raw = await request.text();
	if (raw.length > MAX_INVENTORY_BYTES) {
		throw new ApiError(413, "inventory_too_large", "Inventory document is too large");
	}

	let body: { schema_version?: unknown; plugins?: unknown };
	try {
		body = JSON.parse(raw);
	} catch {
		throw new ApiError(400, "invalid_inventory", "Inventory must be JSON");
	}

	if (body.schema_version !== SUPPORTED_SCHEMA_VERSION) {
		throw new ApiError(
			400,
			"unsupported_schema_version",
			`Inventory schema_version must be ${SUPPORTED_SCHEMA_VERSION}`,
		);
	}
	if (!Array.isArray(body.plugins)) {
		throw new ApiError(400, "invalid_inventory", "Inventory needs a plugins array");
	}

	// Stored verbatim. The server does not read inside the document, so
	// re-serializing it would only introduce a way for what is stored to
	// differ from what was sent.
	await putMachineInventory(env.DB, machineId, raw, new Date().toISOString());

	return Response.json({ ok: true });
}
```

Add to `router.ts`, in the machine-authenticated group beside `/lessons`:

```ts
	{
		method: "PUT",
		path: "/machine/inventory",
		handler: handlePutInventory,
	},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @onlooker/api test -- machine-inventory`
Expected: PASS, all six.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/machine-inventory.ts apps/api/src/routes/index.ts apps/api/src/router.ts apps/api/src/routes/machine-inventory.test.ts
git commit -m "feat(api): let a machine report what it runs :satellite:"
```

---

### Task 7: `GET /api/machines/:id/inventory`

**Files:**
- Modify: `apps/api/src/routes/machine-inventory.ts`
- Modify: `apps/api/src/routes/index.ts`, `apps/api/src/router.ts`
- Modify: `apps/api/src/routes/machine-inventory.test.ts`

**Interfaces:**
- Consumes: `requireAuth`, `getMachineInventory` (Task 5).
- Produces: `handleGetInventory(request, env, params): Promise<Response>` returning `{ inventory, inventory_at }`.

- [ ] **Step 1: Write the failing tests**

```ts
const get = (id: string, session: string) =>
	new Request(`https://api.test/api/machines/${id}/inventory`, {
		headers: { Cookie: `session=${session}` },
	});

it("returns the stored document to its owner", async () => {
	const { env, userId, session } = await seedEnv();
	const m = await createMachineToken(env.DB, userId, "laptop");
	await putMachineInventory(env.DB, m.id, JSON.stringify(DOC), "2026-09-11T00:00:00.000Z");

	const response = await handleGetInventory(get(m.id, session), env, { id: m.id });

	expect(response.status).toBe(200);
	// An object, not the stored string - every other route answers in objects.
	expect(await response.json()).toEqual({
		inventory: DOC,
		inventory_at: "2026-09-11T00:00:00.000Z",
	});
});

it("404s a machine that has never reported", async () => {
	const { env, userId, session } = await seedEnv();
	const m = await createMachineToken(env.DB, userId, "laptop");

	await expect(
		handleGetInventory(get(m.id, session), env, { id: m.id }),
	).rejects.toMatchObject({ status: 404 });
});

it("404s another account's machine rather than 403", async () => {
	const { env, userId } = await seedEnv();
	const other = await seedEnv(env);
	const m = await createMachineToken(env.DB, userId, "laptop");
	await putMachineInventory(env.DB, m.id, JSON.stringify(DOC), "2026-09-11T00:00:00.000Z");

	// 403 would confirm the id exists - the existence oracle over other
	// users' rows that handleRevokeMachine already refuses to be.
	await expect(
		handleGetInventory(get(m.id, other.session), env, { id: m.id }),
	).rejects.toMatchObject({ status: 404 });
});

it("rejects a machine token on this browser route", async () => {
	const { env, userId } = await seedEnv();
	const m = await createMachineToken(env.DB, userId, "laptop");

	await expect(
		handleGetInventory(
			new Request(`https://api.test/api/machines/${m.id}/inventory`, {
				headers: { Authorization: `Bearer ${m.token}` },
			}),
			env,
			{ id: m.id },
		),
	).rejects.toMatchObject({ status: 401 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @onlooker/api test -- machine-inventory`
Expected: FAIL — handler not found.

- [ ] **Step 3: Implement**

```ts
export async function handleGetInventory(
	request: Request,
	env: WorkerEnv,
	params: RouteParams,
): Promise<Response> {
	const { userId } = await requireAuth(request, env);

	const found = await getMachineInventory(env.DB, userId, params.id);
	if (!found) {
		throw new ApiError(404, "not_found", "This machine has not reported an inventory");
	}

	// Parsed rather than passed through as a string, so the client receives an
	// object like every other route's body.
	return Response.json({
		inventory: JSON.parse(found.inventory) as unknown,
		inventory_at: found.inventory_at,
	});
}
```

Router entry, beside the other `/api/machines` routes:

```ts
	{
		method: "GET",
		path: "/api/machines/:id/inventory",
		handler: handleGetInventory,
	},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @onlooker/api test`
Expected: PASS, whole API suite.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes apps/api/src/router.ts
git commit -m "feat(api): serve one machine's inventory to its owner :mag:"
```

---

### Task 8: Contract cases and the web mock

**Files:**
- Modify: `packages/api-contract/src/index.ts`
- Modify: `apps/web/src/api/mockApi.ts`

**Interfaces:**
- Consumes: Tasks 6 and 7's routes.
- Produces: contract cases both the real API and the mock satisfy.

- [ ] **Step 1: Add the failing contract cases**

```ts
		{
			name: "machines list carries an inventory summary, never the document",
			path: "/api/machines",
			init: { method: "GET" },
			status: 200,
			body: { machines: expectArray },
			// `scopes` appears only inside a full inventory document. Its
			// presence in a list response means the split collapsed and every
			// machine's whole inventory is riding along.
			forbidden: [...NO_SECRETS, "token_hash", "onlk_", "scopes"],
		},
		{
			name: "an unreported machine has no inventory",
			path: "/api/machines/nonexistent/inventory",
			init: { method: "GET" },
			status: 404,
			forbidden: NO_SECRETS,
		},
		{
			name: "an inventory with an unknown schema_version is rejected",
			path: "/machine/inventory",
			init: { method: "PUT", body: JSON.stringify({ schema_version: 99, plugins: [] }) },
			status: 400,
		},
```

- [ ] **Step 2: Run the contract suite to verify it fails**

Run: `pnpm --filter @onlooker/api test -- contract && pnpm --filter @onlooker/web test -- contract`
Expected: FAIL on the web side — the mock has no `/api/machines/:id/inventory` and no `/machine/inventory`.

- [ ] **Step 3: Teach the mock both routes**

In `mockApi.ts`, extend `MockMachine` and add both routes beside the existing `/api/machines` handlers (around line 774):

```ts
interface MockMachine {
	// ...existing fields
	inventory?: unknown;
	inventory_at?: string | null;
}
```

```ts
	if (poolPath === "/api/machines" && (options.method ?? "GET") === "GET") {
		// The count, never the document - same split the real route makes.
		return json({
			machines: machinesOf(email).map(({ inventory, ...m }) => ({
				...m,
				inventory_at: m.inventory_at ?? null,
				plugin_count: Array.isArray((inventory as { plugins?: unknown[] })?.plugins)
					? (inventory as { plugins: unknown[] }).plugins.length
					: null,
			})),
		});
	}

	if (poolPath.endsWith("/inventory") && (options.method ?? "GET") === "GET") {
		const id = poolPath.slice("/api/machines/".length, -"/inventory".length);
		const machine = machinesOf(email).find((m) => m.id === id);
		if (!machine?.inventory || !machine.inventory_at) {
			return json({ error: "not_found" }, 404);
		}
		return json({ inventory: machine.inventory, inventory_at: machine.inventory_at });
	}

	if (poolPath === "/machine/inventory" && options.method === "PUT") {
		const body = JSON.parse(String(options.body ?? "{}"));
		if (body.schema_version !== 1) {
			return json({ error: "unsupported_schema_version" }, 400);
		}
		if (!Array.isArray(body.plugins)) {
			return json({ error: "invalid_inventory" }, 400);
		}
		return json({ ok: true });
	}
```

Use the `json()` helper throughout — not a raw `Response`. Five raw sites in this file already send JSON with no `Content-Type`, which is what `onlooker-jws` tracks; these must not become the sixth through tenth.

Order matters: the `/inventory` check must come **before** the existing `poolPath.startsWith("/api/machines/")` DELETE branch, or a detail path will fall into machine revocation.

- [ ] **Step 4: Run both suites**

Run: `pnpm --filter @onlooker/api test && pnpm --filter @onlooker/web test`
Expected: PASS on both sides of the contract.

- [ ] **Step 5: Commit**

```bash
git add packages/api-contract/src/index.ts apps/web/src/api/mockApi.ts
git commit -m "test(contract): pin the inventory split on both sides :handshake:"
```

---

### Task 9: CLI client method and sync wiring

This is the task the trigger decision rests on. The report must be attempted on a path where there are no lessons to send.

**Files:**
- Modify: `apps/cli/src/api.ts`
- Modify: `apps/cli/src/commands/sync.ts`
- Modify: `apps/cli/src/__tests__/sync.test.ts`

**Interfaces:**
- Consumes: `collectInventory` (Task 2), `PUT /machine/inventory` (Task 6).
- Produces: `ApiClient.reportInventory(inventory: unknown): Promise<void>` — `unknown` rather than `Inventory`, matching the existing `push(lessons: unknown[])`, so `api.ts` stays a transport module that does not import the collector's types.

- [ ] **Step 1: Write the failing tests**

```ts
it("reports the inventory even when there are no lessons to send", async () => {
	const env = linked();
	// No lessons anywhere - the path that returns before createClient today.
	const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });

	const out = await sync({ env, fetchImpl });

	const paths = fetchImpl.mock.calls.map(([url]) => String(url));
	expect(paths.some((p) => p.endsWith("/machine/inventory"))).toBe(true);
	// And it still says what it said before about lessons.
	expect(out).toContain("Nothing to sync");
});

it("still pushes lessons when the inventory report fails", async () => {
	const env = linked();
	withLessons(env, 1);
	const fetchImpl = vi.fn().mockImplementation(async (url) => {
		if (String(url).endsWith("/machine/inventory")) {
			return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
		}
		return { ok: true, status: 200, json: async () => ({ results: [{ id: "l", outcome: "created" }] }) };
	});

	const out = await sync({ env, fetchImpl });

	expect(out).toContain("1 lesson");
});

it("never swallows a failed report", async () => {
	const env = linked();
	withLessons(env, 1);
	const fetchImpl = vi.fn().mockImplementation(async (url) =>
		String(url).endsWith("/machine/inventory")
			? { ok: false, status: 500, json: async () => ({}) }
			: { ok: true, status: 200, json: async () => ({ results: [{ id: "l", outcome: "created" }] }) },
	);

	const out = await sync({ env, fetchImpl });

	// Exiting 0 with the page quietly stale is the failure this asserts against.
	expect(out.toLowerCase()).toContain("inventory");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @onlooker/cli test -- sync`
Expected: FAIL — no request to `/machine/inventory` is made at all.

- [ ] **Step 3: Add the client method**

In `api.ts`, extend `ApiClient` and the returned object:

```ts
	/** Replace this machine's reported inventory. Idempotent. */
	reportInventory(inventory: unknown): Promise<void>;
```

```ts
		reportInventory: async (inventory) => {
			await call("/machine/inventory", {
				method: "PUT",
				body: JSON.stringify(inventory),
			});
		},
```

- [ ] **Step 4: Move the report above the lesson paths**

In `sync.ts`, immediately after the `machineToken` guard and **before** `discoverApproved`:

```ts
	const client = createClient(config.apiBaseUrl, config.machineToken, fetchImpl);

	// Before the lesson paths, not after. Every no-lessons path below returns
	// without touching the network, and every machine is on one of them while
	// the pool is empty - so a report attached to the push would never fire for
	// the machines whose page is emptiest.
	const inventoryNote = await reportInventory(client, env);
```

with a helper in the same file:

```ts
/**
 * Report the inventory, and describe the outcome rather than throwing.
 *
 * Non-fatal because a reporting failure must not cost a lesson push. Never
 * silent because an inventory that quietly stops updating while the command
 * exits 0 is the successful-looking silence this codebase keeps finding.
 * Collection and transport failures read differently on purpose: one is a
 * local problem and the other is not.
 */
async function reportInventory(
	client: ApiClient,
	env: NodeJS.ProcessEnv,
): Promise<string | null> {
	const collected = collectInventory({ cwd: process.cwd(), env });
	if (collected.kind === "unavailable") {
		return `Inventory not reported: ${collected.reason}`;
	}
	try {
		await client.reportInventory(collected.inventory);
		return null;
	} catch (error) {
		return `Inventory not reported: ${(error as Error).message}`;
	}
}
```

Then append `inventoryNote` to every return path's message — including each early return — so the note travels with whatever sync was going to say anyway.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @onlooker/cli test`
Expected: PASS, whole CLI suite. Pre-existing sync tests that assert an exact return string will need the note appended; that is the behavior change, not a broken test.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/api.ts apps/cli/src/commands/sync.ts apps/cli/src/__tests__/sync.test.ts
git commit -m "feat(cli): report the inventory before the lessons, not after :arrow_up:"
```

---

### Task 10: Render the inventory on the Machines page

**Files:**
- Modify: `apps/web/src/pages/MachinesPage.tsx`
- Modify: `apps/web/src/api/` client module (wherever `listMachines` lives)
- Test: `apps/web/src/pages/__tests__/MachinesPage.test.tsx` (follow the existing location)

**Interfaces:**
- Consumes: Tasks 7 and 8.
- Produces: `getMachineInventory(id): Promise<{ inventory: Inventory; inventory_at: string }>` in the web API client.

- [ ] **Step 1: Write the failing tests**

```tsx
it("shows a machine that has never reported as never reported", async () => {
	// plugin_count null, inventory_at null -> "Never reported", NOT "0 plugins"
});

it("shows the plugin count and when it was reported", async () => {
	// plugin_count 28 -> "28 plugins", and the inventory_at timestamp rendered
});

it("lists each scope a plugin is installed at, with its own version", async () => {
	// librarian at 0.18.1 (user) and 0.18.0 (~/src/ecosystem) -> both visible
});

it("marks an installed-but-not-enabled plugin as inert", async () => {
	// enabled false -> a visible distinction from enabled true
});

it("says unknown where enablement could not be determined", async () => {
	// enabled null -> neither "enabled" nor "disabled"
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @onlooker/web test -- MachinesPage`
Expected: FAIL — no inventory rendering exists.

- [ ] **Step 3: Implement**

Add to the web API client, beside the existing machines calls:

```ts
export async function getMachineInventory(
	id: string,
): Promise<{ inventory: Inventory; inventory_at: string }> {
	return request(`/api/machines/${encodeURIComponent(id)}/inventory`);
}
```

In `MachinesPage`, the summary line per machine:

```tsx
{machine.inventory_at === null ? (
	// Not "0 plugins". "Nothing installed" and "never told us" are
	// different claims, and only one of them is knowable from here.
	<span className="machine-inventory-empty">Never reported</span>
) : (
	<span className="machine-inventory-summary">
		{machine.plugin_count} {machine.plugin_count === 1 ? "plugin" : "plugins"}
		{" · reported "}
		<time dateTime={machine.inventory_at}>
			{formatTimestamp(machine.inventory_at)}
		</time>
	</span>
)}
```

And the expanded detail, one row per scope:

```tsx
{inventory.plugins.map((plugin) => (
	<li key={plugin.id}>
		<h4>{plugin.id}</h4>
		<ul>
			{plugin.scopes.map((scope) => (
				<li key={`${plugin.id}:${scope.scope}`}>
					<code>{scope.version}</code>
					<span>{scope.scope}</span>
					{scope.git_commit_sha ? <code>{scope.git_commit_sha.slice(0, 7)}</code> : null}
					{/* Three states, not two. `null` is unknowable enablement -
					    a project other than the one that synced - and reading
					    it as "disabled" would invent a fact. */}
					<span>
						{scope.enabled === true
							? "enabled"
							: scope.enabled === false
								? "inert"
								: "unknown"}
					</span>
				</li>
			))}
		</ul>
	</li>
))}
```

Fetch the full document on expand rather than with the list, matching the split Task 7 built. Reuse whatever loading and error handling the page already uses for its machines list rather than inventing a second pattern — and note that `onlooker-bcn` proposes extracting that lifecycle into a hook, so keep the new state minimal rather than adding a fourth copy of it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @onlooker/web test`
Expected: PASS, whole web suite.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): let the machines page say what each machine runs :desktop_computer:"
```

---

## Final verification

- [ ] `pnpm test` — every package.
- [ ] `pnpm lint && pnpm typecheck`.
- [ ] Apply the migration locally and exercise the real path end to end:

```bash
pnpm --filter @onlooker/api exec wrangler d1 migrations apply onlooker-db-local --local --env development
```

Then run `onlooker sync` against the local API from a linked machine and confirm the Machines page shows the inventory — including from a directory with no lessons, which is the case the whole trigger decision exists for.

- [ ] `bd close onlooker-sbgh` once merged.
