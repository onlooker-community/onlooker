import { beforeEach, describe, expect, it } from "vitest";
import { call, resetOrgTables, signup } from "../test-support/orgs.js";

let adaToken: string;
let bobToken: string;

beforeEach(async () => {
	await resetOrgTables();
	adaToken = (await signup("ada@example.com")).token;
	bobToken = (await signup("bob@example.com")).token;
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
