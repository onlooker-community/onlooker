import { AuthApiError } from "@onlooker/auth-react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	del: vi.fn(),
	get: vi.fn(),
}));

vi.mock("./client", () => ({
	apiClient: { delete: mocks.del, get: mocks.get },
	tokenStore: { getRefreshToken: () => null },
}));

const { deleteAccount, getDeletionPreview } = await import("./accountApi");

// What apps/api actually sends: routes/account.ts throws
// ApiError(409, "sole_owner", ..., { orgs }), and auth-react's request()
// unpacks that envelope into AuthApiError(status, code, message, details).
function refusal(details: unknown) {
	return new AuthApiError(
		409,
		"sole_owner",
		"An org needs an owner; promote somebody else, or delete the org if you are its only member",
		details,
	);
}

beforeEach(() => {
	mocks.del.mockReset().mockResolvedValue({ success: true });
	mocks.get.mockReset();
});

describe("deleteAccount", () => {
	it("reports success when the account is gone", async () => {
		expect(await deleteAccount()).toEqual({ success: true });
	});

	it("turns the sole-owner 409 into a refusal naming the orgs", async () => {
		mocks.del.mockRejectedValue(
			refusal({
				orgs: [
					{ id: "org-1", name: "Acme" },
					{ id: "org-2", name: "Beta" },
				],
			}),
		);

		expect(await deleteAccount()).toEqual({
			success: false,
			reason: "sole_owner",
			orgs: [
				{ id: "org-1", name: "Acme" },
				{ id: "org-2", name: "Beta" },
			],
		});
	});

	// The refusal is the ONLY failure this swallows. Returning a result for
	// anything else would turn a dead session or a 500 into a page that calmly
	// explains an org problem the user does not have.
	it("still rejects on any other failure", async () => {
		mocks.del.mockRejectedValue(
			new AuthApiError(401, "unauthorized", "Session expired"),
		);

		await expect(deleteAccount()).rejects.toThrow("Session expired");
	});

	// A 409 whose details never arrived is still a refusal: the deletion did
	// not happen, and saying so without names beats crashing the panel.
	it("refuses with an empty list when the details are missing", async () => {
		mocks.del.mockRejectedValue(refusal(undefined));

		expect(await deleteAccount()).toEqual({
			success: false,
			reason: "sole_owner",
			orgs: [],
		});
	});

	it("drops entries that are not orgs rather than passing them on", async () => {
		mocks.del.mockRejectedValue(
			refusal({ orgs: [{ id: "org-1", name: "Acme" }, null, { id: "org-2" }] }),
		);

		expect(await deleteAccount()).toEqual({
			success: false,
			reason: "sole_owner",
			orgs: [{ id: "org-1", name: "Acme" }],
		});
	});
});

describe("getDeletionPreview", () => {
	it("asks the deletion-preview endpoint and returns what it answers", async () => {
		mocks.get.mockResolvedValue({
			publicLessons: 12,
			orgsKeeping: [{ id: "org-1", name: "Acme", lessons: 4 }],
		});

		expect(await getDeletionPreview()).toEqual({
			publicLessons: 12,
			orgsKeeping: [{ id: "org-1", name: "Acme", lessons: 4 }],
		});
		expect(mocks.get).toHaveBeenCalledWith("/auth/account/deletion-preview");
	});

	// Not zeros. An account that has published nothing and an account whose
	// preview failed are different facts, and a zero for the second would read
	// as "nothing will be lost" over a request that never answered.
	it("rejects when the request fails rather than resolving to zeros", async () => {
		mocks.get.mockRejectedValue(
			new AuthApiError(500, "internal_error", "Something failed"),
		);

		await expect(getDeletionPreview()).rejects.toThrow("Something failed");
	});

	// A body that is not this shape must not reach the panel. The panel reads
	// orgsKeeping.length, so an unexpected payload - an older API deploy, a
	// proxy's JSON error page, a stubbed client in somebody else's test - would
	// throw inside render and take the whole delete section down with it,
	// leaving nobody able to delete their account at all. Rejecting here lands
	// it in the panel's "couldn't check" state instead, which is the honest one.
	it.each([
		["a missing orgsKeeping", { publicLessons: 2 }],
		["a missing publicLessons", { orgsKeeping: [] }],
		["orgsKeeping that is not an array", { publicLessons: 2, orgsKeeping: {} }],
		["a body that is not an object", "nope"],
		["null", null],
		["an unrelated payload", { machines: [] }],
	])("rejects %s rather than passing it to the panel", async (_label, body) => {
		mocks.get.mockResolvedValue(body);

		await expect(getDeletionPreview()).rejects.toThrow(
			/unexpected deletion-preview/i,
		);
	});
});
