import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = {
	user: null as { id: string; email: string } | null,
	loading: false,
	unavailable: null as { retryAt: number } | null,
};
const retrySession = vi.fn();

vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({
			...authState,
			retrySession,
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
		authState.unavailable = null;
		retrySession.mockClear();
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

	// ONL-243: an unreachable session is not a signed-out one. Sending it to
	// /login would read as having been logged out during a 429.
	it("says it can't reach Onlooker, rather than logging in, while the session is unreachable", () => {
		authState.unavailable = { retryAt: Date.now() + 30_000 };

		render(
			<MemoryRouter initialEntries={["/"]}>
				<App />
			</MemoryRouter>,
		);

		expect(screen.queryByLabelText(/password/i)).toBeNull();
		expect(screen.getByRole("status").textContent).toMatch(
			/can't reach onlooker right now/i,
		);

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(retrySession).toHaveBeenCalledTimes(1);
	});

	// ONL-247. A retry in flight sets loading again while the last failure's
	// unavailable is still there. Loading wins: the check is running now.
	it("shows loading, not the notice, while a retry is in flight", () => {
		authState.loading = true;
		authState.unavailable = { retryAt: Date.now() + 30_000 };

		render(
			<MemoryRouter initialEntries={["/"]}>
				<App />
			</MemoryRouter>,
		);

		expect(screen.queryByLabelText(/password/i)).toBeNull();
		expect(screen.getByRole("status").textContent).toMatch(/loading/i);
	});
});
