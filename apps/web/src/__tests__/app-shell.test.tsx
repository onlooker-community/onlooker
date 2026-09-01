import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RevealHost, RevealProvider, useReveal } from "../reveal";

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

// AppShell now reads useReveal, which throws outside a RevealProvider - so
// every render needs one, not just the tests in the describe block below that
// exercise it directly.
function renderShell(path = "/lessons") {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<RevealProvider>
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
			</RevealProvider>
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
		expect(href(/activity/i)).toBe("/activity");
		expect(href(/settings/i)).toBe("/settings");
		expect(href(/profile/i)).toBe("/profile");
	});

	// Without this the nav is five identical links and nothing says which of
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

	// CC BY 4.0 requires credit wherever the icons ship. A footer on the shell puts
	// it on every authenticated page for as long as the icons are on screen, which
	// is what the condition asks for and what an /about route nobody visits does
	// not.
	it("credits the icon set and links its license", () => {
		renderShell();
		const footer = screen.getByRole("contentinfo");
		expect(footer.textContent).toContain("Crusenho Agus Hennihuno");
		expect(
			screen.getByRole("link", { name: /CC BY 4\.0/i }).getAttribute("href"),
		).toBe("https://creativecommons.org/licenses/by/4.0/");
	});

	// The nav is five identical links plus a wordmark; the icons are what make
	// them scannable at a glance rather than a column of same-shaped words.
	it("gives the wordmark and every nav link an icon", () => {
		renderShell();
		const icons = document.querySelectorAll("img.pixel-icon");
		expect(icons.length).toBe(6);
		// Array.from, not a bare for-of: the project's `lib` has no DOM.Iterable,
		// so NodeListOf<Element> is not directly iterable under this tsconfig.
		for (const img of Array.from(icons)) {
			expect(img.getAttribute("width")).toBe("16");
			expect(img.getAttribute("src")).toBeTruthy();
		}
	});
});

const MACHINE = {
	id: "m1",
	name: "work laptop",
	token: `onlk_${"a".repeat(64)}`,
};

function Minter() {
	const { reveal } = useReveal();
	return (
		<button type="button" onClick={() => reveal(MACHINE)}>
			mint
		</button>
	);
}

describe("AppShell while a token is revealed", () => {
	// aria-modal is advisory: a screen reader's virtual cursor can still browse
	// into the nav the focus trap exists to protect. `inert` is what actually
	// removes it, from the accessibility tree and from focus together.
	it("is inert while the reveal is open and not before", () => {
		const { container } = render(
			<MemoryRouter>
				<RevealProvider>
					<AppShell>
						<Minter />
					</AppShell>
					<RevealHost />
				</RevealProvider>
			</MemoryRouter>,
		);
		const shell = container.firstElementChild as HTMLElement;
		expect(shell.hasAttribute("inert")).toBe(false);
		act(() => {
			screen.getByText("mint").click();
		});
		expect(shell.hasAttribute("inert")).toBe(true);
	});

	it("stops being inert once the reveal is dismissed", () => {
		const { container } = render(
			<MemoryRouter>
				<RevealProvider>
					<AppShell>
						<Minter />
					</AppShell>
					<RevealHost />
				</RevealProvider>
			</MemoryRouter>,
		);
		const shell = container.firstElementChild as HTMLElement;
		act(() => {
			screen.getByText("mint").click();
		});
		act(() => {
			screen.getByRole("button", { name: /saved it/i }).click();
		});
		expect(shell.hasAttribute("inert")).toBe(false);
	});
});
