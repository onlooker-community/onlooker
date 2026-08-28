import type { TLesson, TStatus } from "@onlooker-community/lesson-contract";
import { apiClient } from "./client";

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
export function getLesson(id: string): Promise<Lesson> {
	return apiClient.get<Lesson>(
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
