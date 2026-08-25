import { describe, expect, it } from "vitest";
import { createAuthApiClient } from "./index";

/** The three methods AuthTokenStorage requires; none of them matter here. */
const noStorage = {
	getToken: () => null,
	setToken: () => {},
	clearToken: () => {},
};

describe("error envelope", () => {
	// The API wraps every error as { success: false, error: { code, message } }
	// via a shared errorHandler. The parser used to read `data.error` as the
	// code, which against that envelope is an OBJECT, and `data.message`, which
	// is undefined - so every non-401 error surfaced as "Request failed with
	// status N" and `err.code === "some_code"` was false in production while
	// true against the mock.
	it("reads the code and message out of the API's envelope", async () => {
		const client = createAuthApiClient({
			baseUrl: "https://api.test",
			tokenStorage: noStorage,
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						success: false,
						error: {
							code: "status_not_allowed",
							message: "A lesson may be retracted or made active again.",
						},
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				),
		});

		await expect(client.get("/thing")).rejects.toMatchObject({
			status: 400,
			code: "status_not_allowed",
			message: "A lesson may be retracted or made active again.",
		});
	});

	it("falls back when a response carries no envelope at all", async () => {
		const client = createAuthApiClient({
			baseUrl: "https://api.test",
			tokenStorage: noStorage,
			fetchImpl: async () => new Response("not json", { status: 500 }),
		});

		await expect(client.get("/thing")).rejects.toMatchObject({
			status: 500,
			code: "unknown_error",
			message: "Request failed with status 500",
		});
	});
});
