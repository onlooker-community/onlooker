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

/**
 * An org a reader may retract a lesson in, named so the browser can say which.
 *
 * The name rides along rather than being resolved client-side, which is a
 * deliberate departure from `MachineTokenSummary.org_id`. That one carries an
 * id alone because the page rendering it already lists the account's orgs to
 * build a picker; the lessons page lists no orgs and has no other reason to,
 * so making it fetch the whole list to render one label would be worse than
 * sending eleven more bytes.
 */
export interface RetractableOrg {
	org_id: string;
	org_name: string;
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
	/**
	 * The names of the authors of the org lessons on this page, by lesson id.
	 *
	 * Carried beside the documents for the reason `ownedIds` is: a lesson body
	 * is the published contract's shape and nothing server-computed belongs in
	 * it.
	 *
	 * Only rows whose `visibility` is `'org'` and whose `org_id` is one of the
	 * reader's appear here. A public row carries `author_key` alone, so the
	 * anonymous surface's disclosure is unchanged and nothing links an author
	 * across tiers. Attribution follows the org match, not the route the row
	 * arrived by: a reader's own org lesson, in an org they still belong to,
	 * is attributed with their own name - harmless, since it is their name on
	 * their own lesson - while their own org lesson in an org they have LEFT
	 * is reached only through ownership and gets no key.
	 *
	 * A key is absent when the author has no name set. The server does not
	 * substitute an email - a different disclosure class - and does not invent
	 * a label.
	 *
	 * Always present, empty for an anonymous caller and for a page with no org
	 * rows on it.
	 */
	authors: Record<string, string>;
	/**
	 * The org lessons on this page whose author's account has been anonymized.
	 *
	 * A separate list rather than a sentinel in `authors`, for the reason
	 * `authorNames` gives for emitting no key at all when a name is missing:
	 * the server does not invent labels, and a literal like "Former member" in
	 * a name field cannot be told apart from a user who set that as their
	 * actual name. The client renders the words.
	 *
	 * Disjoint from `authors` by construction - an anonymized row has a NULL
	 * name, which produces no `authors` key.
	 */
	formerAuthors: string[];
	/**
	 * The lessons on this page the reader may retract at org level, by lesson
	 * id, each naming the org that grants it.
	 *
	 * Carried beside the documents for the reason `ownedIds` is, and populated
	 * by the same principle: the server decides what the caller may act on and
	 * the browser renders it. A key appears only when the row reached this
	 * reader through the ORG disjunct and the reader's role in that org is
	 * `owner`.
	 *
	 * Absent for the reader's own lesson even in an org they own - the
	 * author's own bidirectional control answers for that one, and the org
	 * retract is one-way.
	 *
	 * Always present, empty for an anonymous caller and for any page with no
	 * org rows on it.
	 */
	retractableIn: Record<string, RetractableOrg>;
}
