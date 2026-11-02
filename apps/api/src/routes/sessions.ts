import { BROWSE_DEFAULT_LIMIT, InvalidCursorError } from "../db/lessons.js";
import type { Principal } from "../db/pool.js";
import type {
	ProjectFilter,
	SessionSummaryInput,
} from "../db/session-summaries.js";
import {
	listSessionSummaries,
	MAX_PROJECT_FILTERS,
	putSessionSummaries,
} from "../db/session-summaries.js";
import { requireMachineToken } from "../middleware/machine-auth.js";
import type { RouteParams, WorkerEnv } from "../types";
import { ApiError } from "../types";

/**
 * Bounded so a machine credential cannot write an unbounded blob into D1. The
 * same reasoning, and the same shape, as MAX_INVENTORY_BYTES.
 *
 * This was sized against "72 sessions a week", and a real week was 582 -
 * 305,939 bytes, measured 2026-10-23 (ONL-188). The CLI now splits its report
 * to fit, at half this cap, so this bounds one request rather than one week.
 * scripts/source-guards.test.sh holds the CLI's budget below it.
 */
const MAX_SESSIONS_BYTES = 256 * 1024;

/** The only document shape this server knows how to store. */
const SUPPORTED_SCHEMA_VERSION = 1;

/** A project key as the CLI derives it: the first 12 hex of a SHA-256. */
const PROJECT_KEY = /^[0-9a-f]{12}$/;

/** `<key>` for a remote key, `<machine_id>:<key>` for a root key. */
const PROJECT_VALUE = /^(?:([^:]+):)?([0-9a-f]{12})$/;

/** The `project` values of a read, or throws 400. */
function parseProjectFilters(url: URL): ProjectFilter[] {
	const values = url.searchParams.getAll("project");
	if (values.length > MAX_PROJECT_FILTERS) {
		throw new ApiError(
			400,
			"invalid_project",
			`Ask for at most ${MAX_PROJECT_FILTERS} projects at once`,
		);
	}
	return values.map((value) => {
		const match = PROJECT_VALUE.exec(value);
		if (!match) {
			throw new ApiError(400, "invalid_project", "That is not a project");
		}
		return { key: match[2], machineId: match[1] ?? null };
	});
}

/**
 * Whether `counts_by_project` is a map of project key -> {basis, event_count}.
 *
 * Absent is VALID and means an empty map. A CLI older than this column posts no
 * such field, and rejecting those bodies would break every machine that has not
 * upgraded yet - for a dimension whose own absence already means "not
 * attributable". `putSessionSummaries` defaults it on write.
 *
 * The basis is checked against its two legal values rather than `typeof
 * "string"`, because it is what a reader branches on to decide whether a key
 * may be aggregated across machines. A third value would read as neither and
 * silently drop out of both.
 *
 * Keys are held to the 12-hex shape too, so what the project filter can ask for
 * and what can be stored agree.
 */
function isValidCountsByProject(value: unknown): boolean {
	if (value === undefined) return true;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	return Object.entries(value as Record<string, unknown>).every(
		([key, entry]) => {
			if (!PROJECT_KEY.test(key)) return false;
			if (typeof entry !== "object" || entry === null) return false;
			const count = entry as Record<string, unknown>;
			return (
				(count.basis === "remote" || count.basis === "root") &&
				typeof count.event_count === "number"
			);
		},
	);
}

/**
 * What a registered event type looks like. Identical to the CLI's
 * EVENT_TYPE_PATTERN in apps/cli/src/sessions.ts, which decides what it keys;
 * scripts/source-guards.test.sh keeps the two the same.
 */
const EVENT_TYPE_PATTERN = /^(?=.{1,64}$)[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$/;

/** The CLI's MAX_TYPES_PER_SESSION. More than this came from something else. */
const MAX_TYPES_PER_SESSION = 128;

/**
 * Whether `counts_by_type` is a map of event type -> whole count (ONL-128).
 *
 * Absent is VALID and means an empty map, for the reason it is for
 * `counts_by_project`: every CLI older than this column posts no such field.
 *
 * The keys are held to the pattern rather than to `typeof "string"`. A type is
 * envelope rather than payload only while it is a registered name, and the
 * CLI keys nothing else - so a key that is not one is text from somewhere
 * else, and this is the last place to refuse to store it.
 */
function isValidCountsByType(value: unknown): boolean {
	if (value === undefined) return true;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const entries = Object.entries(value as Record<string, unknown>);
	return (
		entries.length <= MAX_TYPES_PER_SESSION &&
		entries.every(
			([type, count]) =>
				EVENT_TYPE_PATTERN.test(type) &&
				Number.isInteger(count) &&
				(count as number) >= 0,
		)
	);
}

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
		Object.values(candidate.counts_by_prefix).every(
			(count) => typeof count === "number",
		) &&
		isValidCountsByType(candidate.counts_by_type) &&
		isValidCountsByProject(candidate.counts_by_project) &&
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
	// Kept rather than reading the router-resolved principal: this handler
	// needs `machineId`, which `Principal` deliberately does not carry (see
	// db/pool.ts), so only `requireMachineToken`'s own return value has it.
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
		// `candidate` itself, not a field-by-field copy: `isValidSummary` only
		// confirms every field `putSessionSummaries` needs is present and the
		// right type, not that the object carries nothing else - an unknown
		// extra field on the body survives to the DB layer. Noted rather than
		// narrowed: there is one choke point on this payload instead of two,
		// which is a deliberate trade-off already made, not an oversight.
		summaries.push(candidate);
	}

	await putSessionSummaries(env.DB, userId, machineId, summaries);

	return Response.json({ stored: summaries.length });
}

/**
 * GET /api/sessions
 *
 * The browser's read of its own session history, across every machine that
 * has reported one. Declared `auth: "session"`, the same way GET /api/activity
 * is - a machine credential names exactly one machine and has no business
 * reading a person's whole feed, so a machine token here fails in
 * `resolvePrincipal` before this handler's body ever runs.
 *
 * Under `/api/` deliberately: this API splits its namespaces by who may call
 * them, browser-authenticated feeds under `/api/` and machine-authenticated
 * routes bare (see router.ts) - the same split `/api/activity` and the bare
 * `/lessons` delta route already draw.
 */
export async function handleGetSessions(
	request: Request,
	env: WorkerEnv,
	_params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	// The router resolved this from the route's `auth: "session"`, which throws
	// rather than returning null, so it cannot be null here.
	const { userId } = principal as Principal;
	const url = new URL(request.url);

	// Clamped rather than rejected, matching handleActivity: a client asking
	// for more than the ceiling wants as much as it can get, and failing the
	// request serves nobody.
	const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
	const limit = Number.isNaN(requested) ? BROWSE_DEFAULT_LIMIT : requested;
	const projects = parseProjectFilters(url);

	try {
		const page = await listSessionSummaries(env.DB, userId, {
			cursor: url.searchParams.get("cursor"),
			limit,
			projects,
		});
		return Response.json({
			sessions: page.sessions,
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
