import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ZCounterObservation, ZLesson } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The versioned branch of applies_to.scope. Found by discriminator rather than
 * by index so the test does not depend on how zod happens to order oneOf.
 */
const versionedBranch = (json: Record<string, any>) =>
	json.properties.applies_to.properties.scope.oneOf.find(
		(branch: any) => branch.properties.kind.const === "versioned",
	);

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
			versionedBranch(json).properties.versions.additionalProperties.pattern;

		expect(pattern).toBeDefined();
		expect(new RegExp(pattern).test("<6")).toBe(true);
		expect(new RegExp(pattern).test(">=4 <6")).toBe(true);
		expect(new RegExp(pattern).test("potato")).toBe(false);
	});

	// The artifact half of the non-empty rule. Its runtime twin lives in
	// applies-to.test.ts. Both are asserted because .meta() does not affect
	// parsing and .check() does not reach the artifact, so the two can drift.
	it("carries the non-empty versions rule into the artifact", () => {
		const json = z.toJSONSchema(ZLesson) as Record<string, any>;
		expect(versionedBranch(json).properties.versions.minProperties).toBe(1);
	});

	it("publishes both scope branches so plugins can emit either", () => {
		const json = z.toJSONSchema(ZLesson) as Record<string, any>;
		const kinds = json.properties.applies_to.properties.scope.oneOf.map(
			(branch: any) => branch.properties.kind.const,
		);
		expect(kinds.sort()).toEqual(["version_independent", "versioned"]);
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

	it("carries the versions AND-combining rule into the artifact", () => {
		const json = z.toJSONSchema(ZLesson) as Record<string, any>;
		expect(versionedBranch(json).properties.versions.description).toMatch(
			/AND/,
		);
	});

	// The published artifact is the only channel that reaches the shell-based
	// plugins, which cannot import this package. A cross-field rule JSON Schema
	// cannot express is therefore invisible to them unless it is stated in a
	// description — the same reason ZConsensus documents "agreed <= judges"
	// rather than silently enforcing it server-side only.
	it("tells plugins that versions keys must come from stack", () => {
		const json = z.toJSONSchema(ZLesson) as Record<string, any>;
		const description = json.properties.applies_to.description;

		expect(description).toBeDefined();
		expect(description).toMatch(/stack/);
		expect(description).toMatch(/ingest/);
	});
});
