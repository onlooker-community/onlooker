import { type TLesson, ZLesson } from "@onlooker-community/lesson-contract";
import type { ApiClient, DeltaResponse } from "./api";
import { type Cursor, readCursor, writeCursor, writeLesson } from "./pool";

/** One window per request. The server clamps its own maximum. */
const DEFAULT_LIMIT = 100;

export type PullOutcome =
	| {
			kind: "received";
			created: number;
			updated: number;
			unchanged: number;
			/**
			 * Lessons held by an earlier run that arrived in this one. Already
			 * counted in created, updated or unchanged; this says how many of
			 * those were waiting.
			 */
			released: number;
			/**
			 * Every lesson still held after this run, named by seq with the
			 * contract's reason. Skipped, not fatal, and retried every run.
			 */
			held: string[];
			cursor: number;
	  }
	| { kind: "gap"; expected: number; got: number; cursor: number }
	| { kind: "failed"; reason: string; cursor: number };

/** `seq N: path: message`, from the contract's first complaint. */
function refusal(
	seq: number,
	error: { issues: Array<{ path: PropertyKey[]; message: string }> },
): string {
	const issue = error.issues[0];
	return `seq ${seq}: ${issue?.path.join(".") || "(root)"}: ${
		issue?.message ?? "did not match the lesson contract"
	}`;
}

/** The cursor to write, with the held list in seq order. */
function cursorOf(seq: number, held: Map<number, string>): Cursor {
	return { seq, held: [...held.keys()].sort((a, b) => a - b) };
}

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
 * A row the contract refuses is held rather than dropped (ONL-182). The API
 * validates every lesson against its own copy of the contract before writing
 * it, so a refusal here almost always means this CLI bundles an older contract
 * than the one the lesson was written under. The cursor still moves past it,
 * so it cannot wedge the mirror, but its seq is kept in the cursor file and
 * asked for again at the start of every run. Once an upgraded CLI accepts it,
 * it lands like any other lesson. That costs one request per held lesson per
 * run, which is the price of never losing one quietly.
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

	let stored: Cursor;
	try {
		stored = readCursor(env);
	} catch (error) {
		// Nothing is requested. Without a trustworthy starting point, any
		// request we made would be a guess about what this machine holds.
		return { kind: "failed", reason: (error as Error).message, cursor: 0 };
	}
	let cursor = stored.seq;

	let created = 0;
	let updated = 0;
	let unchanged = 0;
	let released = 0;
	// Keyed by seq, so a row refused again by a re-fetched window is still one
	// held lesson.
	const held = new Map<number, string>();

	const tally = (lesson: TLesson) => {
		switch (writeLesson(lesson, env)) {
			case "created":
				created += 1;
				break;
			case "updated":
				updated += 1;
				break;
			default:
				unchanged += 1;
		}
	};

	// Held lessons first. Each is the one-row window that starts just below
	// it, so the retry needs nothing from the API that the delta read does not
	// already offer.
	for (const seq of stored.held) {
		let window: DeltaResponse;
		try {
			window = await opts.client.readDelta(seq - 1, 1);
		} catch (error) {
			return { kind: "failed", reason: (error as Error).message, cursor };
		}
		if (!Array.isArray(window.lessons)) {
			return {
				kind: "failed",
				reason: "the API answered the delta read without a lessons array",
				cursor,
			};
		}

		const entry = window.lessons[0];
		// A deleted lesson takes its feed rows with it. The window then
		// starts at a later row, which is not this one and which the main
		// loop has already handled, so there is nothing left to hold.
		if (entry?.seq !== seq) continue;

		const parsed = ZLesson.safeParse(entry.lesson);
		if (!parsed.success) {
			held.set(seq, refusal(seq, parsed.error));
			continue;
		}
		try {
			tally(parsed.data);
		} catch (error) {
			return { kind: "failed", reason: (error as Error).message, cursor };
		}
		released += 1;
	}

	if (stored.held.length > 0) {
		// Written once the whole list has been asked about. A failure partway
		// leaves the stored list as it was, and a lesson that did land is only
		// written again as unchanged next run.
		try {
			writeCursor(cursorOf(cursor, held), env);
		} catch (error) {
			return { kind: "failed", reason: (error as Error).message, cursor };
		}
	}

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
					// Held, skipped, and deliberately not fatal. A row the
					// contract refuses must not wedge every later lesson behind
					// it forever - one bad record would become a permanent
					// outage, and the cursor would never pass it.
					held.set(entry.seq, refusal(entry.seq, parsed.error));
					continue;
				}
				tally(parsed.data);
			}
		} catch (error) {
			return { kind: "failed", reason: (error as Error).message, cursor };
		}

		// Only now. Everything this window described is on disk, and every
		// row it refused is in the held list written beside the cursor.
		const advanced = window.lessons[window.lessons.length - 1].seq;
		try {
			writeCursor(cursorOf(advanced, held), env);
		} catch (error) {
			return { kind: "failed", reason: (error as Error).message, cursor };
		}
		cursor = advanced;

		if (!window.has_more) break;
	}

	return {
		kind: "received",
		created,
		updated,
		unchanged,
		released,
		held: [...held.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, reason]) => reason),
		cursor,
	};
}
