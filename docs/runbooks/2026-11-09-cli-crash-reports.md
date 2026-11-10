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

## Sentry project settings

The client never sets a user, but Sentry's ingest records the sending IP
address on its own unless the project says otherwise. A crash report is
meant to be anonymous, so the project must not keep it.

- **Done 2026-11-09 (owner):** "Prevent Storing of IP Addresses" is on in the
  `onlooker-cli` project's Security & Privacy settings. If the project is
  ever recreated, turn it on again before any release reports to it.
- After the first test event arrives (below), open it and check that it has
  no `user.ip_address`, and no `user` at all. If one is there, the setting
  is off: turn it on, delete the event, and send the test again.

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
| No "reported this crash" line after a crash | Consent is off (`onlooker crash-reports status` says why), the error was not a crash (a refusal, a `CliError`, a system error), or Sentry did not accept the event with a 2xx within 2 seconds (the send is aborted at 2 seconds; an error status or a rate limit counts as not sent) |
| Events arrive as `development` from a released CLI | release-cli.yml built with `build` instead of `build:release` |
| No email for a production crash | `cli-crashes.json` was never applied: run `scripts/sentry/apply.sh` |
