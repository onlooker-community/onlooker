import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("../api/client", () => ({
	apiClient: { get: mocks.get },
}));

import { listSessions } from "../api/sessionsApi";

describe("listSessions", () => {
	beforeEach(() => {
		mocks.get.mockReset();
		mocks.get.mockResolvedValue({
			sessions: [],
			cursor: null,
			has_more: false,
		});
	});

	it("asks for no limit when none is given", async () => {
		await listSessions();
		expect(mocks.get).toHaveBeenCalledWith("/api/sessions");
	});

	it("forwards a limit", async () => {
		await listSessions({ limit: 200 });
		expect(mocks.get).toHaveBeenCalledWith("/api/sessions?limit=200");
	});

	// The route clamps at BROWSE_MAX_LIMIT rather than rejecting, so sending a
	// cursor and a limit together has to keep both - a page 2 that silently
	// dropped the limit would return 50 rows into a 200-row rollup and make the
	// header under-report without any error to notice.
	it("keeps both when paging", async () => {
		await listSessions({ cursor: "c1", limit: 200 });
		expect(mocks.get).toHaveBeenCalledWith("/api/sessions?cursor=c1&limit=200");
	});
});
