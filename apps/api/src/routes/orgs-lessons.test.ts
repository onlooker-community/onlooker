import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { blockAuthor } from "../db/author-blocks.js";
import { createLessonsWithFeed, probeLessonId } from "../db/lessons.js";
import {
	addMembership,
	createOrgWithOwner,
	removeMembership,
} from "../db/orgs.js";
import { deleteUser } from "../db/queries.js";
import { errorHandler } from "../middleware/error.js";
import { BASE, lesson, resetLessonCounter } from "../test-support/lessons.js";
import {
	call,
	resetOrgTables,
	type SignedUpUser,
	signup,
} from "../test-support/orgs.js";
import { ApiError, type WorkerEnv } from "../types";
import { handleRetractOrgLesson } from "./orgs-lessons.js";

const db = () => env.DB;
const REAL_ENV = env as unknown as WorkerEnv;

// Same string the sibling retracts' own failure tests use
// (routes/lessons-push-failure.test.ts) - the real wrapped form D1 emits for
// a lesson_feed sequence collision.
const SEQ_COLLISION =
	"D1_ERROR: UNIQUE constraint failed: lesson_feed.user_id, lesson_feed.seq: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)";

/**
 * The real binding, with db.batch() failing the way D1 can under sustained
 * contention. Same idiom as routes/lessons-push-failure.test.ts, which is the
 * only place in this suite that already forces SequenceExhaustedError through
 * a route handler - neither admin-moderation.test.ts nor
 * lessons-browser.test.ts has a 503 test of its own to follow instead.
 */
function batchFailsWith(error: Error): WorkerEnv {
	const broken = new Proxy(REAL_ENV.DB, {
		get(target, property, receiver) {
			if (property === "batch") return () => Promise.reject(error);
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as D1Database;

	return { ...REAL_ENV, DB: broken };
}

let owner: SignedUpUser;
let member: SignedUpUser;
let stranger: SignedUpUser;
let orgId: string;
let sharedId: string;

/** Write a lesson shared with `orgId`, authored by `userId`. Bypasses push. */
async function seedOrgLesson(userId: string, orgId: string): Promise<TLesson> {
	const written = lesson({ visibility: "org" }) as TLesson;
	await createLessonsWithFeed(db(), userId, [written], orgId);
	return written;
}

/** The ids GET /api/lessons returns to this token. */
async function browse(token: string): Promise<string[]> {
	const response = await call("/api/lessons", token);
	const body = (await response.json()) as { lessons: { id: string }[] };
	return body.lessons.map((l) => l.id);
}

beforeEach(async () => {
	await resetOrgTables();
	// resetOrgTables deliberately does not touch these two tables - see its
	// doc comment - so this suite, the one org suite that seeds a lesson,
	// clears them itself, the same way db/lessons.test.ts and
	// db/pool.test.ts do.
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	resetLessonCounter();

	owner = await signup("owner@example.com");
	member = await signup("member@example.com");
	stranger = await signup("stranger@example.com");

	const created = await call("/api/orgs", owner.token, {
		method: "POST",
		body: JSON.stringify({ name: "Acme" }),
	});
	orgId = ((await created.json()) as { org: { id: string } }).org.id;
	await addMembership(db(), orgId, member.id, "member");

	// Authored by the MEMBER, not the owner - the whole point of this route
	// is an owner retracting a lesson that is not theirs.
	sharedId = (await seedOrgLesson(member.id, orgId)).id;
});

describe("POST /api/orgs/:id/lessons/:lessonId/retract", () => {
	it("lets an owner retract a lesson shared with their org", async () => {
		const response = await call(
			`/api/orgs/${orgId}/lessons/${sharedId}/retract`,
			owner.token,
			{ method: "POST" },
		);

		expect(response.status).toBe(200);
		// Matches the retract family's shape (handleOperatorRetract,
		// admin-moderation.ts:35), the closest relative.
		expect(await response.json()).toEqual({
			id: sharedId,
			seq: expect.any(Number),
			status: "retracted",
		});
		expect((await probeLessonId(db(), sharedId))?.status).toBe("retracted");
	});

	it("refuses a member", async () => {
		const response = await call(
			`/api/orgs/${orgId}/lessons/${sharedId}/retract`,
			member.token,
			{ method: "POST" },
		);

		expect(response.status).toBe(404);
		expect((await probeLessonId(db(), sharedId))?.status).toBe("active");
	});

	it("refuses an owner of another org", async () => {
		const other = await createOrgWithOwner(db(), "Beta", stranger.id);

		const response = await call(
			`/api/orgs/${other.id}/lessons/${sharedId}/retract`,
			stranger.token,
			{ method: "POST" },
		);

		expect(response.status).toBe(404);
		expect((await probeLessonId(db(), sharedId))?.status).toBe("active");
	});

	it("404s a lesson id that does not exist, indistinguishably", async () => {
		const response = await call(
			`/api/orgs/${orgId}/lessons/01NOPE00000000000000000000/retract`,
			owner.token,
			{ method: "POST" },
		);

		expect(response.status).toBe(404);
	});

	it("keeps the org's access when the author leaves, and ends the author's", async () => {
		// D6, observed. The predicate never consults the AUTHOR's membership -
		// only the reader's - so surviving a departure is the only thing it can
		// do. Asserted anyway: it is the decision most likely to be "fixed" in
		// the wrong direction by someone who reads the org disjunct and assumes
		// both sides must be members.
		//
		// Here rather than in db/pool.test.ts because this suite already
		// manipulates memberships, and because the two halves have to be seen
		// together: the lesson stays readable, and the departed author stops
		// reading the org's others.
		const authored = await seedOrgLesson(member.id, orgId);
		const byOwner = await seedOrgLesson(owner.id, orgId);

		await db()
			.prepare("DELETE FROM org_memberships WHERE org_id = ? AND user_id = ?")
			.bind(orgId, member.id)
			.run();

		const ownerSees = await browse(owner.token);
		const departedSees = await browse(member.token);

		expect(ownerSees).toContain(authored.id);
		expect(departedSees).not.toContain(byOwner.id);
		// Their own lesson is still theirs to see - through `user_id = ?`,
		// not through the org disjunct.
		expect(departedSees).toContain(authored.id);
	});
});

describe("POST /api/orgs/:id/lessons/:lessonId/retract when the write fails", () => {
	// Calls the handler directly rather than through SELF, the same way
	// routes/lessons-push-failure.test.ts does and for the same reason:
	// sustained sequence contention is a D1 failure, and there is no request
	// through the worker that provokes one. That file is the only existing
	// precedent for forcing SequenceExhaustedError through a route handler -
	// neither admin-moderation.test.ts nor lessons-browser.test.ts has a 503
	// test of its own for their equivalent retracts, so this follows
	// lessons-push-failure.test.ts's idiom instead.
	it("answers 503 for sustained sequence contention, like the sibling retracts", async () => {
		const thrown = await handleRetractOrgLesson(
			new Request(`${BASE}/api/orgs/${orgId}/lessons/${sharedId}/retract`, {
				method: "POST",
			}),
			batchFailsWith(new Error(SEQ_COLLISION)),
			{ id: orgId, lessonId: sharedId },
			{ userId: owner.id },
		).then(
			() => null,
			(error: unknown) => error,
		);

		expect(thrown).toBeInstanceOf(ApiError);
		expect((thrown as ApiError).status).toBe(503);
		expect(errorHandler(thrown).status).toBe(503);
	});

	it("writes nothing at all when it gives up", async () => {
		await handleRetractOrgLesson(
			new Request(`${BASE}/api/orgs/${orgId}/lessons/${sharedId}/retract`, {
				method: "POST",
			}),
			batchFailsWith(new Error(SEQ_COLLISION)),
			{ id: orgId, lessonId: sharedId },
			{ userId: owner.id },
		).catch(() => {});

		expect((await probeLessonId(db(), sharedId))?.status).toBe("active");
	});
});

describe("deleting the org the lesson was shared with", () => {
	it("leaves the lesson readable by its author and by nobody else", async () => {
		// Both can read it to begin with: the member wrote it, the owner
		// reaches it through the org.
		expect(await browse(member.token)).toContain(sharedId);
		expect(await browse(owner.token)).toContain(sharedId);

		// The org can only be deleted by its sole member, so the member goes
		// first. Leaving does not unshare the lesson - that is ONL-12's
		// design - so the lesson is still visibility 'org' here.
		await removeMembership(db(), orgId, member.id);

		const deleted = await call(`/api/orgs/${orgId}`, owner.token, {
			method: "DELETE",
		});
		expect(deleted.status).toBe(200);

		// The claim this describe block is named for: ON DELETE SET NULL
		// actually fired on this row. Without this, the two browse() assertions
		// below pass for an unrelated reason - see the comment above them - and
		// would do so even with org_id left dangling at the deleted org's id.
		expect((await probeLessonId(db(), sharedId))?.org_id).toBeNull();

		// lessons.org_id is ON DELETE SET NULL, and visibilityPredicate pushes
		// `user_id = ?` as its own disjunct, so the author keeps it...
		expect(await browse(member.token)).toContain(sharedId);
		// ...while `org_id IN (...)` is never true for NULL, so the former
		// owner does not. This pair is the whole reason the route needs no
		// lesson handling of its own.
		expect(await browse(owner.token)).not.toContain(sharedId);
	});
});

describe("after the author's account is gone", () => {
	it("an owner can still retract the lesson they left behind", async () => {
		// The member authored sharedId and shared it with the org. Promote the
		// owner's co-ownership first so deleting the member is not refused for
		// a reason unrelated to this test - the member is a plain member here,
		// so nothing blocks it, but assert the outcome rather than assuming.
		expect(await deleteUser(db(), member.id)).toBe("anonymized");

		const response = await call(
			`/api/orgs/${orgId}/lessons/${sharedId}/retract`,
			owner.token,
			{ method: "POST" },
		);

		// A 500 here is the failure mode to watch for: transitionLesson
		// allocates MAX(seq)+1 for the AUTHOR's feed and inserts under their
		// user_id, so an author whose row was deleted rather than anonymized
		// would make this violate a foreign key.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ status: "retracted" });
	});

	it("and a block on that author still applies", async () => {
		// lesson_author_blocks keys on author_key, not user_id, so a blocked
		// author cannot evade a block by deleting their account. Anonymization
		// must preserve that, and it does so only because author_key lives on
		// the lesson row rather than being resolved through users.
		// probeLessonId's StoredLesson does not select author_key - it is a
		// column on the row (createLessonsWithFeed writes it alongside body,
		// never through it), so this reads the column directly rather than
		// through the JSON body.
		const authorKey = (
			await db()
				.prepare("SELECT author_key FROM lessons WHERE id = ?")
				.bind(sharedId)
				.first<{ author_key: string }>()
		)?.author_key;
		await blockAuthor(db(), authorKey ?? "", "ONL-136 check", owner.id);

		expect(await deleteUser(db(), member.id)).toBe("anonymized");

		const page = await call("/api/lessons", owner.token);
		const body = (await page.json()) as { lessons: { id: string }[] };
		expect(body.lessons.map((l) => l.id)).not.toContain(sharedId);
	});
});
