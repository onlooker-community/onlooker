import { env } from "cloudflare:test";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createLessonsWithFeed } from "../db/lessons.js";
import { addMembership, createOrgWithOwner } from "../db/orgs.js";
import { deleteUser } from "../db/queries.js";
import { lesson, resetLessonCounter } from "../test-support/lessons.js";
import { call, resetOrgTables, signup } from "../test-support/orgs.js";

/**
 * `resolvePrincipal`'s own check, exercised through two real routes rather
 * than by calling it directly - what matters is that neither `auth: "session"`
 * route can act on behalf of an anonymized account, and the quickest way to
 * fool yourself here is to test the middleware in isolation and let a route
 * import something else by accident.
 *
 * ONL-136: deleteUser now has a path where the `users` row survives account
 * deletion, anchoring an org lesson. Before this file, nothing checked
 * `anonymized_at` anywhere in the authenticated request path, so the access
 * token issued before deletion kept authenticating - and kept writing - for
 * up to TOKEN_EXPIRY_MINUTES. See final-review.md finding 1.
 *
 * ONL-146: the same window was open for an ORDINARY deletion, for longer and
 * less visibly. The check added above asked "is this row anonymized", which a
 * missing row answers no, so the half of deleteUser that removes the row
 * outright sailed through it. Both halves are covered here now, deliberately
 * adjacent: the two paths are one intent, and a test for either alone is what
 * let this sit open.
 */

const db = () => env.DB;

beforeEach(async () => {
	await resetOrgTables();
	// resetOrgTables deliberately does not touch these two tables - see its
	// doc comment - so this suite, which seeds a lesson, clears them itself,
	// the same way routes/orgs-lessons.test.ts and account-deletion.test.ts do.
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM machine_tokens").run();
	resetLessonCounter();
});

/**
 * Sign up an account that anonymizes rather than deletes: a member (never an
 * owner, so never a sole owner) of an org it shares a lesson with. Returns
 * the access token issued BEFORE anonymization - the one this suite proves
 * cannot keep acting afterward.
 */
async function anonymizedAccountToken(): Promise<string> {
	const owner = await signup("owner@example.com");
	const departing = await signup("departing@example.com");
	const orgId = (await createOrgWithOwner(db(), "Acme", owner.id)).id;
	await addMembership(db(), orgId, departing.id, "member");
	await createLessonsWithFeed(
		db(),
		departing.id,
		[lesson({ visibility: "org" }) as TLesson],
		orgId,
	);

	expect(await deleteUser(db(), departing.id)).toBe("anonymized");

	return departing.token;
}

describe("an anonymized account's leftover access token", () => {
	it("cannot mint a machine token", async () => {
		const token = await anonymizedAccountToken();

		// The security-critical property the design names: a machine token
		// has no expiry, so minting one after anonymization would be a
		// standing credential for a row nobody can log in as again.
		const response = await call("/api/machines", token, {
			method: "POST",
			body: JSON.stringify({ name: "stolen window" }),
		});

		expect(response.status).toBe(401);
	});

	it("cannot change the account's email", async () => {
		const token = await anonymizedAccountToken();

		// The resurrection chain finding 1 traces: change the email, then
		// forgot-password -> reset-password with no account-state check of
		// its own. Refusing here closes it at the first step.
		const response = await call("/auth/profile", token, {
			method: "PATCH",
			body: JSON.stringify({ email: "resurrected@example.com" }),
		});

		expect(response.status).toBe(401);
	});

	it("still rejects a request with no credential at all, same as before", async () => {
		// Sanity check against a fix that only recognizes the anonymized case
		// and accidentally swallows the ordinary "no token" 401.
		const response = await call("/api/machines", null, {
			method: "POST",
			body: JSON.stringify({ name: "no credential" }),
		});

		expect(response.status).toBe(401);
	});
});

/**
 * Sign up an account that DELETES rather than anonymizes: no org, no shared
 * lesson, so deleteUser removes the row outright. Returns the access token
 * issued before the deletion.
 */
async function deletedAccountToken(): Promise<string> {
	const departing = await signup("departing@example.com");

	expect(await deleteUser(db(), departing.id)).toBe("deleted");

	return departing.token;
}

describe("a deleted account's leftover access token", () => {
	it("cannot mint a machine token", async () => {
		const token = await deletedAccountToken();

		// Same property as the anonymized case above, and it was open for
		// every ordinary deletion until ONL-146: a machine token has no
		// expiry, so minting one afterward is a standing credential for an
		// account that no longer exists.
		const response = await call("/api/machines", token, {
			method: "POST",
			body: JSON.stringify({ name: "stolen window" }),
		});

		expect(response.status).toBe(401);
	});

	it("cannot read the account's orgs", async () => {
		const token = await deletedAccountToken();

		// The exact request ONL-146 measured against production on
		// 2026-10-11, which answered `200 {"orgs":[]}`. An empty list is not a
		// refusal, which is what made this easy to mistake for harmless - the
		// reasoning recorded in resolvePrincipal was that every downstream read
		// would fail on its own, and a read scoped to a vanished user_id does
		// not fail, it matches nothing.
		const response = await call("/api/orgs", token);

		expect(response.status).toBe(401);
	});
});

describe("an ordinary account's access token", () => {
	it("still authenticates: mints a machine token and changes its email", async () => {
		// The other half of the property. A fix that is too eager would make
		// every account look anonymized, and nothing above would notice -
		// every one of its assertions is also satisfied by "auth is broken
		// for everyone".
		const live = await signup("still-here@example.com");

		const minted = await call("/api/machines", live.token, {
			method: "POST",
			body: JSON.stringify({ name: "laptop" }),
		});
		expect(minted.status).toBe(201);

		const updated = await call("/auth/profile", live.token, {
			method: "PATCH",
			body: JSON.stringify({ email: "still-here-2@example.com" }),
		});
		expect(updated.status).toBe(200);
	});
});
