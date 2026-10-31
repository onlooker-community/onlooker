# Mail Cap Per Recipient — Design

Linear: ONL-222, first slice. The issue's framing: "`handleForgotPassword`
reaches `sendEmail` on an unauthenticated request. A per-IP cap doesn't limit
how many emails one victim address can be sent from many IPs, and it doesn't
protect the Resend quota or sending reputation."

**Each kind of mail gets a cap per recipient address, and all mail together
gets a daily ceiling under Resend's free-tier quota.** The cap is checked before
any token is touched, so a refused request leaves the link the recipient
already holds working.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-10-31.
Sections marked *(measured)* were read from this repository on 2026-10-31 and
name the file and line. Sections marked *(proposed)* are this document's own.

## What sends mail today *(measured)*

Three handlers call `sendEmail` (`apps/api/src/email/index.ts:60`), and only
three:

| Handler | Caller | Recipient |
|---|---|---|
| `handleForgotPassword` (`routes/account.ts:428`) | anyone, no credential | the account holder |
| `handleResendVerification` (`routes/account.ts:381`) | a signed-in user | their own address |
| `handleCreateInvite` (`routes/orgs-invites.ts:31`) | an org owner | any address typed |

**Signup sends no mail.** `scripts/cloudflare/ratelimit.json`'s `_comment` says
"`/auth/signup` creates an account and sends mail"; nothing under `handleSignup`
calls `sendEmail`. The path stays in the zone rule, since account creation is
worth metering anyway, and the comment is corrected here. `_comment` is
stripped before comparison, so the edit is not drift for ONL-180's check.

**The invite route is the one that mails strangers**, and the zone rule does not
cover `/api/orgs/:id/invites`. Its only limit today is that the caller must own
an org, and anyone can create one.

**Every sender retires the old credential before making the new one.**
`deleteVerificationTokens` runs at `account.ts:398` and `:444`, and
`deletePendingInvitesFor` at `orgs-invites.ts:71`, each before `sendEmail`. This
is the fact that decides where the cap goes (see *Where the check runs*).

**There is a pattern to copy.** `db/login-attempts.ts` keys a D1 table on a hash
of the address, counts with a single upsert, and is pruned by the five-minute
cron through `ScheduledDeps` (`src/scheduled.ts:23`).

**Resend's free tier allows 100 emails a day and 3,000 a month.** This is the
plan in use.

## Decisions *(approved)*

**Counters are per kind of mail, and each route answers in its own way.**

* `reset`: forgot-password answers its usual `200 { success: true }` when
  refused, and does nothing else. A different answer would tell the caller that
  the address had recently been sent mail, which means it has an account here.
  Hiding that is the whole design of `handleForgotPassword`.
* `verify`: resend-verification answers `429` with `Retry-After`. The caller is
  signed in and asking about their own address, so nothing leaks.
* `invite`: the invite route answers `429` with `Retry-After`. Because the
  counter holds only invites, a refusal says "this address has been invited
  too often lately" and nothing about accounts.

A single counter per address was rejected: with it, an inviter's `429` would
reveal password-reset traffic to that address.

**The limits:**

| Limit | Value |
|---|---|
| `reset` per address | 3 per hour |
| `verify` per address | 3 per hour |
| `invite` per address, across all orgs | 3 per day |
| all mail | 80 per UTC day |

80 a day leaves headroom under Resend's 100. 80 × 31 = 2,480, so it also keeps
under the 3,000 a month without a separate monthly counter.

**At the global ceiling every route behaves as at its own cap, and the ceiling
also raises a Sentry issue.** A per-address cap firing is the system working.
The global ceiling firing means legitimate mail is being refused for the rest
of the day, possibly because someone with many valid addresses is driving
forgot-password. Without the ceiling, that would first surface as Resend
refusing to send.

## Where the check runs *(proposed)*

**In each handler, before any token work, not inside `sendEmail`.** If
`sendEmail` refused the fourth reset, `deleteVerificationTokens` would already
have invalidated the link from the third, and the user would hold nothing
usable. That would turn the cap into a way to lock someone out of a reset.

Placing it in three call sites rather than one chokepoint risks a fourth sender
being added without a claim. A source guard covers that (see *Tests*).

## The table *(proposed)*

```
mail_sends
  key           text primary key   -- "reset:<sha256>", "invite:<sha256>", "global:2026-10-31"
  window_start  text not null      -- ISO timestamp
  count         integer not null
  index on window_start            -- for the prune
```

Migration `0018`. The address hash is `loginAttemptKey`'s normalization: trim,
lowercase, `hashToken`. It is reused rather than re-declared. No plaintext
address is stored, for the same reason `login_attempts` stores none.

**Fixed windows rather than sliding ones.** One row per key, one statement per
claim. A fixed hourly window allows up to 6 sends across a window boundary
rather than 3. That is acceptable for a cap whose job is to stop hundreds.

## The claim *(proposed)*

`claimMailSend(db, kind, address, now?)` in `apps/api/src/db/mail-sends.ts`,
which also holds the four limits as named constants.

1. Upsert the per-address row in **one statement**. If the stored window has
   ended, restart it at `now` with count 1, otherwise increment. `RETURNING
   count, window_start`. One statement, as `recordLoginFailure` does, so two
   concurrent requests cannot both read the old count.
2. If the count is over the kind's limit, answer
   `{ ok: false, scope: "address", retryAfterMs }`. The global row is not
   touched, so a bombed address cannot use up the day's ceiling.
3. Otherwise upsert `global:<UTC date>` the same way. If over 80, answer
   `{ ok: false, scope: "global", retryAfterMs }` (milliseconds to the next
   UTC midnight).
4. Otherwise `{ ok: true }`.

A claim counts even if the send then fails. That is conservative, and it means a
Resend outage cannot be retried into a burst.

## The handlers *(proposed)*

* **forgot-password:** claim only when `getUserByEmail` found a user. An
  unknown address sends no mail, so it has nothing to cap and should not grow
  the table. On refusal, return the normal `200`.
* **resend-verification, invites:** on refusal, throw `ApiError(429,
  "rate_limit_exceeded", …)` with `Retry-After` in whole seconds, rounded up.
  That is the code and header the login backoff already answers, so a client
  handles one shape. `ApiError` already carries headers, added for the login
  backoff.

## The web client must not wait out a long Retry-After *(measured, then proposed)*

`apps/web/src/api/client.ts` retries every `429` up to `maxRetries` (2) times,
sleeping for the full `Retry-After` before each retry, with no upper bound
(`resilientFetch`, `retryAfterMs`). A capped invite answers `Retry-After` of up
to a day, so the page would hang for that long. This is not new: the login
backoff already answers up to 1,800 seconds, so a locked-out sign-in through
this client hangs for up to 30 minutes.

**Fix:** when `Retry-After` exceeds `retryMaxDelayMs` (5 seconds by default),
return the `429` at once instead of retrying. A short `Retry-After` keeps
today's behavior. A server that says to wait an hour is not describing a
transient failure.
* **All three:** on a `global` refusal, call `monitor.captureException` before
  answering, and log `{ event: "mail_global_ceiling" }`.

## Pruning *(proposed)*

`pruneMailSends(db)` deletes rows whose `window_start` is more than two days
old. That is longer than the longest window, so no live counter is lost. It is
added to `ScheduledDeps` beside `pruneLoginAttempts`, with the same
`captureException` on failure.

## Tests *(proposed)*

In the Workers pool, against D1:

* `claimMailSend`: three claims succeed and the fourth is refused, with the
  right `retryAfterMs`. A new window restarts the count. Kinds don't share
  counters. The global ceiling refuses the 81st claim, and a per-address refusal
  does not use up a global slot. Addresses differing only in case or
  surrounding whitespace share a counter.
* **forgot-password:** a fourth request inside the hour answers `200` with the
  same body, and **the third request's reset link still verifies**. That second
  assertion is the reason for the claim's placement. An unknown address writes
  no `mail_sends` row.
* **resend-verification and invites:** the fourth request answers `429` with
  `Retry-After`, and the previous link or invite still works.
* **Global ceiling:** a refusal raises an issue through `monitor`, checked the
  way `scheduled.test.ts` checks `captureException`.
* **Prune:** removes old rows and keeps current ones.

In `scripts/source-guards.test.sh`, because `vi.mock` does not apply in the
Workers pool:

* Every file calling `sendEmail(` also calls `claimMailSend(`, and in each
  handler the claim appears before the token deletion. The guard is paired with
  a positive check that it found three call sites, and ablated: removing one
  claim must fail it.

## Ride-alongs

* **Delete `apps/web/src/utils/rateLimiting.ts` and its test.** The issue
  suggested renaming it so it isn't mistaken for server-side limiting. It turns
  out nothing imports it, so a rename would preserve dead code.
* Correct the signup line in `ratelimit.json`'s `_comment`.

## Deferred, each to its own issue

* **Per-account limits on other signed-in routes.** This is ONL-222's next
  slice and needs measurement first.
* **A possible timing difference in forgot-password** between registered and
  unregistered addresses. It predates this design: a known address already does
  a delete, a create and a send that an unknown one skips, and the claim adds
  one more write. #205 fixed the
  equivalent leak in login. Measure it, then file it if real.
