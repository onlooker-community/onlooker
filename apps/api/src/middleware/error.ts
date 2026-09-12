import type { Monitor } from "@onlooker/monitoring";
import { monitor as apiMonitor } from "../monitoring";
import { ApiError } from "../types";

/**
 * The shape of a failure body. Success has no equivalent wrapper — see below.
 */
export interface ApiErrorResponse {
	success: false;
	error: {
		code: string;
		message: string;
		details?: unknown;
	};
}

/**
 * Send a payload as-is.
 *
 * This used to wrap in `{ success: true, data }`, and nothing on the receiving
 * end ever unwrapped it. The `/auth/*` routes return bare objects, apps/web's
 * mock API mirrors that, and the shared client hands whatever it parsed to the
 * caller untouched — so only `/api/*` carried an envelope, and only the pages
 * reading those two routes broke. DashboardPage read `.stats` off the wrapper,
 * got undefined, and threw mid-render; with no error boundary in apps/web that
 * blanked the page while the API kept answering 200.
 *
 * Failures keep their envelope (see `errorHandler`) because a failure body has
 * no natural payload, and the code/message pair is what the client reports.
 */
export function jsonResponse<T>(data: T, status: number = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Whether a failure is worth a human's attention.
 *
 * A 4xx ApiError is the API answering correctly - a wrong password, a taken
 * address, a route that does not exist - and reporting those would bury the
 * real faults under traffic. Anything else, or an ApiError this code chose to
 * answer with a 5xx, is a fault. Before this, unexpected errors were not logged
 * at all; the 500 reached the client and nowhere else.
 */
function isFault(error: unknown): boolean {
	return !(error instanceof ApiError) || error.status >= 500;
}

export function errorHandler(
	error: unknown,
	monitor: Monitor = apiMonitor,
): Response {
	if (isFault(error)) monitor.captureException(error);

	if (error instanceof ApiError) {
		return new Response(
			JSON.stringify({
				success: false,
				error: {
					code: error.code,
					message: error.message,
					details: error.details,
				},
			}),
			{
				status: error.status,
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	const message =
		error instanceof Error ? error.message : "Internal server error";

	return new Response(
		JSON.stringify({
			success: false,
			error: {
				code: "INTERNAL_ERROR",
				message,
			},
		}),
		{
			status: 500,
			headers: { "Content-Type": "application/json" },
		},
	);
}
