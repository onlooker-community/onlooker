import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addMembership, getMembership } from "../db/orgs.js";
import {
	call,
	resetOrgTables,
	type SignedUpUser,
	signup,
} from "../test-support/orgs.js";

const db = () => env.DB;
let ada: SignedUpUser;
let bob: SignedUpUser;
let orgId: string;

beforeEach(async () => {
	await resetOrgTables();
	ada = await signup("ada@example.com");
	bob = await signup("bob@example.com");

	const created = await call("/api/orgs", ada.token, {
		method: "POST",
		body: JSON.stringify({ name: "Acme" }),
	});
	orgId = ((await created.json()) as { org: { id: string } }).org.id;
});

describe("GET /api/orgs/:id/members", () => {
	it("lists members to a member", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		const response = await call(`/api/orgs/${orgId}/members`, bob.token);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			members: { email: string; role: string }[];
		};
		expect(body.members.map((m) => [m.email, m.role])).toEqual(
			expect.arrayContaining([
				["ada@example.com", "owner"],
				["bob@example.com", "member"],
			]),
		);
	});

	it("404s a non-member", async () => {
		const response = await call(`/api/orgs/${orgId}/members`, bob.token);
		expect(response.status).toBe(404);
	});
});

describe("PATCH /api/orgs/:id/members/:userId", () => {
	it("promotes a member for an owner", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		const response = await call(
			`/api/orgs/${orgId}/members/${bob.id}`,
			ada.token,
			{ method: "PATCH", body: JSON.stringify({ role: "owner" }) },
		);
		expect(response.status).toBe(200);
		expect(await getMembership(db(), orgId, bob.id)).toEqual({ role: "owner" });
	});

	it("404s a plain member trying to promote themselves", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		const response = await call(
			`/api/orgs/${orgId}/members/${bob.id}`,
			bob.token,
			{ method: "PATCH", body: JSON.stringify({ role: "owner" }) },
		);
		expect(response.status).toBe(404);
		expect(await getMembership(db(), orgId, bob.id)).toEqual({
			role: "member",
		});
	});

	it("400s an unknown role", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		const response = await call(
			`/api/orgs/${orgId}/members/${bob.id}`,
			ada.token,
			{ method: "PATCH", body: JSON.stringify({ role: "admin" }) },
		);
		expect(response.status).toBe(400);
	});

	it("409s demoting the last owner", async () => {
		const response = await call(
			`/api/orgs/${orgId}/members/${ada.id}`,
			ada.token,
			{ method: "PATCH", body: JSON.stringify({ role: "member" }) },
		);
		expect(response.status).toBe(409);
		expect(await getMembership(db(), orgId, ada.id)).toEqual({ role: "owner" });
	});

	it("allows demoting an owner once there are two", async () => {
		await addMembership(db(), orgId, bob.id, "owner");
		const response = await call(
			`/api/orgs/${orgId}/members/${bob.id}`,
			ada.token,
			{ method: "PATCH", body: JSON.stringify({ role: "member" }) },
		);
		expect(response.status).toBe(200);
	});
});

describe("DELETE /api/orgs/:id/members/:userId", () => {
	it("removes a member for an owner", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		const response = await call(
			`/api/orgs/${orgId}/members/${bob.id}`,
			ada.token,
			{ method: "DELETE" },
		);
		expect(response.status).toBe(200);
		expect(await getMembership(db(), orgId, bob.id)).toBeNull();
	});

	// The documented exception to the role enumeration: this route's required
	// role depends on its arguments.
	it("lets a plain member remove their own id - that is leaving", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		const response = await call(
			`/api/orgs/${orgId}/members/${bob.id}`,
			bob.token,
			{ method: "DELETE" },
		);
		expect(response.status).toBe(200);
		expect(await getMembership(db(), orgId, bob.id)).toBeNull();
	});

	it("404s a plain member removing somebody else", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		const response = await call(
			`/api/orgs/${orgId}/members/${ada.id}`,
			bob.token,
			{ method: "DELETE" },
		);
		expect(response.status).toBe(404);
		expect(await getMembership(db(), orgId, ada.id)).toEqual({ role: "owner" });
	});

	it("409s the last owner leaving", async () => {
		const response = await call(
			`/api/orgs/${orgId}/members/${ada.id}`,
			ada.token,
			{ method: "DELETE" },
		);
		expect(response.status).toBe(409);
		expect(await getMembership(db(), orgId, ada.id)).toEqual({ role: "owner" });
	});
});
