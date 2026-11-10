# CLI Crash Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The onlooker CLI reports its own crashes to Sentry, only from machines whose owner ran `onlooker crash-reports on`, and only with the fields the spec allows.

**Architecture:** `apps/cli` decides whether an error is a crash (`errors.ts`) and whether this machine consented (`consent.ts`). Only then does `monitoring.ts` dynamically import a new `@onlooker/monitoring-sentry/node` adapter. The adapter is built on `@sentry/core` alone, with a `fetch` transport and no Node integrations. It sends one scrubbed event and flushes before `run()` returns. Nothing else in the CLI imports Sentry.

**Tech Stack:** TypeScript, Node 20+, esbuild (single-file ESM bundle), vitest, `@sentry/core` 10.74.0, pnpm workspaces, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-09-cli-crash-reports-design.md`

## Global Constraints

- Nothing is sent unless `cli.json` holds `crashReports: true` and neither `ONLOOKER_CRASH_REPORTS` (set to `0`, `false`, `off` or `no`) nor `DO_NOT_TRACK` (set to anything but empty, `0` or `false`) turns it off. The environment can only turn reporting off.
- The CLI never prompts for consent.
- Never reported: `ApiError`, `CliError`, or an error whose `code` is a string matching `/^E[A-Z]+$/`.
- Reporting never changes the exit code or the existing `✕ <message>` stderr line. A report whose flush drained adds exactly one muted stderr line: `reported this crash (onlooker crash-reports off to stop)`.
- A report never contains a hostname (`server_name`), username, `user`, machine ID or token, email, working directory, environment variables, `argv` beyond the subcommand, file contents or lesson text.
- Tags are exactly `command`, `os`, `arch` and `node` (major version).
- `release` is `onlooker-cli@<apps/cli/package.json version>`. `environment` is `production` only for a `build:release` bundle, otherwise `development`.
- `@onlooker/monitoring-sentry/node` imports only `@sentry/core`, `@onlooker/monitoring` and its own siblings, never `@sentry/node` or a `node:` module.
- Run one test file as `pnpm --filter <pkg> test <name>`, with no `--`.
- Edit tracked files with the Edit and Write tools, never with `sed -i`, heredocs or `biome check --write` / `lint:fix`. Check lint with `pnpm --filter <pkg> lint`, which only reports.
- Commit through `/git-workflow:commit`. American English in code, comments and messages.
- Test literals must not be credential-shaped, and a variable named `token`, `secret` or `password` must not be assigned a quoted string: a hook blocks writes that look like either. Build a secret-shaped value at runtime and give it a neutral name (`const hex = "0123456789abcdef".repeat(3)`).

---

## File structure

| File | Responsibility |
|---|---|
| `apps/cli/src/errors.ts` (new) | `CliError`, and `isCrash(error)` |
| `apps/cli/src/consent.ts` (new) | `crashConsent(env)` and `describeConsent(consent, theme)` |
| `apps/cli/src/commands/crash-reports.ts` (new) | The `onlooker crash-reports` command, and the text saying what is sent |
| `apps/cli/src/monitoring.ts` (new) | `reportCrash`: consent gate, lazy import, capture, flush |
| `packages/monitoring-sentry/src/node.ts` (new) | `createNodeMonitor`: a core-only Sentry client with a fetch transport |
| `apps/cli/src/config.ts` | `crashReports?: boolean` on `CliConfig` |
| `apps/cli/src/cli.ts` | Dispatch for the new command; the crash branch in `catch`; `ONLOOKER_CRASH_TEST` |
| `apps/cli/src/commands/status.ts` | One `Crashes:` line |
| `apps/cli/src/{config,pool,eventlog}.ts`, `commands/{link,sync}.ts` | Deliberate throws become `CliError` |
| `apps/cli/package.json`, `apps/cli/tsconfig.json`, `pnpm-lock.yaml` | Dependencies, `build:release`, JSON import |
| `packages/monitoring-sentry/package.json` | The `./node` export |
| `.github/workflows/release-cli.yml` | Builds with `build:release` |
| `scripts/sentry/rules/cli-crashes.json` (new) | Alert on new production issues in `onlooker-cli` |
| `docs/runbooks/2026-11-09-cli-crash-reports.md` (new) | Operations |

---

### Task 1: Tell a crash from a deliberate failure

**Files:**
- Create: `apps/cli/src/errors.ts`
- Create: `apps/cli/src/__tests__/errors.test.ts`
- Modify: `apps/cli/src/config.ts:46`, `apps/cli/src/pool.ts:80`, `apps/cli/src/pool.ts:87`, `apps/cli/src/pool.ts:125`, `apps/cli/src/eventlog.ts:529`, `apps/cli/src/commands/link.ts:28`, `apps/cli/src/commands/sync.ts:195`

**Interfaces:**
- Consumes: `ApiError` from `apps/cli/src/api.ts`.
- Produces: `export class CliError extends Error` and `export function isCrash(error: unknown): boolean`, both from `apps/cli/src/errors.ts`.

The two `throw new Error("not an object")` lines in `eventlog.ts` (around lines 256 and 725) are caught by their own surrounding `try` and never leave the function. **Leave them as they are.**

- [ ] **Step 1: Write the failing test**

`apps/cli/src/__tests__/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import { CliError, isCrash } from "../errors";

describe("isCrash", () => {
	// A refusal or a dropped connection is the API talking, not a defect in
	// the CLI. Reporting those would fill the project with the network.
	it("never counts an ApiError", () => {
		expect(
			isCrash(new ApiError({ kind: "transient", message: "503" })),
		).toBe(false);
	});

	// The deliberate messages: a bad config, no token, a corrupt local file.
	// The user can act on each, and each names a local path.
	it("never counts a CliError", () => {
		expect(isCrash(new CliError("cli.json could not be read"))).toBe(false);
	});

	// A permissions problem or a full disk describes the machine, not the CLI.
	it("never counts a system error", () => {
		const error = Object.assign(new Error("EACCES: permission denied"), {
			code: "EACCES",
		});
		expect(isCrash(error)).toBe(false);
	});

	it("counts anything else", () => {
		expect(isCrash(new TypeError("cannot read properties of undefined"))).toBe(
			true,
		);
		expect(isCrash(new Error("plain"))).toBe(true);
		expect(isCrash("a thrown string")).toBe(true);
	});

	// A `code` that is not an errno name is not a system error. Without the
	// pattern, any library error with a `code` field would hide a real bug.
	it("counts an error whose code is not an errno name", () => {
		const error = Object.assign(new Error("bad"), { code: "ERR_INVALID_ARG" });
		expect(isCrash(error)).toBe(true);
	});

	it("keeps the message a CliError was given", () => {
		const error = new CliError("No token entered. Nothing was changed.");
		expect(error.message).toBe("No token entered. Nothing was changed.");
		expect(error).toBeInstanceOf(Error);
	});
});
```

- [ ] **Step 2: Run it and check it fails**

Run: `pnpm --filter @onlooker/cli test errors`
Expected: FAIL, because `../errors` can't be resolved.

- [ ] **Step 3: Write `errors.ts`**

`apps/cli/src/errors.ts`:

```ts
import { ApiError } from "./api";

/**
 * A failure the CLI meant to raise, with a message for the person at the
 * keyboard: a config it could not read, a token nobody entered, a local file
 * in a shape it refuses to guess at.
 *
 * Its own class so a crash report can leave it out. Every one of these names
 * a local path or the user's own setup, and none is a defect anyone but the
 * user can fix.
 */
export class CliError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliError";
	}
}

/** `EACCES`, `ENOSPC`, `EISDIR`: Node's names for what the OS refused. */
const ERRNO = /^E[A-Z]+$/;

/**
 * Whether an error reaching `run()`'s catch is a defect worth reporting.
 *
 * Everything the CLI or the API said on purpose is excluded, and so is the
 * operating system refusing something. What remains is the case nobody wrote
 * a message for: a TypeError, a parser that assumed a shape, an unguarded
 * JSON.parse. Node's own `ERR_*` codes are not errno names, so they still
 * count.
 */
export function isCrash(error: unknown): boolean {
	if (error instanceof ApiError || error instanceof CliError) return false;
	const code = (error as { code?: unknown } | null | undefined)?.code;
	return !(typeof code === "string" && ERRNO.test(code));
}
```

- [ ] **Step 4: Run the test and check it passes**

Run: `pnpm --filter @onlooker/cli test errors`
Expected: PASS, 6 tests.

- [ ] **Step 5: Turn the deliberate throws into `CliError`**

At each of these sites, change `throw new Error(` to `throw new CliError(`, keep the message byte for byte, and add `import { CliError } from "./errors";` (or `"../errors"` under `commands/`) beside the file's other imports:

- `apps/cli/src/config.ts:46`: `${path} could not be read: …`
- `apps/cli/src/pool.ts:80`: `${path} does not hold an integer seq`
- `apps/cli/src/pool.ts:87`: `${path} holds a held list that is not integer seqs`
- `apps/cli/src/pool.ts:125`: `refusing to write a lesson whose id is not a ULID: …`
- `apps/cli/src/eventlog.ts:529`: `${path} could not be fully read: …`
- `apps/cli/src/commands/link.ts:28`: `No token entered. Nothing was changed.`
- `apps/cli/src/commands/sync.ts:195`: `This machine is not linked. …`

Then confirm nothing else escapes as a plain `Error`. Run `grep -n 'throw new Error' apps/cli/src/*.ts apps/cli/src/commands/*.ts`. The only remaining lines should be the two `"not an object"` throws in `eventlog.ts`.

**If `config.ts` importing `./errors` creates an import cycle** (`errors.ts` imports `api.ts`, so check whether `api.ts` imports `config.ts`), the typecheck and tests still pass, since ES modules allow cycles between declarations. Don't restructure to avoid one.

- [ ] **Step 6: Run the CLI suite, typecheck and lint**

Run: `pnpm --filter @onlooker/cli test`, then `pnpm --filter @onlooker/cli typecheck`, then `pnpm --filter @onlooker/cli lint`
Expected: all pass. The existing `toThrow(/could not be read/i)`-style assertions still pass, because the messages didn't change.

- [ ] **Step 7: Commit**

Through `/git-workflow:commit`, with `apps/cli/src/errors.ts`, `apps/cli/src/__tests__/errors.test.ts` and the seven modified files. Suggested subject: `feat(cli): tell a crash from a failure it meant to raise`.

---

### Task 2: Record consent, and the `crash-reports` command

**Files:**
- Modify: `apps/cli/src/config.ts` (`CliConfig`, `readConfig`)
- Create: `apps/cli/src/consent.ts`
- Create: `apps/cli/src/commands/crash-reports.ts`
- Modify: `apps/cli/src/cli.ts` (`COMMANDS`, `usage`, dispatch)
- Modify: `apps/cli/src/commands/status.ts` (one line after `Config:`)
- Test: `apps/cli/src/__tests__/consent.test.ts` (new), `apps/cli/src/__tests__/crash-reports.test.ts` (new), `apps/cli/src/__tests__/status.test.ts`, `apps/cli/src/__tests__/cli.test.ts`

**Interfaces:**
- Consumes: `CliError` from Task 1; `readConfig`, `writeConfig` and `configPath` from `config.ts`; `ok`, `muted`, `warn`, `PLAIN` and `Theme` from `ui.ts`.
- Produces:
  - `CliConfig.crashReports?: boolean`
  - `export type CrashConsent = { on: true } | { on: false; why: "not-chosen" | "turned-off" | "unreadable" } | { on: false; why: "environment"; variable: "DO_NOT_TRACK" | "ONLOOKER_CRASH_REPORTS" }`
  - `export function crashConsent(env?: NodeJS.ProcessEnv): CrashConsent`
  - `export function describeConsent(consent: CrashConsent, theme: Theme): string`
  - `export function crashReports(action: string | undefined, deps?: { env?: NodeJS.ProcessEnv; theme?: Theme }): string`
  - `export const WHAT_IS_SENT: string`

- [ ] **Step 1: Write the failing consent tests**

`apps/cli/src/__tests__/consent.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath, writeConfig } from "../config";
import { crashConsent } from "../consent";

const API = "https://api.onlooker.dev";

function sandbox(crashReports?: boolean): NodeJS.ProcessEnv {
	const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-cli-")) };
	if (crashReports !== undefined) writeConfig({ apiBaseUrl: API, crashReports }, env);
	return env;
}

describe("crashConsent", () => {
	it("is off until someone chooses", () => {
		expect(crashConsent(sandbox())).toEqual({ on: false, why: "not-chosen" });
	});

	it("is on only when cli.json says so", () => {
		expect(crashConsent(sandbox(true))).toEqual({ on: true });
		expect(crashConsent(sandbox(false))).toEqual({
			on: false,
			why: "turned-off",
		});
	});

	// The environment can only take consent away. A shell, a CI runner or a
	// dotfile must never be able to opt a machine in.
	it("lets DO_NOT_TRACK override a recorded yes", () => {
		const env = { ...sandbox(true), DO_NOT_TRACK: "1" };
		expect(crashConsent(env)).toEqual({
			on: false,
			why: "environment",
			variable: "DO_NOT_TRACK",
		});
	});

	it("lets ONLOOKER_CRASH_REPORTS=0 override a recorded yes", () => {
		for (const value of ["0", "false", "off", "no"]) {
			const env = { ...sandbox(true), ONLOOKER_CRASH_REPORTS: value };
			expect(crashConsent(env)).toMatchObject({
				on: false,
				variable: "ONLOOKER_CRASH_REPORTS",
			});
		}
	});

	it("cannot be turned on from the environment", () => {
		const env = { ...sandbox(), ONLOOKER_CRASH_REPORTS: "1" };
		expect(crashConsent(env)).toEqual({ on: false, why: "not-chosen" });
	});

	it("ignores an empty or zero DO_NOT_TRACK", () => {
		for (const value of ["", "0", "false"]) {
			expect(crashConsent({ ...sandbox(true), DO_NOT_TRACK: value })).toEqual({
				on: true,
			});
		}
	});

	// Asked from inside a crash handler. A second throw there would replace
	// the error being reported with one about the config.
	it("answers off, not a throw, for a config it cannot read", () => {
		const env = sandbox(true);
		writeFileSync(configPath(env), "{ not json");
		expect(crashConsent(env)).toEqual({ on: false, why: "unreadable" });
	});
});
```

- [ ] **Step 2: Run it and check it fails**

Run: `pnpm --filter @onlooker/cli test consent`
Expected: FAIL, because `../consent` can't be resolved, and TypeScript rejects `crashReports` on `CliConfig`.

- [ ] **Step 3: Add the field to `config.ts`**

In `apps/cli/src/config.ts`, add the field to `CliConfig` and change the comment's "two settings" to three:

```ts
export interface CliConfig {
	apiBaseUrl: string;
	machineToken?: string;
	/**
	 * Whether this machine may report the CLI's own crashes. Absent until
	 * someone runs `onlooker crash-reports on|off`; absent and false both mean
	 * nothing is sent.
	 */
	crashReports?: boolean;
}
```

Then make `readConfig`'s return carry it, accepting only a real boolean:

```ts
	return {
		apiBaseUrl: env.ONLOOKER_API_URL ?? stored.apiBaseUrl ?? DEFAULT_API,
		machineToken: stored.machineToken,
		// Only a real boolean. A hand-edited "yes" is not a recorded choice.
		crashReports:
			typeof stored.crashReports === "boolean" ? stored.crashReports : undefined,
	};
```

- [ ] **Step 4: Write `consent.ts`**

`apps/cli/src/consent.ts`:

```ts
import { readConfig } from "./config";
import { muted, ok, type Theme, warn } from "./ui";

export type CrashConsent =
	| { on: true }
	| { on: false; why: "not-chosen" | "turned-off" | "unreadable" }
	| {
			on: false;
			why: "environment";
			variable: "DO_NOT_TRACK" | "ONLOOKER_CRASH_REPORTS";
	  };

/** Values that mean "unset" under the DO_NOT_TRACK convention. */
const TRACKING_ALLOWED = new Set(["", "0", "false"]);
const OFF = new Set(["0", "false", "off", "no"]);

/**
 * Whether this machine has agreed to send the CLI's crash reports.
 *
 * Only `cli.json` can say yes, and only `onlooker crash-reports on` writes
 * that. The environment is checked first and can only say no, so a recorded
 * yes is still overridden by DO_NOT_TRACK on a machine that sets it.
 *
 * Never throws: it runs inside the crash handler, where a config that cannot
 * be read must mean "not reported", not a second error.
 */
export function crashConsent(
	env: NodeJS.ProcessEnv = process.env,
): CrashConsent {
	const dnt = env.DO_NOT_TRACK?.trim().toLowerCase();
	if (dnt !== undefined && !TRACKING_ALLOWED.has(dnt)) {
		return { on: false, why: "environment", variable: "DO_NOT_TRACK" };
	}
	const own = env.ONLOOKER_CRASH_REPORTS?.trim().toLowerCase();
	if (own !== undefined && OFF.has(own)) {
		return { on: false, why: "environment", variable: "ONLOOKER_CRASH_REPORTS" };
	}

	let stored: boolean | undefined;
	try {
		stored = readConfig(env).crashReports;
	} catch {
		return { on: false, why: "unreadable" };
	}
	if (stored === true) return { on: true };
	return { on: false, why: stored === false ? "turned-off" : "not-chosen" };
}

/** One line for `status` and `crash-reports`. */
export function describeConsent(consent: CrashConsent, theme: Theme): string {
	if (consent.on) return ok(theme, "on");
	switch (consent.why) {
		case "not-chosen":
			return `off ${muted(theme, "- `onlooker crash-reports on` to send them")}`;
		case "turned-off":
			return "off";
		case "environment":
			return `off ${muted(theme, `- ${consent.variable} is set`)}`;
		case "unreadable":
			return warn(theme, "off - cli.json could not be read");
	}
}
```

If `muted`, `ok` or `warn` aren't exported from `ui.ts` under those names, `status.ts` and `link.ts` import the ones that exist. Use the same names they use.

- [ ] **Step 5: Run the consent tests**

Run: `pnpm --filter @onlooker/cli test consent`
Expected: PASS, 7 tests.

- [ ] **Step 6: Write the failing command tests**

`apps/cli/src/__tests__/crash-reports.test.ts`:

```ts
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crashReports, WHAT_IS_SENT } from "../commands/crash-reports";
import { configPath, readConfig, writeConfig } from "../config";
import { CliError } from "../errors";

const API = "https://api.onlooker.dev";

function linked(): NodeJS.ProcessEnv {
	const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-cli-")) };
	writeConfig({ apiBaseUrl: API, machineToken: "t" }, env);
	return env;
}

describe("crash-reports", () => {
	it("records on and off, keeping the token and the file mode", () => {
		const env = linked();
		crashReports("on", { env });
		expect(readConfig(env)).toMatchObject({ machineToken: "t", crashReports: true });
		expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);

		crashReports("off", { env });
		expect(readConfig(env)).toMatchObject({ machineToken: "t", crashReports: false });
	});

	// Agreeing means knowing what you agreed to, so `on` prints the contents.
	it("prints what a report contains when turned on", () => {
		const text = crashReports("on", { env: linked() });
		expect(text).toContain(WHAT_IS_SENT);
		expect(WHAT_IS_SENT).toMatch(/never contains/i);
		expect(WHAT_IS_SENT).toMatch(/hostname/i);
	});

	it("reads the setting back without changing it", () => {
		const env = linked();
		expect(crashReports(undefined, { env })).toMatch(/^Crash reports: off/);
		expect(crashReports("status", { env })).toMatch(/^Crash reports: off/);
		expect(readFileSync(configPath(env), "utf8")).not.toContain("crashReports");
	});

	it("says when the environment is overriding a recorded yes", () => {
		const env = linked();
		crashReports("on", { env });
		expect(
			crashReports("status", { env: { ...env, DO_NOT_TRACK: "1" } }),
		).toContain("DO_NOT_TRACK is set");
	});

	it("refuses an action it does not know, as a CliError", () => {
		expect(() => crashReports("maybe", { env: linked() })).toThrow(CliError);
	});
});
```

- [ ] **Step 7: Run it and check it fails**

Run: `pnpm --filter @onlooker/cli test crash-reports`
Expected: FAIL, because `../commands/crash-reports` can't be resolved.

- [ ] **Step 8: Write the command**

`apps/cli/src/commands/crash-reports.ts`:

```ts
import { readConfig, writeConfig } from "../config";
import { crashConsent, describeConsent } from "../consent";
import { CliError } from "../errors";
import { PLAIN, type Theme } from "../ui";

export interface CrashReportsDeps {
	env?: NodeJS.ProcessEnv;
	/** How to style the output; plain text when omitted. */
	theme?: Theme;
}

/**
 * What `on` prints, so the choice is made knowing what it sends.
 *
 * This is the user-facing statement of the policy in
 * docs/superpowers/specs/2026-11-09-cli-crash-reports-design.md. If the
 * payload changes, this text changes with it.
 */
export const WHAT_IS_SENT = [
	"A crash report contains:",
	"  the error's type, message and stack, with your home directory shown as ~,",
	"  file paths cut to file names, and anything credential-shaped removed",
	"  the CLI version, the command you ran (not its arguments), your OS,",
	"  CPU architecture and Node major version",
	"",
	"It never contains:",
	"  your hostname, username, account, machine token or email",
	"  the directory you ran it in, your environment, file contents or lesson text",
	"",
	"Only unexpected errors are reported: never a refused request, a network",
	"failure, or a problem with your own files.",
	"Turn it off with `onlooker crash-reports off`, or set DO_NOT_TRACK=1.",
].join("\n");

/**
 * `onlooker crash-reports on|off|status`. No argument means `status`.
 *
 * The only way a machine opts in. Nothing prompts for it, so nothing can be
 * agreed to by a CI run or a script piping through.
 */
export function crashReports(
	action: string | undefined,
	{ env = process.env, theme = PLAIN }: CrashReportsDeps = {},
): string {
	if (action === "on" || action === "off") {
		writeConfig({ ...readConfig(env), crashReports: action === "on" }, env);
	} else if (action !== undefined && action !== "status") {
		throw new CliError(
			`unknown action: ${action}. Use onlooker crash-reports on, off or status.`,
		);
	}

	const line = `Crash reports: ${describeConsent(crashConsent(env), theme)}`;
	return action === "on" ? `${line}\n\n${WHAT_IS_SENT}` : line;
}
```

- [ ] **Step 9: Run the command tests**

Run: `pnpm --filter @onlooker/cli test crash-reports`
Expected: PASS, 5 tests.

- [ ] **Step 10: Wire it into `cli.ts`, and widen the usage column**

In `apps/cli/src/cli.ts`:

1. Import it with the other commands: `import { crashReports } from "./commands/crash-reports";`
2. Add a row to `COMMANDS`, after `doctor`:
   `["crash-reports", "whether this CLI may report its own crashes"],`
3. `usage` pads with `" ".repeat(9 - name.length)`. That is negative for the 13-character `crash-reports` and makes `repeat` throw a `RangeError`. Derive the width from the table instead:

```ts
export function usage(theme: Theme): string {
	// Derived, not a constant: a fixed 9 made `repeat` throw a RangeError the
	// moment a command name outgrew it.
	const width = Math.max(...COMMANDS.map(([name]) => name.length)) + 2;
	const rows = COMMANDS.map(
		([name, does]) =>
			`  ${accent(theme, `onlooker ${name}`)}${" ".repeat(width - name.length)}${muted(theme, does)}`,
	);
	return `${pill(theme, "ONLOOKER")} push approved lessons to app.onlooker.dev\n\n${rows.join("\n")}\n`;
}
```

4. Add a dispatch branch before the `help` branch:

```ts
		} else if (command === "crash-reports") {
			show("crash-reports", crashReports(argv[3], { theme: out }));
```

5. Change the comment `Five commands and one flag` to `Six commands and one flag`.

In `apps/cli/src/__tests__/cli.test.ts`, add one test to the `run` describe:

```ts
	it("lists crash-reports in the usage text", async () => {
		await invoke("--help");
		expect(out.join("\n")).toContain("onlooker crash-reports");
	});
```

- [ ] **Step 11: Add the `Crashes:` line to `status`**

In `apps/cli/src/commands/status.ts`, import `crashConsent` and `describeConsent` from `"../consent"`. Then make the initial `lines` array:

```ts
	const lines = [
		field("API:", config.apiBaseUrl),
		field("Config:", configPath(env)),
		field("Crashes:", describeConsent(crashConsent(env), theme)),
	];
```

`Crashes:` is eight characters, inside the ten-column pad the comment above `field` describes.

In `apps/cli/src/__tests__/status.test.ts`, add a test in the file's existing style. Use its sandbox env helper (read the top of the file for its name): run `status` against a sandbox with no config, and expect the output to match `/Crashes:\s+off/`. Then write `crashReports: true` with `writeConfig` and expect `/Crashes:\s+on/`. If the file pins the whole output exactly anywhere, update those expectations to include the new line, and leave every other line alone.

- [ ] **Step 12: Run the CLI suite, typecheck and lint**

Run: `pnpm --filter @onlooker/cli test`, then `pnpm --filter @onlooker/cli typecheck`, then `pnpm --filter @onlooker/cli lint`
Expected: all pass.

- [ ] **Step 13: Commit**

Through `/git-workflow:commit`, with the files above. Suggested subject: `feat(cli): let a machine opt in to crash reports, and only by asking`.

---

### Task 3: `@onlooker/monitoring-sentry/node`

**Files:**
- Create: `packages/monitoring-sentry/src/node.ts`
- Create: `packages/monitoring-sentry/src/node.test.ts`
- Modify: `packages/monitoring-sentry/package.json` (`exports`)
- Modify: `packages/monitoring-sentry/src/index.ts` (the doc comment lists the subpaths)

**Interfaces:**
- Consumes:
  - `MonitoringConfig` and `sentryOptions` from `./options`;
  - `createSentryMonitor()` from `./monitor`, which talks to `@sentry/core`'s global client and is already `guarded`;
  - `Monitor` and `noopMonitor` from `@onlooker/monitoring`.
- Produces:
  - `export type FetchLike = (url: string, init: { method: string; body: string | Uint8Array; headers: Record<string, string> }) => Promise<{ status: number; headers: { get(name: string): string | null } }>`
  - `export interface NodeMonitoringOptions { fetch: FetchLike; home: string }`
  - `export function createNodeMonitor(config: MonitoringConfig, options: NodeMonitoringOptions): Monitor`
  - It's exported as `@onlooker/monitoring-sentry/node`.

`fetch` and `home` are injected, not read from `globalThis` or `node:os`. That keeps the package free of Node types (its tsconfig has `lib: ["ES2022"]` and no `@types/node`), and it lets the test watch exactly what would be sent.

- [ ] **Step 1: Write the failing test**

`packages/monitoring-sentry/src/node.test.ts`:

```ts
import { noopMonitor } from "@onlooker/monitoring";
import { describe, expect, it, vi } from "vitest";
import { createNodeMonitor, type FetchLike } from "./node";

const DSN = "https://public@o1.ingest.sentry.io/1";
const HOME = "/Users/alice";

function fakeFetch() {
	return vi.fn<FetchLike>(async () => ({
		status: 200,
		headers: { get: () => null },
	}));
}

/** The event item from the one envelope `fetch` was handed. */
function sentEvent(fetch: ReturnType<typeof fakeFetch>): Record<string, any> {
	expect(fetch).toHaveBeenCalledTimes(1);
	const body = fetch.mock.calls[0]?.[1].body;
	// An envelope with no attachments serializes to a string.
	expect(typeof body).toBe("string");
	const lines = (body as string).split("\n");
	const at = lines.findIndex((line) => {
		try {
			return JSON.parse(line).type === "event";
		} catch {
			return false;
		}
	});
	return JSON.parse(lines[at + 1] as string);
}

async function capture(error: unknown, tags?: Record<string, string>) {
	const fetch = fakeFetch();
	const monitor = createNodeMonitor(
		{ dsn: DSN, environment: "production", release: "onlooker-cli@9.9.9" },
		{ fetch, home: HOME },
	);
	monitor.captureException(error, tags ? { tags } : undefined);
	expect(await monitor.flush(2000)).toBe(true);
	return sentEvent(fetch);
}

describe("createNodeMonitor", () => {
	it("is the no-op monitor when no DSN is configured, and builds no client", () => {
		const fetch = fakeFetch();
		const monitor = createNodeMonitor(
			{ dsn: undefined, environment: "production" },
			{ fetch, home: HOME },
		);
		expect(monitor).toBe(noopMonitor);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("files the event under the release and environment it was given", async () => {
		const event = await capture(new TypeError("boom"));
		expect(event.release).toBe("onlooker-cli@9.9.9");
		expect(event.environment).toBe("production");
		expect(event.exception.values[0].type).toBe("TypeError");
	});

	// The two things a person's machine adds that the hosted apps never had.
	it("shows the home directory as ~ and frame paths as file names", async () => {
		const event = await capture(new Error(`${HOME}/.onlooker/cli.json broke`));
		const exception = event.exception.values[0];
		expect(exception.value).toBe("~/.onlooker/cli.json broke");
		const frames = exception.stacktrace.frames as Array<Record<string, unknown>>;
		expect(frames.length).toBeGreaterThan(0);
		for (const frame of frames) {
			expect(String(frame.filename)).not.toContain("/");
			expect(frame.abs_path).toBeUndefined();
			expect(frame.module).toBeUndefined();
		}
	});

	it("carries no host, no user and no tags it was not given", async () => {
		const tags = { command: "sync", os: "darwin", arch: "arm64", node: "22" };
		const event = await capture(new Error("x"), tags);
		expect(event.server_name).toBeUndefined();
		expect(event.user).toBeUndefined();
		expect(event.tags).toEqual(tags);
	});

	it("redacts anything credential-shaped in the message", async () => {
		const hex = "0123456789abcdef".repeat(3);
		const event = await capture(new Error(`failed ?token=${hex}`));
		expect(JSON.stringify(event)).not.toContain(hex);
	});

	// linkedErrors: a wrapped error arrives with the one it wraps.
	it("keeps the cause chain", async () => {
		const event = await capture(
			new Error("outer", { cause: new RangeError("inner") }),
		);
		const types = event.exception.values.map((v: { type: string }) => v.type);
		expect(types).toEqual(expect.arrayContaining(["Error", "RangeError"]));
	});
});
```

`Record<string, any>` keeps the envelope assertions readable. If Biome's `noExplicitAny` rejects it, add `// biome-ignore lint/suspicious/noExplicitAny: a parsed Sentry envelope, asserted field by field` on the line above `sentEvent`, the way `monitoring.test.ts` in `apps/api` ignores a rule. Don't run `lint:fix`.

`new Error("outer", { cause })` needs `lib: ES2022`, which this package already has.

- [ ] **Step 2: Run it and check it fails**

Run: `pnpm --filter @onlooker/monitoring-sentry test node`
Expected: FAIL, because `./node` can't be resolved.

- [ ] **Step 3: Write `node.ts`**

`packages/monitoring-sentry/src/node.ts`:

```ts
import { type Monitor, noopMonitor } from "@onlooker/monitoring";
import {
	type BaseTransportOptions,
	createStackParser,
	createTransport,
	dedupeIntegration,
	type ErrorEvent,
	eventFiltersIntegration,
	linkedErrorsIntegration,
	nodeStackLineParser,
	ServerRuntimeClient,
	setCurrentClient,
	type Transport,
} from "@sentry/core";
import { createSentryMonitor } from "./monitor";
import { type MonitoringConfig, sentryOptions } from "./options";

/** The part of `fetch` the transport uses. Node's global `fetch` satisfies it. */
export type FetchLike = (
	url: string,
	init: {
		method: string;
		body: string | Uint8Array;
		headers: Record<string, string>;
	},
) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

export interface NodeMonitoringOptions {
	/** Injected so this package needs no Node types, and a test can watch it. */
	fetch: FetchLike;
	/** The user's home directory, shown as `~` in anything sent. */
	home: string;
}

function fetchTransport(fetchImpl: FetchLike) {
	return (options: BaseTransportOptions): Transport =>
		createTransport(options, async ({ body }) => {
			const response = await fetchImpl(options.url, {
				method: "POST",
				body,
				headers: { "Content-Type": "application/x-sentry-envelope" },
			});
			return {
				statusCode: response.status,
				headers: {
					"x-sentry-rate-limits": response.headers.get("X-Sentry-Rate-Limits"),
					"retry-after": response.headers.get("Retry-After"),
				},
			};
		});
}

/** `/opt/homebrew/…/onlooker.mjs` → `onlooker.mjs`; `node:fs` unchanged. */
function fileName(path: string): string {
	return path.slice(path.replace(/\\/g, "/").lastIndexOf("/") + 1);
}

/**
 * Strip what a person's machine adds to an event.
 *
 * A home directory names the user, and a full frame path repeats it, so
 * messages show `~` and frames show a file name. The bundle is one file, so
 * the name still says where in it the frame is.
 */
function localize(event: ErrorEvent, home: string): ErrorEvent {
	const strip = (text: string) => (home ? text.split(home).join("~") : text);
	if (event.message) event.message = strip(event.message);
	for (const exception of event.exception?.values ?? []) {
		if (exception.value) exception.value = strip(exception.value);
		for (const frame of exception.stacktrace?.frames ?? []) {
			if (frame.filename) frame.filename = fileName(frame.filename);
			delete frame.abs_path;
			delete frame.module;
		}
	}
	return event;
}

/**
 * A `Monitor` for a Node process on someone else's machine: the CLI.
 *
 * `@sentry/core` only, not `@sentry/node`. That keeps OpenTelemetry and
 * module patching out of a process that runs for milliseconds, and it means
 * the machine context `@sentry/node` collects by default (the hostname among
 * it) is never collected at all, rather than collected and stripped.
 *
 * Registers its client as core's global one, so `createSentryMonitor` reaches
 * it, as it reaches the client the browser and Workers SDKs register.
 */
export function createNodeMonitor(
	config: MonitoringConfig,
	{ fetch, home }: NodeMonitoringOptions,
): Monitor {
	if (!config.dsn) return noopMonitor;

	const base = sentryOptions(config);
	const client = new ServerRuntimeClient({
		...base,
		beforeSend: (event: ErrorEvent) => base.beforeSend(localize(event, home)),
		integrations: [
			eventFiltersIntegration(),
			linkedErrorsIntegration(),
			dedupeIntegration(),
		],
		stackParser: createStackParser(nodeStackLineParser()),
		transport: fetchTransport(fetch),
		platform: "node",
	});
	setCurrentClient(client);
	client.init();
	return createSentryMonitor();
}
```

If `tsc` rejects a field that `sentryOptions` returns as not being in `ServerRuntimeClientOptions` (for example `dataCollection`), report it as DONE_WITH_CONCERNS. Name the field and the compiler's message, and don't delete the field: it's part of the shared privacy policy.

- [ ] **Step 4: Export the subpath**

In `packages/monitoring-sentry/package.json`, add `"./node": "./src/node.ts"` to `exports` after `"./worker"`. In `packages/monitoring-sentry/src/index.ts`, extend the doc comment's last paragraph to say `./node` is the CLI's client.

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @onlooker/monitoring-sentry test node`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run the package's suite, typecheck and lint**

Run: `pnpm --filter @onlooker/monitoring-sentry test`, `pnpm --filter @onlooker/monitoring-sentry typecheck`, `pnpm --filter @onlooker/monitoring-sentry lint`
Expected: all pass.

- [ ] **Step 7: Commit**

Through `/git-workflow:commit`, with the four files. Suggested subject: `feat(monitoring): add a core-only Sentry client for Node`.

---

### Task 4: Report a consented crash from `run()`

**Files:**
- Create: `apps/cli/src/monitoring.ts`
- Create: `apps/cli/src/__tests__/monitoring.test.ts`
- Modify: `apps/cli/src/cli.ts` (the catch, and `ONLOOKER_CRASH_TEST`)
- Modify: `apps/cli/src/__tests__/cli.test.ts`
- Modify: `apps/cli/package.json` (dependencies), `apps/cli/tsconfig.json` (`resolveJsonModule`), `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `isCrash` (Task 1), `crashConsent` (Task 2), `createNodeMonitor` and `FetchLike` (Task 3), `muted` from `ui.ts`.
- Produces:
  - `export const CRASH_DSN: string | undefined`. It's `undefined` until Task 5.
  - `export function buildEnvironment(): "production" | "development"`
  - `export async function reportCrash(error: unknown, context: { command: string }, deps?: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike; dsn?: string | undefined }): Promise<boolean>`

- [ ] **Step 1: Add the dependencies**

In `apps/cli/package.json` `dependencies`, add `"@onlooker/monitoring": "workspace:*"` and `"@onlooker/monitoring-sentry": "workspace:*"`. In `apps/cli/tsconfig.json` `compilerOptions`, add `"resolveJsonModule": true`. Then run `pnpm install` from the repo root, so `pnpm-lock.yaml` records the links. CI installs with `--frozen-lockfile`, so the lockfile change has to be committed.

- [ ] **Step 2: Write the failing tests**

`apps/cli/src/__tests__/monitoring.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "@onlooker/monitoring-sentry/node";
import { describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { configPath, writeConfig } from "../config";
import { buildEnvironment, reportCrash } from "../monitoring";

const DSN = "https://public@o1.ingest.sentry.io/1";

function machine(crashReports?: boolean): NodeJS.ProcessEnv {
	const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-cli-")) };
	writeConfig({ apiBaseUrl: "https://api.onlooker.dev", crashReports }, env);
	return env;
}

function fakeFetch() {
	return vi.fn<FetchLike>(async () => ({
		status: 200,
		headers: { get: () => null },
	}));
}

const crash = () => new TypeError("cannot read properties of undefined");

/**
 * The gate. Each case passes a real DSN and a real adapter, so the only thing
 * standing between the error and `fetch` is the consent check. That is what
 * makes "fetch was not called" mean "consent stopped it" and not "nothing
 * was wired up".
 */
describe("reportCrash, without consent", () => {
	const cases: Array<[string, () => NodeJS.ProcessEnv]> = [
		["nobody chose", () => machine()],
		["it was turned off", () => machine(false)],
		["DO_NOT_TRACK is set", () => ({ ...machine(true), DO_NOT_TRACK: "1" })],
		[
			"ONLOOKER_CRASH_REPORTS=0",
			() => ({ ...machine(true), ONLOOKER_CRASH_REPORTS: "0" }),
		],
		[
			"cli.json cannot be read",
			() => {
				const env = machine(true);
				writeFileSync(configPath(env), "{ not json");
				return env;
			},
		],
	];

	for (const [why, env] of cases) {
		it(`sends nothing when ${why}`, async () => {
			const fetchImpl = fakeFetch();
			expect(
				await reportCrash(crash(), { command: "sync" }, {
					env: env(),
					fetchImpl,
					dsn: DSN,
				}),
			).toBe(false);
			expect(fetchImpl).not.toHaveBeenCalled();
		});
	}

	it("sends nothing, and says so, with consent but no DSN", async () => {
		const fetchImpl = fakeFetch();
		expect(
			await reportCrash(crash(), { command: "sync" }, {
				env: machine(true),
				fetchImpl,
				dsn: undefined,
			}),
		).toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("reportCrash, with consent", () => {
	it("sends one event with exactly the allowed tags", async () => {
		const fetchImpl = fakeFetch();
		expect(
			await reportCrash(crash(), { command: "sync" }, {
				env: machine(true),
				fetchImpl,
				dsn: DSN,
			}),
		).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		const body = fetchImpl.mock.calls[0]?.[1].body as string;
		const lines = body.split("\n");
		const at = lines.findIndex((line) => line.includes('"type":"event"'));
		const event = JSON.parse(lines[at + 1] as string);
		expect(event.release).toBe(`onlooker-cli@${packageJson.version}`);
		expect(event.environment).toBe("development");
		expect(Object.keys(event.tags).sort()).toEqual(["arch", "command", "node", "os"]);
		expect(event.tags.command).toBe("sync");
		expect(event.tags.node).toMatch(/^\d+$/);
		expect(event.server_name).toBeUndefined();
	});
});

describe("buildEnvironment", () => {
	// Only a release build says production. A bundle someone built locally,
	// or a test, must never page anyone.
	it("is development unless the release build defined it", () => {
		expect(buildEnvironment()).toBe("development");
	});
});
```

- [ ] **Step 3: Run it and check it fails**

Run: `pnpm --filter @onlooker/cli test monitoring`
Expected: FAIL, because `../monitoring` can't be resolved.

- [ ] **Step 4: Write `monitoring.ts`**

`apps/cli/src/monitoring.ts`:

```ts
import { homedir } from "node:os";
import type { FetchLike } from "@onlooker/monitoring-sentry/node";
import packageJson from "../package.json" with { type: "json" };
import { crashConsent } from "./consent";

/**
 * The onlooker-cli Sentry project. Committed rather than injected because a
 * DSN can only submit events, which is also why apps/api/wrangler.toml
 * commits its own. Undefined means reporting is off for every build.
 */
export const CRASH_DSN: string | undefined = undefined;

/** Replaced with "production" by `build:release`; undefined in every other build. */
declare const __ONLOOKER_ENVIRONMENT__: string | undefined;

/**
 * Where this bundle runs, in the shared vocabulary.
 *
 * Only a bundle built by release-cli.yml says production. The typeof guard
 * is what keeps a local build, or a test, from throwing a ReferenceError on
 * a name esbuild was never asked to define.
 */
export function buildEnvironment(): "production" | "development" {
	return typeof __ONLOOKER_ENVIRONMENT__ === "string" &&
		__ONLOOKER_ENVIRONMENT__ === "production"
		? "production"
		: "development";
}

export interface CrashDeps {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: FetchLike;
	dsn?: string | undefined;
}

/**
 * Send one crash, if and only if this machine agreed to.
 *
 * The consent check comes before the import, so a run that crashed on a
 * machine that never opted in does not load Sentry at all. Resolves whether
 * the report drained: `run()` prints its one line only when it did, so the
 * line never claims a report that did not leave.
 *
 * Never rejects. It runs in `run()`'s catch, where a second failure would
 * replace the one the user is being told about.
 */
export async function reportCrash(
	error: unknown,
	{ command }: { command: string },
	{ env = process.env, fetchImpl = fetch, dsn = CRASH_DSN }: CrashDeps = {},
): Promise<boolean> {
	if (!crashConsent(env).on || !dsn) return false;
	try {
		const { createNodeMonitor } = await import(
			"@onlooker/monitoring-sentry/node"
		);
		const monitor = createNodeMonitor(
			{
				dsn,
				environment: buildEnvironment(),
				release: `onlooker-cli@${packageJson.version}`,
			},
			{ fetch: fetchImpl, home: homedir() },
		);
		monitor.captureException(error, {
			tags: {
				command,
				os: process.platform,
				arch: process.arch,
				node: process.versions.node.split(".")[0] ?? "unknown",
			},
		});
		return await monitor.flush(2000);
	} catch {
		return false;
	}
}
```

If TypeScript rejects `fetchImpl = fetch` as not assignable to `FetchLike`, report it as DONE_WITH_CONCERNS with the compiler's message. Don't cast it away without saying so.

- [ ] **Step 5: Run the monitoring tests**

Run: `pnpm --filter @onlooker/cli test monitoring`
Expected: PASS, 8 tests.

- [ ] **Step 6: Prove the gate test by ablation**

Temporarily delete `!crashConsent(env).on || ` from the first line of `reportCrash`, using Edit. Run `pnpm --filter @onlooker/cli test monitoring`.
Expected: the five "sends nothing when …" tests FAIL, because `fetch` was called.
Restore the line with Edit and re-run: PASS. Record both outcomes in the report.

- [ ] **Step 7: Write the failing `run()` tests**

In `apps/cli/src/__tests__/cli.test.ts`, mock the module next to the existing `vi.mock` calls. This also stops any test in the file from reading the real `~/.onlooker/cli.json` on the developer's machine:

```ts
// Mocked for every test here. `run` is called with an empty env, and the real
// reportCrash would read the developer's own ~/.onlooker/cli.json, so a
// machine that opted in would send reports from the test suite.
vi.mock("../monitoring", () => ({ reportCrash: vi.fn(async () => false) }));
```

Add `import { reportCrash } from "../monitoring";`, `import { CliError } from "../errors";`, and `const mockedReport = vi.mocked(reportCrash);`. Then add a describe block:

```ts
describe("run, when something crashes", () => {
	it("reports an unexpected error with the command it came from", async () => {
		const error = new TypeError("cannot read properties of undefined");
		mockedSync.mockRejectedValueOnce(error);
		expect(await invoke("sync")).toBe(1);
		expect(mockedReport).toHaveBeenCalledWith(error, { command: "sync" }, {
			env: {},
		});
	});

	for (const [what, error] of [
		["an ApiError", new ApiError({ kind: "transient", message: "503" })],
		["a CliError", new CliError("No token entered. Nothing was changed.")],
		[
			"a system error",
			Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
		],
	] as const) {
		it(`never reports ${what}`, async () => {
			mockedSync.mockRejectedValueOnce(error);
			await invoke("sync");
			expect(mockedReport).not.toHaveBeenCalled();
		});
	}

	// The exit code and the error line are the contract scripts read. A
	// report must add to them, never change them.
	it("keeps the exit code and message, and adds one line when sent", async () => {
		mockedSync.mockRejectedValueOnce(new TypeError("boom"));
		mockedReport.mockResolvedValueOnce(true);
		expect(await invoke("sync")).toBe(1);
		expect(err[0]).toContain("boom");
		expect(err[1]).toBe(
			"reported this crash (onlooker crash-reports off to stop)",
		);
		expect(err).toHaveLength(2);
	});

	it("adds nothing when the report did not go", async () => {
		mockedSync.mockRejectedValueOnce(new TypeError("boom"));
		expect(await invoke("sync")).toBe(1);
		expect(err).toHaveLength(1);
	});

	it("crashes on purpose under ONLOOKER_CRASH_TEST=1, to check delivery", async () => {
		expect(await run(["node", "onlooker", "status"], { ONLOOKER_CRASH_TEST: "1" })).toBe(1);
		expect(mockedReport.mock.calls[0]?.[0]).toBeInstanceOf(TypeError);
	});
});
```

`vi.restoreAllMocks()` in the file's `afterEach` resets spies but **not** `vi.fn` call history on a module mock. Add `mockedReport.mockClear();` to the file's `beforeEach`, or the "never reports" cases see calls from earlier tests.

`err[1]` is compared as plain text because `run` is invoked with an empty env, which `resolveTheme` turns into an uncolored theme. If the existing tests show that theme still emits SGR codes, compare `stripSgr(err[1])` instead.

- [ ] **Step 8: Run them and check they fail**

Run: `pnpm --filter @onlooker/cli test cli`
Expected: the new tests FAIL. `reportCrash` is never called, and `ONLOOKER_CRASH_TEST` doesn't throw.

- [ ] **Step 9: Wire `run()`**

In `apps/cli/src/cli.ts`, import `isCrash` from `"./errors"` and `reportCrash` from `"./monitoring"`. As the first statement inside `try`, add:

```ts
		// A deliberate crash, so someone who turned reports on can check one
		// arrives. Thrown inside the try so it travels the real path.
		if (env.ONLOOKER_CRASH_TEST === "1") {
			throw new TypeError(
				"ONLOOKER_CRASH_TEST: a deliberate crash, to check reports arrive",
			);
		}
```

In the `catch`, after the existing `console.error(...)` and before the `return`, add:

```ts
		// After the message, never instead of it: the line above is what the
		// user and any wrapping script read, and a report changes neither it
		// nor the exit code.
		if (
			isCrash(error) &&
			(await reportCrash(error, { command: command ?? "none" }, { env }))
		) {
			console.error(
				muted(err, "reported this crash (onlooker crash-reports off to stop)"),
			);
		}
```

- [ ] **Step 10: Run the CLI suite, typecheck and lint, and build**

Run: `pnpm --filter @onlooker/cli test`, `pnpm --filter @onlooker/cli typecheck`, `pnpm --filter @onlooker/cli lint`, then `pnpm --filter @onlooker/cli build`.
Expected: all pass, and the build writes `apps/cli/dist/onlooker.mjs`. Then check that the bundle still starts:
`ONLOOKER_DIR=$(mktemp -d) node apps/cli/dist/onlooker.mjs --help` should print the usage, including `onlooker crash-reports`, and exit 0.

- [ ] **Step 11: Commit**

Through `/git-workflow:commit`, with `apps/cli/src/monitoring.ts`, both test files, `apps/cli/src/cli.ts`, `apps/cli/package.json`, `apps/cli/tsconfig.json` and `pnpm-lock.yaml`. Suggested subject: `feat(cli): report a crash, once, when the machine agreed to`.

---

### Task 5: Ship it: DSN, release build, alert, runbook, version

**Owner inputs.** The controller asks for these before dispatching the task. They come from creating the `onlooker-cli` project in Sentry:
- the project's DSN, which goes in `CRASH_DSN`;
- the project's numeric ID, which goes in `cli-crashes.json`'s `project`.

**Files:**
- Modify: `apps/cli/src/monitoring.ts` (`CRASH_DSN`)
- Modify: `apps/cli/package.json` (`build:release` and `version`)
- Modify: `.github/workflows/release-cli.yml:65`
- Create: `scripts/sentry/rules/cli-crashes.json`
- Create: `docs/runbooks/2026-11-09-cli-crash-reports.md`
- Test: `apps/cli/src/__tests__/monitoring.test.ts`

**Interfaces:**
- Consumes: `buildEnvironment` and the `__ONLOOKER_ENVIRONMENT__` define from Task 4.
- Produces: the release build labels its events `production`, and the CLI version moves to `2.13.0`, which makes `tag-cli.yml` release it on merge.

- [ ] **Step 1: Write the failing release-build test**

Add to `apps/cli/src/__tests__/monitoring.test.ts`:

```ts
describe("the release build", () => {
	const root = join(__dirname, "..", "..", "..", "..");

	// The define is the only thing that makes an event say production. If the
	// workflow built with plain `build`, every released crash would file as
	// development and the production-only alert would never fire.
	it("is what release-cli.yml builds", () => {
		const workflow = readFileSync(
			join(root, ".github/workflows/release-cli.yml"),
			"utf8",
		);
		expect(workflow).toContain("pnpm --filter @onlooker/cli build:release");
	});

	it("defines the environment as production", () => {
		expect(packageJson.scripts["build:release"]).toContain(
			`__ONLOOKER_ENVIRONMENT__='"production"'`,
		);
	});
});
```

Add `readFileSync` to the file's existing `node:fs` import, not a second import line.

- [ ] **Step 2: Run it and check it fails**

Run: `pnpm --filter @onlooker/cli test monitoring`
Expected: the two new tests FAIL.

- [ ] **Step 3: Add `build:release`, switch the workflow, and bump the version**

In `apps/cli/package.json` `scripts`, after `build`, add:

```json
		"build:release": "pnpm run build --define:__ONLOOKER_ENVIRONMENT__='\"production\"'",
```

`pnpm run build <args>` appends the arguments to the esbuild command, so this is exactly `build` plus one define.

Also change `"version": "2.12.2"` to `"version": "2.13.0"`: a new command and a new capability make this a minor release. The `CLI released with its source` gate requires this bump, because `apps/cli/src` changed.

In `.github/workflows/release-cli.yml`, change `- run: pnpm --filter @onlooker/cli build` to `- run: pnpm --filter @onlooker/cli build:release`, with this comment above it:

```yaml
      # build:release, not build: the define it adds is the only thing that
      # makes a crash report say environment production, and the onlooker-cli
      # alert fires on production alone.
```

- [ ] **Step 4: Commit the DSN**

In `apps/cli/src/monitoring.ts`, set `export const CRASH_DSN: string | undefined = "<the DSN the owner supplied>";`, using the value given to you verbatim.

- [ ] **Step 5: Run the tests and check the release bundle**

Run: `pnpm --filter @onlooker/cli test`, then `pnpm --filter @onlooker/cli build:release`.
Then `grep -c __ONLOOKER_ENVIRONMENT__ apps/cli/dist/onlooker.mjs` should print `0`, since every use was replaced. And `ONLOOKER_DIR=$(mktemp -d) node apps/cli/dist/onlooker.mjs --help` should exit 0.
Finally run `pnpm --filter @onlooker/cli build`, so `dist/` holds the development bundle again, and `grep -c __ONLOOKER_ENVIRONMENT__ apps/cli/dist/onlooker.mjs` should print a number greater than `0`.

- [ ] **Step 6: Add the alert**

`scripts/sentry/rules/cli-crashes.json`, with `project` set to the numeric ID the owner supplied:

```json
{
	"_comment": [
		"apps/cli, reported only from machines that ran `onlooker crash-reports on`.",
		"Its Sentry project is onlooker-cli (the `project` below).",
		"",
		"Production only, and here that filter is the whole point: CRASH_DSN is",
		"committed, so a CLI built and run from a checkout reports to this same",
		"project as environment 'development'. Only a bundle built by",
		"release-cli.yml's build:release says production.",
		"",
		"regression_event for the reason api-faults.json gives (ONL-217)."
	],
	"project": "<the numeric project ID the owner supplied>",
	"detectorType": "issue_stream",
	"workflow": {
		"name": "CLI crash (production)",
		"environment": "production",
		"enabled": true,
		"config": {
			"frequency": 60
		},
		"triggers": {
			"logicType": "any-short",
			"conditions": [
				{
					"type": "first_seen_event",
					"comparison": true,
					"conditionResult": true
				},
				{
					"type": "regression_event",
					"comparison": true,
					"conditionResult": true
				}
			]
		},
		"actionFilters": [
			{
				"logicType": "all",
				"conditions": [],
				"actions": [
					{
						"type": "email",
						"data": {
							"fallthroughType": "AllMembers"
						},
						"config": {
							"targetType": "issue_owners"
						}
					}
				]
			}
		]
	}
}
```

Run: `bash scripts/sentry/apply.test.sh`
Expected: PASS. If it fails because the new file is neither applied nor listed in `scripts/sentry/unapplied.txt`, read the failure. `rules/` is a directory `apply.sh` already applies, so a failure there means the file is malformed. Fix the file, not the test.

- [ ] **Step 7: Write the runbook**

`docs/runbooks/2026-11-09-cli-crash-reports.md`:

````markdown
# Runbook: CLI crash reports

**Created:** 2026-11-09
**Issue:** ONL-56
**Design:** `docs/superpowers/specs/2026-11-09-cli-crash-reports-design.md`

The CLI reports its own crashes to the `onlooker-cli` Sentry project, but
only from a machine whose owner ran `onlooker crash-reports on`. Nothing
prompts for it, and the environment can only turn it off.

| | |
|---|---|
| Consent | `crashReports: true` in `~/.onlooker/cli.json`, written only by `onlooker crash-reports on` |
| Overrides | `DO_NOT_TRACK` (anything but empty, `0`, `false`) or `ONLOOKER_CRASH_REPORTS=0` turn it off |
| Reported | errors that are not `ApiError`, `CliError` or a system (`E…` code) error |
| Client | `@onlooker/monitoring-sentry/node`, on `@sentry/core` alone |
| DSN | `CRASH_DSN` in `apps/cli/src/monitoring.ts` |
| Environment | `production` only from `build:release` (release-cli.yml); every other build says `development` |
| Alert | `scripts/sentry/rules/cli-crashes.json`, applied with `scripts/sentry/apply.sh` |

## Check that a crash arrives

On a machine with a released CLI:

```
onlooker crash-reports on
ONLOOKER_CRASH_TEST=1 onlooker status
```

The second command exits 1, prints the deliberate `TypeError`, and then
`reported this crash (onlooker crash-reports off to stop)`. The event shows
up in `onlooker-cli` with `environment: production` and the tag
`command: status`. Run `onlooker crash-reports off` afterward if the
machine shouldn't keep reporting.

With reporting off, or with `DO_NOT_TRACK=1`, the same command prints the
error and no "reported" line, and nothing arrives.

## What a report holds

The exact list is in the spec's "What a report contains" table, and
`onlooker crash-reports on` prints it to the person agreeing. If the payload
changes, all three change together: `packages/monitoring-sentry/src/node.ts`,
`WHAT_IS_SENT` in `apps/cli/src/commands/crash-reports.ts`, and the spec.

## Troubleshooting

| Symptom | Cause |
|---|---|
| No "reported this crash" line after a crash | Consent is off (`onlooker crash-reports status` says why), the error was not a crash (a refusal, a `CliError`, a system error), or the flush did not drain within 2 seconds |
| Events arrive as `development` from a released CLI | release-cli.yml built with `build` instead of `build:release` |
| No email for a production crash | `cli-crashes.json` was never applied: run `scripts/sentry/apply.sh` |
````

- [ ] **Step 8: Run the full suite and typecheck**

Run: `pnpm test` and `pnpm typecheck` from the repo root. If `typecheck` fails only because a workspace package hasn't been built, run `pnpm build` once and re-run.
Expected: all pass.

- [ ] **Step 9: Commit**

Through `/git-workflow:commit`, with `apps/cli/src/monitoring.ts`, `apps/cli/src/__tests__/monitoring.test.ts`, `apps/cli/package.json`, `.github/workflows/release-cli.yml`, `scripts/sentry/rules/cli-crashes.json` and `docs/runbooks/2026-11-09-cli-crash-reports.md`. Suggested subject: `feat(cli): ship crash reports in 2.13.0`.

---

## After merge (owner and controller)

1. `tag-cli.yml` tags `cli-v2.13.0`, and `release-cli.yml` publishes it to the tap.
2. Owner: run `scripts/sentry/apply.sh` to create the `CLI crash (production)` alert.
3. `brew upgrade onlooker`, then run the runbook's "Check that a crash arrives" with reporting on, then off, then with `DO_NOT_TRACK=1`. The first must show an event in `onlooker-cli` with `environment: production`; the other two must send nothing. That's ONL-56's done-when.
