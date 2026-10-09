import { retractOrgLesson, SequenceExhaustedError } from "../db/lessons.js";
import type { Principal } from "../db/pool.js";
import { requireOrgRole } from "../orgs/authorize.js";
import type { RouteParams, WorkerEnv } from "../types";
import { ApiError } from "../types";

/**
 * Org-level moderation of org lessons.
 *
 * Owner only, and scoped to the org in the path: requireOrgRole throws the
 * same 404 for a non-member as for an org that does not exist, and
 * retractOrgLesson refuses any lesson not shared with THIS org, so an owner of
 * one org cannot reach inside another.
 */
export async function handleRetractOrgLesson(
	_request: Request,
	env: WorkerEnv,
	params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	await requireOrgRole(env.DB, principal, params.id, "owner");

	let seq: number | null;
	try {
		seq = await retractOrgLesson(env.DB, params.id, params.lessonId);
	} catch (error) {
		if (error instanceof SequenceExhaustedError) {
			// Nothing was written when this fires - the batch rolled back whole
			// and no sequence number was consumed - so retry is correct advice,
			// where a bare 500 would tell the caller their request may or may not
			// have landed. The same distinction handleOperatorRetract and
			// handleBrowserTransition already make for their own retracts.
			throw new ApiError(
				503,
				"sequence_contention",
				"Could not assign a lesson sequence; nothing was written, so retry",
			);
		}
		throw error;
	}

	// 404 and not 403: a distinguishable answer would confirm that a lesson id
	// exists, which is the reasoning transitionLesson and getLessonForUser
	// both already follow.
	if (seq === null) throw new ApiError(404, "not_found", "No such lesson");

	// Matches the retract family's shape (handleOperatorRetract,
	// admin-moderation.ts:35), the closest relative: also a retract by
	// someone other than the author.
	return Response.json({ id: params.lessonId, seq, status: "retracted" });
}
