import { type Monitor, noopMonitor } from "@onlooker/monitoring";
import {
	type BaseTransportOptions,
	createStackParser,
	createTransport,
	dedupeIntegration,
	type Envelope,
	type ErrorEvent,
	type Exception,
	envelopeContainsItemType,
	eventFiltersIntegration,
	linkedErrorsIntegration,
	nodeStackLineParser,
	ServerRuntimeClient,
	type StackFrame,
	setCurrentClient,
	type Transport,
} from "@sentry/core";
import { createSentryMonitor } from "./monitor";
import { type MonitoringConfig, sentryOptions } from "./options";

declare global {
	/**
	 * As much of the runtime's `AbortSignal` as this package names. Declared
	 * because the package carries no Node or DOM types; wherever those are
	 * loaded, this merges into the real one and changes nothing.
	 */
	interface AbortSignal {
		readonly aborted: boolean;
	}
}

/** The part of `fetch` the transport uses. Node's global `fetch` satisfies it. */
export type FetchLike = (
	url: string,
	init: {
		method: string;
		body: string | Uint8Array;
		headers: Record<string, string>;
		signal?: AbortSignal;
	},
) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

export interface NodeMonitoringOptions {
	/** Injected so this package needs no Node types, and a test can watch it. */
	fetch: FetchLike;
	/** The user's home directory, shown as `~` in anything sent. */
	home: string;
}

/**
 * How long one send may stay open. The CLI flushes for 2000 ms, but a flush
 * only stops waiting: the request stays open, and a Node process exits only
 * once nothing is open. Against a server that accepts and stalls, that was
 * minutes after the user's error had printed.
 */
const SEND_TIMEOUT_MS = 2000;

/** Reached through `globalThis` so the package needs no runtime's types. */
function timeoutSignal(ms: number): AbortSignal | undefined {
	const { AbortSignal: Signal } = globalThis as unknown as {
		AbortSignal?: { timeout?(ms: number): AbortSignal };
	};
	return Signal?.timeout?.(ms);
}

/**
 * Whether the event this client captured was accepted.
 *
 * Core's flush resolves true once every request has settled, whatever it
 * settled to: a 500, a 429 or a refused connection all count as drained.
 * The CLI tells the user "reported this crash" on that answer, so this keeps
 * the one it can trust.
 */
interface Delivery {
	/** Undefined until an event envelope settles. */
	accepted: boolean | undefined;
}

function fetchTransport(fetchImpl: FetchLike, delivery: Delivery) {
	return (options: BaseTransportOptions): Transport => {
		const transport = createTransport(options, async ({ body }) => {
			const response = await fetchImpl(options.url, {
				method: "POST",
				body,
				headers: { "Content-Type": "application/x-sentry-envelope" },
				signal: timeoutSignal(SEND_TIMEOUT_MS),
			});
			return {
				statusCode: response.status,
				headers: {
					"x-sentry-rate-limits": response.headers.get("X-Sentry-Rate-Limits"),
					"retry-after": response.headers.get("Retry-After"),
				},
			};
		});
		return {
			...transport,
			send(envelope: Envelope) {
				// Client reports ride the same transport; only the event decides.
				const isEvent = envelopeContainsItemType(envelope, ["event"]);
				const settle = (ok: boolean) => {
					if (isEvent) delivery.accepted = delivery.accepted !== false && ok;
				};
				return transport.send(envelope).then(
					(response) => {
						// A rate-limited or overflowing send resolves `{}`: not sent.
						const status = response.statusCode;
						settle(status !== undefined && status >= 200 && status < 300);
						return response;
					},
					(error: unknown) => {
						settle(false);
						throw error;
					},
				);
			},
		};
	};
}

/** `/opt/homebrew/…/onlooker.mjs` → `onlooker.mjs`; `node:fs` unchanged. */
function fileName(path: string): string {
	return path.slice(path.replace(/\\/g, "/").lastIndexOf("/") + 1);
}

/**
 * An absolute path inside free text: POSIX (`/…`, `~/…`), Windows (`C:\…`,
 * `\\server\…`) or a `file://` URL. Quoted, it may hold spaces, as Node's
 * own fs messages quote it; bare, it ends at whitespace.
 *
 * The lookbehind is what leaves URLs alone: the slashes in
 * `https://host/path` follow a colon, a slash or a letter, never a space.
 * `node:fs` has no leading slash, so it never matches.
 */
const QUOTED_PATH =
	/(['"`])((?:file:\/\/|~[\\/]|\/|[A-Za-z]:[\\/]|\\\\)[^'"`\n]*?)\1/g;
// A colon is not in the lookbehind, so `path:/a/b.ts` is cut; the `(?!\/)`
// keeps the first slash of `https://` out instead, and the second follows
// a slash.
const BARE_PATH =
	/(?<![\w/\\.~-])(?:file:\/\/\S*|~[\\/]\S*|\/(?!\/)[^\s'"`()<>,;]+|[A-Za-z]:[\\/][^\s'"`()<>,;]*|\\\\[^\s'"`()<>,;]+)/g;

/** Home is replaced only where a path segment ends: `/Users/al` is not `/Users/alice`. */
function homeAsTilde(text: string, home: string): string {
	if (home.length <= 1) return text;
	const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return text.replace(new RegExp(`${escaped}(?![\\w-])`, "g"), "~");
}

/**
 * Adapter-local, not in the shared scrub: the hosted apps report their own
 * signed-in users, and what they redact is a separate decision.
 */
const EMAIL =
	/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * Strip what a person's machine adds to free text.
 *
 * Home goes first, so a path under it is recognized as one (`~/…`) before
 * it is cut. A path names the directories someone works in, and only its
 * last segment says anything about the bug.
 */
function localizeText(text: string, home: string): string {
	return homeAsTilde(text, home)
		.replace(
			QUOTED_PATH,
			(_match, quote, path) => `${quote}${fileName(path)}${quote}`,
		)
		.replace(BARE_PATH, (path) => fileName(path))
		.replace(EMAIL, "[email]");
}

/**
 * Strip what a person's machine adds to an event.
 *
 * A full frame path repeats the home directory, so frames show a file name.
 * The bundle is one file, so the name still says where in it the frame is.
 */
function localize(event: ErrorEvent, home: string): ErrorEvent {
	if (event.message) event.message = localizeText(event.message, home);
	for (const exception of event.exception?.values ?? []) {
		if (exception.value) exception.value = localizeText(exception.value, home);
		for (const frame of exception.stacktrace?.frames ?? []) {
			if (frame.filename) frame.filename = fileName(frame.filename);
		}
	}
	return event;
}

/** Defined fields only, so an absent one stays absent rather than `null`. */
function pick<T extends object, K extends keyof T>(
	source: T,
	keys: readonly K[],
): Pick<T, K> {
	const out = {} as Pick<T, K>;
	for (const key of keys) {
		if (source[key] !== undefined) out[key] = source[key];
	}
	return out;
}

const FRAME_FIELDS = [
	"filename",
	"function",
	"lineno",
	"colno",
	"in_app",
] as const satisfies ReadonlyArray<keyof StackFrame>;

const MECHANISM_FIELDS = [
	"type",
	"handled",
	"synthetic",
	"source",
	"exception_id",
	"parent_id",
	"is_exception_group",
] as const;

/**
 * What stands in for a parse error's message. Node's `JSON.parse` quotes the
 * start of the text it failed on, so a crash over a corrupt local file would
 * send part of that file. No scrub can tell which words are the file's, so
 * the message goes whole and the type and frames say what happened.
 */
const PARSE_ERROR_MESSAGE = "[message omitted: may quote input]";

function allowedException(exception: Exception): Exception {
	const out: Exception = pick(exception, ["type", "value"]);
	if (exception.type === "SyntaxError") out.value = PARSE_ERROR_MESSAGE;
	if (exception.mechanism) {
		out.mechanism = pick(exception.mechanism, MECHANISM_FIELDS);
	}
	if (exception.stacktrace?.frames) {
		out.stacktrace = {
			frames: exception.stacktrace.frames.map((frame) =>
				pick(frame, FRAME_FIELDS),
			),
		};
	}
	return out;
}

/**
 * The event, rebuilt from the fields the spec's table lists.
 *
 * An allowlist, so it holds against what nobody thought of: a thrown plain
 * object arrives as `extra.__serialized__`, unscrubbed, and a scope can
 * carry a user, breadcrumbs or contexts from code that never meant them for
 * a crash report. None of that is copied. Frame source lines, `abs_path`
 * and `module` are left behind the same way.
 */
function allowlist(event: ErrorEvent): ErrorEvent {
	const out: ErrorEvent = {
		type: undefined,
		...pick(event, [
			"event_id",
			"timestamp",
			"level",
			"platform",
			"environment",
			"release",
			"tags",
			"message",
			"sdk",
		]),
	};
	// A SyntaxError sent as text has no exception value to key on.
	if (out.message && /^SyntaxError\b/.test(out.message)) {
		out.message = PARSE_ERROR_MESSAGE;
	}
	if (event.exception?.values) {
		out.exception = { values: event.exception.values.map(allowedException) };
	}
	const trace = event.contexts?.trace;
	if (trace) {
		out.contexts = {
			trace: { trace_id: trace.trace_id, span_id: trace.span_id },
		};
	}
	return out;
}

/**
 * A `Monitor` for a Node process on someone else's machine: the CLI.
 *
 * `@sentry/core` only, not `@sentry/node`. That keeps OpenTelemetry and
 * module patching out of a process that runs for milliseconds, and it means
 * the machine context `@sentry/node` collects by default (the hostname among
 * it) is never collected at all, rather than collected and stripped.
 *
 * Registers its client as core's global one, so `createSentryMonitor` reaches
 * it, as it reaches the client the browser and Workers SDKs register.
 */
export function createNodeMonitor(
	config: MonitoringConfig,
	{ fetch, home }: NodeMonitoringOptions,
): Monitor {
	if (!config.dsn) return noopMonitor;

	const base = sentryOptions(config);
	const delivery: Delivery = { accepted: undefined };
	const client = new ServerRuntimeClient({
		...base,
		// The shared scrub before the paths are cut, so a credential in a path
		// segment is caught in the shape its patterns know, not as a file name.
		beforeSend: (event: ErrorEvent) =>
			localize(base.beforeSend(allowlist(event)), home),
		integrations: [
			eventFiltersIntegration(),
			linkedErrorsIntegration(),
			dedupeIntegration(),
		],
		stackParser: createStackParser(nodeStackLineParser()),
		transport: fetchTransport(fetch, delivery),
		platform: "node",
	});
	setCurrentClient(client);
	client.init();
	const monitor = createSentryMonitor();
	return {
		...monitor,
		// Drained and accepted. An event dropped before sending never sets
		// `accepted`, so it reads as not sent too.
		flush: async (timeoutMs) =>
			(await monitor.flush(timeoutMs)) && delivery.accepted === true,
	};
}
