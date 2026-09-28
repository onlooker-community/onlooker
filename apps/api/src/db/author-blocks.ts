import type { D1Database } from "@cloudflare/workers-types";

/**
 * The blocklist, written by the operator routes below.
 *
 * The read side is not here. `db/pool.ts`'s `visibilityPredicate` builds its
 * own inline `NOT EXISTS (SELECT 1 FROM lesson_author_blocks ...)` rather than
 * calling a function from this file, because the subquery has to be atomic
 * with the read it guards - a separate query-then-check has a window between
 * the two where the fail-closed guarantee would not hold. That subquery is
 * what actually enforces the block; nothing here reads it back.
 */

/**
 * Block an author key. Idempotent: blocking twice is not an error, because an
 * operator acting on a report should not have to check first.
 */
export async function blockAuthor(
	db: D1Database,
	authorKey: string,
	reason: string,
	blockedBy: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO lesson_author_blocks (author_key, reason, blocked_by)
			 VALUES (?, ?, ?)
			 ON CONFLICT(author_key) DO UPDATE SET
			   reason = excluded.reason,
			   blocked_by = excluded.blocked_by,
			   blocked_at = CURRENT_TIMESTAMP`,
		)
		.bind(authorKey, reason, blockedBy)
		.run();
}

/** Lift a block. Returns whether there was one, so a typo'd key reads as 404. */
export async function unblockAuthor(
	db: D1Database,
	authorKey: string,
): Promise<boolean> {
	const result = await db
		.prepare("DELETE FROM lesson_author_blocks WHERE author_key = ?")
		.bind(authorKey)
		.run();
	return (result.meta.changes ?? 0) > 0;
}
