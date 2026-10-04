import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetOrgTables } from "../test-support/orgs.js";
import {
	addMembership,
	countOwners,
	createOrgWithOwner,
	getMembership,
	listMembers,
	listOrgsForUser,
	removeMembership,
	renameOrg,
	setMemberRole,
} from "./orgs.js";
import { createUser } from "./queries.js";

const db = () => env.DB;
let ada: string;
let bob: string;

beforeEach(async () => {
	await resetOrgTables();
	ada = (await createUser(db(), "ada@example.com", "hash", "Ada")).id;
	bob = (await createUser(db(), "bob@example.com", "hash", "Bob")).id;
});

describe("createOrgWithOwner", () => {
	it("makes the creator an owner", async () => {
		const org = await createOrgWithOwner(db(), "Acme", ada);
		expect(await getMembership(db(), org.id, ada)).toEqual({ role: "owner" });
	});

	it("writes the org and its owner atomically", async () => {
		// A bare pair of inserts can leave an org with no owner if the second
		// fails - and an ownerless org is unadministerable. The batch must roll
		// back both on either failure. To prove this, trigger a FK violation on
		// the membership insert and assert the org insert was rolled back too.
		const fakeUserId = crypto.randomUUID();

		try {
			await createOrgWithOwner(db(), "Acme", fakeUserId);
		} catch {
			// FK violation expected when userId doesn't exist
		}

		const result = await db()
			.prepare("SELECT COUNT(*) AS n FROM orgs WHERE name = 'Acme'")
			.first<{ n: number }>();
		// If batch works, org is rolled back (n = 0). If the inserts are
		// separate, org row remains (n = 1) and the test fails.
		expect(result?.n).toBe(0);
	});
});

describe("listOrgsForUser", () => {
	it("returns each org with the caller's own role", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		const beta = await createOrgWithOwner(db(), "Beta", bob);
		await addMembership(db(), beta.id, ada, "member");

		const mine = await listOrgsForUser(db(), ada);
		expect(mine).toEqual(
			expect.arrayContaining([
				{ id: acme.id, name: "Acme", role: "owner" },
				{ id: beta.id, name: "Beta", role: "member" },
			]),
		);
		expect(mine).toHaveLength(2);
	});

	it("returns nothing for a user in no org", async () => {
		await createOrgWithOwner(db(), "Acme", ada);
		expect(await listOrgsForUser(db(), bob)).toEqual([]);
	});
});

describe("getMembership", () => {
	it("is null across an org boundary", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		expect(await getMembership(db(), acme.id, bob)).toBeNull();
	});
});

describe("listMembers", () => {
	it("names each member", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), acme.id, bob, "member");

		const members = await listMembers(db(), acme.id);
		expect(members.map((m) => [m.email, m.role, m.name])).toEqual(
			expect.arrayContaining([
				["ada@example.com", "owner", "Ada"],
				["bob@example.com", "member", "Bob"],
			]),
		);
	});
});

describe("renameOrg", () => {
	it("renames, and reports an unknown org", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		expect(await renameOrg(db(), acme.id, "Acme Inc")).toBe(true);
		expect((await listOrgsForUser(db(), ada))[0].name).toBe("Acme Inc");
		expect(await renameOrg(db(), crypto.randomUUID(), "Ghost")).toBe(false);
	});
});

describe("setMemberRole and countOwners", () => {
	it("promotes, demotes, and counts owners", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), acme.id, bob, "member");
		expect(await countOwners(db(), acme.id)).toBe(1);

		expect(await setMemberRole(db(), acme.id, bob, "owner")).toBe(true);
		expect(await countOwners(db(), acme.id)).toBe(2);

		expect(await setMemberRole(db(), acme.id, bob, "member")).toBe(true);
		expect(await countOwners(db(), acme.id)).toBe(1);
	});

	it("reports a non-member", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		expect(await setMemberRole(db(), acme.id, bob, "owner")).toBe(false);
	});
});

describe("removeMembership", () => {
	it("removes a member, and reports one who was not there", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), acme.id, bob, "member");

		expect(await removeMembership(db(), acme.id, bob)).toBe(true);
		expect(await getMembership(db(), acme.id, bob)).toBeNull();
		expect(await removeMembership(db(), acme.id, bob)).toBe(false);
	});
});
