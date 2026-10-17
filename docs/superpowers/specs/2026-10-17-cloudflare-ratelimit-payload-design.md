# The Rate Limiting Rule As A Committed Payload — Design

| Linear | What |
| --- | --- |
| [ONL-140](https://linear.app/onlooker/issue/ONL-140) | `GET /api/orgs/invites/verify` sits outside the only rate limit rule — the trigger for this work |
| [ONL-171](https://linear.app/onlooker/issue/ONL-171) | The documented rule does not exist; four `/auth/*` paths are unprotected — found while doing it |
| `onlooker-9s0m` | WS5. Names this script: "a `scripts/cloudflare/apply.sh` doing the same for zone rules would make its absence detectable" |

**The zone's one rate limiting rule becomes a committed payload, applied by a
script, covering the five unauthenticated paths the project intends to meter
rather than the one it currently does.**

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-10-17.
Sections marked *(measured)* were read from this repository or from the live
Cloudflare zone on 2026-10-17 and name their source, so a reader can check
rather than trust. Sections marked *(proposed)* are this document's own
recommendations.

Every number in here about the live zone was read from the API. That is not a
style note: this whole piece of work exists because the last description of
this rule was written without doing that.

## The live rule *(measured)*

`GET /zones/{zone}/rulesets/phases/http_ratelimit/entrypoint`, ruleset
`146be8e1fc824ed1907e49712474a6c6`, `last_updated` 2026-09-28. One rule:

```json
{
  "description": "public lesson reads",
  "expression": "(http.host eq \"api.onlooker.dev\" and starts_with(http.request.uri.path, \"/api/public/lessons/\"))",
  "action": "block",
  "enabled": true,
  "ratelimit": {
    "characteristics": ["ip.src", "cf.colo.id"],
    "period": 10,
    "requests_per_period": 6,
    "mitigation_timeout": 10
  }
}
```

`apps/api/DEPLOYMENT.md` described five path clauses, 60 requests per minute,
"per client IP", and a one-minute mitigation. Every one of those four is wrong.
ONL-171 holds the gap and its consequences; this document is the structural
fix.

Also measured: the zone has no `http_request_firewall_custom` ruleset, so no
custom WAF rule covers these paths either. Only Cloudflare-managed rulesets
(Normalization, Managed Free, DDoS L7) sit alongside the rate limiting one.

## What exists to copy *(measured)*

`scripts/sentry/apply.sh` is the same shape of problem already solved in this
repo — a production control that lives in a vendor's dashboard, where a
hand-click is "undiffable, unreviewable, and gone the moment somebody tidies it
away". Conventions worth taking verbatim:

* **`_comment` arrays in the payload** carry the rationale (`rules/api-faults.json`).
* **Server-assigned ids are never written to the file** — they mean nothing to a
  reviewer and break when the object is recreated.
* **`--dry-run` needs no token**, and the tests prove it makes no request by
  pointing the API base at a closed port (`apply.test.sh:136`).
* **Three-way exit codes**: `0` done, `1` the vendor rejected it or a file is
  malformed, `2` the script could not do its job at all.
* **The token is never printed and never an argv element** — read from the
  environment into a curl config on stdin, so it stays out of `ps`, shell
  history, and transcripts.
* **REFUSED rather than choosing** wherever the script cannot tell two
  situations apart.
* **CI runs the tests, never the apply** (`deploy.yml:137`). `apply.sh` is
  human-run with a token.

## Decisions *(approved)*

### D1. The payload is canonical; the document references it

`scripts/cloudflare/ratelimit.json` holds the expression and the limits.
`apps/api/DEPLOYMENT.md` keeps every word of rationale — why these paths, what
the rule is holding, why `/auth/refresh` is deliberately excluded — and stops
restating the expression.

This deliberately retires an invariant that file states: "this is the only
place the expression is written down — deliberately, so the two cannot drift."
The intent was right and the mechanism failed, because a document cannot be
applied. The payload is what gets sent to Cloudflare, so it is the artifact
that cannot be wrong, and one copy still exists — it has just moved.

Rejected: **generating the payload from the Markdown**, which honors the
invariant most literally and would make production rate limiting the output of
a Markdown parser. Rejected: **both, with a source guard asserting they
match** — a 38th guard doing an exact-string match that fails on a line wrap.

### D2. Keep the live limits; widen only the expression

The payload starts as the live rule, captured from the zone, with its limits
untouched: `period` 10, `requests_per_period` 6, `mitigation_timeout` 10,
`characteristics` `["ip.src", "cf.colo.id"]`. Only the expression changes:

```
(http.host eq "api.onlooker.dev" and (
  starts_with(http.request.uri.path, "/api/public/lessons/")
  or http.request.uri.path in {"/auth/login" "/auth/signup" "/auth/forgot-password"
                               "/auth/reset-password" "/api/orgs/invites/verify"}
))
```

So the apply is **purely additive protection**: nothing that is metered today
changes, and four paths that reach `sendEmail`, bcrypt, or account creation
with no credential start being metered.

Rejected: **applying the documented 60/minute**, which would make reality match
the written claim and in doing so *loosen* the only limit that actually exists,
from 6-per-10s to 60-per-60s on the lessons path. A fix that weakens the one
working control to match a sentence is the wrong direction.

Rejected for now: **different rates for `/auth/*` than for the public read**,
which is what the two surfaces actually want. The plan allows exactly one rule,
so this needs either a second rule or the in-worker limiting that
`onlooker-9s0m` still tracks as unbuilt.

The path goes in the existing `in {...}` set rather than as the extra disjunct
ONL-140 sketches — identical semantics, one clause fewer.

**A risk worth stating rather than discovering.** 6 requests per 10 seconds is
tight for `/auth/login` behind a shared NAT: an office where thirty people sign
in within the same ten seconds can trip it. Two things make it tolerable, and
both are properties of the live rule rather than choices made here — the
mitigation timeout is 10 seconds, so a tripped limit clears almost immediately
rather than blocking for a minute, and `cf.colo.id` in the characteristics
means the counter is per-datacenter, so the practical ceiling is higher than
the number suggests. If it does bite, loosening `requests_per_period` is a
one-line diff in a reviewed file, which is the entire point of this work.

### D3. Two refusals, because a PUT is a replace

Updating the phase sets its rules to exactly what is sent. Cloudflare documents
the hazard on the sibling cache phase: "using these examples directly will
cause any existing rules to be deleted." So:

* **More than one live rule → REFUSE**, naming them. The plan allows one; a
  second one means somebody added it, and applying would delete it.
* **A live rule carrying a field the payload does not describe → REFUSE.** The
  direct analog of the Sentry script refusing a workflow "listening to anything
  this file does not describe". It stops an apply from silently dropping a
  counting expression, a `requests_to_origin`, or a `score_response_header_name`
  somebody set in the dashboard.

  **The server-assigned set is exempt, and naming it is load-bearing.** The live
  rule always carries `id`, `version`, `last_updated` and `ref` — and the
  payload deliberately never does (D4). Compared literally, "a field the payload
  does not describe" is true on every run and the script would refuse
  universally. So the comparison ignores exactly those four and refuses on any
  other addition. The exemption list lives in one named constant, because a
  future Cloudflare field added to that set would otherwise look like dashboard
  drift and block every apply.

The cost is real and accepted: `apply.sh` stops working the moment the rule is
edited in the dashboard, and the recovery is `--capture` then review the diff.
That is the intended pressure — it makes the dashboard the exceptional path.

### D4. `--capture` is how the payload is born

The first committed payload is read from the zone, not typed from a document.
`--capture` GETs the entry point, strips the server-assigned four — `id`,
`version`, `last_updated` and `ref` — and writes the rule to the payload file
preserving its `_comment` block. `ref` is strippable because Cloudflare
defaults it to the rule id, which the live rule confirms: both read
`89ff444ed38940b9a568554e1c631a20`. It is the same list D3's comparison
ignores, and the same named constant.

This is not a convenience. The reason this work exists is that the last
description of this rule was written without reading it, so a bootstrap that
*cannot* be authored by hand is the design answering its own history.

### D5. CI runs the tests; a human runs the apply

`apply.test.sh` joins `deploy.yml`'s lint job beside the Sentry suites. It
needs no token and makes no network request. `apply.sh` itself is never run by
CI, matching `scripts/sentry/apply.sh` exactly.

Consequence stated plainly: **nothing watches the live zone.** CI will verify
the payload is well formed and `apply.sh --dry-run` will report drift on
demand, but no scheduled job holds a token, so a rule deleted in the dashboard
still produces no failing check. That is strictly better than today, where the
written description was wrong for weeks and nothing could have noticed, and it
is not the same as monitored. Out of scope here; see below.

## Files *(proposed)*

```
scripts/cloudflare/
  ratelimit.json      the one rule, canonical, with a _comment block
  apply.sh            --capture / --dry-run / apply
  apply.test.sh       offline suite, no token
  testdata/*.py       fixture servers, as scripts/sentry/testdata/ does
```

`ratelimit.json` holds the rule object's own fields plus `_comment`. `apply.sh`
deletes `_comment`, wraps the rest in `{"rules": [ ... ]}`, and PUTs that —
Cloudflare rejects unknown fields, so the strip is load-bearing and gets its
own test.

### `apply.sh` contract

| | |
| --- | --- |
| `--capture` | GET the entry point, strip server-assigned fields, write the payload file |
| `--dry-run` | validate the file and print the exact body it would PUT; no token, no network |
| *(default)* | GET, refuse or report the change, PUT only if different; exit 0 without a PUT if already matching |

`--dry-run` prints the body it would send, **not** a diff against the live rule.
A diff needs the live rule, which needs the network and a token by definition,
so a "no network" dry run cannot produce one — an earlier draft of this
document asked for both and was incoherent. The live comparison is the default
mode's own output, printed before it applies anything.

Environment: `CLOUDFLARE_API_TOKEN` (required unless `--dry-run`; needs Zone →
Zone WAF → Edit), `CLOUDFLARE_ZONE_ID` (required), `CLOUDFLARE_API_BASE`
(overridable so the tests can point at a fixture server, the reason
`SENTRY_API_BASE` is overridable).

The zone id stays an environment variable rather than a committed constant.
It is not a secret, but this repository is public and already carries a source
guard keeping ids out of committed config; a wrong zone id would also apply
this rule to the wrong zone.

Exit codes: `0` applied, already matching, or a well-formed `--dry-run`; `1`
Cloudflare rejected it, the payload is malformed, or a refusal fired; `2` the
script could not run at all — no token, no zone id, no `curl`, no `jq`.

## Testing *(proposed)*

Offline and fixture-driven, no token, mirroring `scripts/sentry/apply.test.sh`:

* the payload is valid JSON, carries every required field, and its action is `block`
* `--dry-run` exits 0 with no token and makes no request — proven by pointing
  `CLOUDFLARE_API_BASE` at a closed port, which would fail the run if anything
  reached for the network
* `--dry-run` prints a body that is valid JSON and carries no `_comment`
* a missing token exits `2`, not `1`; a missing zone id exits `2`
* a fixture returning **two** rules refuses, exit `1`
* a fixture returning a rule with an undescribed field refuses, exit `1` — the
  fixture adds a meaningful one (`ratelimit.requests_to_origin`), not a
  server-assigned one, and a sibling case proves the server-assigned four alone
  do **not** trigger it
* a fixture returning the identical rule issues **no PUT** — the fixture records
  the requests it receives, so this is asserted rather than assumed
* a Cloudflare 4xx exits `1`
* the PUT body carries no `_comment`
* the token value appears nowhere in the output of any path

## What changes in `apps/api/DEPLOYMENT.md` *(proposed)*

* The expression block goes; a pointer to `scripts/cloudflare/ratelimit.json`
  replaces it.
* The real limits are stated: 6 requests per 10 seconds, counted per IP **per
  datacenter**, 10-second mitigation. The current text's "60 requests per
  minute per client IP" is wrong three ways.
* `/api/orgs/invites/verify` joins the "why those paths" list, with its reason:
  an unmetered D1 read on a route that takes no credential, the same concern
  that put `/api/public/lessons/` in the rule.
* "Nothing in CI can verify any of this" becomes accurate rather than absolute —
  the payload is reviewed and drift is detectable on demand; the live zone is
  still unwatched.
* **A correction notice.** PR #209 landed 2026-10-17 saying "everything else
  rests on ONE Cloudflare zone rule" and that the zone rule "caps requests per
  IP" for `/auth/forgot-password`. Both are false and this work wrote them, an
  hour before measuring. The rewritten section says so rather than quietly
  replacing the sentence, because a reader who believed it deserves to know it
  was corrected. `apps/api/src/index.ts`'s header gets the same treatment.

## Not in scope

* **A scheduled drift check against the live zone.** It needs a token in CI and
  a schedule, and it is the thing that would make deletion detectable rather
  than merely diffable. Worth its own Linear issue; D5 records why today's
  answer is partial.
* **In-worker limiting for `/auth/*`**, per-account limits beyond login, and
  mail-send throttling. `onlooker-9s0m` owns these.
* **The legacy `rate_limits` endpoint.** The token used answered
  `Authentication error` for it, so pre-ruleset legacy rules were not checked.
  Recorded in ONL-171 rather than resolved here.
* **Loosening or splitting the limits.** D2 keeps the live numbers; changing
  them is a reviewed one-line diff once this exists.

## Verification

```bash
bash scripts/cloudflare/apply.test.sh
bash scripts/source-guards.test.sh
```

Then, with the token: `scripts/cloudflare/apply.sh --dry-run` to show the diff,
`apply.sh` to apply it, and a re-read of the entry point to confirm the live
rule matches the payload.

## Shape

One PR. The payload, the script, its tests, the CI line, and the documentation
correction are one change — a payload without the script is a file nothing
applies, and the script without the corrected document leaves the false claim
standing.
