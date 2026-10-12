import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RevealProvider } from "../reveal";

const logout = vi.fn();
const navigate = vi.fn();

// The session teardown is the thing a refusal must NOT reach: signing someone
// out of an account that still exists leaves them unable to act on the very
// refusal they were just shown.
vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({
			user: { id: "u1", email: "ada@example.com", name: "Ada" },
			loading: false,
			logout,
			refresh: vi.fn(),
			sessionExpiresAt: null,
			sessionExpiringSoon: false,
		}),
		RequireAuth: ({ children }: { children: React.ReactNode }) => children,
	},
}));

vi.mock("react-router-dom", async () => {
	const actual =
		await vi.importActual<typeof import("react-router-dom")>(
			"react-router-dom",
		);
	return { ...actual, useNavigate: () => navigate };
});

vi.mock("../api/accountApi", () => ({
	getProfile: () =>
		Promise.resolve({
			user: {
				id: "u1",
				name: "Ada",
				email: "ada@example.com",
				emailVerified: true,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		}),
	updateProfile: vi.fn(),
	changePassword: vi.fn(),
	deleteAccount: vi.fn(),
	resendVerificationEmail: vi.fn(),
}));

const api = await import("../api/accountApi");
const { default: SettingsPage } = await import("../pages/SettingsPage");

beforeEach(() => {
	logout.mockClear();
	navigate.mockClear();
	vi.mocked(api.deleteAccount).mockReset();
});

async function askToDelete() {
	const user = userEvent.setup();
	render(
		<MemoryRouter>
			<RevealProvider>
				<SettingsPage />
			</RevealProvider>
		</MemoryRouter>,
	);
	await user.click(
		await screen.findByRole("button", { name: /delete my account/i }),
	);
	await user.type(screen.getByLabelText(/type your email/i), "ada@example.com");
	await user.click(screen.getByRole("button", { name: /permanently delete/i }));
}

describe("delete account, accepted", () => {
	// The refusal branch returns early, which is one edit away from skipping
	// the teardown on the path that is supposed to run it.
	it("ends the session when the account is really gone", async () => {
		vi.mocked(api.deleteAccount).mockResolvedValue({ success: true });

		await askToDelete();

		await vi.waitFor(() => expect(logout).toHaveBeenCalled());
		expect(navigate).toHaveBeenCalledWith("/");
	});
});

describe("delete account, refused because the account solely owns an org", () => {
	it("names every org responsible for the refusal", async () => {
		vi.mocked(api.deleteAccount).mockResolvedValue({
			success: false,
			reason: "sole_owner",
			orgs: [
				{ id: "org-1", name: "Acme" },
				{ id: "org-2", name: "Beta" },
			],
		});

		await askToDelete();

		// Both, not just the first: somebody who owns several has no other
		// route that would tell them which ones are blocking this.
		expect(await screen.findByText(/Acme/)).toBeInTheDocument();
		expect(screen.getByText(/Beta/)).toBeInTheDocument();
	});

	it("keeps the session, because the account still exists", async () => {
		vi.mocked(api.deleteAccount).mockResolvedValue({
			success: false,
			reason: "sole_owner",
			orgs: [{ id: "org-1", name: "Acme" }],
		});

		await askToDelete();

		await screen.findByText(/Acme/);
		expect(logout).not.toHaveBeenCalled();
		expect(navigate).not.toHaveBeenCalled();
	});
});
