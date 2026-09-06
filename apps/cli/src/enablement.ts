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
function userConfigDir(
	env: NodeJS.ProcessEnv,
	home: string,
	override?: string,
): string {
	return (
		override ||
		env.CLAUDE_HOME ||
		env.CLAUDE_CONFIG_DIR ||
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
	const project = projectDir(opts.cwd);
	const globalPath = join(
		userConfigDir(opts.env ?? process.env, home, opts.configDir),
		"settings.json",
	);

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
