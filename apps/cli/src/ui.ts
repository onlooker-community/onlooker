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
		width: tty && stream.columns ? stream.columns : Number.POSITIVE_INFINITY,
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
