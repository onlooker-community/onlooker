import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectInventory } from "../inventory";

/** A home directory that exists, so home-relative paths have something to cut. */
function home(): string {
	return mkdtempSync(join(tmpdir(), "onlooker-inv-home-"));
}

/** A config dir holding `plugins/installed_plugins.json` and optional settings. */
function configDir(installed: unknown, settings?: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "onlooker-inv-cfg-"));
	mkdirSync(join(dir, "plugins"), { recursive: true });
	writeFileSync(
		join(dir, "plugins", "installed_plugins.json"),
		typeof installed === "string" ? installed : JSON.stringify(installed),
	);
	if (settings !== undefined) {
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	}
	return dir;
}

/** Marks `dir` as a git repository, so `repoRoot` resolves to it. */
function markRepo(dir: string): string {
	mkdirSync(join(dir, ".git"), { recursive: true });
	return dir;
}

/** The real file's shape: one plugin, installed at two scopes, two versions. */
function twoScopes(projectPath: string) {
	return {
		version: 1,
		plugins: {
			"librarian@onlooker-community": [
				{
					scope: "user",
					projectPath: null,
					installPath: "/cache/librarian/0.18.1",
					version: "0.18.1",
					gitCommitSha: "abc1234def",
					installedAt: "2026-09-05T18:39:27.969Z",
					lastUpdated: "2026-09-09T21:50:18.733Z",
				},
				{
					scope: "project",
					projectPath,
					installPath: "/cache/librarian/0.18.0",
					version: "0.18.0",
					gitCommitSha: "def5678abc",
					installedAt: "2026-09-05T18:39:27.969Z",
					lastUpdated: "2026-09-09T21:50:18.733Z",
				},
			],
		},
	};
}

describe("collectInventory", () => {
	// The failure this exists for: an implementation that keeps the last scope
	// it read passes a one-install fixture and is wrong on every real machine.
	it("keeps every scope a plugin is installed at, with its own version", () => {
		const h = home();
		const dir = configDir(twoScopes(join(h, "src", "ecosystem")));

		const result = collectInventory({
			cwd: h,
			home: h,
			configDir: dir,
			env: {},
		});

		expect(result.kind).toBe("collected");
		if (result.kind !== "collected") return;
		const librarian = result.inventory.plugins.find(
			(p) => p.id === "librarian@onlooker-community",
		);
		expect(librarian?.scopes).toHaveLength(2);
		expect(librarian?.scopes.map((s) => s.version).sort()).toEqual([
			"0.18.0",
			"0.18.1",
		]);
	});

	it("sends project paths home-relative, never absolute", () => {
		const h = home();
		const dir = configDir(twoScopes(join(h, "src", "ecosystem")));

		const result = collectInventory({
			cwd: h,
			home: h,
			configDir: dir,
			env: {},
		});

		if (result.kind !== "collected") throw new Error("expected collected");
		const serialized = JSON.stringify(result.inventory);
		expect(serialized).toContain("~/src/ecosystem");
		// The OS username must not reach the server.
		expect(serialized).not.toContain(h);
	});

	it("keeps plugins from marketplaces doctor filters away", () => {
		const h = home();
		const dir = configDir({
			version: 1,
			plugins: {
				"superpowers@superpowers-dev": [
					{ scope: "user", projectPath: null, version: "6.2.0" },
				],
			},
		});

		const result = collectInventory({
			cwd: h,
			home: h,
			configDir: dir,
			env: {},
		});

		if (result.kind !== "collected") throw new Error("expected collected");
		expect(result.inventory.plugins.map((p) => p.id)).toEqual([
			"superpowers@superpowers-dev",
		]);
	});

	it("marks user-scope enablement from settings", () => {
		const h = home();
		const dir = configDir(twoScopes(join(h, "src", "ecosystem")), {
			enabledPlugins: { "librarian@onlooker-community": true },
		});

		const result = collectInventory({
			cwd: h,
			home: h,
			configDir: dir,
			env: {},
		});

		if (result.kind !== "collected") throw new Error("expected collected");
		const scopes = result.inventory.plugins[0].scopes;
		expect(scopes.find((s) => s.scope === "user")?.enabled).toBe(true);
	});

	// Three states, not two. A project other than the one that synced has
	// settings in a tree we never opened, so claiming "disabled" invents a fact.
	it("says unknown for a project other than the one that synced", () => {
		const h = home();
		const dir = configDir(twoScopes(join(h, "src", "elsewhere")), {
			enabledPlugins: { "librarian@onlooker-community": true },
		});

		const result = collectInventory({
			cwd: h,
			home: h,
			configDir: dir,
			env: {},
		});

		if (result.kind !== "collected") throw new Error("expected collected");
		const scopes = result.inventory.plugins[0].scopes;
		expect(scopes.find((s) => s.scope !== "user")?.enabled).toBeNull();
	});

	it("answers enablement for the project it actually ran in", () => {
		const h = home();
		const repo = markRepo(join(h, "src", "onlooker"));
		const dir = configDir(twoScopes(repo), {
			enabledPlugins: { "librarian@onlooker-community": true },
		});

		const result = collectInventory({
			cwd: repo,
			home: h,
			configDir: dir,
			env: {},
		});

		if (result.kind !== "collected") throw new Error("expected collected");
		const scopes = result.inventory.plugins[0].scopes;
		expect(scopes.find((s) => s.scope === "~/src/onlooker")?.enabled).toBe(
			true,
		);
		expect(result.inventory.project).toBe("~/src/onlooker");
	});

	it("records a disabled plugin as inert rather than absent", () => {
		const h = home();
		const dir = configDir(
			{
				version: 1,
				plugins: {
					"archivist@onlooker-community": [
						{ scope: "user", projectPath: null, version: "0.5.0" },
					],
				},
			},
			{ enabledPlugins: { "archivist@onlooker-community": false } },
		);

		const result = collectInventory({
			cwd: h,
			home: h,
			configDir: dir,
			env: {},
		});

		if (result.kind !== "collected") throw new Error("expected collected");
		expect(result.inventory.plugins[0].scopes[0].enabled).toBe(false);
	});

	// "Nothing installed" and "we could not look" are different claims, and
	// only one of them is knowable from a missing file.
	it("is unavailable, not empty, when the file is missing", () => {
		const h = home();
		const dir = mkdtempSync(join(tmpdir(), "onlooker-inv-cfg-"));

		const result = collectInventory({
			cwd: h,
			home: h,
			configDir: dir,
			env: {},
		});

		expect(result.kind).toBe("unavailable");
	});

	it("is unavailable when the file is not valid JSON", () => {
		const h = home();
		const dir = configDir("{ nope");

		expect(
			collectInventory({ cwd: h, home: h, configDir: dir, env: {} }).kind,
		).toBe("unavailable");
	});

	it("keeps the home directory out of an unavailable reason too", () => {
		const h = home();
		const dir = mkdtempSync(join(tmpdir(), "onlooker-inv-cfg-"));

		const result = collectInventory({
			cwd: h,
			home: h,
			configDir: dir,
			env: {},
		});

		if (result.kind !== "unavailable") throw new Error("expected unavailable");
		expect(result.reason).not.toContain(h);
	});

	it("stamps collected_at from the injected clock", () => {
		const h = home();
		const dir = configDir(twoScopes(join(h, "src", "ecosystem")));

		const result = collectInventory({
			cwd: h,
			home: h,
			configDir: dir,
			env: {},
			now: () => new Date("2026-09-11T12:00:00.000Z"),
		});

		if (result.kind !== "collected") throw new Error("expected collected");
		expect(result.inventory.collected_at).toBe("2026-09-11T12:00:00.000Z");
	});

	// Sorted so two reports from an unchanged machine are byte-identical, and
	// a diff between reports means something actually moved.
	it("sorts plugins so an unchanged machine reports identically", () => {
		const h = home();
		const dir = configDir({
			version: 1,
			plugins: {
				"zulu@m": [{ scope: "user", projectPath: null, version: "1.0.0" }],
				"alpha@m": [{ scope: "user", projectPath: null, version: "1.0.0" }],
			},
		});

		const result = collectInventory({
			cwd: h,
			home: h,
			configDir: dir,
			env: {},
		});

		if (result.kind !== "collected") throw new Error("expected collected");
		expect(result.inventory.plugins.map((p) => p.id)).toEqual([
			"alpha@m",
			"zulu@m",
		]);
	});

	it("resolves the config dir from CLAUDE_CONFIG_DIR when no override is given", () => {
		const h = home();
		const dir = configDir(twoScopes(join(h, "src", "ecosystem")));

		const result = collectInventory({
			cwd: h,
			home: h,
			env: { CLAUDE_CONFIG_DIR: dir },
		});

		expect(result.kind).toBe("collected");
	});
});
