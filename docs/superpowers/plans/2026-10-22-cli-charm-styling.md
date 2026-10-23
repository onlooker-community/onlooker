# Charm-inspired CLI styling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every `onlooker` command Charm-style output (header pill, state badges, muted detail, spinner) without changing a single word it prints.

**Architecture:** One new module, `apps/cli/src/ui.ts`, holds the theme, palette, primitives and spinner. Each renderer takes an optional `theme` (default `PLAIN`) and wraps the parts it wants emphasized. `cli.ts` resolves one theme for stdout and one for stderr, prints the header pill, prefixes errors, and runs doctor and sync inside the spinner.

**Tech Stack:** TypeScript (ES2023, Node 20+), esbuild bundle, vitest, biome. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-22-cli-charm-styling-design.md` · **Issue:** ONL-185 · **Branch:** `meagan/onl-185-charm-inspired-styling-for-the-cli`

## Global Constraints

- No new runtime or dev dependencies. `apps/cli/package.json` changes only its `version`.
- Existing sentences keep every word. Styling adds escape codes, glyphs, line breaks and the header. The one new sentence is doctor's tally line.
- Palette (256-color SGR): accent `38;5;205`, heading `38;5;141`, ok `38;5;78`, warn `38;5;214`, bad `38;5;203`, muted `38;5;245`, bold `1`, underline `4`, pill `1;38;5;231;48;5;205`.
- Glyphs: `●` recording, `○` unknown/warning, `✕` stopped/error, `·` no rule, `✓` success, `╰` wrap continuation.
- Color only on a TTY; `NO_COLOR` (non-empty) and `TERM=dumb` disable; `FORCE_COLOR` (not `0`) forces on, `FORCE_COLOR=0` forces off.
- Non-TTY width is unbounded: piped output never wraps.
- `playbook --json` is never styled and gets no header.
- The token prompt in `prompt.ts` is not touched.
- Edit tracked files with the Edit/Write tools, never `sed -i` or heredocs (repo CLAUDE.md: the lineage plugin only records tool edits).
- A PreToolUse hook blocks any write in which a line holds the word token, a colon or equals sign, and then a quoted string of 8+ characters. It scans an Edit's whole replacement text, not just the changed line. Keep the `Token:` label in the `TOKEN_LABEL` constant (Task 5) so no edit trips it.
- Commit through `/git-workflow:commit` (conventional commit, mood emoji, American English, body `Refs ONL-185`). A subagent without that skill reports back and lets the orchestrator commit.
- All commands below run from `apps/cli/`.
- Snippets here are not pre-formatted for biome. When `pnpm lint` reports only formatting, run `pnpm lint:fix` and move on. Any other lint finding is real.

## File Structure

| File | Responsibility |
|---|---|
| `src/ui.ts` (create) | Theme resolution, palette, primitives, badge, tally, wrap, spinner |
| `src/__tests__/ui.test.ts` (create) | Unit tests for all of `ui.ts` |
| `src/streams.ts` (modify ~2550-2640) | `doctorLines` gains a theme; `label()` is replaced by `badge()` |
| `src/commands/doctor.ts` | Passes `theme` through |
| `src/commands/status.ts` | Styled label/value block |
| `src/commands/sync.ts` | `✓` summary, `○` notices, muted idle line |
| `src/commands/link.ts` | `✓ Linked to <url>.` plus a muted next-step line |
| `src/commands/playbook.ts` | Violet headings, accent ids, muted reasons |
| `src/cli.ts` | Theme resolution, header, usage, error prefix, spinners |
| existing `__tests__/*.test.ts` | Glyph-only assertion updates plus one color-strip test each |

---

### Task 1: Theme and palette primitives

**Files:**
- Create: `src/ui.ts`
- Create: `src/__tests__/ui.test.ts`

**Interfaces:**
- Produces:
  - `interface Theme { color: boolean; width: number }`
  - `const PLAIN: Theme` (`{ color: false, width: Infinity }`)
  - `resolveTheme(env: NodeJS.ProcessEnv, stream: { isTTY?: boolean; columns?: number }): Theme`
  - `accent | heading | label | ok | warn | bad | muted | bold | underline: (theme: Theme, text: string) => string`
  - `pill(theme, text): string`, `header(theme, command): string`
  - `stripSgr(text): string`, `visibleWidth(text): number`, `pad(text, width): string`

- [ ] **Step 1: Write the failing tests**

`src/__tests__/ui.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/__tests__/ui.test.ts`
Expected: FAIL, `Failed to resolve import "../ui"`.

- [ ] **Step 3: Write the implementation**

`src/ui.ts`:

```ts
/**
 * How everything this CLI prints is styled, in the spirit of Charm's Lip Gloss.
 *
 * Every function here keeps its input's words and only adds escape codes when
 * the theme says color is on. That is the rule the color-strip tests hold each
 * renderer to: color changes emphasis, never a word. A renderer that needs a
 * different sentence under color has broken it.
 */

export interface Theme {
	color: boolean;
	/** Columns to fit, or Infinity when the output is not a terminal. */
	width: number;
}

/**
 * What tests, pipes and redirects get. Unbounded rather than 80 columns: a
 * line someone pipes to grep has to stay one line, whatever a terminal would
 * have done with it.
 */
export const PLAIN: Theme = { color: false, width: Number.POSITIVE_INFINITY };

/**
 * Decide once per stream, in `cli.ts`, so no renderer reads `process` itself
 * and a test controls the result by passing a theme.
 */
export function resolveTheme(
	env: NodeJS.ProcessEnv,
	stream: { isTTY?: boolean; columns?: number },
): Theme {
	const tty = stream.isTTY === true;
	const forced = env.FORCE_COLOR;
	// no-color.org: only a non-empty NO_COLOR disables.
	const color =
		forced !== undefined
			? forced !== "0"
			: tty && !env.NO_COLOR && env.TERM !== "dumb";
	return {
		color,
		width:
			tty && stream.columns ? stream.columns : Number.POSITIVE_INFINITY,
	};
}

const ESC = "\u001b";
// Built from a string so the escape byte never sits in a regex literal, which
// biome's noControlCharactersInRegex would refuse.
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

function paint(theme: Theme, codes: string, text: string): string {
	return theme.color && text !== "" ? `${ESC}[${codes}m${text}${ESC}[0m` : text;
}

type Style = (theme: Theme, text: string) => string;

export const accent: Style = (t, s) => paint(t, "38;5;205", s);
export const heading: Style = (t, s) => paint(t, "38;5;141", s);
/** The `API:` / `Config:` column. Same violet as a heading, named for its job. */
export const label: Style = heading;
export const ok: Style = (t, s) => paint(t, "38;5;78", s);
export const warn: Style = (t, s) => paint(t, "38;5;214", s);
export const bad: Style = (t, s) => paint(t, "38;5;203", s);
export const muted: Style = (t, s) => paint(t, "38;5;245", s);
export const bold: Style = (t, s) => paint(t, "1", s);
export const underline: Style = (t, s) => paint(t, "4", s);

/** Padded inside the color, so the block reads as a block. */
export const pill: Style = (t, s) => paint(t, "1;38;5;231;48;5;205", ` ${s} `);

export function header(theme: Theme, command: string): string {
	return `${pill(theme, "ONLOOKER")} ${bold(theme, command)}`;
}

export function stripSgr(text: string): string {
	return text.replace(SGR, "");
}

/** Every glyph this module uses is one column wide, so length is enough. */
export function visibleWidth(text: string): number {
	return stripSgr(text).length;
}

/** `padEnd` by what the terminal shows, so color never shifts a column. */
export function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/__tests__/ui.test.ts && pnpm lint && pnpm typecheck`
Expected: all PASS, biome and tsc clean. If biome reorders the import list in the test, run `pnpm lint:fix` and re-run.

- [ ] **Step 5: Commit**

Stage `src/ui.ts` and `src/__tests__/ui.test.ts`; commit via `/git-workflow:commit`, e.g. `feat(cli): add a theme and palette for styled output :art:` with body `Refs ONL-185`.

---

### Task 2: Badge, tally and wrap

**Files:**
- Modify: `src/ui.ts` (append)
- Modify: `src/__tests__/ui.test.ts` (append)

**Interfaces:**
- Consumes: `Theme`, `PLAIN`, `pad`, `stripSgr`, `visibleWidth`, the styles from Task 1.
- Produces:
  - `type BadgeState = "recording" | "unknown" | "stopped" | "no-rule"` (the same strings as `Verdict["kind"]` in `streams.ts`)
  - `const BADGE_WIDTH = 13`
  - `badge(theme: Theme, state: BadgeState): string`, padded to `BADGE_WIDTH` visible columns
  - `tally(theme: Theme, counts: Partial<Record<BadgeState, number>>): string`
  - `wrap(text: string, column: number, width: number, style?: (s: string) => string): string[]`

- [ ] **Step 1: Write the failing tests**

Add `badge`, `BADGE_WIDTH`, `tally` and `wrap` to the import list in `ui.test.ts`, then append:

```ts
describe("badge", () => {
	it("pairs each state with its glyph and word", () => {
		expect(badge(PLAIN, "recording").trimEnd()).toBe("● recording");
		expect(badge(PLAIN, "unknown").trimEnd()).toBe("○ unknown");
		expect(badge(PLAIN, "stopped").trimEnd()).toBe("✕ STOPPED");
		expect(badge(PLAIN, "no-rule").trimEnd()).toBe("· no rule");
	});

	it("occupies the same width in every state, with color or without", () => {
		for (const state of ["recording", "unknown", "stopped", "no-rule"] as const) {
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

	it("styles each piece, hook included", () => {
		const lines = wrap("aaaa bbbb cccc dddd eeee", 10, 30, (s) => muted(COLOR, s));
		expect(lines[0]).toBe(muted(COLOR, "aaaa bbbb cccc dddd"));
		expect(lines[1]).toBe(`        ${muted(COLOR, "╰ eeee")}`);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/__tests__/ui.test.ts`
Expected: FAIL, `badge is not a function` (or a missing export error).

- [ ] **Step 3: Write the implementation**

Append to `src/ui.ts`:

```ts
/** The same strings as `Verdict["kind"]` in `streams.ts`, on purpose. */
export type BadgeState = "recording" | "unknown" | "stopped" | "no-rule";

const BADGES: Record<BadgeState, { glyph: string; word: string; style: Style }> =
	{
		recording: { glyph: "●", word: "recording", style: ok },
		unknown: { glyph: "○", word: "unknown", style: warn },
		// Upper case earns its shout: this is the one line someone scanning the
		// output has to catch, and it is surrounded by lower-case rows. Bold red
		// on top, for the same reason.
		stopped: {
			glyph: "✕",
			word: "STOPPED",
			style: (t, s) => bold(t, bad(t, s)),
		},
		"no-rule": { glyph: "·", word: "no rule", style: muted },
	};

const ORDER: BadgeState[] = ["recording", "unknown", "stopped", "no-rule"];

/** `● recording` and two spaces: the widest badge plus a gap. */
export const BADGE_WIDTH = 13;

export function badge(theme: Theme, state: BadgeState): string {
	const { glyph, word, style } = BADGES[state];
	return pad(style(theme, `${glyph} ${word}`), BADGE_WIDTH);
}

/**
 * Doctor's last line. Lower-case `stopped` here: the count is a summary,
 * and the row it summarizes already shouted.
 */
export function tally(
	theme: Theme,
	counts: Partial<Record<BadgeState, number>>,
): string {
	return ORDER.filter((state) => (counts[state] ?? 0) > 0)
		.map((state) => {
			const { glyph, word, style } = BADGES[state];
			return style(theme, `${glyph} ${counts[state]} ${word.toLowerCase()}`);
		})
		.join("  ");
}

/**
 * Fit `text` into the columns right of `column`, breaking on spaces.
 *
 * The first piece continues the caller's line. Each later piece is a line of
 * its own, with `╰` two columns left of the text it continues. Below 20
 * columns of room the result would be a ribbon of single words, which is
 * harder to read than one long line, so nothing wraps.
 */
export function wrap(
	text: string,
	column: number,
	width: number,
	style: (s: string) => string = (s) => s,
): string[] {
	const room = width - column;
	if (!Number.isFinite(room) || room < 20 || text.length <= room) {
		return [style(text)];
	}
	const pieces: string[] = [];
	let current = "";
	for (const word of text.split(" ")) {
		if (current === "") current = word;
		else if (current.length + 1 + word.length <= room) current += ` ${word}`;
		else {
			pieces.push(current);
			current = word;
		}
	}
	pieces.push(current);
	const indent = " ".repeat(column - 2);
	return pieces.map((piece, i) =>
		i === 0 ? style(piece) : `${indent}${style(`${i === 1 ? "╰" : " "} ${piece}`)}`,
	);
}
```

Note: the `wrap` "hook, then plain indent" test expects the third line as `"          iiii jjjj"`. That is `indent` (8 spaces) + style(`"  iiii jjjj"`), so 10 spaces in plain mode.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/__tests__/ui.test.ts && pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(cli): badge, tally and wrap doctor's rows :label:`, body `Refs ONL-185`.

---

### Task 3: Spinner

**Files:**
- Modify: `src/ui.ts` (append)
- Modify: `src/__tests__/ui.test.ts` (append)

**Interfaces:**
- Consumes: `Theme`, `accent`, `muted`.
- Produces: `withSpinner<T>(theme: Theme, text: string, work: () => Promise<T>, out?: { write(chunk: string): unknown }): Promise<T>`. `out` defaults to `process.stderr`, and `theme` must be the **stderr** theme.

- [ ] **Step 1: Write the failing tests**

Add `withSpinner` to the imports and `vi, afterEach` to the vitest import, then append:

```ts
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
			withSpinner(COLOR, "working…", async () => {
				throw new Error("boom");
			}, out),
		).rejects.toThrow("boom");
		expect(chunks.at(-1)).toBe(`\r${ESC}[2K`);
		expect(vi.getTimerCount()).toBe(0);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/__tests__/ui.test.ts`
Expected: FAIL, `withSpinner is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/ui.ts`:

```ts
const FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

/**
 * Run `work` with a Bubbles-style dot spinner on stderr.
 *
 * `theme` is stderr's, not stdout's: `onlooker doctor | less` should still
 * spin on the terminal, and `onlooker doctor 2>log` should not write frames
 * into the log. The line is cleared in `finally`, so a throw leaves neither a
 * stray frame in front of the error nor a live interval keeping the process
 * up.
 */
export async function withSpinner<T>(
	theme: Theme,
	text: string,
	work: () => Promise<T>,
	out: { write(chunk: string): unknown } = process.stderr,
): Promise<T> {
	if (!theme.color) return work();
	let frame = 0;
	const draw = () => {
		out.write(
			`\r${accent(theme, FRAMES[frame++ % FRAMES.length])} ${muted(theme, text)}`,
		);
	};
	draw();
	const timer = setInterval(draw, 80);
	try {
		return await work();
	} finally {
		clearInterval(timer);
		out.write(`\r${ESC}[2K`);
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/__tests__/ui.test.ts && pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(cli): spin on stderr while a command works :hourglass_flowing_sand:`, body `Refs ONL-185`.

---

### Task 4: Styled doctor report

**Files:**
- Modify: `src/streams.ts:2550-2640` (`DETAIL_COLUMN`, `label`, `detail`, `doctorLines`)
- Modify: `src/commands/doctor.ts`
- Modify: `src/__tests__/streams.test.ts` (`describe("doctorLines")`, around line 3702)

**Interfaces:**
- Consumes: `Theme`, `PLAIN`, `badge`, `BADGE_WIDTH`, `tally`, `wrap`, `label`, `heading`, `warn`, `bad`, `muted`, `stripSgr` from `../ui`.
- Produces: `doctorLines(survey: StreamSurvey, theme?: Theme): string[]` (theme defaults to `PLAIN`). `DoctorDeps` gains `theme?: Theme`.

- [ ] **Step 1: Write the failing tests**

In `streams.test.ts`, add `import { stripSgr, type Theme } from "../ui";` and update the two existing regexes that assume the old label sits directly after the name:

- In "leaves a gap after the longest real plugin name, cartographer": `/cartographer\s+recording/` becomes `/cartographer\s+● recording/`.
- In "leaves a gap after any name as long as the current longest name in STREAMS": `` new RegExp(`${syntheticName}\\s+recording`) `` becomes `` new RegExp(`${syntheticName}\\s+● recording`) ``.

Then append inside `describe("doctorLines", …)`:

```ts
	const COLOR: Theme = { color: true, width: Number.POSITIVE_INFINITY };

	const everything = () =>
		surveyOf({
			enablement: {
				kind: "found",
				plugins: ["bursar", "echo", "lineage", "mystery"],
				source: "/repo/.claude/settings.json",
				caveat: "user settings were guessed",
			},
			projectKeys: ["6a7678979e31"],
			verdicts: [
				{ plugin: "lineage", verdict: { kind: "recording", detail: "lineage/* last changed 2026-10-22 15:28" } },
				{ plugin: "echo", verdict: { kind: "unknown", detail: "last sign of life 2026-10-12, 140 of this repo's sessions ago, none of which had to trigger it" } },
				{ plugin: "bursar", verdict: { kind: "stopped", detail: "bursar-session-end fired 71 times" } },
				{ plugin: "mystery", verdict: { kind: "no-rule" } },
			],
			footer: [{ plugin: "governor", detail: "last wrote 2026-09-07" }],
			faults: ["the event log could not be read"],
			notes: ["2 event log line(s) could not be parsed"],
		});

	it("gives each verdict a badge and ends on a tally", () => {
		const lines = doctorLines(everything());
		expect(lines).toContain(
			"  lineage      ● recording  lineage/* last changed 2026-10-22 15:28",
		);
		expect(lines.find((l) => l.includes("bursar"))).toContain("✕ STOPPED");
		expect(lines.find((l) => l.includes("mystery"))).toContain(
			"· no rule    this CLI has no health rule for it",
		);
		expect(lines.at(-1)).toBe(
			"● 1 recording  ○ 1 unknown  ✕ 1 stopped  · 1 no rule",
		);
	});

	it("marks a fault without disturbing its alignment with notes", () => {
		const lines = doctorLines(everything());
		expect(lines).toContain("✕ Fault:  the event log could not be read");
		expect(lines).toContain("Note:     2 event log line(s) could not be parsed");
	});

	it("prints no tally when there are no verdicts", () => {
		const lines = doctorLines(surveyOf({}));
		expect(lines.join("\n")).not.toMatch(/[●○✕·] \d/);
	});

	it("wraps a long detail under its column on a narrow terminal", () => {
		const lines = doctorLines(everything(), { color: false, width: 60 });
		const at = lines.findIndex((l) => l.startsWith("  echo"));
		expect(lines[at].length).toBeLessThanOrEqual(60);
		expect(lines[at + 1]).toMatch(/^ {26}╰ /);
	});

	// The rule ui.ts exists to keep: color is emphasis, never words.
	it("says exactly the same words with color on", () => {
		expect(doctorLines(everything(), COLOR).map(stripSgr)).toEqual(
			doctorLines(everything()),
		);
		expect(doctorLines(everything(), COLOR).join("")).toContain("\u001b[");
	});
```

The `surveyOf` helper already exists in this file. If it doesn't accept one of these fields (`faults`, `notes`, `projectKeys`), read its definition and pass the field the way the other tests in this file do.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/__tests__/streams.test.ts -t doctorLines`
Expected: FAIL on the new tests and the two updated regexes (no `●` yet).

- [ ] **Step 3: Write the implementation**

In `src/streams.ts`:

1. Add to the imports: `import { BADGE_WIDTH, bad, badge, heading, label, muted, PLAIN, type Theme, tally, warn, wrap } from "./ui";`
2. Delete the `label(verdict)` function (lines ~2552-2565). Its comment now lives on `BADGES.stopped` in `ui.ts`.
3. Replace `doctorLines` with the version below. Every sentence is copied from the current function. Only the wrappers are new.

```ts
export function doctorLines(
	survey: StreamSurvey,
	theme: Theme = PLAIN,
): string[] {
	const lines: string[] = [];

	if (survey.enablement.kind === "unknown") {
		lines.push(
			`${label(theme, "Expected:")} ${warn(theme, "unknown")} - ${survey.enablement.reason}`,
		);
	} else {
		const count = survey.enablement.plugins.length;
		// This machine's own footer is routinely two keys, not one - one
		// current, one partly historical, both legitimate - so this pluralizes
		// exactly like the plugin count just above it rather than assuming a
		// single key.
		const keys =
			survey.projectKeys.length > 0
				? ` - key${survey.projectKeys.length === 1 ? "" : "s"} ${survey.projectKeys.join(", ")}`
				: "";
		lines.push(
			`${label(theme, "Expected:")} ${count} plugin${count === 1 ? "" : "s"} enabled from onlooker-community${muted(theme, keys)}`,
		);
		// Directly under the count it qualifies, not with the notes at the
		// bottom: every line between here and there rests on it.
		if (survey.enablement.caveat !== undefined) {
			lines.push(
				`${label(theme, "Caution:")}  ${warn(theme, survey.enablement.caveat)}`,
			);
		}
	}

	// Sorted here as well as in readEnablement: this renderer is exported and
	// a caller may hand it verdicts assembled some other way.
	const sorted = [...survey.verdicts].sort((a, b) =>
		a.plugin.localeCompare(b.plugin),
	);
	if (sorted.length > 0) lines.push("");
	for (const { plugin, verdict } of sorted) {
		const left = `  ${plugin.padEnd(DETAIL_COLUMN - 2)}${badge(theme, verdict.kind)}`;
		const [first, ...rest] = wrap(
			detail(verdict),
			DETAIL_COLUMN + BADGE_WIDTH,
			theme.width,
			(s) => muted(theme, s),
		);
		lines.push(`${left}${first}`, ...rest);
	}

	if (survey.footer.length > 0) {
		lines.push("");
		// With a guessed user layer, a stream enabled in the settings doctor
		// could not find lands here, so the heading must not assert it.
		const guessed =
			survey.enablement.kind === "found" &&
			survey.enablement.caveat !== undefined;
		lines.push(
			heading(
				theme,
				guessed
					? "Not enabled here, as far as doctor could tell, but holding data on this machine:"
					: "Not enabled here, but holding data on this machine:",
			),
		);
		for (const { plugin, detail: text } of [...survey.footer].sort((a, b) =>
			a.plugin.localeCompare(b.plugin),
		)) {
			lines.push(`  ${plugin.padEnd(DETAIL_COLUMN - 2)}${muted(theme, text)}`);
		}
	}

	if (survey.faults.length > 0) {
		lines.push("");
		// Ten columns, like `Note:     `, so faults and notes still line up.
		for (const fault of survey.faults)
			lines.push(`${bad(theme, "✕ Fault:")}  ${fault}`);
	}

	// Its own label, aligned with `Fault:`, rather than folded in with them.
	// The exit code reacts to a fault and not to a note, and output that
	// called both the same thing would leave a reader unable to tell which
	// line is the reason the command exited 1.
	if (survey.notes.length > 0) {
		lines.push("");
		for (const note of survey.notes)
			lines.push(`${label(theme, "Note:")}     ${muted(theme, note)}`);
	}

	// The only sentence this renderer has that the plain report did not: a
	// count, so the whole verdict reads at a glance before the rows do.
	const counts: Partial<Record<Verdict["kind"], number>> = {};
	for (const { verdict } of sorted)
		counts[verdict.kind] = (counts[verdict.kind] ?? 0) + 1;
	const summary = tally(theme, counts);
	if (summary !== "") lines.push("", summary);

	return lines;
}
```

Check that the `Expected:` unknown line keeps its words: the old text was `Expected: unknown - <reason>`, and the new plain text is identical.

In `src/commands/doctor.ts`, add `import type { Theme } from "../ui";` and add to `DoctorDeps`:

```ts
	/** How to style the report. Plain unless `cli.ts` found a terminal. */
	theme?: Theme;
```

Then change the return to `doctorLines(survey, deps.theme).join("\n")`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run && pnpm lint && pnpm typecheck`
Expected: PASS. If a test elsewhere (for example `doctor.test.ts`) asserts the old `name  recording` adjacency, update only the glyph or spacing in that assertion and never its words. Paste each assertion you changed into the commit body.

- [ ] **Step 5: Commit**

`feat(cli): badge doctor's verdicts and tally them :vertical_traffic_light:`, body `Refs ONL-185`.

---

### Task 5: Styled status

**Files:**
- Modify: `src/commands/status.ts`
- Modify: `src/__tests__/status.test.ts`

**Interfaces:**
- Consumes: `Theme`, `PLAIN`, `pad`, `label`, `ok`, `warn`, `bad`, `accent`, `bold`, `muted`, `stripSgr`.
- Produces: `StatusDeps` gains `theme?: Theme`.

- [ ] **Step 1: Write the failing test**

Append to `status.test.ts` (add `import { writeConfig } from "../config";` if it isn't imported yet, plus `import { stripSgr } from "../ui";`):

```ts
	// The rule ui.ts exists to keep: color is emphasis, never words.
	it("says exactly the same words with color on", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		writeConfig({ apiBaseUrl: "https://api.onlooker.dev", machineToken: "tok" }, env);
		const plain = await status({ env, fetchImpl: ok() });
		const colored = await status({
			env,
			fetchImpl: ok(),
			theme: { color: true, width: Number.POSITIVE_INFINITY },
		});
		expect(colored).not.toBe(plain);
		expect(stripSgr(colored)).toBe(plain);
		expect(colored).toContain("\u001b[38;5;78maccepted");
	});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/__tests__/status.test.ts`
Expected: FAIL (a TypeScript error on `theme`, or `colored` equals `plain`).

- [ ] **Step 3: Implement**

In `status.ts`, import `{ accent, bad, bold, label, muted, ok, PLAIN, pad, type Theme, warn } from "../ui"`, add `theme = PLAIN` to the destructured deps, and add `theme?: Theme` with a one-line doc to `StatusDeps`. Add a module-level constant above `status`:

```ts
// A constant, not a literal at each call site: the repo's secret-scanning hook
// reads the token label followed by a long quoted string on one line as a
// credential and blocks the edit.
const TOKEN_LABEL = "Token:";
```

Inside the function, directly under the existing padding comment, add:

```ts
	const field = (name: string, value: string) =>
		`${pad(label(theme, name), 10)}${value}`;
```

Then rewrite each `lines.push`/initializer through `field`, keeping every word. Each snippet replaces the matching existing line in place, and every comment stays where it is:

```ts
	const lines = [
		field("API:", config.apiBaseUrl),
		field("Config:", configPath(env)),
	];
```

Not linked:

```ts
		lines.push(
			field(
				TOKEN_LABEL,
				`${warn(theme, "not linked")} - run ${accent(theme, "`onlooker link`")}`,
			),
		);
```

Accepted:

```ts
			lines.push(field(TOKEN_LABEL, ok(theme, "accepted")));
```

Rejected / unknown:

```ts
			lines.push(
				failure?.kind === "unauthorized"
					? field(TOKEN_LABEL, `${bad(theme, "rejected")} - ${detail}`)
					: field(TOKEN_LABEL, `${warn(theme, "unknown")} - ${detail}`),
			);
```

The three `Lessons:` branches, in order:

```ts
		lines.push(
			field(
				"Lessons:",
				`none - ${found.path} does not exist, so no plugin has run here yet`,
			),
		);
```

```ts
		lines.push(
			field(
				"Lessons:",
				`none - ${found.path} does not exist, so librarian has not run here yet`,
			),
		);
```

```ts
		lines.push(
			field(
				"Lessons:",
				`${warn(theme, "unknown")} - ${found.path} exists but could not be listed`,
			),
		);
```

The count:

```ts
		lines.push(
			field(
				"Lessons:",
				`${ready > 0 ? bold(theme, String(ready)) : ready} approved lesson${ready === 1 ? "" : "s"} ready to sync` +
					(caveats.length > 0 ? `, ${caveats.join(", ")}` : ""),
			),
		);
```

The pipeline:

```ts
		const [first, ...rest] = pipelineLines(surveyPipeline(env)).map(
			stage(theme),
		);
		lines.push(field("Pipeline:", first));
		for (const line of rest) lines.push(`${" ".repeat(10)}${line}`);
```

Add `stage` as a module-level function under `status`:

```ts
/**
 * A pipeline line leads with its count. Zero is the quiet state, so the whole
 * line is muted; anything waiting gets its number in bold so it is what the
 * eye lands on. A line with no leading count (a fault) passes through.
 */
function stage(theme: Theme): (line: string) => string {
	return (line) => {
		const match = /^(\d+)( .*)$/.exec(line);
		if (match === null) return line;
		return match[1] === "0"
			? muted(theme, line)
			: `${bold(theme, match[1])}${match[2]}`;
	};
}
```

- [ ] **Step 4: Verify**

Run: `pnpm vitest run src/__tests__/status.test.ts && pnpm lint && pnpm typecheck`
Expected: PASS, including the existing column-alignment tests (lines ~139 and ~182-187), which run in plain mode and see unchanged text.

- [ ] **Step 5: Commit**

`feat(cli): color status by what needs attention :traffic_light:`, body `Refs ONL-185`.

---

### Task 6: Styled sync

**Files:**
- Modify: `src/commands/sync.ts` (`SyncDeps`, `describePull`, `withNote`, final return)
- Modify: `src/__tests__/sync.test.ts`

**Interfaces:**
- Consumes: `Theme`, `PLAIN`, `ok`, `warn`, `muted`, `stripSgr`.
- Produces: `SyncDeps` gains `theme?: Theme`.

- [ ] **Step 1: Write the failing tests**

Append to `sync.test.ts` (add `import { stripSgr } from "../ui";`):

```ts
describe("sync styling", () => {
	const COLOR = { color: true, width: Number.POSITIVE_INFINITY };

	it("marks a successful push with a check", async () => {
		const env = linked();
		withLessons(env, 2);
		const message = await sync({ env, fetchImpl: accepts() });
		expect(message.split("\n")[0]).toMatch(/^✓ Synced 2 lessons/);
	});

	it("does not dress a healthy idle pull as a warning", async () => {
		const env = linked();
		withLessons(env, 1);
		const message = await sync({ env, fetchImpl: accepts() });
		expect(message).toContain(
			"Received nothing: the pool holds nothing this machine does not.",
		);
		expect(message).not.toContain("○ Received nothing");
	});

	// The rule ui.ts exists to keep: color is emphasis, never words.
	it("says exactly the same words with color on", async () => {
		const env = linked();
		withLessons(env, 2);
		const plain = await sync({ env, fetchImpl: accepts() });
		const colored = await sync({ env, fetchImpl: accepts(), theme: COLOR });
		expect(colored).not.toBe(plain);
		expect(stripSgr(colored)).toBe(plain);
	});
});
```

If `accepts()`'s default pull answer is not the idle "holds nothing" case, read `routed` (line ~71) and pass the override that yields `received` with all counts zero.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/__tests__/sync.test.ts -t "sync styling"`
Expected: FAIL (no `✓`).

- [ ] **Step 3: Implement**

In `sync.ts`:

1. Import `{ muted, ok, PLAIN, type Theme, warn } from "../ui"`; add `theme?: Theme` to `SyncDeps` and `theme = PLAIN` to the destructuring in `sync`.
2. Give `describePull` a `theme: Theme` parameter and wrap its returns:
   - `received` with `total === 0` and no invalid: `muted(theme, line)`. With invalid entries, return the existing concatenation unstyled, since it reports a refusal.
   - `received` with `total > 0`: unchanged.
   - `gap` and `default`: prefix `` `${warn(theme, "○")} ` `` to the existing template string.
3. In `withNote`, pass `theme` to `describePull` and prefix the two notes:

```ts
	const notice = (note: string | null) =>
		note === null ? null : `${warn(theme, "○")} ${note}`;
	const withNote = async (message: string): Promise<string> => {
		const received = describePull(await pull({ client, env }), theme);
		return [message, received, notice(inventoryNote), notice(sessionsNote)]
			.filter((line): line is string => line !== null)
			.join("\n");
	};
```

4. Change only the final success return to `` return await withNote(`${ok(theme, "✓")} ${summary}`); ``. The thrown `ApiError` keeps the bare `summary`, because that path is a failure and `cli.ts` prefixes it with `✕`.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run && pnpm lint && pnpm typecheck`
Expected: PASS. An existing assertion anchored on `^Synced` or on `Inventory not reported` at a line start may need the glyph added. Change only the glyph.

- [ ] **Step 5: Commit**

`feat(cli): let sync's success and warnings look different :white_check_mark:`, body `Refs ONL-185`.

---

### Task 7: Styled link and playbook

**Files:**
- Modify: `src/commands/link.ts`, `src/commands/playbook.ts`
- Modify: `src/__tests__/link.test.ts`, `src/__tests__/playbook-command.test.ts`

**Interfaces:**
- Consumes: `Theme`, `PLAIN`, `ok`, `underline`, `muted`, `heading`, `accent`, `stripSgr`.
- Produces: `LinkDeps.theme?: Theme`; `playbook(opts)` gains `theme?: Theme`.

- [ ] **Step 1: Write the failing tests**

Append to `link.test.ts` (import `stripSgr` from `../ui`):

```ts
	it("confirms with a check and puts the next step on its own line", async () => {
		const message = await link({ env: env(), prompt: async () => "t", fetchImpl: ok() });
		expect(message).toBe(
			"✓ Linked to https://api.onlooker.dev.\nRun `onlooker sync` to push lessons.",
		);
	});

	it("says exactly the same words with color on", async () => {
		const deps = { prompt: async () => "t", fetchImpl: ok() };
		const plain = await link({ env: env(), ...deps });
		const colored = await link({
			env: env(),
			...deps,
			theme: { color: true, width: Number.POSITIVE_INFINITY },
		});
		expect(stripSgr(colored)).toBe(plain);
		expect(colored).toContain("\u001b[4mhttps://api.onlooker.dev");
	});
```

If `env()` in this file configures a different `apiBaseUrl`, use that URL in both assertions.

Append inside `describe` in `playbook-command.test.ts` (import `stripSgr`):

```ts
	it("says exactly the same words with color on, and never colors JSON", async () => {
		const env = mirrored([
			{
				...FIXTURE,
				id: IDS[1],
				applies_to: { ...FIXTURE.applies_to, file_patterns: ["nothing/here.ts"] },
			},
			{
				...FIXTURE,
				id: IDS[2],
				applies_to: { ...FIXTURE.applies_to, stack: ["not-installed"] },
			},
		]);
		const cwd = project({ vite: "5.2.1" });
		const COLOR = { color: true, width: Number.POSITIVE_INFINITY };

		const plain = await playbook({ env, cwd });
		const colored = await playbook({ env, cwd, theme: COLOR });
		expect(colored).not.toBe(plain);
		expect(stripSgr(colored)).toBe(plain);

		const json = await playbook({ env, cwd, json: true, theme: COLOR });
		expect(json).not.toContain("\u001b[");
		expect(() => JSON.parse(json)).not.toThrow();
	});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/__tests__/link.test.ts src/__tests__/playbook-command.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`link.ts`: import `{ muted, ok, PLAIN, type Theme, underline } from "../ui"`, add `theme?: Theme` to `LinkDeps` and `theme = PLAIN` to the destructuring, and replace the return:

```ts
	return `${ok(theme, "✓")} Linked to ${underline(theme, config.apiBaseUrl)}.\n${muted(theme, "Run `onlooker sync` to push lessons.")}`;
```

`playbook.ts`: import `{ accent, heading, muted, PLAIN, type Theme } from "../ui"`, add `theme?: Theme` to the `opts` type and `const theme = opts.theme ?? PLAIN;` next to `env`/`cwd`. Leave the `if (opts.json)` branch exactly as it is. Give `section` a `theme` parameter (rename its `heading` parameter to `title` so it no longer shadows the import), pass `theme` at all four call sites, and rewrite it:

```ts
function section(
	lines: string[],
	title: string,
	entries: Entry[],
	theme: Theme,
): void {
	if (entries.length === 0) return;
	lines.push("", heading(theme, `${title} (${entries.length}):`));
	for (const entry of entries) {
		lines.push(`  ${accent(theme, entry.id)}  ${entry.claim}`);
		lines.push(`    ${muted(theme, reasonOf(entry.verdict))}`);
	}
}
```

Replace the invalid block with:

```ts
	if (invalid.length > 0) {
		lines.push(
			"",
			heading(theme, `${invalid.length} mirrored file(s) the contract refuses:`),
			...invalid.map((line) => `  ${muted(theme, line)}`),
		);
	}
```

- [ ] **Step 4: Verify**

Run: `pnpm vitest run && pnpm lint && pnpm typecheck`
Expected: PASS. If an existing link test asserts the old single-line message with `toBe`, update it to the two-line form.

- [ ] **Step 5: Commit**

`feat(cli): style link's confirmation and playbook's sections :bookmark_tabs:`, body `Refs ONL-185`.

---

### Task 8: Wire themes, header, usage, errors and spinners in `cli.ts`

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/__tests__/cli.test.ts`

**Interfaces:**
- Consumes: `resolveTheme`, `header`, `pill`, `accent`, `muted`, `bad`, `withSpinner`, `type Theme`, plus the new `theme` deps on all five commands.
- Produces: `run(argv: string[], env?: NodeJS.ProcessEnv): Promise<number>` (`env` is used only for theme resolution, default `process.env`), and `usage(theme: Theme): string`, which replaces the `USAGE` constant.

- [ ] **Step 1: Write the failing tests**

In `cli.test.ts`, change the helper so the suite never picks up a `FORCE_COLOR` from CI:

```ts
const invoke = (...args: string[]) => run(["node", "onlooker", ...args], {});
```

Import `usage` from `../cli` and `{ PLAIN, stripSgr }` from `../ui`, then append:

```ts
describe("presentation", () => {
	it("opens a command's report with the header pill", async () => {
		mockedSync.mockResolvedValueOnce("✓ Synced 2 lessons: 2 new.");
		await invoke("sync");
		expect(out.join("\n")).toBe(" ONLOOKER  sync\n\n✓ Synced 2 lessons: 2 new.");
	});

	it("marks an error on stderr without changing its words", async () => {
		mockedSync.mockRejectedValueOnce(new Error("EACCES: permission denied"));
		await invoke("sync");
		expect(err.join("\n")).toBe("✕ EACCES: permission denied");
	});

	it("prints usage under the pill with every command aligned", async () => {
		await invoke("--help");
		const text = out.join("\n");
		expect(text.split("\n")[0]).toBe(
			" ONLOOKER  push approved lessons to app.onlooker.dev",
		);
		expect(text).toContain("  onlooker link     connect this machine");
		expect(text).toContain("  onlooker playbook which mirrored lessons apply here");
	});

	it("colors usage only when the theme says so", () => {
		expect(usage(PLAIN)).not.toContain("\u001b[");
		expect(stripSgr(usage({ color: true, width: 80 }))).toBe(usage(PLAIN));
	});
});
```

The existing "names the command it did not recognize" test should still pass, because `✕ unknown command: snyc` matches `/unknown command: snyc/`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/__tests__/cli.test.ts`
Expected: FAIL (`usage` is not exported, no header).

- [ ] **Step 3: Implement**

Import `{ accent, bad, header, muted, pill, resolveTheme, type Theme, withSpinner } from "./ui"`. Replace the `USAGE` constant with:

```ts
// No argument-parsing library. Three commands and no flags do not justify one,
// and a switch is easier to read than the framework would be.
const COMMANDS: Array<[name: string, does: string]> = [
	["link", "connect this machine with a token from the Machines page"],
	["sync", "push every approved lesson"],
	["playbook", "which mirrored lessons apply here"],
	["status", "what is linked, and what is waiting"],
	["doctor", "which plugin streams are still recording"],
];

export function usage(theme: Theme): string {
	const rows = COMMANDS.map(
		([name, does]) =>
			`  ${accent(theme, `onlooker ${name}`)}${" ".repeat(9 - name.length)}${muted(theme, does)}`,
	);
	return `${pill(theme, "ONLOOKER")} push approved lessons to app.onlooker.dev\n\n${rows.join("\n")}\n`;
}
```

Change the `run` signature to `run(argv: string[], env: NodeJS.ProcessEnv = process.env)`, and start its body with:

```ts
	const out = resolveTheme(env, process.stdout);
	const err = resolveTheme(env, process.stderr);
	// Header, blank line, report. Only for a report: errors and `--json` are
	// read by people and programs that want the bytes and nothing else.
	const show = (command: string, text: string) =>
		console.log(`${header(out, command)}\n\n${text}`);
```

Then rewrite the branches. The existing comments stay in their branches.

```ts
		if (command === "link") {
			show("link", await link({ prompt: promptForToken, theme: out }));
		} else if (command === "sync") {
			show(
				"sync",
				await withSpinner(err, "syncing lessons…", () => sync({ theme: out })),
			);
		} else if (command === "playbook") {
			const json = argv.includes("--json");
			const text = await playbook({ json, theme: out });
			if (json) console.log(text);
			else show("playbook", text);
		} else if (command === "status") {
			show("status", await status({ theme: out }));
		} else if (command === "doctor") {
			const report = await withSpinner(err, "surveying streams…", () =>
				doctor({ theme: out }),
			);
			show("doctor", report.text);
			return report.code;
		} else if (
			command === undefined ||
			command === "--help" ||
			command === "-h" ||
			command === "help"
		) {
			console.log(usage(out));
		} else {
			console.error(bad(err, `✕ unknown command: ${command}`));
			console.error(usage(err));
			return 1;
		}
```

In the `catch`:

```ts
		const failure = error instanceof ApiError ? error.failure : undefined;
		console.error(
			`${bad(err, "✕")} ${failure ? failure.message : (error as Error).message}`,
		);
		return failure?.kind === "transient" ? 2 : 1;
```

Check that `main.ts` still calls `run(process.argv)`. It does, because the default `env` covers it.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run && pnpm lint && pnpm typecheck && pnpm build`
Expected: PASS, and `dist/onlooker.mjs` builds. The existing "exits 0 and prints what the command returned" test still passes because it uses `toContain`.

- [ ] **Step 5: Commit**

`feat(cli): open every report with the onlooker pill :sparkles:`, body `Refs ONL-185`.

---

### Task 9: Prove the guard, look at it, release

**Files:**
- Modify: `apps/cli/package.json` (`version` only)
- Temporarily modify, then revert: `src/ui.ts`

- [ ] **Step 1: Ablation, proving the color-strip tests can fail**

Temporarily change `ok` in `ui.ts` to `(t, s) => paint(t, "38;5;78", t.color ? s.toUpperCase() : s)`.
Run: `pnpm vitest run`
Expected: FAIL in the "same words with color on" tests for status, sync and link, and in doctorLines'. If any of those passes, it isn't guarding anything. Fix the test before going on.
Revert `ok` with the Edit tool, re-run `pnpm vitest run`, and expect PASS. Record which tests failed under ablation for the PR description.

- [ ] **Step 2: Look at it in a real terminal**

Run: `pnpm build`
Ask the user to run these in their own terminal. A pty is the only honest test of a spinner, and a captured byte stream is not a screen.

```
! node apps/cli/dist/onlooker.mjs doctor
! node apps/cli/dist/onlooker.mjs status
! node apps/cli/dist/onlooker.mjs --help
! node apps/cli/dist/onlooker.mjs doctor | cat
! NO_COLOR=1 node apps/cli/dist/onlooker.mjs doctor
```

Expected: color and the spinner in the first three. The `| cat` and `NO_COLOR` runs show the same layout with no escape codes and no spinner residue. Fix anything they flag before going on.

- [ ] **Step 3: Bump the version**

In `apps/cli/package.json`, change `"version": "2.9.0"` to `"version": "2.10.0"`. `tag-cli.yml` releases on a version change and nothing else.

Run: `pnpm vitest run && pnpm lint && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 4: Commit**

`chore(cli): release 2.10.0 with styled output :package:`. The body explains why minor: the layout changes for anyone parsing it. Include `Refs ONL-185`.
