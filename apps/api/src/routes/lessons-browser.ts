import {
	BROWSE_DEFAULT_LIMIT,
	getLessonForUser,
	InvalidCursorError,
	listLessonsPage,
	SequenceExhaustedError,
	transitionLesson,
} from "../db/lessons.js";
import { requireAuth } from "../middleware/auth.js";
import type { RouteParams, WorkerEnv } from "../types";
import { ApiError } from "../types";

/**
 * Browsing is a separate surface from sync, on purpose.
 *
 * GET /lessons is machine-authenticated and delta-shaped: a sequence cursor,
 * every status, built for a mirror draining a queue. These routes are the
 * opposite read, and they are kept apart so a change made for a person cannot
 * break a mirror mid-drain. See the design's Section 3.
 */

/** Every status a lesson may hold, for validating ?status. */
const KNOWN_STATUSES = new Set([
	"active",
	"refuted",
	"superseded",
	"retracted",
]);

/**
 * What a human may assert from a browser, and nothing else.
 *
 * `refuted` belongs to the counter-observation path that produces it - a click
 * is not evidence. `superseded` must name the lesson that replaced it, and the
 * browser has no authoring, so a human choosing it would be asserting a
 * relationship the tribunal never judged.
 */
const BROWSER_TRANSITIONS = new Set(["active", "retracted"]);

export async function handleBrowseLessons(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const { userId } = await requireAuth(request, env);
	const url = new URL(request.url);

	const statuses = url.searchParams.getAll("status");
	for (const status of statuses) {
		if (!KNOWN_STATUSES.has(status)) {
			throw new ApiError(
				400,
				"invalid_status",
				`status must be one of ${[...KNOWN_STATUSES].join(", ")}`,
			);
		}
	}

	// Clamped rather than rejected: a client asking for more than the ceiling
	// wants as much as it can get, and failing the request serves nobody.
	const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
	const limit = Number.isNaN(requested) ? BROWSE_DEFAULT_LIMIT : requested;

	try {
		const page = await listLessonsPage(env.DB, userId, {
			statuses,
			cursor: url.searchParams.get("cursor"),
			limit,
		});
		return Response.json({
			lessons: page.lessons,
			cursor: page.cursor,
			has_more: page.hasMore,
		});
	} catch (error) {
		if (error instanceof InvalidCursorError) {
			throw new ApiError(
				400,
				"invalid_cursor",
				"That cursor was not issued by this server; start from the first page",
			);
		}
		throw error;
	}
}

export async function handleGetLesson(
	request: Request,
	env: WorkerEnv,
	params: RouteParams,
): Promise<Response> {
	const { userId } = await requireAuth(request, env);
	const found = await getLessonForUser(env.DB, userId, params.id);
	if (!found) throw new ApiError(404, "not_found", "No such lesson");
	return Response.json(found);
}

export async function handleBrowserTransition(
	request: Request,
	env: WorkerEnv,
	params: RouteParams,
): Promise<Response> {
	const { userId } = await requireAuth(request, env);
	const body = (await request.json()) as { status?: unknown };
	const status = typeof body.status === "string" ? body.status : "";

	if (!BROWSER_TRANSITIONS.has(status)) {
		throw new ApiError(
			400,
			"status_not_allowed",
			"A lesson may be retracted or made active again from here. " +
				"'refuted' belongs to the counter-observation that produced it, " +
				"and 'superseded' must name the lesson that replaced it.",
		);
	}

	let seq: number | null;
	try {
		// The same transition the machine route makes, so it appends to
		// lesson_feed and reaches every mirror on its next delta pull.
		seq = await transitionLesson(env.DB, userId, params.id, status, null);
	} catch (error) {
		if (error instanceof SequenceExhaustedError) {
			throw new ApiError(
				503,
				"sequence_contention",
				"Could not assign a lesson sequence; nothing was written, so retry",
			);
		}
		throw error;
	}

	if (seq === null) throw new ApiError(404, "not_found", "No such lesson");
	return Response.json({ id: params.id, seq });
}
