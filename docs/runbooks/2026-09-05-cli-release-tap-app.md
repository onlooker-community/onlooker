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
| Targets | this repository's `cli-v*` tags; `onlooker-community/homebrew-tap`, `Formula/onlooker.rb` |
| Secrets | `TAP_APP_ID`, `TAP_APP_PRIVATE_KEY` — both workflows, same App |

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
- **Repository permissions:** **Contents → Read and write**. That is the only
  one. `Metadata → Read-only` is added automatically and cannot be removed.
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

`onlooker` is on that list only because **a tag pushed with the default
`GITHUB_TOKEN` does not start a workflow** — GitHub blocks that so a workflow
cannot trigger itself. Without the App, `tag-cli.yml` would push the tag and
`release-cli.yml` would wait forever for an event that never arrives.

### 3. Store the credentials

In this repository's **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `TAP_APP_ID` | the numeric App ID from step 1 |
| `TAP_APP_PRIVATE_KEY` | the entire `.pem`, including the BEGIN and END lines |

The names predate the App's second job; both workflows read the same pair.

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
| `Bad credentials` at the mint step | `TAP_APP_ID` is wrong, or the key belongs to a different App |
| `Resource not accessible by integration` | The App is not installed on the repository being written to, or lacks Contents write |
| `cli-vX.Y.Z ships X.Y.Z, apps/cli/package.json says …` | The tag was pushed without the manifest bump. Fix the manifest, delete and re-push the tag |
| Job succeeds, log says `Tap already at X.Y.Z` | Not a failure. A re-run of an already-released tag regenerates a byte-identical formula and correctly pushes nothing |
| `tag-cli` pushed a tag but no release ran | The tag was pushed with `GITHUB_TOKEN` rather than the App token. Tags pushed by `GITHUB_TOKEN` never start a workflow |

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
