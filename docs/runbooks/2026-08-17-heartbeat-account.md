# Runbook — the heartbeat account

**Created:** 2026-08-17
**Design:** [authenticated heartbeat](../superpowers/specs/2026-08-17-authenticated-heartbeat-design.md)

The heartbeat logs in on every run to prove the authenticated path works. This
is the account it logs in as.

| | Production | Staging |
|---|---|---|
| Address | `heartbeat@onlooker.dev` | `heartbeat-staging@onlooker.dev` |
| Password secret | `HEARTBEAT_PASSWORD_PRODUCTION` | `HEARTBEAT_PASSWORD_STAGING` |
| Address secret | `HEARTBEAT_EMAIL_PRODUCTION` | `HEARTBEAT_EMAIL_STAGING` |

## Rules

**It owns nothing.** No data anyone would miss, no elevated permission. It is
an ordinary user row that exists to be logged into.

**Its address does not route.** There is no Email Routing rule for either
address and there should not be one. Password reset is impossible by
construction rather than by policy, which matters because this repository is
public, `/auth/forgot-password` is public, and Email Routing forwards to a
personal inbox — a routable address would make reading that inbox sufficient to
take the account.

**It is permanently unverified, on purpose.** `email_verified` stays `null`
because nothing can confirm an address that accepts no mail. Nothing in the
login path reads that column today. If verification ever gates login, this
heartbeat will start failing — which is correct signal, because the same change
would lock out every unverified real user. Fix the product decision, not the
heartbeat.

**The address is a secret, not an Actions variable.** Not for obscurity — the
runbook names it — but because secrets are masked in logs and this repository's
logs are public.

## Creating one

Use the product's own signup endpoint so the password hash is produced by the
same code that will later verify it. No hand-written SQL, no hand-generated
bcrypt hash.

Generate a password:

```bash
openssl rand -base64 32
```

**Save it in your password manager before running anything else.** There is no
reset path — that is deliberate, and it is documented two sections down as a
security property. It is also a trap: an address that accepts no mail cannot
receive a reset link, and `change-password` needs the password you are trying to
recover. A password you did not save is gone, and the account it belongs to can
never be rotated or deleted again.

This is not hypothetical. Both accounts created on 2026-08-18 were created
without saving the password first, because this paragraph did not exist yet.
They still work — CI can read a secret a human cannot — but they are
permanently unrotatable. See "Current accounts" below.

Create the account (production shown; for staging use
`https://api-staging.onlooker.dev` and the staging address):

**fish** — the shell this repository's operator actually uses:

```fish
read -sx HEARTBEAT_PW    # paste the generated password, it will not echo
jq -n --arg email 'heartbeat@onlooker.dev' \
      '{email: $email, password: env.HEARTBEAT_PW, name: "Heartbeat"}' |
  curl -s -X POST https://api.onlooker.dev/auth/signup \
    -H 'Content-Type: application/json' --data @-
```

**bash or zsh**, if you are somewhere else:

```bash
read -rs HEARTBEAT_PW    # paste the generated password, it will not echo
export HEARTBEAT_PW
jq -n --arg email 'heartbeat@onlooker.dev' \
      '{email: $email, password: env.HEARTBEAT_PW, name: "Heartbeat"}' |
  curl -s -X POST https://api.onlooker.dev/auth/signup \
    -H 'Content-Type: application/json' --data @-
```

`read -sx` in fish is silent plus export in one flag. There is no `-r` because
fish does not mangle backslashes and so has nothing to disable — `read -rs`
fails outright with `unknown option`, which is how this was found.

The password goes to `jq` through the environment rather than `--arg`, for the
same reason `scripts/heartbeat.sh` does it that way: `/proc/PID/cmdline` is
world-readable on Linux and `/proc/PID/environ` is not. A runbook that tells you
to do the thing the code was fixed not to do is worse than no runbook.

Expect `201` with a `token` and `refreshToken` in the body. A `409` with
`user_exists` means the account is already there — do not create a second.

**Those two values are live credentials, and the `refreshToken` is good for 30
days.** Signup logs you in as a side effect. Do not paste that response into a
chat, an issue, a PR description, or anywhere else that gets stored or shared —
the password is the secret you are protecting, but a refresh token mints
sessions without it. If it does end up somewhere it should not, revoke it and
move on; there is no need to recreate the account:

```bash
curl -s -X POST https://api.onlooker.dev/auth/logout \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<the token>"}'
```

`{"success":true}` means it is dead. Nothing depends on that session — the
heartbeat logs in fresh on every run — so revoking costs nothing. The access
token beside it expires after `TOKEN_EXPIRY_MINUTES` (15) on its own.

Then set the secrets under **Settings → Secrets and variables → Actions**:
`HEARTBEAT_EMAIL_PRODUCTION`, `HEARTBEAT_PASSWORD_PRODUCTION`,
`HEARTBEAT_EMAIL_STAGING`, `HEARTBEAT_PASSWORD_STAGING`.

Finally, unset the shell variable so the password does not sit in the session:

```fish
set -e HEARTBEAT_PW    # fish;  bash and zsh: unset HEARTBEAT_PW
```

## Rotating one

**Rehearsed 2026-08-19 against staging.** The commands below are what actually
ran, not what the source suggested should work. Every one behaved as written.

Because the address does not route, there is no reset flow. Two options.

### 1. Change the password

The rotation path. Needs the current password, so it is not available for
recovery.

Two things are not guessable: the endpoint requires an access token, so you log
in first; and its body is **snake_case**, alone in this API, where every
neighboring endpoint uses `refreshToken` and `email`. camelCase returns
`400 invalid_input`.

Log in and capture the tokens without putting them in your scrollback:

```fish
read -sx HB_OLD
set LOGIN (jq -n --arg e 'heartbeat-staging-2@onlooker.dev' \
  '{email:$e,password:env.HB_OLD}' |
  curl -s -X POST https://api-staging.onlooker.dev/auth/login \
    -H 'Content-Type: application/json' --data @-)
set TOKEN (echo $LOGIN | jq -r .token)
set RT (echo $LOGIN | jq -r .refreshToken)
test -n "$TOKEN"; and echo "logged in, token captured"
```

Generate the new password and **save it before the next command** — see the
warning under "Creating one". Then:

```fish
read -sx HB_NEW
jq -n --arg rt "$RT" \
  '{current_password: env.HB_OLD, new_password: env.HB_NEW, refreshToken: $rt}' |
  curl -s -X POST https://api-staging.onlooker.dev/auth/change-password \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' --data @-
```

`{"success":true}`. Passing `$RT` spares this session; changing a password ends
the account's other sessions, and without it you would log yourself out
mid-rotation.

Then update the secret, which prompts rather than taking the value in argv:

```fish
gh secret set HEARTBEAT_PASSWORD_STAGING
set -e HB_OLD HB_NEW
```

**The window between those two steps is real, and this is what it looks like:**

```
  FAIL  auth login -> 401 (expected 200)
heartbeat: staging — 1 of 5 checks failed
##[warning] One or more staging checks did not return the expected status.
```

Two things to expect there. In production this fails the workflow and emails
you; in staging it warns and the run still passes. And the count says **1 of 5**
rather than 1 of 9 — when login fails, checks 6 to 9 never run and the
denominator shrinks with them. Nothing is broken; the named failure above it is
the whole message. Keep the gap short and it is at most one run.

### 2. Replace the account

The recovery path when the password is lost, and the only one.

Create a new account at a **new address** — the old one still holds its own, so
signup returns `409 user_exists` — and update both secrets.

You cannot delete the old account in that case. `DELETE /auth/account` requires
an access token, which requires a login, which requires the password you no
longer have. Leave the orphan row: it owns nothing, its address does not route,
and its password exists only inside a GitHub secret that is about to be
overwritten, after which nothing can ever log into it again. If you want it gone
anyway, remove it directly with `wrangler d1 execute` — see the database rebuild
runbook for the shape of that.

### Deleting an account you can still log into

**Rehearsed 2026-08-19** against a throwaway staging account, created and
deleted in one sitting. Signup returns an access token, so no separate login is
needed:

```fish
curl -s -X DELETE https://api-staging.onlooker.dev/auth/account \
  -H "Authorization: Bearer $TOKEN" -w '\n%{http_code}\n'
```

`{"success":true}` and `200`. **Then prove it deleted** by logging in again and
expecting `401`. That step is not ceremony: `handleLogout` once returned `200`
while revoking nothing, and shipped. An endpoint that reports success and leaves
the row is the same bug wearing a different hat, and nothing in the test suite
currently asserts otherwise.

## Current accounts

| Address | Environment | Password |
|---|---|---|
| `heartbeat-staging-2@onlooker.dev` | staging, live | known, rotated 2026-08-19 |
| `heartbeat@onlooker.dev` | production, live | **unknown** — exists only in `HEARTBEAT_PASSWORD_PRODUCTION` |
| `heartbeat-staging@onlooker.dev` | none — orphan | unknown, unreachable |

The two unknown ones were created 2026-08-18 without the password being saved
first, before this runbook warned to. They work, because CI can read a secret a
human cannot. They cannot be rotated or deleted, so when production next needs
rotating, option 2 is the only path. That is the cost of the missing sentence,
and it is why the warning under "Creating one" exists.

## When the heartbeat fails on an authenticated check

The five authenticated checks are `auth login`, `auth me`, `auth valid
refresh`, `auth logout` and `auth revoked refresh`. What each failure means:

| Failing check | Most likely cause |
|---|---|
| `auth login` returning `401` | Password drift between the database and the secret. Rotate. |
| `auth login` returning `200 without token and refreshToken` | The login handler's response shape changed. A client-breaking change. |
| `auth me` returning `401` | `JWT_SECRET` changed, or `requireAuth` regressed. |
| `auth me` returning a different account | A serious `getUserById` or session-lookup bug. Treat as an incident. |
| `auth me` returning a different account, but nothing else is wrong | The `/auth/me` response shape changed — a renamed or moved `user.email`. The check cannot tell that from a genuinely wrong account, and a body that will not parse lands here too. Rule this out before escalating. |
| `auth valid refresh` returning `401` | A session cannot be extended. Nothing else catches this: every other refresh assertion expects a rejection, so a broken token lookup satisfies them all while logging every real user out after 15 minutes. Treat as an incident. |
| `auth valid refresh` returning `200 without token and refreshToken` | The refresh response shape changed. The old token was consumed anyway, so one session row is orphaned until it expires — harmless, but it explains a row you cannot account for. |
| `auth logout` failing | Revocation is broken; sessions will not end. |
| `auth revoked refresh` returning `200` | Logout is not revoking. This exact regression has shipped once before. |
| The run failing with `authenticated checks are required but unavailable` | A secret was deleted or renamed. The guard is working. |
