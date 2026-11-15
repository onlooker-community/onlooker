import { createClient } from "../api";
import {
	type CliConfig,
	readConfig,
	readStoredConfig,
	writeConfig,
} from "../config";
import { CliError } from "../errors";
import { muted, ok, PLAIN, type Theme, warn } from "../ui";

export interface ProjectLabelsDeps {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	theme?: Theme;
}

/**
 * What `on` prints, so the choice is made knowing what it sends. The
 * user-facing statement of docs/superpowers/specs/2026-11-15-cli-project-labels-design.md.
 */
export const WHAT_IS_SENT = [
	"Each sync then sends a name for each project this machine reported:",
	"  for a repository with a remote, its owner/repo, private repositories",
	"  included (git@github.com:acme/api.git is sent as acme/api)",
	"  for a repository with no remote, its folder name",
	"",
	"It never sends:",
	"  the remote's host, port or credentials, the full path, or branch names",
	"",
	"A name you give a project on the web always wins over this one.",
	"Turn it off with `onlooker project-labels off`, which also deletes the",
	"names this machine sent.",
].join("\n");

/** One line for `status` and this command. */
export function describeLabels(config: CliConfig, theme: Theme): string {
	if (config.projectLabelsPending === "delete") {
		return warn(theme, "off, deletion pending - the next sync retries it");
	}
	if (config.projectLabels === true) return ok(theme, "on");
	return `off ${muted(theme, "- `onlooker project-labels on` to name projects from git")}`;
}

/**
 * `onlooker project-labels on|off|status`. No argument means `status`.
 *
 * `off` records the choice before it asks the API to delete, so a sync that
 * runs while the request is failing still uploads nothing.
 */
export async function projectLabels(
	action: string | undefined,
	{ env = process.env, fetchImpl, theme = PLAIN }: ProjectLabelsDeps = {},
): Promise<string> {
	if (action !== undefined && !["on", "off", "status"].includes(action)) {
		throw new CliError(
			`unknown action: ${action}. Use onlooker project-labels on, off or status.`,
		);
	}
	if (action === "on") {
		writeConfig({ ...readStoredConfig(env), projectLabels: true }, env);
		return `Project labels: ${describeLabels(readConfig(env), theme)}\n\n${WHAT_IS_SENT}`;
	}
	if (action === "off") {
		writeConfig({ ...readStoredConfig(env), projectLabels: false }, env);
		const deleted = await deleteUploaded(env, fetchImpl);
		const line = `Project labels: ${describeLabels(readConfig(env), theme)}`;
		return deleted === null ? line : `${line}\n${deleted}`;
	}
	return `Project labels: ${describeLabels(readConfig(env), theme)}`;
}

/**
 * Ask the API to delete this machine's labels, and record the outcome. A
 * note to print, or null when the machine is not linked and nothing could
 * have been sent from it.
 */
export async function deleteUploaded(
	env: NodeJS.ProcessEnv,
	fetchImpl?: typeof fetch,
): Promise<string | null> {
	const config = readConfig(env);
	if (!config.machineToken) return null;
	try {
		const { deleted } = await createClient(
			config.apiBaseUrl,
			config.machineToken,
			fetchImpl,
		).deleteProjectLabels();
		const { projectLabelsPending: _done, ...rest } = readStoredConfig(env);
		writeConfig(rest, env);
		return `Deleted ${deleted} ${deleted === 1 ? "name" : "names"} this machine sent.`;
	} catch (error) {
		writeConfig(
			{ ...readStoredConfig(env), projectLabelsPending: "delete" },
			env,
		);
		return `Could not delete the names this machine sent: ${(error as Error).message}. Deletion pending; the next sync retries it.`;
	}
}
