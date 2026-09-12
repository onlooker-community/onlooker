import { ZLesson } from "@onlooker-community/lesson-contract";
import type { ApiClient, DeltaResponse } from "./api";
import { readCursor, writeCursor, writeLesson } from "./pool";

/** One window per request. The server clamps its own maximum. */
const DEFAULT_LIMIT = 100;

export type PullOutcome =
	| {
			kind: "received";
			created: number;
			updated: number;
			unchanged: number;
			/** Rows the contract refused, named by seq. Skipped, not fatal. */
			invalid: string[];
			cursor: number;
	  }
	| { kind: "gap"; expected: number; got: number; cursor: number }
	| { kind: "failed"; reason: string; cursor: number };

/**
 * Mirror the hosted delta to disk, one window at a time.
 *
 * Two rules carry this function, and both are about what happens when it does
 * not finish.
 *
 * **The cursor advances only after the window it describes is durably
 * written.** Advancing first is `ecosystem-449.55` one layer down - librarian's
 * watermark moves through an outage and the skipped artifacts are never
 * re-scanned - and that failure is invisible, because the watermark is the
 * thing claiming everything is fine. Re-fetching a window costs one redundant
 * request and is otherwise free, because writes upsert by id.
 *
 * **A gap stops the run and leaves the cursor.** `seq` is dense, so a hole
 * means a row that should exist did not come back. Restarting from zero would
 * hide exactly the anomaly `seq` exists to expose, while looking like a slow
 * but healthy run.
 *
 * Returns its outcome rather than throwing. The caller has already pushed by
 * the time this runs, and a receive failure must not erase that result.
 */
export async function pull(opts: {
	client: Pick<ApiClient, "readDelta">;
	env?: NodeJS.ProcessEnv;
	limit?: number;
}): Promise<PullOutcome> {
	const env = opts.env ?? process.env;
	const limit = opts.limit ?? DEFAULT_LIMIT;

	let cursor: number;
	try {
		cursor = readCursor(env);
	} catch (error) {
		// Nothing is requested. Without a trustworthy starting point, any
		// request we made would be a guess about what this machine holds.
		return { kind: "failed", reason: (error as Error).message, cursor: 0 };
	}

	let created = 0;
	let updated = 0;
	let unchanged = 0;
	const invalid: string[] = [];

	for (;;) {
		let window: DeltaResponse;
		try {
			window = await opts.client.readDelta(cursor, limit);
		} catch (error) {
			return { kind: "failed", reason: (error as Error).message, cursor };
		}

		// `api.ts` casts the body rather than validating it, so this is the
		// first place a response that is not the promised shape can be
		// noticed. Treated as a failure rather than as an empty window: a
		// moved or reshaped endpoint would otherwise read as "nothing is
		// waiting" forever, which is the exact failure the push path's own
		// count reconciliation exists to prevent.
		if (!Array.isArray(window.lessons)) {
			return {
				kind: "failed",
				reason: "the API answered the delta read without a lessons array",
				cursor,
			};
		}

		if (window.lessons.length === 0) break;

		// Contiguity first, before anything is written, so a window is
		// all-or-nothing rather than partially applied beneath a stale cursor.
		// Checked from `cursor + 1` rather than only within the window, so a
		// hole at the seam between two runs is caught as well.
		let expected = cursor + 1;
		for (const entry of window.lessons) {
			if (entry.seq !== expected) {
				return { kind: "gap", expected, got: entry.seq, cursor };
			}
			expected += 1;
		}

		try {
			for (const entry of window.lessons) {
				const parsed = ZLesson.safeParse(entry.lesson);
				if (!parsed.success) {
					// Recorded, skipped, and deliberately not fatal. A row the
					// contract refuses must not wedge every later lesson behind
					// it forever - one bad record would become a permanent
					// outage, and the cursor would never pass it.
					const issue = parsed.error.issues[0];
					invalid.push(
						`seq ${entry.seq}: ${issue?.path.join(".") || "(root)"}: ${
							issue?.message ?? "did not match the lesson contract"
						}`,
					);
					continue;
				}
				switch (writeLesson(parsed.data, env)) {
					case "created":
						created += 1;
						break;
					case "updated":
						updated += 1;
						break;
					default:
						unchanged += 1;
				}
			}
		} catch (error) {
			return { kind: "failed", reason: (error as Error).message, cursor };
		}

		// Only now. Everything this window described is on disk.
		const advanced = window.lessons[window.lessons.length - 1].seq;
		try {
			writeCursor(advanced, env);
		} catch (error) {
			return { kind: "failed", reason: (error as Error).message, cursor };
		}
		cursor = advanced;

		if (!window.has_more) break;
	}

	return { kind: "received", created, updated, unchanged, invalid, cursor };
}
