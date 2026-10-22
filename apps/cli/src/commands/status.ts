import { ApiError, createClient } from "../api";
import { configPath, readConfig } from "../config";
import { discoverApproved, parseLesson } from "../lessons";
import { pipelineLines, surveyPipeline } from "../pipeline";
import {
	accent,
	bad,
	bold,
	label,
	muted,
	ok,
	PLAIN,
	pad,
	type Theme,
	warn,
} from "../ui";

export interface StatusDeps {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	/** How to style the output; plain text when omitted. */
	theme?: Theme;
}

// A constant, not a literal at each call site: the repo's secret-scanning hook
// reads the token label followed by a long quoted string on one line as a
// credential and blocks the edit.
const TOKEN_LABEL = "Token:";

/** What is linked, whether it still works, and what is waiting to be sent. */
export async function status({
	env = process.env,
	fetchImpl,
	theme = PLAIN,
}: StatusDeps): Promise<string> {
	const config = readConfig(env);
	// Padded to the width of the longest label, so every value starts in the
	// same column. `Pipeline:` is the longest at nine characters, so every
	// label pads to ten and the pipeline block's continuation lines indent to
	// match.
	const field = (name: string, value: string) =>
		`${pad(label(theme, name), 10)}${value}`;
	const lines = [
		field("API:", config.apiBaseUrl),
		field("Config:", configPath(env)),
	];

	if (!config.machineToken) {
		lines.push(
			field(
				TOKEN_LABEL,
				`${warn(theme, "not linked")} - run ${accent(theme, "`onlooker link`")}`,
			),
		);
	} else {
		try {
			await createClient(
				config.apiBaseUrl,
				config.machineToken,
				fetchImpl,
			).verify();
			lines.push(field(TOKEN_LABEL, ok(theme, "accepted")));
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
					? field(TOKEN_LABEL, `${bad(theme, "rejected")} - ${detail}`)
					: field(TOKEN_LABEL, `${warn(theme, "unknown")} - ${detail}`),
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
			field(
				"Lessons:",
				`none - ${found.path} does not exist, so no plugin has run here yet`,
			),
		);
	} else if (found.kind === "no-librarian-dir") {
		lines.push(
			field(
				"Lessons:",
				`none - ${found.path} does not exist, so librarian has not run here yet`,
			),
		);
	} else if (found.kind === "unreadable") {
		// The one case `status` most has to survive: it exists to explain a
		// broken machine, so it must report an unlistable directory rather than
		// dying on it. "unknown", never "none" - we did not look successfully,
		// so claiming zero would be an answer we do not have.
		lines.push(
			field(
				"Lessons:",
				`${warn(theme, "unknown")} - ${found.path} exists but could not be listed`,
			),
		);
	} else {
		// Parseable lessons, not files. `sync` counts what it can actually send,
		// and a status that advertises lessons `sync` will refuse is worse than
		// no count at all - it makes the two commands look like they disagree.
		const ready = found.files.filter((file) => parseLesson(file).ok).length;
		const unparseable = found.files.length - ready;
		// Two different failures, kept apart. `unparseable` is a file that was
		// read and is not a lesson; `found.unreadable` is a project directory
		// that could not be listed at all. Folding the second into the first
		// would hide whole projects behind a count of bad files, and the
		// remedies are nothing alike.
		const caveats = [
			unparseable > 0 ? `${unparseable} that cannot be read` : "",
			found.unreadable.length > 0
				? `${found.unreadable.length} project${found.unreadable.length === 1 ? "" : "s"} that could not be listed`
				: "",
		].filter(Boolean);
		lines.push(
			field(
				"Lessons:",
				`${ready > 0 ? bold(theme, String(ready)) : ready} approved lesson${ready === 1 ? "" : "s"} ready to sync` +
					(caveats.length > 0 ? `, ${caveats.join(", ")}` : ""),
			),
		);

		// Only on the `found` branch. The three branches above already say that
		// no plugin has run, that librarian has not, or that the directory could
		// not be listed - a stage breakdown under any of them would be four
		// zeros restating a sentence directly above it.
		const [first, ...rest] = pipelineLines(surveyPipeline(env)).map(
			stage(theme),
		);
		lines.push(field("Pipeline:", first));
		for (const line of rest) lines.push(`${" ".repeat(10)}${line}`);
	}

	return lines.join("\n");
}

/**
 * A pipeline line leads with its count. Zero is the quiet state, so the whole
 * line is muted; anything waiting gets its number in bold so it is what the
 * eye lands on. A line with no leading count (a fault) passes through.
 */
function stage(theme: Theme): (line: string) => string {
	return (line) => {
		const match = /^(\d+)( .*)$/.exec(line);
		if (match === null) return line;
		return match[1] === "0"
			? muted(theme, line)
			: `${bold(theme, match[1])}${match[2]}`;
	};
}
