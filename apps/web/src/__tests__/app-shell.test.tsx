import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RevealProvider } from "../reveal";

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

// Orgs, Settings, Profile and Sign out live behind the signed-in person's name
// (ONL-218), and like the narrow menu the dropdown is rendered only while open.
const accountButton = () =>
	screen.getByRole("button", { name: /someone@example\.com/i });
const openAccountMenu = () => fireEvent.click(accountButton());

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
		openAccountMenu();
		const href = (name: RegExp) =>
			screen.getByRole("link", { name }).getAttribute("href");
		expect(href(/lessons/i)).toBe("/lessons");
		expect(href(/machines/i)).toBe("/machines");
		expect(href(/activity/i)).toBe("/activity");
		expect(href(/sessions/i)).toBe("/sessions");
		expect(href(/orgs/i)).toBe("/orgs");
		expect(href(/settings/i)).toBe("/settings");
		expect(href(/profile/i)).toBe("/profile");
	});

	// Without this the nav is seven identical links and nothing says which of
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

	// ONL-218. It was a span that looked exactly like the links around it, so
	// clicking it did nothing. It goes home rather than to a section, which is
	// why it is a plain link and never marked as the current page.
	it("links the wordmark home", () => {
		renderShell();
		const wordmark = screen.getByRole("link", { name: /onlooker/i });
		expect(wordmark.getAttribute("href")).toBe("/");
		expect(wordmark.getAttribute("aria-current")).toBeNull();
	});

	// Weight, not an underline (ONL-218). In the stacked menus an underlined
	// link sitting above a divider read as two rules. Weight is still a cue
	// that is not hue alone.
	it("shows the current section in bold, with no underline", () => {
		renderShell("/machines");
		const current = screen.getByRole("link", { name: /machines/i });
		const other = screen.getByRole("link", { name: /lessons/i });
		expect(current.style.fontWeight).toBe("700");
		expect(other.style.fontWeight).toBe("400");
		expect(current.style.borderBottom).toBe("");
	});

	it("signs out and returns to the public home page", async () => {
		renderShell();
		openAccountMenu();
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

	// The nav is seven identical links plus a wordmark; the icons are what make
	// them scannable at a glance rather than a column of same-shaped words.
	it("gives the wordmark and every nav link an icon", () => {
		renderShell();
		openAccountMenu();
		const icons = document.querySelectorAll("img.pixel-icon");
		expect(icons.length).toBe(8);
		// Array.from, not a bare for-of: the project's `lib` has no DOM.Iterable,
		// so NodeListOf<Element> is not directly iterable under this tsconfig.
		for (const img of Array.from(icons)) {
			expect(img.getAttribute("src")).toBeTruthy();
		}
		// The wordmark's eye is drawn at the wordmark's own 32px, and every link
		// icon at 16. A difference in size is part of what keeps the brand from
		// reading as one more section (ONL-218).
		const wordmark = screen.getByRole("link", { name: /onlooker/i });
		const sizes = Array.from(icons).map((img) => img.getAttribute("width"));
		expect(wordmark.querySelector("img")?.getAttribute("width")).toBe("32");
		expect(sizes.filter((w) => w === "16").length).toBe(7);
	});
});

// ONL-218. Who you are collapsed into one control, so the bar holds the
// product and the brand and nothing else. The same disclosure contract as
// the narrow menu below, plus a click outside closing it: this one opens
// over the page rather than pushing it down, so it would otherwise sit on
// top of whatever the person went back to.
describe("the account menu", () => {
	const accountMenu = () => document.getElementById("app-account-menu");

	it("starts closed, and says so", () => {
		renderShell();
		expect(accountButton().getAttribute("aria-expanded")).toBe("false");
		expect(accountMenu()).toBeNull();
		// Product sections stay in the bar; account ones are behind the button.
		expect(screen.getByRole("link", { name: /sessions/i })).toBeTruthy();
		expect(screen.queryByRole("link", { name: /orgs/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
	});

	it("opens to Orgs, Settings, Profile and Sign out", () => {
		renderShell();
		openAccountMenu();

		expect(accountButton().getAttribute("aria-expanded")).toBe("true");
		expect(accountButton().getAttribute("aria-controls")).toBe(
			"app-account-menu",
		);
		const menu = accountMenu() as HTMLElement;
		expect(menu).not.toBeNull();
		for (const [label, to] of [
			["Orgs", "/orgs"],
			["Settings", "/settings"],
			["Profile", "/profile"],
		]) {
			expect(
				within(menu)
					.getByRole("link", { name: new RegExp(label, "i") })
					.getAttribute("href"),
			).toBe(to);
		}
		expect(
			within(menu).getByRole("button", { name: /sign out/i }),
		).toBeTruthy();
	});

	it("closes on Escape and hands focus back to the button", () => {
		renderShell();
		openAccountMenu();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(accountMenu()).toBeNull();
		expect(document.activeElement).toBe(accountButton());
	});

	it("closes when a section is opened from it", () => {
		renderShell();
		openAccountMenu();
		fireEvent.click(
			within(accountMenu() as HTMLElement).getByRole("link", {
				name: /settings/i,
			}),
		);
		expect(accountMenu()).toBeNull();
		expect(accountButton().getAttribute("aria-expanded")).toBe("false");
	});

	it("closes on a click outside it, and not on one inside", () => {
		renderShell();
		openAccountMenu();
		fireEvent.mouseDown(accountMenu() as HTMLElement);
		expect(accountMenu()).not.toBeNull();
		fireEvent.mouseDown(screen.getByText("page body"));
		expect(accountMenu()).toBeNull();
	});
});

// The two `inert` tests that lived here moved to reveal.test.tsx when `inert`
// was hoisted off AppShell onto InertWhileRevealed, so it would also cover the
// routes AppShell does not render (onlooker-zq1). The behavior did not go
// away, only its owner.

// ONL-178. The header became a split bar - product links left, wordmark
// centre, account right - that collapses below 60rem behind a Menu toggle.
// None of the widths are testable here: jsdom processes no CSS, so both
// groups and the toggle are always in the document and the breakpoint does
// nothing. What IS testable is the disclosure contract, which is the part
// that was argued against in ONL-176 on the grounds that it costs state,
// focus management and an aria-expanded contract. This is that cost, paid.
describe("the header's menu toggle", () => {
	const toggle = () => screen.getByRole("button", { name: /menu|close/i });

	it("starts closed, and says so", () => {
		renderShell();

		expect(toggle().getAttribute("aria-expanded")).toBe("false");
		// Rendered only when open, so it is absent rather than hidden - which
		// is what keeps a second copy of every link out of the queries the
		// rest of this file makes.
		expect(document.getElementById("app-menu")).toBeNull();
	});

	it("opens to a panel the button owns, carrying every section", () => {
		renderShell();
		fireEvent.click(toggle());

		expect(toggle().getAttribute("aria-expanded")).toBe("true");

		const menu = document.getElementById("app-menu");
		expect(menu).not.toBeNull();
		// aria-controls is the tie between the two, and a panel id that did
		// not match would leave the button pointing at nothing.
		expect(toggle().getAttribute("aria-controls")).toBe("app-menu");

		// Every section, not just the product ones: the collapsed layout is
		// the ONLY way to reach Settings and Profile at that width.
		for (const label of [
			"Lessons",
			"Machines",
			"Activity",
			"Sessions",
			"Orgs",
			"Settings",
			"Profile",
		]) {
			expect(
				within(menu as HTMLElement).getByRole("link", {
					name: new RegExp(label, "i"),
				}),
			).toBeTruthy();
		}
	});

	it("closes on Escape and hands focus back to the button", () => {
		renderShell();
		fireEvent.click(toggle());
		expect(document.getElementById("app-menu")).not.toBeNull();

		fireEvent.keyDown(document, { key: "Escape" });

		expect(document.getElementById("app-menu")).toBeNull();
		// The second half, and the one that is easy to omit: without it focus
		// sits on an element that is no longer in the accessibility tree and
		// the next Tab restarts from the top of the document.
		expect(document.activeElement).toBe(toggle());
	});

	it("closes when a section is opened from it", () => {
		renderShell();
		fireEvent.click(toggle());

		const menu = document.getElementById("app-menu") as HTMLElement;
		fireEvent.click(within(menu).getByRole("link", { name: /machines/i }));

		// Otherwise the menu stays up over the page it just opened, and the
		// tap reads as having done nothing.
		expect(document.getElementById("app-menu")).toBeNull();
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
	});
});
