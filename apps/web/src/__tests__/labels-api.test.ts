import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), request: vi.fn() }));

vi.mock("../api/client", () => ({
	apiClient: { get: mocks.get, request: mocks.request },
}));

import {
	labelIdentity,
	listLabels,
	nameForKey,
	setLabel,
} from "../api/labelsApi";

describe("listLabels", () => {
	beforeEach(() => {
		mocks.get.mockReset();
	});

	it("keys each label by machine and project key", async () => {
		mocks.get.mockResolvedValue({
			labels: [
				{ project_key: "6a7678979e31", machine_id: null, label: "onlooker" },
				{ project_key: "54460a64b16d", machine_id: "m1", label: "scratch" },
			],
		});

		const labels = await listLabels();

		expect(mocks.get).toHaveBeenCalledWith("/api/project-labels");
		expect(labels.get(labelIdentity("6a7678979e31", null))).toBe("onlooker");
		expect(labels.get(labelIdentity("54460a64b16d", "m1"))).toBe("scratch");
		// A root key's label belongs to its machine alone.
		expect(labels.get(labelIdentity("54460a64b16d", "m2"))).toBeUndefined();
	});
});

describe("setLabel", () => {
	beforeEach(() => {
		mocks.request.mockReset();
		mocks.request.mockResolvedValue({
			project_key: "6a7678979e31",
			machine_id: null,
			label: "onlooker",
		});
	});

	it("puts the label and returns what was stored", async () => {
		const stored = await setLabel("6a7678979e31", null, "  onlooker ");

		expect(mocks.request).toHaveBeenCalledWith("PUT", "/api/project-labels", {
			project_key: "6a7678979e31",
			machine_id: null,
			label: "  onlooker ",
		});
		expect(stored).toBe("onlooker");
	});

	it("clears with null", async () => {
		mocks.request.mockResolvedValue({
			project_key: "6a7678979e31",
			machine_id: null,
			label: null,
		});

		expect(await setLabel("6a7678979e31", null, null)).toBeNull();
		expect(mocks.request).toHaveBeenCalledWith("PUT", "/api/project-labels", {
			project_key: "6a7678979e31",
			machine_id: null,
			label: null,
		});
	});
});

describe("nameForKey", () => {
	const KEY = "6a7678979e31";

	it("names a key by its remote label", () => {
		const labels = new Map([[labelIdentity(KEY, null), "onlooker"]]);
		expect(nameForKey(labels, KEY, { rootLabels: true })).toBe("onlooker");
		expect(nameForKey(labels, KEY, { rootLabels: false })).toBe("onlooker");
	});

	it("prefers the remote label over a root one", () => {
		const labels = new Map([
			[labelIdentity(KEY, "m1"), "local copy"],
			[labelIdentity(KEY, null), "onlooker"],
		]);
		expect(nameForKey(labels, KEY, { rootLabels: true })).toBe("onlooker");
	});

	it("names a root key when every machine agrees on its name", () => {
		const labels = new Map([
			[labelIdentity(KEY, "m1"), "scratch"],
			[labelIdentity(KEY, "m2"), "scratch"],
		]);
		expect(nameForKey(labels, KEY, { rootLabels: true })).toBe("scratch");
	});

	it("names nothing when machines disagree about a root key", () => {
		const labels = new Map([
			[labelIdentity(KEY, "m1"), "scratch"],
			[labelIdentity(KEY, "m2"), "sandbox"],
		]);
		expect(nameForKey(labels, KEY, { rootLabels: true })).toBeNull();
	});

	it("ignores root labels when told to", () => {
		const labels = new Map([[labelIdentity(KEY, "m1"), "scratch"]]);
		expect(nameForKey(labels, KEY, { rootLabels: false })).toBeNull();
	});

	it("does not match another key that ends the same way", () => {
		const labels = new Map([[labelIdentity(`00${KEY}`, "m1"), "other"]]);
		expect(nameForKey(labels, KEY, { rootLabels: true })).toBeNull();
	});
});
