import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createInvite } from "../db/org-invites.js";
import { createOrgWithOwner, getMembership } from "../db/orgs.js";
import { createUser } from "../db/queries.js";
import {
	call,
	resetOrgTables,
	type SignedUpUser,
	signup,
} from "../test-support/orgs.js";
import { hashToken } from "../utils/crypto.js";

const db = () => env.DB;
let ada: string;
let bob: SignedUpUser;
let orgId: string;

/** Seed an invitation directly, so the test holds the raw token. */
async function seedInvite(
	email: string,
	expiresAt = new Date(Date.now() + 86_400_000).toISOString(),
): Promise<string> {
	const token = crypto.randomUUID().replace(/-/g, "");
	await createInvite(db(), {
		orgId,
		email,
		role: "member",
		tokenHash: await hashToken(token),
		expiresAt,
		invitedBy: ada,
	});
	return token;
}

beforeEach(async () => {
	await resetOrgTables();
	ada = (await createUser(db(), "ada@example.com", "hash", "Ada")).id;
	bob = await signup("bob@example.com", "Bob");
	orgId = (await createOrgWithOwner(db(), "Acme", ada)).id;
});

describe("GET /api/orgs/invites/verify", () => {
	it("names the org for a valid token, with no credential", async () => {
		const token = await seedInvite("bob@example.com");
		const response = await call(
			`/api/orgs/invites/verify?token=${token}`,
			null,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			valid: true,
			org: { name: "Acme" },
			email: "bob@example.com",
		});
	});

	it("reports invalid for an unknown, expired or spent token", async () => {
		const expired = await seedInvite(
			"bob@example.com",
			new Date(Date.now() - 1000).toISOString(),
		);
		for (const token of [crypto.randomUUID(), expired]) {
			const response = await call(
				`/api/orgs/invites/verify?token=${token}`,
				null,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ valid: false });
		}
	});

	it("400s a request with no token at all", async () => {
		expect((await call("/api/orgs/invites/verify", null)).status).toBe(400);
	});
});

describe("POST /api/orgs/invites/accept", () => {
	it("joins the org at the invited role", async () => {
		const token = await seedInvite("bob@example.com");
		const response = await call("/api/orgs/invites/accept", bob.token, {
			method: "POST",
			body: JSON.stringify({ token }),
		});
		expect(response.status).toBe(200);
		expect(await getMembership(db(), orgId, bob.id)).toEqual({
			role: "member",
		});
	});

	it("401s without a session, even holding a valid token", async () => {
		const token = await seedInvite("bob@example.com");
		const response = await call("/api/orgs/invites/accept", null, {
			method: "POST",
			body: JSON.stringify({ token }),
		});
		expect(response.status).toBe(401);
	});

	it("refuses a valid token held by the wrong account", async () => {
		// The email binding is what keeps this from being membership-by-link: a
		// forwarded invitation must do nothing for anybody but the addressee.
		const token = await seedInvite("someone-else@example.com");
		const response = await call("/api/orgs/invites/accept", bob.token, {
			method: "POST",
			body: JSON.stringify({ token }),
		});
		expect(response.status).toBe(403);
		expect(await getMembership(db(), orgId, bob.id)).toBeNull();
	});

	it("matches the address case-insensitively", async () => {
		const token = await seedInvite("BOB@example.com");
		const response = await call("/api/orgs/invites/accept", bob.token, {
			method: "POST",
			body: JSON.stringify({ token }),
		});
		expect(response.status).toBe(200);
	});

	it("400s an expired token", async () => {
		const token = await seedInvite(
			"bob@example.com",
			new Date(Date.now() - 1000).toISOString(),
		);
		const response = await call("/api/orgs/invites/accept", bob.token, {
			method: "POST",
			body: JSON.stringify({ token }),
		});
		expect(response.status).toBe(400);
		expect(await getMembership(db(), orgId, bob.id)).toBeNull();
	});

	it("spends the token, so a replay fails", async () => {
		const token = await seedInvite("bob@example.com");
		expect(
			(
				await call("/api/orgs/invites/accept", bob.token, {
					method: "POST",
					body: JSON.stringify({ token }),
				})
			).status,
		).toBe(200);
		expect(
			(
				await call("/api/orgs/invites/accept", bob.token, {
					method: "POST",
					body: JSON.stringify({ token }),
				})
			).status,
		).toBe(400);
	});

	it("400s an unknown token", async () => {
		const response = await call("/api/orgs/invites/accept", bob.token, {
			method: "POST",
			body: JSON.stringify({ token: crypto.randomUUID() }),
		});
		expect(response.status).toBe(400);
	});

	it("refuses the stored token_hash as a credential", async () => {
		// This is the test that proves the table stores a hash rather than the
		// raw token, and it has to live here rather than in Task 7.
		//
		// A 32-byte token hex-encodes to 64 characters and so does its SHA-256,
		// so NO shape assertion can tell them apart - Task 7's "stores only a
		// hash" test was shown by mutation to stay green when the raw token was
		// stored instead. Task 7 has no observation point either: the raw value
		// is consumed server-side, and sendEmail appends the body only in
		// development, deliberately, because a live link in Workers Logs is a
		// credential readable by anyone with log access (onlooker-9dqr).
		//
		// The accept route supplies the missing observation. If the stored
		// value were the token, presenting it here would succeed. The property
		// asserted is the one that matters - a read of org_invites yields
		// nothing that works - rather than the mechanism that provides it, so
		// this survives a change to the token's length or encoding.
		await seedInvite("bob@example.com");
		const row = await db()
			.prepare("SELECT token_hash FROM org_invites")
			.first<{ token_hash: string }>();
		expect(row?.token_hash).toBeTruthy();

		const response = await call("/api/orgs/invites/accept", bob.token, {
			method: "POST",
			body: JSON.stringify({ token: row?.token_hash }),
		});
		expect(response.status).toBe(400);
		expect(await getMembership(db(), orgId, bob.id)).toBeNull();
	});
});
