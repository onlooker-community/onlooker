import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findUp, readEnablement } from "../enablement";

/** A temp directory tree with a `.claude/settings.json` at its root. */
function project(
	settings: unknown,
	nested = "a/b/c",
): { root: string; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "onlooker-enable-"));
	mkdirSync(join(root, ".claude"), { recursive: true });
	writeFileSync(
		join(root, ".claude", "settings.json"),
		typeof settings === "string" ? settings : JSON.stringify(settings),
	);
	const cwd = join(root, nested);
	mkdirSync(cwd, { recursive: true });
	return { root, cwd };
}

/** A temp config dir with no `settings.json`, so only the project file counts. */
function bareHome(): string {
	return mkdtempSync(join(tmpdir(), "onlooker-home-"));
}

/** Marks `dir` as a git repository, so `repoRoot` resolves to it. */
function markRepo(dir: string): string {
	mkdirSync(join(dir, ".git"), { recursive: true });
	return dir;
}

/** Writes a `.claude/<name>` settings file under an existing directory. */
function writeSettings(dir: string, name: string, settings: unknown): void {
	mkdirSync(join(dir, ".claude"), { recursive: true });
	writeFileSync(
		join(dir, ".claude", name),
		typeof settings === "string" ? settings : JSON.stringify(settings),
	);
}

/** A temp config dir holding a user-level `settings.json`. */
function configDir(settings: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "onlooker-cfg-"));
	writeFileSync(
		join(dir, "settings.json"),
		typeof settings === "string" ? settings : JSON.stringify(settings),
	);
	return dir;
}

describe("findUp", () => {
	it("finds a file in an ancestor directory", () => {
		const { root, cwd } = project({ enabledPlugins: {} });
		expect(findUp(cwd, join(".claude", "settings.json"))).toBe(
			join(root, ".claude", "settings.json"),
		);
	});

	it("returns null when nothing up the tree has it", () => {
		const empty = mkdtempSync(join(tmpdir(), "onlooker-none-"));
		expect(findUp(empty, join(".claude", "nonexistent.json"))).toBeNull();
	});
});

describe("readEnablement", () => {
	it("keeps only onlooker-community plugins that are switched on", () => {
		const { cwd } = project({
			enabledPlugins: {
				"ecosystem@onlooker-community": true,
				"bursar@onlooker-community": true,
				"archivist@onlooker-community": false,
				"typescript-architect@meaganewaller-marketplace": true,
			},
		});
		const found = readEnablement({ cwd, home: bareHome(), env: {} });
		expect(found.kind).toBe("found");
		if (found.kind !== "found") return;
		// Sorted, so the report cannot reshuffle between runs.
		expect(found.plugins).toEqual(["bursar", "ecosystem"]);
	});

	// The whole point of the command is to stop guessing. An absent config is
	// not an empty expected-set: one says "nothing should be running", the
	// other says "I do not know what should be running", and reporting the
	// first when the second is true is the confident-but-wrong sentence this
	// work exists to remove.
	it("reports unknown rather than empty when no settings file exists", () => {
		const empty = mkdtempSync(join(tmpdir(), "onlooker-bare-"));
		// `findUp` walks all the way to `/`, so this test's premise -- that no
		// `.claude/settings.json` exists above `empty` -- depends on the
		// machine, not just this test. A CI box with `TMPDIR=/tmp` and a
		// `/tmp/.claude/settings.json` would flip this to "found" with no
		// hint why. Assert the precondition explicitly so pollution fails
		// loudly here, with the offending path, instead of as a confusing
		// kind mismatch below.
		const polluter = findUp(empty, join(".claude", "settings.json"));
		if (polluter !== null) {
			throw new Error(
				`environment polluted for this test: found ${polluter} above ${empty}. ` +
					"This test assumes no ancestor of the OS temp dir declares a .claude/settings.json.",
			);
		}
		const found = readEnablement({ cwd: empty, home: bareHome(), env: {} });
		expect(found.kind).toBe("unknown");
	});

	it("reports unknown rather than throwing when the settings file is not JSON", () => {
		const { cwd } = project("{ this is not json");
		const found = readEnablement({ cwd, home: bareHome(), env: {} });
		expect(found.kind).toBe("unknown");
		if (found.kind !== "unknown") return;
		expect(found.reason).toContain("could not be read");
	});

	it("reports unknown when the file parses but declares no enabledPlugins", () => {
		const { cwd } = project({ hooks: {} });
		expect(readEnablement({ cwd, home: bareHome(), env: {} }).kind).toBe(
			"unknown",
		);
	});

	// The bug ecosystem@057a40d (#237) fixed across 16 vendored copies of
	// config-loader.sh. Claude Code exports CLAUDE_CONFIG_DIR, and where it is
	// set $HOME/.claude typically does not exist at all - so hardcoding it
	// makes the user layer silently unreachable, with no error and no failing
	// test. This drives the disagreement on purpose: a custom config dir, and
	// no $HOME/.claude anywhere.
	it("reads user settings from CLAUDE_CONFIG_DIR when it is set", () => {
		const cfg = configDir({
			enabledPlugins: { "assayer@onlooker-community": true },
		});
		const bare = mkdtempSync(join(tmpdir(), "onlooker-nohome-"));
		const found = readEnablement({
			cwd: mkdtempSync(join(tmpdir(), "onlooker-noproj-")),
			home: bare,
			env: { CLAUDE_CONFIG_DIR: cfg },
		});
		expect(found.kind).toBe("found");
		if (found.kind !== "found") return;
		expect(found.plugins).toEqual(["assayer"]);
	});

	it("lets the project file win over the user file", () => {
		const cfg = configDir({
			enabledPlugins: { "assayer@onlooker-community": true },
		});
		const { cwd } = project({
			enabledPlugins: { "assayer@onlooker-community": false },
		});
		const found = readEnablement({
			cwd,
			home: bareHome(),
			configDir: cfg,
			env: {},
		});
		expect(found.kind).toBe("found");
		if (found.kind !== "found") return;
		expect(found.plugins).toEqual([]);
	});

	// A layer that exists but cannot be parsed is not the same as a layer
	// that is simply absent: we found something and could not read it, so we
	// cannot know the full expected set even if another layer parsed fine.
	// Reporting "found" from the surviving layer alone would silently drop
	// whatever the broken layer declared.
	it("reports unknown when a discovered layer cannot be parsed, even if another layer parses fine", () => {
		const cfg = configDir("{ this is not json");
		const { cwd } = project({
			enabledPlugins: { "bursar@onlooker-community": true },
		});
		const found = readEnablement({
			cwd,
			home: bareHome(),
			configDir: cfg,
			env: {},
		});
		expect(found.kind).toBe("unknown");
		if (found.kind !== "unknown") return;
		expect(found.reason).toContain("could not be read");
	});

	// `enabledPlugins` present but not an object (null, a string, an array,
	// a number) is a malformed config, not an empty one. Treating it as
	// "found, nothing enabled" would report a clean bill from garbage input.
	it("reports unknown when enabledPlugins is null", () => {
		const { cwd } = project({ enabledPlugins: null });
		expect(readEnablement({ cwd, home: bareHome(), env: {} }).kind).toBe(
			"unknown",
		);
	});

	it("reports unknown when enabledPlugins is a string rather than an object", () => {
		const { cwd } = project({ enabledPlugins: "ab" });
		expect(readEnablement({ cwd, home: bareHome(), env: {} }).kind).toBe(
			"unknown",
		);
	});

	// A plugin's value is whatever JSON held, not necessarily a boolean.
	// Truthiness would treat the string "false" as enabled; only the literal
	// `true` should count.
	it("treats a non-true value as not enabled, not as a problem", () => {
		const { cwd } = project({
			enabledPlugins: { "bursar@onlooker-community": "false" },
		});
		const found = readEnablement({ cwd, home: bareHome(), env: {} });
		expect(found.kind).toBe("found");
		if (found.kind !== "found") return;
		expect(found.plugins).toEqual([]);
	});

	// The shell chain this mirrors is `${CLAUDE_HOME:-${CLAUDE_CONFIG_DIR:-...}}`,
	// and `:-` falls through on an empty value where JS `??` does not. A wrapper
	// that runs `export CLAUDE_HOME="$SOME_UNSET_VAR"` exports the empty string,
	// which the shell skips and this code took as the config dir - making the
	// path relative and the user layer silently unreachable. That is the exact
	// shape of ecosystem #237, the defect this function exists to avoid.
	it("falls through an empty CLAUDE_HOME the way the shell chain does", () => {
		const cfg = configDir({
			enabledPlugins: { "assayer@onlooker-community": true },
		});
		const found = readEnablement({
			cwd: mkdtempSync(join(tmpdir(), "onlooker-noproj-")),
			home: bareHome(),
			env: { CLAUDE_HOME: "", CLAUDE_CONFIG_DIR: cfg },
		});
		expect(found.kind).toBe("found");
		if (found.kind !== "found") return;
		expect(found.plugins).toEqual(["assayer"]);
	});

	// `settings.local.json` is the highest-precedence project layer in Claude
	// Code and the file a `/plugin` toggle writes to. Missing it meant someone
	// could switch a plugin off for this project and have doctor keep judging
	// it against the stale committed value - a permanent false STOPPED in the
	// command built to stop crying wolf.
	it("lets settings.local.json win over settings.json", () => {
		const { root, cwd } = project({
			enabledPlugins: { "bursar@onlooker-community": true },
		});
		writeSettings(root, "settings.local.json", {
			enabledPlugins: { "bursar@onlooker-community": false },
		});
		const found = readEnablement({ cwd, home: bareHome(), env: {} });
		expect(found.kind).toBe("found");
		if (found.kind !== "found") return;
		expect(found.plugins).toEqual([]);
	});

	it("reads settings.local.json as a project layer of its own", () => {
		const root = markRepo(mkdtempSync(join(tmpdir(), "onlooker-local-")));
		writeSettings(root, "settings.local.json", {
			enabledPlugins: { "lineage@onlooker-community": true },
		});
		const found = readEnablement({ cwd: root, home: bareHome(), env: {} });
		expect(found.kind).toBe("found");
		if (found.kind !== "found") return;
		expect(found.plugins).toEqual(["lineage"]);
	});

	// The walk used to run to `/`, so a repo with no settings of its own
	// inherited whatever an unrelated ancestor declared - a checkouts
	// directory, or `$HOME/.claude` on a machine whose CLAUDE_CONFIG_DIR
	// points elsewhere. Claude Code never loads those as project settings.
	it("does not climb past the repo root for project settings", () => {
		const outer = mkdtempSync(join(tmpdir(), "onlooker-outer-"));
		writeSettings(outer, "settings.json", {
			enabledPlugins: { "bursar@onlooker-community": true },
		});
		const repo = markRepo(join(outer, "repo"));
		const cwd = join(repo, "apps", "cli");
		mkdirSync(cwd, { recursive: true });
		const found = readEnablement({ cwd, home: bareHome(), env: {} });
		expect(found.kind).toBe("unknown");
	});

	// `cwd` is wherever the command was run, not the repo root, so a walk
	// starting there let a subdirectory's settings shadow the repo's own.
	it("reads the repo root's settings, not a subdirectory's", () => {
		const repo = markRepo(mkdtempSync(join(tmpdir(), "onlooker-repo-")));
		writeSettings(repo, "settings.json", {
			enabledPlugins: { "bursar@onlooker-community": true },
		});
		const cwd = join(repo, "apps", "cli");
		mkdirSync(cwd, { recursive: true });
		writeSettings(cwd, "settings.json", {
			enabledPlugins: { "bursar@onlooker-community": false },
		});
		const found = readEnablement({ cwd, home: bareHome(), env: {} });
		expect(found.kind).toBe("found");
		if (found.kind !== "found") return;
		expect(found.plugins).toEqual(["bursar"]);
	});
});
