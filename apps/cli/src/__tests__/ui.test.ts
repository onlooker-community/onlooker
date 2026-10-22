import { describe, expect, it } from "vitest";
import {
	accent,
	bad,
	bold,
	header,
	heading,
	label,
	muted,
	ok,
	PLAIN,
	pad,
	pill,
	resolveTheme,
	stripSgr,
	type Theme,
	underline,
	visibleWidth,
	warn,
} from "../ui";

const COLOR: Theme = { color: true, width: Number.POSITIVE_INFINITY };
const ESC = "\u001b";

describe("resolveTheme", () => {
	const tty = { isTTY: true, columns: 100 };

	it("colors a TTY and takes its width", () => {
		expect(resolveTheme({}, tty)).toEqual({ color: true, width: 100 });
	});

	it("leaves a pipe plain and unbounded, so nothing wraps", () => {
		expect(resolveTheme({}, {})).toEqual(PLAIN);
	});

	it("leaves a TTY without columns unbounded", () => {
		expect(resolveTheme({}, { isTTY: true }).width).toBe(
			Number.POSITIVE_INFINITY,
		);
	});

	// no-color.org: only a non-empty value disables color.
	it("honors a non-empty NO_COLOR and ignores an empty one", () => {
		expect(resolveTheme({ NO_COLOR: "1" }, tty).color).toBe(false);
		expect(resolveTheme({ NO_COLOR: "" }, tty).color).toBe(true);
	});

	it("does not color a dumb terminal", () => {
		expect(resolveTheme({ TERM: "dumb" }, tty).color).toBe(false);
	});

	it("lets FORCE_COLOR win in both directions", () => {
		expect(resolveTheme({ FORCE_COLOR: "1" }, {}).color).toBe(true);
		expect(resolveTheme({ FORCE_COLOR: "1", NO_COLOR: "1" }, {}).color).toBe(
			true,
		);
		expect(resolveTheme({ FORCE_COLOR: "0" }, tty).color).toBe(false);
	});
});

describe("palette", () => {
	const cases: Array<[string, (t: Theme, s: string) => string, string]> = [
		["accent", accent, "38;5;205"],
		["heading", heading, "38;5;141"],
		["label", label, "38;5;141"],
		["ok", ok, "38;5;78"],
		["warn", warn, "38;5;214"],
		["bad", bad, "38;5;203"],
		["muted", muted, "38;5;245"],
		["bold", bold, "1"],
		["underline", underline, "4"],
	];

	for (const [name, style, code] of cases) {
		it(`${name} wraps its text in ${code} and resets`, () => {
			expect(style(COLOR, "x")).toBe(`${ESC}[${code}mx${ESC}[0m`);
		});

		it(`${name} returns its text untouched when color is off`, () => {
			expect(style(PLAIN, "x")).toBe("x");
		});
	}

	it("does not wrap an empty string", () => {
		expect(ok(COLOR, "")).toBe("");
	});
});

describe("pill and header", () => {
	it("pads the pill so it reads as a block", () => {
		expect(pill(PLAIN, "ONLOOKER")).toBe(" ONLOOKER ");
		expect(pill(COLOR, "ONLOOKER")).toBe(
			`${ESC}[1;38;5;231;48;5;205m ONLOOKER ${ESC}[0m`,
		);
	});

	it("puts the command after the pill", () => {
		expect(header(PLAIN, "doctor")).toBe(" ONLOOKER  doctor");
		expect(stripSgr(header(COLOR, "doctor"))).toBe(" ONLOOKER  doctor");
	});
});

describe("measuring", () => {
	it("measures what the terminal shows, not the escape codes", () => {
		expect(visibleWidth(ok(COLOR, "recording"))).toBe(9);
		expect(visibleWidth("● recording")).toBe(11);
	});

	it("pads by visible width", () => {
		expect(pad(ok(COLOR, "ab"), 5)).toBe(`${ok(COLOR, "ab")}   `);
		expect(pad("abcdef", 3)).toBe("abcdef");
	});
});
