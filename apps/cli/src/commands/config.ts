import { homedir } from "node:os";
import { configDirCandidates } from "../enablement";
import { CliError } from "../errors";
import {
	deletePath,
	distance,
	getPath,
	installedPlugins,
	isObject,
	type Json,
	leaves,
	parseKey,
	pluginDefaults,
	pluginLayers,
	readSettingsFile,
	resolveSetting,
	type Scope,
	type SettingsFiles,
	scopeFile,
	setPath,
	settingsFiles,
	writeSettingsFile,
} from "../settings";

export interface ConfigDeps {
	cwd: string;
	env: NodeJS.ProcessEnv;
	home?: string;
}

export const CONFIG_USAGE = [
	"onlooker config get <plugin.key> [--json]",
	"onlooker config set <plugin.key> <value> [--scope user|project|local] [--force]",
	"onlooker config unset <plugin.key> [--scope user|project|local]",
	"onlooker config list [plugin] [--json]",
	"",
	"Scopes are the files the plugins read, latest winning:",
	"  user     your Claude account's settings.json",
	"  project  this repository's .claude/settings.json, committed",
	"  local    this repository's .claude/settings.local.json, gitignored (the default)",
].join("\n");

interface Parsed {
	positional: string[];
	scope: Scope;
	force: boolean;
	json: boolean;
}

function parse(args: string[]): Parsed {
	const parsed: Parsed = {
		positional: [],
		scope: "local",
		force: false,
		json: false,
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--force") parsed.force = true;
		else if (arg === "--json") parsed.json = true;
		else if (arg === "--scope" || arg.startsWith("--scope=")) {
			const value = arg === "--scope" ? args[++i] : arg.slice(8);
			if (value !== "user" && value !== "project" && value !== "local") {
				throw new CliError(
					`scope must be user, project or local, not ${JSON.stringify(value ?? "")}`,
				);
			}
			parsed.scope = value;
		} else if (arg.startsWith("--")) {
			throw new CliError(`unknown option: ${arg}\n\n${CONFIG_USAGE}`);
		} else parsed.positional.push(arg);
	}
	return parsed;
}

/**
 * Coerce a typed word to the JSON type the shipped default has.
 *
 * The plugins compare with `== "true"` and read numbers with an integer
 * check, so a string "true" written where a boolean belongs reads as false,
 * silently. Matching the default's type is what keeps `set` from writing a
 * value that looks right in the file and is ignored.
 */
function coerce(key: string, raw: string, shipped: Json | undefined): Json {
	if (shipped === undefined || shipped === null) {
		try {
			return JSON.parse(raw) as Json;
		} catch {
			return raw;
		}
	}
	if (typeof shipped === "boolean") {
		if (raw === "true") return true;
		if (raw === "false") return false;
		throw new CliError(
			`${key} expects a boolean (true or false), not ${JSON.stringify(raw)}`,
		);
	}
	if (typeof shipped === "number") {
		const value = Number(raw);
		if (raw.trim() === "" || !Number.isFinite(value)) {
			throw new CliError(`${key} expects a number, not ${JSON.stringify(raw)}`);
		}
		return value;
	}
	if (typeof shipped === "string") return raw;
	const kind = Array.isArray(shipped) ? "array" : "object";
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new CliError(
			`${key} expects a JSON ${kind}, not ${JSON.stringify(raw)}`,
		);
	}
	if (
		(kind === "array") !== Array.isArray(value) ||
		(kind === "object" && !isObject(value))
	) {
		throw new CliError(
			`${key} expects a JSON ${kind}, not ${JSON.stringify(raw)}`,
		);
	}
	return value as Json;
}

/**
 * Refuse a user-scope write to a config directory nobody named.
 *
 * Claude Code exports CLAUDE_CONFIG_DIR to its children, so an agent gets
 * the right one; a person's shell may not, and then `$HOME/.claude` is a
 * guess. On a machine whose real directory is elsewhere, a setting written
 * there is read by no session (ONL-105).
 */
function guardUserScope(files: SettingsFiles, home: string): void {
	if (files.configDirSource !== "default") return;
	const others = configDirCandidates(home).filter((dir) => dir !== "~/.claude");
	if (others.length === 0) return;
	throw new CliError(
		`CLAUDE_CONFIG_DIR is not set, so user scope would write ${files.user}, which is a guess. These look like config directories: ${others.join(", ")}. Set CLAUDE_CONFIG_DIR to the one this machine uses.`,
	);
}

function show(key: string, value: Json, origin: string): string {
	return `${key} = ${JSON.stringify(value)}  (${origin})`;
}

/** The closest shipped key, for a refusal to name. */
function suggestion(plugin: string, path: string[], defaults: Json): string {
	const wanted = path.join(".");
	const known = leaves(defaults).map((leaf) => leaf.join("."));
	if (known.length === 0) return "";
	const best = known.reduce((a, b) =>
		distance(wanted, a) <= distance(wanted, b) ? a : b,
	);
	return ` Did you mean ${plugin}.${best}?`;
}

/**
 * `onlooker config get|set|unset|list`, over the settings files the plugins
 * read. Returns what to print; throws CliError for anything the person typed
 * wrong, so `run` exits 1 without a crash report.
 */
export function configCommand(args: string[], deps: ConfigDeps): string {
	const [action, ...rest] = args;
	if (action === undefined || action === "help" || action === "--help") {
		return CONFIG_USAGE;
	}
	const opts = parse(rest);
	const home = deps.home ?? homedir();
	const files = settingsFiles({ ...deps, home });

	if (action === "list") {
		const plugins =
			opts.positional[0] !== undefined
				? [opts.positional[0]]
				: installedPlugins(files);
		const rows = plugins.flatMap((plugin) => {
			const defaults = pluginDefaults(files, plugin);
			const layers = pluginLayers(files, plugin, defaults);
			const keys = new Map<string, string[]>();
			for (const { settings } of layers) {
				for (const leaf of leaves(settings)) keys.set(leaf.join("."), leaf);
			}
			return [...keys.entries()]
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([name, path]) => {
					const hit = resolveSetting(layers, path);
					return { key: `${plugin}.${name}`, ...hit };
				});
		});
		if (opts.json) return JSON.stringify(rows, null, 2);
		return rows
			.map((row) => show(row.key, row.value as Json, row.origin as string))
			.join("\n");
	}

	if (action !== "get" && action !== "set" && action !== "unset") {
		throw new CliError(`unknown action: ${action}\n\n${CONFIG_USAGE}`);
	}

	const key = opts.positional[0];
	const { plugin, path } = parseKey(key);

	if (action === "get") {
		const defaults = pluginDefaults(files, plugin);
		const hit = resolveSetting(pluginLayers(files, plugin, defaults), path);
		if (hit === null) {
			throw new CliError(
				`${key} is not set anywhere.${suggestion(plugin, path, defaults)}`,
			);
		}
		if (opts.json) {
			return JSON.stringify({
				key,
				value: hit.value,
				origin: hit.origin,
				file: hit.file,
			});
		}
		return show(key as string, hit.value, hit.origin);
	}

	if (opts.scope === "user") guardUserScope(files, home);
	const file = scopeFile(files, opts.scope);

	if (action === "unset") {
		const settings = readSettingsFile(file);
		if (!deletePath(settings, [plugin, ...path])) {
			return `${key} is not set in ${opts.scope} (${file}); nothing to remove.`;
		}
		writeSettingsFile(file, settings);
		return `Removed ${key} from ${opts.scope} (${file}).`;
	}

	const raw = opts.positional[1];
	if (raw === undefined) {
		throw new CliError(`set needs a value: onlooker config set ${key} <value>`);
	}
	const defaults = pluginDefaults(files, plugin);
	const shipped = getPath(defaults, path);
	if (!shipped.found && !opts.force) {
		throw new CliError(
			`${plugin} ships no setting ${path.join(".")}.${suggestion(plugin, path, defaults)} Use --force to write it anyway.`,
		);
	}
	const value = coerce(key as string, raw, shipped.value);
	const settings = readSettingsFile(file);
	setPath(settings, [plugin, ...path], value);
	writeSettingsFile(file, settings);
	return `Set ${key} = ${JSON.stringify(value)} in ${opts.scope} (${file}).`;
}
