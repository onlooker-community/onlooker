import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// App reaches for the API client at module scope and RequireAuth would bounce
// an unauthenticated render, so auth is the seam - the same one
// app-error-boundary.test.tsx uses. Everything else stays real, because the
// thing under test is App's wiring rather than any single page.
vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({
			user: { id: "u1", email: "someone@example.com", name: "Someone" },
			loading: false,
			logout: vi.fn(),
			refresh: vi.fn(),
			sessionExpiresAt: null,
			sessionExpiringSoon: false,
		}),
		RequireAuth: ({ children }: { children: React.ReactNode }) => children,
	},
}));

// ProfilePage fetches on mount. Left unmocked it would try a real request and
// the page would render its loading branch, which still renders the shell -
// but a stub keeps the test about routing rather than about timing.
vi.mock("../hooks/useAuthenticatedFetch", () => ({
	useAuthenticatedFetch: () => ({
		data: {
			name: "Someone",
			email: "someone@example.com",
			createdAt: "2026-01-01T00:00:00.000Z",
			lastLoginAt: "2026-08-30T00:00:00.000Z",
		},
		loading: false,
		error: null,
		refetch: vi.fn(),
	}),
}));

// SettingsPage calls getProfile() on mount, same reason as the fetch stub
// above - a stub keeps the test about routing rather than about timing.
vi.mock("../api/accountApi", () => ({
	getProfile: () =>
		Promise.resolve({
			user: {
				id: "u1",
				name: "Someone",
				email: "someone@example.com",
				emailVerified: true,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		}),
	updateProfile: vi.fn(),
	changePassword: vi.fn(),
	deleteAccount: vi.fn(),
	resendVerificationEmail: vi.fn(),
}));

const { default: App } = await import("../App");

function renderAppAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<App />
		</MemoryRouter>,
	);
}

describe("account routes", () => {
	// The whole point of the change: before this, a signed-in person who
	// reached /profile lost the navigation and had to use browser-back.
	it("renders /profile inside the shell", () => {
		renderAppAt("/profile");
		const href = (name: RegExp) =>
			screen.getByRole("link", { name }).getAttribute("href");
		expect(href(/lessons/i)).toBe("/lessons");
		expect(href(/machines/i)).toBe("/machines");
		expect(href(/settings/i)).toBe("/settings");
	});

	// The hand-rolled <nav> existed only because there was no shell. Leaving it
	// would mean two sets of links to the same places - one from AppShell, one
	// from the page itself. Its accessible name was "Back to the pool", not
	// "Lessons", so asserting on the shell's own link text would not catch it
	// coming back.
	it("does not keep a second set of links on /profile", () => {
		renderAppAt("/profile");
		expect(screen.getAllByRole("navigation")).toHaveLength(1);
		expect(
			screen.queryByRole("link", { name: /back to the pool/i }),
		).toBeNull();
	});

	// Profile took sole ownership of the account overview in Task 2, so the
	// fields have to survive the move. Settings' copy showed three of these
	// and called the date something else; this is what stops the surviving
	// copy quietly shedding one.
	it("shows every account field on /profile", () => {
		renderAppAt("/profile");
		expect(screen.getByText("Name")).toBeDefined();
		expect(screen.getByText("Email")).toBeDefined();
		expect(screen.getByText("Account created")).toBeDefined();
		expect(screen.getByText("Last login")).toBeDefined();
	});

	it("renders /settings inside the shell", () => {
		renderAppAt("/settings");
		const href = (name: RegExp) =>
			screen.getByRole("link", { name }).getAttribute("href");
		expect(href(/lessons/i)).toBe("/lessons");
		expect(href(/machines/i)).toBe("/machines");
		expect(href(/profile/i)).toBe("/profile");
	});

	// One fact, one home. Settings and Profile both showed the account
	// overview and had already drifted - Settings said "Member since" and
	// never showed last login. Profile owns it now, and this is what stops
	// the second copy growing back.
	it("does not show an account overview on /settings", () => {
		renderAppAt("/settings");
		expect(screen.queryByRole("heading", { name: /^profile$/i })).toBeNull();
	});
});
