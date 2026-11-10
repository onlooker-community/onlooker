# CLI crash reports, opt-in

Linear: ONL-56. Approved 2026-11-09.

## Problem

The API, the web app and the website report their faults to Sentry through
`@onlooker/monitoring`. The CLI reports nothing. A bug in `onlooker sync` on
someone's machine is seen only if they file it, and the error they see is one
line on stderr.

The CLI also runs on other people's machines, which none of the other apps do.
So nothing may be sent without a recorded choice. Today what leaves a machine is
lessons, machine inventory and session summaries, each to our own API.

## Decisions

- **Opt in by an explicit command, never by a prompt.** Off until someone runs
  `onlooker crash-reports on`. CI and piped runs can never be asked anything.
- **Only the unexpected is a crash.** A refusal, a network failure or a
  deliberate message about the user's own setup is not reported.
- **Sentry through `@sentry/core` alone.** A `./node` adapter in
  `@onlooker/monitoring-sentry`, not `@sentry/node`. That keeps OpenTelemetry,
  module patching and the SDK's machine-context integrations out of the CLI.
  Then the report contains only fields we chose, so nothing has to be stripped
  back out.
- **Anonymous.** No user, machine or host identifier. Sentry can count events
  per release but not affected machines, and that cost is accepted.

## Part 1: consent and classification

### Consent

- `cli.json` gains `crashReports?: boolean`. Absent or `false` means off.
  `writeConfig` still writes the whole file with mode `0600`, so turning
  reporting on or off keeps `machineToken`.
- `onlooker crash-reports on|off|status`. With no argument it behaves like
  `status`.
  - `on` records the choice and prints what a report contains and what it
    never contains (the tables in Part 2). That output is the user-facing
    statement of the policy.
  - `off` records the opposite. `status` prints the current setting and, when
    an environment override is in force, says so.
  - It joins `COMMANDS` in `cli.ts`, which then has six entries.
- `onlooker status` gains one line saying whether crash reports are on.
- **The environment can only turn reporting off.** `ONLOOKER_CRASH_REPORTS=0`
  or `DO_NOT_TRACK=1` suppresses a report even when `cli.json` says on.
  Nothing in the environment turns it on: consent is a recorded choice, not
  something a shell can pass along.

### What counts as a crash

- New `apps/cli/src/errors.ts` exports `class CliError extends Error`. Every
  deliberate `throw new Error(...)` in `apps/cli/src` becomes a `CliError`
  with the same message. That covers `config.ts`, `pool.ts`, `eventlog.ts`,
  `commands/link.ts` and `commands/sync.ts`, about ten sites. A corrupt local
  file stays a `CliError`: its message names a local path, and the user can
  act on it.
- In `run()`'s catch, an `ApiError` or a `CliError` is never reported.
  Neither is a system error: one carrying an `E`-prefixed string `code`
  (`EACCES`, `ENOSPC`, `EISDIR`), which describes the machine, not the CLI.
  Anything else is a crash: a `TypeError`, a parser bug, an unguarded
  `JSON.parse`.
- **Reporting never changes what the user sees.** The exit code stays the one
  `run()` returns today, and stderr still prints `✕ <message>`. When a report
  was sent, one muted line follows it:
  `reported this crash (onlooker crash-reports off to stop)`.
- **A failed report changes nothing.** If the send fails, the flush times out,
  or `cli.json` can't be read in the crash path, nothing was reported. That
  produces no second error and no change to the exit code.

## Part 2: the adapter and the payload

### `@onlooker/monitoring-sentry/node`

A new subpath beside `./browser` and `./worker`. It exports
`createNodeMonitor(config: MonitoringConfig): Monitor`:

- Builds a `ServerRuntimeClient` from `@sentry/core`, using the options from
  `sentryOptions(config)`. That brings `sendDefaultPii: false` and every
  scrub hook, as the other apps have.
- Transport: `createTransport` from `@sentry/core`, sending each envelope with
  Node's built-in `fetch`. No `@sentry/node`, no OpenTelemetry, no
  `import-in-the-middle`.
- Stack parsing: `createStackParser(nodeStackLineParser())` from
  `@sentry/core`.
- Integrations: `eventFilters` (`inboundFilters` is its deprecated name),
  `linkedErrors` (so a `cause` chain arrives) and `dedupe` only. None of the
  Node context integrations, so the report carries no hostname, memory or CPU
  data. `serverName` is never set.
- Registers the client with `setCurrentClient(client)` and `client.init()`,
  then returns `createSentryMonitor()`. That monitor talks to core's global
  client, as it does after the browser and Workers SDKs initialize, and is
  already `guarded`. With no DSN it returns `noopMonitor` and builds no
  client.

### `apps/cli/src/monitoring.ts`

`reportCrash(error: unknown, context: { command: string }, env?): Promise<boolean>`:

1. Consent gate: `readConfig(env).crashReports === true`, and neither
   override is set. A config read that throws counts as off.
2. Only then `await import("@onlooker/monitoring-sentry/node")`. No other CLI
   module imports Sentry, so a run without a crash or without consent never
   loads it.
3. `captureException`, then `flush(2000)`. Returns true only when Sentry
   accepted the event with a 2xx; a drained flush alone is not enough, since
   core counts a 500 or a refused connection as drained. The send is aborted
   at 2 seconds so a stalled server cannot hold the process open. That answer
   decides whether the muted line prints.

### What a report contains

It's an allowlist: anything not listed here is left out.

| Sent | Value |
|---|---|
| Error type, message, stack, and those of any error it wraps (`cause` chain) | Each message goes through the shared `scrubText`, then has `os.homedir()` replaced with `~`, every absolute path (POSIX, Windows, `file://`, quoted or bare) cut to its file name, and email addresses redacted. Home is replaced only at a path boundary, and both `~/` and `~\` count as home. A path may also follow a colon (`path:/a/b.ts`); `//` in a URL is left alone. An unquoted path containing spaces may keep the directories after the space. A `SyntaxError`'s message (the top error or any in the chain) is left out whole, as `[message omitted: may quote input]`, because Node's `JSON.parse` quotes the text it failed on; its type and frames are kept. Stack frame paths are reduced to file names (`onlooker.mjs`, `node:fs`), and frames carry only file, function, line, column and `in_app` |
| `release` | `onlooker-cli@<version>`, from `apps/cli/package.json` at build time |
| `environment` | `production` for a build made by `release-cli.yml`, otherwise `development` |
| Tags | `command` (a known subcommand's name, `none` when there is none, `other` for anything else), `os` (`process.platform`), `arch`, `node` (major version) |

The adapter enforces this in its `beforeSend`: it rebuilds the event from
these fields and the envelope bookkeeping Sentry needs (`event_id`,
`timestamp`, `level`, `platform`, `sdk`, `contexts.trace`), and copies
nothing else. `extra`, `user`, `breadcrumbs`, `request`, `modules` and every
other context are dropped, whatever put them there.

**Never sent:** hostname, username, user ID, machine ID or token, email, the
working directory, environment variables, the rest of `argv`, file contents,
lesson text.

The DSN is committed in `apps/cli/src/monitoring.ts`, the same way
`apps/api/wrangler.toml` commits the API's DSN. A DSN can only submit events.
It points at a new `onlooker-cli` Sentry project.

## Part 3: operations, release and tests

### Sentry

- **Owner step:** create the `onlooker-cli` project in the existing org. Its
  DSN goes into `apps/cli/src/monitoring.ts`.
- `scripts/sentry/rules/cli-crashes.json` alerts on a new issue in
  `onlooker-cli`, filtered to `environment: production`, like the other
  rules. `apply.sh` binds it to the project's own `issue_stream` detector,
  and `apply.test.sh` covers it as it covers the rest.

### Build

- The CLI's esbuild `build` script gets a `--define` for the release and the
  environment. `release-cli.yml` sets the environment to `production` when it
  builds a tag. Every other build, a local `pnpm build` included, gets
  `development`.
- The bundle stays unminified, as it is today, so stacks are readable without
  uploading source maps.
- `@onlooker/monitoring` and `@onlooker/monitoring-sentry` become CLI
  dependencies. esbuild bundles them, and the adapter is reached only through
  the dynamic `import()`.

### Docs

- No current document makes a user-facing claim about what leaves a machine.
  The `crash-reports on` output becomes that statement.
- New runbook `docs/runbooks/2026-11-09-cli-crash-reports.md`. It covers the
  Sentry project, the alert, the consent rules, and how to check that a crash
  arrives: `ONLOOKER_CRASH_TEST=1` makes `run()` throw a `TypeError`, and
  only matters when crash reports are on.

### Tests

- **Classification.** An `ApiError` or a `CliError` never reaches
  `reportCrash`, and a `TypeError` does. The exit code and stderr are the
  same whether or not a report was sent.
- **Consent gate.** A missing field, `false`, `ONLOOKER_CRASH_REPORTS=0` or
  `DO_NOT_TRACK=1` means nothing is imported or sent. `DO_NOT_TRACK=1` beats
  `crashReports: true`. An unreadable `cli.json` means not reported, with no
  second error. **Proved by ablation:** removing the consent check must turn
  the gate test red. Otherwise the test could pass because nothing was sent
  for some other reason.
- **Command.** `on` and `off` keep `machineToken` and file mode `0600`;
  `status` reads the setting back.
- **Payload, through the real adapter with a fake `fetch`.** The home
  directory arrives as `~`, frame paths as file names, and the tags are
  exactly the four listed. There's no `server_name` and no `user`, and a
  credential-shaped string in the message arrives redacted.

## Done when (from ONL-56)

- This spec is approved.
- A released CLI with crash reports on sends an `ONLOOKER_CRASH_TEST` crash,
  and it shows up in `onlooker-cli` with `environment: production`.
- The same build with reporting off, or with `DO_NOT_TRACK=1`, sends nothing:
  a fake `fetch` sees no calls.
