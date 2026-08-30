# Marketplace Contrast Arena — Design

Tracked by `onlooker-12s`, with `onlooker-12s.1` (install probe) and
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
holds: `installed_plugins.json` lists exactly one Onlooker plugin,
`ecosystem@onlooker-community 0.45.2`, project-scoped to the ecosystem repo. The
five plugins that repo's Wave 1 declared were never installed, so a full day of
soak measured nothing and its numbers were retracted. The open question — does
`enabledPlugins` alone trigger installation? — cannot be answered cleanly in
that repo, whose install history includes 0.45.0 orphaned mid-session and a
marketplace update landing between sessions. This repo has zero
`onlooker-community` entries for its `projectPath`. It is the clean room.

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
| `biome check ${file}` | 103 ms | yes |
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
schedule; it needs to be certain the plugins are actually running.

### Step 0 — the install probe (`onlooker-12s.1`)

Land `extraKnownMarketplaces` and `enabledPlugins` for
`ecosystem@onlooker-community` **alone**. Restart. Read
`~/.claude-personal/plugins/installed_plugins.json` for this `projectPath`.

This is the whole value of the clean room, and it is worth more than everything
downstream of it. If the substrate self-installs, `ecosystem-449.10` is
version-churn noise local to the ecosystem repo and its rollout can resume. If
it does not, `enabledPlugins` alone does not install, and the premise both
rollouts are built on is wrong in both repos.

Report the result on `ecosystem-449.10` either way.

### Step 1 — the recorder set (`onlooker-12s.2`)

Only if step 0 installs. Add lineage, inspector, assayer, and bursar plus the
`inspector.checks` block. Restart, then confirm all four appear in
`hook-health.jsonl` **before** trusting a single measurement.

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

None blocking. The one genuine unknown — whether `enabledPlugins` alone
installs — is the subject of step 0 rather than a question to resolve before
starting.
