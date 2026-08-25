import { describe, expect, it } from "vitest";
import { PALETTE } from "../components/palette";

// PALETTE was lifted out of form.tsx so ui.tsx could import it rather than
// re-derive it. These values are pinned because the alternative - a second
// palette that re-derives the plate/accent distinction - already put links at
// 1.35 contrast in day mode once.
describe("PALETTE", () => {
	it("holds the values form.tsx defined before the lift", () => {
		expect(PALETTE).toEqual({
			plateTeal: "var(--plate-teal)",
			plateRed: "var(--plate-red)",
			plateInk: "var(--plate-ink)",
			accent: "var(--teal)",
			danger: "var(--red)",
			border: "var(--ink-dim)",
			borderError: "var(--red)",
			muted: "var(--ink-dim)",
			track: "var(--panel)",
		});
	});

	// The bug this file exists to prevent: a plate is a filled background and is
	// constant across themes; an accent is ink on a ground and shifts. Pointing
	// one key at the other is what produced the 1.35 contrast.
	it("keeps plates and accents distinct", () => {
		expect(PALETTE.plateTeal).not.toBe(PALETTE.accent);
		expect(PALETTE.plateRed).not.toBe(PALETTE.danger);
	});
});
