import { describe, expect, it, vi } from "vitest";
import { classify, createClient } from "../api";

const URL_ = "https://api.onlooker.dev/lessons";

describe("classify", () => {
	// Each of these is a different instruction to the user. Collapsing them into
	// one message is exactly the defect this replaces.
	it("calls 401 a credential problem and names the fix", () => {
		const f = classify(401, URL_, {});
		expect(f.kind).toBe("unauthorized");
		expect(f.message).toMatch(/onlooker link/);
	});

	// The failure that hid for two months. It must name the URL, because the
	// whole reason nobody noticed was that the message never said what 404'd.
	it("calls 404 terminal and names the URL", () => {
		const f = classify(404, URL_, {});
		expect(f.kind).toBe("gone");
		expect(f.message).toContain(URL_);
	});

	it("surfaces the API's own message on a 400", () => {
		const f = classify(400, URL_, {
			error: {
				code: "batch_too_large",
				message: "At most 100 lessons per request",
			},
		});
		expect(f.kind).toBe("rejected");
		expect(f.message).toContain("At most 100 lessons per request");
	});

	it("calls 5xx transient and says a retry is worth it", () => {
		const f = classify(503, URL_, {});
		expect(f.kind).toBe("transient");
		expect(f.message).toMatch(/again/i);
	});

	// 429 is the one 4xx that IS worth retrying. Bucketing it with the others
	// would tell the user to give up on a request that would succeed.
	it("calls 429 transient rather than terminal", () => {
		expect(classify(429, URL_, {}).kind).toBe("transient");
	});
});

describe("createClient", () => {
	function withFetch(status: number, body: unknown) {
		return vi.fn().mockResolvedValue({
			ok: status < 400,
			status,
			json: async () => body,
		});
	}

	it("sends the token as a bearer on verify", async () => {
		const fetchImpl = withFetch(200, { lessons: [], has_more: false });
		await createClient("https://api.onlooker.dev", "tok", fetchImpl).verify();
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://api.onlooker.dev/lessons?since=0&limit=1");
		expect(init.headers.Authorization).toBe("Bearer tok");
	});

	// GET /lessons is machine-authenticated; /api/lessons is the browser's
	// session route and would reject every valid machine token. Pinning the URL
	// is what stops that mix-up returning.
	it("verifies against the machine route, never the browser one", async () => {
		const fetchImpl = withFetch(200, { lessons: [], has_more: false });
		await createClient("https://api.onlooker.dev", "tok", fetchImpl).verify();
		expect(fetchImpl.mock.calls[0][0]).not.toContain("/api/lessons");
	});

	it("throws a classified error rather than a bare status", async () => {
		const client = createClient(
			"https://api.onlooker.dev",
			"tok",
			withFetch(401, {}),
		);
		await expect(client.verify()).rejects.toMatchObject({
			failure: { kind: "unauthorized" },
		});
	});

	// A refused connection never reaches a status code, and it is the case the
	// user can actually do something about by trying again.
	it("treats a network failure as transient", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
		const client = createClient("https://api.onlooker.dev", "tok", fetchImpl);
		await expect(client.push([])).rejects.toMatchObject({
			failure: { kind: "transient" },
		});
	});

	it("posts lessons as a bare array under `lessons`", async () => {
		const fetchImpl = withFetch(200, { results: [] });
		await createClient("https://api.onlooker.dev", "tok", fetchImpl).push([
			{ id: "x" },
		]);
		const [, init] = fetchImpl.mock.calls[0];
		expect(JSON.parse(init.body)).toEqual({ lessons: [{ id: "x" }] });
	});
});
