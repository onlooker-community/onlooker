import { env } from "cloudflare:workers";
import type { RateLimit } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it } from "vitest";
import { dispatch } from "../router";
import { BASE, lesson, mintMachine } from "../test-support/lessons.js";
import { resetOrgTables, signup } from "../test-support/orgs.js";
import type { WorkerEnv } from "../types";

/**
 * The circuit breaker as a caller meets it: through dispatch, with a fake
 * limiter on env. The worker's default export can't carry a per-test binding, so these call
 * dispatch directly with the worker's own env plus the fake.
 */

function fakeLimiter(success: boolean): RateLimit & { keys: string[] } {
	const keys: string[] = [];
	return {
		keys,
		limit: async ({ key }) => {
			keys.push(key);
			return { success };
		},
	};
}

function envWith(limiter: RateLimit): WorkerEnv {
	return { ...(env as unknown as WorkerEnv), ACCOUNT_LIMITER: limiter };
}

function request(path: string, token: string | null, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	headers.set("Content-Type", "application/json");
	if (token) headers.set("Authorization", `Bearer ${token}`);
	return new Request(`${BASE}${path}`, { ...init, headers });
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
	const row = await env.DB.prepare(sql)
		.bind(...binds)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM lesson_feed").run();
	await env.DB.prepare("DELETE FROM lessons").run();
	await env.DB.prepare("DELETE FROM machine_tokens").run();
	await resetOrgTables();
});

describe("the per-account limit", () => {
	it("refuses a session route with 429 before its handler runs", async () => {
		const ada = await signup("ada@example.com");
		const response = await dispatch(
			request("/api/machines", ada.token, {
				method: "POST",
				body: JSON.stringify({ name: "refused" }),
			}),
			envWith(fakeLimiter(false)),
		);
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("60");
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("rate_limited");
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM machine_tokens WHERE user_id = ?",
				ada.id,
			),
		).toBe(0);
	});

	it("refuses a machine route with 429 before its handler runs", async () => {
		const machine = await mintMachine("grace@example.com");
		const response = await dispatch(
			request("/lessons", machine.token, {
				method: "POST",
				body: JSON.stringify({ lessons: [lesson()] }),
			}),
			envWith(fakeLimiter(false)),
		);
		expect(response.status).toBe(429);
		expect(await count("SELECT COUNT(*) AS n FROM lessons")).toBe(0);
	});

	it("lets an allowed request reach its handler", async () => {
		const ada = await signup("ada@example.com");
		const response = await dispatch(
			request("/api/machines", ada.token, {
				method: "POST",
				body: JSON.stringify({ name: "allowed" }),
			}),
			envWith(fakeLimiter(true)),
		);
		expect(response.status).toBeLessThan(300);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM machine_tokens WHERE user_id = ?",
				ada.id,
			),
		).toBe(1);
	});

	it("keys a session and a machine token on one account alike", async () => {
		const ada = await signup("ada@example.com");
		const minted = await dispatch(
			request("/api/machines", ada.token, {
				method: "POST",
				body: JSON.stringify({ name: "laptop" }),
			}),
			env as unknown as WorkerEnv,
		);
		const { token: machineToken } = (await minted.json()) as { token: string };

		const limiter = fakeLimiter(true);
		await dispatch(request("/api/machines", ada.token), envWith(limiter));
		await dispatch(
			request("/lessons?since=0&limit=1", machineToken),
			envWith(limiter),
		);
		expect(limiter.keys).toEqual([`user:${ada.id}`, `user:${ada.id}`]);
	});

	it("never consults the limiter on a route that takes no credential", async () => {
		const limiter = fakeLimiter(false);
		const response = await dispatch(
			request("/auth/login", null, {
				method: "POST",
				body: JSON.stringify({ email: "nobody@example.com", password: "x" }),
			}),
			envWith(limiter),
		);
		expect(response.status).not.toBe(429);
		expect(limiter.keys).toEqual([]);
	});

	it("never consults the limiter when the credential is refused", async () => {
		const limiter = fakeLimiter(false);
		const response = await dispatch(
			request("/api/machines", "not-a-token"),
			envWith(limiter),
		);
		expect(response.status).toBe(401);
		expect(limiter.keys).toEqual([]);
	});
});
