import { createInterface, type Interface } from "node:readline";

/**
 * Stop readline echoing what is typed, and say whether that worked.
 *
 * `_writeToOutput` is readline's internal line-refresh hook rather than public
 * API, so its presence is checked instead of assumed - and checked *before* the
 * assignment, because assigning it would make any later check pass no matter
 * what. That ordering is the whole point: this prompt shipped once against
 * `node:readline/promises`, whose Interface has no such hook, and the override
 * landed as an own property nothing ever called. The token went to the screen
 * in clear text and the code that meant to hide it looked correct.
 */
export function suppressEcho(rl: Interface): boolean {
	const internals = rl as unknown as {
		_writeToOutput?: (text: string) => void;
	};
	if (typeof internals._writeToOutput !== "function") return false;
	internals._writeToOutput = () => {};
	return true;
}

/**
 * Read a credential without putting it on screen.
 *
 * A pasted machine token is shown once and recoverable only by revoking the
 * machine, so it should not survive in the scrollback. Reading stdin when it is
 * not a TTY also lets `echo "$TOKEN" | onlooker link` work in a script.
 *
 * The callback `node:readline` deliberately, not `node:readline/promises`: only
 * the callback Interface consults `_writeToOutput`, so only it can be told not
 * to echo. Verified under a pty on Node 24.13.0.
 */
export async function promptForToken(): Promise<string> {
	if (!process.stdin.isTTY) {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks).toString("utf8");
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	// The prompt is written before the override, deliberately: readline's own
	// prompt rendering goes through the hook this is about to silence.
	process.stdout.write("Machine token: ");
	if (!suppressEcho(rl)) {
		// A visible warning is survivable; a silent leak is not. Someone told the
		// token is on screen can revoke it. Someone not told cannot.
		process.stdout.write(
			"\nWarning: this Node build cannot hide typed input - your token will be " +
				"visible.\nMachine token: ",
		);
	}

	try {
		return await new Promise<string>((resolve) => {
			// Ctrl+D is a person saying "never mind" at a credential prompt - one of
			// the two normal ways to back out - and on the callback API it arrives
			// as `close` with the question never answered. Resolving "" routes it
			// into the same "No token entered" message an empty paste gets, rather
			// than a Node stack trace. Whichever listener fires first wins; the
			// other resolve is a no-op.
			rl.on("close", () => resolve(""));
			rl.question("", resolve);
		});
	} finally {
		rl.close();
		process.stdout.write("\n");
	}
}
