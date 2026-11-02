import { describe, expect, it } from "vitest";
import { labelIdentity } from "../api/labelsApi";
import type { Project } from "../api/projectsApi";
import { projectEntries, projectName } from "../lib/projectEntries";

function project(
	key: string,
	machineId: string | null,
	basis: Project["basis"] = machineId === null ? "remote" : "root",
): Project {
	return {
		project_key: key,
		basis,
		machine_id: machineId,
		sessions: 1,
		events: 1,
		last_seen_at: null,
	};
}

describe("projectEntries", () => {
	it("makes an entry of a key with no name, named by the key", () => {
		expect(projectEntries([project("aaa", null)], new Map())).toEqual([
			{ name: "aaa", values: ["aaa"] },
		]);
	});

	it("makes one entry of two remote keys sharing a name", () => {
		const labels = new Map([
			[labelIdentity("aaa", null), "onlooker"],
			[labelIdentity("bbb", null), "onlooker"],
		]);
		expect(
			projectEntries([project("aaa", null), project("bbb", null)], labels),
		).toEqual([{ name: "onlooker", values: ["aaa", "bbb"] }]);
	});

	it("sends a root key as <machine_id>:<key>", () => {
		expect(projectEntries([project("aaa", "m1")], new Map())).toEqual([
			{ name: "aaa", values: ["m1:aaa"] },
		]);
	});

	it("keeps the same root key on two machines apart when named apart", () => {
		const labels = new Map([
			[labelIdentity("aaa", "m1"), "scratch"],
			[labelIdentity("aaa", "m2"), "elsewhere"],
		]);
		expect(
			projectEntries([project("aaa", "m1"), project("aaa", "m2")], labels),
		).toEqual([
			{ name: "elsewhere", values: ["m2:aaa"] },
			{ name: "scratch", values: ["m1:aaa"] },
		]);
	});

	it("sorts by name, ignoring case", () => {
		const labels = new Map([
			[labelIdentity("aaa", null), "banana"],
			[labelIdentity("bbb", null), "Apple"],
			[labelIdentity("ccc", null), "cherry"],
		]);
		const names = projectEntries(
			[project("aaa", null), project("bbb", null), project("ccc", null)],
			labels,
		).map((entry) => entry.name);
		expect(names).toEqual(["Apple", "banana", "cherry"]);
	});
});

describe("projectName", () => {
	it("prefers the label under the right identity", () => {
		const labels = new Map([[labelIdentity("aaa", "m1"), "scratch"]]);
		expect(projectName("aaa", "m1", labels)).toBe("scratch");
	});

	it("does not let a root label answer for the remote identity", () => {
		const labels = new Map([[labelIdentity("aaa", "m1"), "scratch"]]);
		expect(projectName("aaa", null, labels)).toBe("aaa");
	});

	it("falls back to the key", () => {
		expect(projectName("aaa", null, new Map())).toBe("aaa");
	});
});
