import { ApiError, createClient } from "../api";
import { readConfig } from "../config";
import { batch, discoverApproved, MAX_BATCH, parseLesson } from "../lessons";

export interface SyncDeps {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}

/**
 * Push every approved lesson to the pool.
 *
 * Stateless on purpose. `POST /lessons` answers `created`, `noop`, `conflict`,
 * `invalid` or `error` per lesson rather than failing the whole request, so an
 * id the server already holds comes back `noop` rather than as an error - which
 * means re-running is free and a crashed run just runs again. That removes the
 * buffer, the cursor and the watermark the retired CLI carried, and with them
 * the failure where a dead endpoint filled a database forever.
 */
export async function sync({
	env = process.env,
	fetchImpl,
}: SyncDeps): Promise<string> {
	const config = readConfig(env);
	if (!config.machineToken) {
		throw new Error(
			"This machine is not linked. Mint a token on the Machines page and run `onlooker link`.",
		);
	}

	const found = discoverApproved(env);
	if (found.kind === "no-onlooker-dir") {
		return `Nothing to sync: ${found.path} does not exist, so no plugin has run here yet.`;
	}
	if (found.kind === "no-librarian-dir") {
		return `Nothing to sync: ${found.path} does not exist, so librarian has not run here yet.`;
	}
	if (found.files.length === 0) {
		return "Nothing to sync: no approved lessons yet.";
	}

	const lessons = [];
	const skipped: string[] = [];
	for (const file of found.files) {
		const parsed = parseLesson(file);
		// One malformed file does not stop the run. Aborting would let a single
		// bad lesson block every valid one behind it, and the file name plus the
		// failing field is enough to go fix it.
		if (parsed.ok) lessons.push(parsed.lesson);
		else skipped.push(`${parsed.file}: ${parsed.error}`);
	}

	const client = createClient(
		config.apiBaseUrl,
		config.machineToken,
		fetchImpl,
	);
	let created = 0;
	let unchanged = 0;
	// Split rather than lumped, because the API distinguishes "never send this
	// again" from "send it again in a minute" and the exit code has to carry
	// that difference out to whatever called us.
	const terminal: string[] = [];
	const retryable: string[] = [];

	for (const chunk of batch(lessons, MAX_BATCH)) {
		const response = await client.push(chunk);
		for (const result of response.results ?? []) {
			switch (result.outcome) {
				case "created":
					created++;
					break;
				case "noop":
					unchanged++;
					break;
				case "conflict":
					// Same id, different content. Not a failure to store, but not a
					// success either - the pool and this machine disagree, and only a
					// person can say which is right.
					terminal.push(`${result.id}: the pool holds a different version`);
					break;
				case "invalid":
					terminal.push(
						`${result.id}: rejected - ${result.error ?? "no reason given"}`,
					);
					break;
				default:
					// `error`, and anything a future API adds. Treated as retryable
					// because that is the safe direction to be wrong in: retrying a
					// lesson the server already holds costs one deduped request, while
					// discarding one the server never stored loses it for good.
					retryable.push(
						`${result.id}: ${result.error ?? "not stored; retry it"}`,
					);
			}
		}
	}

	const counts = [`${created} new`, `${unchanged} already in the pool`];
	if (skipped.length > 0) counts.push(`${skipped.length} skipped`);
	const summary = `Synced ${lessons.length} lessons: ${counts.join(", ")}.`;

	// A lesson the server did not store must never be reported as one it did.
	// Counting every non-`created` outcome as "already in the pool" is exactly
	// how the retired CLI turned a failure into a success message.
	if (retryable.length > 0) {
		throw new ApiError({
			kind: "transient",
			message: [
				`${retryable.length} lesson(s) were not stored. Run sync again.`,
				...retryable,
			].join("\n"),
		});
	}
	if (terminal.length > 0) {
		throw new ApiError({
			kind: "rejected",
			message: [`${terminal.length} lesson(s) were refused.`, ...terminal].join(
				"\n",
			),
		});
	}

	return [summary, ...skipped].join("\n");
}
