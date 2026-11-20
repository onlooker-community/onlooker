# Web home page, PR 2: the Plugins panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Plugins panel to `/home`. It says what each Onlooker plugin did across the last 7 days, failures first, and names the installed Onlooker plugins that sent no events.

**Architecture:** Plugin activity is summed from the same windowed session rows the Recent sessions panel already uses, so no new API. `pluginActivity`'s per-plugin classification is pulled out as `pluginTallies` so a week can be summed from raw counts rather than from per-session strings. What is installed comes from each reporting machine's inventory (`listMachines`, then `getMachineInventory` per machine). `HomePage` computes the windowed rows once and shares the loading and failed states through one small helper, as PR 1's final review asked.

**Tech Stack:** React 18, react-router 6, Vitest + Testing Library (jsdom), Biome, `@onlooker-community/schema` 3.8.0 (`event-roles` subpath).

**Spec:** `docs/superpowers/specs/2026-11-18-web-home-dashboard-design.md`, section "Plugins".

## Global Constraints

- Work in the worktree `/Users/meaganwaller/src/github.com/onlooker-community/onlooker-onl-298-plugins`, branch `meagan/onl-298-home-plugins`.
- Edit tracked files with the Edit/Write tools, never `sed -i` or heredocs. Never run a formatter that writes (`biome check --write`, `pnpm lint:fix`); check with `pnpm --filter @onlooker/web lint` and fix by hand. Tabs for indentation.
- One test file: `pnpm --filter @onlooker/web test <name>` — the name straight after `test`, with **no `--`**.
- Test files that render or compute dates start with `process.env.TZ = "UTC";` before any import.
- Import the schema only from `@onlooker-community/schema/event-roles`, never the package root (the root loads `node:fs`).
- Only inventory ids ending in `@onlooker-community` count; the plugin name is the part before the last `@`.
- A plugin counts as installed when some reporting machine has a scope with `enabled` true or null.
- A machine reports when `revoked_at`, `removed_at` are null and `inventory_at` is not null.
- Wording is "no events", never "broken" or "failed" for a quiet plugin.
- If any inventory request fails, the silent line says it couldn't check and lists nothing.
- If the week is capped (`complete` false), the silent line lists nothing, because an unread session may hold a plugin's events.
- A plugin the schema names no events of its own for (no non-`observed` type with its prefix, e.g. `ecosystem`) is never listed as silent.
- The Plugins panel's footer link text is `Plugin activity per session`, to `/sessions` (a second "All sessions" link on the page would read the same to a screen reader).
- Commits through `/git-workflow:commit`, or mirroring its contract: stage files by name, `<type>(<scope>): <subject> :emoji:` ≤72 chars, why-focused body wrapped at 80, American English, `Refs ONL-298`, never `--no-verify`.
- The full web suite prints a pre-existing jsdom "a page render throw" stack on stderr. It is not a failure.

## Files

- Modify `apps/web/src/lib/pluginActivity.ts` — export `PluginTally` and `pluginTallies`; `pluginActivity` uses it.
- Create `apps/web/src/lib/pluginRollup.ts` — `rollupPlugins`, `describePluginWeek`.
- Create `apps/web/src/lib/installedPlugins.ts` — `reportingMachines`, `installedOnlookerPlugins`, `silentPlugins`.
- Create `apps/web/src/lib/load.ts` — the `Load<T>` type, moved out of `HomePage`.
- Create `apps/web/src/components/HomePluginsPanel.tsx`.
- Modify `apps/web/src/pages/HomePage.tsx`.
- Modify `packages/brand/index.ts` — `"Plug"` in `UNPLATED_ICONS`.
- Tests: `apps/web/src/__tests__/plugin-activity.test.ts` (extend), `plugin-rollup.test.ts`, `installed-plugins.test.ts`, `home-plugins-panel.test.tsx`, `home-page.test.tsx` (extend).

---

### Task 1: Split per-plugin tallies out of `pluginActivity`

**Files:**
- Modify: `apps/web/src/lib/pluginActivity.ts`
- Test: `apps/web/src/__tests__/plugin-activity.test.ts`

**Interfaces:**
- Produces: `export interface PluginTally { output: number; skipped: number; failed: number; lifecycle: number; unknown: number }` and `export function pluginTallies(countsByType: Record<string, number>): Map<string, PluginTally>` from `../lib/pluginActivity`. Observed events are left out. An empty input returns an empty Map.

- [ ] **Step 1: Write the failing test** — append inside the file, after the existing `describe("pluginActivity", …)` block:

```ts
describe("pluginTallies", () => {
	// The week's rollup sums these across sessions, so they must be the raw
	// counts per role, not the per-session strings pluginActivity formats.
	it("counts each plugin's events by role, leaving observed out", () => {
		const tallies = pluginTallies({
			"historian.retrieval.surfaced": 3,
			"historian.retrieval.started": 5,
			"historian.embedder.failed": 2,
			"tribunal.gate.skipped": 4,
			"tool.file.read": 40,
			"someplugin.new.thing": 1,
		});

		expect(Object.fromEntries(tallies)).toEqual({
			historian: { output: 3, skipped: 0, failed: 2, lifecycle: 5, unknown: 0 },
			tribunal: { output: 0, skipped: 4, failed: 0, lifecycle: 0, unknown: 0 },
			someplugin: { output: 0, skipped: 0, failed: 0, lifecycle: 0, unknown: 1 },
		});
	});

	it("is empty for a session with no per-type counts", () => {
		expect(pluginTallies({}).size).toBe(0);
	});
});
```

Change the file's import line to `import { pluginActivity, pluginTallies } from "../lib/pluginActivity";`.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @onlooker/web test plugin-activity`
Expected: FAIL — `pluginTallies` is not exported.

- [ ] **Step 3: Implement.** In `pluginActivity.ts`, rename `interface Tally` to `export interface PluginTally` (keep its body), and add this function above `pluginActivity`, moving the loop (and its two comments) out of `pluginActivity` into it:

```ts
/**
 * Each plugin's events by role, from one session's per-type counts. Observed
 * events are the harness rather than a plugin, so they are left out.
 *
 * Exported for the home page's week (lib/pluginRollup.ts), which sums these
 * across sessions: the strings pluginActivity formats cannot be added up.
 */
export function pluginTallies(
	countsByType: Record<string, number>,
): Map<string, PluginTally> {
	// A Map rather than an object literal: the plugin segment is whatever the
	// event log carried, and "__proto__" or "constructor" would read through
	// Object.prototype on a plain object.
	const tallies = new Map<string, PluginTally>();
	for (const [type, count] of Object.entries(countsByType)) {
		const role = roleOf(type);
		// The harness rather than a plugin - see the role's definition in the
		// schema.
		if (role === "observed") continue;

		const plugin = pluginOf(type);
		const tally = tallies.get(plugin) ?? {
			output: 0,
			skipped: 0,
			failed: 0,
			lifecycle: 0,
			unknown: 0,
		};
		tally[role ?? "unknown"] += count;
		tallies.set(plugin, tally);
	}
	return tallies;
}
```

`pluginActivity` then begins:

```ts
	if (Object.keys(countsByType).length === 0) return null;

	const all = [...pluginTallies(countsByType).entries()];
```

and keeps everything from its `// Output is the stronger statement` comment onward unchanged.

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm --filter @onlooker/web test plugin-activity`
Expected: PASS, every existing `pluginActivity` test included. Then `pnpm --filter @onlooker/web test sessions-page` — PASS (the Sessions page is `pluginActivity`'s caller).

- [ ] **Step 5: Commit** `apps/web/src/lib/pluginActivity.ts` and the test: `refactor(web): expose each plugin's tallies before formatting`.

---

### Task 2: Sum a week of plugin activity

**Files:**
- Create: `apps/web/src/lib/pluginRollup.ts`
- Test: `apps/web/src/__tests__/plugin-rollup.test.ts`

**Interfaces:**
- Consumes: `pluginTallies`, `PluginTally` (Task 1).
- Produces:
  - `export interface PluginWeek extends PluginTally { plugin: string; sessions: number }` — `sessions` is how many sessions carried any non-observed event of this plugin.
  - `export interface PluginRollup { rows: PluginWeek[]; unclassified: string[] }`
  - `export function rollupPlugins(sessions: SessionSummary[]): PluginRollup`
  - `export function describePluginWeek(week: PluginWeek): string` — the row text after `"<plugin>: "`.

- [ ] **Step 1: Write the failing test** `apps/web/src/__tests__/plugin-rollup.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../api/sessionsApi";
import { describePluginWeek, rollupPlugins } from "../lib/pluginRollup";

function session(counts_by_type: Record<string, number>): SessionSummary {
	return {
		session_id: "s",
		machine_id: "m1",
		started_at: "2026-11-18T10:00:00Z",
		ended_at: "2026-11-18T11:00:00Z",
		event_count: 1,
		counts_by_prefix: {},
		counts_by_type,
		counts_by_project: {},
		plugins: [],
		prompts: 1,
		compactions: 0,
	};
}

describe("rollupPlugins", () => {
	it("sums each plugin across sessions and counts the sessions it ran in", () => {
		const { rows } = rollupPlugins([
			session({ "historian.retrieval.surfaced": 3 }),
			session({ "historian.retrieval.surfaced": 2, "bursar.session.recorded": 1 }),
			session({ "tool.file.read": 9 }),
		]);

		expect(rows.map((r) => [r.plugin, r.output, r.sessions])).toEqual([
			["historian", 5, 2],
			["bursar", 1, 1],
		]);
	});

	// Failures are the thing a week's summary most needs to say, so they lead
	// whatever else the plugin did.
	it("puts plugins with failures first, most failures first", () => {
		const { rows } = rollupPlugins([
			session({
				"historian.retrieval.surfaced": 40,
				"scribe.distill.errored": 1,
				"governor.ledger.write_failed": 3,
			}),
		]);

		expect(rows.map((r) => r.plugin)).toEqual(["governor", "scribe", "historian"]);
	});

	it("orders by output, then by name", () => {
		const { rows } = rollupPlugins([
			session({
				"bursar.session.recorded": 2,
				"lineage.change.recorded": 2,
				"historian.retrieval.surfaced": 9,
			}),
		]);

		expect(rows.map((r) => r.plugin)).toEqual(["historian", "bursar", "lineage"]);
	});

	// A plugin newer than this build would otherwise vanish from the panel.
	it("names a plugin whose every type is unknown under unclassified", () => {
		const rollup = rollupPlugins([session({ "someplugin.new.thing": 2 })]);

		expect(rollup.rows).toEqual([]);
		expect(rollup.unclassified).toEqual(["someplugin"]);
	});

	it("skips sessions from a CLI that sent no per-type counts", () => {
		expect(rollupPlugins([session({})])).toEqual({ rows: [], unclassified: [] });
	});
});

describe("describePluginWeek", () => {
	const week = (over: Partial<Parameters<typeof describePluginWeek>[0]>) =>
		describePluginWeek({
			plugin: "p",
			sessions: 1,
			output: 0,
			skipped: 0,
			failed: 0,
			lifecycle: 0,
			unknown: 0,
			...over,
		});

	it("says what a plugin produced and in how many sessions", () => {
		expect(week({ output: 41, sessions: 18 })).toBe("produced 41 in 18 sessions");
	});

	it("leads with failures, beside output", () => {
		expect(week({ failed: 3, output: 12, sessions: 4 })).toBe(
			"3 failed · produced 12 in 4 sessions",
		);
		expect(week({ failed: 1, lifecycle: 2 })).toBe("1 failed in 1 session");
	});

	// "produced 0" reads as a fault; a plugin that ran and found nothing did
	// its job.
	it("says found nothing or skipped rather than produced 0", () => {
		expect(week({ lifecycle: 4, sessions: 2 })).toBe("found nothing in 2 sessions");
		expect(week({ skipped: 4, sessions: 4 })).toBe("skipped in 4 sessions");
	});
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @onlooker/web test plugin-rollup`
Expected: FAIL — cannot find module `../lib/pluginRollup`.

- [ ] **Step 3: Implement** `apps/web/src/lib/pluginRollup.ts`:

```ts
/**
 * A week of plugin activity for the home page's Plugins panel (ONL-298).
 *
 * Summed from each session's per-type counts through pluginTallies, the same
 * classification the Sessions page's rows use, so the two pages agree about
 * what a plugin did. Sessions from a CLI older than 2.12.0 carry no per-type
 * counts and add nothing here.
 */

import type { SessionSummary } from "../api/sessionsApi";
import { type PluginTally, pluginTallies } from "./pluginActivity";
import { plural } from "./sessionRollup";

export interface PluginWeek extends PluginTally {
	plugin: string;
	/** Sessions that carried any non-observed event of this plugin. */
	sessions: number;
}

export interface PluginRollup {
	/** Failures first, most first; then output, largest first; then name. */
	rows: PluginWeek[];
	/**
	 * Plugins whose every type is unknown to the schema this app was built
	 * with - a plugin newer than the web app. Named so it does not vanish.
	 */
	unclassified: string[];
}

const byName = (a: string, b: string) => a.localeCompare(b);

function isUnclassified(week: PluginWeek): boolean {
	return (
		week.unknown > 0 &&
		week.output === 0 &&
		week.skipped === 0 &&
		week.lifecycle === 0 &&
		week.failed === 0
	);
}

export function rollupPlugins(sessions: SessionSummary[]): PluginRollup {
	const weeks = new Map<string, PluginWeek>();
	for (const session of sessions) {
		for (const [plugin, tally] of pluginTallies(session.counts_by_type)) {
			const week = weeks.get(plugin) ?? {
				plugin,
				sessions: 0,
				output: 0,
				skipped: 0,
				failed: 0,
				lifecycle: 0,
				unknown: 0,
			};
			week.sessions += 1;
			week.output += tally.output;
			week.skipped += tally.skipped;
			week.failed += tally.failed;
			week.lifecycle += tally.lifecycle;
			week.unknown += tally.unknown;
			weeks.set(plugin, week);
		}
	}

	const all = [...weeks.values()];
	return {
		rows: all
			.filter((week) => !isUnclassified(week))
			.sort(
				(a, b) =>
					b.failed - a.failed ||
					b.output - a.output ||
					byName(a.plugin, b.plugin),
			),
		unclassified: all
			.filter(isUnclassified)
			.map((week) => week.plugin)
			.sort(byName),
	};
}

/** One row's text after the plugin's name: "3 failed · produced 12 in 4 sessions". */
export function describePluginWeek(week: PluginWeek): string {
	const parts: string[] = [];
	if (week.failed > 0) parts.push(`${week.failed} failed`);
	if (week.output > 0) parts.push(`produced ${week.output}`);
	// Only when there is nothing stronger to say: "produced 0" would read as
	// a fault for a plugin that ran and had nothing to do.
	else if (week.failed === 0)
		parts.push(week.skipped > 0 ? "skipped" : "found nothing");
	return `${parts.join(" · ")} in ${plural(week.sessions, "session")}`;
}
```

Check `plural` in `lib/sessionRollup.ts` returns `"1 session"` / `"4 sessions"` (HomeSessionsPanel uses it that way). If its signature differs, adapt the call, not the expected strings.

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm --filter @onlooker/web test plugin-rollup`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit** both files: `feat(web): sum a week of plugin activity`.

---

### Task 3: Work out which installed plugins were silent

**Files:**
- Create: `apps/web/src/lib/installedPlugins.ts`
- Test: `apps/web/src/__tests__/installed-plugins.test.ts`

**Interfaces:**
- Consumes: `Machine`, `Inventory` from `../api/machinesApi`; `SessionSummary` from `../api/sessionsApi`; `EVENT_TYPE_ROLES` from `@onlooker-community/schema/event-roles`.
- Produces:
  - `export function reportingMachines(machines: Machine[]): Machine[]`
  - `export function installedOnlookerPlugins(inventories: Inventory[]): string[]` (sorted, unique)
  - `export function silentPlugins(installed: string[], sessions: SessionSummary[]): string[]` (keeps `installed`'s order)

- [ ] **Step 1: Write the failing test** `apps/web/src/__tests__/installed-plugins.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Inventory, Machine } from "../api/machinesApi";
import type { SessionSummary } from "../api/sessionsApi";
import {
	installedOnlookerPlugins,
	reportingMachines,
	silentPlugins,
} from "../lib/installedPlugins";

function machine(over: Partial<Machine>): Machine {
	return {
		id: "m",
		name: "m",
		created_at: "2026-11-01T00:00:00Z",
		last_used_at: null,
		revoked_at: null,
		removed_at: null,
		inventory_at: "2026-11-18T00:00:00Z",
		plugin_count: 1,
		org_id: null,
		...over,
	};
}

function inventory(
	plugins: { id: string; enabled: (boolean | null)[] }[],
): Inventory {
	return {
		schema_version: 1,
		collected_at: "2026-11-18T00:00:00Z",
		project: null,
		plugins: plugins.map((p) => ({
			id: p.id,
			scopes: p.enabled.map((enabled) => ({
				scope: "user",
				version: "1.0.0",
				git_commit_sha: null,
				installed_at: null,
				last_updated: null,
				enabled,
			})),
		})),
	};
}

function session(over: Partial<SessionSummary>): SessionSummary {
	return {
		session_id: "s",
		machine_id: "m1",
		started_at: "2026-11-18T10:00:00Z",
		ended_at: "2026-11-18T11:00:00Z",
		event_count: 1,
		counts_by_prefix: {},
		counts_by_type: {},
		counts_by_project: {},
		plugins: [],
		prompts: 1,
		compactions: 0,
		...over,
	};
}

describe("reportingMachines", () => {
	it("keeps machines that are live and have reported an inventory", () => {
		const kept = reportingMachines([
			machine({ id: "ok" }),
			machine({ id: "revoked", revoked_at: "2026-11-02T00:00:00Z" }),
			machine({ id: "removed", removed_at: "2026-11-02T00:00:00Z" }),
			machine({ id: "never", inventory_at: null }),
		]);

		expect(kept.map((m) => m.id)).toEqual(["ok"]);
	});
});

describe("installedOnlookerPlugins", () => {
	it("names Onlooker plugins by the part before the @, once each", () => {
		expect(
			installedOnlookerPlugins([
				inventory([
					{ id: "historian@onlooker-community", enabled: [true] },
					{ id: "superpowers@superpowers-dev", enabled: [true] },
				]),
				inventory([{ id: "historian@onlooker-community", enabled: [true] }]),
				inventory([{ id: "counsel@onlooker-community", enabled: [true] }]),
			]),
		).toEqual(["counsel", "historian"]);
	});

	// Null is the CLI saying it could not tell; dropping it would hide a plugin
	// that may well be on.
	it("counts a plugin enabled in any scope, or unknowably enabled", () => {
		expect(
			installedOnlookerPlugins([
				inventory([
					{ id: "customs@onlooker-community", enabled: [false, null] },
					{ id: "warden@onlooker-community", enabled: [false] },
				]),
			]),
		).toEqual(["customs"]);
	});
});

describe("silentPlugins", () => {
	it("names installed plugins no session in the week heard from", () => {
		expect(
			silentPlugins(
				["counsel", "historian", "warden"],
				[
					session({ counts_by_prefix: { historian: 3, tool: 9 } }),
					session({ plugins: ["warden"] }),
				],
			),
		).toEqual(["counsel"]);
	});

	// ecosystem is infrastructure: the schema has no event of its own for it,
	// so "no events this week" would be true every week and say nothing.
	it("never names a plugin the schema has no events for", () => {
		expect(silentPlugins(["ecosystem", "counsel"], [])).toEqual(["counsel"]);
	});
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @onlooker/web test installed-plugins`
Expected: FAIL — cannot find module `../lib/installedPlugins`.

- [ ] **Step 3: Implement** `apps/web/src/lib/installedPlugins.ts`:

```ts
/**
 * Which Onlooker plugins are installed, and which of them were silent, for
 * the home page's Plugins panel (ONL-298).
 *
 * Imported from the schema's `event-roles` subpath, never its root: the root
 * re-exports the validator, which loads node:fs and cannot run in a browser.
 */

import { EVENT_TYPE_ROLES } from "@onlooker-community/schema/event-roles";
import type { Inventory, Machine } from "../api/machinesApi";
import type { SessionSummary } from "../api/sessionsApi";

/** Plugins from any other marketplace never emit Onlooker events. */
const ONLOOKER_MARKETPLACE = "onlooker-community";

/**
 * Plugins the schema names an event of their own for. A plugin outside this
 * set, like ecosystem, never emits under its own name, so "no events this
 * week" would be true of it every week.
 */
const EMITTERS = new Set(
	Object.entries(EVENT_TYPE_ROLES)
		.filter(([, role]) => role !== "observed")
		.map(([type]) => type.slice(0, type.indexOf("."))),
);

/** Machines whose inventory can say what is installed: live, and reported. */
export function reportingMachines(machines: Machine[]): Machine[] {
	return machines.filter(
		(machine) =>
			machine.revoked_at === null &&
			machine.removed_at === null &&
			machine.inventory_at !== null,
	);
}

/**
 * Onlooker plugins on in some scope of some machine, by bare name. `enabled`
 * null counts: the CLI could not tell, and dropping it would hide a plugin
 * that may be on.
 */
export function installedOnlookerPlugins(inventories: Inventory[]): string[] {
	const names = new Set<string>();
	for (const inventory of inventories) {
		for (const plugin of inventory.plugins) {
			const at = plugin.id.lastIndexOf("@");
			if (at === -1 || plugin.id.slice(at + 1) !== ONLOOKER_MARKETPLACE)
				continue;
			if (plugin.scopes.some((scope) => scope.enabled !== false))
				names.add(plugin.id.slice(0, at));
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Installed plugins no session in `sessions` carried an event from. Heard is
 * read from counts_by_prefix and plugins, which every CLI version sends,
 * rather than counts_by_type, which older ones do not.
 */
export function silentPlugins(
	installed: string[],
	sessions: SessionSummary[],
): string[] {
	const heard = new Set<string>();
	for (const session of sessions) {
		for (const prefix of Object.keys(session.counts_by_prefix))
			heard.add(prefix);
		for (const plugin of session.plugins) heard.add(plugin);
	}
	return installed.filter((name) => EMITTERS.has(name) && !heard.has(name));
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm --filter @onlooker/web test installed-plugins`
Expected: PASS, 6 tests. If the `ecosystem` test fails because `EVENT_TYPE_ROLES` does carry an `ecosystem.*` type, stop and report NEEDS_CONTEXT with the type found; do not change the test.

- [ ] **Step 5: Commit** both files: `feat(web): name installed plugins that sent no events`.

---

### Task 4: The Plugins panel

**Files:**
- Create: `apps/web/src/components/HomePluginsPanel.tsx`
- Modify: `packages/brand/index.ts` (add `"Plug"` to `UNPLATED_ICONS`)
- Test: `apps/web/src/__tests__/home-plugins-panel.test.tsx`

**Interfaces:**
- Consumes: `rollupPlugins`, `describePluginWeek` (Task 2); `silentPlugins` (Task 3); `Panel` from `./ui`; `PALETTE` from `./palette`; `plural` from `../lib/sessionRollup`.
- Produces: `export type Installed = { kind: "loading" } | { kind: "failed" } | { kind: "loaded"; names: string[] }` and default `HomePluginsPanel({ sessions, complete, installed }: { sessions: SessionSummary[]; complete: boolean; installed: Installed })`.

Rendered contract (exact text):
- Panel title `Plugins`, icon `Plug`.
- No rows and no unclassified: `No plugin events in the last 7 days.` (muted).
- Capped (`complete` false) with rows: a muted line `From the most recent N sessions.` (via `plural`) above the list.
- Rows: a muted lead-in `This week` with an id, and a `<ul aria-labelledby>` (`data-testid="home-plugins"`); each `<li>` textContent is `<plugin>: <describePluginWeek>`, the plugin name in a `<span>`; a row with failures renders the `N failed` part in `PALETTE.danger`.
- Unclassified: `<p>` `Unclassified: a, b.`
- The silent line, `data-testid="home-plugins-silent"`, muted, always present:
  - loading: `Checking which plugins are installed…`
  - failed: `Couldn't check which plugins are installed.`
  - capped: `Not every session this week was loaded, so quiet plugins aren't listed.`
  - loaded, `names` empty: `No machine has reported its installed plugins.`
  - loaded, none silent: `Every installed Onlooker plugin sent events this week.`
  - loaded, some silent: `Installed, no events in 7 days: a, b.`
- Footer link `Plugin activity per session` → `/sessions`, styled as HomeSessionsPanel's footer.

- [ ] **Step 1: Write the failing test** `apps/web/src/__tests__/home-plugins-panel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../api/sessionsApi";
import HomePluginsPanel, { type Installed } from "../components/HomePluginsPanel";

function session(over: Partial<SessionSummary>): SessionSummary {
	return {
		session_id: "s",
		machine_id: "m1",
		started_at: "2026-11-18T10:00:00Z",
		ended_at: "2026-11-18T11:00:00Z",
		event_count: 1,
		counts_by_prefix: {},
		counts_by_type: {},
		counts_by_project: {},
		plugins: [],
		prompts: 1,
		compactions: 0,
		...over,
	};
}

const historianWeek = [
	session({
		counts_by_type: {
			"historian.retrieval.surfaced": 4,
			"governor.ledger.write_failed": 2,
		},
		counts_by_prefix: { historian: 4, governor: 2 },
	}),
];

function renderPanel(
	sessions: SessionSummary[],
	installed: Installed = { kind: "loaded", names: [] },
	complete = true,
) {
	return render(
		<MemoryRouter>
			<HomePluginsPanel
				sessions={sessions}
				complete={complete}
				installed={installed}
			/>
		</MemoryRouter>,
	);
}

const silentLine = () => screen.getByTestId("home-plugins-silent").textContent;

describe("HomePluginsPanel", () => {
	it("lists each plugin's week, failures first", () => {
		renderPanel(historianWeek);

		const list = screen.getByRole("list", { name: "This week" });
		expect(
			[...list.querySelectorAll("li")].map((li) => li.textContent),
		).toEqual([
			"governor: 2 failed in 1 session",
			"historian: produced 4 in 1 session",
		]);
	});

	it("says so when no plugin sent events", () => {
		renderPanel([]);
		expect(
			screen.getByText("No plugin events in the last 7 days."),
		).toBeDefined();
		expect(screen.queryByRole("list")).toBeNull();
	});

	it("names unclassified plugins rather than dropping them", () => {
		renderPanel([session({ counts_by_type: { "someplugin.new.thing": 1 } })]);
		expect(screen.getByText("Unclassified: someplugin.")).toBeDefined();
	});

	it("names installed plugins that sent no events", () => {
		renderPanel(historianWeek, {
			kind: "loaded",
			names: ["counsel", "ecosystem", "historian", "warden"],
		});
		expect(silentLine()).toBe("Installed, no events in 7 days: counsel, warden.");
	});

	it("says every installed plugin sent events when none were quiet", () => {
		renderPanel(historianWeek, { kind: "loaded", names: ["historian"] });
		expect(silentLine()).toBe(
			"Every installed Onlooker plugin sent events this week.",
		);
	});

	it("says no machine has reported when nothing is installed", () => {
		renderPanel(historianWeek, { kind: "loaded", names: [] });
		expect(silentLine()).toBe("No machine has reported its installed plugins.");
	});

	// A partial list would call plugins silent that a failed machine may have
	// run.
	it("lists nothing when an inventory could not be read", () => {
		renderPanel(historianWeek, { kind: "failed" });
		expect(silentLine()).toBe("Couldn't check which plugins are installed.");
	});

	it("says it is checking while inventories load", () => {
		renderPanel(historianWeek, { kind: "loading" });
		expect(silentLine()).toBe("Checking which plugins are installed…");
	});

	// An unread session may hold the very events that would clear a plugin.
	it("lists no quiet plugins when the week is capped", () => {
		renderPanel(
			historianWeek,
			{ kind: "loaded", names: ["counsel", "historian"] },
			false,
		);
		expect(screen.getByText("From the most recent 1 session.")).toBeDefined();
		expect(silentLine()).toBe(
			"Not every session this week was loaded, so quiet plugins aren't listed.",
		);
	});

	it("links through to the sessions", () => {
		renderPanel(historianWeek);
		expect(
			screen
				.getByRole("link", { name: "Plugin activity per session" })
				.getAttribute("href"),
		).toBe("/sessions");
	});
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @onlooker/web test home-plugins-panel`
Expected: FAIL — cannot find module `../components/HomePluginsPanel`.

- [ ] **Step 3: Add the icon.** In `packages/brand/index.ts`, after the `"Sun",` entry in `UNPLATED_ICONS`, add:

```ts
	// The home page's Plugins panel title (ONL-298).
	"Plug",
```

Run: `pnpm --filter @onlooker/brand test`
Expected: PASS. If the contrast floor test fails for `Plug`, stop and report NEEDS_CONTEXT with the failing output; do not pick another icon yourself.

- [ ] **Step 4: Implement** `apps/web/src/components/HomePluginsPanel.tsx`:

```tsx
/**
 * The home page's Plugins panel: what each Onlooker plugin did in the last 7
 * days, and which installed ones sent nothing (ONL-298).
 *
 * Presentational, like HomeSessionsPanel. HomePage hands it the window's
 * sessions and what the machines' inventories say is installed; a read that
 * failed or is still running arrives as such, so the panel never names a
 * plugin silent on evidence it does not have.
 */

import { useId } from "react";
import { Link } from "react-router-dom";
import type { SessionSummary } from "../api/sessionsApi";
import { silentPlugins } from "../lib/installedPlugins";
import { describePluginWeek, rollupPlugins } from "../lib/pluginRollup";
import { plural } from "../lib/sessionRollup";
import { PALETTE } from "./palette";
import { Panel } from "./ui";

/** What the inventories say is installed, by bare plugin name. */
export type Installed =
	| { kind: "loading" }
	| { kind: "failed" }
	| { kind: "loaded"; names: string[] };

const muted = { color: PALETTE.muted, fontSize: "0.85em" } as const;

function silentLine(
	installed: Installed,
	complete: boolean,
	sessions: SessionSummary[],
): string {
	if (installed.kind === "loading")
		return "Checking which plugins are installed…";
	// A partial list would call plugins silent that a failed machine ran.
	if (installed.kind === "failed")
		return "Couldn't check which plugins are installed.";
	// An unread session may hold the events that would clear a plugin.
	if (!complete)
		return "Not every session this week was loaded, so quiet plugins aren't listed.";
	if (installed.names.length === 0)
		return "No machine has reported its installed plugins.";
	const silent = silentPlugins(installed.names, sessions);
	return silent.length === 0
		? "Every installed Onlooker plugin sent events this week."
		: `Installed, no events in 7 days: ${silent.join(", ")}.`;
}

export default function HomePluginsPanel({
	sessions,
	complete,
	installed,
}: {
	/** Already filtered to the window. */
	sessions: SessionSummary[];
	/** False when more pages remain that may hold sessions in the window. */
	complete: boolean;
	installed: Installed;
}) {
	const listId = useId();
	const { rows, unclassified } = rollupPlugins(sessions);

	return (
		<Panel title="Plugins" icon="Plug">
			{rows.length === 0 && unclassified.length === 0 ? (
				<p style={{ margin: 0, color: PALETTE.muted }}>
					No plugin events in the last 7 days.
				</p>
			) : (
				<>
					{complete ? null : (
						<p style={{ margin: 0, ...muted }}>
							From the most recent {plural(sessions.length, "session")}.
						</p>
					)}
					{rows.length > 0 ? (
						<>
							<p id={listId} style={{ margin: 0, ...muted }}>
								This week
							</p>
							<ul
								data-testid="home-plugins"
								aria-labelledby={listId}
								style={{
									margin: "var(--space-1) 0 0",
									padding: 0,
									listStyle: "none",
								}}
							>
								{rows.map((week) => {
									const text = describePluginWeek(week);
									const flagged = `${week.failed} failed`;
									return (
										<li key={week.plugin}>
											<span>{week.plugin}</span>:{" "}
											{week.failed > 0 ? (
												<>
													<span style={{ color: PALETTE.danger }}>
														{flagged}
													</span>
													{text.slice(flagged.length)}
												</>
											) : (
												text
											)}
										</li>
									);
								})}
							</ul>
						</>
					) : null}
					{unclassified.length > 0 ? (
						<p style={{ margin: "var(--space-2) 0 0" }}>
							Unclassified: {unclassified.join(", ")}.
						</p>
					) : null}
				</>
			)}

			<p
				data-testid="home-plugins-silent"
				style={{ margin: "var(--space-3) 0 0", ...muted }}
			>
				{silentLine(installed, complete, sessions)}
			</p>

			<p style={{ margin: "var(--space-3) 0 0" }}>
				<Link to="/sessions" style={{ color: PALETTE.accent }}>
					Plugin activity per session
				</Link>
			</p>
		</Panel>
	);
}
```

Note the `<span>` and `:` with `{" "}` must produce textContent `governor: 2 failed in 1 session` exactly; adjust whitespace if the test shows otherwise, not the expected strings. Check `Panel`'s `icon` prop type accepts `"Plug"` (it takes `IconName`).

- [ ] **Step 5: Run it to see it pass**

Run: `pnpm --filter @onlooker/web test home-plugins-panel`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit** the component, its test, and `packages/brand/index.ts`: `feat(web): show the week's plugin activity on one panel`.

---

### Task 5: Load inventories and put the panel on the home page

**Files:**
- Create: `apps/web/src/lib/load.ts`
- Modify: `apps/web/src/pages/HomePage.tsx`
- Test: `apps/web/src/__tests__/home-page.test.tsx`

**Interfaces:**
- Consumes: `HomePluginsPanel`, `Installed` (Task 4); `reportingMachines`, `installedOnlookerPlugins` (Task 3); `listMachines`, `getMachineInventory` from `../api/machinesApi`.
- Produces: `export type Load<T>` from `../lib/load` (same three states as today's private type in HomePage).

- [ ] **Step 1: Write the failing tests.** In `home-page.test.tsx`:

Add to the hoisted mocks: `listMachines: vi.fn(), getMachineInventory: vi.fn(),` and a module mock:

```ts
vi.mock("../api/machinesApi", () => ({
	listMachines: mocks.listMachines,
	getMachineInventory: mocks.getMachineInventory,
}));
```

In `beforeEach`, add:

```ts
		mocks.listMachines.mockReset();
		mocks.getMachineInventory.mockReset();
		mocks.listMachines.mockResolvedValue({ machines: [] });
```

Append these tests inside `describe("HomePage", …)`:

```ts
	it("shows the week's plugin activity from the same sessions", async () => {
		mocks.listSessions.mockResolvedValue({
			sessions: [
				session({
					counts_by_type: { "historian.retrieval.surfaced": 4 },
					counts_by_prefix: { historian: 4 },
				}),
			],
			has_more: false,
		});
		renderPage();

		expect(
			await screen.findByText("historian", { selector: "li span" }),
		).toBeDefined();
		expect(screen.getByRole("list", { name: "This week" }).textContent).toBe(
			"historian: produced 4 in 1 session",
		);
	});

	it("reads the inventory of each reporting machine only", async () => {
		mocks.listSessions.mockResolvedValue({ sessions: [], has_more: false });
		mocks.listMachines.mockResolvedValue({
			machines: [
				machine({ id: "live" }),
				machine({ id: "never", inventory_at: null }),
				machine({ id: "gone", revoked_at: "2026-11-02T00:00:00Z" }),
			],
		});
		mocks.getMachineInventory.mockResolvedValue({
			inventory: inventory(["counsel@onlooker-community"]),
			inventory_at: "2026-11-18T00:00:00Z",
		});
		renderPage();

		expect(
			await screen.findByText("Installed, no events in 7 days: counsel."),
		).toBeDefined();
		expect(mocks.getMachineInventory.mock.calls).toEqual([["live"]]);
	});

	it("says it couldn't check when one inventory read fails", async () => {
		mocks.listSessions.mockResolvedValue({ sessions: [], has_more: false });
		mocks.listMachines.mockResolvedValue({
			machines: [machine({ id: "a" }), machine({ id: "b" })],
		});
		mocks.getMachineInventory
			.mockResolvedValueOnce({
				inventory: inventory(["counsel@onlooker-community"]),
				inventory_at: "2026-11-18T00:00:00Z",
			})
			.mockRejectedValueOnce(new Error("boom"));
		renderPage();

		expect(
			await screen.findByText("Couldn't check which plugins are installed."),
		).toBeDefined();
		expect(screen.queryByText(/Installed, no events/)).toBeNull();
	});

	// One alert for one failure: the Plugins panel says why it is empty
	// without announcing the same failure a second time.
	it("raises one alert when the sessions read fails", async () => {
		mocks.listSessions.mockRejectedValue(new Error("down"));
		renderPage();

		expect(await screen.findAllByRole("alert")).toHaveLength(1);
		expect(
			screen.getByText(
				"Plugin activity comes from your sessions, which could not be loaded.",
			),
		).toBeDefined();
	});
```

And add these helpers below `session()` (import `Inventory`, `Machine` types from `../api/machinesApi`):

```ts
function machine(over: Partial<Machine> = {}): Machine {
	return {
		id: "m1",
		name: "laptop",
		created_at: "2026-11-01T00:00:00Z",
		last_used_at: null,
		revoked_at: null,
		removed_at: null,
		inventory_at: "2026-11-18T00:00:00Z",
		plugin_count: 1,
		org_id: null,
		...over,
	};
}

function inventory(ids: string[]): Inventory {
	return {
		schema_version: 1,
		collected_at: "2026-11-18T00:00:00Z",
		project: null,
		plugins: ids.map((id) => ({
			id,
			scopes: [
				{
					scope: "user",
					version: "1.0.0",
					git_commit_sha: null,
					installed_at: null,
					last_updated: null,
					enabled: true,
				},
			],
		})),
	};
}
```

Also add the same `machinesApi` mock (resolving `{ machines: [] }`) to `apps/web/src/__tests__/root-redirect.test.tsx`, which renders HomePage through the app.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @onlooker/web test home-page`
Expected: the four new tests FAIL (no Plugins panel); the existing six PASS.

- [ ] **Step 3: Create** `apps/web/src/lib/load.ts`, moving the type and its comment out of HomePage:

```ts
/**
 * A read in three states. "Failed" is kept apart from "loaded and empty" so a
 * panel can never render an empty answer for a read that did not succeed.
 */
export type Load<T> =
	| { kind: "loading" }
	| { kind: "loaded"; value: T }
	| { kind: "failed"; message: string };
```

- [ ] **Step 4: Rewrite** `apps/web/src/pages/HomePage.tsx`. Keep the file's header comment, `SESSIONS_LIMIT` and its comment, the `now`, `sessions` and `labels` state with their comments, and the sessions and labels reads in the effect, unchanged. Then:

1. Import `Load` from `../lib/load` and delete the local type. Import `useMemo`, `type ReactNode`, `HomePluginsPanel` and `type Installed`, `installedOnlookerPlugins`, `reportingMachines`, `getMachineInventory`, `listMachines`, `type SessionSummary`, `type Windowed`.
2. Add state: `const [installed, setInstalled] = useState<Installed>({ kind: "loading" });`
3. In the same effect, before `return () => {`, add:

```ts
		listMachines()
			.then(({ machines }) =>
				Promise.all(
					reportingMachines(machines).map((machine) =>
						getMachineInventory(machine.id).then((read) => read.inventory),
					),
				),
			)
			.then((inventories) => {
				if (active)
					setInstalled({
						kind: "loaded",
						names: installedOnlookerPlugins(inventories),
					});
			})
			.catch(() => {
				// Any one failure voids the list: see the Plugins panel's silent line.
				if (active) setInstalled({ kind: "failed" });
			});
```

4. After the effect, compute the window once for every panel:

```ts
	// Every panel reads the same window, so it is cut once, here.
	const week = useMemo<Load<Windowed<SessionSummary>>>(
		() =>
			sessions.kind === "loaded"
				? {
						kind: "loaded",
						value: withinWindow(
							sessions.value.sessions,
							(session) => session.started_at,
							now,
							sessions.value.has_more,
						),
					}
				: sessions,
		[sessions, now],
	);
```

5. Above `export default function HomePage`, add the shared states helper:

```tsx
/**
 * The loading and failed states a home panel shows for a read, so each panel
 * states only what it draws once the read has arrived.
 */
function PanelFor<T>({
	load,
	title,
	icon,
	loading,
	failed,
	children,
}: {
	load: Load<T>;
	title: string;
	icon: IconName;
	loading: string;
	failed: (message: string) => ReactNode;
	children: (value: T) => ReactNode;
}) {
	if (load.kind === "loading")
		return (
			<Panel title={title} icon={icon}>
				<Loading label={loading} />
			</Panel>
		);
	if (load.kind === "failed")
		return (
			<Panel title={title} icon={icon}>
				{failed(load.message)}
			</Panel>
		);
	return <>{children(load.value)}</>;
}
```

Import `IconName` from wherever `Panel`'s `icon` prop type comes from (check `components/ui.tsx`'s import of it).

6. The returned JSX becomes:

```tsx
		<div style={{ display: "grid", gap: "var(--space-5)", maxWidth: "720px" }}>
			<PanelFor
				load={week}
				title="Recent sessions"
				icon="Monitor"
				loading="Loading your sessions…"
				failed={(message) => (
					<p role="alert" style={{ margin: 0 }}>
						{`Could not load your sessions. ${message}`.trim()}
					</p>
				)}
			>
				{(windowed) => (
					<HomeSessionsPanel
						sessions={windowed.rows}
						complete={windowed.complete}
						days={windowDays(now)}
						labels={labels}
					/>
				)}
			</PanelFor>
			<PanelFor
				load={week}
				title="Plugins"
				icon="Plug"
				loading="Loading plugin activity…"
				failed={() => (
					// Not an alert: the sessions panel already announced this failure.
					<p style={{ margin: 0 }}>
						Plugin activity comes from your sessions, which could not be
						loaded.
					</p>
				)}
			>
				{(windowed) => (
					<HomePluginsPanel
						sessions={windowed.rows}
						complete={windowed.complete}
						installed={installed}
					/>
				)}
			</PanelFor>
		</div>
```

The comment on the old `{ kind: "failed", message: describeError(error, "") }` stays where it is.

- [ ] **Step 5: Run it to see it pass**

Run: `pnpm --filter @onlooker/web test home-page` — PASS, 10 tests.
Run: `pnpm --filter @onlooker/web test root-redirect` — PASS.

- [ ] **Step 6: Full gates.**

Run: `pnpm --filter @onlooker/web test` — all pass.
Run: `pnpm --filter @onlooker/brand test` — all pass.
Run: `pnpm typecheck` — 14/14.
Run: `pnpm --filter @onlooker/web lint` — 0 errors.

- [ ] **Step 7: Commit** `lib/load.ts`, `HomePage.tsx` and both test files: `feat(web): put the plugins panel on the home page`.

- [ ] **Step 8: Browser check (controller, not a subagent).** Run the web app against the mock API (`VITE_USE_MOCK_API=true VITE_API_BASE_URL= pnpm --filter @onlooker/web dev`), sign up in the mock, and open `/home`. The mock holds no sessions, so expect "No plugin events in the last 7 days." and a silent line from the mock machines' inventories (or "No machine has reported…" if none is seeded). Check light and dark, and the panel at 390 px with no horizontal scroll. The loaded state is checked in production after deploy against the Sessions page's plugin lines for the same days.
