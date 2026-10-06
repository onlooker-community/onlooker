import { env } from "cloudflare:test";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createLessonsWithFeed, probeLessonId } from "../db/lessons.js";
import { addMembership, createOrgWithOwner } from "../db/orgs.js";
import { lesson, resetLessonCounter } from "../test-support/lessons.js";
import {
	call,
	resetOrgTables,
	type SignedUpUser,
	signup,
} from "../test-support/orgs.js";

const db = () => env.DB;

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
