#!/usr/bin/env bash
# Tells Sentry Crons that a scheduled workflow ran.
#
# heartbeat.yml and client-error-monitor.yml cannot detect their own absence.
# client-error-monitor.yml's own header names the bug it was built to replace -
# "a monitor that stays green while blind" - and a workflow that silently stops
# being scheduled is the purest form of that: no failure, no email, no run at
# all, and the inbox looks exactly like a quiet week. GitHub does not tell
# anyone either; it disables schedules on inactive repositories without a word.
#
# A Sentry cron monitor closes that by expecting a check-in on a schedule and
# raising an issue when one does not arrive.
#
# Usage:
#   scripts/sentry/checkin.sh <monitor-slug> in_progress|ok|error
#
# Sentry pairs an `ok` or `error` with the monitor's open `in_progress` itself,
# so nothing here has to carry a check-in id between steps.
#
# THIS SCRIPT NEVER FAILS ITS CALLER. It exits 0 whatever happens - bad
# arguments, no network, Sentry returning 500. A telemetry call that can break
# the job it is reporting on would make the monitoring worse than none: the
# heartbeat exists to check production, and it must not go red because an
# observability vendor had a bad afternoon. Every failure here is a printed
# warning and nothing more.
set -uo pipefail

# Ingest address, not a credential - the same DSN sits in apps/api/wrangler.toml
# and in the web bundle in plain sight. Split into parts because the check-in
# URL is not the DSN: it is <host>/api/<project>/cron/<slug>/<status>/.
readonly SENTRY_HOST="${SENTRY_INGEST_HOST:-o4512074220371968.ingest.us.sentry.io}"
readonly SENTRY_PROJECT="${SENTRY_INGEST_PROJECT:-4512075995283456}"
readonly SENTRY_KEY="${SENTRY_INGEST_KEY:-4ae17b2b535e1bbed1df91ac1fcce47f}"

readonly SLUG="${1:-}"
readonly STATUS="${2:-}"

warn() {
	echo "[sentry-checkin] $*" >&2
	exit 0
}

[[ -n "${SLUG}" ]] || warn "no monitor slug given; skipping"

case "${STATUS}" in
	in_progress | ok | error) ;;
	*) warn "unknown status '${STATUS}'; expected in_progress, ok or error" ;;
esac

# The key goes in the PATH, and the status is a query parameter. This is not
# interchangeable with the arrangement it looks like: putting the status in the
# path and the key in `?sentry_key=` makes the endpoint read the status
# positionally AS the key, and it answers 400 "multiple authorization payloads
# detected" - which sounds like a credentials problem and is a URL shape
# problem. Verified against the live endpoint on 2026-09-13: this form returns
# 202 and the check-in appears on the monitor.
readonly URL="https://${SENTRY_HOST}/api/${SENTRY_PROJECT}/cron/${SLUG}/${SENTRY_KEY}/?status=${STATUS}"

code=""
if ! code="$(curl --silent --show-error --max-time 10 --request POST \
	--output /dev/null --write-out '%{http_code}' "${URL}" 2>&1)"; then
	warn "could not reach Sentry: ${code}"
fi

case "${code}" in
	2*) echo "[sentry-checkin] ${SLUG}: ${STATUS} (HTTP ${code})" ;;
	*) warn "${SLUG}: ${STATUS} was not accepted (HTTP ${code})" ;;
esac

exit 0
