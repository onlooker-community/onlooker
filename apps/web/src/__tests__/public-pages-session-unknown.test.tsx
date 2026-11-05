import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ONL-247. The public pages offered a sign-in link to anyone without a user,
// including someone whose session is only unreachable or still loading.
// Neither of those is signed out, and the link said they were.
const authState = {
	user: null as { id: string; email: string } | null,
	loading: false,
	unavailable: null as { retryAt: number } | null,
};

vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({
			...authState,
			retrySession: vi.fn(),
			logout: vi.fn(),
			refresh: vi.fn(),
			sessionExpiresAt: null,
			sessionExpiringSoon: false,
		}),
		RequireAuth: ({ children }: { children: React.ReactNode }) => children,
	},
}));

const verifyEmail = vi.fn();
vi.mock("../api/accountApi", () => ({
	verifyEmail: (...args: unknown[]) => verifyEmail(...args),
	resendVerificationEmail: vi.fn(),
}));

const { default: NotFoundPage } = await import("../pages/NotFoundPage");
const { default: VerifyEmailPage } = await import("../pages/VerifyEmailPage");

function renderAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<Routes>
				<Route path="/verify-email/:token" element={<VerifyEmailPage />} />
				<Route path="*" element={<NotFoundPage />} />
			</Routes>
		</MemoryRouter>,
	);
}

const unreachable = () => {
	authState.unavailable = { retryAt: Date.now() + 30_000 };
};

beforeEach(() => {
	authState.user = null;
	authState.loading = false;
	authState.unavailable = null;
	verifyEmail.mockReset();
});

describe("the not-found page", () => {
	it("offers sign-in once the session is known to be gone", () => {
		renderAt("/nowhere");
		expect(screen.getByRole("link", { name: "Sign in" })).toBeDefined();
	});

	it("does not offer sign-in while the session is unreachable", () => {
		unreachable();
		renderAt("/nowhere");
		expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
		const onward = screen.getByRole("link", { name: "Continue to Onlooker" });
		expect(onward.getAttribute("href")).toBe("/");
	});
});

describe("the verify-email page", () => {
	describe("after a link that verified", () => {
		// Braced: a function returned from beforeEach runs as its teardown.
		beforeEach(() => {
			verifyEmail.mockResolvedValue(undefined);
		});

		it("offers login once the session is known to be gone", async () => {
			renderAt("/verify-email/tok");
			expect(
				await screen.findByRole("link", { name: "Go to login" }),
			).toBeDefined();
		});

		it("does not offer login while the session is unreachable", async () => {
			unreachable();
			renderAt("/verify-email/tok");
			await screen.findByText(/email verified/i);
			expect(screen.queryByRole("link", { name: "Go to login" })).toBeNull();
			expect(
				screen
					.getByRole("link", { name: "Continue to Onlooker" })
					.getAttribute("href"),
			).toBe("/");
		});

		it("does not offer login while the session is still loading", async () => {
			authState.loading = true;
			renderAt("/verify-email/tok");
			await screen.findByText(/email verified/i);
			expect(screen.queryByRole("link", { name: "Go to login" })).toBeNull();
		});
	});

	describe("after a link that failed", () => {
		beforeEach(() => {
			verifyEmail.mockRejectedValue(new Error("expired"));
		});

		it("offers login once the session is known to be gone", async () => {
			renderAt("/verify-email/tok");
			expect(
				await screen.findByRole("link", { name: "Back to login" }),
			).toBeDefined();
		});

		it("does not offer login while the session is unreachable", async () => {
			unreachable();
			renderAt("/verify-email/tok");
			await screen.findByText(/verification failed/i);
			expect(screen.queryByRole("link", { name: "Back to login" })).toBeNull();
			expect(
				screen
					.getByRole("link", { name: "Continue to Onlooker" })
					.getAttribute("href"),
			).toBe("/");
		});
	});
});
