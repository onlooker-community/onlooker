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
 * The orgs the reader belongs to.
 *
 * Contract: return the ids of orgs `userId` is a member of. Never include an
 * org they do not belong to. NEVER THROW - an org list that cannot be resolved
 * must return [], so a membership outage narrows access instead of widening it.
 * `readPool` enforces that structurally by catching anything this throws, so
 * the property does not rest on a resolver's politeness.
 *
 * This used to return the ids of the reader's org-MATES, and the predicate
 * matched them against `lessons.user_id`. That authorized on who the author
 * was rather than on which org the lesson was shared with, which over-shares
 * the moment a user can belong to two orgs: Alice in orgs A and B pushes one
 * org lesson, and Bob (A only) and Carol (B only) can both read it because each
 * shares AN org with Alice. The rename is not cosmetic - a function whose name
 * says "members" and whose values are orgs is the kind of thing a later reader
 * fixes in the wrong direction.
 */
export type OrgIds = (db: D1Database, userId: string) => Promise<string[]>;

/**
 * The fail-closed default: a reader in no orgs.
 *
 * Still the default parameter rather than the live resolver, deliberately. A
 * forgotten wiring then narrows a read instead of widening one, and
 * `routes/lessons-public.ts` keeps an anonymous path that resolves no orgs at
 * all. What catches a forgotten wiring is a test through the production entry
 * point - see "resolves the reader's orgs" in db/pool.test.ts - rather than a
 * default that papers over it.
 */
export const noOrgIds: OrgIds = async () => [];

export interface PoolFilters {
	statuses?: string[];
	cursor?: string | null;
	limit: number;
}

/**
 * The largest number of a reader's orgs this predicate will bind into one
 * query.
 *
 * D1 caps bound parameters per query at 100 - the fact `lessons.ts`'s
 * `ID_LOOKUP_CHUNK` derives from, halving it for the same reason. This query
 * carries other binds beside the org list: both `user_id` binds in
 * visibilityPredicate, up to four `statuses`, two cursor binds, and the page
 * LIMIT.
 *
 * What changed with the rekey is what this bounds. It used to limit an org's
 * SIZE - a hard ceiling on the members an `IN (...)` list could express, past
 * which the predicate silently stopped recognizing members, which is why
 * MAX_ORG_MEMBERS_BOUND was a standing ceiling on how big an org could be at
 * all. Now it limits how many orgs ONE READER may have counted in a single
 * query, which is one or two in practice and 50 at the cap. The org-size
 * ceiling is gone, not raised.
 */
export const MAX_READER_ORGS_BOUND = 50;

/**
 * How many author ids the name lookup binds per statement.
 *
 * Matches `lessons.ts`'s ID_LOOKUP_CHUNK rather than disagreeing with it: D1
 * caps bound parameters at 100, and a page can carry up to BROWSE_MAX_LIMIT
 * rows, so a page of 200 distinct org authors would exceed the cap in one
 * statement.
 */
const AUTHOR_LOOKUP_CHUNK = 50;

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
 * rather than only ownership. That stays true after the rekey below - it is
 * now true because the disjunct tests `visibility = 'org'` against the
 * lesson's own org rather than against the author's identity.
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
	readerOrgIds: string[],
): { sql: string; binds: unknown[] } {
	const binds: unknown[] = [];
	const visible: string[] = ["visibility = 'public'"];

	if (principal) {
		visible.push("user_id = ?");
		binds.push(principal.userId);

		// Truncated, not thrown, for the same reason as before: this read also
		// answers the caller's own private lessons, and a reader in more orgs
		// than the bound should lose org rows rather than lose the whole page.
		// Unreachable in practice now that the bound counts the reader's orgs
		// rather than an org's members.
		const bounded = readerOrgIds.slice(0, MAX_READER_ORGS_BOUND);

		if (bounded.length > 0) {
			visible.push(
				`(visibility = 'org' AND org_id IN (${bounded
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
 * The reader's orgs, or none - never an exception.
 *
 * The OrgIds contract says a resolver never throws. This catches anyway,
 * because "narrows on failure" is a property worth having by construction
 * rather than by agreement: a resolver is a function someone else writes, and
 * the cost of being wrong here is that a membership outage takes down a read
 * that also serves the caller's own private lessons.
 *
 * Narrowing is the only safe direction, so there is deliberately no error
 * propagated to the caller and nothing retried.
 */
async function resolveOrgIds(
	db: D1Database,
	principal: Principal | null,
	orgIds: OrgIds,
): Promise<string[]> {
	if (!principal) return [];
	try {
		return await orgIds(db, principal.userId);
	} catch {
		return [];
	}
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
	orgIds: OrgIds = noOrgIds,
): Promise<LessonPage> {
	const limit = Math.min(Math.max(1, filters.limit), BROWSE_MAX_LIMIT);
	const readerOrgIds = await resolveOrgIds(db, principal, orgIds);
	const predicate = visibilityPredicate(principal, readerOrgIds);

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
			`SELECT body, user_id, visibility, org_id FROM lessons
			 WHERE ${where}
			 ORDER BY promoted_at DESC, id DESC
			 LIMIT ?`,
		)
		.bind(...binds)
		.all<{
			body: string;
			user_id: string;
			visibility: string;
			org_id: string | null;
		}>();

	const rows = results ?? [];
	const hasMore = rows.length > limit;
	const kept = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
		lesson: JSON.parse(r.body) as { id: string; promoted_at: string },
		userId: r.user_id,
		visibility: r.visibility,
		orgId: r.org_id,
	}));
	const page = kept.map((r) => r.lesson);

	// Derived from the rows actually returned, so the lookahead row that only
	// decides has_more can never leak an id into it.
	const ownedIds = principal
		? kept.filter((r) => r.userId === principal.userId).map((r) => r.lesson.id)
		: [];

	// Attributed only where the org disjunct is what matched. A row is
	// org-reached when it is an 'org' row whose org is one of the reader's: a
	// public row is not, and neither is the reader's own 'org' row once they
	// have left that org.
	//
	// Bounded the same way visibilityPredicate bounds its own IN list, even
	// though this filter cannot misbehave on an unbounded list - it runs
	// in-memory over rows the predicate already admitted, so a row whose org
	// was truncated away by the predicate never reaches here at all. The
	// bound is applied anyway so this, the predicate, and orgAuthorName all
	// agree on one reader-org list rather than each truncating it separately.
	const boundedReaderOrgIds = readerOrgIds.slice(0, MAX_READER_ORGS_BOUND);
	const orgReached = kept.filter(
		(r) =>
			r.visibility === "org" &&
			// Narrows r.orgId from `string | null` to `string` for the
			// `includes` call below, rather than filtering anything the next
			// line would not already exclude - a null fails `includes` on a
			// string[] anyway. Removing it is a type error, not a cleanup:
			// `Array<string>.includes` does not accept `string | null`.
			r.orgId !== null &&
			boundedReaderOrgIds.includes(r.orgId),
	);
	const authors = await authorNames(db, orgReached);

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
		authors,
	};
}

/**
 * Author names for the org rows on one page, by lesson id.
 *
 * A second statement rather than a join in the pool read, for two reasons. The
 * repo's own precedent is this shape - see getLessonForUser's note on not
 * widening readPoolLesson's SELECT - and a LEFT JOIN in the main statement
 * would change the plan that pool-query-plan.test.ts pins, for a lookup that
 * most pages do not need at all.
 *
 * Runs no statement when a page carries no org rows, which is every anonymous
 * read and most authenticated ones.
 */
async function authorNames(
	db: D1Database,
	orgReached: Array<{ lesson: { id: string }; userId: string }>,
): Promise<Record<string, string>> {
	if (orgReached.length === 0) return {};

	const ids = [...new Set(orgReached.map((r) => r.userId))];
	const names = new Map<string, string>();

	for (let at = 0; at < ids.length; at += AUTHOR_LOOKUP_CHUNK) {
		const chunk = ids.slice(at, at + AUTHOR_LOOKUP_CHUNK);
		const { results } = await db
			.prepare(
				`SELECT id, name FROM users
				 WHERE id IN (${chunk.map(() => "?").join(", ")})`,
			)
			.bind(...chunk)
			.all<{ id: string; name: string | null }>();

		for (const row of results ?? []) {
			// A null or empty name produces no key at all. The server does not
			// invent a label for a member who never set one.
			if (row.name) names.set(row.id, row.name);
		}
	}

	const authors: Record<string, string> = {};
	for (const row of orgReached) {
		const name = names.get(row.userId);
		if (name) authors[row.lesson.id] = name;
	}
	return authors;
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
	orgIds: OrgIds = noOrgIds,
): Promise<unknown | null> {
	const readerOrgIds = await resolveOrgIds(db, principal, orgIds);
	const predicate = visibilityPredicate(principal, readerOrgIds);

	const row = await db
		.prepare(
			`SELECT body FROM lessons
			 WHERE id = ? AND ${predicate.sql}`,
		)
		.bind(id, ...predicate.binds)
		.first<{ body: string }>();

	return row ? (JSON.parse(row.body) as unknown) : null;
}

/**
 * The name of an org lesson's author, for a reader who reaches it through the
 * org disjunct - or null.
 *
 * A separate function from readPoolLesson rather than a widening of it. That
 * one is also the anonymous public route's read, and its contract is that no
 * code path may widen what it sees; leaving its shape and its single caller
 * list alone is worth more than saving a primary-key lookup here.
 *
 * This is a name lookup, not an authorization check: its WHERE tests
 * `visibility`/`org_id` but omits the retracted-and-blocked-author boundary
 * `visibilityPredicate` applies, because duplicating that logic into a
 * second query would be a worse defect than this function existing at all -
 * `visibilityPredicate` stays the only place a visibility predicate is
 * constructed. That means this must never be called for a lesson id that
 * has not already been established as readable. Its one caller,
 * `getLessonForUser` in lessons.ts, satisfies that by construction: it
 * already returned null (lessons.ts, `if (!lesson) return null`) for any
 * row `readPoolLesson` - which DOES apply the full predicate - would not
 * admit, before this ever runs.
 */
export async function orgAuthorName(
	db: D1Database,
	readerOrgIds: string[],
	lessonId: string,
): Promise<string | null> {
	if (readerOrgIds.length === 0) return null;

	// Bounded the same way visibilityPredicate bounds its own IN list - a
	// reader in more orgs than the cap must not blow D1's bound-parameter
	// limit and turn a readable deep link into a 500. See MAX_READER_ORGS_BOUND.
	const bounded = readerOrgIds.slice(0, MAX_READER_ORGS_BOUND);

	const row = await db
		.prepare(
			`SELECT u.name AS name FROM lessons l
			 JOIN users u ON u.id = l.user_id
			 WHERE l.id = ?
			   AND l.visibility = 'org'
			   AND l.org_id IN (${bounded.map(() => "?").join(", ")})`,
		)
		.bind(lessonId, ...bounded)
		.first<{ name: string | null }>();

	return row?.name ?? null;
}
