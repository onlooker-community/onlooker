import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	configDirCandidates,
	findUp,
	readEnabledMap,
	readEnablement,
	resolveConfigDir,
	userConfigDir,
} from "../enablement";

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

	// `readSettings` used to return its failure as `{ error }` and its success
	// as the parsed settings, so the caller discriminated on `"error" in
	// settings` - a test the file's own content can satisfy. A settings.json
	// with a top-level `error` key had its whole layer discarded, and the
	// non-string value rendered into the reason as `[object Object]`.
	it("reads a settings file that has a top-level error key of its own", () => {
		const { cwd } = project({
			error: { code: 500, message: "left over from something else" },
			enabledPlugins: { "bursar@onlooker-community": true },
		});
		const found = readEnablement({ cwd, home: bareHome(), env: {} });
		expect(found.kind).toBe("found");
		if (found.kind !== "found") return;
		expect(found.plugins).toEqual(["bursar"]);
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

describe("readEnabledMap", () => {
	// The whole reason this is split out of `readEnablement`: the inventory
	// reports every marketplace, and `readEnablement` can only ever answer for
	// one of them.
	it("keeps plugins from marketplaces readEnablement filters away", () => {
		const dir = configDir({
			enabledPlugins: {
				"librarian@onlooker-community": true,
				"superpowers@superpowers-dev": true,
				"archivist@onlooker-community": false,
			},
		});

		const map = readEnabledMap({
			cwd: bareHome(),
			home: bareHome(),
			configDir: dir,
			env: {},
		});

		expect(map.kind).toBe("found");
		if (map.kind !== "found") return;
		expect(map.enabled).toEqual({
			"librarian@onlooker-community": true,
			"superpowers@superpowers-dev": true,
			"archivist@onlooker-community": false,
		});
	});

	// `false` survives the merge rather than being dropped, because a plugin
	// switched off is a different claim from one never mentioned, and the
	// inventory renders the two differently.
	it("keeps a disabled entry rather than omitting it", () => {
		const dir = configDir({
			enabledPlugins: { "bursar@onlooker-community": false },
		});

		const map = readEnabledMap({
			cwd: bareHome(),
			home: bareHome(),
			configDir: dir,
			env: {},
		});

		if (map.kind !== "found") throw new Error("expected found");
		expect(map.enabled).toEqual({ "bursar@onlooker-community": false });
	});

	it("layers project settings over the user's, like readEnablement", () => {
		const dir = configDir({
			enabledPlugins: { "bursar@onlooker-community": true },
		});
		const repo = markRepo(mkdtempSync(join(tmpdir(), "onlooker-repo-")));
		writeSettings(repo, "settings.json", {
			enabledPlugins: { "bursar@onlooker-community": false },
		});

		const map = readEnabledMap({
			cwd: repo,
			home: bareHome(),
			configDir: dir,
			env: {},
		});

		if (map.kind !== "found") throw new Error("expected found");
		expect(map.enabled["bursar@onlooker-community"]).toBe(false);
	});

	it("reports unknown when a layer cannot be parsed", () => {
		const dir = configDir("{ not json");

		expect(
			readEnabledMap({
				cwd: bareHome(),
				home: bareHome(),
				configDir: dir,
				env: {},
			}).kind,
		).toBe("unknown");
	});
});

describe("userConfigDir", () => {
	// The defect this codebase has shipped twice. Pinned here so a third
	// version cannot pass its own tests.
	it("prefers CLAUDE_HOME, then CLAUDE_CONFIG_DIR, then the default", () => {
		expect(
			userConfigDir({ CLAUDE_HOME: "/a", CLAUDE_CONFIG_DIR: "/b" }, "/h"),
		).toBe("/a");
		expect(userConfigDir({ CLAUDE_CONFIG_DIR: "/b" }, "/h")).toBe("/b");
		expect(userConfigDir({}, "/h")).toBe(join("/h", ".claude"));
	});

	it("lets an explicit override win over both variables", () => {
		expect(userConfigDir({ CLAUDE_HOME: "/a" }, "/h", "/explicit")).toBe(
			"/explicit",
		);
	});
});

/**
 * Where the config directory came from, not just what it is.
 *
 * The last element of the chain is an assertion nothing establishes: that a
 * config directory exists at $HOME/.claude. On a multi-account machine there
 * deliberately is none, so a caller that cannot tell a resolved path from a
 * guess reports a wrong answer with total confidence.
 */
describe("resolveConfigDir", () => {
	it("names the variable it resolved from", () => {
		expect(resolveConfigDir({ CLAUDE_HOME: "/a" }, "/h")).toEqual({
			path: "/a",
			source: "CLAUDE_HOME",
		});
		expect(resolveConfigDir({ CLAUDE_CONFIG_DIR: "/b" }, "/h")).toEqual({
			path: "/b",
			source: "CLAUDE_CONFIG_DIR",
		});
	});

	it("marks the bare default as a guess", () => {
		expect(resolveConfigDir({}, "/h")).toEqual({
			path: join("/h", ".claude"),
			source: "default",
		});
	});

	it("treats an explicit override as resolved", () => {
		expect(resolveConfigDir({}, "/h", "/explicit")).toEqual({
			path: "/explicit",
			source: "override",
		});
	});

	// The empty-string case config-loader.sh was corrected for: a wrapper
	// exporting an unset variable exports "", and `||` must fall through it.
	it("falls through an empty variable to the next source", () => {
		expect(
			resolveConfigDir({ CLAUDE_HOME: "", CLAUDE_CONFIG_DIR: "/b" }, "/h"),
		).toEqual({ path: "/b", source: "CLAUDE_CONFIG_DIR" });
	});
});

describe("configDirCandidates", () => {
	it("finds directories that actually look like config directories", () => {
		const home = mkdtempSync(join(tmpdir(), "onlooker-cands-"));
		mkdirSync(join(home, ".claude-personal", "plugins"), { recursive: true });
		mkdirSync(join(home, ".claude-work"), { recursive: true });
		writeFileSync(join(home, ".claude-work", "settings.json"), "{}");

		expect(configDirCandidates(home).sort()).toEqual([
			"~/.claude-personal",
			"~/.claude-work",
		]);
	});

	// Evidence, not a blind glob. A directory merely named .claude-something
	// proves nothing, and listing it would send someone to the wrong place.
	it("ignores a .claude-ish directory with no config in it", () => {
		const home = mkdtempSync(join(tmpdir(), "onlooker-cands-"));
		mkdirSync(join(home, ".claude-notes"), { recursive: true });

		expect(configDirCandidates(home)).toEqual([]);
	});

	it("returns none when home cannot be read", () => {
		expect(
			configDirCandidates(join(tmpdir(), "does-not-exist-at-all")),
		).toEqual([]);
	});
});

describe("readEnabledMap without CLAUDE_CONFIG_DIR", () => {
	// doctor previously reported "no .claude/settings.json declares
	// enabledPlugins", which is true of $HOME/.claude and blames config
	// content for what is really a resolution failure. The verdict is the
	// same - unknown - but the reason has to point at the right thing.
	it("blames the unset variable, not the settings file", () => {
		const home = mkdtempSync(join(tmpdir(), "onlooker-noenv-"));
		mkdirSync(join(home, ".claude-personal"), { recursive: true });
		writeFileSync(join(home, ".claude-personal", "settings.json"), "{}");

		const map = readEnabledMap({ cwd: home, home, env: {} });

		expect(map.kind).toBe("unknown");
		if (map.kind !== "unknown") return;
		expect(map.reason).toMatch(/CLAUDE_CONFIG_DIR/);
		expect(map.reason).toContain("~/.claude-personal");
	});

	// A single-account machine with a real $HOME/.claude keeps working with
	// nothing set, so this must not become a requirement to configure.
	it("still reads $HOME/.claude when it genuinely holds settings", () => {
		const home = mkdtempSync(join(tmpdir(), "onlooker-single-"));
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(
			join(home, ".claude", "settings.json"),
			JSON.stringify({ enabledPlugins: { "bursar@onlooker-community": true } }),
		);

		const map = readEnabledMap({ cwd: home, home, env: {} });

		expect(map.kind).toBe("found");
	});
});
