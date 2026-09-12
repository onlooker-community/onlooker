import type { Breadcrumb, ErrorEvent, TransactionEvent } from "@sentry/core";
import { describe, expect, it } from "vitest";
import { sentryOptions } from "./options";

const TOKEN = "f".repeat(64);
const RESET_URL = `https://app.onlooker.dev/reset-password/${TOKEN}`;
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl";

const options = sentryOptions({
	dsn: "https://x@o1.ingest.sentry.io/1",
	environment: "staging",
});

function leaks(value: unknown): boolean {
	const serialized = JSON.stringify(value);
	return serialized.includes(TOKEN) || serialized.includes(JWT);
}

describe("sentryOptions", () => {
	it("passes identity through and collects no personal data", () => {
		expect(options.environment).toBe("staging");
		expect(options.sendDefaultPii).toBe(false);
		expect(options.dataCollection.httpBodies).toEqual([]);
	});

	it("leaves monitoring off when there is no DSN", () => {
		expect(
			sentryOptions({ dsn: undefined, environment: "development" }).dsn,
		).toBeUndefined();
	});

	it("scrubs an error event's message, exception, URL and headers", () => {
		const event: ErrorEvent = {
			type: undefined,
			message: `navigation to ${RESET_URL} failed`,
			exception: {
				values: [{ type: "TypeError", value: `Failed to fetch ${RESET_URL}` }],
			},
			request: {
				url: RESET_URL,
				query_string: "token=abc123",
				headers: { Referer: RESET_URL, Authorization: `Bearer ${JWT}` },
			},
		};

		const sent = options.beforeSend(event);

		expect(leaks(sent)).toBe(false);
		expect(sent.exception?.values?.[0]?.value).toContain(
			"/reset-password/[redacted]",
		);
	});

	it("scrubs a transaction named after a tokened path", () => {
		const event: TransactionEvent = {
			type: "transaction",
			transaction: `GET /verify-email/${TOKEN}`,
		};

		expect(leaks(options.beforeSendTransaction(event))).toBe(false);
	});

	it("scrubs navigation and fetch breadcrumbs", () => {
		const navigation: Breadcrumb = {
			category: "navigation",
			data: { from: "/login", to: `/reset-password/${TOKEN}` },
		};
		const fetch: Breadcrumb = {
			category: "fetch",
			message: `GET ${RESET_URL}`,
			data: { url: RESET_URL, status_code: 404 },
		};

		expect(leaks(options.beforeBreadcrumb(navigation))).toBe(false);
		const scrubbed = options.beforeBreadcrumb(fetch);
		expect(leaks(scrubbed)).toBe(false);
		expect(scrubbed.data?.status_code).toBe(404);
	});

	it("scrubs log messages", () => {
		const log = options.beforeSendLog({
			level: "info",
			message: `emailed ${RESET_URL}`,
		});

		expect(leaks(log)).toBe(false);
	});
});
