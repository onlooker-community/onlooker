import type { SessionSummaryInput } from "../db/session-summaries.js";
import { putSessionSummaries } from "../db/session-summaries.js";
import { requireMachineToken } from "../middleware/machine-auth.js";
import type { WorkerEnv } from "../types";
import { ApiError } from "../types";

/**
 * Generous against a week of heavy use - 72 sessions at a few hundred bytes -
 * and bounded so a machine credential cannot write an unbounded blob into D1.
 * The same reasoning, and the same shape, as MAX_INVENTORY_BYTES.
 */
const MAX_SESSIONS_BYTES = 256 * 1024;

/** The only document shape this server knows how to store. */
const SUPPORTED_SCHEMA_VERSION = 1;

/** Whether a candidate has every field putSessionSummaries needs. */
function isValidSummary(value: unknown): value is SessionSummaryInput {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;

	return (
		typeof candidate.session_id === "string" &&
		candidate.session_id.length > 0 &&
		typeof candidate.started_at === "string" &&
		(candidate.ended_at === null || typeof candidate.ended_at === "string") &&
		typeof candidate.event_count === "number" &&
		typeof candidate.counts_by_prefix === "object" &&
		candidate.counts_by_prefix !== null &&
		!Array.isArray(candidate.counts_by_prefix) &&
		Array.isArray(candidate.plugins) &&
		candidate.plugins.every((plugin) => typeof plugin === "string") &&
		typeof candidate.prompts === "number" &&
		typeof candidate.compactions === "number"
	);
}

/**
 * A machine may describe what it has been doing.
 *
 * Machine-authenticated for the same reason the inventory route is: the
 * credential names exactly one machine, and every row written is attributed to
 * that machine from the TOKEN, never from the body. A machine_id in the payload
 * is ignored rather than trusted - honoring it would let one machine's
 * credential write history attributed to another.
 */
export async function handlePostSessions(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const { userId, machineId } = await requireMachineToken(request, env);

	const raw = await request.text();
	// Measured in bytes, not characters: a document of multi-byte names is
	// larger than its length suggests, and the cap exists to bound storage.
	if (new TextEncoder().encode(raw).length > MAX_SESSIONS_BYTES) {
		throw new ApiError(413, "sessions_too_large", "Too many sessions at once");
	}

	let body: { schema_version?: unknown; sessions?: unknown };
	try {
		body = JSON.parse(raw) as { schema_version?: unknown; sessions?: unknown };
	} catch {
		throw new ApiError(
			400,
			"invalid_sessions",
			"Sessions payload must be JSON",
		);
	}

	if (body.schema_version !== SUPPORTED_SCHEMA_VERSION) {
		throw new ApiError(
			400,
			"unsupported_schema_version",
			`Sessions schema_version must be ${SUPPORTED_SCHEMA_VERSION}`,
		);
	}
	if (!Array.isArray(body.sessions)) {
		throw new ApiError(400, "invalid_sessions", "sessions must be an array");
	}

	const summaries: SessionSummaryInput[] = [];
	for (const candidate of body.sessions) {
		if (!isValidSummary(candidate)) {
			throw new ApiError(
				400,
				"invalid_sessions",
				"One or more session summaries are malformed",
			);
		}
		summaries.push(candidate);
	}

	await putSessionSummaries(env.DB, userId, machineId, summaries);

	return Response.json({ stored: summaries.length });
}
