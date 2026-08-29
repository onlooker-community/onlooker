import type { TLesson } from "@onlooker-community/lesson-contract";
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

	const lessons: TLesson[] = [];
	const skipped: string[] = [];
	for (const file of found.files) {
		const parsed = parseLesson(file);
		// One malformed file does not stop the run. Aborting would let a single
		// bad lesson block every valid one behind it, and the file name plus the
		// failing field is enough to go fix it. Skipping is not succeeding,
		// though: the list is reported as a failure at the end.
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
		// `api.ts` casts the response body rather than validating it, so this is
		// the first place a body that is not the promised shape can be noticed.
		const results = Array.isArray(response.results) ? response.results : [];
		for (const result of results) {
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

		// Every lesson sent has to come back named. A 200 that answers for fewer
		// lessons than it was given is what a moved or reshaped endpoint looks
		// like from this side, and tallying only what came back would print
		// "Synced 3 lessons: 0 new, 0 already in the pool." and exit 0 -
		// arithmetic that contradicts itself, reported as success.
		//
		// Unanswered goes in with the retryable, the same safe direction the
		// `error` outcome takes: retrying a lesson the server already holds costs
		// one deduped request, while assuming it landed loses it.
		const answered = new Set(results.map((result) => result.id));
		for (const lesson of chunk) {
			if (!answered.has(lesson.id)) {
				retryable.push(`${lesson.id}: the API did not answer for it; retry it`);
			}
		}
	}

	const counts = [`${created} new`, `${unchanged} already in the pool`];
	if (skipped.length > 0) counts.push(`${skipped.length} skipped`);
	const pushed = lessons.length;
	const summary = `Synced ${pushed} lesson${pushed === 1 ? "" : "s"}: ${counts.join(", ")}.`;

	// Every kind of trouble in one report, not whichever kind came first. A
	// lesson that fails permanently must not hide behind one that fails
	// intermittently: throwing only the transient error leaves someone running
	// `sync` again forever while the real problem sits there, never named.
	const problems: string[] = [];
	if (retryable.length > 0) {
		problems.push(
			`${retryable.length} lesson(s) were not stored. Run sync again.`,
			...retryable,
		);
	}
	if (terminal.length > 0) {
		problems.push(`${terminal.length} lesson(s) were refused.`, ...terminal);
	}
	if (skipped.length > 0) {
		problems.push(
			`${skipped.length} file(s) could not be read as a lesson.`,
			...skipped,
		);
	}

	// A lesson the server did not store must never be reported as one it did.
	// Counting every non-`created` outcome as "already in the pool" is exactly
	// how the retired CLI turned a failure into a success message - and so is
	// returning normally because the trouble happened on disk, before the
	// request, rather than on the wire during it. Throwing is what puts the
	// whole report on stderr and a non-zero code on the process.
	if (problems.length > 0) {
		throw new ApiError({
			// `transient` the moment anything is worth retrying, so the exit code
			// still says "run it again" while the terminal detail rides along in
			// the message. Otherwise `rejected`: a file the contract refuses and a
			// lesson the pool refuses are both unchanged by waiting, and telling
			// someone to retry costs them the time it takes to find that out.
			kind: retryable.length > 0 ? "transient" : "rejected",
			message: [summary, ...problems].join("\n"),
		});
	}

	return summary;
}
