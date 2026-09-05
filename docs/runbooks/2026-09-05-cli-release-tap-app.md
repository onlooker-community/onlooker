# Runbook — the GitHub App that pushes the Homebrew formula

**Created:** 2026-09-05
**Issue:** onlooker-33h

`release-cli.yml` now pushes the generated formula to
`onlooker-community/homebrew-tap` itself. It used to stop one step short:
generate `onlooker.rb`, upload it as a workflow artifact, and wait for a person
to commit it. Until they did, the GitHub release said the new version had
shipped and `brew upgrade` served the old one — two minutes for cli-v2.0.1,
thirty-two for cli-v2.1.0, bounded only by whether someone remembered.

| | |
|---|---|
| Workflow | `.github/workflows/release-cli.yml` |
| Generator | `scripts/write-formula.mjs` |
| Trigger | Pushing a `cli-v*` tag |
| Target | `onlooker-community/homebrew-tap`, `Formula/onlooker.rb` |
| Secrets | `TAP_APP_ID`, `TAP_APP_PRIVATE_KEY` |

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

### 2. Install it on the tap, and only the tap

From the App's **Install App** tab, install into `onlooker-community` with
**Only select repositories → homebrew-tap**. The workflow also asks for that
scope when it mints the token, so a wider installation is narrowed at mint
time — but the installation is the real boundary.

### 3. Store the credentials

In this repository's **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `TAP_APP_ID` | the numeric App ID from step 1 |
| `TAP_APP_PRIVATE_KEY` | the entire `.pem`, including the BEGIN and END lines |

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

If you would rather not grant that bypass, the alternative is to have the
workflow open a PR against the tap and auto-merge it — 0 approvals are
required, so it would merge. One trap there: that ruleset sets
`require_extra_approval_for_unattributed_changes: true`, so the commit must
carry the App's bot identity, or the merge waits for an approval nobody is
watching for. That is the same silent stall this work exists to remove, which
is why direct push is what shipped.

## Verifying it

Cut a release the usual way — bump `apps/cli/package.json`, tag `cli-vX.Y.Z`,
push the tag — and check that a commit lands on the tap authored by
`<app-slug>[bot]`. Then, on a machine with the tap already trusted:

```
brew update && brew upgrade onlooker && onlooker --help
```

## When it fails

The formula is uploaded as the `formula` workflow artifact **before** the push
is attempted, deliberately. Whatever goes wrong below, the artifact is there
and the old manual path still works: download it, commit it to the tap.

| Symptom | Cause |
|---|---|
| `protected branch hook declined` on push | Step 4 was skipped, or the App was added to the wrong ruleset |
| `Bad credentials` at the mint step | `TAP_APP_PRIVATE_KEY` is truncated or missing its BEGIN/END lines |
| `Resource not accessible by integration` | The App is not installed on `homebrew-tap`, or lacks Contents write |
| `cli-vX.Y.Z ships X.Y.Z, apps/cli/package.json says …` | The tag was pushed without the manifest bump. Fix the manifest, delete and re-push the tag |
| Job succeeds, log says `Tap already at X.Y.Z` | Not a failure. A re-run of an already-released tag regenerates a byte-identical formula and correctly pushes nothing |

## Still manual after this

Homebrew will not load a formula from a third-party tap until the user runs
`brew trust`, and that blocks upgrades of an existing install, not just first
installs. Nothing here can fix that — it happens on the user's machine. The
release notes now say so; `onlooker-284` covers saying it everywhere else.
