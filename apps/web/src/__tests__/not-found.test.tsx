import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = {
	user: null as { id: string; email: string } | null,
	loading: false,
};

vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({
			...authState,
			logout: vi.fn(),
			refresh: vi.fn(),
			sessionExpiresAt: null,
			sessionExpiringSoon: false,
		}),
		RequireAuth: ({ children }: { children: React.ReactNode }) => children,
	},
}));

const { default: App } = await import("../App");

function renderAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<App />
		</MemoryRouter>,
	);
}

describe("a path that matches nothing", () => {
	beforeEach(() => {
		authState.user = null;
		authState.loading = false;
	});

	// An h1, not an h2. AppShell deliberately renders no heading for a route
	// absent from SECTIONS, so if this page does not carry its own the page has
	// no h1 at all.
	it("leads with a first-level heading", () => {
		renderAt("/nothing-here");

		expect(
			screen.getByRole("heading", { level: 1, name: /page not found/i }),
		).toBeDefined();
	});

	// Not behind RequireAuth on purpose: someone who mistypes a URL should be
	// told the page does not exist, not asked to log in for it.
	it("does not send a signed-out visitor to log in", () => {
		renderAt("/nothing-here");

		expect(screen.queryByLabelText(/password/i)).toBeNull();
		expect(screen.queryByRole("navigation", { name: /sections/i })).toBeNull();
	});

	it("keeps the nav for someone who is signed in", () => {
		authState.user = { id: "u1", email: "someone@example.com" };

		renderAt("/nothing-here");

		expect(screen.getByRole("navigation", { name: /sections/i })).toBeDefined();
	});

	// A signed-in person heading somewhere real must not be told it does not
	// exist while their session is still resolving.
	it("says nothing about missing pages while the session loads", () => {
		authState.loading = true;

		renderAt("/nothing-here");

		expect(screen.queryByText(/page not found/i)).toBeNull();
		expect(screen.getByRole("status").textContent).toMatch(/loading/i);
	});
});
