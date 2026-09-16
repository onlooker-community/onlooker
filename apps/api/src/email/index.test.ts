import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerEnv } from "../types";
import { sendEmail } from "./index";

// What matters here is not that a POST goes out - it is what happens when one
// does not. Every caller of sendEmail is in an auth flow, and several of them
// must answer identically whether or not a message was delivered, so a delivery
// failure has to come back as a value rather than an exception.

function env(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
	return {
		EMAIL_FROM: "Onlooker <noreply@onlooker.dev>",
		APP_BASE_URL: "https://app.onlooker.dev",
		...overrides,
	} as WorkerEnv;
}

const message = {
	to: "someone@example.com",
	subject: "Reset your password",
	text: "https://app.onlooker.dev/reset-password/abc",
	html: "<a href='https://app.onlooker.dev/reset-password/abc'>Reset</a>",
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("sendEmail", () => {
	it("posts to the provider and reports success", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		const result = await sendEmail(env({ RESEND_API_KEY: "re_test" }), message);

		expect(result).toEqual({ sent: true });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.resend.com/emails");
		expect(new Headers(init?.headers as HeadersInit).get("Authorization")).toBe(
			"Bearer re_test",
		);
		const body = JSON.parse(init?.body as string);
		expect(body.from).toBe("Onlooker <noreply@onlooker.dev>");
		expect(body.to).toEqual(["someone@example.com"]);
	});

	// Both parts are always sent. Some clients show only the plain text, and a
	// password reset that arrives as an empty message is a support ticket.
	it("sends plain text alongside the html", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		await sendEmail(env({ RESEND_API_KEY: "re_test" }), message);

		const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
		expect(body.text).toContain("reset-password/abc");
		expect(body.html).toContain("reset-password/abc");
	});

	// Local development has no key and no reason to hand a real provider real
	// addresses, so the message goes to the log and the flow stays walkable.
	it("logs the whole message in development when no key is configured", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const result = await sendEmail(
			env({ ENVIRONMENT: "development" }),
			message,
		);

		expect(result).toEqual({ sent: false, reason: "no_api_key" });
		expect(fetchMock).not.toHaveBeenCalled();
		// The link has to be in the log or the flow cannot be walked locally.
		expect(warn.mock.calls[0][0]).toContain("reset-password/abc");
	});

	// A deployed worker with no key is a misconfiguration and the log line is
	// how it gets found, so it stays. What cannot stay is what it used to carry:
	// `message.text` is a live single-use reset link, and Workers Logs is not
	// the inbox it was addressed to. Anyone who can read the logs could complete
	// the reset.
	it("never logs the message body outside development", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const result = await sendEmail(env({ ENVIRONMENT: "production" }), message);

		expect(result).toEqual({ sent: false, reason: "no_api_key" });
		expect(warn.mock.calls[0][0]).not.toContain("reset-password/abc");
		// Still says what is wrong. A redacted line nobody can act on is worse
		// than no line at all.
		expect(warn.mock.calls[0][0]).toContain("RESEND_API_KEY");
	});

	it("never logs the recipient's address outside development", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await sendEmail(env({ ENVIRONMENT: "production" }), message);

		expect(warn.mock.calls[0][0]).not.toContain("someone@example.com");
	});

	// Unset is not development. ENVIRONMENT is optional on WorkerEnv and a
	// binding that never got set must fail toward redaction, not away from it -
	// the one environment that leaks is the one nobody configured.
	it("redacts when the environment is not stated at all", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await sendEmail(env(), message);

		expect(warn.mock.calls[0][0]).not.toContain("someone@example.com");
		expect(warn.mock.calls[0][0]).not.toContain("reset-password/abc");
	});

	// The domain survives redaction because it is the diagnostic part. An
	// unverified sending domain and a recipient domain bouncing everything are
	// the two failures this log exists to tell apart, and neither is legible
	// once the address is gone entirely.
	it("keeps the recipient's domain when redacting the address", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await sendEmail(env({ ENVIRONMENT: "production" }), message);

		expect(warn.mock.calls[0][0]).toContain("example.com");
	});

	it("reports a provider rejection without throwing", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("domain not verified", { status: 403 }),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(
			await sendEmail(env({ RESEND_API_KEY: "re_test" }), message),
		).toEqual({ sent: false, reason: "http_403" });
	});

	// The status alone cannot tell an unverified domain from a bad key, and both
	// are configuration mistakes someone has to find.
	it("logs the provider's explanation, not just the status", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("The onlooker.dev domain is not verified", { status: 403 }),
		);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await sendEmail(env({ RESEND_API_KEY: "re_test" }), message);

		expect(error.mock.calls[0][0]).toContain("not verified");
	});

	// The rejection path logs `to=` for the same reason the missing-key path
	// does, and leaks for the same reason too. A failed send is exactly when a
	// support conversation starts, so this line gets read by more people than
	// any other in the file.
	it("does not name the recipient when the provider rejects the message", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("domain not verified", { status: 403 }),
		);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await sendEmail(
			env({ RESEND_API_KEY: "re_test", ENVIRONMENT: "production" }),
			message,
		);

		expect(error.mock.calls[0][0]).not.toContain("someone@example.com");
		expect(error.mock.calls[0][0]).toContain("example.com");
	});

	// The provider's body is echoed into the log deliberately, which means the
	// provider chooses what this line says. A 422 that quotes the request back
	// would put the link in the log through a door the code never opened.
	it("redacts a provider response that quotes the message back", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				`invalid request: text=https://app.onlooker.dev/reset-password/${"a1b2c3d4".repeat(8)}`,
				{ status: 422 },
			),
		);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await sendEmail(
			env({ RESEND_API_KEY: "re_test", ENVIRONMENT: "production" }),
			message,
		);

		expect(error.mock.calls[0][0]).not.toContain("a1b2c3d4a1b2c3d4");
		// The reason for the rejection still has to survive the scrubbing.
		expect(error.mock.calls[0][0]).toContain("invalid request");
	});

	it("does not name the recipient when the provider is unreachable", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await sendEmail(
			env({ RESEND_API_KEY: "re_test", ENVIRONMENT: "production" }),
			message,
		);

		expect(error.mock.calls[0][0]).not.toContain("someone@example.com");
		expect(error.mock.calls[0][0]).toContain("ECONNRESET");
	});

	// A provider outage must not take an auth request down with it.
	it("survives the provider being unreachable", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(
			await sendEmail(env({ RESEND_API_KEY: "re_test" }), message),
		).toEqual({ sent: false, reason: "network_error" });
	});
});
