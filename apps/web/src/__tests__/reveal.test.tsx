import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiConfig } from "../api/config";
import { RevealHost, RevealProvider, useReveal } from "../reveal";

const MACHINE = {
	id: "m1",
	name: "work laptop",
	token: `onlk_${"a".repeat(64)}`,
};

/** Drives the hook from outside the dialog, the way MachinesPage will. */
function Driver() {
	const { reveal, dismiss, revealed } = useReveal();
	return (
		<div>
			<button type="button" onClick={() => reveal(MACHINE)}>
				mint
			</button>
			<button type="button" onClick={dismiss}>
				drop
			</button>
			<span data-testid="state">{revealed ? "open" : "closed"}</span>
		</div>
	);
}

describe("reveal provider", () => {
	it("starts with nothing revealed", () => {
		render(
			<RevealProvider>
				<Driver />
			</RevealProvider>,
		);
		expect(screen.getByTestId("state").textContent).toBe("closed");
	});

	it("holds a minted machine until dismissed", () => {
		render(
			<RevealProvider>
				<Driver />
			</RevealProvider>,
		);
		act(() => {
			screen.getByText("mint").click();
		});
		expect(screen.getByTestId("state").textContent).toBe("open");
		act(() => {
			screen.getByText("drop").click();
		});
		expect(screen.getByTestId("state").textContent).toBe("closed");
	});

	// The whole point of the provider. A component that unmounts and remounts -
	// which is what a route change does to a page - must not take the token
	// with it, because the provider is above the thing being remounted.
	it("survives a child unmounting and remounting", () => {
		function Swapper({ show }: { show: boolean }) {
			return (
				<RevealProvider>
					{show ? <Driver /> : <span>gone</span>}
					<Driver />
				</RevealProvider>
			);
		}
		const { rerender } = render(<Swapper show={true} />);
		act(() => {
			screen.getAllByText("mint")[0].click();
		});
		rerender(<Swapper show={false} />);
		expect(screen.getByTestId("state").textContent).toBe("open");
	});

	// Using the hook outside its provider is a wiring mistake that would
	// otherwise show up as a token that silently never appears.
	it("refuses to be used outside its provider", () => {
		expect(() => render(<Driver />)).toThrow(/RevealProvider/);
	});

	it("renders nothing when there is nothing to reveal", () => {
		render(
			<RevealProvider>
				<RevealHost />
			</RevealProvider>,
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("renders the dialog into document.body, not into its parent", () => {
		const { container } = render(
			<RevealProvider>
				<Driver />
				<RevealHost />
			</RevealProvider>,
		);
		act(() => {
			screen.getAllByText("mint")[0].click();
		});
		const dialog = screen.getByRole("dialog");
		expect(dialog).not.toBeNull();
		// The portal is what lets AppShell take `inert` without inerting the
		// dialog too. If this ever renders inside the tree, Task 3 breaks
		// silently - the shell would inert its own dialog.
		expect(container.contains(dialog)).toBe(false);
	});

	// A logout must end a reveal and a session expiry must not, but the provider
	// cannot tell them apart from `user` alone - both null it through the same
	// code path - so it is deliberately not the thing that decides. The two
	// deliberate-logout call sites dismiss it themselves, and
	// reveal-across-the-app.test.tsx is where both halves are held, against the
	// real App tree rather than here.
});

// The third logout, and the one neither of those call sites can see. A
// sign-out in another tab reaches this one through `storage`, and auth-react
// handles it by calling `resetState()` directly - never through
// `expireSession`, never through either dismiss() button. Without the listener
// below, that redirects this tab to /login with the credential still on screen.
describe("reveal provider and another tab", () => {
	function openReveal() {
		render(
			<RevealProvider>
				<Driver />
			</RevealProvider>,
		);
		act(() => {
			screen.getByText("mint").click();
		});
		expect(screen.getByTestId("state").textContent).toBe("open");
	}

	function fromAnotherTab(key: string | null, newValue: string | null) {
		act(() => {
			window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
		});
	}

	const state = () => screen.getByTestId("state").textContent;

	it("dismisses when another tab clears the access token", () => {
		openReveal();
		fromAnotherTab(apiConfig.tokenStorageKey, null);
		expect(state()).toBe("closed");
	});

	// `localStorage.clear()` fires with a null key. auth-react treats that as a
	// sign-out too, so this has to agree with it - a tab redirected to /login
	// while still showing a credential is the whole defect.
	it("dismisses when another tab clears all of storage", () => {
		openReveal();
		fromAnotherTab(null, null);
		expect(state()).toBe("closed");
	});

	// A listener that fired on any storage event would end a reveal because
	// something unrelated wrote to localStorage in another tab.
	it("ignores another tab writing an unrelated key", () => {
		openReveal();
		fromAnotherTab("theme-preference", null);
		expect(state()).toBe("open");
	});

	// Another tab signing in, or completing a token refresh, writes a *new*
	// value to this same key. Keying on the key alone would end the reveal on
	// the one event that proves the session is healthy.
	it("ignores another tab writing a new token to the same key", () => {
		openReveal();
		fromAnotherTab(apiConfig.tokenStorageKey, "a-fresher-token");
		expect(state()).toBe("open");
	});
});
