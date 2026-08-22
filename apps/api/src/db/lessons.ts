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

/** The lesson id is already taken. Distinct from sequence contention. */
export class LessonIdTakenError extends Error {
	constructor(id: string) {
		super(`lesson ${id} already exists`);
		this.name = "LessonIdTakenError";
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

function isUniqueViolationOn(error: unknown, table: string): boolean {
	return (
		error instanceof Error &&
		/UNIQUE constraint failed/i.test(error.message) &&
		error.message.includes(table)
	);
}

/**
 * Insert a lesson and its feed row in one transaction, returning the seq.
 *
 * Raw prepared statements rather than the drizzle builder, because `batch` is
 * the transaction primitive here and both statements must land together. A
 * lesson row without its feed entry is invisible to every mirror; a feed entry
 * without its lesson breaks the join.
 *
 * The sequence is MAX(seq)+1 over lesson_feed for this user, read inside the
 * same call. Two racing pushes can compute the same value - UNIQUE(user_id,
 * seq) rejects the loser, which retries. Correctness rests on that constraint
 * rather than on D1 committing in seq order.
 */
export async function createLessonWithFeed(
	db: D1Database,
	userId: string,
	lesson: TLesson,
): Promise<number> {
	const now = new Date().toISOString();
	const body = canonicalize(lesson);

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
						`INSERT INTO lessons
							(id, user_id, visibility, status, schema_version, body, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						lesson.id,
						userId,
						lesson.visibility,
						lesson.status,
						lesson.schema_version,
						body,
						now,
						now,
					),
				db
					.prepare(
						`INSERT INTO lesson_feed (seq, user_id, lesson_id, kind, at)
						 VALUES (?, ?, ?, ?, ?)`,
					)
					.bind(seq, userId, lesson.id, "create", now),
			]);

			return seq;
		} catch (error) {
			// An id collision is not sequence contention and retrying it would
			// burn all five attempts and then report the wrong problem.
			if (isUniqueViolationOn(error, "lessons.id")) {
				throw new LessonIdTakenError(lesson.id);
			}
			if (isUniqueViolationOn(error, "lesson_feed")) continue;
			throw error;
		}
	}

	throw new Error(
		`could not assign a sequence for user ${userId} after ${MAX_SEQ_ATTEMPTS} attempts`,
	);
}

/**
 * Fetch a lesson by id, WITHOUT filtering by owner.
 *
 * The caller must apply ownership itself. This exists for the idempotency check
 * on push, which has to know that an id is taken even when it belongs to
 * someone else - while being careful never to reveal that fact. See the
 * conflict handling in routes/lessons.ts.
 */
export async function getLessonById(
	db: D1Database,
	id: string,
): Promise<StoredLesson | null> {
	const row = await db
		.prepare(
			"SELECT id, user_id, visibility, status, body FROM lessons WHERE id = ?",
		)
		.bind(id)
		.first<StoredLesson>();

	return row ?? null;
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

	throw new Error(
		`could not assign a sequence for user ${userId} after ${MAX_SEQ_ATTEMPTS} attempts`,
	);
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
