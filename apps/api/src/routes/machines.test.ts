import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const db = () => env.DB;
const BASE = "https://api.onlooker.dev";
const PASSWORD = "correct-horse-battery";

let accessToken: string;

async function signup(email: string): Promise<string> {
	const response = await SELF.fetch(`${BASE}/auth/signup`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password: PASSWORD, name: "Ada" }),
	});
	const body = (await response.json()) as { token: string };
	return body.token;
}

beforeEach(async () => {
	await db().prepare("DELETE FROM machine_tokens").run();
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM users").run();
	accessToken = await signup("machines@example.com");
});

describe("POST /machines", () => {
	it("returns the raw token exactly once", async () => {
		const response = await SELF.fetch(`${BASE}/machines`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ name: "work laptop" }),
		});

		expect(response.status).toBe(201);
		const created = (await response.json()) as { id: string; token: string };
		expect(created.token).toMatch(/^onlk_[0-9a-f]{64}$/);

		// The list must never carry it again.
		const list = await SELF.fetch(`${BASE}/machines`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		expect(await list.text()).not.toContain(created.token);
	});

	it("rejects a request with no credential at all", async () => {
		const response = await SELF.fetch(`${BASE}/machines`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "work laptop" }),
		});

		expect(response.status).toBe(401);
	});

	it("rejects a real machine token, not just a browser session", async () => {
		const seed = await SELF.fetch(`${BASE}/machines`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ name: "seed machine" }),
		});
		const { token: machineToken } = (await seed.json()) as { token: string };

		const response = await SELF.fetch(`${BASE}/machines`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${machineToken}`,
			},
			body: JSON.stringify({ name: "work laptop" }),
		});

		expect(response.status).toBe(401);
	});

	it("rejects a blank name", async () => {
		const response = await SELF.fetch(`${BASE}/machines`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ name: "   " }),
		});

		expect(response.status).toBe(400);
	});
});

describe("DELETE /machines/:id", () => {
	it("will not revoke another user's machine", async () => {
		const create = await SELF.fetch(`${BASE}/machines`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ name: "mine" }),
		});
		const { id } = (await create.json()) as { id: string };

		const otherToken = await signup("other@example.com");
		const response = await SELF.fetch(`${BASE}/machines/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${otherToken}` },
		});

		expect(response.status).toBe(404);
	});
});
