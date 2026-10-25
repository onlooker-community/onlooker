import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), request: vi.fn() }));

vi.mock("../api/client", () => ({
	apiClient: { get: mocks.get, request: mocks.request },
}));

import { labelIdentity, listLabels, setLabel } from "../api/labelsApi";

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
