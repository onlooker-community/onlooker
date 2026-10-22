# Charm-inspired styling for the CLI

**Issue:** ONL-185 · **Status:** approved 2026-10-22 · **Repos:** onlooker (`apps/cli`)

## Problem

Every `onlooker` command prints undecorated text: `cli.ts` hands each
command's returned string to `console.log`, and nothing in `apps/cli` emits a
color or a glyph. The output is correct and carefully worded, and it is flat.
A healthy `doctor` and one with a stopped stream look the same at a glance
until the eye finds `STOPPED` in a column of lower-case words.

The goal is output in the spirit of Charm's tools (Lip Gloss, Bubbles, gum):
a colored header pill, state badges, dimmed detail, a spinner while work runs.
It is a polish pass, chosen because it would be a pleasure to use, not
because something is broken.

## Decision: a small style module in TypeScript, no Go

Charm's libraries are Go. The CLI is TypeScript bundled by esbuild into one
`dist/onlooker.mjs` with no runtime dependencies beyond the workspace. Three
routes were weighed:

- **Port the CLI to Go** to use Lip Gloss and Bubble Tea themselves. Ruled
  out: a full port of ~5,800 lines and their tests, and the release changes
  from one `.mjs` to per-platform binaries. That is a project, not a polish.
- **A JS terminal-UI library** such as Ink. Ruled out: a React runtime in the
  bundle buys interactive screens, and no command needs one.
- **A hand-written style module** that the existing renderers call. Chosen.

Within that route, two other shapes were rejected. Returning a structured
document model (`Section[]`, `Row[]`) for one generic printer would move
`doctorLines`' deliberate wording into data and rewrite five renderers.
Coloring the finished plain text with regexes would paint the word "stopped"
inside a detail sentence.

## The `ui.ts` module

One new file, `apps/cli/src/ui.ts`, no new dependencies, roughly 120 lines.

### Theme

`resolveTheme(env, stream)` returns `{ color: boolean; width: number }`.

- `color` is true only when the stream is a TTY, `NO_COLOR` is unset (any
  value, including empty, disables it, per no-color.org), and `TERM` is not
  `dumb`. `FORCE_COLOR` set to anything other than `0` turns it on regardless.
- `width` is the stream's `columns`, or 80 when it has none.

`cli.ts` resolves the theme once for stdout and once for stderr and passes it
to each command. Commands do not read `process.stdout` or `process.env`
themselves, so a test controls the theme by passing one.

### Palette

256-color ANSI codes. Nearly every terminal supports them, so there is no
truecolor detection to get wrong.

| Role | Code | Used for |
|---|---|---|
| accent | 205 (pink) | pill background, command names, entry ids, `›` |
| heading | 141 (violet) | section headings, `Label:` columns |
| ok | 78 (green) | `●` recording, `✓`, `accepted` |
| warn | 214 (amber) | `○` unknown, `not linked`, caveats |
| bad | 203 (red) | `✕` STOPPED, rejected, faults, errors |
| muted | 245 (gray) | details, reasons, zero counts |

### Primitives

Every primitive returns its input's words unchanged and only adds escape
codes when `theme.color` is true. Glyphs (`●` `○` `✕` `·` `✓` `╰` `›`) are
part of the layout and appear in plain mode too.

- `pill(theme, text)`: inverted accent block, ` ONLOOKER `.
- `header(theme, command)`: `pill("ONLOOKER")` + two spaces + the command name.
- `heading(theme, text)`: violet.
- `label(theme, text)`: violet, for `API:`, `Token:` and the like. The caller
  keeps its existing padding.
- `badge(theme, state)`: glyph plus word, padded to a fixed visible width.
  `recording` → `● recording` ok, `unknown` → `○ unknown` warn, `stopped` →
  `✕ STOPPED` bad and bold, `no-rule` → `· no rule` muted.
- `ok`, `warn`, `bad`, `muted`, `accent`, `bold`, `underline`: plain wrappers.
- `visibleWidth(s)`: length with SGR sequences stripped, so `padEnd`-style
  alignment stays correct when color is on.
- `wrap(theme, text, column, width)`: breaks `text` on spaces to fit
  `width - column`. Continuation lines start at `column - 2` with `╰ ` for the
  first and two spaces for the rest. A single word longer than the space is
  left whole rather than split.

### Spinner

`withSpinner(theme, label, work)` runs `work()` and returns its result.

- Draws only when the **stderr** theme has color, so pipes, CI and tests see
  nothing. stdout is never touched.
- Frames `⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷` at 80 ms, accent-colored, followed by the label
  in muted.
- Clears its line (`\r\x1b[2K`) and stops its timer in a `finally`, so a
  rejected `work()` leaves no stray frame and no live interval.

## How each command uses it

These rules apply to every command:

- Successful stdout output starts with `header(theme, "<command>")` and a
  blank line. Errors on stderr and `playbook --json` get no header.
- Existing sentences keep every word. Styling changes emphasis and layout
  only. The one new sentence is doctor's tally line.
- Errors from the dispatcher go to stderr as `✕ <message>` in bad. Exit codes
  are unchanged: 1 for something to change, 2 for something to retry.

### doctor

- `Expected:` and `Caution:` keep their text. Labels are violet, and the
  caution value is warn.
- Each verdict row is `plugin` (padded as today) + `badge(verdict)` + muted
  detail. A detail too wide for the terminal wraps under the detail column
  with `╰`. `label()` in `streams.ts` is replaced by `badge()`; its comment
  about why STOPPED is upper case moves with it.
- The footer heading keeps both of its wordings and is violet. Footer rows
  keep plugin + muted detail and get no badge, because they are not verdicts.
- `Fault:` lines become `✕ Fault: …` in bad.
- New last line, the tally: `● 13 recording  ○ 1 unknown  ✕ 1 stopped`,
  listing only the states with a nonzero count, each in its badge color.
  Nothing is printed when there are no verdicts.
- The survey runs inside `withSpinner(…, "surveying streams…")`.

### status

- Same label/value block, same ten-column alignment. Labels violet.
- `Token:` value: `accepted` ok, `rejected` bad, `not linked` and `unknown`
  warn. The `onlooker link` in the not-linked hint is accent.
- `Lessons:` count is bold when nonzero.
- `Pipeline:` lines: nonzero counts bold, zero counts muted.

### sync

- The summary line is prefixed `✓` in ok when the push succeeded.
- `Inventory not reported:`, `Sessions not reported:` and `Received nothing:`
  lines are prefixed `○` in warn with the reason muted.
- The push runs inside `withSpinner(…, "syncing lessons…")`.

### link

- The token prompt gains an accent `›` before its existing text.
- Success becomes `✓ Linked to <url>.` with the URL underlined, then
  `Run \`onlooker sync\` to push lessons.` on its own muted line.

### playbook

- Section headings (`Applies here (3):` and the rest) are violet, entry ids
  accent, claims in the default color, reasons muted.
- `--json` output never passes through the theme. It is written exactly as
  today.

### help and unknown commands

- Usage starts with the header pill. Command names are accent and aligned,
  descriptions muted.
- An unknown command prints `✕ unknown command: <name>` (current wording kept)
  to stderr in bad, then the usage, styled with the stderr theme.

## Testing

- **`ui.ts` unit tests**, color forced on: exact escape sequences per role,
  `visibleWidth` against colored strings, `wrap` at boundary widths and with
  an over-long word, `badge` widths equal across states, and the spinner
  clearing its line and its interval on both resolve and reject.
- **`resolveTheme` tests**: TTY vs not, `NO_COLOR` empty and set, `TERM=dumb`,
  `FORCE_COLOR=0` and `=1`, missing `columns`.
- **Command tests** run with the plain theme. Their expected strings are
  updated once for the new layout (header, glyphs, tally) and keep asserting
  exact bytes.
- **Color-strip equivalence**: for each command, render once with color on and
  once plain, and assert that stripping SGR sequences from the first yields
  the second byte for byte. This is the guard that color never changes a
  word; prove it by ablation, making one primitive alter its text under
  color and watching the test fail.

## Release

Bump `apps/cli/package.json` to **2.10.0**. `tag-cli.yml` releases on a
version change and nothing else, so without the bump the change merges and no
installed CLI shows it. Minor rather than patch because the output layout
changes for anyone parsing it.

## Out of scope

- Interactive views (selection lists, live-updating tables).
- Truecolor and light/dark palette detection.
- A `--no-color` flag. `NO_COLOR` covers it.
