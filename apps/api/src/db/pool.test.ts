import { env } from "cloudflare:test";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { lesson, resetLessonCounter } from "../test-support/lessons.js";
import { createLessonsWithFeed } from "./lessons.js";
import { MAX_ORG_MEMBERS_BOUND, readPool, readPoolLesson } from "./pool.js";
import { createUser } from "./queries.js";

const db = () => env.DB;

let mine: string;
let theirs: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_author_blocks").run();
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM users").run();
	mine = (await createUser(db(), "mine@example.com", "hash", "Ada")).id;
	theirs = (await createUser(db(), "theirs@example.com", "hash", "Bob")).id;
	resetLessonCounter();
});

/**
 * Seed one lesson owned by `owner`.
 *
 * Bypasses push, which still rejects every non-private tier - that gate is
 * deliberately untouched by this plan, so the read path has to be testable
 * without it.
 */
async function seedFor(
	owner: string,
	overrides: Record<string, unknown>,
): Promise<TLesson> {
	const written = lesson(overrides) as TLesson;
	await createLessonsWithFeed(db(), owner, [written]);
	return written;
}

async function block(authorKey: string): Promise<void> {
	await db()
		.prepare(
			`INSERT INTO lesson_author_blocks (author_key, reason, blocked_by)
			 VALUES (?, 'injection', 'operator-1')`,
		)
		.bind(authorKey)
		.run();
}

const idsIn = (page: { lessons: unknown[] }) =>
	(page.lessons as Array<{ id: string }>).map((l) => l.id);

describe("readPool, anonymous", () => {
	it("returns a public lesson", async () => {
		const pub = await seedFor(theirs, { visibility: "public" });
		const page = await readPool(db(), null, { limit: 50 });
		expect(idsIn(page)).toEqual([pub.id]);
	});

	// THE LEAK TESTS. Each must be proven by ablation - see Step 5.
	it("does not return a private lesson", async () => {
		await seedFor(theirs, { visibility: "private" });
		const page = await readPool(db(), null, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("does not return an org lesson", async () => {
		await seedFor(theirs, { visibility: "org" });
		const page = await readPool(db(), null, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("does not return a retracted public lesson", async () => {
		await seedFor(theirs, { visibility: "public", status: "retracted" });
		const page = await readPool(db(), null, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("does not return a public lesson from a blocked author", async () => {
		await seedFor(theirs, { visibility: "public", author_key: "d".repeat(32) });
		await block("d".repeat(32));

		const page = await readPool(db(), null, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});
});

describe("readPool, authenticated", () => {
	it("returns my own lesson at any status", async () => {
		const retracted = await seedFor(mine, { status: "retracted" });
		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([retracted.id]);
	});

	it("returns my own lesson even when my author_key is blocked", async () => {
		// A block stops a lesson reaching OTHER people. It is not a punishment
		// that hides your own writing from you.
		const own = await seedFor(mine, { author_key: "e".repeat(32) });
		await block("e".repeat(32));

		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([own.id]);
	});

	it("does not return another user's private lesson", async () => {
		await seedFor(theirs, { visibility: "private" });
		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	// The authenticated-non-owner axis: a signed-in caller who is not the
	// owner. Distinct from both the anonymous leak tests above (principal is
	// null, so `own` is the literal 0) and the owner tests below (`own` is
	// true by construction) - only this axis exercises the `own` disjunct's
	// left side actually evaluating false for a real, authenticated user. A
	// bug that widened `own` to match any signed-in caller would pass every
	// other test in this file.
	it("does not return another user's retracted public lesson", async () => {
		await seedFor(theirs, { visibility: "public", status: "retracted" });
		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("does not return another user's public lesson from a blocked author", async () => {
		await seedFor(theirs, { visibility: "public", author_key: "f".repeat(32) });
		await block("f".repeat(32));

		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("does not return another user's org lesson while OrgMembers is inert", async () => {
		await seedFor(theirs, { visibility: "org" });
		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("returns another user's public lesson", async () => {
		const pub = await seedFor(theirs, { visibility: "public" });
		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([pub.id]);
	});

	it("returns an org lesson once a resolver names the owner a member", async () => {
		// Proves the hole is wired without deciding what an org is - that is
		// ONL-12's. A resolver that names `theirs` is enough.
		const org = await seedFor(theirs, { visibility: "org" });

		const page = await readPool(
			db(),
			{ userId: mine },
			{ limit: 50 },
			async () => [theirs],
		);

		expect(idsIn(page)).toEqual([org.id]);
	});

	it("still hides a private lesson from an org member", async () => {
		// Org membership widens `org`, never `private`.
		await seedFor(theirs, { visibility: "private" });

		const page = await readPool(
			db(),
			{ userId: mine },
			{ limit: 50 },
			async () => [theirs],
		);

		expect(idsIn(page)).toEqual([]);
	});

	it("truncates an oversized org list rather than binding it all", async () => {
		// MAX_ORG_MEMBERS_BOUND keeps this predicate's `IN (...)` list under
		// D1's bound-parameter cap - a floor against a broken or oversized
		// resolver, not a supported way to run a big org (see pool.ts). Naming
		// `theirs` past the bound proves the excess is dropped rather than the
		// query itself breaking.
		await seedFor(theirs, { visibility: "org" });
		const padding = Array.from(
			{ length: MAX_ORG_MEMBERS_BOUND },
			(_, i) => `padding-${i}`,
		);

		const page = await readPool(
			db(),
			{ userId: mine },
			{ limit: 50 },
			async () => [...padding, theirs],
		);

		expect(idsIn(page)).toEqual([]);
	});
});

describe("readPoolLesson", () => {
	it("returns a public lesson to an anonymous caller", async () => {
		const pub = await seedFor(theirs, { visibility: "public" });
		const found = await readPoolLesson(db(), null, pub.id);
		expect((found as { id: string }).id).toBe(pub.id);
	});

	it("returns null for a private lesson to an anonymous caller", async () => {
		const priv = await seedFor(theirs, { visibility: "private" });
		expect(await readPoolLesson(db(), null, priv.id)).toBeNull();
	});

	it("returns null for a missing id, indistinguishably", async () => {
		expect(
			await readPoolLesson(db(), null, "01NOPE00000000000000000000"),
		).toBeNull();
	});
});
