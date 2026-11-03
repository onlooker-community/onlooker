import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("../api/client", () => ({
	apiClient: { get: mocks.get },
}));

import { listLessons } from "../api/lessonsApi";

describe("listLessons", () => {
	beforeEach(() => {
		mocks.get.mockReset();
		mocks.get.mockResolvedValue({ lessons: [], cursor: null, has_more: false });
	});

	it("asks for nothing extra when no option is given", async () => {
		await listLessons();
		expect(mocks.get).toHaveBeenCalledWith("/api/lessons");
	});

	// One value per key under a name, so the parameter repeats rather than
	// joining with a separator a key could in principle contain.
	it("repeats the project parameter for each key", async () => {
		await listLessons({ project: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"] });
		expect(mocks.get).toHaveBeenCalledWith(
			"/api/lessons?project=aaaaaaaaaaaa&project=bbbbbbbbbbbb",
		);
	});

	it("keeps status, project and cursor together", async () => {
		await listLessons({
			statuses: ["active"],
			project: ["aaaaaaaaaaaa"],
			cursor: "c1",
		});
		expect(mocks.get).toHaveBeenCalledWith(
			"/api/lessons?status=active&project=aaaaaaaaaaaa&cursor=c1",
		);
	});
});
