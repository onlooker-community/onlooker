import { homedir } from "node:os";
import { brewTrustFails, brewTrustLines, checkBrewTrust } from "../brew";
import { doctorLines, exitCodeFor, surveyStreams } from "../streams";
import type { Theme } from "../ui";

export interface DoctorDeps {
	/** Where to start looking for `.claude/settings.json` and the repo root. */
	cwd?: string;
	/** Overridable so tests never read the developer's real home. */
	home?: string;
	/** Overrides the resolved CLAUDE_CONFIG_DIR. Tests only. */
	configDir?: string;
	env?: NodeJS.ProcessEnv;
	/** How to style the report. Plain unless `cli.ts` found a terminal. */
	theme?: Theme;
	/** The running script, which says whether Homebrew installed it. Tests only. */
	binPath?: string;
}

/**
 * Which enabled streams are still recording, and which have stopped, and
 * whether Homebrew will keep this CLI up to date.
 *
 * Returns its exit code rather than throwing one. A stopped stream is a
 * finding, not an error: the report is the whole point, and throwing would
 * discard it in favor of a one-line message. A tap brew does not trust is a
 * finding for the same reason (ONL-65): `brew upgrade` skips it without
 * failing, so the machine stays on an old CLI and nothing says so.
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
	const home = deps.home ?? homedir();
	const brew = checkBrewTrust({
		env: deps.env,
		home,
		binPath: deps.binPath,
	});
	const brewLines = brewTrustLines(brew, home, deps.theme);
	return {
		text: [
			...doctorLines(survey, deps.theme),
			...(brewLines.length > 0 ? ["", ...brewLines] : []),
		].join("\n"),
		code: exitCodeFor(survey) === 1 || brewTrustFails(brew) ? 1 : 0,
	};
}
