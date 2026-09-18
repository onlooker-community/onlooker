import type { D1Database } from "@cloudflare/workers-types";
import { session_summaries } from "@onlooker/db";
import { client } from "./client.js";

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
	plugins: string[];
	prompts: number;
	compactions: number;
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
