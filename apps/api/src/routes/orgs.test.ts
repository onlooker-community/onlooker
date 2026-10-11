import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addMembership } from "../db/orgs.js";
import { call, resetOrgTables, signup } from "../test-support/orgs.js";

const db = () => env.DB;
let adaToken: string;
let bobToken: string;
let bobId: string;

beforeEach(async () => {
	await resetOrgTables();
	adaToken = (await signup("ada@example.com")).token;
	const bob = await signup("bob@example.com");
	bobToken = bob.token;
	bobId = bob.id;
});

async function createOrg(token: string, name = "Acme"): Promise<string> {
	const response = await call("/api/orgs", token, {
		method: "POST",
		body: JSON.stringify({ name }),
	});
	expect(response.status).toBe(201);
	const body = (await response.json()) as { org: { id: string } };
	return body.org.id;
}

describe("POST /api/orgs", () => {
	it("creates an org with the caller as owner", async () => {
		const response = await call("/api/orgs", adaToken, {
			method: "POST",
			body: JSON.stringify({ name: "Acme" }),
		});
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			org: { name: "Acme", role: "owner" },
		});
	});

	it("401s without a credential", async () => {
		const response = await call("/api/orgs", null, {
			method: "POST",
			body: JSON.stringify({ name: "Acme" }),
		});
		expect(response.status).toBe(401);
	});

	it("400s an empty or absent name", async () => {
		for (const body of [{}, { name: "" }, { name: "   " }]) {
			const response = await call("/api/orgs", adaToken, {
				method: "POST",
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
		}
	});

	it("400s a name past the length cap", async () => {
		const response = await call("/api/orgs", adaToken, {
			method: "POST",
			body: JSON.stringify({ name: "a".repeat(101) }),
		});
		expect(response.status).toBe(400);
	});
});

describe("GET /api/orgs", () => {
	it("lists only the caller's orgs", async () => {
		await createOrg(adaToken, "Acme");
		const mine = await call("/api/orgs", adaToken);
		expect(await mine.json()).toMatchObject({
			orgs: [{ name: "Acme", role: "owner" }],
		});

		const theirs = await call("/api/orgs", bobToken);
		expect(await theirs.json()).toEqual({ orgs: [] });
	});
});

describe("PATCH /api/orgs/:id", () => {
	it("renames for an owner", async () => {
		const orgId = await createOrg(adaToken);
		const response = await call(`/api/orgs/${orgId}`, adaToken, {
			method: "PATCH",
			body: JSON.stringify({ name: "Acme Inc" }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			org: { id: orgId, name: "Acme Inc" },
		});
	});

	it("404s a non-member", async () => {
		const orgId = await createOrg(adaToken);
		const response = await call(`/api/orgs/${orgId}`, bobToken, {
			method: "PATCH",
			body: JSON.stringify({ name: "Hostile Takeover" }),
		});
		expect(response.status).toBe(404);
	});

	it("404s an org that does not exist", async () => {
		const response = await call(`/api/orgs/${crypto.randomUUID()}`, adaToken, {
			method: "PATCH",
			body: JSON.stringify({ name: "Ghost" }),
		});
		expect(response.status).toBe(404);
	});
});

describe("DELETE /api/orgs/:id", () => {
	it("deletes an org whose only member is the owner", async () => {
		const orgId = await createOrg(adaToken, "Solo");

		const response = await call(`/api/orgs/${orgId}`, adaToken, {
			method: "DELETE",
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ deleted: orgId });

		// Gone from the caller's own list, not merely reported gone.
		const list = await call("/api/orgs", adaToken);
		const { orgs } = (await list.json()) as { orgs: { id: string }[] };
		expect(orgs.map((o) => o.id)).not.toContain(orgId);
	});

	it("refuses with 409 and the member count while anyone else remains", async () => {
		const orgId = await createOrg(adaToken, "Acme");
		await addMembership(db(), orgId, bobId, "member");

		const response = await call(`/api/orgs/${orgId}`, adaToken, {
			method: "DELETE",
		});

		expect(response.status).toBe(409);
		const body = (await response.json()) as {
			error: { code: string; details?: { member_count?: number } };
		};
		expect(body.error.code).toBe("has_members");
		// The count is what makes the refusal actionable without naming
		// people the page already lists.
		expect(body.error.details?.member_count).toBe(2);
	});

	it("gives a plain member 404, not 403", async () => {
		const orgId = await createOrg(adaToken, "Acme");
		await addMembership(db(), orgId, bobId, "member");

		const response = await call(`/api/orgs/${orgId}`, bobToken, {
			method: "DELETE",
		});

		expect(response.status).toBe(404);
	});

	it("gives 404 for an org that is already gone", async () => {
		const orgId = await createOrg(adaToken, "Solo");
		await call(`/api/orgs/${orgId}`, adaToken, { method: "DELETE" });

		const again = await call(`/api/orgs/${orgId}`, adaToken, {
			method: "DELETE",
		});

		expect(again.status).toBe(404);
	});
});
