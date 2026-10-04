import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addMembership } from "../db/orgs.js";
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

function invite(token: string, email: string, role = "member") {
	return call(`/api/orgs/${orgId}/invites`, token, {
		method: "POST",
		body: JSON.stringify({ email, role }),
	});
}

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

describe("POST /api/orgs/:id/invites", () => {
	it("creates a pending invite for an owner", async () => {
		const response = await invite(ada.token, "new@example.com");
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			invite: { email: "new@example.com", role: "member" },
		});
	});

	it("never returns the raw token", async () => {
		// The token is a bearer credential for joining an org. It belongs in the
		// email and nowhere else, so a response body carrying it would put it in
		// every log and proxy between here and the browser.
		const response = await invite(ada.token, "new@example.com");
		const text = await response.text();
		expect(text).not.toMatch(/[0-9a-f]{64}/);
	});

	it("stores a 64-hex value in token_hash, never the email or a blank", async () => {
		// Deliberately weaker than its old name ("stores only a hash") implied.
		// A 32-byte token and its SHA-256 are both 64 hex characters, so this
		// assertion cannot tell a hash from the raw token - mutating
		// `hashToken(token)` to `token` keeps it green. It still rules out an
		// empty string, the address, or a truncated write.
		//
		// The test that does distinguish them needs an observation point this
		// layer does not have, and lives in routes/orgs-invite-accept.test.ts:
		// present the stored token_hash as a credential and watch it refused.
		await invite(ada.token, "new@example.com");
		const row = await db()
			.prepare("SELECT token_hash FROM org_invites")
			.first<{ token_hash: string }>();
		expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("404s a plain member", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		expect((await invite(bob.token, "new@example.com")).status).toBe(404);
	});

	it("404s a non-member", async () => {
		expect((await invite(bob.token, "new@example.com")).status).toBe(404);
	});

	it("409s an address already in the org", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		expect((await invite(ada.token, "bob@example.com")).status).toBe(409);
	});

	it("400s a malformed address and an unknown role", async () => {
		expect((await invite(ada.token, "not-an-email")).status).toBe(400);
		expect((await invite(ada.token, "new@example.com", "admin")).status).toBe(
			400,
		);
	});

	it("replaces an outstanding invite to the same address", async () => {
		await invite(ada.token, "new@example.com");
		await invite(ada.token, "new@example.com");

		// One inbox must never hold two live invitations - the same reasoning
		// account.ts:332 applies to verification links.
		const count = await db()
			.prepare("SELECT COUNT(*) AS n FROM org_invites WHERE email = ?")
			.bind("new@example.com")
			.first<{ n: number }>();
		expect(count?.n).toBe(1);
	});

	it("normalizes the address, so case cannot duplicate an invite", async () => {
		await invite(ada.token, "New@Example.com");
		const row = await db()
			.prepare("SELECT email FROM org_invites")
			.first<{ email: string }>();
		expect(row?.email).toBe("new@example.com");
	});
});

describe("GET /api/orgs/:id/invites", () => {
	it("lists pending invites to an owner, without tokens", async () => {
		await invite(ada.token, "new@example.com");
		const response = await call(`/api/orgs/${orgId}/invites`, ada.token);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain("new@example.com");
		expect(text).not.toMatch(/[0-9a-f]{64}/);
	});

	it("404s a plain member", async () => {
		await addMembership(db(), orgId, bob.id, "member");
		expect((await call(`/api/orgs/${orgId}/invites`, bob.token)).status).toBe(
			404,
		);
	});
});

describe("DELETE /api/orgs/:id/invites/:inviteId", () => {
	it("revokes a pending invite", async () => {
		const created = await invite(ada.token, "new@example.com");
		const { invite: made } = (await created.json()) as {
			invite: { id: string };
		};

		const response = await call(
			`/api/orgs/${orgId}/invites/${made.id}`,
			ada.token,
			{ method: "DELETE" },
		);
		expect(response.status).toBe(200);

		const count = await db()
			.prepare("SELECT COUNT(*) AS n FROM org_invites")
			.first<{ n: number }>();
		expect(count?.n).toBe(0);
	});

	it("404s an unknown invite", async () => {
		const response = await call(
			`/api/orgs/${orgId}/invites/${crypto.randomUUID()}`,
			ada.token,
			{ method: "DELETE" },
		);
		expect(response.status).toBe(404);
	});
});
