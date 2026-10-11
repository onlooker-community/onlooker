import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addMembership } from "../db/orgs.js";
import { getUserById } from "../db/queries.js";
import {
	call,
	resetOrgTables,
	type SignedUpUser,
	signup,
} from "../test-support/orgs.js";

// DELETE /auth/account used to be unconditional, and org_memberships cascades
// from users, so the sole owner of an org could delete their account and leave
// it with zero owners. Every owner route requires an owner to already exist -
// including the lesson retract added by ONL-141 - so that org could never be
// administered or moderated from the inside again. ONL-136.
//
// The guard itself is pinned at the primitive in db/orgs.test.ts, beside the
// other two paths to zero owners. These cover what the caller is told.

const db = () => env.DB;
let ada: SignedUpUser;
let bob: SignedUpUser;

beforeEach(async () => {
	await resetOrgTables();
	ada = await signup("ada@example.com");
	bob = await signup("bob@example.com");
});

const deleteAccount = (token: string) =>
	call("/auth/account", token, { method: "DELETE" });

const createOrg = async (token: string, name: string): Promise<string> => {
	const response = await call("/api/orgs", token, {
		method: "POST",
		body: JSON.stringify({ name }),
	});
	return ((await response.json()) as { org: { id: string } }).org.id;
};

interface ErrorBody {
	success: false;
	error: { code: string; message: string; details?: unknown };
}

describe("DELETE /auth/account when the account owns orgs", () => {
	it("refuses with 409 and names the orgs, leaving the account intact", async () => {
		await createOrg(ada.token, "Acme");

		const response = await deleteAccount(ada.token);

		expect(response.status).toBe(409);
		const body = (await response.json()) as ErrorBody;
		expect(body.error.code).toBe("sole_owner");
		// Naming them is the point. A bare refusal leaves somebody who owns
		// several orgs guessing which one is blocking their deletion, with no
		// route that would tell them.
		expect(JSON.stringify(body.error.details)).toContain("Acme");
		expect(await getUserById(db(), ada.id)).not.toBeNull();
	});

	it("names only the org that is actually blocking the deletion", async () => {
		const shared = await createOrg(ada.token, "Shared");
		await addMembership(db(), shared, bob.id, "owner");
		await createOrg(ada.token, "Solo");

		const response = await deleteAccount(ada.token);

		expect(response.status).toBe(409);
		const details = JSON.stringify(
			((await response.json()) as ErrorBody).error.details,
		);
		// Listing an org the user co-owns would send them to promote somebody
		// who is already an owner there, which fixes nothing.
		expect(details).toContain("Solo");
		expect(details).not.toContain("Shared");
	});

	it("deletes the account once another owner exists", async () => {
		const orgId = await createOrg(ada.token, "Acme");
		await addMembership(db(), orgId, bob.id, "owner");

		const response = await deleteAccount(ada.token);

		expect(response.status).toBe(200);
		expect(await getUserById(db(), ada.id)).toBeNull();
	});

	it("deletes an account that owns nothing", async () => {
		const response = await deleteAccount(ada.token);

		expect(response.status).toBe(200);
		expect(await getUserById(db(), ada.id)).toBeNull();
	});
});
