import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real App route table, the real RevealProvider, the real auth module and
// the real AuthProvider. Only the transport is stubbed: `../api/client` owns
// both the session's tokens and the terminal-401 signal, so replacing it is
// what lets these tests fire auth.ts's own unauthorized handler rather than a
// stand-in that could drift from it.
//
// reveal.test.tsx proves the provider against a synthetic tree with no router.
// This file is the one that would notice the provider being moved back down
// inside a route element, which is the change that reintroduces both of the
// bugs this branch exists to fix.
const mocks = vi.hoisted(() => ({
	token: null as string | null,
	refreshToken: null as string | null,
	/** The handler auth.ts registers at import; the API client calls it on a
	 * mid-session 401 whose refresh failed. */
	unauthorized: null as (() => void) | null,
	get: vi.fn(),
	post: vi.fn(),
	listMachines: vi.fn(),
	createMachine: vi.fn(),
	getProfile: vi.fn(),
	deleteAccount: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/client")>()),
	apiClient: { get: mocks.get, post: mocks.post },
	refreshTokens: vi.fn(),
	setUnauthorizedHandler: (handler: (() => void) | null) => {
		mocks.unauthorized = handler;
	},
	tokenStore: {
		// An opaque token on purpose: getTokenExpiration returns null for one,
		// so no warning or proactive-refresh timer is scheduled and these tests
		// are not racing a background renewal.
		getToken: () => mocks.token,
		setToken: (value: string) => {
			mocks.token = value;
		},
		clearToken: () => {
			mocks.token = null;
		},
		getRefreshToken: () => mocks.refreshToken,
		setRefreshToken: (value: string) => {
			mocks.refreshToken = value;
		},
		clear: () => {
			mocks.token = null;
			mocks.refreshToken = null;
		},
	},
}));

// Spread the originals rather than list every export: these modules are
// imported by pages all over the route table, and a mock that names only the
// functions used here breaks the ones that are merely in the import graph.
// `../api/client` above gets the same treatment - `activeApiConfig` and
// `authenticatedFetch` come through real, and `reveal.tsx` now reads the
// storage key from that config.
vi.mock("../api/machinesApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/machinesApi")>()),
	listMachines: mocks.listMachines,
	createMachine: mocks.createMachine,
	revokeMachine: vi.fn(),
}));

vi.mock("../api/accountApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/accountApi")>()),
	getProfile: mocks.getProfile,
	deleteAccount: mocks.deleteAccount,
}));

const { default: App } = await import("../App");
const { auth } = await import("../auth");

const USER = { id: "u1", email: "someone@example.com", name: "Someone" };
const MINTED = {
	id: "m1",
	name: "work laptop",
	token: `onlk_${"a".repeat(64)}`,
};

beforeEach(() => {
	mocks.token = "opaque-access-token";
	mocks.refreshToken = "opaque-refresh-token";
	mocks.get.mockReset().mockResolvedValue({ user: USER });
	mocks.post.mockReset().mockResolvedValue({ success: true });
	mocks.listMachines.mockReset().mockResolvedValue({ machines: [] });
	mocks.createMachine.mockReset().mockResolvedValue(MINTED);
	mocks.getProfile.mockReset().mockResolvedValue({ user: USER });
	mocks.deleteAccount.mockReset().mockResolvedValue({ success: true });
});

/**
 * A route change from outside the shell, which is what an in-app Back is. The
 * nav inside AppShell is `inert` while a reveal is open, so clicking it is not
 * how a person gets to another page from here - a browser Back is, and it is a
 * same-document popstate that React Router handles client-side.
 */
function Elsewhere() {
	const navigate = useNavigate();
	return (
		<button type="button" onClick={() => navigate("/settings")}>
			back to settings
		</button>
	);
}

async function renderApp(path: string) {
	const result = render(
		<MemoryRouter initialEntries={[path]}>
			<auth.AuthProvider>
				<App />
				<Elsewhere />
			</auth.AuthProvider>
		</MemoryRouter>,
	);
	// The session hydrates from the stored token before RequireAuth will let
	// any of this render.
	await screen.findByText(USER.name);
	return result;
}

/** Mints a token on /machines and leaves the reveal open. */
async function mintFromMachinesPage() {
	fireEvent.change(await screen.findByLabelText(/machine name/i), {
		target: { value: "work laptop" },
	});
	fireEvent.click(screen.getByRole("button", { name: /mint token/i }));
	await screen.findByRole("dialog");
}

describe("a revealed token across the app", () => {
	// The bug the branch exists to fix, and the one the branch's own first
	// attempt reintroduced. A terminal 401 nulls `user` through exactly the code
	// path a deliberate logout takes, so anything keyed on "is someone signed
	// in" ends the reveal here - taking the only copy of a credential off a
	// screen nobody touched, while its owner is in their password manager.
	it("survives a session expiry", async () => {
		await renderApp("/machines");
		await mintFromMachinesPage();

		expect(mocks.unauthorized).not.toBeNull();
		act(() => {
			// Not a hand-rolled `user: null`: this is the callback auth.ts hands
			// the API client, so it runs expireSession -> requestLocalLogout ->
			// performLogout({callApi:false}) -> resetState for real.
			mocks.unauthorized?.();
		});

		// RequireAuth really did redirect - without this the test could pass on
		// an expiry that never took effect.
		expect(await screen.findByRole("heading", { name: /login/i })).toBeTruthy();
		expect(screen.queryByLabelText(/machine name/i)).toBeNull();

		const dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain(MINTED.token);
	});

	// AppShell's Sign out. `inert` covers this button in a browser that
	// implements it, and jsdom implements none of it - so what this pins is the
	// handler, which is the whole of the protection on a browser that ignores
	// the attribute.
	it("is dismissed by signing out of the app shell", async () => {
		await renderApp("/machines");
		await mintFromMachinesPage();

		fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	// /settings now renders inside AppShell, so a browser that implements
	// `inert` would put the page itself out of reach while the reveal is
	// open - same as the sign-out case above. jsdom implements none of it,
	// so this still reaches the delete flow, and what it pins is the same
	// thing: the handler, not the browser's own enforcement.
	it("is dismissed by deleting the account from settings", async () => {
		await renderApp("/machines");
		await mintFromMachinesPage();

		fireEvent.click(screen.getByRole("button", { name: /back to settings/i }));
		expect(
			await screen.findByRole("heading", { name: /account settings/i }),
		).toBeTruthy();
		// It followed the person off /machines - the reveal is above the routes,
		// so a route change does not take the token with it.
		expect(screen.getByRole("dialog")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /delete my account/i }));
		fireEvent.change(await screen.findByLabelText(/type your email/i), {
			target: { value: USER.email },
		});
		fireEvent.click(
			screen.getByRole("button", { name: /permanently delete/i }),
		);

		await waitFor(() => expect(mocks.deleteAccount).toHaveBeenCalled());
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});
