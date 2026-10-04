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
		// What this guards, precisely: accept hashes whatever it is given
		// before looking it up, so a value read straight out of `token_hash` is
		// not presentable. Change the lookup to stop hashing its input and this
		// test fails - which matters, because the stored hash would then BE a
		// working credential and a read of this table would hand one out.
		//
		// What it does NOT prove - an earlier version of this comment claimed
		// it did, wrongly - is that the column holds a hash rather than the raw
		// token. Both implementations 400 here: if the raw token were stored,
		// presenting it would still be hashed on the way in and still miss. A
		// 32-byte token and its SHA-256 are both 64 hex characters, so nothing
		// at this layer separates them by inspection either.
		//
		// The test that does catch a stored raw token is the happy-path accept
		// above. It passes only when the stored value equals the hash of the
		// token the email carried, so storing the raw token breaks it. That is
		// exactly why Task 7's mutation survived - Task 7 never exercises
		// accept - and why it cannot survive here.
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
