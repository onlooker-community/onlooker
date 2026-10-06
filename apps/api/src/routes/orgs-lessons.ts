import { retractOrgLesson } from "../db/lessons.js";
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

	const seq = await retractOrgLesson(env.DB, params.id, params.lessonId);

	// 404 and not 403: a distinguishable answer would confirm that a lesson id
	// exists, which is the reasoning transitionLesson and getLessonForUser
	// both already follow.
	if (seq === null) throw new ApiError(404, "not_found", "No such lesson");

	return Response.json({ success: true, seq });
}
