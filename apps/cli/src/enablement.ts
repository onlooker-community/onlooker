import { existsSync, readFileSync } from "node:fs";
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

interface Settings {
	enabledPlugins?: Record<string, unknown>;
}

function readSettings(path: string): Settings | { error: string } {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) {
			return { error: `${path} could not be read: not a JSON object` };
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
				error: `${path} could not be read: enabledPlugins is not an object`,
			};
		}
		return settings;
	} catch (error) {
		return { error: `${path} could not be read: ${(error as Error).message}` };
	}
}

/**
 * Merge the project's enabled set with the user's global one.
 *
 * Project wins on conflict, matching how Claude Code layers them: a repo that
 * switches a plugin off has made a decision the global default should not undo.
 */
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
 */
function userConfigDir(
	env: NodeJS.ProcessEnv,
	home: string,
	override?: string,
): string {
	return (
		override ??
		env.CLAUDE_HOME ??
		env.CLAUDE_CONFIG_DIR ??
		join(home, ".claude")
	);
}

export function readEnablement(opts: {
	cwd: string;
	home?: string;
	/** Overrides the resolved config dir. Tests use it; callers should not. */
	configDir?: string;
	env?: NodeJS.ProcessEnv;
}): Enablement {
	const home = opts.home ?? homedir();
	const projectPath = findUp(opts.cwd, join(".claude", "settings.json"));
	const globalPath = join(
		userConfigDir(opts.env ?? process.env, home, opts.configDir),
		"settings.json",
	);

	const sources: string[] = [];
	const merged: Record<string, unknown> = {};
	const problems: string[] = [];

	for (const path of [globalPath, projectPath]) {
		if (path === null || !existsSync(path)) continue;
		const settings = readSettings(path);
		if ("error" in settings) {
			problems.push(settings.error);
			continue;
		}
		if (settings.enabledPlugins === undefined) continue;
		Object.assign(merged, settings.enabledPlugins);
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
		return {
			kind: "unknown",
			reason: "no .claude/settings.json declares enabledPlugins",
		};
	}

	const plugins = Object.entries(merged)
		// `on` is whatever JSON held, not necessarily a boolean - coerce
		// with `=== true` rather than truthiness so a stray string like
		// "false" cannot read as enabled.
		.filter(([name, on]) => on === true && name.endsWith(MARKETPLACE))
		.map(([name]) => name.slice(0, -MARKETPLACE.length))
		// Sorted here rather than at render time, so every consumer of this
		// list gets the same order and no renderer has to remember to sort.
		.sort((a, b) => a.localeCompare(b));

	return { kind: "found", plugins, source: sources.join(", ") };
}
