import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ZCounterObservation, ZLesson } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("emitted JSON Schema", () => {
	it("guards the committed schema against drift from the zod source", () => {
		const committed = JSON.parse(
			readFileSync(resolve(here, "../schema/lesson.schema.json"), "utf-8"),
		);
		expect(committed).toEqual(z.toJSONSchema(ZLesson));
	});

	it("keeps the version-range pattern, which refinements would have lost", () => {
		const json = z.toJSONSchema(ZLesson) as Record<string, any>;
		const pattern =
			json.properties.applies_to.properties.versions.additionalProperties
				.pattern;

		expect(pattern).toBeDefined();
		expect(new RegExp(pattern).test("<6")).toBe(true);
		expect(new RegExp(pattern).test(">=4 <6")).toBe(true);
		expect(new RegExp(pattern).test("potato")).toBe(false);
	});

	it("keeps the ULID pattern on ids", () => {
		const json = z.toJSONSchema(ZLesson) as Record<string, any>;
		const pattern = json.properties.id.pattern;

		expect(new RegExp(pattern).test("01KZ8FMKAM734ZS7JK24D2DK0R")).toBe(true);
		expect(new RegExp(pattern).test("not-a-ulid")).toBe(false);
	});

	it("lists every lifecycle state so plugins see retracted too", () => {
		const json = z.toJSONSchema(ZLesson) as Record<string, any>;
		expect(json.properties.status.enum).toEqual([
			"active",
			"refuted",
			"superseded",
			"retracted",
		]);
	});

	it("emits a counter-observation schema with no status field", () => {
		const json = z.toJSONSchema(ZCounterObservation) as Record<string, any>;
		expect(Object.keys(json.properties)).not.toContain("status");
	});
});
