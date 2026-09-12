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
 * them, so they land in Workers Logs alongside everything else, where
 * client-error-monitor.yml alerts on them.
 *
 * Nothing calls this directly any more. The app reports through `monitor` in
 * ../monitoring, which fans out to the provider and to this - kept so the
 * hourly workflow stays fed until it is retired on purpose.
 */

import { redactSecrets } from "@onlooker/api-contract";
import { resolveApiConfig } from "../api/config";

// Re-exported so this module stays the one place apps/web reaches for when it
// needs scrubbing. The implementation is shared with apps/api, which redacts
// again on receipt - see packages/api-contract/src/redact.ts for why both.
export { redactSecrets };

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
