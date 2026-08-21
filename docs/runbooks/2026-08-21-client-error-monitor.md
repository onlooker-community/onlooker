# Runbook — the client error monitor

**Created:** 2026-08-21
**Issue:** onlooker-kuk, under the observability epic onlooker-k34

`apps/web` reports render throws to `POST /api/client-errors`, which logs them.
That has worked since PR #53 and told nobody anything: the reports land in
Workers Logs with 3-day retention, and nothing read them. This job reads them.

Failing the run is the entire alert. GitHub emails on workflow failure, which is
already this project's only alerting mechanism and the only one anyone watches.

| | |
|---|---|
| Workflow | `.github/workflows/client-error-monitor.yml` |
| Script | `scripts/client-error-monitor.sh` |
| Tests | `scripts/client-error-monitor.test.sh` |
| Schedule | Hourly, with a 180-minute lookback |
| Token secret | `CLOUDFLARE_OBSERVABILITY_TOKEN` |
| Account secret | `CLOUDFLARE_ACCOUNT_ID` |

## The token

Named **Observability Token** in the Cloudflare dashboard. One permission:

**Account → Workers Observability → Read**, scoped to the entire account.

That group exists and is sufficient; it was confirmed by creating the token and
running the real query, not by reading documentation. The Workers Observability
REST API documents three endpoints but names no required permission anywhere,
and Cloudflare's own observability MCP server uses OAuth, so it does not name
one either.

It is deliberately **not** the deploy token. `CLOUDFLARE_API_TOKEN` can write
Workers; a read-only monitor has no business holding that, and a job that runs
every hour is a bad place to keep the credential that can replace production.

### Do not test it with the verify endpoint

```
GET /client/v4/user/tokens/verify   ->  success:false, "Invalid API Token"
```

That is a **false negative**, and it will cost you an hour if you trust it. The
token is account-owned — it begins `cfat_` — and `/user/tokens/verify` is a
*user* endpoint, so an account-owned token carries no user context to verify.
The same token answers the account endpoint correctly.

Test it against the thing you actually need:

```bash
export CLOUDFLARE_API_TOKEN=...      # never echo this
export CLOUDFLARE_ACCOUNT_ID=...
scripts/client-error-monitor.sh production
```

### Rotating it

The token has **no expiration**, so nothing forces this to happen and nothing
will remind you.

1. Create a replacement in the dashboard with the same single permission. Copy
   the value when it is shown; Cloudflare shows it exactly once.
2. Verify it *before* retiring the old one, using the command above. A token
   that fails here fails silently in CI as an exit 2, and the staging step
   swallows that as a warning.
3. Update the `CLOUDFLARE_OBSERVABILITY_TOKEN` repository secret.
4. Delete the old token in the dashboard.

Unlike the heartbeat account, nothing here is unrecoverable: a lost token is
replaced by making another one. Two heartbeat accounts are permanently
unrotatable because their passwords were never saved
([the heartbeat account runbook](2026-08-17-heartbeat-account.md) records that).
This credential does not have that failure mode, and should not be given one.

## Exit codes

Three-way on purpose. Collapsing 2 into 0 is how a broken monitor reads as good
news forever.

| Code | Meaning |
|---|---|
| 0 | The window was quiet |
| 1 | Client errors were reported — this is the alert |
| 2 | The monitor could not do its job, which is **not** the same as quiet |

Production fails the run on both 1 and 2. Those are different problems and the
log says which, but both mean nobody is watching.

## The filter key, and why it is pinned by a test

The discriminator is the bare key `event`, filtered with `eq` against
`client_error`. It is neither of the two things it looks like it should be.

Workers Logs parses the JSON string handed to `console.error` and makes every
property a queryable top-level key. The report's own `message` property is
promoted into `$metadata.message`, so that field holds the error text and never
the JSON envelope — the literal string `client_error` appears nowhere in it.
Responses nest the parsed object under `source`, but `source.` is not a query
prefix.

Measured against a real report on 2026-08-21:

| Filter | Matches |
|---|---|
| `$metadata.message includes client_error` | 0 |
| `source.event eq client_error` | 0 |
| `event eq client_error` | **1** |

**All three returned `success: true` with an empty `errors` array.** An unknown
filter key does not fail — it just never matches, and the response is identical
to a correct query over a quiet window. Nothing at runtime can tell you which
one you shipped.

That is why `client-error-monitor.test.sh` asserts the exact key, and why every
run issues a **control query** first: the same endpoint, the same window, no
filters, requiring a non-zero result. If the control finds nothing, the monitor
cannot see the dataset and its silence is worthless, so it exits 2 instead of
reporting quiet.

The control query is sound only because the heartbeat generates traffic against
both API environments every few minutes. **If the heartbeat is ever retired,
this assumption retires with it.**

## When it fires

The email says only that a workflow failed. Open the run log; the reports are
printed there with service, kind, message, and URL.

1. **Read the message and URL.** Stacks are readable — `apps/web` builds with
   source maps since PR #64.
2. **Check whether it is one user or everyone.** The blank-dashboard incident
   that motivated this whole epic was a render throw affecting every logged-in
   user while the API answered 200 throughout.
3. **Expect repeats.** The 180-minute lookback is wider than the hourly
   schedule, so a single error is reported by roughly three consecutive runs
   before it falls out of the window. That overlap is deliberate: GitHub's cron
   was measured at a 24-minute median and a 112-minute maximum delay
   (onlooker-2ho), and a window equal to the interval would leave gaps.

## Testing it by hand

The endpoint is unauthenticated by design, so a synthetic report needs nothing
but `curl`. Send it to **staging** — production heartbeat failures page, and a
fake error in the production record is a lie you will read later.

```bash
curl -sS -X POST https://api-staging.onlooker.dev/api/client-errors \
  -H 'Content-Type: application/json' \
  -d '{"kind":"render","message":"SYNTHETIC test - not a real error","url":"https://app-staging.onlooker.dev/__test"}'
```

Wait roughly 20 seconds for ingestion, then:

```bash
scripts/client-error-monitor.sh staging     # expect exit 1 and the report printed
```

Label synthetic reports clearly. They are indistinguishable from real ones in
the log otherwise, and they persist for the full 3-day retention.
