import { createInterface } from "node:readline/promises";
import { ApiError } from "./api";
import { link } from "./commands/link";
import { status } from "./commands/status";
import { sync } from "./commands/sync";

// No argument-parsing library. Three commands and no flags do not justify one,
// and a switch is easier to read than the framework would be.
const USAGE = `onlooker - push approved lessons to app.onlooker.dev

  onlooker link     connect this machine with a token from the Machines page
  onlooker sync     push every approved lesson
  onlooker status   what is linked, and what is waiting
`;

/**
 * Read a credential without putting it on screen.
 *
 * A pasted machine token is shown once and recoverable only by revoking the
 * machine, so it should not survive in the scrollback. Reading stdin when it is
 * not a TTY also lets `echo "$TOKEN" | onlooker link` work in a script.
 */
async function promptForToken(): Promise<string> {
	if (!process.stdin.isTTY) {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks).toString("utf8");
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	// Suppress the echo of typed characters while still writing the prompt.
	//
	// `_writeToOutput` is readline's internal line-refresh hook, not public API.
	// Verified present on the Interface prototype in Node 24.13.0, and verified
	// under a real PTY that assigning it on the instance does suppress the echo.
	// The prompt is written first, deliberately: after the override nothing
	// reaches the terminal, including the prompt itself.
	const internals = rl as unknown as { _writeToOutput?: (s: string) => void };
	process.stdout.write("Machine token: ");
	internals._writeToOutput = () => {};
	try {
		return await rl.question("");
	} catch (error) {
		// Ctrl+D rejects the question with an AbortError. That is a person saying
		// "never mind" at a credential prompt - one of the two normal ways to back
		// out - and letting it propagate prints a Node stack trace instead.
		// Returning empty routes it into the same "No token entered" message an
		// empty paste gets. Confirmed against Node 24.13.0, which rejects with
		// `AbortError: Aborted with Ctrl+D`.
		if ((error as Error)?.name === "AbortError") return "";
		throw error;
	} finally {
		rl.close();
		process.stdout.write("\n");
	}
}

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
