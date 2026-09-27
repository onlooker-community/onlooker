import { blockAuthor, unblockAuthor } from "../db/author-blocks.js";
import { retractAnyLesson, SequenceExhaustedError } from "../db/lessons.js";
import type { Principal } from "../db/pool.js";
import type { RouteParams, WorkerEnv } from "../types";
import { ApiError } from "../types";

/** The contract's own shape for an author key. See ZAuthorKey. */
const AUTHOR_KEY = /^[0-9a-f]{32}$/;

/**
 * Operator moderation.
 *
 * Every route here declares auth: "operator", which 404s a signed-in
 * non-operator rather than 403ing - an operator surface should not confirm its
 * own existence to someone who may not use it.
 */
export async function handleOperatorRetract(
	_request: Request,
	env: WorkerEnv,
	params: RouteParams,
): Promise<Response> {
	let seq: number | null;
	try {
		seq = await retractAnyLesson(env.DB, params.id);
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
	return Response.json({ id: params.id, seq, status: "retracted" });
}

export async function handleBlockAuthor(
	request: Request,
	env: WorkerEnv,
	_params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	const body = (await request.json()) as {
		author_key?: unknown;
		reason?: unknown;
	};
	const authorKey = typeof body.author_key === "string" ? body.author_key : "";
	const reason = typeof body.reason === "string" ? body.reason.trim() : "";

	if (!AUTHOR_KEY.test(authorKey)) {
		throw new ApiError(
			400,
			"invalid_author_key",
			"author_key must be 32 lowercase hex characters",
		);
	}
	// Required, because a block nobody explained cannot be reviewed later.
	if (reason.length === 0) {
		throw new ApiError(400, "reason_required", "Say why this key is blocked");
	}

	await blockAuthor(env.DB, authorKey, reason, (principal as Principal).userId);
	return Response.json({ author_key: authorKey, blocked: true });
}

export async function handleUnblockAuthor(
	_request: Request,
	env: WorkerEnv,
	params: RouteParams,
): Promise<Response> {
	const lifted = await unblockAuthor(env.DB, params.authorKey);
	if (!lifted) throw new ApiError(404, "not_found", "That key is not blocked");
	return Response.json({ author_key: params.authorKey, blocked: false });
}
