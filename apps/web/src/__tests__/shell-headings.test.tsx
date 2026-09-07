import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// The same seam account-routes-in-shell.test.tsx uses: App reaches for the API
// client at module scope and RequireAuth would bounce an unauthenticated
// render. Everything else stays real, because the thing under test is the
// shell's wiring rather than any single page.
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

// Every shell page fetches on mount. The heading comes from AppShell rather
// than from any page, so it is there whichever branch a page renders - these
// stubs keep the tests about the heading rather than about timing, and keep
// unhandled rejections out of the output.
vi.mock("../hooks/useAuthenticatedFetch", () => ({
	useAuthenticatedFetch: () => ({
		data: null,
		loading: false,
		error: null,
		refetch: vi.fn(),
	}),
}));
vi.mock("../api/accountApi", () => ({
	getProfile: () => Promise.resolve({ user: null }),
	updateProfile: vi.fn(),
	changePassword: vi.fn(),
	deleteAccount: vi.fn(),
	resendVerificationEmail: vi.fn(),
}));
vi.mock("../api/machinesApi", () => ({
	MACHINE_ENDPOINTS: { machines: "/api/machines" },
	listMachines: () => Promise.resolve({ machines: [] }),
	createMachine: vi.fn(),
	revokeMachine: vi.fn(),
}));
vi.mock("../api/lessonsApi", () => ({
	listLessons: () =>
		Promise.resolve({ lessons: [], cursor: null, has_more: false }),
	getLesson: vi.fn(),
	updateLessonStatus: vi.fn(),
}));

const { default: App } = await import("../App");
const { SECTIONS } = await import("../components/AppShell");

function renderAppAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<App />
		</MemoryRouter>,
	);
}

describe("the page heading on shell routes", () => {
	// Driven off SECTIONS rather than a hand-written list, so a route added to
	// the nav is covered without anyone remembering to extend this test. That
	// is what makes this a policy rather than a description of five pages.
	//
	// Equality, not a match: the whole reason the h1 is rendered from SECTIONS
	// is so the heading and the nav label cannot drift. Before this, the nav
	// announced "Settings, current page" and the first heading then said
	// "Account settings".
	it.each(
		SECTIONS.map((section) => [section.to, section.label]),
	)("names %s with an h1 reading exactly %s", (to, label) => {
		renderAppAt(to);
		const headings = screen.getAllByRole("heading", { level: 1 });
		expect(headings).toHaveLength(1);
		expect(headings[0].textContent).toBe(label);
	});

	// The regression this design is most likely to suffer. /lessons/:id renders
	// LessonDetail inside LessonsPage through an Outlet, so re-promoting the
	// claim to h1 would put two on the route - and a test that only looked at
	// /lessons would never see it.
	it("keeps one h1 on a lesson detail route", () => {
		renderAppAt("/lessons/some-lesson-id");
		const headings = screen.getAllByRole("heading", { level: 1 });
		expect(headings).toHaveLength(1);
		expect(headings[0].textContent).toBe("Lessons");
	});
});
