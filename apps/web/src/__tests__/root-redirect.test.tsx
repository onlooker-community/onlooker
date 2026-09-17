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

// Export names taken from apps/web/src/api/lessonsApi.ts: the signed-in case
// lands on /lessons, which fetches on mount, and a mock missing an export the
// page imports fails at module load rather than in the assertion.
vi.mock("../api/lessonsApi", () => ({
	LESSON_ENDPOINTS: { lessons: "/api/lessons" },
	listLessons: () => Promise.resolve({ lessons: [], nextCursor: null }),
	getLesson: vi.fn(),
	setLessonStatus: vi.fn(),
	listActivity: () => Promise.resolve({ events: [], nextCursor: null }),
}));

const { default: App } = await import("../App");

describe("/", () => {
	beforeEach(() => {
		authState.user = null;
		authState.loading = false;
	});

	it("sends a signed-out visitor to log in", async () => {
		render(
			<MemoryRouter initialEntries={["/"]}>
				<App />
			</MemoryRouter>,
		);

		expect(await screen.findByLabelText(/password/i)).toBeDefined();
	});

	it("sends a signed-in person to the pool", async () => {
		authState.user = { id: "u1", email: "someone@example.com" };

		render(
			<MemoryRouter initialEntries={["/"]}>
				<App />
			</MemoryRouter>,
		);

		expect(
			await screen.findByRole("navigation", { name: /sections/i }),
		).toBeDefined();
	});

	// The bug this route is most likely to grow. Deciding on an unresolved
	// session would bounce a signed-in person refreshing / to the login form
	// and then back, which reads as having been logged out.
	it("decides nothing while the session is still loading", () => {
		authState.loading = true;

		render(
			<MemoryRouter initialEntries={["/"]}>
				<App />
			</MemoryRouter>,
		);

		expect(screen.queryByLabelText(/password/i)).toBeNull();
		expect(screen.getByRole("status").textContent).toMatch(/loading/i);
	});
});
