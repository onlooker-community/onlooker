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

**Bucket hourly, and mean it.** The heartbeat does not run every 5 minutes as
configured, and it does not run every 31 either — that figure came from a
three-run sample. Counted across 100 consecutive scheduled runs spanning 44.7 h
(2026-08-16), the delivery is a broad distribution rather than a throttle:

| min | p25 | median | mean | p75 | max |
|---|---|---|---|---|---|
| 12 | 19 | 24 | 27.1 | 31 | **112** |

Any bucket narrower than the delivered interval is empty whenever no run lands in
it, so the floor reads as sparse spikes rather than a constant line. This is not
hypothetical: at the ~15-minute bucketing Dashboard 1 shipped with, two of the
four hosts read zero at 18:00 on 2026-08-16 while production was fully healthy.
An hourly bucket gets ~4.4 requests per host and is reliably non-empty.

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

Measured by counting the checks the script makes (`grep '^check ' scripts/heartbeat.sh`,
four per environment) against the delivered run rate of 2.22 runs/hour — 100 scheduled
runs over 44.7 h, via `gh run list --workflow=heartbeat.yml --event=schedule`.

Counted, not derived from the median gap. The distribution's long tail makes the
median of 24 minutes imply ~60 runs/day, which overstates the real rate by ~13%.

| | per day |
|---|---|
| heartbeat runs | ~53 |
| `onlooker-api-production` invocations | ~318 |
| `onlooker-web-production` invocations | ~106 |
| D1 queries per database | ~318 |
| total requests, all four hosts | ~848 |

The API and D1 figures roughly tripled on 2026-08-17 when the heartbeat gained
four authenticated checks — login, an authenticated read, logout, and a
revoked-token refresh. Six API requests per environment per run rather than
two, and six D1 operations rather than one.

**These two are derived, not measured.** They come from counting the calls each
handler makes, against the same ~53 runs/day. Every other figure in this table
was counted from delivered runs, and the ones that were derived have been wrong
twice. Re-measure and correct them here.

The web figures **doubled** when the heartbeat gained a deep-link check: it used
to request only `/`, which is a file on disk and therefore could not detect the
outage where every other route 404'd. Two requests per environment now.

Deploys add a burst on top — the same script runs as a post-deploy smoke test,
so each deploy contributes 4 requests per environment it touches.

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

**Requests by hostname over time.** The floor chart, and the one the heartbeat
exists to make meaningful. Hostname is the grouping dimension, so restrict the
set rather than letting it enumerate. All four hosts non-zero is the healthy
state; one dropping out is the `api-staging` DNS failure that motivated the
whole design.

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

Expect it to look empty. At ~636 requests a day across the two API hosts this
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

**Where auth requests spend their time** — **not answerable from production
traffic, and the reason matters more than the gap.** Every traced request today
is either a `401` from the heartbeat or a `404` from a scanner. Nobody
authenticates successfully, so no traced request reaches the code that costs
anything:

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

So the traces currently describe what the system does when it turns people away.
Answering this question needs a request that succeeds — either a real user, or a
heartbeat check that authenticates as a seeded account. That is a change to
`scripts/heartbeat.sh` and a decision about test credentials in production, not
a chart.

**Error rates by route rather than by worker** — answerable now, and already
demonstrated. Use the Visualizations query in the `404` note under "Read this
before trusting any chart": filter on `$workers.event.response.status`, group by
`$workers.event.path`. Any status works, not just `404`.

### One trap in the Traces tab

The list is titled **100 Slowest Traces** and means it. It is not a sample, so
averages taken from it are biased upward by construction. While the dataset is
smaller than 100 traces this does not matter — the slowest 100 of 60 is all of
them — but it will start lying quietly as volume grows.

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
