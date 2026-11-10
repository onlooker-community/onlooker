import { ApiError } from "./api";
import { crashReports } from "./commands/crash-reports";
import { doctor } from "./commands/doctor";
import { link } from "./commands/link";
import { playbook } from "./commands/playbook";
import { status } from "./commands/status";
import { sync } from "./commands/sync";
import { isCrash } from "./errors";
import { reportCrash } from "./monitoring";
import { promptForToken } from "./prompt";
import {
	accent,
	bad,
	header,
	muted,
	pill,
	resolveTheme,
	stripSgr,
	type Theme,
	withSpinner,
} from "./ui";

// No argument-parsing library. Six commands and one flag do not justify one,
// and a switch is easier to read than the framework would be.
const COMMANDS: Array<[name: string, does: string]> = [
	["link", "connect this machine with a token from the Machines page"],
	["sync", "push every approved lesson"],
	["playbook", "which mirrored lessons apply here"],
	["status", "what is linked, and what is waiting"],
	["doctor", "which plugin streams are still recording"],
	["crash-reports", "whether this CLI may report its own crashes"],
];

export function usage(theme: Theme): string {
	// Derived, not a constant: a fixed 9 made `repeat` throw a RangeError the
	// moment a command name outgrew it.
	const width = Math.max(...COMMANDS.map(([name]) => name.length)) + 2;
	const rows = COMMANDS.map(
		([name, does]) =>
			`  ${accent(theme, `onlooker ${name}`)}${" ".repeat(width - name.length)}${muted(theme, does)}`,
	);
	return `${pill(theme, "ONLOOKER")} push approved lessons to app.onlooker.dev\n\n${rows.join("\n")}\n`;
}

/**
 * Dispatch one invocation and return the exit code it earned.
 *
 * Separate from `main.ts` so a test can call it. `main.ts` is one line - the
 * top-level await that sets `process.exitCode` - and importing that file to
 * reach this function would run the CLI against the test runner's own argv.
 *
 * Exit codes carry the same distinction the messages do: 1 for something the
 * user must change, 2 for something a retry may fix. A script wrapping this can
 * then tell "stop and go look" from "try again later" without parsing text.
 */
export async function run(
	argv: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const out = resolveTheme(env, process.stdout);
	const err = resolveTheme(env, process.stderr);
	// Header, blank line, report. Only for a report: errors and `--json` are
	// read by people and programs that want the bytes and nothing else.
	const show = (command: string, text: string) =>
		console.log(`${header(out, command)}\n\n${text}`);
	const command = argv[2];
	// What a crash report may say about argv: a known command's name, never
	// the raw word, which can be a path or a pasted token.
	const commandTag =
		command === undefined
			? "none"
			: COMMANDS.some(([name]) => name === command)
				? command
				: "other";
	try {
		// A deliberate crash, so someone who turned reports on can check one
		// arrives. Thrown inside the try so it travels the real path.
		if (env.ONLOOKER_CRASH_TEST === "1") {
			throw new TypeError(
				"ONLOOKER_CRASH_TEST: a deliberate crash, to check reports arrive",
			);
		}
		if (command === "link") {
			show("link", await link({ prompt: promptForToken, theme: out }));
		} else if (command === "sync") {
			show(
				"sync",
				await withSpinner(err, "syncing lessons…", () => sync({ theme: out })),
			);
		} else if (command === "playbook") {
			const json = argv.includes("--json");
			const text = await playbook({ json, theme: out });
			if (json) console.log(text);
			else show("playbook", text);
		} else if (command === "status") {
			show("status", await status({ theme: out }));
		} else if (command === "doctor") {
			// The only command that returns its own exit code. A stopped
			// stream is a finding rather than an exception, so it cannot
			// travel out through the catch below without losing the report.
			const report = await withSpinner(err, "surveying streams…", () =>
				doctor({ theme: out }),
			);
			show("doctor", report.text);
			return report.code;
		} else if (command === "crash-reports") {
			show("crash-reports", crashReports(argv[3], { theme: out }));
		} else if (
			command === undefined ||
			command === "--help" ||
			command === "-h" ||
			command === "help"
		) {
			console.log(usage(out));
		} else {
			// Not the same event as asking for help, and it must not print the same
			// bytes. Someone who typed `onlooker snyc` and got the usage on stdout
			// with no other word has to diff it against the help text to work out
			// that anything went wrong.
			console.error(bad(err, `✕ unknown command: ${command}`));
			console.error(usage(err));
			return 1;
		}
		return 0;
	} catch (error) {
		const failure = error instanceof ApiError ? error.failure : undefined;
		const message = failure ? failure.message : (error as Error).message;
		// A thrown message can carry stdout's styling: sync builds its report
		// before it knows the report is a failure. stderr decides for itself.
		console.error(
			`${bad(err, "✕")} ${err.color ? message : stripSgr(message)}`,
		);
		// After the message, never instead of it: the line above is what the
		// user and any wrapping script read, and a report changes neither it
		// nor the exit code.
		if (
			isCrash(error) &&
			(await reportCrash(error, { command: commandTag }, { env }))
		) {
			console.error(
				muted(err, "reported this crash (onlooker crash-reports off to stop)"),
			);
		}
		return failure?.kind === "transient" ? 2 : 1;
	}
}
