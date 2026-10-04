import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrgsPage from "../pages/OrgsPage";

vi.mock("../api/orgsApi", () => ({
	listOrgs: vi.fn(),
	createOrg: vi.fn(),
	listMembers: vi.fn(),
	listInvites: vi.fn(),
	createInvite: vi.fn(),
	revokeInvite: vi.fn(),
	setMemberRole: vi.fn(),
	removeMember: vi.fn(),
}));

const api = await import("../api/orgsApi");

const OWNED = { id: "org-1", name: "Acme", role: "owner" as const };
const JOINED = { id: "org-2", name: "Beta", role: "member" as const };
const MEMBERS = [
	{
		user_id: "u1",
		name: "Ada",
		email: "ada@example.com",
		role: "owner" as const,
		created_at: "2026-10-01T00:00:00.000Z",
	},
];

beforeEach(() => {
	vi.mocked(api.listMembers).mockResolvedValue({ members: MEMBERS });
	vi.mocked(api.listInvites).mockResolvedValue({ invites: [] });
});

describe("OrgsPage", () => {
	it("lists the orgs the caller belongs to", async () => {
		vi.mocked(api.listOrgs).mockResolvedValue({ orgs: [OWNED, JOINED] });
		render(<OrgsPage />);
		expect(await screen.findByText("Acme")).toBeInTheDocument();
		expect(screen.getByText("Beta")).toBeInTheDocument();
	});

	it("says so when the caller is in no org", async () => {
		vi.mocked(api.listOrgs).mockResolvedValue({ orgs: [] });
		render(<OrgsPage />);
		expect(await screen.findByText(/not in any org/i)).toBeInTheDocument();
	});

	it("offers inviting only for an org the caller owns", async () => {
		vi.mocked(api.listOrgs).mockResolvedValue({ orgs: [JOINED] });
		render(<OrgsPage />);
		await screen.findByText("Beta");

		// A control that always 404s is worse than no control: the API refuses an
		// owner action from a plain member, so the page must not offer one.
		expect(
			screen.queryByRole("button", { name: /invite/i }),
		).not.toBeInTheDocument();
		expect(
			await screen.findByRole("button", { name: /leave/i }),
		).toBeInTheDocument();
	});

	it("creates an org and shows it", async () => {
		vi.mocked(api.listOrgs).mockResolvedValue({ orgs: [] });
		vi.mocked(api.createOrg).mockResolvedValue({
			org: { id: "org-new", name: "Gamma", role: "owner" },
		});
		render(<OrgsPage />);

		await userEvent.type(await screen.findByLabelText(/org name/i), "Gamma");
		await userEvent.click(screen.getByRole("button", { name: /create/i }));

		await waitFor(() => expect(api.createOrg).toHaveBeenCalledWith("Gamma"));
		expect(await screen.findByText("Gamma")).toBeInTheDocument();
	});

	it("surfaces a failed load instead of rendering an empty list", async () => {
		vi.mocked(api.listOrgs).mockRejectedValue(new Error("network"));
		render(<OrgsPage />);
		expect(await screen.findByRole("alert")).toBeInTheDocument();
		expect(screen.queryByText(/not in any org/i)).not.toBeInTheDocument();
	});
});
