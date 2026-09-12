import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The marketplace whose plugins this command knows how to survey. */
const MARKETPLACE = "@onlooker-community";

/**
 * What `.claude/settings.json` says should be running.
 *
 * `unknown` is a distinct outcome rather than an empty `plugins` array because
 * the two claim different things. An empty array asserts that nothing should be
 * recording; a config we could not find or parse supports no such claim. Every
 * verdict downstream depends on this distinction - without it the command
 * reports a machine with no config as a machine with nothing wrong.
 */
export type Enablement =
	| { kind: "unknown"; reason: string }
	| { kind: "found"; plugins: string[]; source: string };

/** Nearest ancestor of `startDir` containing `relPath`, or null. */
export function findUp(startDir: string, relPath: string): string | null {
	let dir = startDir;
	for (;;) {
		const candidate = join(dir, relPath);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		// `dirname("/")` is `"/"`, so this is the root check on every platform.
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * The git repository containing `cwd`, or null outside one.
 *
 * Lives here rather than beside its other caller in `streams.ts` because the
 * project settings lookup below is what needs a repository boundary; the
 * session join imports it back.
 */
export function repoRoot(cwd: string): string | null {
	const dotGit = findUp(cwd, ".git");
	return dotGit === null ? null : dirname(dotGit);
}

/**
 * The directory whose `.claude/` holds this project's settings.
 *
 * The repository root rather than an ancestor walk from `cwd`, because that
 * walk got the project wrong from both ends. Unbounded, it ran to `/` and
 * merged whatever an unrelated ancestor declared - a checkouts directory, or
 * `$HOME/.claude` on a machine whose `CLAUDE_CONFIG_DIR` points elsewhere, as
 * this one's does. Started at `cwd`, which is wherever the command was run
 * rather than the repo root, it let `apps/cli/.claude/settings.json` shadow
 * the repository's own. Claude Code loads neither, so doctor's expected set
 * could disagree with what actually runs - and every verdict beneath that line
 * rests on it.
 *
 * Outside a repository there is no such boundary, so fall back to the nearest
 * ancestor holding a `.claude` directory. That keeps the command usable in a
 * plain directory without reintroducing the unbounded merge inside a repo,
 * which is where the misread was reachable.
 */
function projectDir(cwd: string): string | null {
	const root = repoRoot(cwd);
	if (root !== null) return root;
	const claude = findUp(cwd, ".claude");
	return claude === null ? null : dirname(claude);
}

interface Settings {
	enabledPlugins?: Record<string, unknown>;
}

/**
 * A read that either produced settings or a reason it could not.
 *
 * Tagged with `ok` rather than discriminated on the presence of an `error`
 * key, because the value being discriminated is parsed from a file: a
 * settings.json holding its own top-level `error` was read as a failure, its
 * whole layer discarded, and its non-string value rendered into the reason as
 * `[object Object]`. A discriminant a file's content can satisfy is not a
 * discriminant.
 */
type SettingsRead =
	| { ok: true; settings: Settings }
	| { ok: false; error: string };

function readSettings(path: string): SettingsRead {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) {
			return {
				ok: false,
				error: `${path} could not be read: not a JSON object`,
			};
		}
		const settings = parsed as Settings;
		const { enabledPlugins } = settings;
		// Present but not an object (null, a string, an array, a number) is a
		// malformed config, not an empty one - reporting "found, nothing
		// enabled" from garbage input would be a clean bill from a broken
		// file. A genuinely absent enabledPlugins is handled separately,
		// below, as "not a source" rather than an error.
		if (
			enabledPlugins !== undefined &&
			(typeof enabledPlugins !== "object" ||
				enabledPlugins === null ||
				Array.isArray(enabledPlugins))
		) {
			return {
				ok: false,
				error: `${path} could not be read: enabledPlugins is not an object`,
			};
		}
		return { ok: true, settings };
	} catch (error) {
		return {
			ok: false,
			error: `${path} could not be read: ${(error as Error).message}`,
		};
	}
}

/**
 * Where Claude Code keeps user-level settings.
 *
 * NOT `$HOME/.claude`. Claude Code exports `CLAUDE_CONFIG_DIR` to child
 * processes, and on a machine that sets it `$HOME/.claude` typically does not
 * exist at all - this machine's is `~/.claude-personal`. `CLAUDE_HOME` is not
 * exported by Claude Code but is honored first for parity.
 *
 * This mirrors `validate-path.sh:19` in `onlooker-community/ecosystem`, and the
 * correction that repo made to `config-loader.sh` in `057a40d` (#237), where
 * the hardcoded path made the user settings layer silently unreachable for
 * every plugin in every session. Mirrored rather than shared, because the two
 * live in different repos - so the test above pins the precedence.
 *
 * `||` rather than `??` on purpose: the shell chain is built from `:-`, which
 * falls through on an empty value, and `??` falls through only on null or
 * undefined. A wrapper running `export CLAUDE_HOME="$SOME_UNSET_VAR"` exports
 * the empty string; the shell skips it and `??` took it as the config dir,
 * making `globalPath` the relative `settings.json` and the user layer silently
 * unreachable. That is the same shape as #237 itself.
 */
export function userConfigDir(
	env: NodeJS.ProcessEnv,
	home: string,
	override?: string,
): string {
	return resolveConfigDir(env, home, override).path;
}

/**
 * Where the user config directory came from, not only what it is.
 *
 * The last element of the chain is an assertion nothing establishes: that a
 * config directory exists at `$HOME/.claude`. Claude Code exports
 * `CLAUDE_CONFIG_DIR` to its children, so a hook or an agent inherits it and
 * resolves correctly - while a person running the same command from their own
 * shell does not, and silently gets the default. On a multi-account machine
 * there is deliberately no `$HOME/.claude` at all.
 *
 * A caller that receives only a path cannot tell a resolved directory from a
 * guess, which is how a wrong answer gets reported with total confidence.
 * `source` is what lets a caller refuse to claim.
 */
export type ConfigDirSource =
	| "override"
	| "CLAUDE_HOME"
	| "CLAUDE_CONFIG_DIR"
	| "default";

export function resolveConfigDir(
	env: NodeJS.ProcessEnv,
	home: string,
	override?: string,
): { path: string; source: ConfigDirSource } {
	if (override) return { path: override, source: "override" };
	if (env.CLAUDE_HOME) return { path: env.CLAUDE_HOME, source: "CLAUDE_HOME" };
	if (env.CLAUDE_CONFIG_DIR) {
		return { path: env.CLAUDE_CONFIG_DIR, source: "CLAUDE_CONFIG_DIR" };
	}
	return { path: join(home, ".claude"), source: "default" };
}

/**
 * Directories under `home` that hold evidence of being a config directory.
 *
 * Evidence rather than a blind glob: a directory merely named `.claude-notes`
 * proves nothing, and listing it would send someone to the wrong place. A
 * `settings.json` or a `plugins/` is what makes one worth naming.
 *
 * Home-relative on the way out, because these appear in messages.
 */
export function configDirCandidates(home: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(home);
	} catch {
		return [];
	}

	return entries
		.filter((name) => name.startsWith(".claude"))
		.filter((name) =>
			["settings.json", "plugins"].some((marker) =>
				existsSync(join(home, name, marker)),
			),
		)
		.map((name) => `~/${name}`)
		.sort();
}

/**
 * The merged `enabledPlugins` map, before any marketplace filter.
 *
 * `unknown` carries the same meaning it does in `Enablement`: a layer was
 * found and could not be read, so no claim about the full set is supportable.
 *
 * Split out of `readEnablement` because the two callers want different
 * subsets and the identical layering. `doctor` judges only the plugins it
 * ships expectations for, so it filters to one marketplace; the machine
 * inventory reports every plugin installed, so it must not. Keeping the merge
 * in one place is what stops the global/project/`settings.local.json`
 * precedence from being reimplemented slightly differently for each.
 *
 * Values are preserved as written rather than reduced to the enabled set:
 * `false` is a decision someone made and reads differently from absence.
 */
export type EnabledMap =
	| { kind: "unknown"; reason: string }
	| { kind: "found"; enabled: Record<string, boolean>; source: string };

export function readEnabledMap(opts: {
	cwd: string;
	home?: string;
	/** Overrides the resolved config dir. Tests use it; callers should not. */
	configDir?: string;
	env?: NodeJS.ProcessEnv;
}): EnabledMap {
	const home = opts.home ?? homedir();
	const project = projectDir(opts.cwd);
	const resolved = resolveConfigDir(
		opts.env ?? process.env,
		home,
		opts.configDir,
	);
	const globalPath = join(resolved.path, "settings.json");

	const sources: string[] = [];
	const merged: Record<string, unknown> = {};
	const problems: string[] = [];

	// Merge the project's enabled set with the user's global one. Global
	// first, project second: `Object.assign` lets a later source overwrite
	// an earlier one key-for-key, so the project layer wins on conflict -
	// matching how Claude Code layers them, where a repo that switches a
	// plugin off has made a decision the global default should not undo.
	//
	// `settings.local.json` last, because it is the highest-precedence
	// project layer in Claude Code and the file a `/plugin` toggle writes
	// to. Skipping it meant someone could switch a plugin off for this
	// project and have doctor keep judging it against the committed value,
	// find no output, and report STOPPED forever - a permanent false
	// positive in the command built to stop crying wolf.
	for (const path of [
		globalPath,
		project === null ? null : join(project, ".claude", "settings.json"),
		project === null ? null : join(project, ".claude", "settings.local.json"),
	]) {
		if (path === null || !existsSync(path)) continue;
		const read = readSettings(path);
		if (!read.ok) {
			problems.push(read.error);
			continue;
		}
		const { enabledPlugins } = read.settings;
		if (enabledPlugins === undefined) continue;
		Object.assign(merged, enabledPlugins);
		sources.push(path);
	}

	// A layer that was found but could not be parsed takes priority over a
	// layer that parsed fine: we cannot know the full expected set with one
	// of them unreadable, so a surviving layer must not produce a confident
	// "found" that silently drops whatever the broken layer declared.
	if (problems.length > 0) {
		return { kind: "unknown", reason: problems.join("; ") };
	}

	if (sources.length === 0) {
		// Two different failures used to share this sentence. "No settings
		// declare enabledPlugins" is true of a real config directory that is
		// simply quiet; it is a misattribution when the user layer was never
		// reachable, because CLAUDE_CONFIG_DIR is unset and $HOME/.claude is
		// not this machine's config directory. The verdict is `unknown` either
		// way - only a reader trying to fix it can tell them apart.
		if (resolved.source === "default" && !existsSync(resolved.path)) {
			const candidates = configDirCandidates(home);
			const seen =
				candidates.length === 0
					? ""
					: ` These look like config directories: ${candidates.join(", ")}.`;
			return {
				kind: "unknown",
				reason: `CLAUDE_CONFIG_DIR is not set and ${join("~", ".claude")} does not exist, so no user settings could be read.${seen}`,
			};
		}

		return {
			kind: "unknown",
			reason: "no .claude/settings.json declares enabledPlugins",
		};
	}

	// `on` is whatever JSON held, not necessarily a boolean - coerce with
	// `=== true` rather than truthiness so a stray string like "false" cannot
	// read as enabled. Done here so both callers inherit it.
	const enabled: Record<string, boolean> = {};
	for (const [name, on] of Object.entries(merged)) enabled[name] = on === true;

	return { kind: "found", enabled, source: sources.join(", ") };
}

export function readEnablement(opts: {
	cwd: string;
	home?: string;
	/** Overrides the resolved config dir. Tests use it; callers should not. */
	configDir?: string;
	env?: NodeJS.ProcessEnv;
}): Enablement {
	const map = readEnabledMap(opts);
	if (map.kind === "unknown") return map;

	const plugins = Object.entries(map.enabled)
		.filter(([name, on]) => on && name.endsWith(MARKETPLACE))
		.map(([name]) => name.slice(0, -MARKETPLACE.length))
		// Sorted here rather than at render time, so every consumer of this
		// list gets the same order and no renderer has to remember to sort.
		.sort((a, b) => a.localeCompare(b));

	return { kind: "found", plugins, source: map.source };
}
