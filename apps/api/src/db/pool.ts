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
 */
export type OrgMembers = (db: D1Database, userId: string) => Promise<string[]>;

/**
 * The inert stub, and the reason this whole seam can ship before ONL-12.
 *
 * With the org set empty, every read returns exactly what it returned before
 * this file existed. The unchanged existing test suite is the evidence.
 */
export const noOrgMembers: OrgMembers = async () => [];

export interface PoolFilters {
	statuses?: string[];
	cursor?: string | null;
	limit: number;
}

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

		if (orgMemberIds.length > 0) {
			visible.push(
				`(visibility = 'org' AND user_id IN (${orgMemberIds
					.map(() => "?")
					.join(", ")}))`,
			);
			binds.push(...orgMemberIds);
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

	return {
		lessons: page,
		cursor: hasMore && last ? encodeCursor(last.promoted_at, last.id) : null,
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
