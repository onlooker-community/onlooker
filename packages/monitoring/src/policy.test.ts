import { describe, expect, it } from "vitest";
import { resolveEnvironment, scrubText } from "./policy";

describe("scrubText", () => {
	it("removes a reset token from a failed-fetch message", () => {
		const token = "a".repeat(64);

		const scrubbed = scrubText(
			`Failed to fetch https://app.onlooker.dev/reset-password/${token}`,
		);

		expect(scrubbed).not.toContain(token);
		expect(scrubbed).toContain("/reset-password/[redacted]");
	});

	it("removes a bearer JWT and a token query parameter", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl";

		const scrubbed = scrubText(
			`Authorization: Bearer ${jwt} at fetch (/auth/reset-password/verify?token=abc123)`,
		);

		expect(scrubbed).not.toContain(jwt);
		expect(scrubbed).not.toContain("abc123");
		// The closing bracket of the stack frame survives the parameter pass.
		expect(scrubbed).toContain("?token=[redacted])");
	});
});

describe("resolveEnvironment", () => {
	it("maps aliases onto the shared vocabulary", () => {
		expect(resolveEnvironment("prod", "development")).toBe("production");
		expect(resolveEnvironment(" Staging ", "development")).toBe("staging");
		expect(resolveEnvironment("local", "production")).toBe("development");
	});

	it("uses the caller's fallback for anything it does not recognise", () => {
		expect(resolveEnvironment(undefined, "production")).toBe("production");
		expect(resolveEnvironment("", "staging")).toBe("staging");
		expect(resolveEnvironment("preview-42", "development")).toBe("development");
	});
});
