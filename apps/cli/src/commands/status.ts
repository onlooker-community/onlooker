import { ApiError, createClient } from "../api";
import { configPath, readConfig } from "../config";
import { discoverApproved } from "../lessons";

export interface StatusDeps {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}

/** What is linked, whether it still works, and what is waiting to be sent. */
export async function status({
	env = process.env,
	fetchImpl,
}: StatusDeps): Promise<string> {
	const config = readConfig(env);
	const lines = [`API:    ${config.apiBaseUrl}`, `Config: ${configPath(env)}`];

	if (!config.machineToken) {
		lines.push("Token:  not linked - run `onlooker link`");
	} else {
		try {
			await createClient(
				config.apiBaseUrl,
				config.machineToken,
				fetchImpl,
			).verify();
			lines.push("Token:  accepted");
		} catch (error) {
			// A stored token that stopped working is the case worth surfacing: it
			// looks linked right up until something tries to use it.
			const detail =
				error instanceof ApiError
					? error.failure.message
					: (error as Error).message;
			lines.push(`Token:  rejected - ${detail}`);
		}
	}

	const found = discoverApproved(env);
	if (found.kind === "no-onlooker-dir") {
		lines.push(`Lessons: none - ${found.path} does not exist`);
	} else if (found.kind === "no-librarian-dir") {
		lines.push(`Lessons: none - ${found.path} does not exist`);
	} else {
		const n = found.files.length;
		lines.push(
			`Lessons: ${n} approved lesson${n === 1 ? "" : "s"} ready to sync`,
		);
	}

	return lines.join("\n");
}
