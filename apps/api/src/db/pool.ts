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
 * Return a BOUNDED set, well under MAX_ORG_MEMBERS_BOUND below. This
 * predicate binds one `?` per id, and D1 has a ceiling on bound parameters per
 * query; visibilityPredicate truncates past that bound rather than trusting
 * every resolver to honor it, but a resolver that routinely returns that many
 * ids is doing needless per-request work even before truncation kicks in.
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
 * db/, and nothing ties the two together with a test. The 385 pre-existing
 * tests passing unedited is evidence the two conditions HOLD, not evidence of
 * why.
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
 * Past this, an `IN (...)` list of one `?` per member risks D1's ceiling on
 * bound parameters for a query shaped like this one - roughly 900 by measured
 * behavior, not the 100 a chunking comment elsewhere in this codebase quotes
 * for a different query shape (getLessonsByIds' own `IN` list). This leaves
 * headroom under that for the predicate's own couple of binds and whatever
 * readPool adds for statuses and the cursor, rather than sitting on the edge.
 */
const MAX_ORG_MEMBERS_BOUND = 800;

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
		// resolver that returns more than the codebase asks for should still
		// only narrow which org members are recognized, not take the whole
		// read down. See MAX_ORG_MEMBERS_BOUND above.
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
			"readPool: has_more is true with no cursor; the tail would be unreachable",
		);
	}

	return {
		lessons: page,
		cursor,
		hasMore,
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
