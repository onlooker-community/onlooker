/**
 * Send client-side failures somewhere a human will see them.
 *
 * Nothing did, before this. apps/web is served as static assets with no Worker,
 * so it produces no logs, no traces and no metrics; the ErrorBoundary caught
 * render throws and console.error'd them into the browser of the person they
 * broke for. That is how a wrong response shape on /api/dashboard blanked the
 * page for every logged-in user while every dashboard stayed green.
 *
 * Deliberately a seam rather than a vendor. Reports go to apps/api, which logs
 * them, so they land in Workers Logs alongside everything else and the
 * destination stays one function. If a real error service is adopted later
 * (Sentry has a Workers OTLP integration, so it could cover this and Worker
 * tracing together), this is the file that changes.
 */

import { resolveApiConfig } from "../api/config";

export type ClientErrorKind = "render" | "unhandled-rejection" | "uncaught";

export interface ClientErrorInput {
	kind: ClientErrorKind;
	message: string;
	stack?: string;
	/** Where it happened. Redacted before sending. */
	url: string;
	/** React's component stack, when the boundary supplied one. */
	componentStack?: string;
}

/** Longest any single field may be once it reaches the wire. */
const MAX_FIELD = 2_000;

/**
 * Tokens issued by this system: 32 random bytes, hex encoded.
 *
 * Matched by shape rather than by location, because the route list below is not
 * a guarantee - a future route carrying a token would not be on it, and a stack
 * trace can carry one anywhere. 32+ hex characters is long enough that ordinary
 * text does not collide with it.
 */
const TOKEN_SHAPED = /\b[0-9a-f]{32,}\b/gi;

/** A JWT, which is what an Authorization header carries. */
const JWT_SHAPED = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** Routes that put a single-use credential in the path. */
const SECRET_PATH = /\/(reset-password|verify-email)\/[^/?#\s]+/gi;

/** Query parameters worth removing wherever they appear. */
const SECRET_PARAM = /([?&](?:token|password|secret|key)=)[^&\s]+/gi;

/**
 * Remove anything credential-shaped from a string.
 *
 * Four passes rather than one, because the failure modes differ: known routes
 * catch the common case legibly, the token and JWT shapes catch it wherever
 * else it surfaces, and query parameters catch the reset-verify call.
 *
 * Over-redaction has a cost too. A report with nothing identifiable left in it
 * is not worth sending, which is why this targets shapes rather than, say,
 * dropping every path segment.
 */
export function redactSecrets(value: string): string;
export function redactSecrets(value: undefined): undefined;
export function redactSecrets(value: string | undefined): string | undefined;
export function redactSecrets(value: string | undefined): string | undefined {
	if (!value) return value;

	return value
		.replace(SECRET_PATH, (_m, route) => `/${route}/[redacted]`)
		.replace(SECRET_PARAM, "$1[redacted]")
		.replace(JWT_SHAPED, "[redacted]")
		.replace(TOKEN_SHAPED, "[redacted]");
}

function clamp(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return redactSecrets(value).slice(0, MAX_FIELD);
}

/**
 * Report one failure. Fire and forget, and never throws.
 *
 * Both properties are load-bearing: this runs inside a boundary that has
 * already caught something, and on a path where the page is broken. A reporter
 * that can throw, or that a caller must await, is a second failure on top of
 * the first.
 */
export function reportClientError(input: ClientErrorInput): void {
	try {
		const { baseUrl, useMockApi } = resolveApiConfig();

		// Nothing to report to when the app is running on its in-memory mock -
		// there is no server, and posting to one would be inventing traffic.
		if (useMockApi) {
			console.error(`[client-error:${input.kind}]`, input.message);
			return;
		}

		const body = JSON.stringify({
			kind: input.kind,
			message: clamp(input.message) ?? "",
			stack: clamp(input.stack),
			componentStack: clamp(input.componentStack),
			url: clamp(input.url),
			userAgent:
				typeof navigator === "undefined"
					? undefined
					: navigator.userAgent.slice(0, 200),
		});

		void fetch(`${baseUrl}/api/client-errors`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			// The page may be navigating away as this fires - a failed dynamic
			// import usually is. keepalive lets the request outlive the document.
			keepalive: true,
		}).catch(() => {
			// Swallowed on purpose. There is nowhere left to report a failure to
			// report, and retrying an error report during an outage is how a
			// reporter turns one broken page into a request storm.
		});
	} catch {
		// Same reasoning, for anything synchronous above - a missing navigator, a
		// config that will not resolve.
	}
}

/**
 * Catch the failures no React boundary can see.
 *
 * A boundary only sees throws during render. It never sees a rejected promise
 * with no handler, an error thrown from an event listener, or a dynamic import
 * that 404s - which is the exact shape a stale tab hits after a deploy, and one
 * of the few ways a user experiences a bad release without any request of ours
 * failing.
 */
export function installGlobalErrorReporting(target: Window = window): void {
	target.addEventListener("unhandledrejection", (event) => {
		const reason = (event as PromiseRejectionEvent).reason;
		reportClientError({
			kind: "unhandled-rejection",
			message: reason instanceof Error ? reason.message : String(reason),
			stack: reason instanceof Error ? reason.stack : undefined,
			url: target.location?.href ?? "",
		});
	});

	target.addEventListener("error", (event) => {
		const error = (event as ErrorEvent).error;
		reportClientError({
			kind: "uncaught",
			message:
				error instanceof Error
					? error.message
					: ((event as ErrorEvent).message ?? "unknown error"),
			stack: error instanceof Error ? error.stack : undefined,
			url: target.location?.href ?? "",
		});
	});
}
