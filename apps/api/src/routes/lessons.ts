import type { TLesson } from "@onlooker-community/lesson-contract";
import { ZLesson } from "@onlooker-community/lesson-contract";
import {
	createLessonsWithFeed,
	getLessonsByIds,
	readLessonDelta,
	SequenceExhaustedError,
	transitionLesson,
} from "../db/lessons.js";
import { checkCrossFieldRules } from "../lessons/rules.js";
import { requireMachineToken } from "../middleware/machine-auth.js";
import type { RouteParams, WorkerEnv } from "../types";
import { ApiError } from "../types";
import { canonicalize } from "../utils/canonical.js";

/**
 * The verdict on one lesson.
 *
 * `error` is the fifth value beside the spec's four, and it exists so an
 * unexpected failure on one lesson cannot take the whole response down. It is
 * deliberately not folded into `invalid`: `invalid` means "this lesson will
 * never be accepted, stop sending it", and a client that treats a transient
 * write failure that way drops the lesson permanently. `error` means retry.
 */
type Outcome = "created" | "noop" | "conflict" | "invalid" | "error";

interface PushResult {
	id: string;
	outcome: Outcome;
	seq?: number;
	error?: string;
}

/** How many lessons one request may carry. */
const MAX_BATCH = 100;

/**
 * The two fields the status route owns.
 *
 * A conflict confined to these is not an attempted content rewrite. It is a
 * mirror whose copy predates a lifecycle change - possibly one the same account
 * made through the status route - and telling it that content is immutable
 * would name the one thing it is allowed to change. Keeping the two apart is
 * the distinction the two-route split exists to preserve.
 */
const LIFECYCLE_FIELDS = new Set(["status", "superseded_by"]);

/** A candidate that survived validation, still tied to its place in the batch. */
interface Admitted {
	index: number;
	lesson: TLesson;
}

/** Best effort at naming a candidate that may not even be an object. */
function idOf(candidate: unknown): string {
	return typeof (candidate as { id?: unknown })?.id === "string"
		? (candidate as { id: string }).id
		: "unknown";
}

/**
 * Every field whose value differs, for a conflict the caller owns.
 *
 * Only ever called when the stored lesson belongs to the pusher. Reporting a
 * field on someone else's lesson would confirm what they wrote.
 */
function differingFields(stored: string, incoming: unknown): string[] {
	const before = JSON.parse(stored) as Record<string, unknown>;
	const after = incoming as Record<string, unknown>;

	return [...new Set([...Object.keys(before), ...Object.keys(after)])]
		.filter((key) => canonicalize(before[key]) !== canonicalize(after[key]))
		.sort();
}

/**
 * Everything about one lesson that can be decided without the database.
 *
 * Kept separate from the write because none of these checks may consume a
 * sequence number: a number spent on a lesson that is never stored leaves a
 * hole, and the client's contiguity check reads a hole as corruption.
 */
function screen(
	candidate: unknown,
): { lesson: TLesson } | { result: PushResult } {
	const id = idOf(candidate);

	const parsed = ZLesson.safeParse(candidate);
	if (!parsed.success) {
		return {
			result: {
				id,
				outcome: "invalid",
				error: parsed.error.issues
					.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
					.join("; "),
			},
		};
	}
	const lesson = parsed.data;

	// The tier gate says so explicitly. A generic validation failure here would
	// read as a client bug once org and public open.
	if (lesson.visibility !== "private") {
		return {
			result: {
				id,
				outcome: "invalid",
				error: `The ${lesson.visibility} tier is not open yet; only private lessons are accepted`,
			},
		};
	}

	if (lesson.superseded_by !== null && lesson.status !== "superseded") {
		return {
			result: {
				id,
				outcome: "invalid",
				error:
					"superseded_by is set on a lesson whose status is not superseded",
			},
		};
	}

	const violations = checkCrossFieldRules(lesson);
	if (violations.length > 0) {
		return {
			result: {
				id,
				outcome: "invalid",
				error: violations.map((v) => v.message).join("; "),
			},
		};
	}

	return { lesson };
}

/**
 * Push lessons into the pool.
 *
 * Three phases, and the shape is load-bearing rather than tidy.
 *
 * Everything per item - parse, the tier gate, the cross-field rules, the
 * idempotency check - happens first, so only lessons that will actually be
 * written reach the sequence. Then ONE transaction assigns every number
 * contiguously, because assigning per lesson lets a concurrent push interleave
 * into the middle of a batch: the pusher is told 5 and 7, advances its cursor
 * to 7 on the spec's own invitation, and never receives 6.
 *
 * Results stay per item throughout. One lesson failing must not reject the
 * rest, because a client told only that "the batch failed" will re-push
 * everything and keep doing it - including the lessons that succeeded, whose
 * seq values it can no longer recover.
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

	const candidates = payload.lessons;
	const results = new Array<PushResult | undefined>(candidates.length);
	const admitted: Admitted[] = [];

	// 1. Everything decidable without touching the database.
	for (const [index, candidate] of candidates.entries()) {
		try {
			const screened = screen(candidate);
			if ("result" in screened) results[index] = screened.result;
			else admitted.push({ index, lesson: screened.lesson });
		} catch (error) {
			results[index] = unexpected(idOf(candidate), error);
		}
	}

	// 2. One read decides idempotency for the whole batch.
	const stored = await getLessonsByIds(
		env.DB,
		admitted.map((item) => item.lesson.id),
	);
	const creatable: Admitted[] = [];
	const claimed = new Set<string>();
	// Answerable only once the write has settled: an id repeated inside this
	// request, and an id a concurrent push took first. Both reconcile against
	// what is actually stored rather than against what we expected to store.
	const settle: Admitted[] = [];

	for (const item of admitted) {
		const existing = stored.get(item.lesson.id);
		if (existing) {
			results[item.index] = reconcile(existing, item.lesson, userId);
		} else if (claimed.has(item.lesson.id)) {
			settle.push(item);
		} else {
			claimed.add(item.lesson.id);
			creatable.push(item);
		}
	}

	// 3. One transaction assigns every sequence number, contiguously.
	if (creatable.length > 0) {
		try {
			const writes = await createLessonsWithFeed(
				env.DB,
				userId,
				creatable.map((item) => item.lesson),
			);

			for (const [offset, write] of writes.entries()) {
				const item = creatable[offset];
				if (write.outcome === "created") {
					results[item.index] = {
						id: item.lesson.id,
						outcome: "created",
						seq: write.seq,
					};
				} else {
					settle.push(item);
				}
			}
		} catch (error) {
			// Contention is a condition of the whole user's stream, not of any one
			// lesson: nothing was written, and retrying items individually cannot
			// help. The spec answers 503 there - "never a partial write" - and the
			// named class is what carries that past errorHandler, which would
			// otherwise echo a bare Error's message, user id and all, as a 500.
			if (error instanceof SequenceExhaustedError) {
				throw new ApiError(
					503,
					"sequence_contention",
					"Could not assign a lesson sequence; nothing was written, so retry the batch",
				);
			}

			// Any other write failure rolled the transaction back whole. Give the
			// lessons it covered their own outcome instead of discarding the
			// verdicts already reached for everything else in the request.
			for (const item of creatable) {
				results[item.index] = unexpected(item.lesson.id, error);
			}
		}
	}

	if (settle.length > 0) {
		const now = await getLessonsByIds(
			env.DB,
			settle.map((item) => item.lesson.id),
		);
		for (const item of settle) {
			const existing = now.get(item.lesson.id);
			results[item.index] = existing
				? reconcile(existing, item.lesson, userId)
				: {
						id: item.lesson.id,
						outcome: "error",
						error: "The lesson was not stored; retry it",
					};
		}
	}

	return Response.json({
		results: results.map(
			(result, index) => result ?? unexpected(idOf(candidates[index]), null),
		),
	});
}

/**
 * A lesson that failed for a reason the route did not anticipate.
 *
 * The message is deliberately generic: an unexpected failure's text is a D1
 * string we do not control, and echoing it back is how internal identifiers
 * reach a response body.
 */
function unexpected(id: string, _cause: unknown): PushResult {
	return {
		id,
		outcome: "error",
		error: "This lesson could not be stored; retry it",
	};
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

	const differing = differingFields(existing.body, incoming);
	const content = differing.filter((field) => !LIFECYCLE_FIELDS.has(field));

	if (content.length > 0) {
		return {
			id: incoming.id,
			outcome: "conflict",
			error: `Content differs from the stored lesson at ${content.join(", ")}. Lesson content is immutable; use the status route for lifecycle changes.`,
		};
	}

	// Nothing outside status and superseded_by differs, so the content matches
	// and the pusher's copy is merely behind. Saying "content is immutable" here
	// would name the opposite problem, and point at the very route that produced
	// the difference.
	return {
		id: incoming.id,
		outcome: "conflict",
		error: `The stored lesson's ${differing.join(" and ") || "lifecycle"} has moved on since your copy; its content is unchanged. Pull before you push.`,
	};
}

/**
 * The lifecycle states the contract defines.
 *
 * There is deliberately no "expired". When applies_to.scope stops matching,
 * nothing happens to the record - the lesson is simply not selected. Storing an
 * expired status would need something sweeping the pool to set it, which is the
 * review-queue failure mode the design exists to avoid.
 */
const TRANSITIONS = ["active", "refuted", "superseded", "retracted"];

export async function handleTransitionLesson(
	request: Request,
	env: WorkerEnv,
	params: RouteParams,
): Promise<Response> {
	const { userId } = await requireMachineToken(request, env);

	// The router captured this from /lessons/:id/status, so the handler does not
	// have to know that :id is the second-to-last segment. It used to, and so did
	// handleRevokeMachine with a different rule for its own shape - two idioms,
	// each right only for its own route, and a third shape would have read the
	// wrong segment without failing.
	//
	// No `?? ""` fallback: the router sets every `:name` in the pattern it
	// matched, so an absent key would mean this handler is reading a name its own
	// route does not declare - and coercing that to "" is how such a bug turns
	// into a quiet 404 instead of something anyone notices.
	const id = params.id;

	const body = (await request.json()) as {
		status?: unknown;
		superseded_by?: unknown;
	};

	const status = typeof body.status === "string" ? body.status : "";
	if (!TRANSITIONS.includes(status)) {
		throw new ApiError(
			400,
			"invalid_status",
			`status must be one of ${TRANSITIONS.join(", ")}`,
		);
	}

	const supersededBy =
		typeof body.superseded_by === "string" ? body.superseded_by : null;

	if (status === "superseded" && !supersededBy) {
		throw new ApiError(
			400,
			"missing_superseded_by",
			"A superseded lesson must name the lesson that replaced it",
		);
	}
	if (status !== "superseded" && supersededBy) {
		throw new ApiError(
			400,
			"unexpected_superseded_by",
			"superseded_by belongs only on a superseded lesson",
		);
	}

	let seq: number | null;
	try {
		seq = await transitionLesson(env.DB, userId, id, status, supersededBy);
	} catch (error) {
		// Same reason as the push route: a bare Error becomes a 500 whose body is
		// error.message verbatim, and that message named the internal user id.
		if (error instanceof SequenceExhaustedError) {
			throw new ApiError(
				503,
				"sequence_contention",
				"Could not assign a lesson sequence; nothing was written, so retry the transition",
			);
		}
		throw error;
	}

	if (seq === null) {
		throw new ApiError(404, "not_found", "No such lesson");
	}

	return Response.json({ id, seq });
}

/** Default and ceiling for one delta window. */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export async function handleReadLessons(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const { userId } = await requireMachineToken(request, env);
	const url = new URL(request.url);

	const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
	if (!Number.isInteger(since) || since < 0) {
		throw new ApiError(
			400,
			"invalid_cursor",
			"since must be a non-negative integer",
		);
	}

	const requested = Number.parseInt(
		url.searchParams.get("limit") ?? String(DEFAULT_LIMIT),
		10,
	);
	const limit =
		Number.isInteger(requested) && requested > 0
			? Math.min(requested, MAX_LIMIT)
			: DEFAULT_LIMIT;

	const { entries, hasMore } = await readLessonDelta(
		env.DB,
		userId,
		since,
		limit,
	);

	// seq travels beside each lesson so the client can assert the window is
	// contiguous with what it already holds. A gap means a lesson was skipped,
	// and the client must refuse to advance its cursor rather than treat the
	// absence as "nothing was promoted".
	return Response.json({
		lessons: entries.map((entry) => ({
			seq: entry.seq,
			lesson: JSON.parse(entry.body) as unknown,
		})),
		cursor: entries.length > 0 ? entries[entries.length - 1].seq : since,
		has_more: hasMore,
	});
}
