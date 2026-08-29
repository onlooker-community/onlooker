import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "../components/Icon";

describe("Icon", () => {
	// The glob is the whole mechanism. If it resolves nothing, every icon in
	// the app renders as a broken image and no other test would say so.
	it("resolves a real URL for a known icon", () => {
		render(<Icon name="Eye" />);
		const img = screen.getByRole("presentation");
		expect(img.getAttribute("src")).toBeTruthy();
		expect(img.getAttribute("src")).not.toBe("");
	});

	it("renders at 16 by default and carries the pixel-icon classes", () => {
		render(<Icon name="Key" />);
		const img = screen.getByRole("presentation");
		expect(img.className).toContain("pixel-icon");
		expect(img.className).toContain("pixel-icon--16");
	});

	it("takes the other two legal sizes", () => {
		const { rerender } = render(<Icon name="Trophy" size={32} />);
		expect(screen.getByRole("presentation").className).toContain(
			"pixel-icon--32",
		);
		rerender(<Icon name="Trophy" size={48} />);
		expect(screen.getByRole("presentation").className).toContain(
			"pixel-icon--48",
		);
	});

	// Decorative by default: the label beside an icon already says what it
	// means, and a screen reader announcing both reads it twice.
	it("is hidden from assistive tech unless given a label", () => {
		const { rerender } = render(<Icon name="Skull" />);
		expect(screen.getByRole("presentation").getAttribute("alt")).toBe("");
		rerender(<Icon name="Skull" label="Refuted" />);
		expect(screen.getByRole("img", { name: "Refuted" })).toBeDefined();
	});
});
