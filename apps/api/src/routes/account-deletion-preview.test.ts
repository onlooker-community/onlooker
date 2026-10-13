import { env } from "cloudflare:test";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createLessonsWithFeed } from "../db/lessons.js";
import { lesson, resetLessonCounter } from "../test-support/lessons.js";
import {
	call,
	resetOrgTables,
	type SignedUpUser,
	signup,
} from "../test-support/orgs.js";

// The panel asks this before it asks for confirmation, so what this answers is
// what somebody decides on. ONL-136.
//
// What the two statements count is pinned at the primitive in
// db/lessons.test.ts. These cover what reaches a caller over HTTP.

const db = () => env.DB;
let ada: SignedUpUser;

interface PreviewBody {
	publicLessons: number;
	orgsKeeping: { id: string; name: string; lessons: number }[];
}

beforeEach(async () => {
	await resetOrgTables();
	// resetOrgTables deliberately leaves these two alone - see its doc comment -
	// and this suite seeds lessons, so it clears them itself.
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	resetLessonCounter();

	ada = await signup("ada@example.com");
});

const preview = (token: string | null) =>
	call("/auth/account/deletion-preview", token);

const createOrg = async (token: string, name: string): Promise<string> => {
	const response = await call("/api/orgs", token, {
		method: "POST",
		body: JSON.stringify({ name }),
	});
	return ((await response.json()) as { org: { id: string } }).org.id;
};

describe("GET /auth/account/deletion-preview", () => {
	it("refuses without a session", async () => {
		expect((await preview(null)).status).toBe(401);
	});

	it("counts the caller's public lessons and names the orgs keeping theirs", async () => {
		const orgId = await createOrg(ada.token, "Acme");
		await createLessonsWithFeed(
			db(),
			ada.id,
			[lesson({ visibility: "public" }) as TLesson],
			null,
		);
		await createLessonsWithFeed(
			db(),
			ada.id,
			[lesson({ visibility: "org" }) as TLesson],
			orgId,
		);

		const response = await preview(ada.token);

		expect(response.status).toBe(200);
		expect((await response.json()) as PreviewBody).toEqual({
			publicLessons: 1,
			orgsKeeping: [{ id: orgId, name: "Acme", lessons: 1 }],
		});
	});

	it("answers zero and empty for an account that has shared nothing", async () => {
		const body = (await (await preview(ada.token)).json()) as PreviewBody;

		expect(body).toEqual({ publicLessons: 0, orgsKeeping: [] });
	});
});
