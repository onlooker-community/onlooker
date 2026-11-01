import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createLessonsWithFeed } from "../db/lessons.js";
import { createMachineToken } from "../db/machine-tokens.js";
import { addMembership, removeMembership } from "../db/orgs.js";
import { getUserById } from "../db/queries.js";
import { putSessionSummaries } from "../db/session-summaries.js";
import { lesson, resetLessonCounter } from "../test-support/lessons.js";
import {
	call,
	resetOrgTables,
	type SignedUpUser,
	signup,
} from "../test-support/orgs.js";
import { ApiError, type WorkerEnv } from "../types";
import { handleDeleteAccount } from "./account.js";

// DELETE /auth/account used to be unconditional, and org_memberships cascades
// from users, so the sole owner of an org could delete their account and leave
// it with zero owners. Every owner route requires an owner to already exist -
// including the lesson retract added by ONL-141 - so that org could never be
// administered or moderated from the inside again. ONL-136.
//
// The guard itself is pinned at the primitive in db/orgs.test.ts, beside the
// other two paths to zero owners. These cover what the caller is told.

const db = () => env.DB;
const REAL_ENV = env as unknown as WorkerEnv;
let ada: SignedUpUser;
let bob: SignedUpUser;

beforeEach(async () => {
	await resetOrgTables();
	// resetOrgTables deliberately does not touch these two tables - see its
	// doc comment - so this suite, which now seeds a lesson, clears them
	// itself, the same way routes/orgs-lessons.test.ts does.
	await db().prepare("DELETE FROM session_projects").run();
	await db().prepare("DELETE FROM session_summaries").run();
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	resetLessonCounter();

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

	// session_projects cascades from users and from session_summaries; this
	// pins that deleting the account really leaves none of its project rows.
	it("deletes the account's session_projects rows", async () => {
		const machine = await createMachineToken(db(), ada.id, "laptop");
		await putSessionSummaries(db(), ada.id, machine.id, [
			{
				session_id: "s1",
				started_at: "2026-01-01T00:00:00.000Z",
				ended_at: null,
				event_count: 10,
				counts_by_prefix: { tool: 10 },
				counts_by_project: {
					aaaaaaaaaaaa: { basis: "remote", event_count: 7 },
				},
				plugins: [],
				prompts: 1,
				compactions: 0,
			},
		]);
		const count = async () =>
			(
				await db()
					.prepare("SELECT COUNT(*) AS n FROM session_projects")
					.first<{ n: number }>()
			)?.n;
		expect(await count()).toBe(1);

		const response = await deleteAccount(ada.token);

		expect(response.status).toBe(200);
		expect(await count()).toBe(0);
	});

	it("deletes the account once the sole-owned org is deleted", async () => {
		const orgId = await createOrg(ada.token, "Solo");
		expect((await deleteAccount(ada.token)).status).toBe(409);

		// The way out #198 left for an owner with no one to promote. Without
		// this route that 409 is unfollowable and the account is undeletable.
		const removed = await call(`/api/orgs/${orgId}`, ada.token, {
			method: "DELETE",
		});
		expect(removed.status).toBe(200);

		const response = await deleteAccount(ada.token);

		expect(response.status).toBe(200);
		expect(await getUserById(db(), ada.id)).toBeNull();
	});

	it("reports success when the account is anonymized rather than deleted", async () => {
		const orgId = await createOrg(ada.token, "Acme");
		await addMembership(db(), orgId, bob.id, "owner");
		await createLessonsWithFeed(
			db(),
			ada.id,
			[lesson({ visibility: "org" }) as TLesson],
			orgId,
		);

		const response = await deleteAccount(ada.token);

		// The caller cannot tell the two paths apart, by design.
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true });
	});

	it("still answers 409 when a demotion races the anonymize batch", async () => {
		// Calls the handler directly rather than through SELF, the same way
		// routes/orgs-lessons.test.ts forces its own batch failure: there is no
		// request through the worker that can land a write between deleteUser's
		// reads and its batch, so this injects it at the binding instead.
		const orgId = await createOrg(ada.token, "Acme");
		await addMembership(db(), orgId, bob.id, "owner");
		await createLessonsWithFeed(
			db(),
			ada.id,
			[lesson({ visibility: "org" }) as TLesson],
			orgId,
		);

		const racing = new Proxy(db(), {
			get(target, property, receiver) {
				if (property === "batch") {
					return async (statements: unknown[]) => {
						await removeMembership(db(), orgId, bob.id);
						return (target as D1Database).batch(
							statements as Parameters<D1Database["batch"]>[0],
						);
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as D1Database;

		const thrown = await handleDeleteAccount(
			new Request("https://api.onlooker.dev/auth/account", {
				method: "DELETE",
			}),
			{ ...REAL_ENV, DB: racing },
			{},
			{ userId: ada.id },
		).then(
			() => null,
			(error: unknown) => error,
		);

		// The UPDATE's own guard refused - the account is untouched and the org
		// still needs an owner - so the caller gets the same refusal they would
		// have gotten a moment earlier, not the 200 a call that merely checked
		// the row would wrongly report.
		expect(thrown).toBeInstanceOf(ApiError);
		expect((thrown as ApiError).status).toBe(409);
		expect((thrown as ApiError).code).toBe("sole_owner");
		expect(await getUserById(db(), ada.id)).not.toBeNull();
	});
});

describe("what a deleted account's credentials can do afterward", () => {
	// Nothing, by either route out of deleteUser, and the mechanism is pinned
	// at the middleware in middleware/principal.test.ts. These two cover the
	// answer the CALLER gets, through the real delete endpoint, because that is
	// the thing ONL-146 measured against production: a 200 where the system's
	// own documentation implied 401.
	it("stops authenticating, and cannot refresh", async () => {
		const response = await deleteAccount(ada.token);
		expect(response.status).toBe(200);

		// Both halves of the pair, in one test on purpose. The access token
		// stops because resolvePrincipal reads the row; the refresh token stops
		// because sessions cascade. Asserting only the second is what the
		// cascade test in db/queries.test.ts does, and on its own it cannot
		// tell a closed window from an open one.
		const after = await call("/api/orgs", ada.token);
		expect(after.status).toBe(401);

		const refresh = await call("/auth/refresh", null, {
			method: "POST",
			body: JSON.stringify({ refreshToken: ada.refreshToken }),
		});
		expect(refresh.status).toBe(401);
	});

	it("stops authenticating after an anonymizing deletion too", async () => {
		// The other branch of deleteUser. An account holding an org-shared
		// lesson is anonymized rather than deleted - the users row survives as
		// the lesson's anchor - so this path was already refused by ONL-136
		// while the branch above was not. Kept beside it so the two cannot
		// drift apart again.
		//
		// bob owns the org, so ada is a member rather than a sole owner and the
		// delete is not refused with 409 - it takes the anonymize path instead.
		const orgId = await createOrg(bob.token, "Globex");
		await addMembership(db(), orgId, ada.id, "member");
		await createLessonsWithFeed(
			db(),
			ada.id,
			[lesson({ visibility: "org" }) as TLesson],
			orgId,
		);

		const response = await deleteAccount(ada.token);
		expect(response.status).toBe(200);

		const after = await call("/api/orgs", ada.token);
		expect(after.status).toBe(401);
	});
});
