import { type Monitor, noopMonitor } from "@onlooker/monitoring";
import {
	type BaseTransportOptions,
	createStackParser,
	createTransport,
	dedupeIntegration,
	type ErrorEvent,
	eventFiltersIntegration,
	linkedErrorsIntegration,
	nodeStackLineParser,
	ServerRuntimeClient,
	setCurrentClient,
	type Transport,
} from "@sentry/core";
import { createSentryMonitor } from "./monitor";
import { type MonitoringConfig, sentryOptions } from "./options";

/** The part of `fetch` the transport uses. Node's global `fetch` satisfies it. */
export type FetchLike = (
	url: string,
	init: {
		method: string;
		body: string | Uint8Array;
		headers: Record<string, string>;
	},
) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

export interface NodeMonitoringOptions {
	/** Injected so this package needs no Node types, and a test can watch it. */
	fetch: FetchLike;
	/** The user's home directory, shown as `~` in anything sent. */
	home: string;
}

function fetchTransport(fetchImpl: FetchLike) {
	return (options: BaseTransportOptions): Transport =>
		createTransport(options, async ({ body }) => {
			const response = await fetchImpl(options.url, {
				method: "POST",
				body,
				headers: { "Content-Type": "application/x-sentry-envelope" },
			});
			return {
				statusCode: response.status,
				headers: {
					"x-sentry-rate-limits": response.headers.get("X-Sentry-Rate-Limits"),
					"retry-after": response.headers.get("Retry-After"),
				},
			};
		});
}

/** `/opt/homebrew/…/onlooker.mjs` → `onlooker.mjs`; `node:fs` unchanged. */
function fileName(path: string): string {
	return path.slice(path.replace(/\\/g, "/").lastIndexOf("/") + 1);
}

/**
 * Strip what a person's machine adds to an event.
 *
 * A home directory names the user, and a full frame path repeats it, so
 * messages show `~` and frames show a file name. The bundle is one file, so
 * the name still says where in it the frame is.
 */
function localize(event: ErrorEvent, home: string): ErrorEvent {
	const strip = (text: string) => (home ? text.split(home).join("~") : text);
	if (event.message) event.message = strip(event.message);
	for (const exception of event.exception?.values ?? []) {
		if (exception.value) exception.value = strip(exception.value);
		for (const frame of exception.stacktrace?.frames ?? []) {
			if (frame.filename) frame.filename = fileName(frame.filename);
			delete frame.abs_path;
			delete frame.module;
		}
	}
	return event;
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
	const client = new ServerRuntimeClient({
		...base,
		beforeSend: (event: ErrorEvent) => base.beforeSend(localize(event, home)),
		integrations: [
			eventFiltersIntegration(),
			linkedErrorsIntegration(),
			dedupeIntegration(),
		],
		stackParser: createStackParser(nodeStackLineParser()),
		transport: fetchTransport(fetch),
		platform: "node",
	});
	setCurrentClient(client);
	client.init();
	return createSentryMonitor();
}
