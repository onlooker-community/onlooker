import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmAction } from "../components/ConfirmAction";

function setup(
	props: Partial<React.ComponentProps<typeof ConfirmAction>> = {},
) {
	const onConfirm = vi.fn();
	render(
		<ConfirmAction
			trigger="Retract"
			question="Stop trusting this lesson everywhere?"
			confirmLabel="Yes, retract"
			onConfirm={onConfirm}
			variant="danger"
			{...props}
		/>,
	);
	return { onConfirm };
}

describe("ConfirmAction", () => {
	// The bug this exists to prevent: disabling a focused button moves focus to
	// <body>, so a keyboard user loses their place mid-action - in the one flow
	// where the next keystroke matters most.
	it("keeps focus on the confirm button while the action is pending", () => {
		const { rerender } = render(
			<ConfirmAction
				trigger="Retract"
				question="Sure?"
				confirmLabel="Yes, retract"
				onConfirm={vi.fn()}
				pending={false}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Retract" }));
		const confirm = screen.getByRole("button", { name: "Yes, retract" });
		expect(document.activeElement).toBe(confirm);

		rerender(
			<ConfirmAction
				trigger="Retract"
				question="Sure?"
				confirmLabel="Yes, retract"
				onConfirm={vi.fn()}
				pending={true}
			/>,
		);
		expect(document.activeElement, "focus escaped to the body").toBe(confirm);
		// jsdom does not blur on disable, so activeElement alone cannot catch a
		// revert to the disabled attribute - which is the exact regression this
		// test exists to prevent. Assert the mechanism, not just its effect.
		expect(confirm.hasAttribute("disabled")).toBe(false);
		expect(confirm.getAttribute("aria-busy")).toBe("true");
	});

	it("moves focus to the confirm button when armed", () => {
		setup();
		fireEvent.click(screen.getByRole("button", { name: "Retract" }));
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Yes, retract" }),
		);
	});

	it("returns focus to the trigger on cancel", () => {
		setup();
		fireEvent.click(screen.getByRole("button", { name: "Retract" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Retract" }),
		);
	});

	// Without this a screen reader reaching "Yes, retract" hears no question at
	// all - only the answer.
	it("associates the question with the confirm button", () => {
		setup();
		fireEvent.click(screen.getByRole("button", { name: "Retract" }));
		const confirm = screen.getByRole("button", { name: "Yes, retract" });
		const describedBy = confirm.getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		expect(document.getElementById(describedBy as string)?.textContent).toBe(
			"Stop trusting this lesson everywhere?",
		);
	});

	// Arms while NOT pending, then rerenders pending true - not `setup({
	// pending: true })`, which starts pending before anything is armed. That
	// leaves the trigger disabled and the confirm button never mounted, so
	// the click below would find nothing to press and the assertion would
	// hold without ever exercising the guard it names.
	it("does not fire when the confirm button is clicked while pending", () => {
		const onConfirm = vi.fn();
		const { rerender } = render(
			<ConfirmAction
				trigger="Retract"
				question="Sure?"
				confirmLabel="Yes, retract"
				onConfirm={onConfirm}
				pending={false}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Retract" }));
		const confirm = screen.getByRole("button", { name: "Yes, retract" });

		rerender(
			<ConfirmAction
				trigger="Retract"
				question="Sure?"
				confirmLabel="Yes, retract"
				onConfirm={onConfirm}
				pending={true}
			/>,
		);
		fireEvent.click(confirm);
		expect(onConfirm).not.toHaveBeenCalled();
	});
});
