import type { D1Database } from "@cloudflare/workers-types";
import {
	BROWSE_MAX_LIMIT,
	decodeCursor,
	encodeCursor,
	InvalidCursorError,
	type LessonPage,
} from "./pool-page.js";

/**
 * Who is asking. Resolved by the router from the route's declared `auth`, never
 * from a request parameter.
 *
 * Operator authority is deliberately absent. Moderation is authorized by a
 * route's `auth: "operator"` and acts through its own functions, so no read
 * predicate has an operator branch that could widen what a read returns.
 */
export interface Principal {
	userId: string;
}

/**
 * The org-membership hole. ONL-12 fills this.
 *
 * Contract: return the user_ids sharing an org with `userId`. Never include a
 * non-member. NEVER THROW - an org that cannot be resolved returns [], so a
 * membership outage narrows access instead of widening it.
 *
 * MUST stay within MAX_ORG_MEMBERS_BOUND below (50 - D1's 100-bound-parameter
 * cap, halved for headroom the same way lessons.ts's ID_LOOKUP_CHUNK is).
 * This is not a soft preference: this predicate binds one `?` per id, so an
 * `IN (...)` list cannot express an org bigger than the bound AT ALL. An org
 * larger than that is this issue's to solve with a different shape entirely -
 * a JOIN against a membership table, not a longer id list - not something a
 * resolver can paper over by returning more ids. Past the bound,
 * visibilityPredicate truncates rather than throwing, which silently drops
 * members rather than growing the query; that is a floor against a resolver
 * that ignores this contract, not a way to run a big org correctly.
 */
export type OrgMembers = (db: D1Database, userId: string) => Promise<string[]>;

/**
 * The inert stub - but inertness rests on TWO conditions, and this is only
 * one of them.
 *
 * The load-bearing one is the closed push tier gate at routes/lessons.ts:104:
 * no non-private lesson can enter the pool, and transitionLesson never
 * rewrites `visibility`, so the column can only ever hold 'private' today.
 * `visibility = 'public'` sits outside visibilityPredicate's `if (principal)`
 * branch, so emptying the org set (what this stub does) does not narrow that
 * disjunct at all - it is the closed gate, not this stub, that keeps it from
 * matching anything. That gate is enforced in a route; this read lives in
 * db/, and nothing ties the two together with a test. That no pre-existing
 * test's expectation about a read's behavior changed - the one exception is
 * packages/db/src/__tests__/schema.test.ts, a hand-pinned table/column count
 * that never opens a database and moved only because Task 1 added a table
 * and a column - is evidence the two conditions HOLD, not evidence of why.
 *
 * When that gate opens, an authenticated readPool begins matching OTHER
 * accounts' non-retracted, unblocked public rows - the spec's intent for the
 * browse surface, not a bug. But it is a behavior change that nothing in this
 * file announces, so whoever opens the gate should read this comment first.
 *
 * It also has a measured performance consequence. EXPLAIN QUERY PLAN against
 * a database built from the real migrations:
 *   - Before this predicate (old listLessonsPage): `SEARCH lessons USING
 *     INDEX lessons_user_promoted_at_idx (user_id=?)` - indexed, no sort,
 *     because the index already supplies promoted_at order.
 *   - This predicate, today: `SCAN lessons` plus `USE TEMP B-TREE FOR ORDER
 *     BY` - a full table scan across every user's rows, plus a sort. Cheap
 *     only because the closed gate means every row is 'private' and the
 *     'public' disjunct never matches anything - the planner still has to
 *     scan to find that out.
 *   - With an index added on (visibility, promoted_at, id) - NOT added in
 *     this task; it is filed to land with whichever change opens the gate,
 *     since the regression cannot bite while no cross-user public row can
 *     exist - it becomes `MULTI-INDEX OR` plus a sort: no more full scan, but
 *     the sort cannot be avoided once the leading clause is a disjunction.
 * No test will ever notice this difference; it is production query-planner
 * behavior over real data volume, not something an in-memory D1 test
 * database reveals.
 */
export const noOrgMembers: OrgMembers = async () => [];

export interface PoolFilters {
	statuses?: string[];
	cursor?: string | null;
	limit: number;
}

/**
 * The largest org-membership list this predicate will bind into one query.
 *
 * D1 caps bound parameters per query at 100 - the same fact `lessons.ts`'s
 * `ID_LOOKUP_CHUNK` derives from, halving that cap for the same reason. This
 * query carries other binds beside the org list too: both `user_id` binds in
 * visibilityPredicate itself, up to four `statuses`, two cursor binds, and
 * the page `LIMIT`. 50 - matching `ID_LOOKUP_CHUNK` rather than disagreeing
 * with it - leaves real headroom under the cap instead of sitting near it.
 *
 * This is a hard ceiling on what an `IN (...)` id list can express, not a
 * safety valve for an unusually large but ordinary org. Past this count,
 * ONL-12's resolver cannot be answered with an id list handed to this
 * predicate at all - an org bigger than the bound needs a JOIN against a
 * membership table, not a bigger list. See the truncation below for what
 * happens if such a resolver ships anyway: it is a floor against breakage,
 * not a supported way to run a big org.
 */
export const MAX_ORG_MEMBERS_BOUND = 50;

/**
 * The only place a visibility predicate is constructed.
 *
 * Two parts, ANDed. First, what this principal may see at all. Second, the
 * ownership-boundary rule: your own lessons you see at any status, but across an
 * ownership boundary nothing retracted and nothing from a blocked author_key is
 * ever served. For an anonymous caller `own` is the literal 0, so every row is
 * across the boundary and both restrictions always apply.
 *
 * Note that org membership widens `org` only. A member of your org still cannot
 * read your `private` lessons, which is why the org branch tests visibility
 * rather than only ownership.
 *
 * A decision, recorded because a reader cannot otherwise tell whether it was
 * considered: `ZStatus` is `active | refuted | superseded | retracted`, and
 * only `retracted` is withheld across the ownership boundary. `refuted` and
 * `superseded` are served with their status attached. `retracted` is the
 * *moderation* outcome - what a takedown produces - so hiding it is the point.
 * `refuted` and `superseded` are lifecycle facts the lesson's own body already
 * carries honestly, and `superseded_by` even names the replacement; hiding
 * either would break a link someone was given to a lesson that still exists
 * and still says what happened to it, which is the thing the public-by-link
 * model exists to provide. Serving them with their status intact is more
 * honest than 404ing them.
 */
function visibilityPredicate(
	principal: Principal | null,
	orgMemberIds: string[],
): { sql: string; binds: unknown[] } {
	const binds: unknown[] = [];
	const visible: string[] = ["visibility = 'public'"];

	if (principal) {
		visible.push("user_id = ?");
		binds.push(principal.userId);

		// Truncated, not thrown: OrgMembers promises never to throw, and a
		// resolver whose org exceeds the bound should still only narrow which
		// members are recognized, not take the whole read down - including the
		// caller's own private lessons, which the same query answers. This is a
		// floor against a broken or oversized resolver, not a supported way to
		// serve a big org: see MAX_ORG_MEMBERS_BOUND above for why a bigger org
		// needs a different predicate entirely, not a bigger list here.
		const bounded = orgMemberIds.slice(0, MAX_ORG_MEMBERS_BOUND);

		if (bounded.length > 0) {
			visible.push(
				`(visibility = 'org' AND user_id IN (${bounded
					.map(() => "?")
					.join(", ")}))`,
			);
			binds.push(...bounded);
		}
	}

	const own = principal ? "user_id = ?" : "0";
	if (principal) binds.push(principal.userId);

	const sql =
		`(${visible.join(" OR ")})` +
		` AND (${own} OR (status != 'retracted'` +
		` AND NOT EXISTS (SELECT 1 FROM lesson_author_blocks b` +
		` WHERE b.author_key = lessons.author_key)))`;

	return { sql, binds };
}

/**
 * One page of the pool this principal may read, newest first.
 *
 * Callers pass filters, never SQL. There is no other path from a route to a
 * lesson body, which is what stops a read from being written without a
 * visibility predicate at all.
 */
export async function readPool(
	db: D1Database,
	principal: Principal | null,
	filters: PoolFilters,
	orgMembers: OrgMembers = noOrgMembers,
): Promise<LessonPage> {
	const limit = Math.min(Math.max(1, filters.limit), BROWSE_MAX_LIMIT);
	const orgMemberIds = principal ? await orgMembers(db, principal.userId) : [];
	const predicate = visibilityPredicate(principal, orgMemberIds);

	const binds: unknown[] = [...predicate.binds];
	let where = predicate.sql;

	if (filters.statuses && filters.statuses.length > 0) {
		where += ` AND status IN (${filters.statuses.map(() => "?").join(", ")})`;
		binds.push(...filters.statuses);
	}

	if (filters.cursor) {
		const after = decodeCursor(filters.cursor);
		if (!after) throw new InvalidCursorError();
		// Row-value comparison, which SQLite supports: strictly "older than the
		// boundary lesson", with id breaking a promoted_at tie.
		where += " AND (promoted_at, id) < (?, ?)";
		binds.push(after.promotedAt, after.id);
	}

	binds.push(limit + 1);

	// user_id rides along so the caller can be told which of these are its
	// own. It is never returned - see LessonPage.ownedIds for why ownership
	// is reported as a list of the caller's ids rather than as a field on
	// each body.
	const { results } = await db
		.prepare(
			`SELECT body, user_id FROM lessons
			 WHERE ${where}
			 ORDER BY promoted_at DESC, id DESC
			 LIMIT ?`,
		)
		.bind(...binds)
		.all<{ body: string; user_id: string }>();

	const rows = results ?? [];
	const hasMore = rows.length > limit;
	const kept = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
		lesson: JSON.parse(r.body) as { id: string; promoted_at: string },
		userId: r.user_id,
	}));
	const page = kept.map((r) => r.lesson);

	// Derived from the rows actually returned, so the lookahead row that only
	// decides has_more can never leak an id into it.
	const ownedIds = principal
		? kept.filter((r) => r.userId === principal.userId).map((r) => r.lesson.id)
		: [];
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
			"readPool: has_more is true with no cursor; the tail would be unreachable",
		);
	}

	return {
		lessons: page,
		cursor,
		hasMore,
		ownedIds,
	};
}

/**
 * One lesson by id, or null.
 *
 * Null covers both "does not exist" and "exists but you may not read it", and
 * the caller cannot tell them apart. A distinguishable answer would confirm
 * another user's lesson id - the same reasoning transitionLesson already
 * records.
 */
export async function readPoolLesson(
	db: D1Database,
	principal: Principal | null,
	id: string,
	orgMembers: OrgMembers = noOrgMembers,
): Promise<unknown | null> {
	const orgMemberIds = principal ? await orgMembers(db, principal.userId) : [];
	const predicate = visibilityPredicate(principal, orgMemberIds);

	const row = await db
		.prepare(
			`SELECT body FROM lessons
			 WHERE id = ? AND ${predicate.sql}`,
		)
		.bind(id, ...predicate.binds)
		.first<{ body: string }>();

	return row ? (JSON.parse(row.body) as unknown) : null;
}
