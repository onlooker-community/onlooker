import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addMembership, createOrgWithOwner } from "../db/orgs.js";
import { createUser } from "../db/queries.js";
import { ROUTES } from "../router.js";
import {
	call,
	resetOrgTables,
	type SignedUpUser,
	signup,
} from "../test-support/orgs.js";

const db = () => env.DB;
let ada: string;
let member: SignedUpUser;
let outsider: SignedUpUser;
let orgId: string;

/**
 * Every /api/orgs route, with the role it requires.
 *
 * This table is the guard. A route added to the router without an entry here
 * fails the first test below, which is what stops the next org route from
 * reaching production with no role check at all - RouteAuth cannot express
 * these roles, so nothing else would notice.
 *
 * "argument-dependent" is the one documented exception: DELETE on a member
 * needs owner for somebody else and member for your own id, which is what
 * leaving an org is. Its two cases are pinned in orgs-members.test.ts.
 */
const REQUIRED_ROLE: Record<
	string,
	"owner" | "member" | "argument-dependent" | "none"
> = {
	"POST /api/orgs": "none",
	"GET /api/orgs": "none",
	"PATCH /api/orgs/:id": "owner",
	"GET /api/orgs/:id/members": "member",
	"PATCH /api/orgs/:id/members/:userId": "owner",
	"DELETE /api/orgs/:id/members/:userId": "argument-dependent",
	"POST /api/orgs/:id/invites": "owner",
	"GET /api/orgs/:id/invites": "owner",
	"DELETE /api/orgs/:id/invites/:inviteId": "owner",
	"GET /api/orgs/invites/verify": "none",
	"POST /api/orgs/invites/accept": "none",
};

const orgRoutes = () =>
	ROUTES.filter((route) => route.path.startsWith("/api/orgs"));

beforeEach(async () => {
	await resetOrgTables();
	ada = (await createUser(db(), "ada@example.com", "hash", "Ada")).id;
	member = await signup("member@example.com");
	outsider = await signup("outsider@example.com");
	orgId = (await createOrgWithOwner(db(), "Acme", ada)).id;
	await addMembership(db(), orgId, member.id, "member");
});

/** Fill a route pattern with concrete ids for this fixture. */
function concrete(path: string, targetUserId: string): string {
	return path
		.replace(":inviteId", crypto.randomUUID())
		.replace(":userId", targetUserId)
		.replace(":id", orgId);
}

async function callRoute(
	method: string,
	path: string,
	token: string,
): Promise<number> {
	const init: RequestInit = { method };
	if (method !== "GET" && method !== "DELETE") {
		// A body every handler can parse, so a 400 never masks the 404 this
		// test is looking for.
		init.body = JSON.stringify({
			name: "Probe",
			role: "member",
			email: "probe@example.com",
			token: crypto.randomUUID(),
		});
	}
	return (await call(path, token, init)).status;
}

describe("the org route table", () => {
	it("declares a required role for every /api/orgs route", () => {
		const missing = orgRoutes()
			.map((route) => `${route.method} ${route.path}`)
			.filter((key) => REQUIRED_ROLE[key] === undefined);

		expect(
			missing,
			"Add each new /api/orgs route to REQUIRED_ROLE in this file, then give it a case below. A route with no entry has no role check anybody has verified.",
		).toEqual([]);
	});

	it("has no stale entries", () => {
		const live = new Set(
			orgRoutes().map((route) => `${route.method} ${route.path}`),
		);
		const stale = Object.keys(REQUIRED_ROLE).filter((key) => !live.has(key));
		expect(stale).toEqual([]);
	});

	it('declares cors: "app" on every org route', () => {
		// `auth`'s PRESENCE is deliberately not asserted. router.ts:60-66 says
		// why: it is a required field on the Route interface, so an entry
		// missing it fails to typecheck, and "a test asserting it would only
		// ever pass, which is not evidence of anything." Its VALUE is already
		// enumerated repo-wide by EXPECTED_UNAUTHENTICATED in router.test.ts -
		// Task 8 added the invite-verify route there - so an accidentally
		// unauthenticated org route fails in that test, not this one.
		//
		// `cors` is different: "app" is one of several valid values, so this
		// assertion can fail, and an org route served to any origin would be a
		// real mistake.
		const routes = orgRoutes();
		expect(routes.length).toBeGreaterThan(0);
		for (const route of routes) {
			expect(route.cors, `${route.method} ${route.path}`).toBe("app");
		}
	});
});

describe("a non-member", () => {
	it("gets 404 from every org-scoped route", async () => {
		const scoped = orgRoutes().filter(
			(route) => REQUIRED_ROLE[`${route.method} ${route.path}`] !== "none",
		);
		// A filter that ever matched nothing would make this loop a no-op that
		// still passes - the exact failure mode this file exists to prevent.
		expect(
			scoped.length,
			"expected at least one org-scoped route",
		).toBeGreaterThan(0);

		for (const route of scoped) {
			const status = await callRoute(
				route.method,
				concrete(route.path, ada),
				outsider.token,
			);
			expect(status, `${route.method} ${route.path}`).toBe(404);
		}
	});
});

describe("a plain member", () => {
	it("gets 404 from every owner route", async () => {
		const ownerRoutes = orgRoutes().filter(
			(route) => REQUIRED_ROLE[`${route.method} ${route.path}`] === "owner",
		);
		expect(
			ownerRoutes.length,
			"expected at least one owner route",
		).toBeGreaterThan(0);

		for (const route of ownerRoutes) {
			const key = `${route.method} ${route.path}`;
			const status = await callRoute(
				route.method,
				concrete(route.path, ada),
				member.token,
			);
			expect(status, key).toBe(404);
		}
	});

	it("reaches every member route", async () => {
		const memberRoutes = orgRoutes().filter(
			(route) => REQUIRED_ROLE[`${route.method} ${route.path}`] === "member",
		);
		expect(
			memberRoutes.length,
			"expected at least one member route",
		).toBeGreaterThan(0);

		for (const route of memberRoutes) {
			const key = `${route.method} ${route.path}`;
			const status = await callRoute(
				route.method,
				concrete(route.path, member.id),
				member.token,
			);
			// 200 specifically, not merely "not 404". This is the positive half
			// of the guard - without it the whole suite would pass trivially if
			// requireOrgRole started refusing everybody - and an exact status is
			// the evidence that a member route actually SERVED a member, where
			// not-404 would also be satisfied by a 500.
			expect(status, key).toBe(200);
		}
	});
});
