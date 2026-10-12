import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createLessonsWithFeed } from "../db/lessons.js";
import { addMembership, removeMembership } from "../db/orgs.js";
import { getUserById } from "../db/queries.js";
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
