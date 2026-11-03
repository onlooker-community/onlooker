# A Reserve of Reset Mail for Established Accounts — Design

Linear: ONL-229. This follows the mail pools
(`docs/superpowers/specs/2026-10-31-mail-pools-design.md`, ONL-228, #249).

**The day's 45 resets split into a reserve of 35 for established accounts and
an open share of 10 for everyone.** A burst of fresh free accounts can then
spend at most the open share, and a locked-out user with an established account
still gets their link.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-11-02.
Sections marked *(measured)* were read from this repository or production on
2026-11-02. Sections marked *(proposed)* are this document's own.

## The gap *(measured)*

The reset pool is one counter, `global:reset:<UTC date>`, refusing every reset
past 45 (`apps/api/src/db/mail-sends.ts`, `DAILY_MAIL_CEILINGS`). The daily
address cap of 6 stops one address from spending it, but not many.

Accounts are free, and signup sends no mail. `forgot-password` needs only a
registered address, so 8 throwaway accounts at 6 resets each spend the day's 45.
The zone's rule (6 requests per 10 seconds, per IP, per colo) slows that to a
few minutes from one IP. From then until UTC midnight every reset answers its
usual 200 and sends nothing. A locked-out user gets no mail and no error.

Production on 2026-11-02: 2 accounts, 1 with a verified address. Verifying is
optional, because nothing sends a link until the user asks for one, so a
reserve for verified addresses alone would treat half of today's real users
like an attacker.

## The policy *(approved)*

**Established** means the account has a verified address, or was created at
least 7 days ago.

- A verified address costs a real inbox and a verify send, and verify mail is
  capped at 10 a day.
- Age covers real users who never verified. A patient attacker can create
  accounts a week ahead, which takes planning, and each is still held to 6
  resets a day.

**The split:** 35 reserved, 10 open. The total stays 45, so the Resend budget
and the monthly arithmetic in `DAILY_MAIL_CEILINGS` don't change.

- An established account claims the reserve. When the reserve is spent, it
  claims the open share, so it is never worse off than under one pool.
- Any other account claims the open share only.
- The per-address caps (3 an hour, 6 a day) still come first and are unchanged.

Fresh accounts can spend at most 10 a day, about two addresses at the daily
cap. Spending the reserve needs 6 established accounts.

## The code *(proposed)*

- `claimMailSend(db, "reset", address, { established })`. The reset overload
  requires `established`, so leaving it out is a type error rather than a
  silent default.
- Two pools, `global:reset-reserved:<date>` and `global:reset-open:<date>`. New
  keys, so a deploy mid-day does not read the old 45-pool's count as either.
- `RESET_POOLS = { reserved: 35, open: 10 }`, beside `DAILY_MAIL_CEILINGS`, and a
  test that the two sum to `DAILY_MAIL_CEILINGS.reset`.
- A spill counts against both pools: the reserve's refused count, then the open
  share's. The reserve's count past 35 is what tells its alert it was the day's
  first.
- `isEstablished(user, now)` lives with the mail policy. `created_at` is
  SQLite's `CURRENT_TIMESTAMP`, `YYYY-MM-DD HH:MM:SS` in UTC with no zone, so it
  is parsed as UTC explicitly rather than handed to `new Date()`.
- `handleForgotPassword` decides `established` from the row `getUserByEmail`
  already returns. No new query.

## What the caller sees *(approved)*

Nothing new. Every path, including both refusals, answers the same 200, so the
route still cannot say whether an address has an account or which kind it is.

## Alerting *(approved)*

`reportMailRefusal` raises once per pool per UTC day, as it does today,
fingerprinted per pool:

- `reset-open` spent: probably someone farming accounts. Established users are
  unaffected.
- `reset-reserved` spent: established users are being refused. This is the one
  to act on.

When an established account spills and the open share is also spent, both
pools are full, and each alerts on its own first refusal.

## Tests *(proposed)*

- Fresh accounts spend the open 10, then are refused, while an established
  account still gets mail.
- Verified but new is established. Old but unverified is established. Six days
  old and unverified is not.
- `created_at` in SQLite's format is read as UTC.
- Once the reserve is spent, an established account draws from the open share,
  and is refused once both are.
- Each pool alerts once a day, with its own fingerprint.
- forgot-password answers the same 200 on every path.
- The pools sum to the reset ceiling.

## Out of scope

- Limiting signups per IP.
- Sending a verification link at signup, which would put the verify pool in the
  same position the reset pool is in now.
- Telling a refused user anything, which would turn the route into an oracle.
