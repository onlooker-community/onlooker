import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	configDirCandidates,
	readEnabledMap,
	repoRoot,
	resolveConfigDir,
} from "./enablement";

/**
 * One place a plugin is installed, and what is installed there.
 *
 * A scope rather than a version per plugin, because installs are genuinely
 * per-project: the same plugin is routinely present at the user level and
 * pinned to something else inside a repository. Reducing that to one version
 * would be a guess presented as a fact.
 */
export interface InventoryScope {
	/** `"user"`, or a home-relative project path like `~/src/foo`. */
	scope: string;
	version: string;
	git_commit_sha: string | null;
	installed_at: string | null;
	last_updated: string | null;
	/**
	 * `null` is unknowable, not false.
	 *
	 * Enablement for a project is declared in that project's own `.claude`,
	 * and this command only ever opens one of them - the one it ran in. For
	 * every other project scope the honest answer is that we did not look.
	 */
	enabled: boolean | null;
}

export interface InventoryPlugin {
	/** As keyed in `installed_plugins.json`, e.g. `librarian@onlooker-community`. */
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

/**
 * `unavailable` rather than an empty inventory, for the reason the
 * `Enablement` type gives: an empty list asserts that nothing is installed,
 * and a file we could not read supports no such claim. The Machines page
 * renders the two differently and must be able to.
 */
export type Collected =
	| { kind: "collected"; inventory: Inventory }
	| { kind: "unavailable"; reason: string };

/** `~/src/foo` for a path under home; the path unchanged otherwise. */
function homeRelative(path: string, home: string): string {
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** One entry from `installed_plugins.json`, read defensively. */
function scopeFrom(
	raw: unknown,
	home: string,
): { scope: string; partial: Omit<InventoryScope, "enabled"> } {
	const entry = (raw ?? {}) as Record<string, unknown>;
	const scope =
		entry.scope === "project" && typeof entry.projectPath === "string"
			? homeRelative(entry.projectPath, home)
			: "user";

	return {
		scope,
		partial: {
			scope,
			// A missing version is reported as unknown rather than dropped. The
			// install exists either way, and hiding it would understate the
			// machine.
			version: typeof entry.version === "string" ? entry.version : "unknown",
			git_commit_sha:
				typeof entry.gitCommitSha === "string" ? entry.gitCommitSha : null,
			installed_at:
				typeof entry.installedAt === "string" ? entry.installedAt : null,
			last_updated:
				typeof entry.lastUpdated === "string" ? entry.lastUpdated : null,
		},
	};
}

/**
 * What is installed on this machine, and which of it is switched on.
 *
 * Every marketplace, not just this one's. `readEnablement` filters to
 * `@onlooker-community` because `doctor` judges only plugins it ships
 * expectations for; an inventory that hid two thirds of the fleet would not be
 * fleet visibility.
 */
export function collectInventory(opts: {
	cwd: string;
	home?: string;
	/** Overrides the resolved config dir. Tests use it; callers should not. */
	configDir?: string;
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
}): Collected {
	const home = opts.home ?? homedir();
	const env = opts.env ?? process.env;
	const resolved = resolveConfigDir(env, home, opts.configDir);
	const file = join(resolved.path, "plugins", "installed_plugins.json");

	if (!existsSync(file)) {
		// Which of the two failures this is matters, and the old message could
		// not tell them apart. A directory we were told to use and found empty
		// is a real answer. A directory we guessed at is not an answer at all -
		// Claude Code exports CLAUDE_CONFIG_DIR to its children, so an agent
		// resolves correctly while the person running the same command from
		// their own shell silently gets $HOME/.claude.
		if (resolved.source === "default") {
			const candidates = configDirCandidates(home);
			const seen =
				candidates.length === 0
					? "No directory under your home looks like one."
					: `These look like config directories: ${candidates.join(", ")}.`;
			return {
				kind: "unavailable",
				reason: `CLAUDE_CONFIG_DIR is not set, so this looked in ${homeRelative(file, home)} and found nothing. ${seen} Set CLAUDE_CONFIG_DIR to the one this machine uses.`,
			};
		}

		return {
			kind: "unavailable",
			reason: `${homeRelative(file, home)} does not exist, so nothing is installed for this config directory.`,
		};
	}

	let parsed: { plugins?: Record<string, unknown> };
	try {
		parsed = JSON.parse(readFileSync(file, "utf8")) as {
			plugins?: Record<string, unknown>;
		};
	} catch (error) {
		return {
			kind: "unavailable",
			reason: `${homeRelative(file, home)} could not be read: ${(error as Error).message}`,
		};
	}

	const project = repoRoot(opts.cwd);
	const projectScope = project === null ? null : homeRelative(project, home);
	const enabled = readEnabledMap({
		cwd: opts.cwd,
		home,
		configDir: opts.configDir,
		env,
	});

	const enabledFor = (scope: string, id: string): boolean | null => {
		if (enabled.kind === "unknown") return null;
		if (scope === "user" || scope === projectScope) {
			return enabled.enabled[id] === true;
		}
		return null;
	};

	const plugins: InventoryPlugin[] = Object.entries(parsed.plugins ?? {})
		.map(([id, entries]) => ({
			id,
			scopes: (Array.isArray(entries) ? entries : []).map((raw) => {
				const { scope, partial } = scopeFrom(raw, home);
				return { ...partial, enabled: enabledFor(scope, id) };
			}),
		}))
		// Sorted so two reports from an unchanged machine are byte-identical.
		// Without it, a diff between reports would track object key order
		// rather than anything that happened on the machine.
		.sort((a, b) => a.id.localeCompare(b.id));

	return {
		kind: "collected",
		inventory: {
			schema_version: 1,
			collected_at: (opts.now?.() ?? new Date()).toISOString(),
			project: projectScope,
			plugins,
		},
	};
}
