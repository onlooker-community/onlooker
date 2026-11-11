# Lessons Stack Filter (ONL-14) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Narrow the lesson pool to a stack, answered by the server across every page, not by the browser across one.

**Architecture:** A derived table, `lesson_stacks (lesson_id, stack)`, holds one row per distinct entry of a lesson's `applies_to.stack`, written in the same batch as the lesson and backfilled from `body` by the migration. `GET /api/lessons?stack=` narrows `readPool` with an `EXISTS` against that table, on top of `visibilityPredicate`, never instead of it. The Lessons page sets the filter from the stack chips in the lesson detail.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Drizzle, React, vitest.

Linear: ONL-14. Bead: `onlooker-4bw`. Precedent: the project filter, `docs/superpowers/plans/2026-11-01-lessons-project-filter.md` (#256), whose shape this follows.

## Decisions

- **A derived table, not `json_each` over `body` at read time.** `json_each` in the read would parse every candidate row's JSON to answer one page and has nothing to index. The table is indexed by its primary key and is written once, because `applies_to` never changes after ingest: `transitionLesson` rewrites only `status` and `superseded_by`, and `createLessonsWithFeed` skips an id that already exists.
- **One bound parameter for any number of stacks.** The read already binds exactly D1's 100 at its caps: 59 for the base read (2 user ids, 50 orgs, 4 statuses, 2 cursor, 1 limit) plus 41 for the project filter (39 keys, 2 user ids). The stack values go in as one JSON array, `s.stack IN (SELECT value FROM json_each(?))`, so the stack filter costs 1 whatever its length, and `MAX_LESSON_PROJECT_FILTERS` drops from 39 to 38 to make room. Chosen 2026-11-10 over a shared projects-plus-stacks cap and over rewriting the project filter to `json_each` too.
- **The web control is the stack chips in the detail pane.** Each list row is an `<a>`, so a button inside a row's chip would nest interactive content in a link. `LessonDetail`'s "Stack" field already lists every entry; those become buttons that set the filter, and the active filter shows as a removable chip beside the status control. No new endpoint, and it offers only stacks the reader has already been shown. Chosen 2026-11-10 over a distinct-stacks endpoint.

## Deploying

`deploy.yml` applies migrations before it deploys the code that expects them. A lesson pushed in that gap is written by the old code, which writes no `lesson_stacks` rows, and the backfill has already run, so the filter would never find it. The backfill is idempotent (`INSERT OR IGNORE`), so re-running it once against each environment after its deploy closes the gap:

```sh
pnpm --filter @onlooker/api exec wrangler d1 execute <database> --env <env> --remote --command "<the 0022 backfill statement>"
```

## Global Constraints

- `stack` is repeatable, at most 20 values, each 1 to 100 characters. Anything else answers `400 invalid_stack`. The contract only requires `min(1)`; the length bound keeps a query string from carrying an unbounded JSON array. Values are deduplicated before binding, as `status` is.
- Matching is exact and case-sensitive. `ZAppliesTo` stores stack entries as given, and the filter does not invent a normalization the contract does not have.
- Matching any requested stack is enough (OR), as with `project` and `status`.
- The filter is added to `visibilityPredicate`, never replaces it, and is applied in `readPool`, which stays the only path to a lesson body. Unlike `project`, it has an anonymous form: a stack is a fact of the lesson, not of the reader.
- `project` is now capped at 38. 39 answers `400 invalid_project`.
- Tests: run one file with `pnpm --filter @onlooker/api test <name>` or `pnpm --filter @onlooker/web test <name>`, with **no `--`**. The API's Workers pool does not apply `vi.mock`.
- Edit tracked files with Edit/Write, never `sed -i`, heredocs, `biome format --write` or `lint:fix`. Generated migrations and schema come from their commands.
- Commits: `<type>(<scope>): <subject> :emoji:`, subject at most 72 characters counting the shortcode, American English, a why-focused body, `Refs ONL-14`.

---

### Task 1: Lessons carry their stacks in a table

**Files:**
- Modify: `packages/db/src/schema.ts`, `apps/api/src/db/lessons.ts`
- Generated: `packages/db/migrations/0022_*.sql` and its meta, `packages/db/src/expected-schema.ts`
- Test: `apps/api/src/db/lessons.test.ts`, new `apps/api/src/db/lesson-stacks-backfill.test.ts`, `packages/db/src/__tests__/schema.test.ts`

**Interfaces:**
- Produces: table `lesson_stacks` (`lesson_id` text not null, references `lessons.id` on delete cascade; `stack` text not null; primary key `(lesson_id, stack)`).

- [ ] **Step 1: Write the failing tests**

1. `createLessonsWithFeed` writes one `lesson_stacks` row per distinct stack entry: `["vite", "react", "vite"]` gives two rows.
2. An id that already exists is skipped and writes no second set of rows.
3. Deleting a lesson removes its rows (the cascade).
4. Backfill, sourced from the migration's last statement as `project-key-backfill.test.ts` does: a lesson with stacks in `body` and no rows gets them; a repeated entry gives one row; an unparsable `body` gets none and does not fail; running it twice changes nothing.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @onlooker/api test lessons`, `pnpm --filter @onlooker/api test lesson-stacks-backfill`
Expected: FAIL.

- [ ] **Step 3: Add the table**

In `packages/db/src/schema.ts`, after `lessons`, a `lessonStacks` table with a doc comment saying why it exists (the filter, ONL-14), that it is derived from `body` and never rewritten, and that the primary key is the index the filter's `EXISTS` seeks.

Run: `pnpm --filter @onlooker/db generate:migrations`, then `pnpm --filter @onlooker/db build`. Add the backfill as the migration's last statement with Edit, after a `--> statement-breakpoint`:

```sql
INSERT OR IGNORE INTO lesson_stacks (lesson_id, stack)
SELECT l.id, s.value
FROM lessons l, json_each(l.body, '$.applies_to.stack') s
WHERE json_valid(l.body) AND s.type = 'text';
```

Then run `pnpm --filter @onlooker/db generate:expected-schema`.

- [ ] **Step 4: Write it at ingest**

In `createLessonsWithFeed`, add one `INSERT INTO lesson_stacks` per distinct stack entry to the same `statements` batch, after the lesson's own insert, so the rows commit with the lesson or not at all. Deduplicate in TypeScript with a `Set` and say why (the contract allows repeats, the primary key does not). Check `scripts/source-guards.test.sh` for an `INSERT INTO lessons` guard that needs to know about this.

- [ ] **Step 5: Run everything this task touches**

Run: `pnpm --filter @onlooker/api test lessons`, `pnpm --filter @onlooker/api test lesson-stacks-backfill`, `pnpm --filter @onlooker/api test schema`, `pnpm --filter @onlooker/db test`, `pnpm typecheck`.

### Task 2: The server filters by stack

**Files:**
- Modify: `apps/api/src/db/pool.ts`, `apps/api/src/routes/lessons-browser.ts`
- Test: `apps/api/src/db/pool.test.ts`, `apps/api/src/db/pool-query-plan.test.ts`, `apps/api/src/routes/lessons-browser.test.ts`

**Interfaces:**
- Produces: `PoolFilters.stacks?: string[]`; `MAX_LESSON_STACK_FILTERS = 20`; `MAX_LESSON_STACK_LENGTH = 100`; `MAX_LESSON_PROJECT_FILTERS = 38`; `GET /api/lessons?stack=` (repeatable); error `invalid_stack`.

- [ ] **Step 1: Write the failing tests**

1. **Across pages, the done-when:** seed more matching lessons than one page interleaved with non-matching ones, page through with the cursor, and get every matching lesson exactly once and nothing else.
2. Visibility holds: another account's private lesson with the stack is never returned; a public one is; an anonymous read finds public lessons by stack.
3. It composes: `stack` with `status`, and `stack` with `project`, narrow together.
4. OR across values: `stack=vite&stack=react` returns lessons with either.
5. Exact match: `stack=Vite` does not find `vite`.
6. Route: 21 values, an empty value, or one over 100 characters answer `400 invalid_stack`; 39 projects now answer `400 invalid_project` and 38 do not.
7. The bind proof: the existing test that builds the worst-case statement and counts its parameters at 100 now includes 38 projects and a stack filter, and still counts 100.
8. Query plan: the filtered read reaches `lesson_stacks` by its primary key (`SEARCH ... USING PRIMARY KEY` or the autoindex), not `SCAN lesson_stacks`.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Add `stackPredicate`**

Beside `projectPredicate` in `pool.ts`:

```sql
EXISTS (SELECT 1 FROM lesson_stacks s
        WHERE s.lesson_id = lessons.id
          AND s.stack IN (SELECT value FROM json_each(?)))
```

bound to `JSON.stringify(stacks)`. Apply it in `readPool` after the project filter. Update the `MAX_READER_ORGS_BOUND` and `MAX_LESSON_PROJECT_FILTERS` comments to count the new bind.

- [ ] **Step 4: Parse `stack` in the route**

A `parseStacks(url)` beside `parseProjectKeys`: `getAll("stack")`, deduplicated, validated against the caps above, passed as `stacks`.

- [ ] **Step 5: Run everything this task touches**

Run: `pnpm --filter @onlooker/api test pool`, `pnpm --filter @onlooker/api test lessons-browser`, `pnpm typecheck`.

### Task 3: The contract, the client and the mock agree

**Files:**
- Modify: `packages/api-contract/src/index.ts`, `apps/web/src/api/lessonsApi.ts`, `apps/web/src/api/mockApi.ts`
- Test: `apps/web/src/__tests__/lessons-api.test.ts`, the shared contract cases

- [ ] **Step 1: Write the failing tests:** contract cases for a valid `stack` (200), an empty `stack` and 21 stacks (`400 invalid_stack`), and 39 projects (`400 invalid_project`); `listLessons({ stack: ["vite"] })` sends `?stack=vite`, encoded.
- [ ] **Step 2: Run them and watch them fail**
- [ ] **Step 3: Implement:** `stack?: string[]` on the client's options, appended like `project`; the mock validates as the route does and its project cap moves to 38. The mock's pool is always empty, so there is nothing for it to filter.
- [ ] **Step 4: Run** `pnpm --filter @onlooker/web test lessons-api`, `pnpm --filter @onlooker/web test api-contract`, `pnpm --filter @onlooker/api-contract test`.

### Task 4: The Lessons page filters by a stack chip

**Files:**
- Modify: `apps/web/src/hooks/useLessonPool.ts`, `apps/web/src/pages/LessonsPage.tsx`, `apps/web/src/pages/LessonDetail.tsx`
- Test: `apps/web/src/__tests__/lessons-page.test.tsx`

- [ ] **Step 1: Write the failing tests**

1. Pressing a stack in the detail's "Stack" field reloads the pool with `stack` set to it, and the cursor is dropped (a new query starts at page one).
2. Load more while filtered sends the same `stack` with the cursor.
3. The active filter shows as "Stack: vite" with a button to clear it; clearing reloads without `stack` and returns focus to the status control.
4. An empty filtered pool says it is the stack that matched nothing, not that the pool is empty.
5. A repeated stack (`["vite", "vite"]`) still renders two chips without a key collision, and both set the same filter.
6. The list rows' stack chip stays a plain chip, not a control.

- [ ] **Step 2: Run them and watch them fail**
- [ ] **Step 3: Implement:** `useLessonPool(filter, keys, stack)` sends `stack` and treats it as part of the query; `LessonsPage` holds `stack: string | null` and puts `filterByStack` on `LessonsContext`; `LessonDetail`'s `Chips` gains an optional `onSelect`, and each chip becomes a button labeled "Show lessons for <stack>". Replace the comment at `LessonsPage.tsx:115`, which says stack filtering does not ship.
- [ ] **Step 4: Run** `pnpm --filter @onlooker/web test lessons-page`, then `pnpm test` and `pnpm typecheck`.
