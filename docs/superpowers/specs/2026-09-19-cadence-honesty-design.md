# Cadence Honesty — Design

Bead: `onlooker-txcu.5` ([ONL-51](https://linear.app/onlooker/issue/ONL-51)).
One behavior change in `scripts/client-error-monitor.sh`, its tests beside it,
one added permission, and a set of corrections to comments that assert a
cadence nobody delivers. No new machinery.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-19.
Sections marked *(measured)* were read from this repository and the GitHub API
on 2026-09-19; each names where the fact came from.

## What GitHub actually delivers *(measured)*

Read from `gh run list --event=schedule --limit 20` for each workflow on
2026-09-19, newest run 22:44:54Z, gaps in minutes between consecutive runs:

| workflow | declared | gaps | median | max |
|---|---|---|---|---|
| `heartbeat.yml` | every 5 min | 107, 144, 150, 203, 242, 282, 239, 121, 127, 146, 211, 247, 275, 273, 132, 161, 203, 267, 332 | 203 | 332 |
| `client-error-monitor.yml` | hourly | 131, 127, 159, 193, 295, 300, 122, 142, 158, 206, 199, 310, 305, 150, 153, 197, 304, 327, 297 | 197 | 327 |

Every run that fired succeeded. Nothing looks wrong from inside a run, which is
why this went unnoticed: GitHub drops scheduled runs silently rather than
queueing them, and a dropped run leaves no record anywhere.

The number that matters most is not the ratio but its movement. `onlooker-2ho`
measured the heartbeat at a 24 minute median over 100 runs on 2026-08-16. Thirty
days later the same workflow, unchanged, sits at 203. Delivery degraded roughly
eightfold with nobody touching a line of it, and nothing in the repository
noticed. That is the property any fix here has to survive.

## What already shipped, and what it left *(measured)*

PR #160 moved the frequent shallow check to a Cloudflare cron trigger
(`apps/api/src/heartbeat.ts`, `*/5` under `[env.production.triggers]` and
`[env.staging.triggers]`), leaving the deep authenticated check in
`heartbeat.yml` where lateness costs less. The Worker cron now also carries
session-summary retention cleanup. So the original consequence — a production
outage invisible for hours — is handled.

The Sentry cron monitors were resized to a 6h interval with a 120m margin in the
same era. Against today's numbers they still hold: the worst observed heartbeat
gap is 332 minutes against an 8 hour tolerance. They need no change, and this
was checked rather than assumed.

What survived is everything that still *claims* a cadence nobody delivers, plus
one place where the stale claim is not a comment but a live window.

## The live gap: a lookback narrower than the gap between runs *(measured)*

`scripts/client-error-monitor.sh:52` reads a 180 minute window of Workers Logs
each run. `client-error-monitor.yml` does not override it, so 180 is what
production uses.

The comment above it (`scripts/client-error-monitor.sh:46-51`) explains the
window is deliberately "wider than the schedule that drives it", citing the
heartbeat's "24 minute median with a 112 minute maximum". Two things are wrong
with that justification now. It sizes this workflow's window from a different
workflow's delivery, and the measurement it cites is a month old.

Against today's delivery, 11 of the last 19 gaps exceeded 180 minutes. The worst
left 147 minutes of client error reports that no run ever read. The comment
describes the failure exactly — "a gap here is a client error nobody hears
about" — and the widening it introduced stopped covering that gap without
anyone editing either file.

## Deriving the window from run history *(approved)*

The script stops guessing how long it has been since it last looked, and asks.

The window begins at the `created_at` of this workflow's most recent **completed**
run, minus 5 minutes of overlap for clock skew between GitHub's timestamps and
Cloudflare's log timestamps. Querying `status=completed` excludes the current
in-flight run, which would otherwise always be the most recent one. Run history
is the authoritative answer to
"when did we last look", and it tracks throttling as throttling changes. If
GitHub degrades to six hour gaps next month, the window follows without anyone
remeasuring anything.

`created_at` rather than a completion time, because the previous run executed its
query moments after starting; looking back to its start covers the interval its
query could not, with the run's own duration as free margin.

**Completed, not successful.** This workflow fails on purpose when it finds
client errors — a failing workflow sends email, and email is the only alerting
this project has that anyone watches. A failed run queried correctly; it failed
because it found something. Filtering to successful runs would drag the window
back across every failure and re-report the same errors on every subsequent run
until a clean one, turning one alert into a repeating one.

That leaves one hole, accepted deliberately and recorded here rather than
engineered around. A run that dies *before* querying — missing token, Cloudflare
API error — is indistinguishable from outside from one that found errors, and
its interval would be treated as covered. It is acceptable because that run
emailed a human. The gap this design closes is the silent one.

Three guards on the derived number:

- **Floor of 60 minutes.** A `workflow_dispatch` seconds after a scheduled run
  would otherwise query a 30 second window and miss the very report it was
  dispatched to check.
- **Ceiling of 24 hours.** If the workflow is disabled for a week, the window
  must not become a week. Workers Logs retention is three days regardless, and
  the query cost scales with the span — each run already reads over a million
  rows.
- **Fallback constant, widened 180 → 480.** Used when there is no previous
  completed run, no token, or the API call fails. Sized from the measured
  maximum of 327 minutes with headroom. The script announces the fallback on
  stderr, so falling back is visible rather than silent — the failure mode this
  whole document is about.

`CLIENT_ERROR_LOOKBACK_MINUTES` remains an explicit override and wins over
derivation. It is an existing test seam and a manual escape hatch.

The workflow's `permissions` block currently grants `contents: read` alone and
gains `actions: read`.

## What the cron lines say *(approved)*

`heartbeat.yml` keeps `*/5 * * * *`. Re-declaring it as `0 */3 * * *` would read
honestly and risk behaving worse: `*/5` functions as continuous retry, and a
sparse cron that gets delayed or dropped has no intervening attempts behind it.
We would be trading a measured cadence for an unmeasured one. The line stays and
the measurement goes directly above it, so it reads as a request rather than a
promise.

Same for `client-error-monitor.yml`'s hourly cron.

## The claim corrections *(approved)*

| file | the claim | reality |
|---|---|---|
| `.github/workflows/heartbeat.yml:11` | `*/5` with no caveat | keep the cron, add the 2026-09-19 measurement above it |
| `.github/workflows/deploy.yml:802` | "up to 31 minutes later on the cron" | ~203 min, and the fallback alarm is now the Worker cron, not this one |
| `.github/workflows/client-error-monitor.yml:13` | "Hourly rather than every five minutes" | delivered every ~197 min |
| `scripts/client-error-monitor.sh:46-51` | cites the heartbeat's 24 min median | wrong workflow, and a month stale |
| `docs/runbooks/2026-08-21-client-error-monitor.md:135` | "180-minute lookback is wider than the hourly cron" | narrower than the median gap |
| `apps/web/src/monitoring.ts:40` | "alerts hourly" | justifies a web app design decision on a false latency |
| `apps/web/src/lib/reportError.ts:16` | "hourly workflow" | same |
| `packages/monitoring/src/monitor.ts:137` | "an hourly workflow alerts on it" | same |
| `docs/observability-dashboards.md:209,270` | run-rate arithmetic from the 24 min median | off by roughly eightfold |

`apps/api/src/heartbeat.ts:7-11` and `apps/api/wrangler.toml:101-104` cite the
2026-09-13 numbers, but both are dated and attributed. They are history, not
false claims, and get the remeasurement appended rather than a rewrite. One
sentence does go stale the moment `deploy.yml` is corrected:
`heartbeat.ts:10` says deploy.yml "still" reasons about 31 minutes.

## Testing *(approved)*

`scripts/client-error-monitor.test.sh` already runs in `deploy.yml`'s lint job.
The GitHub API call gets a seam in the style of the existing
`MONITOR_PREFLIGHT_ONLY` / `MONITOR_PRINT_QUERY` / `MONITOR_RENDER_EVENTS`
seams, all of which exit before any network request.

Cases:

- derives the window from a previous completed run
- floors a too-recent previous run at 60 minutes
- caps an ancient previous run at 24 hours
- falls back to 480 on empty run history
- falls back to 480 when the API call fails
- falls back to 480 with no token present
- announces every fallback on stderr
- an explicit `CLIENT_ERROR_LOOKBACK_MINUTES` beats derivation
- a failed previous run counts as completed and is not skipped

## Out of scope *(approved)*

- **A dead man's switch for the Worker cron.** `heartbeat.ts:17-24` states the
  gap plainly: if the Worker stops running, the cron does not fire and nothing
  reports anything — the absence is the signal, and nothing watches for it.
  It overlaps `onlooker-txcu.9` and needs its own design.
- **Moving the client error check onto the Cloudflare cron**, where schedules
  are kept. It is the real fix for this workflow and a larger one: over a
  million log rows per run, a Cloudflare API token in a new place, and its own
  failure modes.
- **Resizing the Sentry cron monitors.** Checked above; they still hold.
