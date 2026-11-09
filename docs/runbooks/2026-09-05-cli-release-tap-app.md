# Runbook — the GitHub App behind CLI releases

**Created:** 2026-09-05
**Issue:** onlooker-33h

Merging a version bump ships the CLI. Two workflows and one GitHub App get it
from `apps/cli/package.json` to `brew upgrade`, with no step in between that
waits for someone to remember.

It used to stop two steps short. Tagging was by hand, and `release-cli.yml`
generated `onlooker.rb` only to upload it as a workflow artifact for a person
to commit to the tap. Until they did, the GitHub release said the new version
had shipped and `brew upgrade` served the old one — two minutes for
cli-v2.0.1, thirty-two for cli-v2.1.0, bounded only by attention.

| | |
|---|---|
| Tagger | `.github/workflows/tag-cli.yml` — on a push to `main` touching `apps/cli/package.json` |
| Releaser | `.github/workflows/release-cli.yml` — on a `cli-v*` tag |
| Generator | `scripts/write-formula.mjs` |
| Ecosystem sync | `.github/workflows/ecosystem-sync.yml` — hourly; opens and updates the `bot/ecosystem-sync` pull request |
| Targets | this repository's `cli-v*` tags; `onlooker-community/homebrew-tap`, `Formula/onlooker.rb` |
| Credentials | variable `RELEASE_APP_CLIENT_ID`, secret `TAP_APP_PRIVATE_KEY` — all three workflows, same App |

## Why an App and not a PAT

`github.token` is scoped to this repository, so it cannot write to the tap. Of
the three credentials that can:

- A **fine-grained PAT** works with no other configuration, because it acts as
  you and you are an admin on the tap, which is a bypass actor on the ruleset
  below. It expires at 366 days and belongs to one person's account.
- A **deploy key** is not a bypass actor on that ruleset, so its push to `main`
  is rejected. It is out unless the ruleset is changed to admit it.
- A **GitHub App installation token** is minted per run and expires in an hour.
  The private key behind it has no expiry to forget, and the App belongs to the
  org, so it survives a person leaving.

The App is the choice. The cost is the one-time setup below, and the fact that
the App has to be added to a bypass list by hand.

## Setup

Steps 1–3 are done once. Nothing in this repository can do them.

### 1. Create the App

At **https://github.com/organizations/onlooker-community/settings/apps/new**:

- **Name:** anything; the workflow reads the slug from the token it mints, so
  it is not hardcoded. The slug becomes the commit author in the tap's history.
- **Homepage URL:** `https://onlooker.dev`
- **Webhook:** uncheck **Active**. Nothing listens.
- **Repository permissions:** **Contents → Read and write**. It is one of two;
  see the next bullet. `Metadata → Read-only` is added automatically and
  cannot be removed.
- **Pull requests → Read and write**, for the ecosystem sync (ONL-277). A pull
  request opened with GITHUB_TOKEN starts no workflows, so it could never
  report the "All checks passed" check the ruleset requires. Added 2026-11-08;
  an existing installation has to accept the new permission before the sync
  can open its PR.
- **Where can this App be installed?** Only on this account.

Note the **App ID** on the settings page, then **Generate a private key** and
keep the downloaded `.pem`.

### 2. Install it on the tap and on this repository

From the App's **Install App** tab, install into `onlooker-community` with
**Only select repositories**, and select **both** `homebrew-tap` and
`onlooker`. Each workflow narrows the scope again when it mints its token, so
the installation is the outer boundary and the mint call is the inner one.

Two repositories because the App does two jobs:

| Repository | Used by | For |
|---|---|---|
| `homebrew-tap` | `release-cli.yml` | committing the formula |
| `onlooker` | `tag-cli.yml` | pushing the `cli-v*` tag |
| `onlooker` | `ecosystem-sync.yml` | pushing `bot/ecosystem-sync` and opening its pull request |

The App's bypass on Require Pull Request is never exercised by the sync, which
pushes only to `bot/ecosystem-sync`.

`onlooker` is on that list only because **a tag pushed with the default
`GITHUB_TOKEN` does not start a workflow** — GitHub blocks that so a workflow
cannot trigger itself. Without the App, `tag-cli.yml` would push the tag and
`release-cli.yml` would wait forever for an event that never arrives.

### 3. Store the credentials

In this repository's **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
|---|---|---|
| Variable | `RELEASE_APP_CLIENT_ID` | the Client ID from the App's settings page (`Iv23…`), not the numeric App ID |
| Secret | `TAP_APP_PRIVATE_KEY` | the entire `.pem`, including the BEGIN and END lines |

The Client ID is a variable, not a secret, because it is not a credential:
`gh api /apps/onlooker-cli-release` returns it to anyone, and a variable shows
its value in the logs where a secret would print `***`. The workflows used
the numeric App ID through `app-id` until 2026-11-08 (ONL-64);
`create-github-app-token` deprecated that input in favor of `client-id`. The
key's name predates the App's later jobs; all three workflows read the same
pair.

```
gh variable set RELEASE_APP_CLIENT_ID --body "$(gh api /apps/onlooker-cli-release --jq .client_id)"
```

**Set the key from the file, never by pasting it.** The first live release
failed here: the key was stored through the browser and came back
undecodable, so the mint step threw `ERR_OSSL_UNSUPPORTED` after the GitHub
release had already published. Piping the file leaves no room for a newline to
be mangled:

```
gh secret set TAP_APP_PRIVATE_KEY < /path/to/your-key.pem
```

### 4. Let the App past the ruleset

This is the step that is easy to miss, and it fails at release time rather than
now. The tap's `main` inherits two **organization-level** rulesets:

- **Main Branch Base** (id `16781984`) — linear history, no deletion, no
  force-push. No bypass actors, and none are needed: the workflow adds one
  commit on top of `main`, which satisfies all three.
- **Require Pull Request** (id `16782009`) — 0 required approvals, squash and
  rebase only. Its bypass list holds exactly one entry: the **Admin**
  repository role. That is why hand-committed formula bumps land on `main`
  directly, and why the App cannot until it is listed too.

At **https://github.com/organizations/onlooker-community/settings/rules**, open
**Require Pull Request**, and add the App from step 1 to the **Bypass list**.
Editing an org ruleset needs org-owner access.

**Know what that grant covers.** The ruleset is organization-level, so adding
the App to its bypass list exempts it in *every* repository the ruleset
applies to, `onlooker` included — not just the tap. Confirmed by reading the
ruleset back from both repositories: each returns
`RepositoryRole/5, Integration/4841677`. Since step 2 installs the App here as
well, the App can in principle push straight to this repository's `main`,
which nothing in these workflows does or needs.

That is tolerable because anyone who can change a workflow here can already
merge to `main`, and secrets are not exposed to fork pull requests. If you
want it airtight, use a second App for tagging and leave it off every bypass
list — the two workflows are identical apart from which secret pair they read.

If you would rather not grant that bypass, the alternative is to have the
workflow open a PR against the tap and auto-merge it — 0 approvals are
required, so it would merge. One trap there: that ruleset sets
`require_extra_approval_for_unattributed_changes: true`, so the commit must
carry the App's bot identity, or the merge waits for an approval nobody is
watching for. That is the same silent stall this work exists to remove, which
is why direct push is what shipped.

## Cutting a release

There is one human decision left, and it is the version number:

1. Open a pull request that sets `apps/cli/package.json`'s `version`. Ideally
   the same pull request as the change that earns the bump.
2. Merge it. `tag-cli.yml` sees the manifest change, finds no `cli-v<version>`
   tag, and pushes one.
3. That tag starts `release-cli.yml`, which tests, builds, publishes the
   GitHub release, and commits the formula to the tap.

Nothing else is manual. To verify, watch for a tap commit authored by
`<app-slug>[bot]`, then on a machine with the tap already trusted:

```
brew update && brew upgrade onlooker && onlooker --help
```

## When it fails

The formula is uploaded as the `formula` workflow artifact **before** the push
is attempted, deliberately. Whatever goes wrong below, the artifact is there
and the old manual path still works: download it, commit it to the tap.

| Symptom | Cause |
|---|---|
| `error:1E08010C:DECODER routines::unsupported` at the mint step | `TAP_APP_PRIVATE_KEY` cannot be decoded. **This is the one that actually happened**, on cli-v2.2.0. Usually newlines mangled by pasting into the browser. Check the file itself with `node -e 'require("crypto").createPrivateKey(require("fs").readFileSync("key.pem"))'` — if that passes, the key is fine and only the secret is bad, so re-set it with `gh secret set … < key.pem`. If it fails too, convert with `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem` |
| `protected branch hook declined` on push | Step 4 was skipped, or the App was added to the wrong ruleset |
| `Bad credentials` at the mint step | `RELEASE_APP_CLIENT_ID` is wrong (the numeric App ID is not the Client ID), or the key belongs to a different App |
| `The 'client-id' (or deprecated 'app-id') input must be set to a non-empty string` at the mint step | The `RELEASE_APP_CLIENT_ID` variable is missing, or was created as a secret: the workflows read `vars.`, and a secret by that name reads as empty |
| `Resource not accessible by integration` | The App is not installed on the repository being written to, or the installation lacks the permission: Contents write for the tap and tag pushes, Pull requests write for the ecosystem sync's `createPullRequest`. Adding a permission in the App's settings is not enough; the org installation must also accept the request. Until it does, the App's settings list the permission while the installation still lacks it. Check what the installation actually holds with `gh api /orgs/onlooker-community/installations --jq '.installations[] \| select(.app_slug=="onlooker-cli-release") \| .permissions'`. This happened on 2026-11-08: the sync pushed `bot/ecosystem-sync` and then failed to open the PR |
| `cli-vX.Y.Z ships X.Y.Z, apps/cli/package.json says …` | The tag was pushed without the manifest bump. Fix the manifest, delete and re-push the tag |
| Job succeeds, log says `Tap already at X.Y.Z` | Not a failure. A re-run of an already-released tag regenerates a byte-identical formula and correctly pushes nothing |
| `tag-cli` pushed a tag but no release ran | The tag went up as `GITHUB_TOKEN`, and tags pushed by `GITHUB_TOKEN` never start a workflow. Check that `actions/checkout` still has `persist-credentials: false` — without it, checkout writes `GITHUB_TOKEN` into local git config as an Authorization header that beats the push URL's credentials, so the App token is minted and silently ignored. This happened on the first dispatch |

**Retrying is safe.** Every step that writes something checks first: the
release is created or updated in place, the tap push no-ops on an identical
formula, and `tag-cli` skips a version that already has a tag. That was not
true on the first live run — `gh release create` was unconditional, so the
cli-v2.2.0 failure could not be retried at all without deleting a public
release. Re-running an *old* run still replays the workflow file from that
run's commit, so after changing these files, re-cut the tag rather than
pressing re-run.

## Still manual after this

Homebrew will not load a formula from a third-party tap until the user runs
`brew trust`, and that blocks upgrades of an existing install, not just first
installs. Nothing here can fix that — it happens on the user's machine. The
release notes now say so; `onlooker-284` covers saying it everywhere else.
