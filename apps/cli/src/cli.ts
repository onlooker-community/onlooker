import { ApiError } from "./api";
import { doctor } from "./commands/doctor";
import { link } from "./commands/link";
import { status } from "./commands/status";
import { sync } from "./commands/sync";
import { promptForToken } from "./prompt";

// No argument-parsing library. Three commands and no flags do not justify one,
// and a switch is easier to read than the framework would be.
export const USAGE = `onlooker - push approved lessons to app.onlooker.dev

  onlooker link     connect this machine with a token from the Machines page
  onlooker sync     push every approved lesson
  onlooker status   what is linked, and what is waiting
  onlooker doctor   which plugin streams are still recording
`;

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
export async function run(argv: string[]): Promise<number> {
	const command = argv[2];
	try {
		if (command === "link") {
			console.log(await link({ prompt: promptForToken }));
		} else if (command === "sync") {
			console.log(await sync({}));
		} else if (command === "status") {
			console.log(await status({}));
		} else if (command === "doctor") {
			// The only command that returns its own exit code. A stopped
			// stream is a finding rather than an exception, so it cannot
			// travel out through the catch below without losing the report.
			const report = await doctor({});
			console.log(report.text);
			return report.code;
		} else if (
			command === undefined ||
			command === "--help" ||
			command === "-h" ||
			command === "help"
		) {
			console.log(USAGE);
		} else {
			// Not the same event as asking for help, and it must not print the same
			// bytes. Someone who typed `onlooker snyc` and got the usage on stdout
			// with no other word has to diff it against the help text to work out
			// that anything went wrong.
			console.error(`unknown command: ${command}`);
			console.error(USAGE);
			return 1;
		}
		return 0;
	} catch (error) {
		const failure = error instanceof ApiError ? error.failure : undefined;
		console.error(failure ? failure.message : (error as Error).message);
		return failure?.kind === "transient" ? 2 : 1;
	}
}
