import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where the CLI keeps the machine token, and which API it talks to.
 *
 * Deliberately one flat JSON file rather than a config library. There are two
 * settings; a library would be more code than the thing it configures.
 */
export interface CliConfig {
	apiBaseUrl: string;
	machineToken?: string;
}

const DEFAULT_API = "https://api.onlooker.dev";

/**
 * `$ONLOOKER_DIR`, or `~/.onlooker`. The ecosystem's plugins write here, so the
 * CLI reads its config from the same root it reads lessons from - one directory
 * to back up, one to delete.
 *
 * The `env` parameter is not decoration: it is what lets the tests run against a
 * temp directory instead of the developer's real home.
 */
export function onlookerDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.ONLOOKER_DIR ?? join(homedir(), ".onlooker");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(onlookerDir(env), "cli.json");
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
	const path = configPath(env);
	let stored: Partial<CliConfig> = {};

	try {
		stored = JSON.parse(readFileSync(path, "utf8")) as Partial<CliConfig>;
	} catch (error) {
		// A missing file is the first-run case and means "no token yet". Anything
		// else - malformed JSON, a permissions problem - is a real fault, and
		// treating it as absent would silently discard a token the user pasted
		// and send them back to `onlooker link` with no idea why.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`${path} could not be read: ${(error as Error).message}`);
		}
	}

	return {
		apiBaseUrl: env.ONLOOKER_API_URL ?? stored.apiBaseUrl ?? DEFAULT_API,
		machineToken: stored.machineToken,
	};
}

export function writeConfig(
	config: CliConfig,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const path = configPath(env);
	mkdirSync(dirname(path), { recursive: true });
	// 0600 from the moment it exists. Writing world-readable and chmod-ing after
	// leaves a window where the token is readable by anyone on the machine.
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
