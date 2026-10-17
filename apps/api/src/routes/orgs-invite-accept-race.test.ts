import { env } from "cloudflare:test";
import type {
	D1Database,
	D1PreparedStatement,
} from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it } from "vitest";
import { isForeignKeyViolation } from "../db/constraints.js";
import { createInvite } from "../db/org-invites.js";
import { addMembership, createOrgWithOwner } from "../db/orgs.js";
import type { Principal } from "../db/pool.js";
import { createUser } from "../db/queries.js";
import { errorHandler } from "../middleware/error.js";
import { BASE } from "../test-support/lessons.js";
import {
	resetOrgTables,
	type SignedUpUser,
	signup,
} from "../test-support/orgs.js";
import { ApiError, type WorkerEnv } from "../types";
import { hashToken } from "../utils/crypto.js";
import { handleAcceptInvite } from "./orgs-invite-accept.js";

/**
 * What an accept is told when the org is deleted underneath it.
 *
 * Calls the handler directly against a proxied binding, the way
 * routes/lessons-push-failure.test.ts does and for the same reason: the window
 * this covers opens between two statements inside ONE request, and no sequence
 * of requests through SELF can open it. Deleting the org before the request
 * cascades the invitation away with it, so the handler refuses at
 * findInviteByTokenHash and never reaches the path under test.
 */
const db = () => env.DB;
const REAL_ENV = env as unknown as WorkerEnv;

let ada: string;
let bob: SignedUpUser;
let orgId: string;

/**
 * The real binding, with the membership insert failing the way D1 fails it.
 *
 * Replaces `run`/`all`/`first` on the membership INSERT only, and re-wraps
 * `bind` because drizzle prepares, binds and only then runs - the statement
 * that actually executes is the one `bind` returned, not the one `prepare` did.
 */
function membershipInsertFailsWith(error: Error): WorkerEnv {
	const rejecting = (statement: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(statement, {
			get(target, property, receiver) {
				if (property === "bind") {
					return (...args: unknown[]) => rejecting(target.bind(...args));
				}
				if (property === "run" || property === "all" || property === "first") {
					// Throws rather than returning Promise.reject(error). A
					// pre-rejected promise is reported as an unhandled
					// rejection by this pool even though drizzle awaits it -
					// the runtime sees the rejection before the awaiting
					// continuation attaches - and vitest warns that unhandled
					// errors can produce false positives. Throwing inside
					// drizzle's own async call makes it that call's rejection,
					// with no second promise to orphan.
					return () => {
						throw error;
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as D1PreparedStatement;

	const broken = new Proxy(REAL_ENV.DB, {
		get(target, property, receiver) {
			if (property === "prepare") {
				return (sql: string) => {
					const statement = target.prepare(sql);
					return /insert\s+into\s+.?org_memberships/i.test(sql)
						? rejecting(statement)
						: statement;
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as D1Database;

	return { ...REAL_ENV, DB: broken };
}

/** Seed an invitation directly, so the test holds the raw token. */
async function seedInvite(email: string): Promise<string> {
	const token = crypto.randomUUID().replace(/-/g, "");
	await createInvite(db(), {
		orgId,
		email,
		role: "member",
		tokenHash: await hashToken(token),
		expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
		invitedBy: ada,
	});
	return token;
}

function acceptRequest(token: string): Request {
	return new Request(`${BASE}/api/orgs/invites/accept`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token }),
	});
}

/** Run a handler and hand back whatever it threw, if anything. */
async function thrownBy(work: Promise<Response>): Promise<unknown> {
	return work.then(
		() => null,
		(error) => error,
	);
}

beforeEach(async () => {
	await resetOrgTables();
	ada = (await createUser(db(), "ada@example.com", "hash", "Ada")).id;
	bob = await signup("bob@example.com", "Bob");
	orgId = (await createOrgWithOwner(db(), "Acme", ada)).id;
});

describe("isForeignKeyViolation", () => {
	// Pins the matcher against what D1 ACTUALLY throws rather than against a
	// string this file made up. Without this case, the injected error below
	// would prove only that the handler maps the error it was handed - true
	// even if D1 worded a real violation differently and the catch never fired
	// in production.
	it("recognizes a real D1 foreign-key failure", async () => {
		const error = await addMembership(
			db(),
			"no-such-org",
			bob.id,
			"member",
		).then(
			() => null,
			(thrown: unknown) => thrown,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/FOREIGN KEY constraint failed/i);
		expect(isForeignKeyViolation(error)).toBe(true);
	});

	it("does not match a unique violation", () => {
		expect(
			isForeignKeyViolation(
				new Error("D1_ERROR: UNIQUE constraint failed: lesson_feed.seq"),
			),
		).toBe(false);
	});
});

describe("POST /api/orgs/invites/accept when the org is deleted mid-request", () => {
	it("answers 400 invalid_invitation rather than 500", async () => {
		const token = await seedInvite("bob@example.com");
		const principal: Principal = { userId: bob.id };

		const error = await thrownBy(
			handleAcceptInvite(
				acceptRequest(token),
				membershipInsertFailsWith(
					new Error(
						"D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT",
					),
				),
				{},
				principal,
			),
		);

		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(400);
		expect((error as ApiError).code).toBe("invalid_invitation");
		// The mapped response too, not only the thrown class - the same pair
		// routes/lessons-push-failure.test.ts asserts, because a thrown
		// ApiError nobody maps is still a 500 to the caller.
		expect(errorHandler(error).status).toBe(400);
	});

	it("lets any other write failure surface as itself", async () => {
		// The catch is scoped to one statement AND one error class on purpose:
		// an unscoped catch would report a disk error as a bad invitation.
		const token = await seedInvite("bob@example.com");
		const principal: Principal = { userId: bob.id };
		const disk = new Error("D1_ERROR: database is locked");

		const error = await thrownBy(
			handleAcceptInvite(
				acceptRequest(token),
				membershipInsertFailsWith(disk),
				{},
				principal,
			),
		);

		expect(error).toBe(disk);
	});
});
