import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetOrgTables } from "../test-support/orgs.js";

const db = () => env.DB;

beforeEach(resetOrgTables);

async function seedOrgAndUser(): Promise<{ orgId: string; userId: string }> {
	const orgId = crypto.randomUUID();
	const userId = crypto.randomUUID();
	await db()
		.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)")
		.bind(orgId, "Acme")
		.run();
	await db()
		.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)")
		.bind(userId, "member@example.com", "hash")
		.run();
	return { orgId, userId };
}

describe("org schema", () => {
	it("holds one membership per (org, user) pair", async () => {
		const { orgId, userId } = await seedOrgAndUser();
		const insert = (id: string) =>
			db()
				.prepare(
					"INSERT INTO org_memberships (id, org_id, user_id, role) VALUES (?, ?, ?, ?)",
				)
				.bind(id, orgId, userId, "member")
				.run();

		await insert(crypto.randomUUID());

		// A second row for the same pair would let a removal leave someone a
		// member, so the constraint is the correctness mechanism rather than a
		// tidiness preference.
		await expect(insert(crypto.randomUUID())).rejects.toThrow();
	});

	it("cascades memberships when the org goes", async () => {
		const { orgId, userId } = await seedOrgAndUser();
		await db()
			.prepare(
				"INSERT INTO org_memberships (id, org_id, user_id, role) VALUES (?, ?, ?, ?)",
			)
			.bind(crypto.randomUUID(), orgId, userId, "owner")
			.run();

		await db().prepare("DELETE FROM orgs WHERE id = ?").bind(orgId).run();

		const left = await db()
			.prepare("SELECT COUNT(*) AS n FROM org_memberships")
			.first<{ n: number }>();
		expect(left?.n).toBe(0);
	});

	it("rejects two invites sharing a token hash", async () => {
		const { orgId, userId } = await seedOrgAndUser();
		const insert = (id: string, email: string) =>
			db()
				.prepare(
					"INSERT INTO org_invites (id, org_id, email, role, token_hash, expires_at, invited_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(
					id,
					orgId,
					email,
					"member",
					"same-hash",
					"2030-01-01T00:00:00.000Z",
					userId,
				)
				.run();

		await insert(crypto.randomUUID(), "one@example.com");
		await expect(
			insert(crypto.randomUUID(), "two@example.com"),
		).rejects.toThrow();
	});
});
