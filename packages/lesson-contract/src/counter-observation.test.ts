import { describe, expect, it } from "vitest";
import { ZCounterObservation } from "./counter-observation.js";

const valid = {
	id: "01KZB1MKAM734ZS7JK24D2DK0R",
	schema_version: 1,
	lesson_id: "01KZ8FMKAM734ZS7JK24D2DK0R",
	observed_at: "2026-08-07T09:15:00Z",
	artifact_ids: ["01KZB2MKAM734ZS7JK24D2DK0R"],
	session_id: "aa11bb22-3344-4556-8899-ccddeeff0011",
	summary: "Applied the vite pin on a matching project; tests still failed.",
	author_key: "c4d5e6f7a8b9",
};

describe("ZCounterObservation", () => {
	it("accepts a well-formed counter-observation", () => {
		expect(ZCounterObservation.parse(valid)).toEqual(valid);
	});

	it("requires the lesson it contradicts", () => {
		const { lesson_id, ...withoutLesson } = valid;
		expect(ZCounterObservation.safeParse(withoutLesson).success).toBe(false);
	});

	it("requires its own evidence, so a bare complaint cannot be filed", () => {
		expect(
			ZCounterObservation.safeParse({ ...valid, artifact_ids: [] }).success,
		).toBe(false);
	});

	it("rejects a malformed lesson_id", () => {
		expect(
			ZCounterObservation.safeParse({ ...valid, lesson_id: "nope" }).success,
		).toBe(false);
	});

	it("rejects a smuggled verdict, because the reporter does not decide", () => {
		expect(
			ZCounterObservation.safeParse({ ...valid, status: "refuted" }).success,
		).toBe(false);
	});

	it("rejects an email address as an author_key", () => {
		expect(
			ZCounterObservation.safeParse({
				...valid,
				author_key: "meagan@example.com",
			}).success,
		).toBe(false);
	});
});
