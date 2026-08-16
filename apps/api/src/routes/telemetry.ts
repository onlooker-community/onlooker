/**
 * Somewhere for the browser to report to.
 *
 * apps/web is served as static assets, so it has no Worker of its own and
 * produces no logs. This endpoint exists to give it one: reports arrive here
 * and are logged, which puts them in Workers Logs beside everything else.
 *
 * The alternative was adopting an error service first. This is smaller, ships
 * today, and keeps the destination a single function on each side - so moving
 * to Sentry or anything else later is a change here and in apps/web's
 * reportError, not a change everywhere errors are raised.
 */

import { redactSecrets } from "@onlooker/api-contract";

import type { WorkerEnv } from "../types";

/** Fields longer than this are truncated rather than rejected. */
const MAX_FIELD = 2_000;

/** A report larger than this is not worth reading and is refused outright. */
const MAX_BODY_BYTES = 16_000;

const KINDS = new Set(["render", "unhandled-rejection", "uncaught"]);

interface ClientErrorReport {
	kind?: unknown;
	message?: unknown;
	stack?: unknown;
	componentStack?: unknown;
	url?: unknown;
	userAgent?: unknown;
}

/**
 * Take one field from a report: bounded, and scrubbed again on arrival.
 *
 * apps/web redacts before sending, and this redacts on receipt, because the two
 * are doing different jobs. The client's is "do not put a secret on the
 * network". This one's is "never write anything secret-shaped to a log,
 * whoever sent it" - and this endpoint is unauthenticated, so whoever sent it
 * is genuinely anyone with curl. It does not take an attacker either: a cached
 * bundle from before the scrubbing existed produces exactly the same result.
 *
 * The comment here used to say the fields arrived already redacted and that
 * nothing should assume so - while the code assumed precisely that.
 */
function field(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return redactSecrets(value).slice(0, MAX_FIELD);
}

/**
 * POST /api/client-errors
 *
 * Unauthenticated by design: the failures most worth hearing about happen to
 * people who are not signed in, or whose session just broke. That does mean
 * anyone can write to this log, which is why the payload is bounded, the kind
 * is checked against a fixed set, and every field is truncated. CORS keeps
 * browsers on other origins out; it does not keep curl out, and nothing here
 * pretends otherwise.
 *
 * Always answers 204. A client reporting an error has no use for a second
 * error, and there is nothing it could do with one - apps/web ignores the
 * response entirely.
 */
export async function handleClientError(
	request: Request,
	_env: WorkerEnv,
): Promise<Response> {
	const raw = await request.text();

	if (raw.length > MAX_BODY_BYTES) {
		console.warn(
			`[client-error] refused an oversized report: ${raw.length} bytes`,
		);
		return new Response(null, { status: 204 });
	}

	let report: ClientErrorReport;
	try {
		report = JSON.parse(raw) as ClientErrorReport;
	} catch {
		console.warn("[client-error] refused a report that was not JSON");
		return new Response(null, { status: 204 });
	}

	const kind =
		typeof report.kind === "string" && KINDS.has(report.kind)
			? report.kind
			: "unknown";
	const message = field(report.message) ?? "(no message)";

	// One line, structured enough to filter on and read at a glance. Every field
	// goes through `field`, which bounds and scrubs it.
	console.error(
		JSON.stringify({
			event: "client_error",
			kind,
			message,
			url: field(report.url),
			userAgent: field(report.userAgent),
			stack: field(report.stack),
			componentStack: field(report.componentStack),
		}),
	);

	return new Response(null, { status: 204 });
}

/** Exported for the contract suite, which asserts the shape of a rejection. */
export const CLIENT_ERROR_LIMITS = { MAX_FIELD, MAX_BODY_BYTES } as const;
