import { readConfig, writeConfig } from "../config";
import { crashConsent, describeConsent } from "../consent";
import { CliError } from "../errors";
import { PLAIN, type Theme } from "../ui";

export interface CrashReportsDeps {
	env?: NodeJS.ProcessEnv;
	/** How to style the output; plain text when omitted. */
	theme?: Theme;
}

/**
 * What `on` prints, so the choice is made knowing what it sends.
 *
 * This is the user-facing statement of the policy in
 * docs/superpowers/specs/2026-11-09-cli-crash-reports-design.md. If the
 * payload changes, this text changes with it.
 */
export const WHAT_IS_SENT = [
	"A crash report contains:",
	"  the error's type, message and stack, with your home directory shown as ~,",
	"  file paths cut to file names, and anything credential-shaped removed",
	"  the CLI version, the command you ran (not its arguments), your OS,",
	"  CPU architecture and Node major version",
	"",
	"It never contains:",
	"  your hostname, username, account, machine token or email",
	"  the directory you ran it in, your environment, file contents or lesson text",
	"",
	"Only unexpected errors are reported: never a refused request, a network",
	"failure, or a problem with your own files.",
	"Turn it off with `onlooker crash-reports off`, or set DO_NOT_TRACK=1.",
].join("\n");

/**
 * `onlooker crash-reports on|off|status`. No argument means `status`.
 *
 * The only way a machine opts in. Nothing prompts for it, so nothing can be
 * agreed to by a CI run or a script piping through.
 */
export function crashReports(
	action: string | undefined,
	{ env = process.env, theme = PLAIN }: CrashReportsDeps = {},
): string {
	if (action === "on" || action === "off") {
		writeConfig({ ...readConfig(env), crashReports: action === "on" }, env);
	} else if (action !== undefined && action !== "status") {
		throw new CliError(
			`unknown action: ${action}. Use onlooker crash-reports on, off or status.`,
		);
	}

	const line = `Crash reports: ${describeConsent(crashConsent(env), theme)}`;
	return action === "on" ? `${line}\n\n${WHAT_IS_SENT}` : line;
}
