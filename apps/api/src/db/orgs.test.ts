import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetOrgTables } from "../test-support/orgs.js";
import { createInvite } from "./org-invites.js";
import {
	addMembership,
	countOwners,
	createOrgWithOwner,
	getMembership,
	listMembers,
	listOrgsForUser,
	orgIdsForUser,
	removeMembership,
	renameOrg,
	setMemberRole,
	toOrgRole,
} from "./orgs.js";
import { createUser, deleteUser } from "./queries.js";

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

		expect(await setMemberRole(db(), acme.id, bob, "owner")).toBe("ok");
		expect(await countOwners(db(), acme.id)).toBe(2);

		expect(await setMemberRole(db(), acme.id, bob, "member")).toBe("ok");
		expect(await countOwners(db(), acme.id)).toBe(1);
	});

	it("reports a non-member", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		expect(await setMemberRole(db(), acme.id, bob, "owner")).toBe("not_member");
	});
});

describe("removeMembership", () => {
	it("removes a member, and reports one who was not there", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), acme.id, bob, "member");

		expect(await removeMembership(db(), acme.id, bob)).toBe("ok");
		expect(await getMembership(db(), acme.id, bob)).toBeNull();
		expect(await removeMembership(db(), acme.id, bob)).toBe("not_member");
	});
});

describe("the last-owner guard", () => {
	// Calls the primitives directly, bypassing the route handlers entirely.
	// The guard lives in the statement's own WHERE clause now (see db/orgs.ts),
	// so it has to hold here even with no handler-level check in front of it -
	// that is the whole point of moving it.
	it("setMemberRole refuses to demote a sole owner", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		expect(await setMemberRole(db(), acme.id, ada, "member")).toBe(
			"last_owner",
		);
		expect(await getMembership(db(), acme.id, ada)).toEqual({
			role: "owner",
		});
	});

	it("removeMembership refuses to remove a sole owner", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		expect(await removeMembership(db(), acme.id, ada)).toBe("last_owner");
		expect(await getMembership(db(), acme.id, ada)).toEqual({
			role: "owner",
		});
	});

	// The third path into zero owners, and the one that used to get there.
	// removeMembership above refuses, so a last owner cannot *leave* an org -
	// but org_memberships.user_id cascades from users, so deleting the account
	// walked straight past this invariant and left the org ownerless. Since
	// the org lesson tier opened, that is also permanent: every owner route,
	// retract included, requires an owner to already exist (ONL-136).
	it("deleteUser refuses to delete a sole owner's account", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);

		expect(await deleteUser(db(), ada)).toBe("sole_owner");

		expect(await getMembership(db(), acme.id, ada)).toEqual({
			role: "owner",
		});
	});

	// The guard's negative case. Without this a guard that refused every
	// deletion would pass the test above, so this was checked by breaking
	// the WHERE clause to refuse unconditionally and watching it fail.
	it("deleteUser lets an owner go when another owner remains", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), acme.id, bob, "owner");

		expect(await deleteUser(db(), ada)).toBe("ok");

		expect(await getMembership(db(), acme.id, ada)).toBeNull();
		expect(await countOwners(db(), acme.id)).toBe(1);
	});

	// Sole ownership is per-org, so one safe org does not license the
	// deletion. A guard written with EXISTS over "an org with >1 owner"
	// instead of NOT EXISTS over "an org with exactly 1" passes the first
	// test and fails this one.
	it("deleteUser refuses when only one of several orgs is at risk", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), acme.id, bob, "owner");
		const solo = await createOrgWithOwner(db(), "Solo", ada);

		expect(await deleteUser(db(), ada)).toBe("sole_owner");

		expect(await getMembership(db(), solo.id, ada)).toEqual({
			role: "owner",
		});
		expect(await getMembership(db(), acme.id, ada)).toEqual({
			role: "owner",
		});
	});

	// Being a plain member of an org is not ownership and must not block
	// deletion, however few owners that org has.
	it("deleteUser ignores orgs where the account is only a member", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", bob);
		await addMembership(db(), acme.id, ada, "member");

		expect(await deleteUser(db(), ada)).toBe("ok");

		expect(await getMembership(db(), acme.id, ada)).toBeNull();
		expect(await countOwners(db(), acme.id)).toBe(1);
	});

	// Keeps the original contract: the caller's intent was "make it gone",
	// and it is. Reported as "ok" so a real refusal stays distinguishable
	// from a no-op rather than both arriving as the same zero-row result.
	it("deleteUser still reports ok for an account already gone", async () => {
		expect(await deleteUser(db(), ada)).toBe("ok");
		expect(await deleteUser(db(), ada)).toBe("ok");
	});
});

describe("toOrgRole", () => {
	it("returns a recognized role unchanged", () => {
		expect(toOrgRole("owner")).toBe("owner");
		expect(toOrgRole("member")).toBe("member");
	});

	it("throws on anything else, naming the offending value", () => {
		// The column is plain text, so a bad migration or a manual edit can put
		// anything here. Throwing names the data problem instead of handing a
		// caller a value typed as OrgRole that is not one.
		for (const bad of ["admin", "", "Owner", null, undefined, 7]) {
			expect(() => toOrgRole(bad)).toThrow(/Invalid org role/);
		}
	});
});

describe("orgIdsForUser", () => {
	// Reuses the suite's own `ada`/`bob` fixtures from the top-level
	// beforeEach rather than creating fresh users with the same emails,
	// which would collide with it on the UNIQUE(email) index.
	it("returns every org this user belongs to", async () => {
		const a = await createOrgWithOwner(db(), "Acme", ada);
		const b = await createOrgWithOwner(db(), "Beta", ada);

		expect((await orgIdsForUser(db(), ada)).sort()).toEqual(
			[a.id, b.id].sort(),
		);
	});

	it("returns an empty list for a user in no org", async () => {
		expect(await orgIdsForUser(db(), bob)).toEqual([]);
	});

	it("does not return an org the user only has an invite to", async () => {
		// Membership is the predicate's input, and an unaccepted invite is not
		// membership. If this ever returned the invited org, a pending invite
		// would read the org's lessons.
		const org = await createOrgWithOwner(db(), "Acme", ada);
		await createInvite(db(), {
			orgId: org.id,
			email: "bob@example.com",
			role: "member",
			tokenHash: "hash-x",
			expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
			invitedBy: ada,
		});

		expect(await orgIdsForUser(db(), bob)).toEqual([]);
	});
});
