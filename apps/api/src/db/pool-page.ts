/**
 * Leaf module for the pool-page shape: the browse limits, the keyset cursor
 * codecs, and the error a bad cursor raises.
 *
 * No imports of its own, on purpose. `pool.ts` needs these while `lessons.ts`
 * imports `readPool`/`readPoolLesson` from `pool.ts` - importing both
 * directions would be a cycle, so this file sits underneath both:
 * `pool-page.ts` <- `pool.ts` <- `lessons.ts`.
 */

/** Default and ceiling for one browsing page. */
export const BROWSE_DEFAULT_LIMIT = 50;
export const BROWSE_MAX_LIMIT = 200;

/**
 * A keyset cursor carries BOTH sort keys, because promoted_at alone is not
 * unique. Two lessons promoted in the same millisecond would make the boundary
 * ambiguous, and a page break landing between them either skips a lesson or
 * shows it twice.
 *
 * Opaque on purpose: the client echoes it back and never constructs one, so
 * the sort keys can change without becoming a breaking API change. `\n` is the
 * join delimiter because neither an ISO timestamp nor a ULID can contain one.
 */
export function encodeCursor(promotedAt: string, id: string): string {
	return btoa(`${promotedAt}\n${id}`);
}

export function decodeCursor(
	cursor: string,
): { promotedAt: string; id: string } | null {
	try {
		const [promotedAt, id, ...rest] = atob(cursor).split("\n");
		if (!promotedAt || !id || rest.length > 0) return null;
		return { promotedAt, id };
	} catch {
		// atob throws on anything that is not base64. A client-supplied cursor
		// is untrusted input, and a malformed one is a 400, not a 500.
		return null;
	}
}

/** Raised when a client sends a cursor this server did not mint. */
export class InvalidCursorError extends Error {
	constructor() {
		super("Invalid cursor");
		this.name = "InvalidCursorError";
	}
}

export interface LessonPage {
	lessons: unknown[];
	cursor: string | null;
	hasMore: boolean;
	/**
	 * Which of `lessons` belong to the caller, by id.
	 *
	 * Carried beside the documents rather than inside them. A lesson body is
	 * the published contract's shape and nothing server-computed belongs in
	 * it - and a body holds no user_id by design, since another account's
	 * owner is not the reader's business. Yet once the pool answers with other
	 * people's public lessons, a browser has to know which ones it may act on:
	 * the write path is still owner-scoped, so offering a retract on a lesson
	 * absent from this list renders a control that can only 404.
	 *
	 * Empty for an anonymous caller, who owns nothing by construction.
	 */
	ownedIds: string[];
}
