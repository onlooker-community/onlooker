# Runbook — mail authentication on onlooker.dev

**Created:** 2026-08-22
**Bead:** `onlooker-9qf`

Two independent services touch mail on this one domain, and they are easy to
conflate. **Resend sends. Cloudflare Email Routing receives.** They share the
domain and nothing else — different names, different DKIM selectors, different
bounce paths — and almost every mistake available here comes from assuming a
record belongs to the other one.

This file exists because the zone's state has already drifted once without
anyone noticing. `onlooker-9qf` was filed on 2026-08-16 after someone ran `dig`
by hand, DMARC was published the same day, and the bead's own notes were stale
within a week. Re-deriving this with `dig` every few months is how that happens.

## The records

| Name | Type | Belongs to | Purpose |
|---|---|---|---|
| `onlooker.dev` | MX | Email Routing | `route1/2/3.mx.cloudflare.net` — inbound mail |
| `onlooker.dev` | TXT | Email Routing | SPF — **decided 2026-08-22, confirm it is live** — see below |
| `_dmarc.onlooker.dev` | TXT | the domain | `v=DMARC1; p=none; rua=…@dmarc-reports.cloudflare.net` |
| `cf2024-1._domainkey.onlooker.dev` | TXT | Email Routing | DKIM for **forwarded** mail |
| `resend._domainkey.onlooker.dev` | TXT | Resend | DKIM for **sent** mail, signs `d=onlooker.dev` |
| `send.onlooker.dev` | TXT | Resend | `v=spf1 include:amazonses.com ~all` |
| `send.onlooker.dev` | MX | Resend | `feedback-smtp.us-east-1.amazonses.com` — bounces |

DKIM public keys are not reproduced here; they are long, and a copy in a
markdown file is a copy that can go stale against the live record. Fetch them
with the `dig` commands at the bottom.

`cf-bounce.onlooker.dev` is **empty, and should stay that way.** That subdomain
belongs to Cloudflare *Email Sending*, which this domain has not onboarded and
does not need — Resend does the sending. If records ever appear there, someone
has onboarded a second sending service, and the root SPF question below has to
be reopened.

## What actually carries DMARC

**DKIM alignment, not SPF.** This is the single most important thing on this
page, because it is what makes the whole arrangement safe to change.

The API sends as `Onlooker <noreply@onlooker.dev>` (`EMAIL_FROM`, identical in
all three environments in `apps/api/wrangler.toml`). That `From:` header is on
the **root** domain. Resend's envelope sender is on `send.onlooker.dev`, so SPF
is evaluated against `send.` and is *not* aligned with the root.

DMARC passes when **either** SPF or DKIM aligns. Resend signs with a root
selector — `resend._domainkey.onlooker.dev`, `d=onlooker.dev` — so DKIM aligns
with the `From:` domain and carries DMARC on its own.

Consequence: **nothing about the root SPF record can break password-reset
mail.** It is evaluated on a different name than the one Resend uses.

## The root SPF

**Decided 2026-08-22: publish it, as hygiene.**

```txt
Type:    TXT
Name:    @
Content: v=spf1 include:_spf.mx.cloudflare.net ~all
TTL:     Auto
```

Verify it landed with the `dig` at the bottom of this file. Before this
decision the root had **zero** TXT records of any kind, so there was nothing to
merge.

**A correction worth keeping, because the bead got it wrong and the wrong
version is the intuitive one.** `onlooker-9qf`'s notes said the uncovered case
was Email Routing's forwarding, and that Cloudflare puts SPF on the root "for
exactly that." Cloudflare's postmaster reference says forwarding rewrites the
envelope sender via the [Sender Rewriting Scheme][srs] to a Cloudflare-controlled
domain, specifically so SPF passes at the destination while relaying. The
forwarded envelope sender is therefore *not* `@onlooker.dev`, and the root SPF
is not what makes forwarding work.

Nor does tightening DMARC later affect forwarding: mail forwarded **to** an
onlooker.dev alias carries the *original* sender's `From:` domain, so this
domain's policy never evaluates it.

So the root SPF has no operational job on this zone. It was published anyway,
for two honest reasons:

1. It is what Email Routing's onboarding adds automatically. The MX records and
   the `cf2024-1` DKIM record are both present and the SPF record was not, which
   means it was removed or the onboarding applied partially. Restoring it puts
   the zone back in its documented shape.
2. It replaces `SPF: none` with an explicit soft-fail for anything forging an
   `@onlooker.dev` envelope, ahead of any future move to `p=quarantine`.

Do not upgrade this reasoning into "the root SPF protects our mail." It does
not. Resend and Routing both authenticate without it.

## Rules for changing any of this

**One `v=spf1` record per name, ever.** Two SPF records on the same name is not
"both apply" — it is a permanent error, and receivers may fail the check
outright. The root and `send.` each get exactly one. If something new ever sends
as the root, **merge** the include into the existing record; never add a second.

**Watch the ten-lookup ceiling when merging.** SPF allows 10 DNS lookups total
and blows past it silently. `_spf.mx.cloudflare.net` currently resolves to a
single flat record with no nested includes, so it costs exactly one:

```txt
v=spf1 ip4:104.30.0.0/19 ip6:2405:8100:c000::/38 ~all
```

**Never reuse a DKIM selector between services.** `resend._domainkey` is
Resend's and `cf2024-1._domainkey` is Cloudflare's. They coexist precisely
because the selector names differ. Overwriting one with the other's key silently
breaks signature verification for that service.

**`p=none` is a starting posture, not the destination.** The record reports
without enforcing, and Cloudflare collects the aggregate reports at the `rua`
address. Read a few weeks of them before moving to `p=quarantine`. Tightening a
domain whose sending has never been observed risks binning the password-reset
mail this whole flow exists to deliver — which is a locked-out user and a
support conversation, the most expensive place to be wrong.

**Do not add an Email Routing rule for the heartbeat addresses.** That is a
separate rule with its own reasoning; see the
[heartbeat account runbook](2026-08-17-heartbeat-account.md). A routable
heartbeat address would make reading a personal inbox sufficient to take the
account, because `/auth/forgot-password` is public and this repository is public.

## Verifying

```bash
dig +short MX  onlooker.dev                        # route1/2/3.mx.cloudflare.net
dig +short TXT onlooker.dev                        # root SPF
dig +short TXT _dmarc.onlooker.dev                 # p=none + rua
dig +short TXT cf2024-1._domainkey.onlooker.dev    # Routing DKIM
dig +short TXT resend._domainkey.onlooker.dev      # Resend DKIM
dig +short TXT send.onlooker.dev                   # Resend SPF
dig +short MX  send.onlooker.dev                   # Resend bounce path
dig +short TXT cf-bounce.onlooker.dev              # must stay EMPTY
dig +short TXT _spf.mx.cloudflare.net              # what the include costs
```

Check against a resolver you do not normally use — `dig @1.1.1.1` and
`dig @8.8.8.8` — when confirming a change has propagated. Cloudflare DNS
usually propagates in 5–15 minutes, but the documented ceiling is 24 hours.

[srs]: https://developers.cloudflare.com/email-service/reference/postmaster/
