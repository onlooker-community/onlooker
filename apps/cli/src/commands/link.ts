import { createClient } from "../api";
import { readConfig, writeConfig } from "../config";

export interface LinkDeps {
	env?: NodeJS.ProcessEnv;
	/** Injected so tests never touch a TTY. `main.ts` supplies the real one. */
	prompt: () => Promise<string>;
	fetchImpl?: typeof fetch;
}

/**
 * Connect this machine to an account with a token minted on the Machines page.
 *
 * A paste rather than the device-authorization dance the retired CLI ran. The
 * server side of that dance no longer exists, and the browser already mints and
 * reveals exactly this credential - the reveal was built for it, and says as
 * much.
 */
export async function link({
	env = process.env,
	prompt,
	fetchImpl,
}: LinkDeps): Promise<string> {
	const token = (await prompt()).trim();
	if (!token) throw new Error("No token entered. Nothing was changed.");

	const config = readConfig(env);
	// Verified before it is written, never after. A token stored without checking
	// turns one clear rejection here into a puzzle at the next command.
	await createClient(config.apiBaseUrl, token, fetchImpl).verify();

	writeConfig({ ...config, machineToken: token }, env);
	// Deliberately does not echo the token: it is shown once, and repeating it
	// into the scrollback undoes the care the one-time reveal takes.
	return `Linked to ${config.apiBaseUrl}. Run \`onlooker sync\` to push lessons.`;
}
