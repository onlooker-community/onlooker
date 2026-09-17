import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// Unlike the other route tests, RequireAuth is NOT a passthrough here. It
// honors loadingFallback exactly as packages/auth-react does, because the bug
// this covers is that apps/web never passed one - a passthrough mock would
// render the page and the test would pass against the broken code.
vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({
			user: null,
			loading: true,
			logout: vi.fn(),
			refresh: vi.fn(),
			sessionExpiresAt: null,
			sessionExpiringSoon: false,
		}),
		RequireAuth: ({
			loadingFallback,
		}: {
			children: React.ReactNode;
			loadingFallback?: React.ReactNode;
		}) => loadingFallback ?? null,
	},
}));

const { default: App } = await import("../App");

describe("an authenticated route while the session is still loading", () => {
	// The symptom was a blank white page on every hard refresh of five routes.
	// Asserting on the nav rather than on the loading text is deliberate: the
	// nav is the part whose absence people actually experienced.
	it("renders the app frame rather than nothing", () => {
		render(
			<MemoryRouter initialEntries={["/machines"]}>
				<App />
			</MemoryRouter>,
		);

		expect(screen.getByRole("navigation", { name: /sections/i })).toBeDefined();
		expect(screen.getByRole("status").textContent).toMatch(/loading/i);
	});
});
