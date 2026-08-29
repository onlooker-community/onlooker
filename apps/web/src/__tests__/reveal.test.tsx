import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
