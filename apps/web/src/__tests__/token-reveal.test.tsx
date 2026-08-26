import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TokenReveal from "../components/TokenReveal";

// Every test here is about a way the token could be lost. The component's whole
// reason to exist is that the value it displays cannot be fetched again, so
// "does it render" is the least interesting thing about it.

const MACHINE = {
	id: "m1",
	name: "work laptop",
	token: `onlk_${"a".repeat(64)}`,
};

const writeText = vi.fn();

beforeEach(() => {
	writeText.mockReset().mockResolvedValue(undefined);
	// jsdom ships no clipboard at all, so this is a definition rather than a
	// spy on something existing.
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
});

function renderReveal(onDismiss = vi.fn()) {
	const result = render(
		<TokenReveal machine={MACHINE} onDismiss={onDismiss} />,
	);
	return { ...result, onDismiss };
}

describe("TokenReveal", () => {
	it("shows the token and says it will not be shown again", () => {
		renderReveal();
		expect(screen.getByText(MACHINE.token)).toBeDefined();
		expect(screen.getByRole("dialog").textContent).toMatch(/only time|again/i);
	});

	// Escape is the reflex that closes a dialog. This is the one dialog where
	// the reflex costs the credential, so it is swallowed on purpose.
	it("does not dismiss on Escape", () => {
		const { onDismiss } = renderReveal();
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onDismiss).not.toHaveBeenCalled();
		expect(screen.getByText(MACHINE.token)).toBeDefined();
	});

	it("does not dismiss when the backdrop is clicked", () => {
		const { onDismiss, container } = renderReveal();
		// The backdrop is the fixed-position element wrapping the dialog. It
		// carries no click handler at all, which is what this asserts.
		fireEvent.click(container.firstChild as HTMLElement);
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it("dismisses only on the explicit acknowledgement", () => {
		const { onDismiss } = renderReveal();
		fireEvent.click(screen.getByRole("button", { name: /saved it/i }));
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("starts focus inside the dialog", () => {
		renderReveal();
		// Otherwise Tab begins at the top of the document and walks the nav
		// behind the modal before it ever reaches the copy button.
		expect(document.activeElement).toBe(screen.getByRole("dialog"));
	});

	// Mount focuses the container, not the first button, so the very first
	// keystroke a person might make is a Shift+Tab with focus still on the
	// container - matching neither "at the first button" nor "at the last".
	// Left unhandled, that falls through to the browser's own backward
	// navigation and walks out of the dialog into whatever precedes it in the
	// document - the nav, once this is wired into AppShell - where Enter is a
	// client-side route change that fires no beforeunload and calls no
	// onDismiss. The token would go with it.
	it("wraps to the last control when Shift+Tab is the first keystroke", () => {
		renderReveal();
		const dialog = screen.getByRole("dialog");
		const buttons = screen.getAllByRole("button");
		const last = buttons[buttons.length - 1];

		fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });

		expect(document.activeElement).toBe(last);
	});

	// The mirror of the wrap above. Without it, a forward Tab off the last
	// button - "I've saved it" - would walk into the machine-name input and
	// Mint button behind the opaque backdrop, where focus is invisible.
	it("wraps to the first control when Tab is pressed from the last", () => {
		renderReveal();
		const dialog = screen.getByRole("dialog");
		const buttons = screen.getAllByRole("button");
		const first = buttons[0];
		const last = buttons[buttons.length - 1];
		last.focus();

		fireEvent.keyDown(dialog, { key: "Tab" });

		expect(document.activeElement).toBe(first);
	});

	it("copies the token to the clipboard", async () => {
		renderReveal();
		fireEvent.click(screen.getByRole("button", { name: /^copy/i }));
		expect(writeText).toHaveBeenCalledWith(MACHINE.token);
		expect(await screen.findByText(/copied/i)).toBeDefined();
	});

	// Claiming a copy that did not happen is the worst thing this component
	// could do: the person dismisses the only copy they will ever see, trusting
	// a clipboard that is empty.
	it("says so when the copy fails, and keeps the token on screen", async () => {
		writeText.mockRejectedValue(new Error("denied"));
		renderReveal();
		fireEvent.click(screen.getByRole("button", { name: /^copy/i }));
		expect(await screen.findByText(/copy failed/i)).toBeDefined();
		expect(screen.getByText(MACHINE.token)).toBeDefined();
	});

	// The modal covers in-app links by trapping focus. Reload, tab close, and
	// a Back that leaves the document are the exits `beforeunload` reaches. An
	// in-app Back is not covered - see the component's doc comment and
	// onlooker-1bz.
	it("warns before the page unloads while it is open", () => {
		const { unmount } = renderReveal();

		const during = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(during);
		expect(during.defaultPrevented).toBe(true);

		unmount();
		const after = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(after);
		// The listener must come off, or every later navigation in the session
		// prompts about a token that is long gone.
		expect(after.defaultPrevented).toBe(false);
	});
});
