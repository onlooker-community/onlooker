import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// auth is the seam, as in login-page.test.tsx: stubbing useAuth lets the nav,
// the router and the logout path stay real without standing up an API client.
// SessionExpiryBanner reads the same hook, so its inputs are set here too.
const mocks = vi.hoisted(() => ({
	logout: vi.fn(),
	refresh: vi.fn(),
	state: {
		user: { id: "u1", email: "someone@example.com" } as {
			id: string;
			email: string;
			name?: string;
		} | null,
		sessionExpiresAt: null as number | null,
		sessionExpiringSoon: false,
	},
}));

vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({
			user: mocks.state.user,
			logout: mocks.logout,
			refresh: mocks.refresh,
			sessionExpiresAt: mocks.state.sessionExpiresAt,
			sessionExpiringSoon: mocks.state.sessionExpiringSoon,
		}),
	},
}));

const { default: AppShell } = await import("../components/AppShell");

function renderShell(path = "/lessons") {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<Routes>
				<Route path="/" element={<p>home reached</p>} />
				<Route
					path="*"
					element={
						<AppShell>
							<p>page body</p>
						</AppShell>
					}
				/>
			</Routes>
		</MemoryRouter>,
	);
}

beforeEach(() => {
	mocks.logout.mockReset().mockResolvedValue(undefined);
	mocks.refresh.mockReset();
	mocks.state.user = { id: "u1", email: "someone@example.com" };
	mocks.state.sessionExpiresAt = null;
	mocks.state.sessionExpiringSoon = false;
});

describe("AppShell", () => {
	it("renders the page it wraps", () => {
		renderShell();
		expect(screen.getByText("page body")).toBeDefined();
	});

	// The nav is the only way to reach the other surfaces now that /dashboard
	// and its ad-hoc <nav> are gone.
	it("links to every authenticated surface", () => {
		renderShell();
		const href = (name: RegExp) =>
			screen.getByRole("link", { name }).getAttribute("href");
		expect(href(/lessons/i)).toBe("/lessons");
		expect(href(/machines/i)).toBe("/machines");
		expect(href(/settings/i)).toBe("/settings");
		expect(href(/profile/i)).toBe("/profile");
	});

	// Without this the nav is four identical links and nothing says which of
	// them you are looking at - to a screen reader, nothing says it at all.
	it("marks the surface the user is on", () => {
		renderShell("/machines");
		expect(
			screen
				.getByRole("link", { name: /machines/i })
				.getAttribute("aria-current"),
		).toBe("page");
		expect(
			screen
				.getByRole("link", { name: /lessons/i })
				.getAttribute("aria-current"),
		).toBeNull();
	});

	it("signs out and returns to the public home page", async () => {
		renderShell();
		fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
		await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.getByText("home reached")).toBeDefined());
	});

	// The banner used to live on DashboardPage. Moving it into the shell before
	// onlooker-yfw deleted that page is why the only warning that a silent
	// token refresh failed didn't disappear with it.
	it("carries the session expiry warning", () => {
		mocks.state.sessionExpiresAt = Date.now() + 90_000;
		mocks.state.sessionExpiringSoon = true;
		renderShell();
		expect(screen.getByRole("alert")).toBeDefined();
	});

	it("shows no warning while the session is healthy", () => {
		renderShell();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	// Which account you are signed into decides whose pool you are looking at,
	// and the shell is the only place that now says.
	it("names the signed-in person", () => {
		renderShell();
		expect(screen.getByText(/someone@example\.com/)).toBeDefined();
	});
});
