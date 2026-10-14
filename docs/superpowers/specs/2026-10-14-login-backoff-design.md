# Failed-Login Backoff Per Account — Design

Bead: `onlooker-9s0m` (WS5), first slice. The bead's own framing is that
"failed-attempt escalation per account is the control that actually stops
credential stuffing; a flat per-IP ceiling just makes an attacker rotate
addresses. Nothing tracks failed attempts today."

**After four failed attempts against the same address, the fifth and each
after it are refused for a cooldown that doubles.** `handleLogin`
(`apps/api/src/routes/auth.ts:101`) currently has no gate of any kind: it reads
the user, runs bcrypt, and answers.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-10-14.
Sections marked *(measured)* were read from this repository on 2026-10-14 and
name the file and line, so a reader can check rather than trust. Sections
marked *(proposed)* are this document's own recommendations.

## What the API has today *(measured)*

**One zone rule, and it is the whole budget.** `apps/api/DEPLOYMENT.md:308-326`
states there is no `rateLimit` function in the codebase and no KV namespace for
one to use, and that a single Cloudflare rule at 60 req/min per client IP
covers `/api/public/lessons/` plus `/auth/login`, `/auth/signup`,
`/auth/forgot-password` and `/auth/reset-password` — "the plan allows a single
rule, and it is spent". `apps/web/src/utils/rateLimiting.ts` throttles the
browser only, so anything calling the API directly ignores it.

**The only binding is D1.** Every environment block in `apps/api/wrangler.toml`
declares `binding = "DB"` and nothing else of this kind — no KV namespace, no
Durable Object. So a counter lives in D1 or it does not exist.

**The worker already runs a cron.** `[env.staging.triggers]` and
`[env.production.triggers]` both declare `crons = ["*/5 * * * *"]`
(`wrangler.toml:144`, `:228`), and `runScheduled` (`apps/api/src/scheduled.ts`)
is its tested body. `ScheduledDeps` already carries
`pruneSessionSummaries: (db) => Promise<number>`, so periodic cleanup has a
shape to copy rather than invent.

**The error vocabulary exists.** `packages/types/errors.ts:17` has
`rate_limit_exceeded` and `:136` sets `statusCode = 429`.

**Login's uniform 401 is deliberate.** `auth.ts:113` and `:118` both throw
`ApiError(401, "invalid_credentials", "Invalid email or password")` — one for
an address with no account, one for a wrong password. The text is identical so
the response cannot be used to enumerate accounts.

**Bcrypt runs before anything could stop it.** `verifyPassword` is reached on
every attempt against an existing account, at cost 10 — roughly 100ms of worker
CPU per guess.

## Decisions *(approved)*

**D1. Escalating cooldown, not a lockout and not a flat cap.** Four failures
answer normally. The fifth and each subsequent failure set a cooldown of
1m, 2m, 4m, 8m, 16m, capped at 30m. A success clears the record.

A fixed lockout window lets an attacker park a victim's account in permanent
denial for the cost of five requests per window. A flat rolling cap leaves a
determined attacker a fixed budget of guesses forever at no increasing cost.
Escalation is the one that makes guessing cost time that compounds while a
legitimate user who mistypes twice is never delayed at all.

**D2. The gate runs before bcrypt.** Refusing after the hash would leave the
expensive half of the attack intact — roughly 100ms of CPU per guess, which is
a denial-of-service lever independent of whether any password is ever found.

**D3. Every submitted address is counted, keyed by hash.** The key is
`sha256(lower(trim(email)))`, written whether or not an account exists.

Counting only real accounts would make a 429 appear exclusively for addresses
that exist, handing back the enumeration oracle that login's uniform 401 was
written to deny. Hashing means the table is never a harvestable list of
attempted addresses, and a row for a typo is indistinguishable from a row for a
real account.

The cost accepted: distinct keys are unbounded, so expired rows must be pruned
(D5).

**D4. The counter decision lives inside the write.** One
`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, not a read followed by a
write.

This is the reasoning `db/orgs.ts` records for `removeMembership` and that
#198 and #200 both followed: two concurrent writers each read the old value,
neither sees the other, and both act on a stale count. For a counter that means
two simultaneous wrong guesses counting as one.

**D5. Pruning hooks into the existing cron.** A `pruneLoginAttempts(db)` added
to `ScheduledDeps` beside `pruneSessionSummaries`, deleting rows whose last
failure is older than the 30m cap.

No new infrastructure, no new trigger, and the function is injectable so the
scheduled path stays testable the way `onlooker-kipn.2` made it.

**D6. The control fails open.** If the counter read or write throws, the login
proceeds.

A D1 hiccup must not lock every account out of the product, and the zone rule
still caps 60 req/min per IP underneath. The cost, stated rather than
discovered: an attacker who can reliably break the counter also disables the
control. Failing closed trades a credible outage for a theoretical attack, and
this project has already weighed the same choice in the other direction and
said why: `middleware/cors.ts:62-66` fails *closed* on an unset `CORS_ORIGIN`
because that "makes it a visibly blocked front end rather than a silently open
API". The blast radius there is one misconfigured deploy noticed immediately.
Here it would be every sign-in on the product, so the same reasoning points the
other way.

**D7. Thresholds are constants in code, not `WorkerEnv` vars.** They are policy
rather than environment, tuning them needs a deploy either way, and every field
of `WorkerEnv` must also appear in `ENVIRONMENT_VARIABLES.md` or the source
guard fails CI — a cost with nothing bought.

## The table *(proposed)*

Migration 0015; 0014 is current.

```sql
CREATE TABLE login_attempts (
  key          TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL,
  locked_until TEXT,
  last_fail_at TEXT NOT NULL
);
CREATE INDEX login_attempts_last_fail ON login_attempts(last_fail_at);
```

`key` is the hex sha256 of the lowercased, trimmed address. `locked_until` is
NULL below the threshold and an ISO 8601 instant at or above it. The index
exists for D5's prune, which is the only query that does not go through the
primary key.

## The flow *(proposed)*

```
POST /auth/login
  |
  |-- read login_attempts by key           (one indexed point read)
  |     locked_until in the future? -> 429 + Retry-After, STOP
  |                                        (before bcrypt, per D2)
  |-- getUserByEmail
  |     no user?        -> record failure, then answer by what it returned
  |-- verifyPassword                        (the only bcrypt in the path)
  |     wrong password? -> record failure, then answer by what it returned
  |
  `-- success -> DELETE the row, issue tokens
```

Recording a failure is D4's single statement. **The answer to a failure is
decided by that statement's `RETURNING`, not by the read at entry:** if the
failure it just recorded set `locked_until` in the future, the response is the
429, otherwise it is the 401. So the fifth consecutive failure is itself
refused with 429 rather than answering 401 and refusing the sixth — which is
what the approved curve means by "fail 5 → 429", and it is the difference
between a cooldown that starts now and one that starts one attempt late.

The 401 path is byte-identical whether or not the account exists, and so is the
429 path.

## The curve *(proposed)*

`cooldownFor(fails)`, a pure function, which is where the policy is testable
without a database:

| fails | cooldown |
|---|---|
| 1–4 | none |
| 5 | 1m |
| 6 | 2m |
| 7 | 4m |
| 8 | 8m |
| 9 | 16m |
| 10+ | 30m (cap) |

## Response shape *(proposed)*

```
429 rate_limit_exceeded
Retry-After: <seconds>
{ "success": false,
  "error": { "code": "rate_limit_exceeded",
             "message": "Too many failed sign-in attempts. Try again shortly." } }
```

The message names no count, no address and no window length beyond the header,
because a refusal that reported "3 attempts remaining" would be telling an
attacker how to pace themselves.

## Tests *(proposed)*

- `cooldownFor` — each boundary in the table above, including the cap.
- the statement — two racing failures count as two (D4), which is the test that
  fails if anybody rewrites it as a read then a write.
- the route — four failures answer 401; the fifth answers 429 with
  `Retry-After`; a correct password inside the cooldown still answers 429
  (the cooldown is not a password check); a correct password after it succeeds.
- non-enumeration — an address with no account and an address with a wrong
  password produce byte-identical 401s, and byte-identical 429s at the
  threshold. This is D3's whole point and the one a later refactor is most
  likely to break by keying on `user_id` for convenience.
- success clears the record, so yesterday's four typos do not add to today's.
- `pruneLoginAttempts` — removes rows past the cap, leaves live ones.
- fail-open (D6) — a throwing `DB` lets the login through rather than 500ing.
- **ablation**: moving the gate after `verifyPassword` must fail a test that
  asserts no bcrypt runs while a cooldown is active.

### Gates

Four, per the lesson of PR #188: `pnpm --filter @onlooker/api test`,
`typecheck`, `lint`, and `bash scripts/source-guards.test.sh` — the last is
wired into no pnpm script, so no local sweep runs it unless named. Nothing here
touches lesson tables or adds a binding, so both guards it enforces should pass
unamended.

## Deferred, each to its own issue

- **The timing oracle in `handleLogin`.** An address with no account returns
  immediately; a wrong password spends ~100ms in bcrypt. The uniform 401 text
  hides what the clock reveals, so account existence is observable today
  without this change and remains so after it. The fix is small — verify
  against a fixed dummy hash when no user is found — but it is a different
  defect from this slice and gets its own bead rather than widening this one.
- **Per-account limits on everything else.** This slice covers the login path
  only. Signed-in work is still bounded by a per-IP counter, which is the wrong
  unit for it.
- **Mail-send throttling.** `handleForgotPassword` reaches `sendEmail` on an
  unauthenticated request, and a per-IP rule cannot cap how many mails one
  victim address receives from many addresses.
- **The IP dimension.** Keying on the address alone means a distributed attack
  against one account still trips that account's cooldown, which is the
  intended behavior here but also a denial-of-service lever against a single
  user. Whether a second key on (address, IP) is worth it is a question this
  slice does not answer.
