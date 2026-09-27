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
