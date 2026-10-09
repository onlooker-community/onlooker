import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createOrgWithOwner } from "../db/orgs.js";

const db = () => env.DB;
const BASE = "https://api.onlooker.dev";
const PASSWORD = "correct-horse-battery";

let accessToken: string;
let orgId: string;

async function signup(email: string): Promise<{ id: string; token: string }> {
	const response = await SELF.fetch(`${BASE}/auth/signup`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password: PASSWORD, name: "Ada" }),
	});
	const body = (await response.json()) as {
		token: string;
		user: { id: string };
	};
	return { id: body.user.id, token: body.token };
}

beforeEach(async () => {
	await db().prepare("DELETE FROM machine_tokens").run();
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM org_memberships").run();
	await db().prepare("DELETE FROM orgs").run();
	await db().prepare("DELETE FROM users").run();
	const owner = await signup("machines@example.com");
	accessToken = owner.token;
	orgId = (await createOrgWithOwner(db(), "Acme", owner.id)).id;
});

describe("POST /api/machines", () => {
	it("returns the raw token exactly once", async () => {
		const response = await SELF.fetch(`${BASE}/api/machines`, {
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
		const list = await SELF.fetch(`${BASE}/api/machines`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		expect(await list.text()).not.toContain(created.token);
	});

	it("rejects a request with no credential at all", async () => {
		const response = await SELF.fetch(`${BASE}/api/machines`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "work laptop" }),
		});

		expect(response.status).toBe(401);
	});

	it("rejects a real machine token, not just a browser session", async () => {
		const seed = await SELF.fetch(`${BASE}/api/machines`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ name: "seed machine" }),
		});
		const { token: machineToken } = (await seed.json()) as { token: string };

		const response = await SELF.fetch(`${BASE}/api/machines`, {
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
		const response = await SELF.fetch(`${BASE}/api/machines`, {
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

describe("DELETE /api/machines/:id", () => {
	// The route's PRIMARY EFFECT, which had no test at all: replacing the id
	// extraction at machines.ts:53 with `const id = ""` left the whole suite
	// green, because the only case covered was one that 404s anyway - and it
	// 404s just as readily when the id is empty.
	//
	// The 200 alone is not enough either. Revocation that answers success and
	// leaves the credential working is the silent failure this whole subsystem
	// is written against, so the token is used afterwards.
	it("revokes your own machine, and the token stops working", async () => {
		const create = await SELF.fetch(`${BASE}/api/machines`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ name: "lost laptop" }),
		});
		const { id, token } = (await create.json()) as {
			id: string;
			token: string;
		};

		// It authenticates now, so the 401 below is about the revocation.
		const before = await SELF.fetch(`${BASE}/lessons?since=0`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(before.status).toBe(200);

		const revoke = await SELF.fetch(`${BASE}/api/machines/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		expect(revoke.status).toBe(200);
		expect(await revoke.json()).toEqual({ success: true });

		const after = await SELF.fetch(`${BASE}/lessons?since=0`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(after.status).toBe(401);

		// And the row says so, rather than the token merely having stopped
		// resolving for some other reason.
		const row = await db()
			.prepare("SELECT revoked_at FROM machine_tokens WHERE id = ?")
			.bind(id)
			.first<{ revoked_at: string | null }>();
		expect(row?.revoked_at).toBeTruthy();
	});

	it("404s for a machine that does not exist", async () => {
		const response = await SELF.fetch(`${BASE}/api/machines/no-such-machine`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(404);
	});

	it("will not revoke another user's machine", async () => {
		const create = await SELF.fetch(`${BASE}/api/machines`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ name: "mine" }),
		});
		const { id } = (await create.json()) as { id: string };

		const other = await signup("other@example.com");
		const response = await SELF.fetch(`${BASE}/api/machines/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${other.token}` },
		});

		expect(response.status).toBe(404);
	});
});

describe("minting a token for an org", () => {
	it("binds the token to an org the caller belongs to", async () => {
		const response = await SELF.fetch(`${BASE}/api/machines`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ name: "laptop", org_id: orgId }),
		});

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({ org_id: orgId });
	});

	it("404s an org the caller does not belong to", async () => {
		// 404 and not 403, matching orgs/authorize.ts: a non-member must not be
		// able to tell an org they are not in from an org that does not exist.
		const stranger = await signup("stranger@example.com");
		const other = await createOrgWithOwner(db(), "Somebody Else", stranger.id);

		const response = await SELF.fetch(`${BASE}/api/machines`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ name: "laptop", org_id: other.id }),
		});

		expect(response.status).toBe(404);
	});

	it("mints a private-only token when no org is named", async () => {
		const response = await SELF.fetch(`${BASE}/api/machines`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ name: "laptop" }),
		});

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({ org_id: null });
	});
});
