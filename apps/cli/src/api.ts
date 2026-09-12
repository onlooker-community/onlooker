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
	/** One window of the machine-side delta, oldest first. */
	readDelta(since: number, limit: number): Promise<DeltaResponse>;
}

export function createClient(
	baseUrl: string,
	token: string,
	fetchImpl: typeof fetch = fetch,
): ApiClient {
	async function call<T>(path: string, init?: RequestInit): Promise<T> {
		const url = `${baseUrl}${path}`;
		let response: Response;
		try {
			response = await fetchImpl(url, {
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
	};
}
