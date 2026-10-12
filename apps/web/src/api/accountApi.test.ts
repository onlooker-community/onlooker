import { AuthApiError } from "@onlooker/auth-react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	del: vi.fn(),
}));

vi.mock("./client", () => ({
	apiClient: { delete: mocks.del },
	tokenStore: { getRefreshToken: () => null },
}));

const { deleteAccount } = await import("./accountApi");

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
