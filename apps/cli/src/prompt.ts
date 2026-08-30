import { createInterface, type Interface } from "node:readline";

/**
 * Stop readline echoing what is typed, and say whether that worked.
 *
 * `_writeToOutput` is readline's internal line-refresh hook rather than public
 * API, so its presence is checked instead of assumed - and checked *before* the
 * assignment, because assigning it would make any later check pass no matter
 * what. The prompt has to be passed in because the hook is the only thing that
 * can redraw it after readline's own clear. That ordering is the whole point: this prompt shipped once against
 * `node:readline/promises`, whose Interface has no such hook, and the override
 * landed as an own property nothing ever called. The token went to the screen
 * in clear text and the code that meant to hide it looked correct.
 */
export function suppressEcho(rl: Interface, prompt: string): boolean {
	const internals = rl as unknown as {
		_writeToOutput?: (text: string) => void;
	};
	if (typeof internals._writeToOutput !== "function") return false;
	internals._writeToOutput = (text: string) => {
		// Readline clears the whole line before every full refresh, and that
		// clear goes straight to the output stream rather than through this
		// hook. Swallowing everything therefore hides the typed characters and
		// the prompt with them, leaving a person staring at a blank line with
		// no idea the command is waiting - which is exactly what shipped in
		// 2.0.0. A full refresh passes `prompt + input`, so redrawing just the
		// prompt puts back what the clear removed. Anything else is the
		// per-keystroke echo, which is the thing being hidden.
		if (typeof text === "string" && text.startsWith(prompt)) {
			process.stdout.write(prompt);
		}
	};
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
const PROMPT = "Machine token: ";

/**
 * Build the readline interface `promptForToken` reads the token through.
 *
 * Extracted so a test can assert against the interface this module actually
 * constructs. Every other test in the suite builds its own interface, which
 * means all of them stay green if the import above changes back to
 * `node:readline/promises` - measured, 4/4 passing against that regression.
 * Nothing else in the file ties an assertion to this module's own import.
 */
export function createPromptInterface(
	input: NodeJS.ReadableStream,
	output: NodeJS.WritableStream,
): Interface {
	return createInterface({ input, output });
}

export async function promptForToken(): Promise<string> {
	if (!process.stdin.isTTY) {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks).toString("utf8");
	}

	const rl = createPromptInterface(process.stdin, process.stdout);
	// The prompt goes to `question` rather than being written here, so readline
	// knows it and passes it to the hook on every refresh. Writing it directly
	// does not survive: readline clears the line before drawing.
	if (!suppressEcho(rl, PROMPT)) {
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
			rl.question(PROMPT, resolve);
		});
	} finally {
		rl.close();
		process.stdout.write("\n");
	}
}
