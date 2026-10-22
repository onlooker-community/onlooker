import { afterEach, describe, expect, it, vi } from "vitest";
import {
	accent,
	BADGE_WIDTH,
	bad,
	badge,
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
	tally,
	underline,
	visibleWidth,
	warn,
	withSpinner,
	wrap,
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

describe("badge", () => {
	it("pairs each state with its glyph and word", () => {
		expect(badge(PLAIN, "recording").trimEnd()).toBe("● recording");
		expect(badge(PLAIN, "unknown").trimEnd()).toBe("○ unknown");
		expect(badge(PLAIN, "stopped").trimEnd()).toBe("✕ STOPPED");
		expect(badge(PLAIN, "no-rule").trimEnd()).toBe("· no rule");
	});

	it("occupies the same width in every state, with color or without", () => {
		for (const state of [
			"recording",
			"unknown",
			"stopped",
			"no-rule",
		] as const) {
			expect(visibleWidth(badge(PLAIN, state))).toBe(BADGE_WIDTH);
			expect(visibleWidth(badge(COLOR, state))).toBe(BADGE_WIDTH);
		}
	});

	it("makes a stopped stream bold red", () => {
		expect(badge(COLOR, "stopped")).toContain(`${ESC}[1m`);
		expect(badge(COLOR, "stopped")).toContain(`${ESC}[38;5;203m`);
	});
});

describe("tally", () => {
	it("counts only the states that occurred, in badge order", () => {
		expect(tally(PLAIN, { stopped: 1, recording: 13 })).toBe(
			"● 13 recording  ✕ 1 stopped",
		);
	});

	it("says nothing when there is nothing to count", () => {
		expect(tally(PLAIN, {})).toBe("");
		expect(tally(PLAIN, { unknown: 0 })).toBe("");
	});

	it("colors each count like its badge", () => {
		expect(tally(COLOR, { unknown: 2 })).toBe(warn(COLOR, "○ 2 unknown"));
	});
});

describe("wrap", () => {
	it("leaves text that fits on one line", () => {
		expect(wrap("short detail", 10, 80)).toEqual(["short detail"]);
	});

	it("never wraps when the width is unbounded", () => {
		const long = "word ".repeat(100).trim();
		expect(wrap(long, 28, Number.POSITIVE_INFINITY)).toEqual([long]);
	});

	it("continues under the column with a hook, then plain indent", () => {
		// 20 columns of room after column 10.
		expect(
			wrap("aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj", 10, 30),
		).toEqual([
			"aaaa bbbb cccc dddd",
			"        ╰ eeee ffff gggg hhhh",
			"          iiii jjjj",
		]);
	});

	it("keeps a word longer than the room whole", () => {
		const long = "x".repeat(25);
		expect(wrap(`a ${long} b`, 10, 30)).toEqual([
			"a",
			`        ╰ ${long}`,
			"          b",
		]);
	});

	it("does not wrap into fewer than 20 columns", () => {
		const text = "one two three four five six seven";
		expect(wrap(text, 28, 40)).toEqual([text]);
	});

	it("does not throw for a column at the left edge", () => {
		expect(wrap("aaaa bbbb cccc dddd eeee ffff", 1, 22)).toEqual([
			"aaaa bbbb cccc dddd",
			"╰ eeee ffff",
		]);
	});

	it("styles each piece, hook included", () => {
		const lines = wrap("aaaa bbbb cccc dddd eeee", 10, 30, (s) =>
			muted(COLOR, s),
		);
		expect(lines[0]).toBe(muted(COLOR, "aaaa bbbb cccc dddd"));
		expect(lines[1]).toBe(`        ${muted(COLOR, "╰ eeee")}`);
	});
});

describe("withSpinner", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const sink = () => {
		const chunks: string[] = [];
		return { chunks, out: { write: (c: string) => chunks.push(c) } };
	};

	it("draws nothing at all without color", async () => {
		const { chunks, out } = sink();
		expect(await withSpinner(PLAIN, "working…", async () => 42, out)).toBe(42);
		expect(chunks).toEqual([]);
	});

	it("animates while the work runs, then clears its line", async () => {
		vi.useFakeTimers();
		const { chunks, out } = sink();
		let finish: (v: string) => void = () => {};
		const pending = withSpinner(
			COLOR,
			"working…",
			() => new Promise<string>((r) => (finish = r)),
			out,
		);
		await vi.advanceTimersByTimeAsync(240);
		expect(chunks.length).toBeGreaterThanOrEqual(3);
		expect(stripSgr(chunks[0])).toBe("\r⣾ working…");
		expect(stripSgr(chunks[1])).toBe("\r⣽ working…");
		finish("done");
		expect(await pending).toBe("done");
		expect(chunks.at(-1)).toBe(`\r${ESC}[2K`);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears its line and stops when the work throws", async () => {
		vi.useFakeTimers();
		const { chunks, out } = sink();
		await expect(
			withSpinner(
				COLOR,
				"working…",
				async () => {
					throw new Error("boom");
				},
				out,
			),
		).rejects.toThrow("boom");
		expect(chunks.at(-1)).toBe(`\r${ESC}[2K`);
		expect(vi.getTimerCount()).toBe(0);
	});
});
