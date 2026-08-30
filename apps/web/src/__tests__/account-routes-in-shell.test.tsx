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
	// would mean two sets of links to the same places.
	it("does not keep a second set of links on /profile", () => {
		renderAppAt("/profile");
		expect(screen.getAllByRole("link", { name: /lessons/i })).toHaveLength(1);
	});
});
