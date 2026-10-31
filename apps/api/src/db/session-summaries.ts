import type { D1Database } from "@cloudflare/workers-types";
import { session_summaries } from "@onlooker/db";
import { client } from "./client.js";
import { BROWSE_MAX_LIMIT, InvalidCursorError } from "./lessons.js";

/**
 * One session summary as the route has validated it, ready to store.
 *
 * Mirrors session_summaries' columns minus the ones the caller supplies
 * separately: user_id and machine_id come from the verified token, never the
 * body (see handlePostSessions), and reported_at is this write's timestamp,
 * not the machine's.
 */
export interface SessionSummaryInput {
	session_id: string;
	started_at: string;
	/** Null while the session is still running. */
	ended_at: string | null;
	event_count: number;
	counts_by_prefix: Record<string, number>;
	/**
	 * Full event type -> count (ONL-128). Absent from every CLI older than
	 * this field, and stored as an empty map then. The route has already held
	 * each key to the registered-name pattern.
	 */
	counts_by_type?: Record<string, number>;
	/**
	 * Project key -> `{ basis, event_count }`, for the events of this session
	 * that were attributable to a repository. Empty when none were, which is
	 * every session reported by a CLI older than this column.
	 *
	 * Opaque keys only. A project key is a hash, never a path or a repo name,
	 * so no directory or repository name reaches the server by this route - the
	 * key -> display-name mapping is a separate, explicitly opt-in upload.
	 */
	counts_by_project: Record<string, ProjectCount>;
	plugins: string[];
	prompts: number;
	compactions: number;
}

/** One repository's share of a session. Mirrors the CLI's own ProjectCount. */
export interface ProjectCount {
	/**
	 * `remote` keys are portable across machines; `root` keys are derived from
	 * a local path, so the same remote-less repo on two machines produces two
	 * different keys. Stored so a reader can aggregate confidently on the
	 * former and scope or flag the latter, rather than summing them blindly.
	 */
	basis: "remote" | "root";
	event_count: number;
}

/**
 * Store one machine's session summaries, upserting by (machine_id, session_id).
 *
 * A session reported twice - once still running, once ended - updates its one
 * row instead of creating a second. That is the whole reason the table is
 * keyed the way it is: see session_summaries in packages/db/src/schema.ts.
 *
 * One batch rather than one statement per session, for the same reason
 * rotateRefreshToken batches in queries.ts: it is one round trip to D1 instead
 * of N.
 */
export async function putSessionSummaries(
	db: D1Database,
	userId: string,
	machineId: string,
	summaries: SessionSummaryInput[],
): Promise<void> {
	if (summaries.length === 0) return;

	const reportedAt = new Date().toISOString();
	const drizzle = client(db);

	const statements = summaries.map((summary) => {
		const row = {
			user_id: userId,
			machine_id: machineId,
			session_id: summary.session_id,
			started_at: summary.started_at,
			ended_at: summary.ended_at,
			event_count: summary.event_count,
			counts_by_prefix: JSON.stringify(summary.counts_by_prefix),
			// `?? {}` for the reason spelled out on counts_by_project below.
			counts_by_type: JSON.stringify(summary.counts_by_type ?? {}),
			// `?? {}` rather than relying on the column default: the default
			// only applies to an INSERT that omits the column, and this row
			// object names it explicitly, so an older CLI that posts no
			// counts_by_project would otherwise stringify `undefined` into
			// the literal text "undefined" and break every later JSON.parse.
			counts_by_project: JSON.stringify(summary.counts_by_project ?? {}),
			plugins: JSON.stringify(summary.plugins),
			prompts: summary.prompts,
			compactions: summary.compactions,
			reported_at: reportedAt,
		};

		return drizzle
			.insert(session_summaries)
			.values(row)
			.onConflictDoUpdate({
				target: [session_summaries.machine_id, session_summaries.session_id],
				// The key columns (machine_id, session_id) are excluded on
				// purpose - they are the thing being matched on, not updated.
				set: {
					user_id: row.user_id,
					started_at: row.started_at,
					ended_at: row.ended_at,
					event_count: row.event_count,
					counts_by_prefix: row.counts_by_prefix,
					counts_by_type: row.counts_by_type,
					counts_by_project: row.counts_by_project,
					plugins: row.plugins,
					prompts: row.prompts,
					compactions: row.compactions,
					reported_at: row.reported_at,
				},
			});
	});

	// batch()'s type requires a non-empty tuple, not a plain array, to
	// guarantee at least one statement at compile time. summaries.length === 0
	// already returned above, so the array built above is never actually
	// empty; this asserts what the early return already established.
	await drizzle.batch(
		statements as [
			(typeof statements)[number],
			...(typeof statements)[number][],
		],
	);
}

/**
 * One session summary as the browser reads it - `counts_by_prefix` and
 * `plugins` already parsed out of their JSON TEXT columns, so a client never
 * sees the storage representation.
 */
export interface SessionSummaryRow {
	machine_id: string;
	session_id: string;
	started_at: string;
	ended_at: string | null;
	event_count: number;
	counts_by_prefix: Record<string, number>;
	counts_by_type: Record<string, number>;
	counts_by_project: Record<string, ProjectCount>;
	plugins: string[];
	prompts: number;
	compactions: number;
}

export interface SessionSummariesPage {
	sessions: SessionSummaryRow[];
	cursor: string | null;
	hasMore: boolean;
}

/**
 * A keyset cursor over (started_at, machine_id, session_id), not started_at
 * alone. Two summaries can share a started_at for one user - two machines
 * syncing at once, or a fast pair of CLI runs - and (machine_id, session_id)
 * is this table's actual primary key, so it is what breaks the tie. Same
 * reasoning as encodeCursor in db/lessons.ts, one column wider because this
 * table's key has two parts where a lesson's has one.
 *
 * `\n` is the join delimiter for the same reason encodeCursor uses it: none
 * of started_at (ISO timestamp), a machine id or a session id can contain one.
 */
export function encodeSessionsCursor(
	startedAt: string,
	machineId: string,
	sessionId: string,
): string {
	return btoa(`${startedAt}\n${machineId}\n${sessionId}`);
}

export function decodeSessionsCursor(
	cursor: string,
): { startedAt: string; machineId: string; sessionId: string } | null {
	try {
		const [startedAt, machineId, sessionId, ...rest] = atob(cursor).split("\n");
		if (!startedAt || !machineId || !sessionId || rest.length > 0) {
			return null;
		}
		return { startedAt, machineId, sessionId };
	} catch {
		// atob throws on anything that is not base64. A client-supplied cursor
		// is untrusted input, and a malformed one is a 400, not a 500 - same
		// reasoning as decodeCursor in db/lessons.ts.
		return null;
	}
}

/**
 * One page of a user's session summaries, newest first.
 *
 * Ordered by (started_at, machine_id, session_id), all DESC - see
 * encodeSessionsCursor for why started_at alone is not enough. The matching
 * index, session_summaries_user_started_idx, covers (user_id, started_at) and
 * leaves the tiebreaker to an in-memory sort over what should ordinarily be a
 * handful of same-instant rows - the same trade listLessonsPage makes against
 * lessons_user_promoted_at_idx, which does not index its own tiebreaker id
 * either.
 *
 * Reuses InvalidCursorError and the browse limit ceiling from db/lessons.ts
 * rather than declaring a second version of either - this is the same
 * keyset-pagination shape listActivityPage and listLessonsPage already use,
 * just walked over this table's own two-part key instead of a bare sequence.
 */
export async function listSessionSummaries(
	db: D1Database,
	userId: string,
	opts: { cursor?: string | null; limit: number },
): Promise<SessionSummariesPage> {
	const limit = Math.min(Math.max(1, opts.limit), BROWSE_MAX_LIMIT);
	const binds: unknown[] = [userId];
	let where = "user_id = ?";

	if (opts.cursor) {
		const after = decodeSessionsCursor(opts.cursor);
		if (!after) throw new InvalidCursorError();
		where += " AND (started_at, machine_id, session_id) < (?, ?, ?)";
		binds.push(after.startedAt, after.machineId, after.sessionId);
	}

	binds.push(limit + 1);

	const { results } = await db
		.prepare(
			`SELECT machine_id, session_id, started_at, ended_at, event_count,
			        counts_by_prefix, counts_by_type, counts_by_project, plugins,
			        prompts, compactions
			 FROM session_summaries
			 WHERE ${where}
			 ORDER BY started_at DESC, machine_id DESC, session_id DESC
			 LIMIT ?`,
		)
		.bind(...binds)
		.all<{
			machine_id: string;
			session_id: string;
			started_at: string;
			ended_at: string | null;
			event_count: number;
			counts_by_prefix: string;
			counts_by_type: string | null;
			counts_by_project: string | null;
			plugins: string;
			prompts: number;
			compactions: number;
		}>();

	const rows = results ?? [];
	const hasMore = rows.length > limit;
	const sessions = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
		machine_id: r.machine_id,
		session_id: r.session_id,
		started_at: r.started_at,
		ended_at: r.ended_at,
		event_count: r.event_count,
		counts_by_prefix: JSON.parse(r.counts_by_prefix) as Record<string, number>,
		// `?? "{}"` for the reason given on counts_by_project, with migration
		// 0016 in place of 0014.
		counts_by_type: JSON.parse(r.counts_by_type ?? "{}") as Record<
			string,
			number
		>,
		// Typed `string | null` and defaulted here even though the column is
		// NOT NULL DEFAULT '{}'. The default covers rows inserted without the
		// column, but a D1 instance that has not yet run migration 0014 returns
		// the field as absent/null for every row, and `JSON.parse(null)` yields
		// null rather than throwing - which would put a null into a field the
		// browser's type says is an object. One `?? "{}"` closes both.
		counts_by_project: JSON.parse(r.counts_by_project ?? "{}") as Record<
			string,
			ProjectCount
		>,
		plugins: JSON.parse(r.plugins) as string[],
		prompts: r.prompts,
		compactions: r.compactions,
	}));

	const last = sessions.at(-1);
	const cursor =
		hasMore && last
			? encodeSessionsCursor(last.started_at, last.machine_id, last.session_id)
			: null;

	// Asserted rather than trusted, for the same reason listActivityPage
	// asserts it: hasMore, the clamped limit and the cursor are three separate
	// facts, and a change to any one of them would silently hide the tail of
	// the list.
	if (hasMore && cursor === null) {
		throw new Error(
			"listSessionSummaries: has_more is true with no cursor; the tail would be unreachable",
		);
	}

	return { sessions, cursor, hasMore };
}

/**
 * A hundred and eighty days.
 *
 * Not a capacity decision - one machine produces on the order of 9,000 rows a
 * year and D1 would not notice. It is here so that "forever" is a thing someone
 * chose rather than a thing nobody decided. Two quarters is long enough to see
 * a trend and short enough that a row written today has a stated end.
 */
export const RETENTION_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Delete summaries whose session started before the retention window, and
 * report how many rows went.
 *
 * The boundary belongs to the kept side: a row started exactly
 * RETENTION_DAYS ago is not older than the cutoff, so it survives. That is
 * the whole reason this compares with `<` rather than `<=` - "180 days of
 * history" should mean 180, not 179.
 *
 * `now` defaults to the real clock and is only ever overridden by a test.
 * Passing it explicitly is what lets the boundary test seed a row and check
 * the cutoff against the same instant instead of racing the wall clock
 * between the two.
 */
export async function pruneSessionSummaries(
	db: D1Database,
	now: Date = new Date(),
): Promise<number> {
	const cutoff = new Date(
		now.getTime() - RETENTION_DAYS * DAY_MS,
	).toISOString();

	const result = await db
		.prepare("DELETE FROM session_summaries WHERE started_at < ?")
		.bind(cutoff)
		.run();

	return result.meta.changes;
}
