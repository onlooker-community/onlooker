# CLI project labels, opt-in

Linear: ONL-197. Approved 2026-11-15.

## Problem

ONL-189 lets someone name a project key on the web. Until they do, the feed
shows a 12-hex hash. The CLI could name most keys itself from the git remote,
but three tribunal rounds on ONL-189 kept finding defects in that path, so it
was deferred with seven problems any design must solve:

1. Each uploaded row must say whether it is remote-basis or root-basis, and a
   machine must not be able to label keys it never reported.
2. A root label must come from the repo root, not from the cwd a session
   started in.
3. The ecosystem's `project-key-cache.tsv` is not this repo's format, and it
   holds negative entries.
4. The CLI runs no git today, and recorded directories go stale.
5. Every remote URL form must lose its userinfo before upload, and the opt-in
   must name what is still disclosed.
6. Opting out must delete what was uploaded.
7. Remote rows are last-writer-wins across machines, so the derivation must be
   pinned.

## Decisions

- **Labels are `owner/repo`.** For a remote, the last two path segments with
  `.git` dropped. The host is never sent, so self-hosted hostnames are not
  disclosed. Private `owner/repo` names are, and `on` says so. A root-basis key
  is labeled with its repo root's folder name.
- **Opt-in is per machine,** by an explicit command, never a prompt, like crash
  reports. Off until `onlooker project-labels on`.
- **Opting out deletes what this machine wrote.** Each CLI row records the
  machine that last wrote it. Another opted-in machine re-asserts a shared
  repo's label on its next sync, which is accepted: that machine consents.
- **Verify, don't trust.** The CLI recomputes each key from git and uploads a
  label only when it matches the key the session reported. Drift between this
  derivation and the ecosystem's shell one, a deleted directory or a changed
  remote all mean no label, never a wrong one.
- **The event log, not the cache, is the source** (problem 3). Every
  `session.start` already carries `payload.working_directory` with the
  envelope's `project` and `project_basis`, and the CLI already reads that log.
  `project-key-cache.tsv` is never read.

## Part 1: the CLI

### Consent

- `cli.json` gains `projectLabels?: boolean` and
  `projectLabelsPending?: "delete"`. Absent `projectLabels` and `false` both
  mean off. Only a real boolean counts, as for `crashReports`.
- `onlooker project-labels on|off|status`; no argument means `status`.
  - `on` records the choice and prints what is sent (each remote's
    `owner/repo`, private repos included; each root repo's folder name) and
    what never is (host, port, credentials, full paths, branch names).
  - `off` writes `projectLabels: false` first, so the next sync uploads
    nothing even if what follows fails. Then it calls
    `DELETE /machine/project-labels`. On failure it sets
    `projectLabelsPending: "delete"` and says so; on success it clears it.
  - `status` shows on, off, or "off, deletion pending".
- `onlooker status` gains the same one line.

### Candidates

From the same 7-day window `reportSessions` uses: every `session.start` with a
`working_directory`, a 12-hex `project` and a `project_basis`. Grouped by
(key, basis); the newest start's directory is kept, and the older ones are
tried in turn if it fails verification.

### Verification (problems 1, 2, 4)

`apps/cli/src/project-key.ts` reimplements `onlooker_project_resolve` from the
ecosystem's `scripts/lib/onlooker-project-key.sh`:

1. Skip the directory if it no longer exists.
2. `git -C dir remote get-url origin`. Non-empty: key is the first 12 hex of
   `sha256("remote:" + url)`, with the URL exactly as git printed it, minus its
   trailing newline. Basis `remote`.
3. Otherwise, if inside a work tree: resolve `--git-common-dir` (relative to
   `dir` when relative), take its parent's real path, falling back to
   `--show-toplevel`. Key is `sha256("root:" + root)`. Basis `root`.
4. Otherwise no key.

A candidate yields a label only when the recomputed key and basis both equal
the session's. Git runs through `execFile` with no shell and a short timeout.
Git missing is one note, not an error per row.

Because the root comes from the common dir, a session started in a
subdirectory or a linked worktree is labeled with the main checkout's folder
name.

### Derivation, pinned as `derivation: 1` (problems 5, 7)

`apps/cli/src/project-label.ts`, a pure function from the verified URL or root
to a label or nothing.

- **Remote.** Parse every form git accepts, then keep only the path:
  - scp-like `[user@]host:path`
  - `ssh://`, `git+ssh://`, `ssh+git://`, `git://`, `http://`, `https://`,
    each with optional `user[:password]@` and `:port`
  - `file://` and local paths yield no label: the path is local disclosure and
    not a name.
  Then drop a trailing `/` and `.git`, and take the last two segments. Fewer
  than two segments yields no label. Percent-encoding is decoded only to check
  the result, which must not contain `@`, `:` or `/` beyond the one separator.
- **Root.** The basename of the verified root.
- Both pass the server's label rules locally (no control or invisible
  formatting characters, not empty, at most 200 bytes) so a refusal is not
  spent on a row the CLI could have dropped.

Changing any of this is a new `derivation` number, which the server must be
taught before any CLI sends it.

### Sync

`reportProjectLabels` runs after `reportSessions` succeeds. The server checks
each key against the session rows just sent.

- `projectLabelsPending: "delete"` first: retry the DELETE, clear the flag on
  success, and upload nothing either way.
- Off: nothing.
- On: verify, derive, `PUT` all labels in one request (a machine has tens of
  projects, not thousands).
- Non-fatal and never silent, like the other reports: for example "Project
  labels: 4 sent, 2 skipped (directory gone: 1, remote changed: 1)". Nothing is
  printed when on and nothing was skipped.

## Part 2: the API

### Migration

`project_labels` gains `written_by text NOT NULL DEFAULT ''`: the machine that
last wrote a `cli` row. User rows leave it `''`. Not part of the primary key:
one remote key has one CLI label, owned by whichever machine wrote it last.
`expected-schema.ts` is regenerated in the same change.

### `PUT /machine/project-labels`

Machine-token auth, like `/machine/sessions`. Body:

```json
{ "derivation": 1, "labels": [{ "project_key": "…", "basis": "remote", "label": "owner/repo" }] }
```

- `derivation` other than `1`: 400 `unsupported_derivation`, saying to update
  the CLI. This is the pin: two CLI versions can never alternate a key between
  two labels.
- `machine_id` is never read from the body. It is `''` for `remote` and the
  token's machine for `root` (problem 1).
- Each row must match a `session_projects` row for this user and this machine
  with the same key and basis. A row that does not is skipped and counted in
  the response, not stored.
- Labels go through the same `validLabel` as the user route, moved to a shared
  module.
- Upserts `source = 'cli'`, `written_by` = this machine. At most 500 rows.
- Response: `{ stored, skipped }`.

### `DELETE /machine/project-labels`

Deletes this user's `source = 'cli'` rows with `written_by` = this machine.
Idempotent; returns `{ deleted }`.

### Reading

`listProjectLabels` returns one label per (key, machine): the `user` row when
there is one, otherwise the `cli` row. Clearing a user label falls back to the
CLI's. Revoking a machine deletes the CLI labels it wrote last, because
revoking withdraws its consent and it can no longer run `off` (decided
2026-11-15). Its sessions stay. Another opted-in machine re-asserts a shared
repo's label on its next sync. `anonymizeUser` already deletes every row.

## Part 3: release and tests

### Order

1. API: migration, both routes, `listProjectLabels`, shared `validLabel`.
2. CLI: consent command, `project-key.ts`, `project-label.ts`, sync. The minor
   version bump goes in its own commit.

The API ships first, so a CLI that sends labels never meets a server without
the route.

### Tests, written first

- **Parser table:** every URL form above, with and without userinfo, password,
  port and `.git`. Asserts the label, and that no output contains the host,
  `@` or a port. Includes `file://`, a bare local path, one-segment paths and a
  percent-encoded `@`.
- **Key parity:** fixtures of (input, key) generated once by running the
  shell's `onlooker_project_resolve` on scripted repos, checked in with the
  command that made them. The TS derivation must reproduce each one.
- **Temp repos:** a remote repo, a no-remote repo, a subdirectory and a linked
  worktree (labeled with the main checkout's name), a deleted directory, and a
  remote changed after the session.
- **Verify ablation:** with the key comparison removed, the changed-remote
  test must fail.
- **API:** an unreported key is skipped; a root row lands on the token's
  machine whatever the body says; an unknown derivation is a 400; a user label
  wins and clearing it reveals the CLI label; DELETE removes only this
  machine's rows; user rows survive DELETE.
- **CLI consent:** `off` writes false before the request; a failed DELETE
  leaves the pending flag and the next sync retries it and uploads nothing.

## Done when

- With `on`, a sync names this machine's projects on the web as `owner/repo`
  or a folder name, and a user alias still wins.
- With `off`, this machine's CLI labels are gone from the web, or `status` says
  the deletion is pending.
- No uploaded label contains a host, port or credential.
