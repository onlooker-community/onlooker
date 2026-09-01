import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	BASE,
	lesson,
	mintMachine,
	push,
	resetLessonCounter,
} from "../test-support/lessons.js";

const db = () => env.DB;
let accessToken: string;
let machineToken: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM machine_tokens").run();
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM users").run();
	const minted = await mintMachine("activity@example.com");
	accessToken = minted.accessToken;
	machineToken = minted.token;
	resetLessonCounter();
});

const read = (path: string) =>
	SELF.fetch(`${BASE}${path}`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});

describe("GET /api/activity", () => {
	it("rejects a request with no session", async () => {
		const response = await SELF.fetch(`${BASE}/api/activity`);
		expect(response.status).toBe(401);
	});

	// The credential split, same as /api/lessons asserts it: a machine token
	// opens the sync routes and must not open the browsing ones.
	it("rejects a machine token", async () => {
		const response = await SELF.fetch(`${BASE}/api/activity`, {
			headers: { Authorization: `Bearer ${machineToken}` },
		});
		expect(response.status).toBe(401);
	});

	it("returns an empty feed as an empty list, not a 404", async () => {
		const response = await read("/api/activity");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			events: [],
			cursor: null,
			has_more: false,
		});
	});

	// Pushed through the real ingest path, which is what writes the feed rows
	// this endpoint reads - seeding them by hand would test a shape the
	// product never produces.
	it("returns the caller's events newest first", async () => {
		await push(machineToken, [lesson(), lesson()]);

		const response = await read("/api/activity");
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			events: { seq: number; kind: string; claim: string }[];
			has_more: boolean;
		};
		expect(body.events).toHaveLength(2);
		expect(body.events[0].seq).toBeGreaterThan(body.events[1].seq);
		expect(body.events.every((e) => e.kind === "create")).toBe(true);
		expect(body.has_more).toBe(false);
	});

	// A cursor this server did not issue is client error, not server error.
	// Without the mapping it surfaces as a 500 and reads like an outage.
	it("answers 400 for a cursor it did not issue", async () => {
		const response = await read("/api/activity?cursor=nonsense!!");
		expect(response.status).toBe(400);
	});
});
