import { env, SELF } from "cloudflare:test";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createLessonsWithFeed } from "../db/lessons.js";
import { createUser } from "../db/queries.js";
import {
	BASE,
	lesson,
	resetLessonCounter,
	TEST_PASSWORD,
} from "../test-support/lessons.js";

const db = () => env.DB;
let owner: string;
let operatorToken: string;
let ordinaryToken: string;

async function signup(email: string): Promise<{ id: string; token: string }> {
	const response = await SELF.fetch(`${BASE}/auth/signup`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password: TEST_PASSWORD, name: "Ada" }),
	});
	const body = (await response.json()) as {
		token: string;
		user: { id: string };
	};
	return { id: body.user.id, token: body.token };
}

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_author_blocks").run();
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM users").run();
	resetLessonCounter();

	const operator = await signup("operator@example.com");
	const ordinary = await signup("ordinary@example.com");
	operatorToken = operator.token;
	ordinaryToken = ordinary.token;
	owner = (await createUser(db(), "owner@example.com", "hash", "Bob")).id;

	// The env var the operator check reads. Operator authority is env-driven
	// rather than a DB column so granting it is a deploy somebody reviews.
	(env as { OPERATOR_USER_IDS?: string }).OPERATOR_USER_IDS = operator.id;
});

async function seed(overrides: Record<string, unknown>): Promise<TLesson> {
	const written = lesson(overrides) as TLesson;
	await createLessonsWithFeed(db(), owner, [written]);
	return written;
}

const authed = (token: string) => ({ Authorization: `Bearer ${token}` });
const asJson = (token: string) => ({
	...authed(token),
	"Content-Type": "application/json",
});

const retract = (id: string, token: string) =>
	SELF.fetch(`${BASE}/api/admin/lessons/${id}/retract`, {
		method: "POST",
		headers: authed(token),
	});

describe("POST /api/admin/lessons/:id/retract", () => {
	it("retracts a lesson the operator does not own", async () => {
		const pub = await seed({ visibility: "public" });

		const response = await retract(pub.id, operatorToken);

		expect(response.status).toBe(200);
		const row = await db()
			.prepare("SELECT status FROM lessons WHERE id = ?")
			.bind(pub.id)
			.first<{ status: string }>();
		expect(row?.status).toBe("retracted");
	});

	it("stops serving it anonymously", async () => {
		const pub = await seed({ visibility: "public" });
		await retract(pub.id, operatorToken);

		const read = await SELF.fetch(`${BASE}/api/public/lessons/${pub.id}`);

		expect(read.status).toBe(404);
	});

	it("404s for a signed-in non-operator, confirming nothing", async () => {
		const pub = await seed({ visibility: "public" });

		expect((await retract(pub.id, ordinaryToken)).status).toBe(404);
	});

	it("401s with no credential", async () => {
		const pub = await seed({ visibility: "public" });

		const response = await SELF.fetch(
			`${BASE}/api/admin/lessons/${pub.id}/retract`,
			{ method: "POST" },
		);

		expect(response.status).toBe(401);
	});
});

describe("author blocks", () => {
	const KEY = "9".repeat(32);

	const blockRequest = (body: unknown, token: string) =>
		SELF.fetch(`${BASE}/api/admin/author-blocks`, {
			method: "POST",
			headers: asJson(token),
			body: JSON.stringify(body),
		});

	const unblockRequest = (key: string, token: string) =>
		SELF.fetch(`${BASE}/api/admin/author-blocks/${key}`, {
			method: "DELETE",
			headers: authed(token),
		});

	it("stops serving every public lesson from a blocked key", async () => {
		const pub = await seed({ visibility: "public", author_key: KEY });

		// The pre-block fetch is the test's own positive control: without it,
		// a 404 below could have any cause, and this test would only prove
		// anything in combination with "serves it again after an unblock".
		expect(
			(await SELF.fetch(`${BASE}/api/public/lessons/${pub.id}`)).status,
		).toBe(200);

		const blocked = await blockRequest(
			{ author_key: KEY, reason: "injection" },
			operatorToken,
		);

		expect(blocked.status).toBe(200);
		expect(
			(await SELF.fetch(`${BASE}/api/public/lessons/${pub.id}`)).status,
		).toBe(404);
	});

	it("serves it again after an unblock", async () => {
		const pub = await seed({ visibility: "public", author_key: KEY });
		await blockRequest({ author_key: KEY, reason: "mistake" }, operatorToken);

		const unblocked = await unblockRequest(KEY, operatorToken);

		expect(unblocked.status).toBe(200);
		expect(
			(await SELF.fetch(`${BASE}/api/public/lessons/${pub.id}`)).status,
		).toBe(200);
	});

	it("rejects a key that is not 32 hex characters", async () => {
		const response = await blockRequest(
			{ author_key: "nope", reason: "typo" },
			operatorToken,
		);

		expect(response.status).toBe(400);
	});

	it("requires a reason, so a block can be reviewed later", async () => {
		const response = await blockRequest(
			{ author_key: KEY, reason: "   " },
			operatorToken,
		);

		expect(response.status).toBe(400);
	});

	it("records who blocked and why", async () => {
		await blockRequest({ author_key: KEY, reason: "injection" }, operatorToken);

		const row = await db()
			.prepare(
				"SELECT reason, blocked_by FROM lesson_author_blocks WHERE author_key = ?",
			)
			.bind(KEY)
			.first<{ reason: string; blocked_by: string }>();

		expect(row?.reason).toBe("injection");
		expect(row?.blocked_by).not.toBe("");
	});

	it("404s an unblock of a key that was never blocked", async () => {
		expect((await unblockRequest(KEY, operatorToken)).status).toBe(404);
	});

	it("404s a block from a signed-in non-operator, confirming nothing", async () => {
		const response = await blockRequest(
			{ author_key: KEY, reason: "injection" },
			ordinaryToken,
		);

		expect(response.status).toBe(404);
		expect(
			await db()
				.prepare("SELECT 1 FROM lesson_author_blocks WHERE author_key = ?")
				.bind(KEY)
				.first(),
		).toBeNull();
	});

	it("404s an unblock from a signed-in non-operator, confirming nothing", async () => {
		await blockRequest({ author_key: KEY, reason: "injection" }, operatorToken);

		expect((await unblockRequest(KEY, ordinaryToken)).status).toBe(404);
		expect(
			await db()
				.prepare("SELECT 1 FROM lesson_author_blocks WHERE author_key = ?")
				.bind(KEY)
				.first(),
		).not.toBeNull();
	});

	it("does not error when blocking an already-blocked key, and updates the reason", async () => {
		await blockRequest(
			{ author_key: KEY, reason: "first report" },
			operatorToken,
		);

		const second = await blockRequest(
			{ author_key: KEY, reason: "second report" },
			operatorToken,
		);

		expect(second.status).toBe(200);
		const row = await db()
			.prepare("SELECT reason FROM lesson_author_blocks WHERE author_key = ?")
			.bind(KEY)
			.first<{ reason: string }>();
		expect(row?.reason).toBe("second report");
	});
});
