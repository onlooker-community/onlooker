import { type MonitoringEnvironment, scrubText } from "@onlooker/monitoring";
import type {
	Breadcrumb,
	ErrorEvent,
	Event,
	Options,
	TransactionEvent,
} from "@sentry/core";

export interface MonitoringConfig {
	/** Absent means off: the SDK initializes and sends nothing. */
	dsn: string | undefined;
	environment: MonitoringEnvironment;
	release?: string;
	/**
	 * 1.0 while traffic is small enough that every trace is affordable; lower
	 * it per app when that stops being true.
	 */
	tracesSampleRate?: number;
}

type Log = Parameters<NonNullable<Options["beforeSendLog"]>>[0];

function scrubStrings<T extends Record<string, unknown>>(record: T): T {
	return Object.fromEntries(
		Object.entries(record).map(([key, value]) => [
			key,
			typeof value === "string" ? scrubText(value) : value,
		]),
	) as T;
}

/**
 * Every string on an event that can carry a URL someone was visiting.
 *
 * Exception values are the likely leak - a failed fetch reads "Failed to
 * fetch <the reset link>". Request headers are the quiet one: a browser event
 * carries the Referer, and the page before a password form is often the
 * emailed link itself.
 */
function scrubEvent<T extends Event>(event: T): T {
	if (event.message) event.message = scrubText(event.message);
	if (event.transaction) event.transaction = scrubText(event.transaction);
	for (const exception of event.exception?.values ?? []) {
		if (exception.value) exception.value = scrubText(exception.value);
	}

	const request = event.request;
	if (request) {
		if (request.url) request.url = scrubText(request.url);
		if (request.headers) request.headers = scrubStrings(request.headers);
		if (typeof request.query_string === "string") {
			request.query_string = scrubText(request.query_string);
		}
	}
	return event;
}

/** Navigation breadcrumbs carry `from`/`to`; fetch ones carry `url`. */
function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
	if (breadcrumb.message) breadcrumb.message = scrubText(breadcrumb.message);
	if (breadcrumb.data) breadcrumb.data = scrubStrings(breadcrumb.data);
	return breadcrumb;
}

function scrubLog(log: Log): Log {
	log.message = scrubText(log.message);
	return log;
}

/**
 * The options every runtime shares, with @onlooker/monitoring's policy
 * applied at the provider's own hooks.
 *
 * Scrubbing happens here and not in `createSentryMonitor`, because most of
 * what Sentry sends never passes through a `Monitor` call: automatic
 * breadcrumbs, request data, transaction names. The hooks see all of it.
 */
export function sentryOptions(config: MonitoringConfig) {
	return {
		dsn: config.dsn,
		environment: config.environment,
		release: config.release,
		tracesSampleRate: config.tracesSampleRate ?? 1.0,
		sendDefaultPii: false,
		// Auth bodies carry passwords and refresh tokens; the waitlist body is
		// an email address. No body is worth that.
		dataCollection: { httpBodies: [], cookies: false, userInfo: false },
		beforeSend: (event: ErrorEvent) => scrubEvent(event),
		beforeSendTransaction: (event: TransactionEvent) => scrubEvent(event),
		beforeBreadcrumb: scrubBreadcrumb,
		beforeSendLog: scrubLog,
	} satisfies Options;
}
