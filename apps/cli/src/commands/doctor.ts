import { doctorLines, exitCodeFor, surveyStreams } from "../streams";

export interface DoctorDeps {
	/** Where to start looking for `.claude/settings.json` and the repo root. */
	cwd?: string;
	/** Overridable so tests never read the developer's real home. */
	home?: string;
	/** Overrides the resolved CLAUDE_CONFIG_DIR. Tests only. */
	configDir?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * Which enabled streams are still recording, and which have stopped.
 *
 * Returns its exit code rather than throwing one. A stopped stream is a
 * finding, not an error: the report is the whole point, and throwing would
 * discard it in favor of a one-line message.
 */
export async function doctor(
	deps: DoctorDeps = {},
): Promise<{ text: string; code: number }> {
	const survey = await surveyStreams({
		cwd: deps.cwd ?? process.cwd(),
		home: deps.home,
		configDir: deps.configDir,
		env: deps.env,
	});
	return { text: doctorLines(survey).join("\n"), code: exitCodeFor(survey) };
}
