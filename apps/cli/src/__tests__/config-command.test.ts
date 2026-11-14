import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../cli";
import { configCommand } from "../commands/config";
import { CliError } from "../errors";
import { settingsFiles } from "../settings";

/** The fixtures' git, cut off from the developer's config (ONL-240). */
const isolatedGit = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore", env: isolatedGit });
}

const DEFAULTS = {
	librarian: {
		enabled: true,
		lesson_sync: { remind: true, auto: false, min_interval_minutes: 60 },
		lesson_auto: { visibility: "org" },
	},
};

interface World {
	home: string;
	configDir: string;
	repo: string;
	env: NodeJS.ProcessEnv;
}

/**
 * A home with a config directory, librarian installed at user scope with
 * DEFAULTS as its shipped config.json, and a git repository to run in.
 */
function world(): World {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "onlooker-config-")));
	const home = join(root, "home");
	const configDir = join(home, ".claude-personal");
	const install = join(configDir, "plugins", "cache", "librarian", "1.0.0");
	mkdirSync(install, { recursive: true });
	writeFileSync(join(install, "config.json"), JSON.stringify(DEFAULTS));
	writeFileSync(
		join(configDir, "plugins", "installed_plugins.json"),
		JSON.stringify({
			version: 2,
			plugins: {
				"librarian@onlooker-community": [
					{ scope: "user", installPath: install, version: "1.0.0" },
				],
			},
		}),
	);

	const repo = join(root, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "t@example.com");
	git(repo, "config", "user.name", "T");
	git(repo, "commit", "-q", "--allow-empty", "-m", "init");

	return {
		home,
		configDir,
		repo,
		env: { CLAUDE_CONFIG_DIR: configDir, HOME: home },
	};
}

function config(w: World, ...argv: string[]): string {
	return configCommand(argv, { cwd: w.repo, env: w.env, home: w.home });
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

describe("settingsFiles", () => {
	it("puts project and local in the repository's .claude, and user in the config dir", () => {
		const w = world();
		const files = settingsFiles({ cwd: w.repo, env: w.env, home: w.home });
		expect(files.project).toBe(join(w.repo, ".claude", "settings.json"));
		expect(files.local).toBe(join(w.repo, ".claude", "settings.local.json"));
		expect(files.user).toBe(join(w.configDir, "settings.json"));
		expect(files.userLocal).toBe(join(w.configDir, "settings.local.json"));
	});

	it("resolves from a subdirectory to the repository root", () => {
		const w = world();
		const sub = join(w.repo, "apps", "cli");
		mkdirSync(sub, { recursive: true });
		const files = settingsFiles({ cwd: sub, env: w.env, home: w.home });
		expect(files.project).toBe(join(w.repo, ".claude", "settings.json"));
	});

	// The plugins read settings.json from the worktree and settings.local.json
	// from the main checkout, because git worktree add never copies a
	// gitignored file (ecosystem config-loader.sh, ecosystem-449.37). Writing
	// local anywhere else would write a file no plugin reads.
	it("in a linked worktree, keeps project in the worktree and local in the main checkout", () => {
		const w = world();
		const tree = join(w.repo, "..", "tree");
		git(w.repo, "worktree", "add", "-q", tree);
		const files = settingsFiles({ cwd: tree, env: w.env, home: w.home });
		expect(files.project).toBe(
			join(realpathSync(tree), ".claude", "settings.json"),
		);
		expect(files.local).toBe(join(w.repo, ".claude", "settings.local.json"));
	});
});

describe("onlooker config set", () => {
	it("writes the key under the plugin's namespace in local scope by default", () => {
		const w = world();
		const out = config(w, "set", "librarian.lesson_sync.auto", "true");
		const local = join(w.repo, ".claude", "settings.local.json");
		expect(readJson(local)).toEqual({
			librarian: { lesson_sync: { auto: true } },
		});
		expect(out).toContain(local);
	});

	it("keeps everything else already in the file", () => {
		const w = world();
		const project = join(w.repo, ".claude", "settings.json");
		writeJson(project, {
			enabledPlugins: { "librarian@onlooker-community": true },
			librarian: { lesson_auto: { visibility: "public" } },
		});
		config(
			w,
			"set",
			"librarian.lesson_sync.auto",
			"true",
			"--scope",
			"project",
		);
		expect(readJson(project)).toEqual({
			enabledPlugins: { "librarian@onlooker-community": true },
			librarian: {
				lesson_auto: { visibility: "public" },
				lesson_sync: { auto: true },
			},
		});
	});

	it("writes user scope to the account's settings.json", () => {
		const w = world();
		config(
			w,
			"set",
			"librarian.lesson_sync.min_interval_minutes",
			"15",
			"--scope",
			"user",
		);
		expect(readJson(join(w.configDir, "settings.json"))).toEqual({
			librarian: { lesson_sync: { min_interval_minutes: 15 } },
		});
	});

	it("coerces the value to the type of the shipped default", () => {
		const w = world();
		config(w, "set", "librarian.lesson_sync.min_interval_minutes", "30");
		config(w, "set", "librarian.lesson_auto.visibility", "public");
		expect(readJson(join(w.repo, ".claude", "settings.local.json"))).toEqual({
			librarian: {
				lesson_sync: { min_interval_minutes: 30 },
				lesson_auto: { visibility: "public" },
			},
		});
	});

	it("refuses a value of the wrong type, and writes nothing", () => {
		const w = world();
		expect(() => config(w, "set", "librarian.lesson_sync.auto", "yes")).toThrow(
			/expects a boolean/,
		);
		expect(existsSync(join(w.repo, ".claude", "settings.local.json"))).toBe(
			false,
		);
	});

	it("refuses a key the plugin does not define, and names the closest one", () => {
		const w = world();
		expect(() =>
			config(w, "set", "librarian.lesson_synk.auto", "true"),
		).toThrow(/librarian\.lesson_sync\.auto/);
		expect(existsSync(join(w.repo, ".claude", "settings.local.json"))).toBe(
			false,
		);
	});

	it("writes an undefined key with --force, reading the value as JSON when it parses", () => {
		const w = world();
		config(w, "set", "librarian.future_flag", "true", "--force");
		config(w, "set", "librarian.future_name", "hello", "--force");
		expect(readJson(join(w.repo, ".claude", "settings.local.json"))).toEqual({
			librarian: { future_flag: true, future_name: "hello" },
		});
	});

	it("refuses a plugin that is not installed", () => {
		const w = world();
		expect(() => config(w, "set", "tribunal.enabled", "true")).toThrow(
			/tribunal is not installed/,
		);
	});

	// Rewriting a file that did not parse would replace someone's settings
	// with the one key this command was given.
	it("refuses to rewrite a settings file it cannot parse", () => {
		const w = world();
		const local = join(w.repo, ".claude", "settings.local.json");
		mkdirSync(join(w.repo, ".claude"), { recursive: true });
		writeFileSync(local, "{ not json");
		expect(() =>
			config(w, "set", "librarian.lesson_sync.auto", "true"),
		).toThrow(/could not be read/);
		expect(readFileSync(local, "utf8")).toBe("{ not json");
	});

	// ONL-105: from a shell with no CLAUDE_CONFIG_DIR, ~/.claude is a guess,
	// and on a machine whose real config dir is elsewhere a write there is a
	// setting no session ever reads.
	it("refuses user scope when the config dir is a guess and another one exists", () => {
		const w = world();
		const env = { HOME: w.home };
		expect(() =>
			configCommand(
				["set", "librarian.lesson_sync.auto", "true", "--scope", "user"],
				{ cwd: w.repo, env, home: w.home },
			),
		).toThrow(/CLAUDE_CONFIG_DIR is not set.*~\/\.claude-personal/);
	});

	it("refuses an unknown scope", () => {
		const w = world();
		expect(() =>
			config(w, "set", "librarian.lesson_sync.auto", "true", "--scope", "team"),
		).toThrow(/scope must be user, project or local/);
	});
});

describe("onlooker config unset", () => {
	it("removes the key and the objects it leaves empty", () => {
		const w = world();
		const local = join(w.repo, ".claude", "settings.local.json");
		writeJson(local, {
			permissions: { allow: [] },
			librarian: { lesson_sync: { auto: true } },
		});
		config(w, "unset", "librarian.lesson_sync.auto");
		expect(readJson(local)).toEqual({ permissions: { allow: [] } });
	});

	it("says so when the scope did not set the key", () => {
		const w = world();
		expect(config(w, "unset", "librarian.lesson_sync.auto")).toMatch(
			/not set in local/,
		);
	});
});

describe("onlooker config get", () => {
	it("reports the shipped default when nothing overrides it", () => {
		const w = world();
		expect(config(w, "get", "librarian.lesson_sync.auto")).toBe(
			"librarian.lesson_sync.auto = false  (default)",
		);
	});

	// The plugins' own order: defaults, user, user-local, project, local.
	it("reports the winning layer, in the order the plugins merge them", () => {
		const w = world();
		writeJson(join(w.configDir, "settings.json"), {
			librarian: { lesson_sync: { auto: true, min_interval_minutes: 5 } },
		});
		writeJson(join(w.repo, ".claude", "settings.json"), {
			librarian: { lesson_sync: { min_interval_minutes: 10 } },
		});
		writeJson(join(w.repo, ".claude", "settings.local.json"), {
			librarian: { lesson_sync: { min_interval_minutes: 20 } },
		});
		expect(config(w, "get", "librarian.lesson_sync.auto")).toBe(
			"librarian.lesson_sync.auto = true  (user)",
		);
		expect(config(w, "get", "librarian.lesson_sync.min_interval_minutes")).toBe(
			"librarian.lesson_sync.min_interval_minutes = 20  (local)",
		);
	});

	it("prints JSON with --json", () => {
		const w = world();
		expect(
			JSON.parse(config(w, "get", "librarian.lesson_sync.auto", "--json")),
		).toEqual({
			key: "librarian.lesson_sync.auto",
			value: false,
			origin: "default",
			file: null,
		});
	});
});

describe("onlooker config list", () => {
	it("lists every setting a plugin ships, with where each value came from", () => {
		const w = world();
		writeJson(join(w.repo, ".claude", "settings.json"), {
			librarian: { lesson_auto: { visibility: "public" } },
		});
		const out = config(w, "list", "librarian");
		expect(out.split("\n")).toEqual([
			"librarian.enabled = true  (default)",
			'librarian.lesson_auto.visibility = "public"  (project)',
			"librarian.lesson_sync.auto = false  (default)",
			"librarian.lesson_sync.min_interval_minutes = 60  (default)",
			"librarian.lesson_sync.remind = true  (default)",
		]);
	});
});

describe("onlooker config, through the CLI", () => {
	it("is dispatched, and exits 1 for a usage error", async () => {
		const w = world();
		const env = { ...w.env, NO_COLOR: "1" };
		const cwd = process.cwd();
		try {
			process.chdir(w.repo);
			expect(
				await run(
					[
						"node",
						"onlooker",
						"config",
						"set",
						"librarian.lesson_sync.auto",
						"true",
					],
					env,
				),
			).toBe(0);
			expect(await run(["node", "onlooker", "config", "frobnicate"], env)).toBe(
				1,
			);
		} finally {
			process.chdir(cwd);
		}
		expect(readJson(join(w.repo, ".claude", "settings.local.json"))).toEqual({
			librarian: { lesson_sync: { auto: true } },
		});
	});

	it("throws CliError, not a crash, for a user mistake", () => {
		const w = world();
		expect(() => config(w, "get")).toThrow(CliError);
	});
});
