# Marketplace Contrast Arena — Design

Tracked by `onlooker-12s`, with `onlooker-12s.1` (declare, install, verify) and
`onlooker-12s.2` (recorder set).

Applies to `.claude/settings.json` only. No application code changes.

Companion to the ecosystem repo's rollout spec,
`onlooker-community/ecosystem:docs/superpowers/specs/2026-08-29-dogfooding-rollout-design.md`,
and to its tracking epic `ecosystem-449`.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-08-30 and are
decisions rather than proposals. Latency figures attributed to *this* repo were
measured on this machine on 2026-08-30. Figures attributed to the ecosystem repo
are cited from `ecosystem-449.11` and the `ecosystem-449` notes and were not
re-measured here.

## Boundary

**In scope:** enabling a fixed subset of the `onlooker-community` marketplace in
this repo through a committed `.claude/settings.json`, configuring inspector for
a TypeScript workspace, and routing the resulting findings to whichever repo
owns the fix.

**Out of scope:** any wave schedule of this repo's own, the gate plugins, the
`SessionStart` cohort, and any change to the plugins themselves. This repo is
where the stack gets *exercised*; ecosystem stays where it gets *fixed*.

---

## Why this repo, and not just more of ecosystem *(approved)*

Three things this arena produces that the ecosystem repo structurally cannot.

**A clean install path.** `ecosystem-449.10` is open, and its premise still
held when this was written: `installed_plugins.json` listed exactly one Onlooker
plugin, `ecosystem@onlooker-community`, project-scoped to the ecosystem repo.
The five plugins that repo's Wave 1 declared were never installed, so a full day
of soak measured nothing and its numbers were retracted.

That question — does `enabledPlugins` alone trigger installation? — was resolved
the same day, and the answer is no. It is recorded under *Correction* in the
staging section rather than here, because it changed the design rather than
motivating it.

What survives is narrower and still worth having. This repo has zero
`onlooker-community` entries for its `projectPath`, where ecosystem has carried
the substrate since 2026-08-09. So this is the first install either repo
performs with the mechanism understood instead of assumed, and the first
verification done against the registry rather than the cache.

**A different substrate.** Ecosystem is shell and markdown; its inspector
configuration is shellcheck, biome, and markdownlint. This repo is 175 `.ts`,
41 `.tsx`, 74 `.json`, 63 `.md`, 6 `.mjs`, and 7 `.sh` in a pnpm/turbo
workspace. Every assumption inspector makes about "run the check on the touched
file" meets a different reality here, and the result is the first finding below.

**Cross-repo signal.** The ecosystem spec names this as a deliberate deferral:
cross-project plugins "will show thinner signal confined to one repo — that is
an accepted cost of a tight blast radius, revisitable after Wave 4." Bursar
computes a rolling seven-day spend window. Computed from a single repo, that is
a number that cannot mean what it claims. This arena is the revisit, available
without waiting for Wave 4.

## The plugin set *(approved)*

| Plugin | Cadence | Why it is here |
|---|---|---|
| `ecosystem` | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse | Substrate. Required by all others. |
| `lineage` | PostToolUse | Change ledger; needed to correlate edits with inspector runs. |
| `inspector` | PostToolUse | The contrast. A TypeScript workspace is where its per-file model is tested. |
| `assayer` | Stop | Audits agent claims against recorded commands. Claims here are about builds, types, and tests rather than shell exit codes. |
| `bursar` | SessionStart, SessionEnd | The only member whose value is definitionally cross-repo. |

Nothing lands on `SessionStart` beyond the substrate and bursar, so the per-edit
and `Stop` numbers stay directly comparable to ecosystem's.

**Echo is excluded on evidence, not caution.** Its shipped default is
`watch_paths: ["plugins/*/agents/*.md"]`. This repo has no `plugins/` directory;
the only agent-adjacent file is `.agents/skills/beads/SKILL.md`. Echo would
register, cost its hook time, and match nothing, forever. That exclusion is
itself a finding — see below.

## Configuration *(approved)*

Committed `.claude/settings.json` rather than `settings.local.json`. Both repos
are public and have a single committer, so the argument that made ecosystem
commit its settings applies unchanged: there is no third party on whom the stack
would be imposed, and the configuration that produced a measurement should be
readable next to it.

The block is additive to the existing `typescript-architect@meaganewaller-marketplace`
entry and the existing `bd prime --hook-json` SessionStart hook.

```json
{
  "extraKnownMarketplaces": {
    "onlooker-community": {
      "source": { "source": "github", "repo": "onlooker-community/ecosystem" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": {
    "ecosystem@onlooker-community": true,
    "lineage@onlooker-community": true,
    "inspector@onlooker-community": true,
    "assayer@onlooker-community": true,
    "bursar@onlooker-community": true
  },
  "inspector": {
    "checks": {
      ".ts":   [{ "name": "biome", "kind": "lint", "argv": ["${repo_root}/node_modules/.bin/biome", "check", "${file}"] }],
      ".tsx":  [{ "name": "biome", "kind": "lint", "argv": ["${repo_root}/node_modules/.bin/biome", "check", "${file}"] }],
      ".json": [{ "name": "biome", "kind": "lint", "argv": ["${repo_root}/node_modules/.bin/biome", "check", "${file}"] }],
      ".mjs":  [{ "name": "biome", "kind": "lint", "argv": ["${repo_root}/node_modules/.bin/biome", "check", "${file}"] }]
    }
  }
}
```

Two details that are decisions rather than incidentals.

**Biome resolves through `${repo_root}/node_modules/.bin/biome`, not a bare
`biome`.** Hooks run under `sh`/`bash` without the interactive shell, and biome
is a devDependency here rather than a global. Ecosystem's own config uses a bare
`biome` for its JavaScript checks and the `${repo_root}` form only for
markdownlint; the bare form would be a silent skip here.

**`.md` gets no check.** This repo has no markdownlint and biome does not read
markdown. Sixty-three tracked `.md` files will emit `inspector.check.skipped`,
which is the honest outcome and a useful denominator when reading the event
stream.

### Why not typecheck *(approved)*

Inspector substitutes exactly three variables — `${file}`, `${file_relative}`,
and `${repo_root}` (`scripts/lib/inspector-run.sh:21`). There is no
package-root variable, so in a workspace the correct check cannot be expressed.
Measured here:

| Check | Cost | Correct? |
|---|---|---|
| `biome check ${file}` | 103 ms cold, 46–51 ms warm | yes |
| `tsc --noEmit ${file}` | 2.04 s | **no** — 8 spurious errors against a clean tree |
| `tsc --noEmit` scoped to `@onlooker/web` | 1.22 s | yes, but inexpressible |
| `turbo typecheck` from `${repo_root}` | ~1.2 s fully cached | yes, but whole-repo on every edit |

That 1.2 s is a floor, not a typical cost: turbo reported `FULL TURBO` with all
11 tasks cached, so almost all of it is pnpm and turbo process startup. The cache
is coldest precisely when a file has just changed, which is the only time the
hook fires.

The single-file arm ignores the package `tsconfig.json` entirely. Run against
`apps/web/src/App.tsx` it reported `Cannot find name 'ImportMetaEnv'` and four
`import.meta` module errors on code that `pnpm typecheck` passes clean. On a
`PostToolUse` hook that is a false-positive firehose into the agent's context on
every edit, and it costs two seconds to produce.

So this repo runs biome only, and the gap is filed against ecosystem rather than
worked around.

## Staging *(approved)*

Two steps, not four waves. A contrast arena has no need of its own wave
schedule; it needs to be certain the plugins are actually running — which, as
Step 0 records, is a stronger claim than it sounds.

### Step 0 — declare, install, verify (`onlooker-12s.1`)

**Revised 2026-08-30.** This step was written as a probe: land the settings and
see whether the substrate installs itself. That question is now answered, and
the answer invalidates the original design. See *Correction* below.

Three acts, in order, none of which is optional:

1. **Declare.** `extraKnownMarketplaces` for `onlooker-community`, and
   `enabledPlugins` for `ecosystem@onlooker-community` alone. This makes the
   marketplace resolvable and marks the plugin enabled. It does not install it.
2. **Install, explicitly.**

   ```bash
   claude-personal plugin install ecosystem@onlooker-community -s project
   ```

   Two traps in one line. The CLI defaults to `--scope user`, so project scope
   has to be asked for. And on this machine `claude` is not the binary — the
   interactive fish shell defines `claude` as an account picker
   (`~/.config/fish/conf.d/10-claude.fish`), where `claude-personal` resolves to
   `_claude_account "$HOME/.claude-personal"`. Running the bare binary would
   target a different config root, and the install would land in a registry this
   session never reads.
3. **Verify against the registry.** Read
   `~/.claude-personal/plugins/installed_plugins.json` and confirm an entry
   whose `projectPath` is this repo. Do not verify by checking the marketplace
   clone or the version directories under `plugins/cache/` — see below for why
   that reads as healthy when nothing is installed.

### Step 0 result, 2026-08-30

Done and verified. `ecosystem@onlooker-community` 0.45.3, `scope=project`,
`installedAt=2026-08-30T15:18:11Z`, `projectPath` this repo. Four hooks
confirmed live in `hook-health.jsonl` under the session id: `turn-tracker`,
`session-duration-tracker`, and `prompt-rule-injector` on `UserPromptSubmit`,
`tool-sequence-tracker` on `PreToolUse`, `tool-history-tracker` on
`PostToolUse`. The plugin's `bin` directory also appears on `PATH`.

**No restart was required.** `/reload-plugins` registered the hooks into the
running session. Both this spec and ecosystem's rollout assumed a restart, and
ecosystem's `449.11` went further, arguing against restarting as "the riskier
path" — which is part of what kept a stale session alive through Wave 1. A
reload is cheap and non-destructive, and it shortens the wave loop considerably.

**One limit on that.** A reload does not replay `SessionStart`. The substrate's
`session-start-tracker` and `memory-recall-tracker` did not fire, because the
session had already started. So `PostToolUse`, `PreToolUse`, `Stop`, and
`UserPromptSubmit` cadences can be picked up by reload, but anything measured at
`SessionStart` — bursar in Step 1, and the whole Wave 2 cohort in ecosystem —
still needs a fresh session.

### Correction: enabling is not installing

The original Step 0 assumed `enabledPlugins` in committed settings could install
a plugin, and both this spec and ecosystem's four-wave rollout were built on it.
It cannot. `enabledPlugins` marks a plugin enabled *only if it is already
installed*; nothing but `claude plugin install` writes the registry that governs
hook registration.

`autoUpdate` is what hides this. It keeps the plugin **cache** warm for every
enabled entry regardless of install state, so a plugin can have a freshly
fetched version directory while being absent from the registry entirely. The
cache reads as healthy. Only the registry tells the truth.

This is the same failure shape as `ecosystem-449.12` and the `config-loader.sh`
bug before it: nothing errors, nothing surfaces, and the only symptom is an
absence nobody notices. Ecosystem's Wave 1 committed its settings and measured
nothing for a day.

Recorded upstream in `onlooker-community/ecosystem#222`. A related trap from the
same commit: `claude plugin update` also defaults to `--scope user` and fails
outright against a project-scoped plugin.

**What this repo can still contribute.** Not the mechanism — that is settled.
But every measurement either rollout takes depends on the verification step
above actually being performed, and the arena is only worth running if the
plugins are demonstrably registered. The cold install here is the first one done
with the mechanism understood rather than assumed.

### Step 1 — the recorder set (`onlooker-12s.2`)

Only once step 0's registry check passes. Add lineage, inspector, assayer, and
bursar to `enabledPlugins` plus the `inspector.checks` block, then install each
one explicitly at project scope — enabling them in settings will not install
them any more than it installed the substrate. Then confirm all four appear in
`hook-health.jsonl` **before** trusting a single measurement.

`/reload-plugins` is enough to register lineage, inspector, and assayer, whose
cadences are `PostToolUse` and `Stop`. Bursar is not: it hooks `SessionStart`
and `SessionEnd`, so its measurement needs a fresh session either way.

### Step 1 finding: the recorders only see tool-shaped edits

Registration is not the same as observation. Lineage and inspector hook
`PostToolUse` matched on `Edit`, `Write`, and `MultiEdit`. They see a *tool
call*, not a change to the filesystem. An agent that edits through the shell —
a heredoc, `sed -i`, a short Python script — changes the same bytes and is
invisible to both.

Established by a two-arm test against the same file, minutes apart.

| Arm | How | Hooks fired | Total |
|---|---|---|---|
| A | `Edit` tool | sequence 37ms, history 155ms, **inspector 221ms**, **lineage 305ms** | **718 ms** |
| B | Bash append | sequence 37ms, history 139ms | 176 ms |

Arm B changed the same file and produced `tool.shell.exec`, not
`lineage.change.recorded`. Two numbers worth keeping from that table: 718 ms is
this repo's per-edit tax with the recorders on, comfortably inside the ~1 s
criterion; and 176 ms independently reproduces the 178 ms `ecosystem-449.11`
re-baseline, on a different repo and a different substrate.

The ledger makes the gap easier to see than the experiment does. Lineage's store
for this project holds 348 records: 108 `Write`, 240 `Edit`, and nothing from
any shell tool, ever. Over this session the event bus recorded 33
`tool.shell.exec` against 1 `tool.file.edit`, and lineage recorded exactly one
change — the one made through a tool.

So lineage's ledger has a hole shaped like whichever editing style the agent
happened to use, and `/lineage <file>:<line>` answers "no record" for a line
that was demonstrably written. That is worse than an obvious gap, because the
ledger cannot distinguish "not recorded" from "not changed".

This repo is unusually good at provoking it: the harness instruction in play
here prefers Bash wherever it can do the job, which routes almost all editing
away from the matcher. Ecosystem is unlikely to surface it at all, being where
the plugins are authored and where prompts do not push work toward the shell.

**Inspector's floor.** The 221 ms in Arm A bought a single
`inspector.check.skipped` with `reason: no_extension_match` — the `.md` file has
no configured check, so that is 221 ms to decide there was nothing to do. With
63 tracked `.md` files here, every markdown edit pays it. Ecosystem never sees
this because its config gives `.md` a markdownlint check.

That verification gate is the direct lesson from ecosystem's retracted Wave 1.
Five plugins were enabled in settings, never installed, and every number taken
during the soak had to be withdrawn. The failure was silent in exactly the way
`ecosystem-449.10` and `ecosystem-449.12` are silent: the hook exits 0, nothing
surfaces, and the only symptom is an absence nobody notices.

## Measurement

Three targeted reads against the 0.45.2 re-baseline recorded in
`ecosystem-449.11` — not a fresh baseline exercise of this repo's own.

1. **Per-edit round trip on a `.tsx` edit**, against ecosystem's 178 ms on shell
   files. Inspector adds ~103 ms of biome; lineage adds its own record write.
2. **`Stop` latency with assayer** auditing TypeScript and test claims, against
   the 353 ms it took to audit 7 claims over 92 shell commands in the ecosystem
   repo. Claims about `turbo test` and `tsc` have a different verification shape
   than claims about shell exit codes.
3. **Whether bursar's rolling seven-day figure shifts** once a second repo
   contributes to it.

No export step is required. `~/.onlooker` is a single global store keyed by
session, not partitioned by repo, so queries run from the ecosystem repo already
see this repo's events.

## Where findings go *(approved)*

Split by where the fix lands. Plugin bugs and latency findings become beads in
the ecosystem repo under `ecosystem-449`, because that is where the fix ships.
Onlooker-side configuration work stays in this repo's tracker.

Two findings are already evidenced and need no soak:

1. **Inspector has no `${package_root}` substitution**, so a workspace-scoped
   typecheck cannot be expressed. The only expressible form emits spurious
   errors on a clean tree, with the evidence above. Every monorepo consumer hits
   this.
2. **Echo's default `watch_paths` is marketplace-repo-shaped.** Any consumer
   without a `plugins/*/agents/*.md` layout installs a permanent silent no-op.

A third is a second confirmed instance rather than a new bug: `ecosystem-449.12`
(memory-recall-tracker encoding `github.com` where Claude Code writes
`github-com`) applies here too, since this repo is also under a `github.com`
path. Worth a note on that bead; not worth coupling a fix to this work.

## Deliberately out of scope *(approved)*

**The gates** — warden, compass, and governor at hard enforcement. Production
Cloudflare Workers deploys and D1 migrations run from this repo. Compass ships
`error_policy: "closed"` and gates every write-class tool call, so its own
errors block writes; a misfire during a migration is a categorically worse
outcome here than in a plugin repo, and it buys no signal that ecosystem cannot
produce. Gates stay in ecosystem's Wave 4.

**The `SessionStart` cohort** — historian, curator, scribe, librarian, counsel,
cartographer, archivist. Deferred until ecosystem's Wave 2 has actually run and
`ecosystem-449.2` has a retention policy. `~/.onlooker` is 824 MB of unsharded
flat directories today, several plugins scan their own session directories at
`SessionStart`, and a second active arena doubles the write rate into that
store. Historian is the one worth revisiting first, because cross-repo retrieval
is the capability neither repo can demonstrate alone — but running it here
before ecosystem soaks it would invert the cadence ordering that exists to keep
latency attributable.

**A wave schedule of this repo's own.** Rejected in conversation: it roughly
doubles the measurement work for signal that mostly duplicates `ecosystem-449`.
The contrast is the product, not a second corpus.

## Rollback

One commit to one file. `git revert` plus a session restart. No gates are
enabled at any point, so there is no state in which the settings file itself
becomes unwritable — the escape hatches ecosystem's spec documents for its
Wave 4 are not needed here.

## Open questions

The original open question — whether `enabledPlugins` alone installs — was
resolved on 2026-08-30 and is recorded under *Correction* above. It does not.

Nothing else is blocking. The remaining unknowns are the measurements themselves,
which is what the arena exists to produce.
