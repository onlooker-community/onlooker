import type { SessionSummary } from "./sessions";

/**
 * The hosted API, and the four things a failure can mean.
 *
 * The CLI this replaces mapped every status >= 400 to one error string and let
 * its caller retry on all of them. A 404 was therefore indistinguishable from a
 * flaky network: when the ingest endpoint moved, the daemon retried the same
 * batch every thirty seconds for two months while its local buffer grew without
 * bound, and the only signal was a warning nobody read. Four kinds, four
 * messages, one of them retryable.
 */
export type Failure =
	| { kind: "unauthorized"; message: string }
	| { kind: "gone"; message: string }
	| { kind: "rejected"; message: string }
	| { kind: "transient"; message: string };

export class ApiError extends Error {
	constructor(readonly failure: Failure) {
		super(failure.message);
		this.name = "ApiError";
	}
}

/** The shape apps/api's errorHandler wraps every failure in. */
interface ErrorEnvelope {
	error?: { code?: string; message?: string };
}

export function classify(status: number, url: string, body: unknown): Failure {
	const detail = (body as ErrorEnvelope)?.error?.message;

	if (status === 401) {
		return {
			kind: "unauthorized",
			message:
				"That machine token was rejected. Mint a new one on the Machines page " +
				"and run `onlooker link` again.",
		};
	}
	// 429 sits with the 5xx family rather than its 4xx neighbors: it is the one
	// client error that succeeds on a retry, and telling someone to give up on it
	// would be wrong.
	if (status === 429 || status >= 500) {
		return {
			kind: "transient",
			// The API's own explanation, when it gave one. "Retry in 30s" and
			// "upstream database unavailable" are both a 429 or a 503, and
			// dropping the sentence that tells them apart leaves the user with a
			// number to look up.
			message: detail
				? `The API answered ${status}: ${detail}. Nothing was lost - run the command again.`
				: `The API answered ${status}. Nothing was lost - run the command again.`,
		};
	}
	if (status === 404) {
		return {
			kind: "gone",
			message:
				`${url} returned 404. The endpoint this CLI expects is not there, ` +
				"which is a version mismatch rather than something a retry fixes.",
		};
	}
	return {
		kind: "rejected",
		message: detail
			? `The API rejected the request: ${detail}`
			: `The API rejected the request with ${status}.`,
	};
}

/**
 * The five answers `POST /lessons` gives per lesson, named exactly as the API
 * names them.
 *
 * Not a boolean and not a loose string. The route's own source warns that
 * `invalid` means "this lesson will never be accepted, stop sending it" while
 * `error` means retry - so a client that collapses them either drops a lesson
 * permanently or retries one forever.
 */
export type Outcome = "created" | "noop" | "conflict" | "invalid" | "error";

export interface PushResult {
	id: string;
	outcome: Outcome;
	seq?: number;
	error?: string;
}

export interface PushResponse {
	results: PushResult[];
}

/**
 * One entry of the machine-side delta.
 *
 * `seq` travels beside the lesson rather than inside it so a client can assert
 * the window is contiguous with what it already holds. A gap means a lesson
 * was skipped, and the client must refuse to advance rather than read the
 * absence as "nothing was promoted".
 */
export interface DeltaEntry {
	seq: number;
	lesson: unknown;
}

export interface DeltaResponse {
	lessons: DeltaEntry[];
	cursor: number;
	has_more: boolean;
}

/**
 * The most a single session report may weigh on the wire.
 *
 * Half of the API's `MAX_SESSIONS_BYTES` (256 KiB, apps/api/src/routes/
 * sessions.ts), so a session that grows a field between here and there still
 * fits. A source guard holds this below the API's cap: the two live in
 * different workspaces, and nothing else would notice one moving alone.
 */
export const MAX_SESSION_REPORT_BYTES = 128 * 1024;

/** The exact body `reportSessions` sends, so a chunk is measured as sent. */
export function sessionReportBody(summaries: SessionSummary[]): string {
	return JSON.stringify({ schema_version: 1, sessions: summaries });
}

/**
 * Split a session report into bodies the API will accept (ONL-188).
 *
 * The API refuses a body over its cap outright, so one request for a busy
 * week reported nothing at all - measured 2026-10-23 at 582 sessions and
 * 305,939 bytes against 262,144. Sizes are counted in encoded bytes of the
 * real body, not estimated: an undercount lets through a chunk the API then
 * refuses.
 *
 * A session larger than the budget on its own still goes, alone. Dropping it
 * would be silent, and holding the rest back behind it would cost every other
 * session for the sake of one.
 */
export function chunkSessionReport(
	summaries: SessionSummary[],
	maxBytes: number = MAX_SESSION_REPORT_BYTES,
): SessionSummary[][] {
	const encoder = new TextEncoder();
	// `JSON.stringify` of the envelope with an empty array, plus each
	// summary's own bytes and one comma between neighbors, is exactly the
	// stringified chunk: the serializer adds no whitespace.
	const envelope = encoder.encode(sessionReportBody([])).length;

	const chunks: SessionSummary[][] = [];
	let chunk: SessionSummary[] = [];
	let size = envelope;
	for (const summary of summaries) {
		const own = encoder.encode(JSON.stringify(summary)).length;
		if (chunk.length > 0 && size + own + 1 > maxBytes) {
			chunks.push(chunk);
			chunk = [];
			size = envelope;
		}
		size += chunk.length === 0 ? own : own + 1;
		chunk.push(summary);
	}
	if (chunk.length > 0) chunks.push(chunk);
	return chunks;
}

export interface ApiClient {
	/** Cheapest call a machine token can make, and it has no side effects. */
	verify(): Promise<void>;
	push(lessons: unknown[]): Promise<PushResponse>;
	/**
	 * Replace this machine's reported inventory.
	 *
	 * `unknown` rather than the collector's `Inventory`, matching `push`: this
	 * module is transport and has no opinion about the document's shape.
	 */
	reportInventory(inventory: unknown): Promise<void>;
	/**
	 * Report session summaries in one request. Callers split a large report
	 * with `chunkSessionReport` first; this sends whatever it is given.
	 */
	reportSessions(summaries: SessionSummary[]): Promise<void>;
	/** One window of the machine-side delta, oldest first. */
	readDelta(since: number, limit: number): Promise<DeltaResponse>;
}

/** The longest a 429 may hold a request, whatever its Retry-After says. */
export const MAX_RETRY_AFTER_SECONDS = 60;

/**
 * How long a 429 asks to wait, in whole seconds between 1 and the cap.
 *
 * Retry-After is either a count of seconds or an HTTP date. Missing or
 * unreadable reads as the cap rather than as the floor: the API's limit is per
 * minute (ONL-222), so a retry a second later would most likely spend the one
 * retry there is on a second 429.
 */
export function retryAfterSeconds(
	header: string | null | undefined,
	now: number = Date.now(),
): number {
	const clamp = (seconds: number) =>
		Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(seconds)));
	const value = header?.trim();
	if (!value) return MAX_RETRY_AFTER_SECONDS;
	if (/^-?\d+$/.test(value)) return clamp(Number(value));
	const at = Date.parse(value);
	return Number.isNaN(at) ? MAX_RETRY_AFTER_SECONDS : clamp((at - now) / 1000);
}

export interface RetryOptions {
	/** Injected so tests do not wait out a real Retry-After. */
	sleep?: (ms: number) => Promise<void>;
	/** Told before each wait, so a sync that pauses for a minute says why. */
	onWait?: (seconds: number) => void;
}

const realSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

const sayWaiting = (seconds: number) =>
	console.error(
		`The API is rate limiting this account. Waiting ${seconds}s, then trying once more.`,
	);

export function createClient(
	baseUrl: string,
	token: string,
	fetchImpl: typeof fetch = fetch,
	{ sleep = realSleep, onWait = sayWaiting }: RetryOptions = {},
): ApiClient {
	// Set once a wait has failed to clear the limit (ONL-242). The limit is per
	// account, so the next request would meet the same 429, and waiting a
	// minute for each of a sync's requests would hold it for several minutes
	// to fail the same way. Cleared by any request that gets through.
	let stillLimited = false;

	async function send(url: string, init?: RequestInit): Promise<Response> {
		try {
			return await fetchImpl(url, {
				...init,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					...init?.headers,
				},
			});
		} catch (error) {
			// No status to classify - the request never arrived. That is always
			// worth trying again, and saying so is the difference between "your
			// wifi dropped" and "give up".
			throw new ApiError({
				kind: "transient",
				message: `Could not reach ${baseUrl}: ${(error as Error).message}`,
			});
		}
	}

	async function call<T>(path: string, init?: RequestInit): Promise<T> {
		const url = `${baseUrl}${path}`;
		let response = await send(url, init);

		// 429 only. It is the one refusal that says how long to wait, so waiting
		// is following an instruction; a 503 or a dropped connection says
		// nothing of the kind, and stays the person's call to retry.
		if (response.status === 429 && !stillLimited) {
			const seconds = retryAfterSeconds(response.headers?.get("Retry-After"));
			onWait(seconds);
			await sleep(seconds * 1000);
			response = await send(url, init);
			stillLimited = response.status === 429;
		} else if (response.status !== 429) {
			stillLimited = false;
		}

		const body = await response.json().catch(() => ({}));
		if (!response.ok) throw new ApiError(classify(response.status, url, body));
		return body as T;
	}

	return {
		verify: async () => {
			// GET /lessons, not /api/lessons. A machine token authenticates the
			// machine-side delta read; /api/lessons is the browser's
			// session-authenticated route and would reject every valid token.
			await call("/lessons?since=0&limit=1");
		},
		push: (lessons) =>
			call<PushResponse>("/lessons", {
				method: "POST",
				body: JSON.stringify({ lessons }),
			}),
		readDelta: (since, limit) =>
			call<DeltaResponse>(`/lessons?since=${since}&limit=${limit}`),
		reportInventory: async (inventory) => {
			// PUT, not POST: this replaces one row's document rather than
			// adding to a collection, so running sync twice must be free.
			await call("/machine/inventory", {
				method: "PUT",
				body: JSON.stringify(inventory),
			});
		},
		reportSessions: async (summaries) => {
			// POST, not PUT: this upserts rows in a collection keyed by
			// (machine, session) rather than replacing one document, so it
			// does not need inventory's replace-the-whole-thing semantics.
			await call("/machine/sessions", {
				method: "POST",
				body: sessionReportBody(summaries),
			});
		},
	};
}
