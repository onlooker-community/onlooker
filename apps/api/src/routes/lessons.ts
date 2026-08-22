import type { D1Database } from "@cloudflare/workers-types";
import { ZLesson } from "@onlooker-community/lesson-contract";
import {
	createLessonWithFeed,
	getLessonById,
	LessonIdTakenError,
} from "../db/lessons.js";
import { checkCrossFieldRules } from "../lessons/rules.js";
import { requireMachineToken } from "../middleware/machine-auth.js";
import type { WorkerEnv } from "../types";
import { ApiError } from "../types";
import { canonicalize } from "../utils/canonical.js";

type Outcome = "created" | "noop" | "conflict" | "invalid";

interface PushResult {
	id: string;
	outcome: Outcome;
	seq?: number;
	error?: string;
}

/** How many lessons one request may carry. */
const MAX_BATCH = 100;

/**
 * Name the first field whose value differs, for a conflict the caller owns.
 *
 * Only ever called when the stored lesson belongs to the pusher. Reporting a
 * field on someone else's lesson would confirm what they wrote.
 */
function firstDifferingField(stored: string, incoming: unknown): string {
	const before = JSON.parse(stored) as Record<string, unknown>;
	const after = incoming as Record<string, unknown>;

	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (canonicalize(before[key]) !== canonicalize(after[key])) return key;
	}
	return "unknown";
}

/**
 * Push lessons into the pool.
 *
 * Results are per item rather than per request. One lesson failing a
 * cross-field rule must not reject the rest, because a client told only that
 * "the batch failed" will re-push everything and keep doing it.
 */
export async function handlePushLessons(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const { userId } = await requireMachineToken(request, env);

	const payload = (await request.json()) as { lessons?: unknown };
	if (!Array.isArray(payload.lessons)) {
		throw new ApiError(400, "invalid_body", "Expected a lessons array");
	}
	if (payload.lessons.length > MAX_BATCH) {
		throw new ApiError(
			400,
			"batch_too_large",
			`At most ${MAX_BATCH} lessons per request`,
		);
	}

	const results: PushResult[] = [];

	for (const candidate of payload.lessons) {
		results.push(await pushOne(env.DB, userId, candidate));
	}

	return Response.json({ results });
}

async function pushOne(
	db: D1Database,
	userId: string,
	candidate: unknown,
): Promise<PushResult> {
	const id =
		typeof (candidate as { id?: unknown })?.id === "string"
			? (candidate as { id: string }).id
			: "unknown";

	const parsed = ZLesson.safeParse(candidate);
	if (!parsed.success) {
		return {
			id,
			outcome: "invalid",
			error: parsed.error.issues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("; "),
		};
	}
	const lesson = parsed.data;

	// The tier gate says so explicitly. A generic validation failure here would
	// read as a client bug once org and public open.
	if (lesson.visibility !== "private") {
		return {
			id,
			outcome: "invalid",
			error: `The ${lesson.visibility} tier is not open yet; only private lessons are accepted`,
		};
	}

	if (lesson.superseded_by !== null && lesson.status !== "superseded") {
		return {
			id,
			outcome: "invalid",
			error: "superseded_by is set on a lesson whose status is not superseded",
		};
	}

	const violations = checkCrossFieldRules(lesson);
	if (violations.length > 0) {
		return {
			id,
			outcome: "invalid",
			error: violations.map((v) => v.message).join("; "),
		};
	}

	const existing = await getLessonById(db, lesson.id);
	if (existing) return reconcile(existing, lesson, userId);

	try {
		return {
			id,
			outcome: "created",
			seq: await createLessonWithFeed(db, userId, lesson),
		};
	} catch (error) {
		// Lost a race with a concurrent push of the same id. Re-read and answer
		// from what is now stored, rather than reporting a failure that is not one.
		if (error instanceof LessonIdTakenError) {
			const raced = await getLessonById(db, lesson.id);
			if (raced) return reconcile(raced, lesson, userId);
		}
		throw error;
	}
}

function reconcile(
	existing: { user_id: string; body: string },
	incoming: { id: string },
	userId: string,
): PushResult {
	const identical = existing.body === canonicalize(incoming);

	// Someone else's lesson. Answer the same way whether the content matches or
	// not, so this cannot be used to probe which ULIDs are taken or what they say.
	if (existing.user_id !== userId) {
		return {
			id: incoming.id,
			outcome: "conflict",
			error: "That lesson id is already in use",
		};
	}

	if (identical) return { id: incoming.id, outcome: "noop" };

	return {
		id: incoming.id,
		outcome: "conflict",
		error: `Content differs from the stored lesson, starting at "${firstDifferingField(existing.body, incoming)}". Lesson content is immutable; use the status route for lifecycle changes.`,
	};
}
