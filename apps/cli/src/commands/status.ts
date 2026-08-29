import { ApiError, createClient } from "../api";
import { configPath, readConfig } from "../config";
import { discoverApproved, parseLesson } from "../lessons";

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
	// Padded to the width of the longest label, so every value starts in the
	// same column. `Lessons:` is one character wider than the rest and used to
	// push its own line out of alignment with them.
	const lines = [
		`API:     ${config.apiBaseUrl}`,
		`Config:  ${configPath(env)}`,
	];

	if (!config.machineToken) {
		lines.push("Token:   not linked - run `onlooker link`");
	} else {
		try {
			await createClient(
				config.apiBaseUrl,
				config.machineToken,
				fetchImpl,
			).verify();
			lines.push("Token:   accepted");
		} catch (error) {
			// A stored token that stopped working is the case worth surfacing: it
			// looks linked right up until something tries to use it.
			//
			// Only a 401 says the token is what is wrong, though. An unreachable
			// API or a moved endpoint says nothing at all about the credential,
			// and calling those a rejection sends someone on a flaky network to
			// revoke and re-mint a token that was fine - in the one command whose
			// entire job is telling them what is actually broken.
			const failure = error instanceof ApiError ? error.failure : undefined;
			const detail = failure ? failure.message : (error as Error).message;
			lines.push(
				failure?.kind === "unauthorized"
					? `Token:   rejected - ${detail}`
					: `Token:   unknown - ${detail}`,
			);
		}
	}

	const found = discoverApproved(env);
	if (found.kind === "no-onlooker-dir") {
		// The same two sentences `sync` gives, because they are two different
		// situations: nothing has ever written here, versus the ecosystem has run
		// but librarian has not. Collapsing them discards the distinction
		// `lessons.ts` exists to draw.
		lines.push(
			`Lessons: none - ${found.path} does not exist, so no plugin has run here yet`,
		);
	} else if (found.kind === "no-librarian-dir") {
		lines.push(
			`Lessons: none - ${found.path} does not exist, so librarian has not run here yet`,
		);
	} else {
		// Parseable lessons, not files. `sync` counts what it can actually send,
		// and a status that advertises lessons `sync` will refuse is worse than
		// no count at all - it makes the two commands look like they disagree.
		const ready = found.files.filter((file) => parseLesson(file).ok).length;
		const unreadable = found.files.length - ready;
		lines.push(
			`Lessons: ${ready} approved lesson${ready === 1 ? "" : "s"} ready to sync` +
				(unreadable > 0 ? `, ${unreadable} that cannot be read` : ""),
		);
	}

	return lines.join("\n");
}
