import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addMembership, createOrgWithOwner } from "../db/orgs.js";
import { createUser } from "../db/queries.js";
import { resetOrgTables } from "../test-support/orgs.js";
import { ApiError } from "../types";
import { requireOrgRole } from "./authorize.js";

const db = () => env.DB;
let ada: string;
let bob: string;

beforeEach(async () => {
	await resetOrgTables();
	ada = (await createUser(db(), "ada@example.com", "hash", "Ada")).id;
	bob = (await createUser(db(), "bob@example.com", "hash", "Bob")).id;
});

describe("requireOrgRole", () => {
	it("returns the caller's role when it suffices", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		expect(await requireOrgRole(db(), { userId: ada }, acme.id, "owner")).toBe(
			"owner",
		);
		expect(await requireOrgRole(db(), { userId: ada }, acme.id, "member")).toBe(
			"owner",
		);
	});

	it("404s a non-member rather than confirming the org exists", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		await expect(
			requireOrgRole(db(), { userId: bob }, acme.id, "member"),
		).rejects.toMatchObject({ status: 404 });
	});

	it("404s a plain member asked for owner authority", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), acme.id, bob, "member");
		await expect(
			requireOrgRole(db(), { userId: bob }, acme.id, "owner"),
		).rejects.toMatchObject({ status: 404 });
	});

	it("404s an org that does not exist", async () => {
		await expect(
			requireOrgRole(db(), { userId: ada }, crypto.randomUUID(), "member"),
		).rejects.toBeInstanceOf(ApiError);
	});

	it("404s a null principal", async () => {
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		await expect(
			requireOrgRole(db(), null, acme.id, "member"),
		).rejects.toMatchObject({ status: 404 });
	});

	it("is byte-identical across every refusal", async () => {
		// A non-member must not be able to tell an org they cannot see from one
		// that does not exist. Comparing the messages is the only way to notice
		// a later edit that makes one of them more specific.
		const acme = await createOrgWithOwner(db(), "Acme", ada);
		const refusals = await Promise.all([
			requireOrgRole(db(), { userId: bob }, acme.id, "member").catch(
				(error: ApiError) => `${error.status} ${error.code} ${error.message}`,
			),
			requireOrgRole(
				db(),
				{ userId: bob },
				crypto.randomUUID(),
				"member",
			).catch(
				(error: ApiError) => `${error.status} ${error.code} ${error.message}`,
			),
		]);
		expect(refusals[0]).toBe(refusals[1]);
	});
});
