import { readPoolLesson } from "../db/pool.js";
import type { RouteParams, WorkerEnv } from "../types";
import { ApiError } from "../types";

/**
 * How long a public lesson may sit in a cache.
 *
 * THIS NUMBER IS THE FLOOR ON TAKEDOWN LATENCY. A retracted or newly blocked
 * lesson keeps being served until every cached copy expires, and a fast pull is
 * the control the whole moderation story rests on. Raising it lengthens the
 * window in which a lesson nobody can withdraw is still reaching readers.
 */
const MAX_AGE_SECONDS = 60;

/**
 * One public lesson, to anybody, with no credential.
 *
 * This handler exists separately from the browse routes for one reason: it may
 * only ever call readPoolLesson with a null principal. A predicate bug on an
 * authenticated route leaks to one signed-in user; the same bug here leaks to
 * the internet, so there must be no code path where a caller-supplied value
 * could widen what this sees.
 */
export async function handlePublicLesson(
	_request: Request,
	env: WorkerEnv,
	params: RouteParams,
): Promise<Response> {
	// Literal null, never a variable. See the note above.
	const found = await readPoolLesson(env.DB, null, params.id);

	// 404 and not 403: a 403 would confirm the id exists, which is the same
	// reasoning getLessonForUser and transitionLesson already follow.
	if (!found) throw new ApiError(404, "not_found", "No such lesson");

	return Response.json(found, {
		headers: { "Cache-Control": `public, max-age=${MAX_AGE_SECONDS}` },
	});
}
