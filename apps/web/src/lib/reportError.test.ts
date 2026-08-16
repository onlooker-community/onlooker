import { afterEach, describe, expect, it, vi } from "vitest";
import { redactSecrets, reportClientError } from "./reportError";

// The suite runs with no VITE_API_BASE_URL, so the real config resolves to the
// in-memory mock - and reportClientError deliberately does not post anywhere in
// that case, because there is no server to post to. Pin a configured API here
// so the sending path is the one under test.
vi.mock("../api/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../api/config")>();
	return {
		...actual,
		resolveApiConfig: () => ({
			...actual.resolveApiConfig(),
			baseUrl: "https://api.onlooker.dev",
			useMockApi: false,
		}),
	};
});

// The scrubbing is the part that matters. An error report carries whatever URL
// the user was on, and two of this app's routes put a single-use credential in
// the path: /reset-password/<token> and /verify-email/<token>. Reporting those
// unredacted would take a token that exists only in someone's inbox and copy it
// into a log that several people can read.
//
// The same applies to the message and the stack, not just the URL - "Failed to
// fetch https://api.../reset-password/abc" is the ordinary shape of a network
// error and carries the token with it.

const TOKEN = "a".repeat(64);

describe("redactSecrets", () => {
	it("redacts a reset token out of a path", () => {
		const out = redactSecrets(
			`https://app.onlooker.dev/reset-password/${TOKEN}`,
		);

		expect(out).not.toContain(TOKEN);
		expect(out).toContain("/reset-password/");
	});

	it("redacts a verification token out of a path", () => {
		const out = redactSecrets(`https://app.onlooker.dev/verify-email/${TOKEN}`);

		expect(out).not.toContain(TOKEN);
	});

	it("redacts a token passed as a query parameter", () => {
		const out = redactSecrets(
			`https://api.onlooker.dev/auth/reset-password/verify?token=${TOKEN}`,
		);

		expect(out).not.toContain(TOKEN);
	});

	// The route list is not the guarantee - a new route carrying a token would
	// not be in it. Tokens are 64 hex characters, so redacting anything that
	// shape catches them wherever they surface, including inside a stack.
	it("redacts a token-shaped string anywhere, not only on known routes", () => {
		const out = redactSecrets(
			`Failed to fetch https://api.onlooker.dev/some/future/route/${TOKEN}`,
		);

		expect(out).not.toContain(TOKEN);
	});

	it("redacts a bearer token out of a message", () => {
		const out = redactSecrets(
			"Request failed with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig",
		);

		expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
	});

	// Over-redaction has a cost too: a report with nothing identifiable in it is
	// not worth sending. Ordinary paths and words must survive.
	it("leaves ordinary text alone", () => {
		expect(redactSecrets("https://app.onlooker.dev/dashboard")).toBe(
			"https://app.onlooker.dev/dashboard",
		);
		expect(redactSecrets("Cannot read properties of undefined")).toBe(
			"Cannot read properties of undefined",
		);
	});

	// Both of these were found in a production log line, not in review. The
	// redaction was correct - every secret was gone - and it had also eaten a
	// real endpoint path and a closing bracket, which is the over-redaction cost
	// this module's own comment warns about, arriving in the one place someone
	// reads carefully during an incident.
	it("keeps a real path segment that only looks like a token's position", () => {
		// /auth/reset-password/verify is an endpoint. `verify` is not a secret.
		const out = redactSecrets(
			`https://api.onlooker.dev/auth/reset-password/verify?token=${TOKEN}`,
		);

		expect(out).toContain("/reset-password/verify");
		expect(out).not.toContain(TOKEN);
	});

	it("stops at punctuation instead of swallowing it", () => {
		const out = redactSecrets(
			`at fetch (https://api.onlooker.dev/x?token=${TOKEN}) with Bearer y`,
		);

		// The frame has to stay readable - a stack that loses its brackets is
		// harder to parse than one that never had them.
		expect(out).toContain(")");
		expect(out).not.toContain(TOKEN);
	});

	it("survives an empty or absent value", () => {
		expect(redactSecrets("")).toBe("");
		expect(redactSecrets(undefined)).toBeUndefined();
	});
});

describe("reportClientError", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("posts a redacted report", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 204 }));

		reportClientError({
			kind: "render",
			message: `boom at /reset-password/${TOKEN}`,
			url: `https://app.onlooker.dev/reset-password/${TOKEN}`,
		});
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

		const body = String(fetchMock.mock.calls[0][1]?.body);
		expect(body).not.toContain(TOKEN);
		expect(body).toContain("render");
	});

	// A reporter that can break the page is worse than no reporter. This runs
	// inside a boundary that has already caught one failure.
	it("never throws when the network is gone", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

		expect(() =>
			reportClientError({ kind: "uncaught", message: "x", url: "/" }),
		).not.toThrow();
	});

	// Unbounded strings from a browser become unbounded log lines. A stack from
	// a deep render loop can be enormous.
	it("truncates oversized fields", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 204 }));

		reportClientError({
			kind: "render",
			message: "m".repeat(50_000),
			stack: "s".repeat(50_000),
			url: "/",
		});
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

		expect(String(fetchMock.mock.calls[0][1]?.body).length).toBeLessThan(
			10_000,
		);
	});
});
