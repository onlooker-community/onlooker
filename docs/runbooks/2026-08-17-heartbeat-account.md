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

Because the address does not route, there is no reset flow. Two options:

1. **Change the password** via `POST /auth/change-password`, then update the
   secret. This needs the current password, so it is the rotation path, not the
   recovery one. Two things about it are not guessable and will cost you a
   detour: the endpoint requires an access token, so log in first and send
   `Authorization: Bearer <token>`; and its body is `{"current_password": ...,
   "new_password": ...}` in **snake_case**, alone in this API, where every
   neighboring endpoint uses `refreshToken` and `email`. camelCase returns
   `400 invalid_input`.

   Between changing the password and updating the secret, every heartbeat run
   fails `auth login -> 401`, and in production that fails the workflow and
   emails you. At a ~24 minute median cadence you will usually catch at least
   one. Expect it rather than being alarmed by it, and keep the gap short.

2. **Replace the account** — create a new one at a new address and update both
   secrets. This is the recovery path when the password is lost.

   You cannot delete the old one through the API in that case: `DELETE
   /auth/account` requires an access token, which requires a login, which
   requires the password you no longer have. Leave the orphan row. It owns
   nothing, its address does not route, and nothing can log into it. If you
   want it gone, remove it directly with `wrangler d1 execute` — see the
   database rebuild runbook for the shape of that.

**Neither of these has been rehearsed.** The creation steps above were wrong
twice on their first real use — bash syntax in a fish shell, and an unlabeled
live credential — and both were found by running them, not by reading them.
Treat everything in this section as unverified until someone has rotated the
staging account for practice.

## When the heartbeat fails on an authenticated check

The four authenticated checks are `auth login`, `auth me`, `auth logout` and
`auth revoked refresh`. What each failure means:

| Failing check | Most likely cause |
|---|---|
| `auth login` returning `401` | Password drift between the database and the secret. Rotate. |
| `auth login` returning `200 without token and refreshToken` | The login handler's response shape changed. A client-breaking change. |
| `auth me` returning `401` | `JWT_SECRET` changed, or `requireAuth` regressed. |
| `auth me` returning a different account | A serious `getUserById` or session-lookup bug. Treat as an incident. |
| `auth me` returning a different account, but nothing else is wrong | The `/auth/me` response shape changed — a renamed or moved `user.email`. The check cannot tell that from a genuinely wrong account, and a body that will not parse lands here too. Rule this out before escalating. |
| `auth logout` failing | Revocation is broken; sessions will not end. |
| `auth revoked refresh` returning `200` | Logout is not revoking. This exact regression has shipped once before. |
| The run failing with `authenticated checks are required but unavailable` | A secret was deleted or renamed. The guard is working. |
