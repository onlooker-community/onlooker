import { describe, expect, it } from "vitest";
import { ZEvidence } from "./evidence.js";

const valid = {
	artifact_ids: ["01KZ45MKAM734ZS7JK24D2DK0R"],
	session_ids: ["e967f5f9-1234-4321-8888-abcdefabcdef"],
	project_key: "6a7678979e31",
	observed_at: "2026-08-03T15:59:48Z",
	resolution: "Upgraded vite 5.4.11 to 8.0.16; 267 tests pass.",
};

describe("ZEvidence", () => {
	it("accepts a real archivist-shaped artifact reference", () => {
		expect(ZEvidence.parse(valid)).toEqual(valid);
	});

	it("requires a resolution, because a claim without a fix is a warning", () => {
		const { resolution, ...withoutResolution } = valid;
		expect(ZEvidence.safeParse(withoutResolution).success).toBe(false);
	});

	it("rejects an empty resolution string", () => {
		expect(ZEvidence.safeParse({ ...valid, resolution: "" }).success).toBe(
			false,
		);
	});

	it("requires at least one artifact id", () => {
		expect(ZEvidence.safeParse({ ...valid, artifact_ids: [] }).success).toBe(
			false,
		);
	});

	it("requires at least one session id", () => {
		expect(ZEvidence.safeParse({ ...valid, session_ids: [] }).success).toBe(
			false,
		);
	});

	it("rejects a lowercase ulid", () => {
		expect(
			ZEvidence.safeParse({
				...valid,
				artifact_ids: ["01kz45mkam734zs7jk24d2dk0r"],
			}).success,
		).toBe(false);
	});

	it("rejects a project_key that is not 12 hex characters", () => {
		expect(
			ZEvidence.safeParse({ ...valid, project_key: "onlooker" }).success,
		).toBe(false);
	});
});
