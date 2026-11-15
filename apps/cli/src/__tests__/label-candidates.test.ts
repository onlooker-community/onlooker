import { describe, expect, it } from "vitest";
import { CandidateCollector } from "../label-candidates";

const start = (timestamp: string, dir: string, project = "6a7678979e31") => ({
	timestamp,
	project,
	project_basis: "remote" as const,
	working_directory: dir,
});

describe("CandidateCollector", () => {
	it("groups by key and basis, newest directory first, without repeats", () => {
		const c = new CandidateCollector("2026-11-08T00:00:00.000Z");
		c.add(start("2026-11-10T00:00:00.000Z", "/a"));
		c.add(start("2026-11-12T00:00:00.000Z", "/b"));
		c.add(start("2026-11-11T00:00:00.000Z", "/a"));
		expect(c.candidates()).toEqual([
			{ key: "6a7678979e31", basis: "remote", dirs: ["/b", "/a"] },
		]);
	});

	it("drops starts before the window", () => {
		const c = new CandidateCollector("2026-11-08T00:00:00.000Z");
		c.add(start("2026-11-01T00:00:00.000Z", "/old"));
		expect(c.candidates()).toEqual([]);
	});

	it("drops a key that is not 12 hex", () => {
		const c = new CandidateCollector("2026-11-08T00:00:00.000Z");
		c.add(start("2026-11-10T00:00:00.000Z", "/a", "nope"));
		expect(c.candidates()).toEqual([]);
	});
});
