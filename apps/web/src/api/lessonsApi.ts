import type { TLesson, TStatus } from "@onlooker-community/lesson-contract";
import { apiClient } from "./client";
import { ORG_ENDPOINTS } from "./orgsApi";

// The pool, as a person browses it. Beside machinesApi.ts and deliberately the
// same shape: transport - auth header, retries, refresh-and-replay on 401 -
// belongs to client.ts and is not re-implemented here.
//
// These are NOT the machine-authenticated /lessons routes. Those are delta-
// shaped: a sequence cursor, every status, built for a mirror draining a
// queue. Browsing is the opposite read, and the two are kept apart so a change
// made for a person cannot break a mirror mid-drain. See the design's
// Section 3 for why dual-authenticating one surface was rejected.

export const LESSON_ENDPOINTS = {
	lessons: "/api/lessons",
	activity: "/api/activity",
} as const;

/**
 * A lesson, as the contract package defines it and nowhere else.
 *
 * Imported rather than mirrored. machinesApi.ts declares its own `Machine`
 * because MachineTokenSummary is an apps/api internal with no published
 * definition; TLesson is the published contract, and a second copy of it in
 * the browser would be exactly the drift @onlooker-community/lesson-contract
 * exists to prevent. `import type` is erased at build, so zod does not reach
 * the bundle.
 */
export type Lesson = TLesson;

/** The four values the `status` column holds. */
export type LessonStatus = TStatus;

/**
 * An org the signed-in account may retract a lesson in.
 *
 * Mirrors `RetractableOrg` in apps/api's pool-page.ts. The name is sent rather
 * than resolved here because this page lists no orgs of its own.
 */
export interface RetractableOrg {
	org_id: string;
	org_name: string;
}

/**
 * The two a human may assert from a browser.
 *
 * `refuted` means a claim was tried and found false and belongs to the
 * counter-observation path that produces it - a click is not evidence.
 * `superseded` must name the lesson that replaced it, and the browser has no
 * authoring. apps/api rejects both with a 400 naming why; this type is a
 * convenience for callers, not the enforcement. A rule that lives only in the
 * client is not a rule.
 */
export type BrowserStatus = Extract<LessonStatus, "active" | "retracted">;

/** One page of the pool. Field names are the API's, not camelCased. */
export interface LessonPage {
	lessons: Lesson[];
	cursor: string | null;
	has_more: boolean;
	/**
	 * Which of `lessons` belong to the signed-in account, by id.
	 *
	 * The pool answers with other people's public lessons; the write path is
	 * still owner-scoped, so a status control offered on a lesson absent from
	 * this list can only 404. It cannot be derived here - a lesson body holds
	 * no user_id, deliberately - so the server says it, beside the documents
	 * rather than inside them.
	 *
	 * Always sent, empty when the caller owns none of the page.
	 */
	owned_ids: string[];
	/**
	 * The names of the authors of the org lessons on this page, by lesson id.
	 *
	 * Carried beside the documents for the reason `owned_ids` is - a lesson
	 * body is the published contract's shape, and nothing server-computed
	 * belongs in it. Only an org row the caller can read through membership
	 * carries a name here; a public row's author stays behind its opaque
	 * author_key. A key is absent when the author has no name set - the
	 * server does not invent a label, and this client must not either.
	 *
	 * Always sent, empty when the page holds no org rows.
	 */
	authors: Record<string, string>;
	/**
	 * Which org, if any, the signed-in account may retract each org lesson
	 * in, by lesson id.
	 *
	 * The server decides what the caller may act on, not this client - a key
	 * appears only for a teammate's org lesson in an org the caller owns, and
	 * the caller did not author. Carried beside the documents for the same
	 * reason `authors` is.
	 *
	 * Always sent, empty when nothing on this page qualifies.
	 */
	retractable_in: Record<string, RetractableOrg>;
	/**
	 * Which of `lessons` had an author whose account has since been
	 * anonymized, by id.
	 *
	 * Carried beside the documents for the reason `authors` is - the server
	 * says who has left, and a literal string in a name field cannot be told
	 * apart from a member who actually chose that as their name, so this
	 * must be its own key rather than a magic value inside `authors`. The
	 * label itself ("Former member") is this client's wording, never the
	 * server's - see `former_author` on `OwnedLesson`.
	 *
	 * Always sent, empty when nothing on this page qualifies.
	 */
	former_authors: string[];
}

/** One lesson, with the same ownership answer `owned_ids` gives for a page. */
export interface OwnedLesson {
	lesson: Lesson;
	own: boolean;
	/**
	 * This lesson's author name, the same way `authors` names one on a page -
	 * absent when the author has no name set, or when the row is public
	 * rather than attributed through an org.
	 */
	author_name: string | null;
	/**
	 * Whether this lesson's author's account has since been anonymized, the
	 * same way `former_authors` answers for a page - always sent, and the
	 * one fact `author_name` alone cannot distinguish from a member who
	 * never set a name.
	 */
	former_author: boolean;
	/**
	 * This lesson's retract authority, the same way `retractable_in` answers
	 * for a page - present only when this is a teammate's org lesson in an
	 * org the caller owns, `null` otherwise.
	 */
	retractable_in: RetractableOrg | null;
}

export interface ListLessonsOptions {
	statuses?: LessonStatus[];
	cursor?: string | null;
	limit?: number;
}

export function listLessons(
	options: ListLessonsOptions = {},
): Promise<LessonPage> {
	const query = new URLSearchParams();

	// Appended once per status, not joined. handleBrowseLessons reads
	// searchParams.getAll("status"), so "active,retracted" would arrive as a
	// single unrecognized status and come back a 400.
	for (const status of options.statuses ?? []) query.append("status", status);

	// `if (cursor)` and not `!= null`: apps/api guards the same way, treating
	// "" as absent. Sending `?cursor=` for an empty string would be a request
	// neither implementation needs to answer.
	if (options.cursor) query.set("cursor", options.cursor);
	if (options.limit !== undefined) query.set("limit", String(options.limit));

	const search = query.toString();
	return apiClient.get<LessonPage>(
		search ? `${LESSON_ENDPOINTS.lessons}?${search}` : LESSON_ENDPOINTS.lessons,
	);
}

/**
 * One lesson by id, for the deep link the list cannot answer.
 *
 * The list returns full bodies, so clicking down the loaded pages issues no
 * requests at all. This exists for the one case that cannot work that way: an
 * id that is not in any page the browser has loaded.
 */
export function getLesson(id: string): Promise<OwnedLesson> {
	return apiClient.get<OwnedLesson>(
		`${LESSON_ENDPOINTS.lessons}/${encodeURIComponent(id)}`,
	);
}

/**
 * Move a lesson between `active` and `retracted`.
 *
 * Returns the feed sequence the transition was written at, not the updated
 * lesson - the same `transitionLesson` the machine route calls, which appends
 * to lesson_feed, so a retraction made here reaches every mirror on its next
 * delta pull with no new sync machinery.
 */
export function setLessonStatus(
	id: string,
	status: BrowserStatus,
): Promise<{ id: string; seq: number }> {
	return apiClient.patch<{ id: string; seq: number }>(
		`${LESSON_ENDPOINTS.lessons}/${encodeURIComponent(id)}/status`,
		{ status },
	);
}

/**
 * Retract a lesson at org level, on the authority of owning the org it was
 * shared with.
 *
 * A different endpoint from `setLessonStatus`, deliberately: that one is
 * owner-scoped by `WHERE id = ? AND user_id = ?` and can only ever move the
 * caller's own lesson. This one is one-way - there is no org-level route back
 * to active - and the UI says so before it is used.
 *
 * Routed through `ORG_ENDPOINTS.orgs` (orgsApi.ts) rather than a path built
 * here, the same way every other /api/orgs call is - this is an org-scoped
 * route wearing a lessons-shaped tail, not a lessons route.
 */
export function retractOrgLesson(
	orgId: string,
	lessonId: string,
): Promise<{ id: string; seq: number; status: string }> {
	return apiClient.post<{ id: string; seq: number; status: string }>(
		`${ORG_ENDPOINTS.orgs}/${encodeURIComponent(orgId)}/lessons/${encodeURIComponent(lessonId)}/retract`,
		{},
	);
}

/**
 * One event in the reader's own feed. Field names are the API's, not camelCased.
 *
 * The wire also carries `applies_to` and `status`. Both are omitted on purpose.
 * A status row must name no state — see the approved limitation in
 * 2026-08-31-lesson-activity-screen-design.md — and leaving `status` off this
 * type makes rendering it a compile error rather than a review catch. `applies_to`
 * has no consumer. Add either the moment one does.
 */
export interface ActivityEvent {
	seq: number;
	kind: string;
	at: string;
	lesson_id: string;
	claim: string;
}

/**
 * One page of the activity feed.
 *
 * Named `ActivityFeedPage` and not `ActivityPage`, which is what the server
 * type in apps/api/src/db/lessons.ts is called: the browser already has a
 * component by that name, and both are imported into ActivityPage.tsx. The
 * server has no such collision, which is why the names diverge here rather
 * than there.
 */
export interface ActivityFeedPage {
	events: ActivityEvent[];
	cursor: string | null;
	has_more: boolean;
}

export interface ListActivityOptions {
	cursor?: string | null;
}

/**
 * The reader's own feed, newest first.
 *
 * Lives beside listLessons rather than in an activityApi.ts because the server
 * made the same choice for the same reason: listActivityPage sits with
 * listLessonsPage in apps/api/src/db/lessons.ts, since this is the second read
 * over the same feed the browse routes already page through.
 */
export function listActivity(
	options: ListActivityOptions = {},
): Promise<ActivityFeedPage> {
	const query = new URLSearchParams();

	// `if (cursor)` and not `!= null`, matching listLessons above and apps/api:
	// both treat "" as absent.
	if (options.cursor) query.set("cursor", options.cursor);

	const search = query.toString();
	return apiClient.get<ActivityFeedPage>(
		search
			? `${LESSON_ENDPOINTS.activity}?${search}`
			: LESSON_ENDPOINTS.activity,
	);
}
