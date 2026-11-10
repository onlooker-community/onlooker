import { ApiError } from "./api";

/**
 * A failure the CLI meant to raise, with a message for the person at the
 * keyboard: a config it could not read, a token nobody entered, a local file
 * in a shape it refuses to guess at.
 *
 * Its own class so a crash report can leave it out. Every one of these names
 * a local path or the user's own setup, and none is a defect anyone but the
 * user can fix.
 */
export class CliError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliError";
	}
}

/**
 * `EACCES`, `ENOSPC`, `EISDIR`, `E2BIG`: Node's names for what the OS
 * refused. A few carry a digit, so the pattern allows one.
 */
const ERRNO = /^E[A-Z0-9]+$/;

/**
 * Whether an error reaching `run()`'s catch is a defect worth reporting.
 *
 * Everything the CLI or the API said on purpose is excluded, and so is the
 * operating system refusing something. What remains is the case nobody wrote
 * a message for: a TypeError, a parser that assumed a shape, an unguarded
 * JSON.parse. Node's own `ERR_*` codes are not errno names, so they still
 * count.
 */
export function isCrash(error: unknown): boolean {
	if (error instanceof ApiError || error instanceof CliError) return false;
	const code = (error as { code?: unknown } | null | undefined)?.code;
	return !(typeof code === "string" && ERRNO.test(code));
}
