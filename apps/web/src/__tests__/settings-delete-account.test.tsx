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
	getDeletionPreview: vi.fn(),
	resendVerificationEmail: vi.fn(),
}));

const api = await import("../api/accountApi");
const { default: SettingsPage } = await import("../pages/SettingsPage");

beforeEach(() => {
	logout.mockClear();
	navigate.mockClear();
	vi.mocked(api.deleteAccount).mockReset();
	// A resolved default, so the tests that are about the refusal and the
	// teardown do not also have to care about the preview - and so an
	// unhandled rejection cannot be mistaken for one of their failures.
	vi.mocked(api.getDeletionPreview).mockReset().mockResolvedValue({
		publicLessons: 0,
		orgsKeeping: [],
	});
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

/**
 * Stop at the revealed form, without confirming.
 *
 * The preview is what the panel says *before* a deletion is asked for, so
 * these cases never reach the DELETE at all.
 */
async function askWhatWillHappen() {
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

describe("what the panel says deletion will destroy", () => {
	it("names the public count and each org that keeps its lessons", async () => {
		vi.mocked(api.getDeletionPreview).mockResolvedValue({
			publicLessons: 12,
			orgsKeeping: [
				{ id: "org-1", name: "Acme", lessons: 4 },
				{ id: "org-2", name: "Beta", lessons: 1 },
			],
		});

		await askWhatWillHappen();

		expect(await screen.findByText(/12 public lessons/i)).toBeInTheDocument();
		// 5 is summed on the client: the API sends no total, because a total it
		// computes and a total the names add up to can disagree.
		expect(
			screen.getByText(/5 lessons stay with their org/i),
		).toBeInTheDocument();
		expect(screen.getByText(/Acme \(4\)/)).toBeInTheDocument();
		expect(screen.getByText(/Beta \(1\)/)).toBeInTheDocument();
	});

	it("says plainly when there is nothing shared to lose", async () => {
		vi.mocked(api.getDeletionPreview).mockResolvedValue({
			publicLessons: 0,
			orgsKeeping: [],
		});

		await askWhatWillHappen();

		expect(await screen.findByText(/no shared lessons/i)).toBeInTheDocument();
	});

	it("admits it could not check, without claiming the deletion is blocked", async () => {
		vi.mocked(api.getDeletionPreview).mockRejectedValue(
			new Error("network down"),
		);

		await askWhatWillHappen();

		expect(
			await screen.findByText(/couldn't check what deleting will remove/i),
		).toBeInTheDocument();
	});

	// Spec D5, and the guard worth proving by ablation. Closing your own
	// account must not depend on a disclosure query succeeding - the
	// irreversible case is already guarded by the sole-owner 409.
	it("still allows deletion after a failed preview", async () => {
		vi.mocked(api.getDeletionPreview).mockRejectedValue(
			new Error("network down"),
		);
		vi.mocked(api.deleteAccount).mockResolvedValue({ success: true });
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
		await screen.findByText(/couldn't check what deleting will remove/i);

		await user.type(
			screen.getByLabelText(/type your email/i),
			"ada@example.com",
		);
		await user.click(
			screen.getByRole("button", { name: /permanently delete/i }),
		);

		await vi.waitFor(() => expect(api.deleteAccount).toHaveBeenCalled());
	});
});
