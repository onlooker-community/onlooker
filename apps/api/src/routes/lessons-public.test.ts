import { env, SELF } from "cloudflare:test";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createLessonsWithFeed } from "../db/lessons.js";
import { createOrgWithOwner } from "../db/orgs.js";
import { createUser } from "../db/queries.js";
import {
	BASE,
	lesson,
	mintMachine,
	push,
	resetLessonCounter,
} from "../test-support/lessons.js";

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

/**
 * Written straight to the pool, bypassing push.
 *
 * Still the right tool for most cases here: `org` and `retracted` cannot be
 * pushed at all, and a split-jury public lesson is now refused at ingest, so
 * the leak tests below could not construct their subjects through the route.
 * The one case that CAN go the whole way - push a unanimous public lesson,
 * then read it with no credential - has its own test at the bottom of this
 * file, because that chain is the feature and nothing else here exercises it.
 */
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
		// A REAL org_id, not the NULL seed() would leave it with. NULL makes
		// this pass on an absent column rather than on the visibility: the
		// anonymous route's predicate tests `visibility = 'public'` alone, so
		// an 'org' row 404s whether or not it carries an org_id at all. A real
		// org_id is what makes this the test that exercises the shape the
		// spec describes - an org row that genuinely belongs to an org.
		const orgId = (await createOrgWithOwner(db(), "Acme", owner)).id;
		const written = lesson({ visibility: "org" }) as TLesson;
		await createLessonsWithFeed(db(), owner, [written], orgId);

		expect((await get(written.id)).status).toBe(404);
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

describe("OPTIONS preflight", () => {
	const FOREIGN_ORIGIN = "https://somebody-elses-site.example";

	it("answers a preflight for the public lesson route with the wildcard", async () => {
		const response = await SELF.fetch(
			`${BASE}/api/public/lessons/01NOPE00000000000000000000`,
			{
				method: "OPTIONS",
				headers: {
					Origin: FOREIGN_ORIGIN,
					"Access-Control-Request-Method": "GET",
				},
			},
		);

		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	// The one that matters: proves the wildcard preflight fix above did not
	// leak to every route. A `cors: "app"` route, preflighted from the same
	// foreign origin, must still get nothing back.
	it("still refuses a cors: app route's preflight from the same foreign origin", async () => {
		const response = await SELF.fetch(`${BASE}/auth/me`, {
			method: "OPTIONS",
			headers: {
				Origin: FOREIGN_ORIGIN,
				"Access-Control-Request-Method": "GET",
			},
		});

		expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
		expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
		expect(response.headers.get("Access-Control-Allow-Headers")).toBeNull();
	});

	// The fail-closed guarantee rests entirely on `matched` being undefined
	// whenever the target route can't be identified, and on preflightResponse's
	// default parameter treating that as "app". These two pin the other paths
	// into that undefined besides an outright unmatched path: no
	// Access-Control-Request-Method at all, and one naming no route.
	it("fails closed to the allowlist when Access-Control-Request-Method is missing", async () => {
		const response = await SELF.fetch(
			`${BASE}/api/public/lessons/01NOPE00000000000000000000`,
			{
				method: "OPTIONS",
				headers: { Origin: FOREIGN_ORIGIN },
			},
		);

		expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("fails closed to the allowlist when Access-Control-Request-Method is garbage", async () => {
		const response = await SELF.fetch(
			`${BASE}/api/public/lessons/01NOPE00000000000000000000`,
			{
				method: "OPTIONS",
				headers: {
					Origin: FOREIGN_ORIGIN,
					"Access-Control-Request-Method": "FROBNICATE",
				},
			},
		);

		expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});
});

/**
 * Push to anonymous read, the whole way, with nothing seeded behind the
 * route's back.
 *
 * Every other test in this file writes its subject straight into the pool,
 * because until 2026-10-03 the push gate rejected every non-private tier and
 * there was no way to get a public lesson in through the front door. That
 * made the read path well covered and the CHAIN entirely unproven: a machine
 * pushes a lesson it marked public, and a stranger with no account reads it.
 * That chain is the product - Shared Playbooks is the one capability the
 * hosted app exists for - so it gets a test that touches only public routes.
 */
describe("a pushed public lesson reaches a reader with no account", () => {
	it("is readable anonymously after a machine pushes it", async () => {
		const machine = await mintMachine("author@example.com");
		const written = lesson({
			visibility: "public",
			consensus: {
				judges: 3,
				agreed: 3,
				decided_at: "2026-08-22T00:00:00.000Z",
			},
		});

		const pushed = await push(machine.token, [written]);
		expect(
			((await pushed.json()) as { results: Array<{ outcome: string }> })
				.results[0].outcome,
		).toBe("created");

		// No Authorization header anywhere in `get`. This is the stranger.
		const response = await get(written.id);

		expect(response.status).toBe(200);
		expect(((await response.json()) as { claim: string }).claim).toBe(
			written.claim,
		);
	});

	// The same push, one judge short. Nothing reaches the pool, so nothing
	// reaches a reader - the bar has to hold at ingest, because after a
	// lesson is public the only remedy left is a retraction with a
	// browser-cache floor under it.
	it("never reaches the pool when the jury was split", async () => {
		const machine = await mintMachine("author2@example.com");
		const written = lesson({
			visibility: "public",
			consensus: {
				judges: 3,
				agreed: 2,
				decided_at: "2026-08-22T00:00:00.000Z",
			},
		});

		await push(machine.token, [written]);

		expect((await get(written.id)).status).toBe(404);
	});
});
