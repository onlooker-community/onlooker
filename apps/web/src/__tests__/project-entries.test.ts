import { describe, expect, it } from "vitest";
import { labelIdentity } from "../api/labelsApi";
import type { Project } from "../api/projectsApi";
import { projectEntries, projectName } from "../lib/projectEntries";

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const C = "cccccccccccc";

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
		expect(projectEntries([project(A, null)], new Map())).toEqual([
			{ name: A, values: [A] },
		]);
	});

	it("makes one entry of two remote keys sharing a name", () => {
		const labels = new Map([
			[labelIdentity(A, null), "onlooker"],
			[labelIdentity(B, null), "onlooker"],
		]);
		expect(
			projectEntries([project(A, null), project(B, null)], labels),
		).toEqual([{ name: "onlooker", values: [A, B] }]);
	});

	it("sends a root key as <machine_id>:<key>", () => {
		expect(projectEntries([project(A, "m1")], new Map())).toEqual([
			{ name: A, values: [`m1:${A}`] },
		]);
	});

	it("keeps the same root key on two machines apart when named apart", () => {
		const labels = new Map([
			[labelIdentity(A, "m1"), "scratch"],
			[labelIdentity(A, "m2"), "elsewhere"],
		]);
		expect(
			projectEntries([project(A, "m1"), project(A, "m2")], labels),
		).toEqual([
			{ name: "elsewhere", values: [`m2:${A}`] },
			{ name: "scratch", values: [`m1:${A}`] },
		]);
	});

	// Sync accepts keys the filter cannot send, and one in a shared name would
	// make the whole entry a 400.
	it("leaves out a key the server cannot filter on", () => {
		const labels = new Map([
			[labelIdentity(A, null), "shared"],
			[labelIdentity("not-a-hex-key", null), "shared"],
		]);
		expect(
			projectEntries(
				[
					project(A, null),
					project("not-a-hex-key", null),
					project("ABCDEF012345", "m1"),
				],
				labels,
			),
		).toEqual([{ name: "shared", values: [A] }]);
	});

	it("sorts by name, ignoring case", () => {
		const labels = new Map([
			[labelIdentity(A, null), "banana"],
			[labelIdentity(B, null), "Apple"],
			[labelIdentity(C, null), "cherry"],
		]);
		const names = projectEntries(
			[project(A, null), project(B, null), project(C, null)],
			labels,
		).map((entry) => entry.name);
		expect(names).toEqual(["Apple", "banana", "cherry"]);
	});
});

describe("projectName", () => {
	it("prefers the label under the right identity", () => {
		const labels = new Map([[labelIdentity(A, "m1"), "scratch"]]);
		expect(projectName(A, "m1", labels)).toBe("scratch");
	});

	it("does not let a root label answer for the remote identity", () => {
		const labels = new Map([[labelIdentity(A, "m1"), "scratch"]]);
		expect(projectName(A, null, labels)).toBe(A);
	});

	it("falls back to the key", () => {
		expect(projectName(A, null, new Map())).toBe(A);
	});
});
