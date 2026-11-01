# Mail Pools Per Kind and an Inviter Cap — Design

Linear: ONL-228. This follows the mail cap
(`docs/superpowers/specs/2026-10-31-mail-cap-design.md`, ONL-222, #248).

**The day's 80 mails become three daily pools, one per kind of mail, and each
inviter may send 10 invites a day.** Invites can then never spend the mail that
password resets depend on, and no kind's refusal moves with another kind's
traffic.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-10-31.
Sections marked *(measured)* were read from this repository on 2026-10-31.
Sections marked *(proposed)* are this document's own.

## The two gaps *(measured)*

#248 shipped one global counter, `global:<UTC date>`, shared by every kind and
refusing all mail past 80 (`apps/api/src/db/mail-sends.ts`,
`DAILY_MAIL_CEILING`). The final review of that branch found two problems with
sharing it, filed as ONL-228:

1. **Invites can fill it.** Invites are capped at 3 per recipient a day, but not
   per inviter. Anyone can sign up and create an org, so about 27 fresh
   addresses × 3 invites spends the day's 80. Every password reset is then
   refused until UTC midnight.
2. **It is a weak cross-route oracle.** forgot-password raises the shared count
   only for registered addresses, and an invite or verify caller can see the
   count fill (a 429 until midnight). That is the kind of shared counter the
   mail-cap spec rejected for addresses, one level up.

**Accounts are free.** Inviting does not require a verified address
(`handleCreateInvite` checks only `requireOrgRole(…, "owner")`), and signup
sends no mail. So a cap per inviter alone cannot fix gap 1: at 10 a day, eight
throwaway accounts still drain 80. Only keeping invites away from reset mail
fixes it.

## Decisions *(approved)*

**Split the day's 80 into a pool per kind:**

| Kind | Per UTC day |
|---|---|
| `reset` | 45 |
| `verify` | 10 |
| `invite` | 25 |
| **total** | **80** |

Resets get the most because a locked-out user has no other way back in. A
verify mail goes to someone already signed in. 25 invites is about eight new
orgs a day at three invites each. The total is unchanged, so the headroom under
Resend's free tier (100 a day, 3,000 a month) is too.

**And cap each inviter at 10 invites per day.** Without it, one owner spends the
invite pool in 25 calls to about nine addresses (every invite spends a pool
slot) and nobody else can invite until midnight. With it,
that takes three accounts. It leaks nothing: the owner can already see their
own invites.

Rejected:

* **Reserving part of the shared 80 for reset and verify.** That closes gap 1
  but not gap 2, because invites would still read a count that reset traffic
  moves.
* **A per-inviter cap alone.** Accounts are free (see above).

**And cap reset and verify at 6 per address per 24 hours** *(approved
2026-11-01, at the final review)*. The reset pool is 45 and the hourly address
cap allows 72 a day, so one address could spend the pool over 15 hours, and
every reset after that would silently answer 200 until midnight. A fixed
24-hour window per kind and address bounds one address's share of a pool to 6.
Invites need no such cap: they are already 3 per address per 24 hours.

## The counters *(proposed)*

No new table and no migration. `mail_sends` already holds any key in a fixed
window.

| Key | Window | Limit |
|---|---|---|
| `<kind>:<sha256 of address>` | as today | as today (3/hour, 3/hour, 3/day) |
| `<kind>-day:<sha256 of address>` (reset, verify) | 24 hours, fixed | 6 |
| `inviter:<user id>` | 24 hours, fixed | 10 |
| `global:<kind>:<UTC date>` | the UTC day | 45 / 10 / 25 |

The user id is an opaque identifier, not an address, so it is stored as it is.
`DAILY_MAIL_CEILING` becomes `DAILY_MAIL_CEILINGS: Record<MailKind, number>`,
and a test pins that its values sum to 80. Raising one pool then visibly raises
the total.

## The claim *(proposed)*

`claimMailSend` keeps one entry point, so the source guard and the
claim-before-token-work rule stay as they are. Invite claims must carry the
inviter, and the type system enforces it:

```ts
claimMailSend(db, "invite", address, { inviterId, now? })
claimMailSend(db, "reset" | "verify", address, { now? })
```

The counters are claimed narrowest-first, and each refusal stops before the
next counter:

1. **inviter** (invite only). A capped owner spends no victim address's slots
   and no pool slot.
2. **address, hourly**, as today. A capped address spends only the inviter's
   own allowance.
3. **address, daily** (reset and verify only). An address refused in step 2
   spends no daily slot. A refusal here is `scope: "address"`, with
   `retryAfterMs` the end of that 24-hour window.
4. **the kind's pool.** A refusal answers `first: true` to exactly one request
   per pool per day: the one whose upsert returns the limit plus one.

So a refusal does not spend the counters after it, but it has spent the ones
before it: a refusal at an address has spent the inviter's own slot, and one at
the pool has spent the address's and the inviter's.

```ts
type MailClaim =
	| { ok: true }
	| { ok: false; scope: "address" | "inviter"; retryAfterMs: number }
	| { ok: false; scope: "global"; first: boolean; retryAfterMs: number };
```

A claim still counts even if the send then fails (unchanged).

## The responses *(proposed)*

* **forgot-password:** unchanged. It answers its usual `200` on any refusal and
  claims only for a real user.
* **resend-verification:** unchanged except that it reads the verify pool.
  `429 rate_limit_exceeded` with `Retry-After`.
* **invites:** `429 rate_limit_exceeded` with `Retry-After` at each of the three
  steps. The inviter step says "You have sent too many invites today. Try again
  later." with `Retry-After` set to the end of that inviter's window.
  `OrgsPage` already shows the server's message (`describeError`).

## Reporting *(proposed)*

* The log line names the scope (`mail_address_capped`, `mail_inviter_capped`,
  `mail_global_ceiling`) and the kind. It never names an address or a user id.
* Sentry raises an issue only on a pool's first refusal of the day, tagged
  `mail_kind`, so a full invite pool is told apart from a full reset pool. An
  inviter refusal does not page, for the reason an address refusal does not: it
  is the cap working.

## Rollout *(proposed)*

The new pool keys start at zero. On the deploy day, up to 80 more mails can go
out on top of what the old `global:<date>` row had already counted. On the free
tier that is harmless, because Resend itself refuses past 100. It is accepted
rather than carried over. The old rows are removed by the existing prune within
two days.

That can pass Resend's 100, though: a high old row plus the new counters can
push the day's sends past it, where a reset vanishes and an invite 500s. Before
deploying, read `SELECT key, count FROM mail_sends WHERE key LIKE 'global:%'`,
and if the count is high, deploy just after UTC midnight.

## Tests *(proposed)*

In the Workers pool, against D1:

* **Pools are separate.** With the invite pool spent, a reset to a fresh
  registered address still sends, and a verify still sends. This is the reason
  for the change.
* The pool limits are 45/10/25 and sum to 80. Each pool refuses its limit plus
  one, with `first: true` once and `false` after.
* **Inviter cap.** One owner's 11th invite of the day is refused with `429`,
  even to an address never invited before. A second owner is unaffected. A
  refusal at the inviter step writes no address row and no pool row.
* `claimMailSend` for an invite without `inviterId` does not compile, checked
  with a `@ts-expect-error` line that typecheck would flag if it stopped
  erroring.
* Reporting: one Sentry issue per pool per day, tagged with the kind. None for
  an inviter refusal.

The existing route tests (that a refused request leaves the old link working,
and that forgot-password answers byte-identically) and the source guard keep
passing unchanged in substance.

## Docs

* The `apps/api/DEPLOYMENT.md` mail paragraph gives the three pools and the
  inviter cap.
* The mail-cap spec's Deferred entry for ONL-228 points here.

## Still deferred

* Per-account limits on other signed-in routes (ONL-222's next slice).
* The forgot-password timing difference (measure first).
* Many free accounts can still spend the reset pool: 15 addresses x 3 in a
  burst. The zone's per-IP rule slows this but does not stop it. ONL-229.
* Requiring a verified address to invite, which would make accounts cost
  something. It is out of scope here and worth its own issue if invite abuse is
  ever seen.
