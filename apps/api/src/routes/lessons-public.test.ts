import { env, SELF } from "cloudflare:test";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createLessonsWithFeed } from "../db/lessons.js";
import { createUser } from "../db/queries.js";
import { BASE, lesson, resetLessonCounter } from "../test-support/lessons.js";

const db = () => env.DB;
let owner: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_author_blocks").run();
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM users").run();
	owner = (await createUser(db(), "owner@example.com", "hash", "Ada")).id;
	resetLessonCounter();
});

/** Seeded directly: push still rejects every non-private tier, deliberately. */
async function seed(overrides: Record<string, unknown>): Promise<TLesson> {
	const written = lesson(overrides) as TLesson;
	await createLessonsWithFeed(db(), owner, [written]);
	return written;
}

const get = (id: string) => SELF.fetch(`${BASE}/api/public/lessons/${id}`);

describe("GET /api/public/lessons/:id", () => {
	it("serves a public lesson with no credential at all", async () => {
		const pub = await seed({ visibility: "public" });

		const response = await get(pub.id);

		expect(response.status).toBe(200);
		expect(((await response.json()) as { id: string }).id).toBe(pub.id);
	});

	// THE LEAK TESTS, at the route. Proven by ablation in Step 4.
	it("404s a private lesson", async () => {
		const priv = await seed({ visibility: "private" });
		expect((await get(priv.id)).status).toBe(404);
	});

	it("404s an org lesson", async () => {
		const org = await seed({ visibility: "org" });
		expect((await get(org.id)).status).toBe(404);
	});

	it("404s a retracted public lesson", async () => {
		const gone = await seed({ visibility: "public", status: "retracted" });
		expect((await get(gone.id)).status).toBe(404);
	});

	it("404s a public lesson from a blocked author", async () => {
		const pub = await seed({
			visibility: "public",
			author_key: "f".repeat(32),
		});
		await db()
			.prepare(
				`INSERT INTO lesson_author_blocks (author_key, reason, blocked_by)
				 VALUES (?, 'injection', 'operator-1')`,
			)
			.bind("f".repeat(32))
			.run();

		expect((await get(pub.id)).status).toBe(404);
	});

	it("404s a missing id the same way, so a 404 confirms nothing", async () => {
		const priv = await seed({ visibility: "private" });

		const missing = await get("01NOPE00000000000000000000");
		const hidden = await get(priv.id);

		expect(missing.status).toBe(hidden.status);
		expect(await missing.text()).toBe(await hidden.text());
	});

	it("caps cache lifetime, because the TTL is the takedown floor", async () => {
		const pub = await seed({ visibility: "public" });

		const header = (await get(pub.id)).headers.get("Cache-Control");

		const maxAge = Number(/max-age=(\d+)/.exec(header ?? "")?.[1] ?? -1);
		expect(maxAge).toBeGreaterThanOrEqual(0);
		expect(maxAge).toBeLessThanOrEqual(60);
	});

	it("allows any origin to read it, without credentials", async () => {
		const pub = await seed({ visibility: "public" });

		const response = await SELF.fetch(`${BASE}/api/public/lessons/${pub.id}`, {
			headers: { Origin: "https://somebody-elses-site.example" },
		});

		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		// A wildcard origin plus credentials is exactly what cors.ts exists to
		// prevent, so it must not appear even here.
		expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
	});
});
