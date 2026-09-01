import {
	BROWSE_DEFAULT_LIMIT,
	InvalidCursorError,
	listActivityPage,
} from "../db/lessons.js";
import { requireAuth } from "../middleware/auth.js";
import type { WorkerEnv } from "../types";
import { ApiError } from "../types";

/**
 * GET /api/activity
 *
 * Session-authenticated, under /api with the other browser reads — not beside
 * the machine-authenticated /lessons sync routes, which read the same feed for
 * a different consumer. Keeping them apart is what stops a change made for a
 * person breaking a mirror mid-drain.
 */
export async function handleActivity(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const { userId } = await requireAuth(request, env);
	const url = new URL(request.url);

	// Clamped rather than rejected, matching handleBrowseLessons: a client
	// asking for more than the ceiling wants as much as it can get, and failing
	// the request serves nobody.
	const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
	const limit = Number.isNaN(requested) ? BROWSE_DEFAULT_LIMIT : requested;

	try {
		const page = await listActivityPage(env.DB, userId, {
			cursor: url.searchParams.get("cursor"),
			limit,
		});
		return Response.json({
			events: page.events,
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
