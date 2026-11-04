import type { AuthApiError } from "@onlooker/auth-core";
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

describe("Retry-After", () => {
	it("carries the server's Retry-After on a refused request", async () => {
		const client = createAuthApiClient({
			baseUrl: "https://api.test",
			tokenStorage: noStorage,
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						success: false,
						error: { code: "rate_limited", message: "Too many requests" },
					}),
					{
						status: 429,
						headers: {
							"Content-Type": "application/json",
							"Retry-After": "60",
						},
					},
				),
		});

		await expect(client.get("/auth/me")).rejects.toMatchObject({
			status: 429,
			code: "rate_limited",
			retryAfterMs: 60_000,
		});
	});

	it("leaves it undefined when the server sent none", async () => {
		const client = createAuthApiClient({
			baseUrl: "https://api.test",
			tokenStorage: noStorage,
			fetchImpl: async () => new Response("{}", { status: 503 }),
		});

		const failure = client.get("/auth/me").catch((e) => e);
		const error = (await failure) as AuthApiError;
		expect(error.status).toBe(503);
		expect(error.retryAfterMs).toBeUndefined();
	});
});
