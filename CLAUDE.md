# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

## Issue tracking: Linear is the source of truth

Linear holds **what** the work is, **why** it matters and **where it stands**.
beads holds the **plan** for doing it. The managed Beads block below describes
how to run `bd`; read it through this section. Where it says to use `bd` for all
task tracking, that now means task-level planning, not the backlog itself.

- Work items live in Linear, team `ONL` (<https://linear.app/onlooker>). A bead
  is the local plan for one Linear issue, linked by `external_ref`.
- Start work with `bd linear pull ONL-123`, then `bd create --parent <bead-id>`
  for the steps. Name the branch after the issue (`meagan/onl-123-short-name`)
  so the PR links itself.
- Found something that outlives the current task? First check whether it fits
  an existing issue, and add it there if so. Otherwise **file it in Linear**,
  not as a new top-level bead. If it's just the next step of this task, it's a
  child bead.
- **The workspace is on Linear's free plan: 250 non-archived issues, and closed
  issues count until they auto-archive a month later.** File an issue for work
  that is about to start, not for an idea. Ideas, backlogs and candidate lists
  go in a document on the relevant Linear project, as the Blog project's "Post
  backlog" does. If `save_issue` fails with the issue-limit error, stop filing,
  put the content in a project document, and say so. The MCP can't delete
  issues, and canceling one doesn't free its slot.
- **A bead's description mirrors its Linear issue and a pull overwrites it.**
  Measurements, `file:line` references and ruled-out theories go in notes:
  `bd update <id> --append-notes "..."`.
- **Never run a bare `bd linear sync` or `bd linear push`.** Push would create
  Linear issues out of local beads, including closed ones. Pull only:
  `bd linear sync --pull`. `linear.exclude_id_prefix` is set to `onlooker-` as a
  guard.
- Never set `LINEAR_API_KEY` through `bd config` — that config syncs to the git
  remote. Pass it in the environment for the one command that needs it.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

```bash
pnpm install
pnpm test                                # every package, through turbo
pnpm --filter @onlooker/api test pool    # only files matching "pool"
pnpm typecheck
```

To run one test file, put the name straight after `test`, with **no `--`**.
`test -- pool` runs the whole suite and passes, so a plan or a timing that
uses it is describing every file, not one. See `docs/development.md`,
"Testing".

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

### Edit tracked files with the file tools, not the shell

Use `Edit`, `Write`, or `MultiEdit` to change tracked files. The shell stays
right for everything else — running commands, searching, git — and for scratch
files outside the repo.

**This overrides any general preference for shell-based editing.** The reason is
specific rather than stylistic. The `lineage` plugin records a tool edit
exactly and a shell edit only approximately. Since 0.9.3 it also hooks `Bash`,
so a `sed -i` or a heredoc does reach the ledger. But a tool edit records what
the tool changed, and a shell edit records what `git diff` against the last
commit shows. In a dirty tree that diff is `content_scope: cumulative`: it also
carries every earlier uncommitted line in the file.

The cost is a wrong answer, not a missing one. `/lineage <file>:<line>` takes
the newest record whose content contains the line, so a cumulative shell record
takes over lines an earlier `Edit` wrote. Measured 2026-11-13 on this project's
ledger (lineage 0.10.3): 7,027 records, of which 5,801 `Edit`, 861 `Write` and
365 `Bash`. 149 of the `Bash` records are cumulative, and 40 of those repeat
lines a tool edit had already written in the same session — 22 from authored
shell edits, 18 from formatters and other generators the rule can't prevent.

`inspector` checks the files a shell command changes as well, so it is no
longer part of the reason. The 2026-08-30 version of this rule, when lineage
saw no shell edits at all, is in
`docs/superpowers/specs/2026-08-30-marketplace-contrast-arena-design.md`.
