import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ConfigDirSource, resolveConfigDir } from "./enablement";
import { CliError } from "./errors";
import { atomicWrite } from "./pool";

/** The marketplace whose plugins read these settings. */
const MARKETPLACE = "onlooker-community";

/** Where `set` and `unset` may write. Claude Code's own `--scope` names. */
export type Scope = "user" | "project" | "local";

/**
 * Every layer the plugins merge, in the order they merge them, latest
 * winning. This is `config-loader.sh` in onlooker-community/ecosystem, which
 * every plugin's config reads through; mirrored rather than shared because the
 * two live in different repos, so the tests pin the order.
 */
export const LAYERS = [
	"default",
	"user",
	"user-local",
	"project",
	"local",
] as const;
export type Layer = (typeof LAYERS)[number];

export interface SettingsDeps {
	cwd: string;
	env: NodeJS.ProcessEnv;
	home?: string;
}

export interface SettingsFiles {
	user: string;
	userLocal: string;
	project: string;
	local: string;
	/** The worktree root, which is what an installed plugin's projectPath names. */
	worktree: string;
	parent: string;
	configDir: string;
	configDirSource: ConfigDirSource;
}

/**
 * The worktree and the main checkout, from one git call.
 *
 * They differ in a linked worktree, and the plugins read a different file
 * from each: `settings.json` is committed, so a worktree on a branch has its
 * own; `settings.local.json` is gitignored, so `git worktree add` never copies
 * it and it lives only in the main checkout. A local setting written into the
 * worktree would be a file no plugin reads (ecosystem-449.37).
 *
 * `--git-common-dir` is relative to cwd in a normal checkout and absolute in a
 * linked worktree, so it is resolved against cwd. Outside git there is no
 * project boundary, so cwd is the project, as the loader also decides.
 */
function projectRoots(cwd: string): { worktree: string; parent: string } {
	try {
		const out = execFileSync(
			"git",
			["rev-parse", "--show-toplevel", "--git-common-dir"],
			{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
		const [toplevel, commonDir] = out.split("\n");
		if (toplevel && commonDir) {
			return {
				worktree: realpathSync(toplevel),
				parent: dirname(realpathSync(resolve(cwd, commonDir))),
			};
		}
	} catch {
		// Not a repository, or no git: the plain-directory case below.
	}
	const dir = realpathSync(cwd);
	return { worktree: dir, parent: dir };
}

export function settingsFiles(deps: SettingsDeps): SettingsFiles {
	const home = deps.home ?? homedir();
	const { worktree, parent } = projectRoots(deps.cwd);
	const resolved = resolveConfigDir(deps.env, home);
	return {
		user: join(resolved.path, "settings.json"),
		userLocal: join(resolved.path, "settings.local.json"),
		project: join(worktree, ".claude", "settings.json"),
		local: join(parent, ".claude", "settings.local.json"),
		worktree,
		parent,
		configDir: resolved.path,
		configDirSource: resolved.source,
	};
}

export function scopeFile(files: SettingsFiles, scope: Scope): string {
	return scope === "user"
		? files.user
		: scope === "project"
			? files.project
			: files.local;
}

function layerFile(files: SettingsFiles, layer: Layer): string | null {
	switch (layer) {
		case "default":
			return null;
		case "user":
			return files.user;
		case "user-local":
			return files.userLocal;
		case "project":
			return files.project;
		case "local":
			return files.local;
	}
}

export type Json =
	| null
	| boolean
	| number
	| string
	| Json[]
	| { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A settings file's contents, `{}` when it does not exist.
 *
 * Throws rather than returning `{}` for a file that will not parse. Every
 * caller either reports from it or rewrites it, and rewriting a file read as
 * empty would replace someone's settings with the one key being set.
 */
export function readSettingsFile(path: string): JsonObject {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new CliError(
			`${path} could not be read: ${(error as Error).message}. Fix or remove it first.`,
		);
	}
	if (!isObject(parsed)) {
		throw new CliError(
			`${path} could not be read: not a JSON object. Fix or remove it first.`,
		);
	}
	return parsed;
}

export function writeSettingsFile(path: string, settings: JsonObject): void {
	mkdirSync(dirname(path), { recursive: true });
	atomicWrite(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Installed onlooker plugins, by name, from `installed_plugins.json`. */
function installed(files: SettingsFiles): Map<string, unknown[]> {
	const path = join(files.configDir, "plugins", "installed_plugins.json");
	const plugins = new Map<string, unknown[]>();
	if (!existsSync(path)) return plugins;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new CliError(
			`${path} could not be read: ${(error as Error).message}`,
		);
	}
	const entries = isObject(parsed) ? parsed.plugins : undefined;
	if (!isObject(entries)) return plugins;
	for (const [key, value] of Object.entries(entries)) {
		const [name, marketplace] = key.split("@");
		if (marketplace === MARKETPLACE && name && Array.isArray(value)) {
			plugins.set(name, value);
		}
	}
	return plugins;
}

export function installedPlugins(files: SettingsFiles): string[] {
	return [...installed(files).keys()].sort();
}

/**
 * The shipped defaults of one installed plugin: its `config.json`, under the
 * plugin's own key.
 *
 * The install this project runs: a project-scoped install for this worktree
 * or its main checkout, else the user-scoped one. Two installs can ship
 * different keys, and the one that runs here is the one whose keys mean
 * anything.
 */
export function pluginDefaults(
	files: SettingsFiles,
	plugin: string,
): JsonObject {
	const installs = installed(files).get(plugin);
	if (installs === undefined) {
		const where = join(files.configDir, "plugins", "installed_plugins.json");
		const guess =
			files.configDirSource === "default"
				? " CLAUDE_CONFIG_DIR is not set, so this may be the wrong config directory."
				: "";
		throw new CliError(
			`${plugin} is not installed: ${where} has no ${plugin}@${MARKETPLACE}.${guess}`,
		);
	}
	const entries = installs.filter(isObject);
	const here = entries.find(
		(entry) =>
			entry.scope === "project" &&
			(entry.projectPath === files.worktree ||
				entry.projectPath === files.parent),
	);
	const chosen =
		here ?? entries.find((entry) => entry.scope === "user") ?? entries[0];
	const installPath =
		chosen && typeof chosen.installPath === "string"
			? chosen.installPath
			: null;
	if (installPath === null) return {};
	const config = join(installPath, "config.json");
	if (!existsSync(config)) return {};
	const shipped = readSettingsFile(config)[plugin];
	return isObject(shipped) ? shipped : {};
}

/** `plugin.a.b` as its plugin and the path beneath it. */
export function parseKey(key: string | undefined): {
	plugin: string;
	path: string[];
} {
	const parts = (key ?? "").split(".");
	if (parts.length < 2 || parts.some((part) => part === "")) {
		throw new CliError(
			`a key names a plugin and a setting, like librarian.lesson_sync.auto, not ${JSON.stringify(key ?? "")}`,
		);
	}
	const [plugin, ...path] = parts;
	return { plugin: plugin as string, path };
}

export function getPath(
	root: Json | undefined,
	path: string[],
): { found: boolean; value?: Json } {
	let node: Json | undefined = root;
	for (const part of path) {
		if (!isObject(node) || !(part in node)) return { found: false };
		node = node[part];
	}
	return { found: true, value: node as Json };
}

export function setPath(root: JsonObject, path: string[], value: Json): void {
	let node = root;
	for (const part of path.slice(0, -1)) {
		const next = node[part];
		if (!isObject(next)) node[part] = {};
		node = node[part] as JsonObject;
	}
	node[path[path.length - 1] as string] = value;
}

/**
 * Delete the key, then every object it leaves empty on the way back up. An
 * empty `librarian: {}` is noise a person reading the file has to wonder about.
 * Returns whether the key was there.
 */
export function deletePath(root: JsonObject, path: string[]): boolean {
	const [head, ...rest] = path;
	if (head === undefined || !(head in root)) return false;
	if (rest.length === 0) {
		delete root[head];
		return true;
	}
	const child = root[head];
	if (!isObject(child) || !deletePath(child, rest)) return false;
	if (Object.keys(child).length === 0) delete root[head];
	return true;
}

/** Every leaf beneath `node`, as dotted paths. Arrays are leaves. */
export function leaves(
	node: Json | undefined,
	prefix: string[] = [],
): string[][] {
	if (
		!isObject(node) ||
		(Object.keys(node).length === 0 && prefix.length > 0)
	) {
		return prefix.length === 0 ? [] : [prefix];
	}
	return Object.entries(node).flatMap(([key, value]) =>
		leaves(value, [...prefix, key]),
	);
}

export interface Resolved {
	value: Json;
	origin: Layer;
	file: string | null;
}

/** Each layer's settings for one plugin, in merge order. */
export function pluginLayers(
	files: SettingsFiles,
	plugin: string,
	defaults: JsonObject,
): Array<{ layer: Layer; file: string | null; settings: Json | undefined }> {
	return LAYERS.map((layer) => {
		const file = layerFile(files, layer);
		const settings = file === null ? defaults : readSettingsFile(file)[plugin];
		return { layer, file, settings };
	});
}

/** The value the plugins would read for `path`, and which layer set it. */
export function resolveSetting(
	layers: ReturnType<typeof pluginLayers>,
	path: string[],
): Resolved | null {
	let winner: Resolved | null = null;
	for (const { layer, file, settings } of layers) {
		const hit = getPath(settings, path);
		if (hit.found) winner = { value: hit.value as Json, origin: layer, file };
	}
	return winner;
}

/** Edit distance, for naming the key someone probably meant. */
export function distance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let previous = row[0] as number;
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const saved = row[j] as number;
			row[j] = Math.min(
				(row[j] as number) + 1,
				(row[j - 1] as number) + 1,
				previous + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
			previous = saved;
		}
	}
	return row[b.length] as number;
}
