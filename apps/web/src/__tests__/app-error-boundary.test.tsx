import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A boundary that exists but is not mounted is worth nothing, and that is not a
// hypothetical - this repo carried five git hooks that were checked in and never
// installed, for exactly as long as nobody tested whether they ran. So this
// covers the wiring in App rather than the component: a real page is replaced
// with one that throws, and App is rendered for real.
vi.mock("../pages/ProfilePage", () => ({
	default: () => {
		throw new Error("ProfilePage exploded");
	},
}));

// App pulls in auth at module scope, which reaches for the API client. None of
// that is under test here. RequireAuth passes through so /profile is reachable.
vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({ user: null, loading: false }),
		RequireAuth: ({ children }: { children: React.ReactNode }) => children,
	},
}));

const { default: App } = await import("../App");

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	consoleError.mockRestore();
});

function renderAppAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<App />
		</MemoryRouter>,
	);
}

describe("App", () => {
	it("catches a throwing route instead of unmounting everything", () => {
		renderAppAt("/profile");

		// The failure this replaces rendered an empty document, so what matters
		// most is that anything survived at all.
		expect(screen.getByRole("alert")).toBeDefined();
		expect(screen.getByText(/something went wrong/i)).toBeDefined();
		expect(screen.getByText(/ProfilePage exploded/)).toBeDefined();
	});

	// The boundary is keyed by pathname in App. Without that key it stays caught
	// forever and every later route renders the fallback too, so this navigates
	// for real rather than trusting the key is there.
	it("recovers on navigation, rather than holding the fallback forever", () => {
		renderAppAt("/profile");
		expect(screen.getByRole("alert")).toBeDefined();

		fireEvent.click(screen.getByRole("link", { name: /home/i }));

		expect(screen.getByText("Onlooker")).toBeDefined();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("leaves routes that do not throw alone", () => {
		renderAppAt("/login");

		expect(screen.queryByRole("alert")).toBeNull();
	});

	// The keyed boundary existed because a boundary that has caught stays
	// caught. Replacing the key with resetKey has to keep that: catching on
	// one route and navigating away must clear it, or the user is stranded on
	// the fallback for the rest of the session.
	it("stays clear and keeps routing usable after the boundary has recovered", () => {
		renderAppAt("/profile");
		expect(screen.getByRole("alert")).toBeDefined();

		fireEvent.click(screen.getByRole("link", { name: /home/i }));
		expect(screen.queryByRole("alert")).toBeNull();

		// A second hop, not just "no alert": proves the recovered subtree is
		// genuinely live rather than merely blank, and exercises a second
		// resetKey change while state.error is already null - the case the
		// guard in componentDidUpdate has to no-op on.
		fireEvent.click(screen.getByRole("link", { name: /log in/i }));
		expect(screen.getByRole("heading", { name: /login/i })).toBeDefined();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
