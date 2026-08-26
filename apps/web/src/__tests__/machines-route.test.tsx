import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// auth and machinesApi are both stubbed; everything between them - App's route
// table, RequireAuth, AppShell - stays real. machines-page.test.tsx covers what
// the page does, so the only assertions here are about reaching it at all.
vi.mock("../auth", () => ({
	auth: {
		RequireAuth: ({ children }: { children: unknown }) => children,
		useAuth: () => ({
			user: { id: "u1", email: "someone@example.com" },
			logout: vi.fn(),
			refresh: vi.fn(),
			sessionExpiresAt: null,
			sessionExpiringSoon: false,
		}),
	},
}));

vi.mock("../api/machinesApi", () => ({
	MACHINE_ENDPOINTS: { machines: "/api/machines" },
	listMachines: vi.fn().mockResolvedValue({ machines: [] }),
	createMachine: vi.fn(),
	revokeMachine: vi.fn(),
}));

const { default: App } = await import("../App");

describe("/machines", () => {
	it("renders the machines page inside the app shell", async () => {
		render(
			<MemoryRouter initialEntries={["/machines"]}>
				<App />
			</MemoryRouter>,
		);

		expect(await screen.findByLabelText(/machine name/i)).toBeDefined();
		// The shell, not just the page: /machines is the first route to mount
		// AppShell, so this is where a missing wrapper would show up.
		expect(screen.getByRole("navigation", { name: /sections/i })).toBeDefined();
		await waitFor(() =>
			expect(
				screen
					.getByRole("link", { name: /machines/i })
					.getAttribute("aria-current"),
			).toBe("page"),
		);
	});
});
