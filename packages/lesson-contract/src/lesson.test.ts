import { describe, expect, it } from "vitest";
import { ZLesson } from "./lesson.js";

const valid = {
	id: "01KZ8FMKAM734ZS7JK24D2DK0R",
	schema_version: 1,
	claim: "Pin vitest and vite to compatible majors; vitest >=4 needs vite >=6.",
	rationale:
		"vitest 4 imports vite/module-runner, a subpath vite 5 does not export.",
	evidence: {
		artifact_ids: ["01KZ45MKAM734ZS7JK24D2DK0R"],
		session_ids: ["e967f5f9-1234-4321-8888-abcdefabcdef"],
		project_key: "6a7678979e31",
		observed_at: "2026-08-03T15:59:48Z",
		resolution: "Upgraded vite 5.4.11 to 8.0.16; 267 tests pass.",
	},
	applies_to: {
		stack: ["vitest", "vite"],
		versions: { vite: "<6", vitest: ">=4" },
		file_patterns: ["**/vite.config.*"],
		task_kinds: ["test-setup", "ci"],
	},
	visibility: "public",
	consensus: { judges: 3, agreed: 3, decided_at: "2026-08-06T12:00:00Z" },
	status: "active",
	superseded_by: null,
	source: "local",
	author_key: "b3f1c2d4e5a6",
	promoted_at: "2026-08-06T12:00:01Z",
};

describe("ZLesson", () => {
	it("accepts a complete lesson", () => {
		expect(ZLesson.parse(valid)).toEqual(valid);
	});

	it("accepts every lifecycle state including retracted", () => {
		for (const status of ["active", "refuted", "superseded", "retracted"]) {
			expect(ZLesson.safeParse({ ...valid, status }).success).toBe(true);
		}
	});

	it("rejects expired as a status, because expiry is not a state", () => {
		expect(ZLesson.safeParse({ ...valid, status: "expired" }).success).toBe(
			false,
		);
	});

	it("accepts a superseded_by pointer", () => {
		expect(
			ZLesson.safeParse({
				...valid,
				status: "superseded",
				superseded_by: "01KZ9AMKAM734ZS7JK24D2DK0R",
			}).success,
		).toBe(true);
	});

	it("rejects an unknown visibility tier", () => {
		expect(ZLesson.safeParse({ ...valid, visibility: "team" }).success).toBe(
			false,
		);
	});

	it("rejects a schema_version other than 1", () => {
		expect(ZLesson.safeParse({ ...valid, schema_version: 2 }).success).toBe(
			false,
		);
	});

	it("rejects unknown top-level fields", () => {
		expect(ZLesson.safeParse({ ...valid, injected: true }).success).toBe(false);
	});
});
