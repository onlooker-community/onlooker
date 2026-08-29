import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PALETTE } from "../components/palette";
import {
	Button,
	Chip,
	EmptyState,
	Panel,
	Plate,
	StatusBadge,
} from "../components/ui";

// The display half of the split form.tsx anticipated. These are the primitives
// the lessons and machines pages are built from; the assertions here are the
// contracts those pages depend on rather than a description of how they look.

describe("Button", () => {
	// SubmitButton is the type="submit" one. This is the other kind - Retract,
	// Revoke, Retry - and several of them sit inside or beside a form. A
	// default type would submit that form instead of running the handler.
	it("cannot submit a surrounding form", () => {
		render(<Button onClick={() => {}}>Retract</Button>);
		expect(
			screen.getByRole("button", { name: "Retract" }).getAttribute("type"),
		).toBe("button");
	});

	it("runs its handler when pressed", () => {
		const onClick = vi.fn();
		render(<Button onClick={onClick}>Retract</Button>);
		fireEvent.click(screen.getByRole("button", { name: "Retract" }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	// Retract round-trips rather than updating optimistically, so the button is
	// visibly pending for as long as the request takes. A second press in that
	// window would issue a second transition against a lesson already moving.
	it("ignores a second press while pending", () => {
		const onClick = vi.fn();
		render(
			<Button onClick={onClick} loading loadingLabel="Retracting...">
				Retract
			</Button>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Retracting..." }));
		expect(onClick).not.toHaveBeenCalled();
	});

	// A filled button needs a plate: accents shift per theme and no constant
	// label ink reads on a background that moves under it. This is the 1.35
	// contrast bug, aimed at a button instead of a link.
	it("fills with a plate and never an accent", () => {
		render(<Button onClick={() => {}}>Retract</Button>);
		const button = screen.getByRole("button", { name: "Retract" });
		expect(button.style.background).toBe(PALETTE.plateTeal);
		expect(button.style.color).toBe(PALETTE.plateInk);
	});

	it("fills with the red plate when it is destructive", () => {
		render(
			<Button onClick={() => {}} variant="danger">
				Revoke
			</Button>,
		);
		expect(
			screen.getByRole("button", { name: "Revoke" }).style.background,
		).toBe(PALETTE.plateRed);
	});
});

describe("StatusBadge", () => {
	it("names the status in words rather than the column value", () => {
		render(<StatusBadge status="retracted" />);
		expect(screen.getByText("Retracted")).toBeDefined();
	});

	// The pool is browsed with every status mixed together, so the badge is the
	// only thing separating a claim in force from one withdrawn. Rendering both
	// on the same plate would make the list unreadable at a glance.
	it("renders a retracted lesson differently from an active one", () => {
		const { container: active } = render(<StatusBadge status="active" />);
		const { container: retracted } = render(<StatusBadge status="retracted" />);
		const plateOf = (c: HTMLElement) =>
			(c.firstElementChild as HTMLElement).style.background;
		expect(plateOf(active)).not.toBe(plateOf(retracted));
	});

	it("puts plate ink on its plate for every status", () => {
		for (const status of [
			"active",
			"retracted",
			"refuted",
			"superseded",
		] as const) {
			const { container } = render(<StatusBadge status={status} />);
			const badge = container.firstElementChild as HTMLElement;
			expect(badge.style.color, `${status} ink`).toBe(PALETTE.plateInk);
			expect(badge.style.background, `${status} plate`).not.toBe(
				PALETTE.accent,
			);
			expect(badge.style.background, `${status} plate`).not.toBe(
				PALETTE.danger,
			);
		}
	});
});

describe("Plate", () => {
	it("fills with the teal plate, not red, for a live-tone icon", () => {
		const { container } = render(<Plate tone="teal" icon="Key" />);
		expect((container.firstElementChild as HTMLElement).style.background).toBe(
			PALETTE.plateTeal,
		);
	});

	it("fills with the red plate for a not-live-tone icon", () => {
		const { container } = render(<Plate tone="red" icon="Key" />);
		expect((container.firstElementChild as HTMLElement).style.background).toBe(
			PALETTE.plateRed,
		);
	});

	// The box a bordered plate actually occupies is its declared width PLUS
	// the border - nothing in this project sets box-sizing: border-box - so a
	// 16px icon's plate is 28px of fill, not the 32px total box it renders in.
	it("sizes its fill to the icon plus 12px, regardless of the border", () => {
		const { container } = render(<Plate tone="teal" icon="Key" size={48} />);
		const plate = container.firstElementChild as HTMLElement;
		expect(plate.style.width).toBe("60px");
		expect(plate.style.height).toBe("60px");
	});
});

describe("Chip", () => {
	it("renders its label", () => {
		render(<Chip>typescript</Chip>);
		expect(screen.getByText("typescript")).toBeDefined();
	});
});

describe("Panel", () => {
	it("renders its title as a heading", () => {
		render(<Panel title="Provenance">body</Panel>);
		expect(screen.getByRole("heading", { name: "Provenance" })).toBeDefined();
		expect(screen.getByText("body")).toBeDefined();
	});

	// A panel used purely to group has no title, and an empty heading in the
	// document outline is worse than none for anyone navigating by headings.
	it("renders no heading when it has no title", () => {
		render(<Panel>body</Panel>);
		expect(screen.queryByRole("heading")).toBeNull();
	});
});

describe("EmptyState", () => {
	it("renders its title and explanation", () => {
		render(
			<EmptyState title="Nothing has synced yet">
				Connect a machine.
			</EmptyState>,
		);
		expect(
			screen.getByRole("heading", { name: "Nothing has synced yet" }),
		).toBeDefined();
		expect(screen.getByText("Connect a machine.")).toBeDefined();
	});

	// This is where DashboardPage's error-and-Retry moved to, before
	// onlooker-yfw deleted that page.
	it("offers its action", () => {
		const onClick = vi.fn();
		render(
			<EmptyState
				title="Could not load lessons"
				action={{ label: "Retry", onClick }}
			>
				The request failed.
			</EmptyState>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	// An empty pool explains itself with a link, not a button that does nothing.
	it("renders no button when it has no action", () => {
		render(<EmptyState title="No retracted lessons" />);
		expect(screen.queryByRole("button")).toBeNull();
	});

	// `icon` alone renders bare - the illustration's own color is assumed
	// legible. `tone` opts into a `Plate` instead, for the icons that measure
	// below 3:1 against `--ground` on their own. Without a plate an icon this
	// large is a dark smudge in the default theme, not an illustration.
	it("plates its icon when a tone is given", () => {
		const { container } = render(
			<EmptyState
				title="Nothing has synced yet"
				icon="ChestTreasure"
				tone="teal"
			>
				Connect a machine.
			</EmptyState>,
		);
		const plate = container.querySelector("span");
		expect(plate).not.toBeNull();
		expect((plate as HTMLElement).style.background).toBe(PALETTE.plateTeal);
	});
});
