# Cloudflare Observability Dashboards

**Status:** Built 2026-08-09 in Cloudflare Custom Dashboards.
**Depends on:** the synthetic heartbeat — see
[the heartbeat design](superpowers/specs/2026-08-09-heartbeat-design.md).

Four dashboards, ordered so each narrows the ambiguity the previous one leaves:

1. **Traffic and availability** — did the request arrive?
2. **Worker runtime health** — did the code survive it?
3. **D1 health** — did the data layer survive it?
4. **Auth surface and abuse** — was it a human, and were they welcome?

A `500` appearing on all three of the first tells a completely different story
than one appearing on only the first.

---

## Read this before trusting any chart

**Filters are not optional, and a wrong one fails silently.** This is the whole
reason this document exists. The identifiers below are invisible from the
dashboard UI, and a chart with the wrong filter renders a plausible-looking
result rather than an error. Everything else here can be re-derived; these
cannot.

**The trailing edge of every short-range chart droops artificially.** Cloudflare
documents a delay in aggregation and metrics delivery that makes the last few
minutes of any range under six hours read low. It is not a traffic drop. On
dashboards whose premise is "deviation from a constant means trouble," that
artifact sits exactly where the eye lands first. Worth a pinned text note.

**Bucket hourly — except you cannot save it, and it is still not enough.** The
heartbeat does not run every 5 minutes as configured, and it does not run every
31 either — that figure came from a three-run sample. Counted across 196
consecutive scheduled runs spanning 113.3 h (2026-08-22), the delivery is a broad
distribution rather than a throttle:

| min | median | p90 | max |
|---|---|---|---|
| 17 | 32 | 52 | **95** |

Any bucket narrower than the delivered interval is empty whenever no run lands in
it, so the floor reads as sparse spikes rather than a constant line. At the ~15
minutes Auto picks for a 24-hour range, Dashboard 1's hostname chart is a
sawtooth touching zero constantly.

Setting the chart's **Interval** to 1 hour fixes the shape completely — and does
not persist. It lives in the chart's `···` menu, reverts to Auto on reload, and
has no equivalent in Configure, which exposes no granularity field at all. The
dashboard time range is URL state (`?time={"r":10080}`) rather than a saved
default. Bucket width is a per-view setting, so **there is no way to ship a
dashboard that opens correctly bucketed** — whoever opens it gets Auto.

Hourly would not be sufficient even if it did stick. Over the same 196 runs, **5
of 113 interior clock-hours contained no run at all (4.4%)** — roughly one empty
bucket per day on a host whose only traffic is the heartbeat. Confirmed against
the run log rather than inferred: 23:55:01Z then 01:01:40Z on 2026-08-22 is a
66-minute gap, with every surrounding run successful.

This is the tail beating the mean, which is the same mistake this document warns
about further down. ~3.5 requests per host per hour is the average; the p90 gap
of 52 minutes and the max of 95 are what decide whether a 60-minute bucket is
empty. **A zero bucket is not signal.** Detection is the heartbeat workflow
failing and emailing; these dashboards are for investigation afterward.

**Standard datasets are sampled.** The heartbeat's volume is what makes sampling
behave at all, and it delivers less than designed. Do not read low-count charts
as precise.

**`404` is the largest status bucket on `api`, and it is noise.** Measured
2026-08-16: 145 `404`s in 24 h on `api.onlooker.dev` against 8 `200`s, making it
the biggest bar on Dashboard 1's status chart and the first thing the eye lands
on. Grouping those same `404`s by path shows **no path above 2 requests in 24
hours**. It is internet background scanning — `.php` webshell names (`god.php`,
`mini.php`, `wp-tem.php`), WordPress paths, `/.git/config`,
`/.well-known/security.txt`. One burst of ~50 arrived 7 ms apart from a single
Azure IP (AS8075) over plain HTTP carrying **no `User-Agent` header at all**,
which is a cleaner tell than any path pattern.

The test that separates this from a real bug is concentration, not volume. A
client calling a route that does not exist repeats *one* path, so it sorts to the
top of a count-ordered list; scanning is flat. Check that before concluding
anything from a `404` spike, and do not try to read it off the status chart,
which cannot show a path.

**Checking a `404` spike.** Log Explorer is the obvious tool and is **not
available** — it is a paid add-on this account has not purchased, and the sidebar
entry leads to a purchase page rather than a query. Use Workers Logs, which is
free and already on (`[observability]` in `apps/api/wrangler.toml`):

Workers & Pages → `onlooker-api-production` → Observability → Visualizations

| | |
|---|---|
| Filter | `$workers.event.response.status` = `404` |
| Group by | `$workers.event.path` |
| Order by | `count`, descending |
| Range | 24 hours |

A top count of 1–2 is scanning and needs no action. Any path reaching double
digits is one of ours, and the path names the bug.

---

## How to build one

Cloudflare dashboard → **Analytics** → **Custom Dashboards**. Blank, or from a
template — "Account takeover" is close to Dashboard 4's intent.

Each chart takes four things: a **dataset**, a **metric** with its aggregation,
**dimensions** to break it down by, and **filters**. Chart types available are
Timeseries, Bar, Donut, Map, Stat, Percentage and Top N, which is why the
descriptions below name a shape — they are choosing from that list.

There is also a natural-language builder. Describing the chart is usually the
fastest way to find the exact field name for something, since the dimension
names are not guessable and are not visible until you are already in the right
dataset. Check what it produces against the filter reference below rather than
trusting it; a wrong filter here renders a plausible chart, not an error.

Two shapes worth knowing:

- **Percentage** is the right type for anything expressed as a rate — a 404
  *rate* rather than a 404 *count*, because a count also rises with legitimate
  traffic and a rate does not.
- **Top N** is the right type for "which client IPs" and similar. Note the
  underlying data is sampled, so at this project's volume the tail is noise.

Standard accounts get up to 25 dashboards.

## Filter reference

### Hostnames — zone `onlooker.dev`

| | production | staging |
|---|---|---|
| web | `app.onlooker.dev` | `app-staging.onlooker.dev` |
| api | `api.onlooker.dev` | `api-staging.onlooker.dev` |

**Selecting the zone is not sufficient.** Other subdomains of `onlooker.dev`
serve unrelated projects — the schema host at `schema.onlooker.dev` among them.
Filter zone-scoped charts by hostname explicitly, or the docs and schema sites
appear as extra series and "the four hosts" stops meaning anything.

### Worker scripts — account-scoped

| | production | staging |
|---|---|---|
| api | `onlooker-api-production` | `onlooker-api-staging` |
| web | `onlooker-web-production` | `onlooker-web-staging` |

Deployed names carry the environment suffix, because `wrangler.toml` uses named
environments. There is no bare `onlooker-api` — filtering on that matches
nothing and yields an empty chart that looks like an outage.

**These are the dangerous charts.** Workers datasets have no zone concept and
span the entire account. Three unrelated workers live here and will be included
in any unfiltered chart:

- `onlooker-community-docs`
- `onlooker-schemas`
- `onlooker-community-website`

A polluted chart still looks plausible: a healthy docs worker dilutes the API's
error rate, and a real spike averages into invisibility.

### D1 databases — account-scoped

| | name | UUID |
|---|---|---|
| production | `onlooker-db` | `5473b131-271e-4ce9-84e5-b48a93269dc8` |
| staging | `onlooker-db-staging` | `ff3a01c8-aedb-4bc2-8231-b8511b353728` |

Only these two exist, so pollution risk is low — but still filter by database.
Production and staging have *opposite* expectations, and combining them destroys
the cleanest signal on any of these dashboards (see D1 chart 1).

### Expected volumes

Derived from the delivered cadence, not the requested one. Treat as a **ceiling**
and expect irregular spacing — GitHub's scheduler is not punctual.

Measured against the delivered run rate of 2.22 runs/hour — 100 scheduled runs
over 44.7 h, via `gh run list --workflow=heartbeat.yml --event=schedule`.

**Remeasured 2026-08-22 and the rate has dropped: 1.73 runs/hour**, from 196
scheduled runs over 113.3 h. The table below was derived at 2.22 and is now
roughly 22% high — which is the direction the section already asks you to read it
in, since it says "treat as a ceiling," but the gap is now wider than it looks.
The figures below are deliberately **not** rescaled: recomputing them from a
factor rather than remeasuring each one is how a derived figure goes wrong a
fourth time. Multiply by ~0.78 for a current estimate, or remeasure.

Count the checks by **running** the script, not by grepping it. Its last line
reports its own total — `all 9 checks passed` — and that is the number the
arithmetic here uses. No grep reproduces it: the four original checks go through
the `check` helper, one call site each, while the four authenticated checks
report through `record` from separate success and failure branches, so any
pattern counting call sites counts branches instead. This recipe used to say
`grep '^check '`, which returns 4 and silently halved every figure below it —
the exact way a derived figure goes wrong a third time.

Without `HEARTBEAT_EMAIL` and `HEARTBEAT_PASSWORD` the script skips the
authenticated checks and reports 4. Nine is the number with credentials, which
is what CI runs.

Counted, not derived from the median gap. The distribution's long tail makes the
median of 24 minutes imply ~60 runs/day, which overstates the real rate by ~13%.

| | per day |
|---|---|
| heartbeat runs | ~53 |
| `onlooker-api-production` invocations | ~371 |
| `onlooker-web-production` invocations | ~106 |
| D1 queries per database | ~530 |
| total requests, all four hosts | ~954 |

The API figures roughly tripled on 2026-08-17, and the D1 figures rose sixfold,
when the heartbeat gained four authenticated checks — login, an authenticated
read, logout, and a revoked-token refresh. Six API requests per environment per
run rather than two, and six D1 operations rather than one.

A fifth authenticated check landed 2026-08-18: refreshing with a *valid* token,
the one assertion that a session can be extended rather than refused. Seven API
requests per environment per run now, and ten D1 operations — that check alone
costs four, because `handleRefresh` reads the session, reads the user, revokes
the old token and writes the new one.

**These two are derived, not measured.** They come from counting the calls each
handler makes, against the same ~53 runs/day. Every other figure in this table
was counted from delivered runs, and the ones that were derived have been wrong
twice. Re-measure and correct them here.

The web figures **doubled** when the heartbeat gained a deep-link check: it used
to request only `/`, which is a file on disk and therefore could not detect the
outage where every other route 404'd. Two requests per environment now.

Deploys add a burst on top — the same script runs as a post-deploy smoke test,
so each deploy contributes 9 requests per environment it touches.

Do not set thresholds on these. Prefer a shape-based rule — "zero for two
consecutive hours" — over any absolute count, but note how little headroom that
rule has. The largest observed gap is 112 minutes, or 93% of a two-hour window, so
a single empty hourly bucket is normal cadence on a healthy system and only the
second one carries information.

That tail also sets the detection latency, which is worse than the cadence suggests:
two consecutive missed runs at the observed maximum is ~3.7 h before anything is
noticed. Write any alerting SLO against the tail, not the median.

Every figure here has been wrong twice. The original set assumed the configured
5-minute cron and was out by roughly 6x. The set that replaced it inferred a steady
31-minute delivery from three runs, and read ~13% low once 100 were counted.

---

## Dashboard 1 — Traffic and availability

Zone-scoped on `onlooker.dev`, every chart additionally filtered to the four app
hostnames.

**Requests by hostname over time.** Hostname is the grouping dimension, so
restrict the set rather than letting it enumerate.

This chart was designed as the floor chart — "all four hosts non-zero is the
healthy state; one dropping out is the `api-staging` DNS failure that motivated
the whole design." **That premise does not hold and cannot be made to hold.** At
any bucket width the tool can render, a healthy heartbeat-only host reads zero
some of the time: ~4.4% of clock-hours at hourly, constantly at the 15 minutes
Auto picks. See the bucketing note at the top for the measurements.

So read it for **shape and totals, not for a floor**. The legend totals are
reliable at any bucket width — they are what to compare between hosts and across
days. A sustained flat-zero stretch on one host while the others carry traffic is
still worth chasing; a single empty bucket is cadence, not an outage.

The `api-staging` DNS failure this was built for would be caught today by the
heartbeat workflow failing and emailing, which is the detection mechanism. This
chart is where you look afterward to see when it started.

**Availability.** Reads non-5xx / total requests across `api` and `app`, so 100%
is healthy and a dip is real. It originally shipped with the status filter
inverted — numerator `is in` the 5xx set rather than `is not in` — which computed
the error rate correctly and then displayed it under a heading that made 0.00%
read as total outage (onlooker-mxf). Worth knowing because the tile looked
broken and was not: the math was right and the label was wrong, which no amount
of staring at the number would have revealed.

**Status codes over time.** Split api from web. `401` is the healthy steady
state on api — it is what a correct auth rejection looks like — and would be
alarming on web. A combined chart makes both unreadable.

---

## Dashboard 2 — Worker runtime health

Every chart filtered to the four app scripts. This dashboard answers what a
status code cannot: a `500` from a thrown exception and a `500` from D1 being
unreachable are identical at the edge.

**Invocation outcomes over time**, stacked, for `onlooker-api-production`,
broken down by invocation status. Success, client-disconnected,
script-threw-exception, exceeded-resources, internal-error — distinct fields,
not inferred. Success is a flat band; anything above it is a real event.
Exceeded-resources doubles as the free-tier ceiling alarm, since it fires on
both CPU overrun and plan limits.

**Error rate** as a percentage tile, `onlooker-api-production` only. A
percentage rather than a count because the volumes are small: one bad
invocation in an hour reads honestly as a percentage and as nothing as a count.
One script only — six others in the denominator is how a real error rate hides.

**Errors grouped by script**, bar chart, all four app workers. Chart one says
something broke; this says where. It is what separates "staging is mid-deploy"
from "production is down" at a glance.

**CPU time per execution, P50 against P99**, `onlooker-api-production` only.
Real quantiles — Cloudflare derives them by reservoir sampling. Read the gap
rather than the lines: flat P50 with climbing P99 means a subset found a slow
path, and D1 is the only I/O, so that subset is almost certainly the database.
Never mix workers here; a P99 over a static-asset worker and a database-backed
API describes nothing.

**Wall time per execution, P99**, its own chart. Sharing an axis with CPU would
be the dual-axis mistake and they measure different things. Wall time counts the
JavaScript context staying open including `waitUntil()` work after the response
was sent — so rising wall time with flat CPU means something runs on after the
user was answered, invisible in response times and visible only here.

**Invocation volume**, `onlooker-api-production`. Read the shape, not the
number. Zero means the heartbeat stopped — which is the self-disabling failure
the design accepts and covers by this chart flatlining.

**Staging outcomes**, a separate chart rather than another series. Staging
breaking is routine; production breaking is an incident. Sharing an axis trains
you to read both as the same severity, which is how monitors get muted.

Deliberately omitted: **subrequests**. The API makes no outbound `fetch` calls,
so the chart would sit at zero and teach nothing. Add it if that changes.

---

## Dashboard 3 — D1 health

Filter by database throughout. Until Analytics Engine exists, this is also the
closest thing to a product-usage signal — the heartbeat never writes, so every
write to production D1 is a real human.

**Rows written — production.** Should be flat zero, and belongs at the top. Any
nonzero bar is either a real person or something writing unintentionally, and
both are worth knowing immediately. No baseline is ever cleaner than zero.

**Rows read — production.** The index-health chart. Each heartbeat does one
indexed lookup on `token_hash` that matches nothing, so this stays near-flat and
small. Cloudflare counts rows *scanned*, not returned — so if this bends upward
while request volume stays flat, a query stopped using its index and started
walking the table. Visible here long before anyone notices slowness.

**Storage size — production.** The long-horizon chart, and the one with teeth.
Nothing prunes expired sessions today; a slow monotonic climb *is* that table
filling. At ~86 KB against a 5 GB ceiling there is enormous headroom, which is
exactly why it needs a chart — nobody notices a problem with that much slack
until it is abrupt.

**Query response time, P50 and P99.** Pairs with Worker wall time: if wall time
climbs and this does not, the delay is in application code; if both climb, it is
the database.

**Rows written — staging**, separately, and expect noise. Migrations and
rebuilds write constantly. The identical spike on the production chart would be
an event; keeping them apart is what stops that distinction eroding.

**Query volume by database.** The cross-check that the heartbeat reaches the
data layer on both sides. Zero here while Worker invocations stay healthy means
the API is up but no longer talking to D1 — precisely the outage
`/auth/refresh` was chosen to catch, and the one where the root URL keeps
answering `200`.

### Free-tier consumption

Use **stat tiles with the limit in the title**, not percentage widgets:

- `Rows written today (free tier: 100,000/day)`
- `Rows read today (free tier: 5,000,000/day)`
- `Database size (free tier: 5 GB)`

Cloudflare's Percentage widget computes part-to-whole *within the queried data*.
It cannot divide by a constant you supply, so "% of free tier" is not buildable.

For rows written the percentage framing would be wrong regardless: expected
value is zero, so the first real signup writes a handful of rows and renders as
`0.0%` — invisible at exactly the moment it matters. The auto-scaled chart above
shows that same signup as an unmistakable jump off the floor.

Budget alarms are better served outside a dashboard anyway. A chart only helps
if someone is looking, and you want to hear about a ceiling at 40%, not notice
it at 100%.

---

## Dashboard 4 — Auth surface and abuse

Zone-scoped, filtered to `api.onlooker.dev` and `api-staging.onlooker.dev` only.
Web hosts serve no auth routes and only inflate the baseline.

Built 2026-08-16, later than the other three, which were built 2026-08-09. Its
value comes from separating human traffic from a known floor, and until the
heartbeat labelled itself there was no reliable way to draw that line.

Expect it to look empty. At ~742 requests a day across the two API hosts this
dashboard watches, nearly all of them synthetic, these charts are a baseline
being established rather than a signal being read. That is the point of having
built it now: the shape of normal accumulates before there is anything abnormal
to compare against.

**401s over time, with the heartbeat filtered out.** Every request the heartbeat
makes carries `User-Agent: onlooker-heartbeat/1`, so exclude that and the
remaining 401s are, by construction, somebody else probing your auth endpoints.
A credential-stuffing detector for the cost of one filter.

This used to be phrased as a constant to subtract by eye — the script produced
exactly 4 401s per run, two per environment. It is now 6, three per environment,
since the revoked-token check asserts a 401 too. That the number moved is the
argument: it lived in a human's head, adding a check invalidated it, and
Cloudflare charts cannot draw a reference line at it anyway. The label replaces
arithmetic with a filter, and did not need updating when the number changed.

Do not reach for `User-Agent not like curl/*` instead. It would exclude anyone
probing with curl, which is precisely the traffic this chart exists to show.

**Requests by country** on a map, and **top client IPs** as a table. With one
real user the shape of legitimate traffic is nearly a single point, so anything
else stands out without anomaly detection.

**404 rate** — what vulnerability scanners generate before they find anything.
They are generating it now: ~145 a day, measured 2026-08-16. That is the
baseline, not an incident — see the `404` note under "Read this before trusting
any chart" for how to tell the two apart.

---

## What traces make answerable

Workers tracing went on 2026-08-16 (PR #57): `[observability.traces]` per
environment, no `head_sampling_rate`, so the rate is the default of 1 and
everything is traced. It is configuration rather than instrumentation —
fetches, binding calls and handler invocations are spanned with no code changes.

**Workers & Pages → `onlooker-api-production` → Observability → Traces.**

Three things about the dataset before any figure drawn from it:

- **There is no history before the deploy.** Traces begin when #57 shipped. A
  24-hour range looked empty for 23 of its hours on the day it landed, which is
  the config being new rather than traffic being absent.
- **Retention is 3 days** on the free plan, against 7 on paid, and the daily
  budget is 200,000 events. Current volume is nowhere near it — roughly 400
  spans a day against ~327 requests.
- **From 2026-10-01 each span bills as one observability event**, sharing the
  Workers Logs quota. Tracing is free only during the beta. That is the date to
  revisit `head_sampling_rate`, not before — sampling a dataset this thin now
  would only make it useless.

### What a span actually contains

Measured 2026-08-16 ~21:43 EDT, from a `POST /auth/refresh` trace — the whole
trace dataset was about 40 minutes old, so these are small numbers of
observations and are quoted as such rather than as averages.

| | |
|---|---|
| `POST /auth/refresh` | 151 ms total, 2 spans |
| └ `d1_all` child span | 100 ms |
| `db.query.text` | `select "user_id", "expires_at" from "sessions" where "sessions"."token_hash" = ? limit ?` |
| `cloudflare.d1.response.sql_duration_ms` | **0.3078** |
| `cloudflare.colo` (where the Worker ran) | `LAX` |
| `cloudflare.d1.response.served_by_colo` | `MIA` |
| `cloudflare.d1.response.served_by_primary` | `true` |

The SQL text arrives parameterized, with values bound out, so queries are
identifiable without leaking anything.

**One trap in that table if you go to query it.** The row above reads
`served_by_colo`, which is what the trace view showed. The *queryable* attribute
in Cloudflare's spans and attributes reference is
`cloudflare.d1.response.served_by_region`. Filtering on `served_by_colo` returns
nothing — and returns it as `success: true` with zero rows, which is the same
answer a quiet window gives. Query `served_by_region`.

**The headline is the gap between those two durations.** Executing the query
took 0.31 ms. The span took 100 ms. The Worker ran in Los Angeles and the
database answered from Miami, off the primary. Essentially all of what looks
like database time is the round trip to reach it, so the chart worth building is
span duration *against* `sql_duration_ms`, not either alone — and no amount of
query tuning moves it. Whether read replication should change that is a separate
question from what to draw.

### The three questions this section was opened to answer

**Which D1 queries dominate a request** — answerable, and answered above. The
second `/auth/refresh` trace in the same minute ran 84 ms, and the dashboard's
own comparison panel put the two `d1_all` spans at 40 ms and 100 ms. At n=2 that
is a range, not a distribution; re-measure before quoting it as one.

`scripts/d1-latency-sample.sh production` is that re-measurement, and how it
works is worth knowing, because the obvious approach does not.

**Trace spans are not reachable from the telemetry query API.** Probed directly
against production on 2026-08-23: that dataset's key list contains no
`cloudflare.d1.*` field of any kind, no event in it carries a `spanName`, and an
`exists` filter on `spanName` returns nothing — with no error, which is the
failure mode this page warns about everywhere else. The Traces tab you are
reading reads a different backend. The first version of that script queried the
API for `d1_all` spans and could never have worked, whatever its dataset name.

So `apps/api` measures it internally instead — see `apps/api/src/db/timing.ts`,
which wraps the D1 binding and emits one `d1_timing` line per query into Workers
Logs. `wall_ms` is what the Worker waited, `exec_ms` is D1's own
`meta.duration`, and the difference is the round trip. The sampler reads those.

That also sidesteps the trap below: these are every query, not the slowest 100,
so the percentiles are not biased upward by construction — which matters for
deciding whether 100 ms is typical or the tail.

**Where auth requests spend their time** — **answerable now; it was not when
this section was written, and the change is worth knowing about.**

The paragraph below described a system where every traced request was either a
`401` from the heartbeat or a `404` from a scanner, so nothing reached the code
that costs anything. It closed by saying the fix was "a heartbeat check that
authenticates as a seeded account… a change to `scripts/heartbeat.sh` and a
decision about test credentials in production, not a chart."

That shipped. PRs #61 and #62 gave the heartbeat a real account — see the
[heartbeat account runbook](runbooks/2026-08-17-heartbeat-account.md) — and it
now logs in and refreshes on every run. So successful authenticated requests
have been tracing for days, and the D1 spans on the refresh path are real
samples rather than rejections.

What follows is kept because it is still the right description of the *rejection*
paths. Treat every bullet as an observation from before #61, not as current
behavior — none of it has been re-observed since the heartbeat gained an
account, and at least the first two have almost certainly changed:

- `bcryptjs` at cost factor 10 runs only on login, signup and change-password.
  Those paths get no production traffic at all, so the expense the epic worried
  about has never been observed.
- `GET /auth/me` traces as a single span with no D1 child. That is *not* because
  it does no database work — `handleMe` calls `getUserById` — but because
  `requireAuth` rejects the tokenless heartbeat first. The trace describes the
  rejection path, not the real one.
- `POST /auth/refresh` is the exception, and only by accident: it queries
  `sessions` *before* deciding to reject, which is why it is the one path with a
  D1 span to look at.

Two of those three have almost certainly changed. `scripts/heartbeat.sh` now
posts real credentials to `/auth/login` on every run, which is the one path that
runs `bcryptjs` at cost factor 10, and it carries the resulting token into the
authenticated checks — so `GET /auth/me` should now be reaching `getUserById`
rather than being turned away at `requireAuth`.

**Should**, because nobody has looked. Re-observing it is the work, and
`scripts/d1-latency-sample.sh` is the instrument for the D1 half — reading the
`d1_timing` lines `apps/api` now emits, not the trace spans this tab shows,
which are not queryable. See the note above.

**Error rates by route rather than by worker** — answerable now, and already
demonstrated. Use the Visualizations query in the `404` note under "Read this
before trusting any chart": filter on `$workers.event.response.status`, group by
`$workers.event.path`. Any status works, not just `404`.

### One trap in the Traces tab

The list is titled **100 Slowest Traces** and means it. It is not a sample, so
averages taken from it are biased upward by construction. While the dataset is
smaller than 100 traces this does not matter — the slowest 100 of 60 is all of
them — but it will start lying quietly as volume grows.

### A wrong filter key looks exactly like a quiet window

Filtering on a key that does not exist does not fail. The query returns
`success: true`, an empty `errors` array, and zero events — which is
indistinguishable from a correct query over a period when nothing happened.

This bit the client error monitor before it shipped. Three plausible-looking
filters for the same log line:

| Filter | Matches |
|---|---|
| `$metadata.message includes client_error` | 0 |
| `source.event eq client_error` | 0 |
| `event eq client_error` | **1** |

Workers Logs parses the JSON string given to `console.error` and makes every
property a top-level queryable key. A `message` property inside that JSON is
promoted into `$metadata.message`, so `$metadata.message` holds the inner text
and never the JSON envelope. Responses nest the parsed object under `source`,
but `source.` is not a query prefix — query the bare property name.

So when a chart or a check reads zero, that is two claims, not one: nothing
happened, *or* it has been asking the wrong question since the day it was
built. Confirm the key against `/keys`, or against a log line you know exists,
before believing the zero. Anything automated should verify with a control
query that must return something — see
[the client error monitor runbook](runbooks/2026-08-21-client-error-monitor.md).

---

## Not buildable without Analytics Engine

A real product funnel — signups, successful versus failed logins, which failure
reason dominates, password resets — is blocked. None of it exists in
Cloudflare's HTTP or Workers datasets, because those describe requests rather
than meaning: a failed login and a successful one are both
`POST /auth/login`, and the edge cannot tell them apart.

It needs an Analytics Engine binding and `writeDataPoint` calls inside the API
worker. Writes are non-blocking and add no latency, so it is cheap once built —
but it is code in `apps/api`, not dashboard configuration.

That is the honest boundary of everything above: these dashboards measure
whether the system is healthy. None of them can tell you whether anyone is
successfully using it.
