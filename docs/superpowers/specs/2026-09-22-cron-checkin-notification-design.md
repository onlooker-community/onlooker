# Cron Check-in Notification — Design

Bead: `onlooker-txcu.9` ([ONL-50](https://linear.app/onlooker/issue/ONL-50)).
One new rule file, one behavior change in `scripts/sentry/apply.sh`, one line in
`scripts/sentry/checkin.sh`, and the tests for both. No new machinery.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-22.
Sections marked *(measured)* were read from this repository, Sentry's
documentation, or the live GitHub API on 2026-09-22; each names where the fact
came from.

## Two premises in the bead that do not hold *(measured)*

The bead was written on 2026-09-14 and its notes last investigated on
2026-09-19. Two of the things it asserts have since stopped being true, and both
change what the fix is.

**The heartbeat has no monitor to miss.** `heartbeat.yml:41-69` records that its
check-in step was removed deliberately: Sentry Crons bills per *active* monitor,
this org has one seat, and the seat went to `client-error-monitor.yml`. The
second monitor was created disabled, and a disabled monitor accepts a check-in
with HTTP 202 and stores nothing — the bug `onlooker-txcu.6` was opened for. So
detector `10315978` ("Heartbeat workflow") exists in front of a monitor that
receives nothing and could never fire.

The bead's note offers "heartbeat-workflow has 14" as evidence that check-ins
arrive. They no longer do. PR #163 (`3f4802b`, 2026-09-14, "stop heartbeat.yml
reporting into a monitor nobody watches") removed the step five days before that
note was written, so the 14 are a historical count that had already stopped
growing when it was read.

A workflow bound to `10315978` would be precisely the thing this bead exists to
prevent: one that cannot fire. The bead's done-when — "a missed check-in on
either monitor notifies someone" — is unreachable for the heartbeat without
buying a second seat, which `heartbeat.yml` already decided against and wrote
down.

**Cron check-ins carry an environment, and it is already `production`.** The
bead's second design question assumes check-ins are untagged, and concludes the
production guard "would have to learn the difference between a detector type
that carries an environment and one that does not." Sentry's documentation for
the check-in HTTP API says otherwise: the endpoint takes an `environment` query
parameter, and "if you don't specify an environment with your check-ins the
default is `production`."

`checkin.sh:57` does not specify one. Every check-in this repo has ever sent is
therefore tagged `production` already, and `assert_production_scoped`
(`apply.sh:140-148`) needs no exception, no allowlist of environmentless
detector types, and no change to its safety story.

## Scope *(approved)*

One monitor: `client-error-monitor-workflow`, detector `10315979`, project
`4512075995283456` (`onlooker-api`), org `onlooker-vw`.

The heartbeat is out of scope. That is recorded here, in the new rule file's
comment, and on the bead, each pointing at `heartbeat.yml:41-69` so the next
reader does not have to rediscover the seat limit to understand the gap.

## The applier resolves detectors instead of guessing *(approved)*

`detector_for()` (`apply.sh:168-173` as of `36eced2`, the commit this branch
starts from) selects on `(projectId, type)` and returns `first`. Project `4512075995283456` holds two `monitor_check_in_failure`
detectors, so today that call would bind arbitrarily — and the one it would
reach first is not knowable from here, which means it could silently bind the
new workflow to the dead heartbeat detector.

It becomes a resolver that returns the whole match set, and `apply_workflow()`
branches on its size:

| matches | behavior |
|---|---|
| 0 | `ERROR`, with today's message unchanged |
| 1 | bind |
| 2+ | `REFUSED`, listing each candidate's id and name, and naming `detectorName` as the way to disambiguate |

Rule files may carry an optional `detectorName`, folded into the `jq` selector
when present. The three shipped `issue_stream` files are unchanged — one
detector each, so they resolve to exactly one match and take the same path they
take today — but they stop being mis-bindable the day a project grows a second
detector of a type.

Refusing on ambiguity rather than picking is the posture the rest of this script
already takes: `assert_production_scoped` refuses a rule it cannot vouch for,
and `report_drift` prints `UNKNOWN` rather than a clean bill of health it did
not earn.

Detector *names* are the handle rather than ids, for the reason the script's
header already gives at `apply.sh:22-25`: an id means nothing to a reviewer and
breaks when a project is recreated.

## The rule file *(approved)*

`scripts/sentry/rules/cron-checkin-missed.json`:

- `project`: `"4512075995283456"`
- `detectorType`: `"monitor_check_in_failure"`
- `detectorName`: `"Client error monitor workflow"`
- `workflow.name`: `"Client error monitor missed a check-in (production)"`
- `workflow.environment`: `"production"`
- action: `email` / `issue_owners` with `fallthroughType: "AllMembers"`, matching
  the three existing files. A missed check-in has no suspect commit to own it, so
  it falls through to all members — which is the intended audience anyway. This
  avoids introducing a second action shape, and a hardcoded team id, into
  `rules/`.

**One unknown, to be resolved against the live API rather than guessed.** What
trigger shape a `monitor_check_in_failure` detector accepts cannot be determined
offline; Sentry publishes no schema for these endpoints (`onlooker-txcu.2`). The
file starts with the `first_seen_event` condition the other three use, on the
reasoning that a missed check-in raises a new issue. If Sentry rejects it, the
response names the valid condition types and `apply.sh:229-231` already prints
600 bytes of the body. The fallback to try is an empty `conditions` array under
`logicType: "any-short"`, meaning "whenever this detector fires."

This is a live-API question, not a design one, and it is the reason section
*Verification* exists.

## `checkin.sh` states the environment it relies on *(approved)*

One line: `&environment=production` appended to the check-in URL
(`checkin.sh:57`), with a comment recording that Sentry's default is already
`production`, so this changes nothing today and exists so the workflow's
environment filter rests on something this file states rather than on a default
that could move.

The check-in reports that the scheduled job *ran*, not which environment it
inspected — `client-error-monitor.yml` checks both staging and production in one
run — so `production` is the right tag for it regardless.

## Tests *(approved)*

Offline, in `apply.test.sh`, with a new `testdata/detectors-server.py` beside
`gone-server.py` serving two `monitor_check_in_failure` detectors in one project.
The existing 410 tests already establish the local-fake-server pattern and the
port-polling that avoids a guessed sleep.

Three cases:

1. an ambiguous file with no `detectorName` is refused
2. the same file with `detectorName` binds to `10315979` specifically
3. a `detectorName` naming no existing detector takes the 0-match error

**Case 1 must assert on the message, not the exit code.** `apply.sh` exits 1 for
a malformed file, a rule that is not production-scoped, and a Sentry rejection
alike, so an exit-code-only assertion would pass identically whether the
ambiguity branch existed or not. It asserts the refusal names the ambiguity and
lists both candidates. Cases 1 and 2 run against the same server and must
differ in an observable the other cannot produce — the bound detector id in case
2, the word "ambiguous" in case 1.

The shipped rule files keep their existing assertions: valid JSON,
production-scoped, and refused when either property is removed.

## Verification *(approved)*

A committed payload that Sentry accepts is not an alert that fires. That
distinction is what this epic exists for, and
`alerts/waitlist-submit-failed.json` already carries an `UNVERIFIED` block
saying so in its own words: "Sentry accepted this rule, but accepting is not
firing."

So this bead closes only after all three:

1. `apply.sh` applies the file cleanly
2. the resulting workflow lists `detectorIds: ["10315979"]` — read back, not assumed
3. `scripts/sentry/checkin.sh client-error-monitor-workflow error` forces a
   failed check-in and a notification arrives

Step 3 needs `SENTRY_AUTH_TOKEN`, so it runs locally under `op run` rather than
in CI, the same way `apply.sh`'s header already documents at `apply.sh:84-90`.

Forcing an `error` check-in is what makes this provable in minutes instead of
waiting out a 6 hour interval plus a 2 hour margin for a real miss.

## What this does not do

- It does not monitor `heartbeat.yml`. See *Scope*.
- It does not change `assert_production_scoped`. See *Two premises*.
- It does not touch the metric alert in `alerts/`, which is `onlooker-txcu.2`.
- It does not add multi-detector (`detectorIds` array) support. One live monitor
  does not need it, and it would not have prevented the mis-binding this fixes.
