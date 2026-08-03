import { ApiError } from "../types";

export interface ApiResponse<T = unknown> {
	success: boolean;
	data?: T;
	error?: {
		code: string;
		message: string;
		details?: unknown;
	};
}

export function jsonResponse<T>(
	data: T,
	status: number = 200,
): Response {
	return new Response(JSON.stringify({ success: true, data }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export function errorHandler(error: unknown): Response {
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

	const message = error instanceof Error ? error.message : "Internal server error";

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
