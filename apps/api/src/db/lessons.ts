import type { D1Database } from "@cloudflare/workers-types";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { canonicalize } from "../utils/canonical.js";

/**
 * EVERY query that touches `lessons` or `lesson_feed` belongs in this file.
 *
 * The contract spec designates the visibility filter as the security boundary:
 * "A bug there leaks private lessons, so it belongs in exactly one place rather
 * than spread across every query site." That is a structural requirement, and
 * this module is the one place. Task 9 adds a test that enforces it by refusing
 * to let any route build its own lesson query.
 */

/** A lesson as stored, before its body is parsed. */
export interface StoredLesson {
	id: string;
	user_id: string;
	visibility: string;
	status: string;
	body: string;
}

/**
 * Sequence assignment gave up after MAX_SEQ_ATTEMPTS.
 *
 * A named class rather than a plain Error, for two reasons. It is what lets a
 * route answer 503 - "the pool is contended, come back" - instead of the 500
 * that a bare Error collapses into, which is what the spec asks for. And
 * `errorHandler` echoes `error.message` into the response body verbatim, so
 * the message this replaced published the internal user id to anyone who could
 * provoke contention. The id now travels as a property, where the handler
 * cannot reach it, and remains available for logging.
 */
export class SequenceExhaustedError extends Error {
	constructor(
		public readonly userId: string,
		public readonly attempts: number,
	) {
		super(`could not assign a lesson sequence after ${attempts} attempts`);
		this.name = "SequenceExhaustedError";
	}
}

/**
 * How many times to retry a sequence collision before giving up.
 *
 * A collision means two pushes for the same user computed the same next value
 * and the unique index rejected the loser. That is expected under concurrency
 * and cheap to retry; exhausting five attempts means sustained contention, not
 * a transient race, and is worth surfacing rather than looping.
 */
const MAX_SEQ_ATTEMPTS = 5;

/**
 * Does this D1 failure mean the named table's unique constraint rejected us?
 *
 * The whole retry/500 decision hangs on D1's error TEXT, which is a vendor
 * string nothing in our build pins. Exported so it can be tested against the
 * literal messages SQLite emits - if D1 ever reformats them, every concurrent
 * push would start 500ing instead of retrying, and without a test on these
 * strings nothing would notice.
 *
 * `table` is matched as a substring, so callers pass the most specific form
 * available: "lessons.id" rather than "lessons", which would also match
 * "lesson_feed" messages in a future where a column is renamed.
 */
export function isUniqueViolationOn(error: unknown, table: string): boolean {
	return (
		error instanceof Error &&
		/UNIQUE constraint failed/i.test(error.message) &&
		error.message.includes(table)
	);
}

/** What the batch write decided for one lesson, in the order it was given. */
export type BatchWrite =
	| { outcome: "created"; seq: number }
	| { outcome: "taken" };

/**
 * How many ids one existence lookup may ask about.
 *
 * D1 caps bound parameters per query at 100, and MAX_BATCH is 100 lessons, so
 * an unchunked `IN` list would sit exactly on the limit. Half of it leaves
 * room and still answers a full batch in two round-trips.
 */
const ID_LOOKUP_CHUNK = 50;

/**
 * Insert a whole batch of lessons and their feed rows in ONE transaction.
 *
 * The batch is the unit, not the lesson, and that is a correctness requirement
 * rather than an optimization. Assigning per lesson means each one runs its own
 * MAX(seq)+1, so a concurrent push interleaves between them: machine A is told
 * `seq 5` and `seq 7` while machine B takes 6. The spec invites a client to
 * advance its cursor to the returned seq without a follow-up read, so that
 * client advances past 6 and never receives it - and the contiguity check
 * cannot catch it, because the gap was never inside a delivered window.
 *
 * Raw prepared statements rather than the drizzle builder, because `batch` is
 * the transaction primitive here and every statement must land together. A
 * lesson row without its feed entry is invisible to every mirror; a feed entry
 * without its lesson breaks the join.
 *
 * A UNIQUE(user_id, seq) collision retries the WHOLE batch, per the spec, so
 * the numbers a batch receives are always contiguous. A rolled-back batch
 * consumes no numbers, so the sequence stays dense.
 *
 * An id that a concurrent push took first comes back as `taken` rather than
 * throwing. The caller reconciles it against what is now stored, which is the
 * same answer it would have reached had it seen the row on its first read - a
 * race must end up reconciled, never fatal.
 */
export async function createLessonsWithFeed(
	db: D1Database,
	userId: string,
	lessons: TLesson[],
): Promise<BatchWrite[]> {
	const results: BatchWrite[] = lessons.map(() => ({ outcome: "taken" }));
	if (lessons.length === 0) return results;

	const now = new Date().toISOString();
	let pending = lessons.map((_, index) => index);
	let attempts = 0;

	while (pending.length > 0) {
		if (attempts >= MAX_SEQ_ATTEMPTS) {
			throw new SequenceExhaustedError(userId, MAX_SEQ_ATTEMPTS);
		}

		const next = await db
			.prepare(
				"SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM lesson_feed WHERE user_id = ?",
			)
			.bind(userId)
			.first<{ next: number }>();
		const first = next?.next ?? 1;

		const statements = pending.flatMap((index, offset) => {
			const lesson = lessons[index];
			return [
				db
					.prepare(
						`INSERT INTO lessons
							(id, user_id, visibility, status, schema_version, body, promoted_at, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						lesson.id,
						userId,
						lesson.visibility,
						lesson.status,
						lesson.schema_version,
						canonicalize(lesson),
						// The column and the body carry the same value, written in
						// one statement so they cannot drift. promoted_at is
						// immutable - transitionLesson must never touch it.
						lesson.promoted_at,
						now,
						now,
					),
				db
					.prepare(
						`INSERT INTO lesson_feed (seq, user_id, lesson_id, kind, at)
						 VALUES (?, ?, ?, ?, ?)`,
					)
					.bind(first + offset, userId, lesson.id, "create", now),
			];
		});

		try {
			await db.batch(statements);
		} catch (error) {
			if (isUniqueViolationOn(error, "lesson_feed")) {
				attempts += 1;
				continue;
			}

			// An id collision is not sequence contention, and charging it to the
			// retry budget would burn all five attempts and then report the wrong
			// problem. The batch rolled back whole, so nothing here was written and
			// no number was consumed: drop whichever ids now exist and re-run the
			// rest. Each pass strictly shrinks `pending`, so this terminates.
			if (isUniqueViolationOn(error, "lessons.id")) {
				const taken = await getLessonsByIds(
					db,
					pending.map((index) => lessons[index].id),
				);
				const remaining = pending.filter(
					(index) => !taken.has(lessons[index].id),
				);
				// No id we can see accounts for the collision, so retrying the same
				// statements would loop on the same failure. Report it instead.
				if (remaining.length === pending.length) throw error;
				pending = remaining;
				continue;
			}

			throw error;
		}

		for (const [offset, index] of pending.entries()) {
			results[index] = { outcome: "created", seq: first + offset };
		}
		return results;
	}

	return results;
}

/**
 * Fetch lessons by id, WITHOUT filtering by owner.
 *
 * The caller must apply ownership itself. This exists for the idempotency check
 * on push, which has to know that an id is taken even when it belongs to
 * someone else - while being careful never to reveal that fact. See the
 * conflict handling in routes/lessons.ts.
 *
 * Plural because push decides idempotency for a whole batch at once. Answering
 * one id per round-trip cost up to a hundred sequential D1 calls inside a
 * single Worker request.
 */
export async function getLessonsByIds(
	db: D1Database,
	ids: string[],
): Promise<Map<string, StoredLesson>> {
	const found = new Map<string, StoredLesson>();
	const unique = [...new Set(ids)];

	for (let at = 0; at < unique.length; at += ID_LOOKUP_CHUNK) {
		const chunk = unique.slice(at, at + ID_LOOKUP_CHUNK);
		const rows = await db
			.prepare(
				`SELECT id, user_id, visibility, status, body
				 FROM lessons
				 WHERE id IN (${chunk.map(() => "?").join(", ")})`,
			)
			.bind(...chunk)
			.all<StoredLesson>();

		for (const row of rows.results ?? []) found.set(row.id, row);
	}

	return found;
}

/** One id's worth of {@link getLessonsByIds}. */
export async function getLessonById(
	db: D1Database,
	id: string,
): Promise<StoredLesson | null> {
	return (await getLessonsByIds(db, [id])).get(id) ?? null;
}

/**
 * Apply a lifecycle transition, appending to the feed.
 *
 * Returns the new seq, or null when the lesson does not exist or is not this
 * user's - the caller cannot tell those apart, which keeps the route from
 * confirming that another user's lesson id exists.
 *
 * The lesson's ORIGINAL feed row is untouched. Appending rather than moving is
 * the entire reason the feed is a separate table: moving a row vacates its old
 * position, and the client's contiguity check would then report corruption on
 * every legitimate status change.
 */
export async function transitionLesson(
	db: D1Database,
	userId: string,
	id: string,
	status: string,
	supersededBy: string | null,
): Promise<number | null> {
	const existing = await getLessonById(db, id);
	if (!existing || existing.user_id !== userId) return null;

	const body = JSON.parse(existing.body) as Record<string, unknown>;
	body.status = status;
	body.superseded_by = supersededBy;

	const now = new Date().toISOString();

	for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt++) {
		const next = await db
			.prepare(
				"SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM lesson_feed WHERE user_id = ?",
			)
			.bind(userId)
			.first<{ next: number }>();
		const seq = next?.next ?? 1;

		try {
			await db.batch([
				db
					.prepare(
						"UPDATE lessons SET status = ?, body = ?, updated_at = ? WHERE id = ? AND user_id = ?",
					)
					.bind(status, canonicalize(body), now, id, userId),
				db
					.prepare(
						`INSERT INTO lesson_feed (seq, user_id, lesson_id, kind, at)
						 VALUES (?, ?, ?, ?, ?)`,
					)
					.bind(seq, userId, id, "status", now),
			]);

			return seq;
		} catch (error) {
			if (isUniqueViolationOn(error, "lesson_feed")) continue;
			throw error;
		}
	}

	throw new SequenceExhaustedError(userId, MAX_SEQ_ATTEMPTS);
}

/**
 * Read one window of a user's feed, joined to current state.
 *
 * user_id is the visibility filter and therefore the security boundary. It
 * comes from the authenticated token and never from the request - a caller
 * cannot ask for someone else's stream, because there is no parameter that
 * would let them.
 *
 * A lesson changed twice appears twice in one window. That is harmless: the
 * client upserts by id and the later entry wins.
 *
 * One extra row is fetched to decide has_more without a second count query.
 */
export async function readLessonDelta(
	db: D1Database,
	userId: string,
	since: number,
	limit: number,
): Promise<{
	entries: Array<{ seq: number; body: string }>;
	hasMore: boolean;
}> {
	const rows = await db
		.prepare(
			`SELECT f.seq AS seq, l.body AS body
			 FROM lesson_feed f
			 JOIN lessons l ON l.id = f.lesson_id
			 WHERE f.user_id = ? AND f.seq > ?
			 ORDER BY f.seq ASC
			 LIMIT ?`,
		)
		.bind(userId, since, limit + 1)
		.all<{ seq: number; body: string }>();

	const found = rows.results ?? [];
	const hasMore = found.length > limit;

	return { entries: hasMore ? found.slice(0, limit) : found, hasMore };
}

/** Default and ceiling for one browsing page. */
export const BROWSE_DEFAULT_LIMIT = 50;
export const BROWSE_MAX_LIMIT = 200;

/**
 * A keyset cursor carries BOTH sort keys, because promoted_at alone is not
 * unique. Two lessons promoted in the same millisecond would make the boundary
 * ambiguous, and a page break landing between them either skips a lesson or
 * shows it twice.
 *
 * Opaque on purpose: the client echoes it back and never constructs one, so
 * the sort keys can change without becoming a breaking API change. `\n` is the
 * join delimiter because neither an ISO timestamp nor a ULID can contain one.
 */
export function encodeCursor(promotedAt: string, id: string): string {
	return btoa(`${promotedAt}\n${id}`);
}

export function decodeCursor(
	cursor: string,
): { promotedAt: string; id: string } | null {
	try {
		const [promotedAt, id, ...rest] = atob(cursor).split("\n");
		if (!promotedAt || !id || rest.length > 0) return null;
		return { promotedAt, id };
	} catch {
		// atob throws on anything that is not base64. A client-supplied cursor
		// is untrusted input, and a malformed one is a 400, not a 500.
		return null;
	}
}

/** Raised when a client sends a cursor this server did not mint. */
export class InvalidCursorError extends Error {
	constructor() {
		super("Invalid cursor");
		this.name = "InvalidCursorError";
	}
}

export interface LessonPage {
	lessons: unknown[];
	cursor: string | null;
	hasMore: boolean;
}

/**
 * One page of the pool, newest first.
 *
 * Ordered by (promoted_at, id) rather than promoted_at alone - see
 * encodeCursor. The matching index is lessons_user_promoted_at_idx.
 *
 * Fetches limit + 1 rows to learn whether another page exists without a second
 * COUNT query, then discards the extra.
 */
export async function listLessonsPage(
	db: D1Database,
	userId: string,
	opts: { statuses?: string[]; cursor?: string | null; limit: number },
): Promise<LessonPage> {
	const limit = Math.min(Math.max(1, opts.limit), BROWSE_MAX_LIMIT);
	const binds: unknown[] = [userId];
	let where = "user_id = ?";

	if (opts.statuses && opts.statuses.length > 0) {
		// This filters on the status COLUMN, but the row returned below is the
		// BODY - a different value on the same row. They only stay in step
		// because transitionLesson writes both in one batch; a caller that sets
		// one without the other would make this filter and its own response
		// disagree.
		where += ` AND status IN (${opts.statuses.map(() => "?").join(", ")})`;
		binds.push(...opts.statuses);
	}

	if (opts.cursor) {
		const after = decodeCursor(opts.cursor);
		if (!after) throw new InvalidCursorError();
		// Row-value comparison, which SQLite supports: strictly "older than the
		// boundary lesson", with id breaking a promoted_at tie.
		where += " AND (promoted_at, id) < (?, ?)";
		binds.push(after.promotedAt, after.id);
	}

	binds.push(limit + 1);

	const { results } = await db
		.prepare(
			`SELECT body FROM lessons
			 WHERE ${where}
			 ORDER BY promoted_at DESC, id DESC
			 LIMIT ?`,
		)
		.bind(...binds)
		.all<{ body: string }>();

	const rows = results ?? [];
	const hasMore = rows.length > limit;
	const page = (hasMore ? rows.slice(0, limit) : rows).map(
		(r) => JSON.parse(r.body) as { id: string; promoted_at: string },
	);
	const last = page.at(-1);
	const cursor =
		hasMore && last ? encodeCursor(last.promoted_at, last.id) : null;

	// Assert rather than trust: this holds by construction today, but the
	// construction is three separate facts (hasMore derives from a row count,
	// limit clamps to >= 1, the cursor comes from the last row) and a change to
	// any one of them breaks it silently. The browser would hide the tail of the
	// pool and say nothing.
	if (hasMore && cursor === null) {
		throw new Error(
			"listLessonsPage: has_more is true with no cursor; the tail would be unreachable",
		);
	}

	return {
		lessons: page,
		cursor,
		hasMore,
	};
}

/**
 * One lesson, or null when it does not exist OR is not this user's.
 *
 * The caller cannot tell those apart, and that is the point: a 403 on someone
 * else's lesson would confirm the id exists. Same reasoning as transitionLesson.
 */
export async function getLessonForUser(
	db: D1Database,
	userId: string,
	id: string,
): Promise<unknown | null> {
	const stored = await getLessonById(db, id);
	if (!stored || stored.user_id !== userId) return null;
	return JSON.parse(stored.body) as unknown;
}
