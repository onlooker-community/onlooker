import type {
	D1Database,
	D1PreparedStatement,
} from "@cloudflare/workers-types";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { canonicalize } from "../utils/canonical.js";
import { orgIdsForUser, ownerOrgIdsForUser } from "./orgs.js";
import {
	orgAuthorFacts,
	orgRetractableFor,
	readPool,
	readPoolLesson,
} from "./pool.js";
import {
	BROWSE_DEFAULT_LIMIT,
	BROWSE_MAX_LIMIT,
	decodeCursor,
	encodeCursor,
	InvalidCursorError,
	type LessonPage,
	type RetractableOrg,
} from "./pool-page.js";

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
	/** The org this lesson was shared with, or null. Null for every tier but 'org'. */
	org_id: string | null;
}

/**
 * Sequence assignment gave up after MAX_SEQ_ATTEMPTS.
 *
 * A named class rather than a plain Error, for two reasons. It is what lets a
 * route answer 503 - "the pool is contended, come back" - instead of the 500
 * that a bare Error collapses into, which is what the spec asks for. And the id
 * travels as a property rather than inside the message, so it stays out of
 * anything built from the message while remaining available for logging.
 *
 * That second reason used to be the only thing keeping the id out of a response
 * body: `errorHandler` echoed a bare Error's message verbatim. It no longer
 * does - an unexpected error gets a fixed sentence - so this is now the inner of
 * two layers rather than the whole defense. It stays because the message is
 * still what a log line or a future handler is most likely to pass along.
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
	/**
	 * The org the pushing MACHINE TOKEN is bound to, or null for a
	 * private-only token. Not a per-lesson value and not a contract field:
	 * the server reads it from the credential so a client cannot name an org
	 * its holder does not belong to.
	 */
	orgId: string | null = null,
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
							(id, user_id, visibility, status, schema_version, body, promoted_at, author_key, org_id, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						lesson.id,
						userId,
						lesson.visibility,
						lesson.status,
						lesson.schema_version,
						canonicalize(lesson),
						// Both promoted_at and author_key carry the same value as their
						// copy inside body, written in the same statement so they cannot
						// drift. promoted_at is immutable - transitionLesson must never
						// touch it. author_key is simply never rewritten, because a
						// lesson's author does not change.
						lesson.promoted_at,
						lesson.author_key,
						// Only an org-visible row carries the token's org. A
						// private row with an org_id would be reachable by the
						// org-retract path, which authorizes on this column.
						lesson.visibility === "org" ? orgId : null,
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
				const taken = await probeLessonIds(
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
 * Does this id exist, for any owner?
 *
 * DELIBERATELY UNAUTHORIZED, and named to say so. Push decides idempotency for
 * a whole batch and has to know that an id is taken even when it belongs to
 * someone else - while being careful never to reveal that fact.
 *
 * ITS RESULTS MUST NEVER BE SERIALIZED INTO A RESPONSE. Adding a user_id filter
 * here to "fix" the missing authorization would silently break push idempotency
 * across accounts; returning a row from it would leak another user's lesson.
 * Reads that answer a caller go through readPool.
 *
 * Plural because push decides a whole batch at once. Answering one id per
 * round-trip cost up to a hundred sequential D1 calls inside one request.
 */
export async function probeLessonIds(
	db: D1Database,
	ids: string[],
): Promise<Map<string, StoredLesson>> {
	const found = new Map<string, StoredLesson>();
	const unique = [...new Set(ids)];

	for (let at = 0; at < unique.length; at += ID_LOOKUP_CHUNK) {
		const chunk = unique.slice(at, at + ID_LOOKUP_CHUNK);
		const rows = await db
			.prepare(
				`SELECT id, user_id, visibility, status, body, org_id
				 FROM lessons
				 WHERE id IN (${chunk.map(() => "?").join(", ")})`,
			)
			.bind(...chunk)
			.all<StoredLesson>();

		for (const row of rows.results ?? []) found.set(row.id, row);
	}

	return found;
}

/** One id's worth of {@link probeLessonIds}. */
export async function probeLessonId(
	db: D1Database,
	id: string,
): Promise<StoredLesson | null> {
	return (await probeLessonIds(db, [id])).get(id) ?? null;
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
	const existing = await probeLessonId(db, id);
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
 * Retract a lesson whoever owns it.
 *
 * A SEPARATE FUNCTION from transitionLesson on purpose. That one's
 * `WHERE id = ? AND user_id = ?` is the user-facing guarantee that a caller
 * cannot touch somebody else's lesson, and widening it with an optional
 * "skip the owner check" flag would put a cross-owner write one wrong argument
 * away from every ordinary transition. Two functions cannot be confused.
 *
 * Appends to the owner's feed like any other transition, so their mirror learns
 * about it on the next delta pull.
 */
export async function retractAnyLesson(
	db: D1Database,
	id: string,
): Promise<number | null> {
	const stored = await probeLessonId(db, id);
	if (!stored) return null;
	return transitionLesson(db, stored.user_id, id, "retracted", null);
}

/**
 * Retract a lesson shared with one org, on that org's authority.
 *
 * THE THIRD retract function, and separate from both others on purpose.
 * `transitionLesson`'s `WHERE id = ? AND user_id = ?` is the user-facing
 * guarantee that a caller cannot touch somebody else's lesson, and
 * `retractAnyLesson` is the operator path. Widening either with an "and also
 * org owners" argument would put a cross-owner write one wrong argument away
 * from an ordinary transition. Three functions cannot be confused.
 *
 * Authorizes on the lesson's own `org_id` AND on `visibility = 'org'`. The
 * visibility check is defense in depth against the write side: createLessons-
 * WithFeed stamps the org only onto org-visible rows precisely so this path
 * cannot reach a member's private lesson, and checking here too means one
 * mistake is not enough.
 *
 * Returns the new seq, or null when the lesson does not exist, is not shared
 * with this org, or is not an org lesson at all - the caller cannot tell those
 * apart, which keeps the route from confirming another org's lesson ids.
 *
 * Appends to the AUTHOR's feed, like any other transition, so their mirror
 * learns about it on the next delta pull. D6 is deliberate here: the lesson
 * survives its author leaving the org, and this is the control that keeps that
 * from making the operator the moderation queue for every customer.
 */
export async function retractOrgLesson(
	db: D1Database,
	orgId: string,
	lessonId: string,
): Promise<number | null> {
	const stored = await probeLessonId(db, lessonId);
	if (!stored) return null;
	if (stored.visibility !== "org") return null;
	if (stored.org_id !== orgId) return null;

	return transitionLesson(db, stored.user_id, lessonId, "retracted", null);
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
			// Same join, same implicit invariant, same predicate stating it -
			// see `listActivityPage` for the reasoning. Hardened together
			// because leaving one of two identical joins implicit is how the
			// next reader concludes the explicit one was the special case.
			`SELECT f.seq AS seq, l.body AS body
			 FROM lesson_feed f
			 JOIN lessons l ON l.id = f.lesson_id AND l.user_id = f.user_id
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

// Moved to pool-page.ts, a leaf module with no imports of its own, so it can
// sit underneath both this file and pool.ts without a cycle: pool.ts needs
// these five names while this file imports readPool/readPoolLesson from
// pool.ts. Re-exported here (imported above for this file's own use, since
// listActivityPage still needs BROWSE_MAX_LIMIT and InvalidCursorError) so
// every existing importer is unchanged.
export {
	BROWSE_DEFAULT_LIMIT,
	BROWSE_MAX_LIMIT,
	decodeCursor,
	encodeCursor,
	InvalidCursorError,
	type LessonPage,
};

/**
 * Activity cursors carry a sequence, not a (timestamp, id) pair.
 *
 * `lesson_feed.seq` is unique per user by index — `lesson_feed_user_seq_idx`
 * on (user_id, seq) — so one value totally orders a user's feed and needs no
 * tiebreaker. Base64 for the same reason the lesson cursor uses it: a client
 * should not read a cursor as a number and start doing arithmetic on it.
 */
export function encodeSeqCursor(seq: number): string {
	return btoa(String(seq));
}

export function decodeSeqCursor(cursor: string): number | null {
	try {
		const seq = Number.parseInt(atob(cursor), 10);
		return Number.isFinite(seq) ? seq : null;
	} catch {
		// atob throws on anything that is not base64. A client-supplied cursor
		// is untrusted input, and a malformed one is a 400, not a 500.
		return null;
	}
}

/** One lesson event, joined to the lesson it happened to. */
export interface ActivityEvent {
	seq: number;
	kind: string;
	at: string;
	lesson_id: string;
	claim: string;
	applies_to: unknown;
	status: string;
}

export interface ActivityPage {
	events: ActivityEvent[];
	cursor: string | null;
	hasMore: boolean;
}

/**
 * One page of a user's lesson activity, newest first.
 *
 * Ordered by seq DESC rather than at DESC. `at` defaults to CURRENT_TIMESTAMP,
 * so two events written in the same second tie — and a tie in the sort key is
 * how cursor pagination drops or repeats rows across a page boundary.
 *
 * The claim lives in the lesson's body rather than a column, so this joins and
 * parses rather than selecting a title that does not exist.
 */
export async function listActivityPage(
	db: D1Database,
	userId: string,
	opts: { cursor?: string | null; limit: number },
): Promise<ActivityPage> {
	const limit = Math.min(Math.max(1, opts.limit), BROWSE_MAX_LIMIT);
	const binds: unknown[] = [userId];
	let where = "f.user_id = ?";

	if (opts.cursor) {
		const after = decodeSeqCursor(opts.cursor);
		if (after === null) throw new InvalidCursorError();
		where += " AND f.seq < ?";
		binds.push(after);
	}

	binds.push(limit + 1);

	const { results } = await db
		.prepare(
			// `AND l.user_id = f.user_id` states the invariant the join rests
			// on rather than trusting it. `lessons.id` is a global primary
			// key, so joining on it alone is safe only because both writers
			// keep a feed row's lesson owned by the same user:
			// `createLessonsWithFeed` drops a colliding id from pending and
			// writes no feed row for it, and `transitionLesson` returns null
			// before writing when the owner differs.
			//
			// No path reaches another account's events today - the feed side
			// is filtered on `f.user_id`, and a forged cursor is a bare seq
			// applied as `f.seq < ?` alongside that predicate, so it cannot
			// escape. This is hardening, not a fix: it costs nothing, and it
			// means a future writer that loses the invariant produces no rows
			// instead of another account's claims.
			`SELECT f.seq, f.kind, f.at, f.lesson_id, l.body, l.status
			 FROM lesson_feed f
			 JOIN lessons l ON l.id = f.lesson_id AND l.user_id = f.user_id
			 WHERE ${where}
			 ORDER BY f.seq DESC
			 LIMIT ?`,
		)
		.bind(...binds)
		.all<{
			seq: number;
			kind: string;
			at: string;
			lesson_id: string;
			body: string;
			status: string;
		}>();

	const rows = results ?? [];
	const hasMore = rows.length > limit;
	const events = (hasMore ? rows.slice(0, limit) : rows).map((r) => {
		const body = JSON.parse(r.body) as {
			claim?: string;
			applies_to?: unknown;
		};
		return {
			seq: r.seq,
			kind: r.kind,
			at: r.at,
			lesson_id: r.lesson_id,
			claim: body.claim ?? "",
			applies_to: body.applies_to ?? null,
			status: r.status,
		};
	});

	const last = events.at(-1);
	const cursor = hasMore && last ? encodeSeqCursor(last.seq) : null;

	// Asserted rather than trusted, for the same reason readPool asserts it:
	// hasMore, the clamped limit and the cursor are three separate facts, and a
	// change to any one of them would silently hide the tail of the feed.
	if (hasMore && cursor === null) {
		throw new Error(
			"listActivityPage: has_more is true with no cursor; the tail would be unreachable",
		);
	}

	return { events, cursor, hasMore };
}

/**
 * One page of this user's pool, newest first.
 *
 * Kept as a named function rather than inlined at the route because its
 * signature is what the browse route and apps/web's contract tests already use.
 * The authorization now lives in readPool, which is the only place that builds
 * a visibility predicate.
 */
export async function listLessonsPage(
	db: D1Database,
	userId: string,
	opts: { statuses?: string[]; cursor?: string | null; limit: number },
): Promise<LessonPage> {
	return readPool(db, { userId }, opts, orgIdsForUser);
}

/**
 * One lesson this user may read, or null.
 *
 * Previously fetched unfiltered and compared user_id in TypeScript afterward.
 * That was a second authorization mechanism alongside listLessonsPage's SQL
 * filter, and it could not express org or public without duplicating the
 * predicate. Both now go through readPool's.
 */
export async function getLessonForUser(
	db: D1Database,
	userId: string,
	id: string,
): Promise<{
	lesson: unknown;
	own: boolean;
	author_name: string | null;
	former_author: boolean;
	retractable_in: RetractableOrg | null;
} | null> {
	// Resolved once into a local rather than passed as orgIdsForUser twice:
	// one membership read per request instead of two, and the name this
	// resolves and the predicate readPoolLesson applies cannot disagree about
	// which orgs the reader is in.
	const readerOrgIds = await orgIdsForUser(db, userId);
	const lesson = await readPoolLesson(
		db,
		{ userId },
		id,
		async () => readerOrgIds,
	);
	if (!lesson) return null;

	// A second statement rather than widening readPoolLesson's SELECT, because
	// the anonymous public route calls that same function and its contract -
	// no code path may widen what it sees - is worth more than saving a
	// primary-key lookup here. The row is already known to be readable; this
	// only asks whose it is.
	const owned = await db
		.prepare("SELECT 1 AS own FROM lessons WHERE id = ? AND user_id = ?")
		.bind(id, userId)
		.first<{ own: number }>();

	// Resolved from the same org list the predicate used, so the name can only
	// appear for a row the org disjunct is what admitted.
	const { name: author_name, formerAuthor: former_author } =
		await orgAuthorFacts(db, readerOrgIds, id);

	// From the reader's OWNED orgs, resolved here rather than inside
	// orgRetractableFor so the two org lists this function depends on - the
	// membership list the predicate used and the owner list this uses - are
	// both visible in one place.
	const retractable_in = await orgRetractableFor(
		db,
		userId,
		await ownerOrgIdsForUser(db, userId),
		id,
	);

	return {
		lesson,
		own: owned !== null,
		author_name,
		former_author,
		retractable_in,
	};
}

/**
 * Whether this user has a lesson that must outlive their account.
 *
 * The condition is the whole of ONL-136's decision: a lesson shared with an
 * org belongs to the org once its author leaves. `org_id IS NOT NULL` is not
 * redundant with `visibility = 'org'` - `lessons.org_id` is ON DELETE SET
 * NULL, so a row whose org was deleted is readable by nobody at all, and
 * keeping an account alive to anchor one would retain identity for nothing.
 */
export async function hasOrgSharedLessons(
	db: D1Database,
	userId: string,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS present FROM lessons
			 WHERE user_id = ? AND visibility = 'org' AND org_id IS NOT NULL
			 LIMIT 1`,
		)
		.bind(userId)
		.first<{ present: number }>();

	return row !== null;
}

/**
 * The statement that deletes the lessons going with a deleted account.
 *
 * Everything except the org-shared ones: a private lesson would be
 * permanently unreadable once nobody can authenticate as its author, and a
 * public one is the author's own publication to withdraw. The inverse of
 * `hasOrgSharedLessons` above, deliberately written as the same condition
 * negated so the two cannot drift apart.
 *
 * Returns the statement rather than running it, so its one caller can put it
 * in the same `db.batch` as the UPDATE that anonymizes the account. Running it
 * separately would delete these lessons before that UPDATE's own sole-owner
 * guard had a chance to refuse, leaving an account stripped of its lessons and
 * still holding its identity - the half-dismantled state the design exists to
 * avoid. The `anonymized_at IS NOT NULL` gate is the other half of that: the
 * batch shares one transaction, so this sees the UPDATE's effect and fires
 * only if it landed.
 *
 * Each deleted lesson takes its own `lesson_feed` rows with it, because
 * `lesson_feed.lesson_id` cascades from `lessons`. The author's remaining feed
 * rows - the ones belonging to surviving lessons - stay, which keeps
 * `transitionLesson`'s `MAX(seq) + 1` continuous for a later org retract.
 */
export function nonOrgLessonsDelete(
	db: D1Database,
	userId: string,
): D1PreparedStatement {
	return db
		.prepare(
			`DELETE FROM lessons
			 WHERE user_id = ?
			   AND NOT (visibility = 'org' AND org_id IS NOT NULL)
			   AND EXISTS (SELECT 1 FROM users
			               WHERE id = ? AND anonymized_at IS NOT NULL)`,
		)
		.bind(userId, userId);
}

/**
 * deleteUser's (db/queries.ts) first attempt: delete the account outright
 * unless it is a sole owner or anchors a lesson shared with an org.
 *
 * Lives here rather than beside its one caller because its WHERE clause names
 * `lessons` directly, and `scripts/source-guards.test.sh` keeps every lesson
 * query inside this file and db/pool.ts - the same reason `nonOrgLessonsDelete`
 * above is a statement-returning function rather than inline SQL in
 * queries.ts.
 *
 * The org-lesson condition is `hasOrgSharedLessons`'s own test, inlined rather
 * than called: deciding with a separate read and then deleting would let a
 * lesson pushed in between be cascaded away - the loss this work exists to
 * prevent. Folding it into the DELETE's own WHERE makes the check and the
 * write atomic, the same reason the sole-owner condition beside it is a
 * subquery rather than a prior read (#198).
 */
export function deleteUserUnlessProtected(
	db: D1Database,
	userId: string,
): D1PreparedStatement {
	return db
		.prepare(
			`DELETE FROM users
			 WHERE id = ?
			   AND NOT EXISTS (
			     SELECT 1 FROM org_memberships m
			     WHERE m.user_id = ? AND m.role = 'owner'
			       AND (SELECT COUNT(*) FROM org_memberships o
			            WHERE o.org_id = m.org_id AND o.role = 'owner') = 1)
			   AND NOT EXISTS (
			     SELECT 1 FROM lessons
			     WHERE user_id = ? AND visibility = 'org' AND org_id IS NOT NULL)`,
		)
		.bind(userId, userId, userId);
}
