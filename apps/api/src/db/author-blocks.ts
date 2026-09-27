import type { D1Database } from "@cloudflare/workers-types";

/**
 * The blocklist, read by the pool predicate and written by the operator routes.
 *
 * A read that cannot resolve the blocklist must fail rather than serve
 * unfiltered, so nothing here catches its own errors.
 */
export async function isAuthorBlocked(
	db: D1Database,
	authorKey: string,
): Promise<boolean> {
	const row = await db
		.prepare("SELECT 1 AS hit FROM lesson_author_blocks WHERE author_key = ?")
		.bind(authorKey)
		.first<{ hit: number }>();
	return row !== null;
}

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
