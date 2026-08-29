import { ApiError } from "./api";
import { link } from "./commands/link";
import { status } from "./commands/status";
import { sync } from "./commands/sync";
import { promptForToken } from "./prompt";

// No argument-parsing library. Three commands and no flags do not justify one,
// and a switch is easier to read than the framework would be.
const USAGE = `onlooker - push approved lessons to app.onlooker.dev

  onlooker link     connect this machine with a token from the Machines page
  onlooker sync     push every approved lesson
  onlooker status   what is linked, and what is waiting
`;

/**
 * Exit codes carry the same distinction the messages do: 1 for something the
 * user must change, 2 for something a retry may fix. A script wrapping this can
 * then tell "stop and go look" from "try again later" without parsing text.
 */
async function run(argv: string[]): Promise<number> {
	const command = argv[2];
	try {
		if (command === "link") {
			console.log(await link({ prompt: promptForToken }));
		} else if (command === "sync") {
			console.log(await sync({}));
		} else if (command === "status") {
			console.log(await status({}));
		} else {
			console.log(USAGE);
			return command === undefined || command === "--help" ? 0 : 1;
		}
		return 0;
	} catch (error) {
		const failure = error instanceof ApiError ? error.failure : undefined;
		console.error(failure ? failure.message : (error as Error).message);
		return failure?.kind === "transient" ? 2 : 1;
	}
}

process.exitCode = await run(process.argv);
