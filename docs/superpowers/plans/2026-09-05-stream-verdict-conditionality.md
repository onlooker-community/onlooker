# Stream Verdict Conditionality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `onlooker doctor` reporting healthy streams as `stopped`, and let it reach a real `stopped` verdict for streams that are demonstrably dead, by recording in the table which signals actually imply a write.

**Architecture:** `StreamEntry` gains `writeEvents`, the event-level mirror of the existing `writeHooks`. `computeVerdict`'s two divergent branches collapse into one rule over two quantities — `alive` (did this plugin run?) and `lastWrite` (did its output move?, defined only where a write signal exists). The wall-clock `RECORDING_FRESHNESS_LIMIT_MS` is replaced by a denominator counted in *opportunities*: sessions of this repo's that also ran the hook machinery.

**Tech Stack:** TypeScript, Node 24, vitest, pnpm workspaces, Biome (lint + format).

**Spec:** `docs/superpowers/specs/2026-09-05-stream-verdict-conditionality-design.md`. Bead: `onlooker-ac5`.

## Global Constraints

- **Edit tracked files with `Edit`/`Write`, never `sed -i` or heredocs.** The `lineage` and `inspector` plugins hook `PostToolUse` on `Edit`/`Write`/`MultiEdit`; a shell edit moves the same bytes invisibly and `/lineage` then answers "no record" for a line that was demonstrably written. See the repo's `CLAUDE.md`.
- **Never compare two ISO timestamps lexically in this codebase.** The event log writes millisecond precision (`…:45.123Z`), hook-health writes second precision (`…:45Z`), and `'Z'` (0x5A) sorts above `'.'` (0x2E) — so `"…:45Z" > "…:45.123Z"` is `true` while the instant is earlier. Compare `new Date(x).getTime()`. The existing `since` check in `scanHooks` documents this trap at length; every new comparison in this plan follows it.
- **Both `Record` accumulators keyed by untrusted strings must be `Object.create(null)`.** An `event_type` of `__proto__` on a plain `{}` reads back through `Object.prototype`. Existing code does this for `lastByPrefix` and `hooks`; new maps match.
- **Never `git add -A`.** Each task's commit step names its files.
- **Commits go through the `/commit` skill.** If you are a subagent without it, mirror its contract: `<type>(<scope>): <subject> :emoji:`, American English, why-focused body, subject ≤72 chars including the emoji.
- **Run gates from the repo root**, not from `apps/cli`.

## Verification commands

```bash
pnpm --filter @onlooker/cli exec vitest run src/__tests__/eventlog.test.ts
pnpm --filter @onlooker/cli exec vitest run src/__tests__/streams.test.ts
pnpm --filter @onlooker/cli test        # all 13 files
pnpm --filter @onlooker/cli lint        # must stay 0 errors, 0 warnings
pnpm --filter @onlooker/cli typecheck
```

Baseline before this plan: **257 tests passing across 13 files**, `apps/cli` lint clean.

---

## Task 1: `EventScan.lastByType`

`writeEvents` names full event types (`lineage.change.recorded`), but `scanEvents` only retains `lastByPrefix` — the newest timestamp per `event_type` prefix. There is no per-type timestamp for the rule to read, so it has to exist before anything can consume it.

The existing per-session buffer is keyed by prefix. This task rekeys it to the full type and derives the prefix at fold time, so one buffer feeds both maps rather than two buffers running in parallel.

**Files:**
- Modify: `apps/cli/src/eventlog.ts` (interface `EventScan` ~line 20; `scanEvents` ~lines 149–361)
- Test: `apps/cli/src/__tests__/eventlog.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `EventScan.lastByType: Record<string, string>` — newest ISO timestamp per full `event_type`, scoped to sessions rooted at `root` exactly as `lastByPrefix` is. Task 6 reads it.

- [ ] **Step 1: Write the failing test**

Add to `apps/cli/src/__tests__/eventlog.test.ts`, inside the existing `describe("scanEvents", …)`:

```ts
it("records the newest timestamp per full event type, not only per prefix", async () => {
	const env = logWith([
		{
			event_type: "session.start",
			timestamp: "2026-09-01T00:00:00.000Z",
			session_id: "s",
			payload: { working_directory: root },
		},
		{
			event_type: "lineage.change.recorded",
			timestamp: "2026-09-01T01:00:00.000Z",
			session_id: "s",
			payload: {},
		},
		{
			event_type: "lineage.scan.skipped",
			timestamp: "2026-09-01T02:00:00.000Z",
			session_id: "s",
			payload: {},
		},
	]);

	const scan = await scanEvents({ root, env });

	// The prefix keeps taking the newest across the whole family...
	expect(scan.lastByPrefix.lineage).toBe("2026-09-01T02:00:00.000Z");
	// ...while each type keeps its own, which is what a write signal needs:
	// `lineage.change.recorded` implies a write, `lineage.scan.skipped` does not.
	expect(scan.lastByType["lineage.change.recorded"]).toBe(
		"2026-09-01T01:00:00.000Z",
	);
	expect(scan.lastByType["lineage.scan.skipped"]).toBe(
		"2026-09-01T02:00:00.000Z",
	);
});
```

If `logWith` and `root` are not the helper names already in that file, read the top of `eventlog.test.ts` and use whatever it does provide — do not add a second helper that duplicates one already there.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @onlooker/cli exec vitest run src/__tests__/eventlog.test.ts -t "full event type"
```

Expected: FAIL — `Cannot read properties of undefined (reading 'lineage.change.recorded')`, because `scan.lastByType` does not exist.

- [ ] **Step 3: Add the field to `EventScan`**

In `apps/cli/src/eventlog.ts`, directly beneath the `lastByPrefix` member:

```ts
	/**
	 * Newest ISO timestamp per FULL `event_type`, from sessions rooted at
	 * `root` — the same scoping `lastByPrefix` gets, one level finer.
	 *
	 * Exists because `StreamEntry.writeEvents` names full types rather than
	 * prefixes, and it has to: `governor.session.complete` fires 2774 times
	 * and implies nothing about output, while `governor.gate.checked` fires
	 * 84 times and does. `lastByPrefix` takes the newest across the whole
	 * family, so the unconditional type masks the conditional one — which is
	 * exactly right for asking "did this plugin run?" and useless for asking
	 * "should its output have moved?".
	 */
	lastByType: Record<string, string>;
```

- [ ] **Step 4: Initialize it**

In `scanEvents`'s `const scan: EventScan = { … }` literal, beneath `lastByPrefix`:

```ts
		lastByType: Object.create(null) as Record<string, string>,
```

- [ ] **Step 5: Rekey the buffer to the full type**

Replace the `prefixBySession` declaration and its comment with:

```ts
	// Same reasoning as `keysBySession`, for the timestamp maps: whether a
	// record's own session belongs to `mine` is not decided until the pass
	// is done, so the newest timestamp is buffered per session first and
	// folded into `scan.lastByPrefix`/`scan.lastByType` afterward, once,
	// against only the sessions that turned out to be ours. Only used when
	// `opts.root !== null` - when it is `null` there is no scoping to do and
	// both maps are updated directly, machine-wide, exactly as before.
	//
	// Keyed by FULL `event_type`, with the prefix derived at fold time
	// rather than buffered alongside it. One buffer, not two: the prefix is
	// a pure function of the type, so storing both would be storing the same
	// information twice per session.
	const typeBySession = new Map<string, Record<string, string>>();
```

In `processLine`, the machine-wide branch becomes:

```ts
		if (opts.root === null) {
			// No root to scope by, so the caller never asked for scoping at
			// all - both maps stay machine-wide, updated directly.
			if (timestamp > (scan.lastByPrefix[prefix] ?? "")) {
				scan.lastByPrefix[prefix] = timestamp;
			}
			if (timestamp > (scan.lastByType[type] ?? "")) {
				scan.lastByType[type] = timestamp;
			}
			return;
		}
```

and the buffering block becomes:

```ts
		let sessionTypes = typeBySession.get(session);
		if (!sessionTypes) {
			sessionTypes = Object.create(null) as Record<string, string>;
			typeBySession.set(session, sessionTypes);
		}
		if (timestamp > (sessionTypes[type] ?? "")) {
			sessionTypes[type] = timestamp;
		}
```

Note both comparisons above are lexical, and that is correct here and only here: both sides come from the same log, which writes one fixed format, so the precision trap in the Global Constraints cannot arise. The comparison this plan adds in Task 4 crosses two logs and must parse.

- [ ] **Step 6: Fold both maps**

Replace the `for (const session of mine)` fold body's prefix section with:

```ts
	for (const session of mine) {
		const sessionTypes = typeBySession.get(session);
		if (sessionTypes) {
			for (const type of Object.keys(sessionTypes)) {
				const timestamp = sessionTypes[type];
				if (timestamp > (scan.lastByType[type] ?? "")) {
					scan.lastByType[type] = timestamp;
				}
				const prefix = type.split(".")[0];
				if (timestamp > (scan.lastByPrefix[prefix] ?? "")) {
					scan.lastByPrefix[prefix] = timestamp;
				}
			}
		}
		for (const key of keysBySession.get(session) ?? []) {
			keys.add(key);
		}
	}
```

- [ ] **Step 7: Reset it on a failed pass**

In `scanEvents`'s `catch`, beside the existing `scan.lastByPrefix` reset:

```ts
		scan.lastByType = Object.create(null) as Record<string, string>;
```

Then update that block's trailing comment, which currently reads "`projectKeys` and `sessionIds` need no reset" — it must now also account for `lastByType` being discarded for the same reason `lastByPrefix` is: a truncated map would let `judge()` certify a stream off evidence this module could not fully read.

- [ ] **Step 8: Run the test to verify it passes**

```bash
pnpm --filter @onlooker/cli exec vitest run src/__tests__/eventlog.test.ts
```

Expected: PASS, and every pre-existing test in the file still passing — the prefix behavior is unchanged, only its source is.

- [ ] **Step 9: Commit**

```bash
git add apps/cli/src/eventlog.ts apps/cli/src/__tests__/eventlog.test.ts
```

Then `/commit`. Subject: `feat(cli): keep the newest timestamp per event type :seedling:`. Body: `writeEvents` names full types because conditionality is per type, not per plugin (`governor.session.complete` 2774 firings vs `governor.gate.checked` 84); `lastByPrefix` cannot answer that, so the buffer is rekeyed to the full type and the prefix derived at fold time. Refs `onlooker-ac5`.

---

## Task 2: `EventScan.sessionStarts`

The opportunity denominator needs to know when each of this repo's sessions began. `scanEvents` already identifies exactly those sessions — it parses `session.start` and checks `working_directory` against `root` to build `mine` — and throws the timestamps away.

**Files:**
- Modify: `apps/cli/src/eventlog.ts`
- Test: `apps/cli/src/__tests__/eventlog.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `EventScan.sessionStarts: Record<string, string>` — session id → the ISO timestamp it started, for sessions rooted at `root` only. Task 4 reads it.

- [ ] **Step 1: Write the failing test**

```ts
it("records when each of this repo's own sessions started, and no one else's", async () => {
	const env = logWith([
		{
			event_type: "session.start",
			timestamp: "2026-09-01T00:00:00.000Z",
			session_id: "ours",
			payload: { working_directory: root },
		},
		{
			event_type: "session.start",
			timestamp: "2026-09-02T00:00:00.000Z",
			session_id: "theirs",
			payload: { working_directory: "/somewhere/else" },
		},
		// A resumed session logs a second start; the opportunity is the
		// session, not each record of it, so the earliest wins.
		{
			event_type: "session.start",
			timestamp: "2026-09-01T06:00:00.000Z",
			session_id: "ours",
			payload: { working_directory: root },
		},
	]);

	const scan = await scanEvents({ root, env });

	expect(scan.sessionStarts).toEqual({ ours: "2026-09-01T00:00:00.000Z" });
	expect(scan.sessionIds).toEqual(["ours"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @onlooker/cli exec vitest run src/__tests__/eventlog.test.ts -t "own sessions started"
```

Expected: FAIL — `expected undefined to deeply equal { ours: … }`.

- [ ] **Step 3: Add the field to `EventScan`**

Beneath the `sessionIds` member:

```ts
	/**
	 * This repo's own sessions, each mapped to the ISO timestamp it started.
	 * Empty when `root` is `null`. `sessionIds` is this object's keys,
	 * sorted — the two are built from the same set and cannot disagree.
	 *
	 * The opportunity denominator needs the timestamps, not just the ids: a
	 * verdict asks "how many chances has this plugin had SINCE the moment it
	 * last showed life", and that is a count of sessions after a cutoff.
	 * Earliest start per session wins, because a resumed session logs a
	 * second `session.start` and it is still one opportunity.
	 */
	sessionStarts: Record<string, string>;
```

- [ ] **Step 4: Initialize it**

```ts
		sessionStarts: Object.create(null) as Record<string, string>,
```

- [ ] **Step 5: Capture the timestamps**

Declare beside `mine`:

```ts
	// Earliest `session.start` per session of ours - see
	// `EventScan.sessionStarts`. Kept separate from `mine` rather than
	// replacing it: `mine` is a membership test used on the hot path of the
	// fold, and this is the data behind it.
	const startedAt = new Map<string, string>();
```

Then in `processLine`, extend the existing `session.start` branch:

```ts
		if (
			type === "session.start" &&
			within(payload.working_directory, opts.root)
		) {
			mine.add(session);
			const seen = startedAt.get(session);
			if (seen === undefined || timestamp < seen) {
				startedAt.set(session, timestamp);
			}
		}
```

- [ ] **Step 6: Fold it**

Immediately after the existing `scan.sessionIds = …` assignment:

```ts
	for (const [session, at] of startedAt) scan.sessionStarts[session] = at;
```

No reset is needed in the `catch`: like `sessionIds` and `projectKeys`, this is assigned only after the loop, so a failed pass leaves it at its initial empty state.

- [ ] **Step 7: Run the test to verify it passes**

```bash
pnpm --filter @onlooker/cli exec vitest run src/__tests__/eventlog.test.ts
```

Expected: PASS, whole file green.

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/eventlog.ts apps/cli/src/__tests__/eventlog.test.ts
```

Then `/commit`. Subject: `feat(cli): keep the session start times the scan already parses :watch:`.

---

## Task 3: `HookScan.sessionsWithRecords`

An opportunity is a session that ran the hook machinery. `scanHooks` sees exactly that evidence and aggregates it away by hook name.

**Files:**
- Modify: `apps/cli/src/eventlog.ts` (interface `HookScan` ~line 368; `scanHooks` ~lines 376–520)
- Test: `apps/cli/src/__tests__/eventlog.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `HookScan.sessionsWithRecords: string[]` — sorted session ids in which any hook fired, already narrowed to `sessionIds` when that option was passed. Task 4 reads it.

- [ ] **Step 1: Write the failing test**

```ts
it("records which sessions ran hooks at all, scoped the same way firings are", async () => {
	const env = hookLogWith([
		{ hook: "lineage-post-tool-use", timestamp: "2026-09-01T00:00:00Z", session_id: "ours" },
		{ hook: "bursar-session-end", timestamp: "2026-09-01T01:00:00Z", session_id: "ours" },
		{ hook: "lineage-post-tool-use", timestamp: "2026-09-01T02:00:00Z", session_id: "theirs" },
		// No session_id at all - cannot be attributed, so it is not an
		// opportunity for anyone.
		{ hook: "lineage-post-tool-use", timestamp: "2026-09-01T03:00:00Z" },
	]);

	const scoped = await scanHooks({ since: {}, sessionIds: ["ours"], env });
	expect(scoped.sessionsWithRecords).toEqual(["ours"]);

	// Unscoped keeps its machine-wide contract, minus the unattributable one.
	const all = await scanHooks({ since: {}, env });
	expect(all.sessionsWithRecords).toEqual(["ours", "theirs"]);
});
```

Use whatever fixture helper `eventlog.test.ts` already has for writing `hook-health.jsonl`; `hookLogWith` is a placeholder for it.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @onlooker/cli exec vitest run src/__tests__/eventlog.test.ts -t "ran hooks at all"
```

Expected: FAIL — `expected undefined to deeply equal [ 'ours' ]`.

- [ ] **Step 3: Add the field to `HookScan`**

```ts
	/**
	 * Sessions in which any hook fired at all, sorted — narrowed to
	 * `sessionIds` when that option was given, so it means "sessions of
	 * OURS that ran the hook machinery".
	 *
	 * This is the opportunity denominator. A session absent from this set
	 * asked nothing of any plugin and must not count against one: 240 of
	 * this repo's 246 sessions in the measured window were subagent
	 * sessions running no hooks, including a single block of 91 consecutive
	 * ones over 27 hours. Counting those, every plugin on the machine shows
	 * a longest silent run of exactly 91 - a property of the session stream,
	 * not of any plugin, and one no threshold can be set above while still
	 * catching a real outage. See the design's *The window* section.
	 */
	sessionsWithRecords: string[];
```

- [ ] **Step 4: Initialize it**

In `scanHooks`'s `const scan: HookScan = { … }`:

```ts
		sessionsWithRecords: [],
```

- [ ] **Step 5: Collect the sessions**

Declare beside `scoped`:

```ts
	// Sessions that demonstrably ran hooks - see
	// `HookScan.sessionsWithRecords`. Populated AFTER the scope filter
	// below, so when scoping was requested this is already the
	// intersection the denominator wants and needs no second pass.
	const ranHooks = new Set<string>();
```

Then restructure the scope-filter block in `processLine`. It currently declares `session` inside the `if (scoped !== null)`; hoist it so both uses see it:

```ts
		// Out-of-scope firings are excluded entirely, not merely uncounted:
		// a hook that only ever fired in other sessions never gets a
		// `scan.hooks[hook]` entry at all, so it reads to a caller exactly
		// like a hook with no records - `undefined`, not `{ firedSince: 0,
		// ... }` - which is what "we have no evidence of OUR OWN activity"
		// actually means. A record with no `session_id` cannot be
		// attributed to `scoped` either way, so it is excluded the same as
		// one that is attributable but not ours.
		const session = record.session_id;
		if (scoped !== null) {
			if (typeof session !== "string" || !scoped.has(session)) return;
		}
		// An unattributable firing proves a hook ran but not WHERE, so it
		// cannot make any session an opportunity - excluded here even on the
		// unscoped path, where it is still counted as a firing above.
		if (typeof session === "string") ranHooks.add(session);
```

- [ ] **Step 6: Fold it**

After the read loop, beside the existing post-loop work in `scanHooks`:

```ts
	scan.sessionsWithRecords = [...ranHooks].sort((a, b) => a.localeCompare(b));
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
pnpm --filter @onlooker/cli exec vitest run src/__tests__/eventlog.test.ts
```

Expected: PASS, whole file green.

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/eventlog.ts apps/cli/src/__tests__/eventlog.test.ts
```

Then `/commit`. Subject: `feat(cli): record which sessions actually ran hooks :footprints:`.

---

## Task 4: `opportunitiesSince`

The pure counting function, tested on its own before any verdict depends on it.

**Files:**
- Modify: `apps/cli/src/streams.ts` (new exported function, near `clearsCadenceFloor`)
- Test: `apps/cli/src/__tests__/streams.test.ts`

**Interfaces:**
- Consumes: `EventScan.sessionStarts` (Task 2), `HookScan.sessionsWithRecords` (Task 3).
- Produces: `export function opportunitiesSince(events: Pick<EventScan, "sessionStarts">, hooks: Pick<HookScan, "sessionsWithRecords">, iso: string): number`. Task 6 calls it.

- [ ] **Step 1: Write the failing test**

```ts
describe("opportunitiesSince", () => {
	const events = {
		sessionStarts: {
			a: "2026-09-01T00:00:00.000Z",
			b: "2026-09-02T00:00:00.000Z",
			c: "2026-09-03T00:00:00.000Z",
			subagent: "2026-09-04T00:00:00.000Z",
		},
	};
	// `subagent` started but ran no hooks, so it was never an opportunity.
	const hooks = { sessionsWithRecords: ["a", "b", "c"] };

	it("counts only sessions that ran hooks, after the cutoff", () => {
		expect(opportunitiesSince(events, hooks, "2026-09-01T12:00:00.000Z")).toBe(2);
	});

	it("does not count a subagent session that ran no hooks", () => {
		// Everything after 2026-09-03 is `subagent` alone.
		expect(opportunitiesSince(events, hooks, "2026-09-03T12:00:00.000Z")).toBe(0);
	});

	it("counts nothing when no session ran a hook", () => {
		expect(
			opportunitiesSince(events, { sessionsWithRecords: [] }, "2026-01-01T00:00:00.000Z"),
		).toBe(0);
	});

	// The precision trap: hook-health writes second precision, the event log
	// writes milliseconds, and `'Z'` (0x5A) sorts above `'.'` (0x2E) - so a
	// lexical compare reads this cutoff as LATER than the session start and
	// returns 0. It is earlier by 500ms and the session counts.
	it("compares instants, not strings, across the two logs' formats", () => {
		expect(
			opportunitiesSince(
				{ sessionStarts: { a: "2026-09-01T00:00:00.500Z" } },
				{ sessionsWithRecords: ["a"] },
				"2026-09-01T00:00:00Z",
			),
		).toBe(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @onlooker/cli exec vitest run src/__tests__/streams.test.ts -t "opportunitiesSince"
```

Expected: FAIL — `opportunitiesSince is not defined`.

- [ ] **Step 3: Implement it**

Add to `apps/cli/src/streams.ts`, and add `EventScan`/`HookScan` to the existing `import type` from `./eventlog` if they are not already imported:

```ts
/**
 * How many opportunities this repo has had since `iso` - sessions of its own
 * that also ran the hook machinery.
 *
 * The denominator every stall verdict is measured against, and deliberately
 * NOT a count of `session.start` events. `session.start` includes subagent
 * sessions, which run no hooks and so were never a chance for any plugin to
 * act: 240 of this repo's 246 sessions in the measured window were exactly
 * that, including one block of 91 consecutive sessions across 27 hours in
 * which no hook fired anywhere. Counted raw, every plugin on the machine -
 * ecosystem across all 11,422 sessions included - shows a longest silent run
 * of exactly 91, because 91 belongs to the session stream rather than to any
 * plugin. A threshold would have to sit above 91 to avoid false alarms while
 * only 35 sessions elapsed across the three and a half weeks the real outage
 * went unnoticed; no value satisfies both. Counting opportunities instead
 * drops that floor to 1.
 *
 * Epoch comparison, not lexical: `iso` can arrive from either log, and the
 * two write different precision. See `scanHooks`'s `since` comment for the
 * full trap.
 */
export function opportunitiesSince(
	events: Pick<EventScan, "sessionStarts">,
	hooks: Pick<HookScan, "sessionsWithRecords">,
	iso: string,
): number {
	const ran = new Set(hooks.sessionsWithRecords);
	const cutoff = new Date(iso).getTime();
	let count = 0;
	for (const session of Object.keys(events.sessionStarts)) {
		if (!ran.has(session)) continue;
		if (new Date(events.sessionStarts[session]).getTime() > cutoff) count++;
	}
	return count;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @onlooker/cli exec vitest run src/__tests__/streams.test.ts -t "opportunitiesSince"
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/streams.ts apps/cli/src/__tests__/streams.test.ts
```

Then `/commit`. Subject: `feat(cli): count opportunities, not sessions :straight_ruler:`.

---

## Task 5: The field and the threshold

Interface and constant only — no entry values, no rule change. Splitting this out keeps Task 6's diff to the rule itself.

**Files:**
- Modify: `apps/cli/src/streams.ts` (`StreamEntry` ~line 111; constants ~line 17)
- Test: `apps/cli/src/__tests__/streams.test.ts`

**Interfaces:**
- Produces: `StreamEntry.writeEvents?: readonly string[]` and `export const SESSION_STALL_THRESHOLD = 5`. Tasks 6 and 7 use both.

- [ ] **Step 1: Write the failing test**

```ts
it("declares no writeEvents naming an event type its own entry does not emit", () => {
	for (const entry of STREAMS) {
		for (const type of entry.writeEvents ?? []) {
			// A write event must belong to a prefix this entry already
			// tracks, or the rule would look it up in a map that is scoped
			// to different prefixes and silently never find it.
			expect(
				entry.events.some((prefix) => type.startsWith(`${prefix}.`)),
				`${entry.plugin}: writeEvents entry ${type} matches none of its events prefixes`,
			).toBe(true);
		}
	}
});

it("sets a session stall threshold above the measured noise floor", () => {
	// Floor is 1: over the six opportunities this repo had between
	// 2026-08-30 and 2026-09-05, bursar fired in 6, and lineage, inspector
	// and assayer each in 5 - a longest healthy silent run of 1. Ceiling is
	// those same 6. See onlooker-run for the recheck.
	expect(SESSION_STALL_THRESHOLD).toBeGreaterThan(1);
	expect(SESSION_STALL_THRESHOLD).toBeLessThanOrEqual(6);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @onlooker/cli exec vitest run src/__tests__/streams.test.ts -t "session stall threshold"
```

Expected: FAIL — `SESSION_STALL_THRESHOLD is not defined`. (The first test will pass vacuously until Task 7 populates any values; that is fine — it is a guard for Task 7, written now so Task 7 cannot land a typo.)

- [ ] **Step 3: Add the constant**

Beneath `STALL_THRESHOLD` in `apps/cli/src/streams.ts`:

```ts
/**
 * How many opportunities - sessions of this repo's that ran the hook
 * machinery, see `opportunitiesSince` - may pass with no sign of life from a
 * stream before its silence reads as a stall rather than as quiet.
 *
 * The design's one new arbitrary number, recorded as such exactly like
 * `STALL_THRESHOLD` and `CADENCE_FLOOR_MULTIPLIER` - but read off measured
 * data rather than picked and justified afterward, which is what went wrong
 * with the wall-clock constant it replaces.
 *
 * Floor 1, ceiling 6. Over the six opportunities this repo had between
 * 2026-08-30 and 2026-09-05: bursar fired in 6 of 6, and lineage, inspector
 * and assayer in 5 of 6 - so a healthy stream's longest silence was one
 * opportunity. Six opportunities have elapsed since the 2026-08-07 outage,
 * so five reports counsel `stopped` today rather than `unknown`. Five also
 * matches `STALL_THRESHOLD` for the same underlying reason: any stream may
 * lag its trigger by about one opportunity, and five clears that with room.
 *
 * The sample is six opportunities wide, because every enabled plugin's
 * hook-health history begins 2026-08-30. `onlooker-run` tracks rechecking
 * this once the enabled set has roughly a month of history.
 */
export const SESSION_STALL_THRESHOLD = 5;
```

- [ ] **Step 4: Add the field to `StreamEntry`**

Directly beneath the `writeHooks` member, so the two read together:

```ts
	/**
	 * The event types whose emission is reliable evidence that this entry's
	 * analytical output was WRITTEN - the exact mirror of `writeHooks`, one
	 * level down.
	 *
	 * Full `event_type` values, never prefixes, because conditionality is a
	 * property of the type rather than of the plugin:
	 * `governor.session.complete` fires on every session and implies nothing
	 * about output, while `governor.gate.checked` fires only when a gate is
	 * checked. `events` above stays prefix-keyed, because it answers the
	 * different question of whether the plugin ran at all, and there the
	 * masking is exactly what you want.
	 *
	 * Undefined or empty means no event this entry emits implies a write.
	 * That is the conservative direction and the common one: scribe emits
	 * per prompt from `scribe-capture` while `scribe-stop` writes only when
	 * there is something to distill, and `curator.scan.complete` fires on
	 * every scan whether or not any finding changed. Together with
	 * `writeHooks` this decides whether `computeVerdict` may ask the write
	 * question at all - see its `lastWrite`.
	 *
	 * Every value here was read out of the plugin's source, not inferred
	 * from its name. Each entry below records the file and line.
	 */
	writeEvents?: readonly string[];
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @onlooker/cli exec vitest run src/__tests__/streams.test.ts
```

Expected: PASS, whole file green.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/streams.ts apps/cli/src/__tests__/streams.test.ts
```

Then `/commit`. Subject: `feat(cli): give the table a place to record write events :pencil:`.

---

## Task 6: The rule

The behavioral change. `computeVerdict`'s branches collapse into `alive` and `lastWrite`, and `RECORDING_FRESHNESS_LIMIT_MS` goes.

**Files:**
- Modify: `apps/cli/src/streams.ts` — `computeVerdict` (~lines 1428–1735), `isFreshEnoughToRecord` and `RECORDING_FRESHNESS_LIMIT_MS` (delete), `surveyStreams` (thread the two scans into `judge`)
- Test: `apps/cli/src/__tests__/streams.test.ts`

**Interfaces:**
- Consumes: `opportunitiesSince` (Task 4), `SESSION_STALL_THRESHOLD` and `StreamEntry.writeEvents` (Task 5), `lastByType` (Task 1).
- Produces: no new exports. `RECORDING_FRESHNESS_LIMIT_MS` and `isFreshEnoughToRecord` cease to exist — this is a deliberate breaking change to the module surface, and `streams.test.ts` references the constant by name today.

- [ ] **Step 1: Write the failing tests**

Four cases. The first three are the reproduced false positives; the fourth is the false negative the change must not lose. Build them with the file's existing `machine()` helper.

```ts
const NOW = new Date("2026-09-05T12:00:00Z");

/**
 * Six opportunities: six sessions of ours, each carrying a hook record.
 * Dates run 2026-08-31 through 2026-09-05, all at or before `NOW` - a
 * fixture session in the future would be counted by `opportunitiesSince`
 * for a cutoff that has not happened yet.
 */
function sixOpportunities(cwd: string): { events: unknown[]; hooks: unknown[] } {
	const days = [
		"2026-08-31", "2026-09-01", "2026-09-02",
		"2026-09-03", "2026-09-04", "2026-09-05",
	];
	const events: unknown[] = [];
	const hooks: unknown[] = [];
	days.forEach((day, i) => {
		const id = `opp-${i}`;
		events.push({
			event_type: "session.start",
			timestamp: `${day}T00:00:00.000Z`,
			session_id: id,
			payload: { working_directory: cwd },
		});
		hooks.push({
			hook: "session-start-tracker",
			timestamp: `${day}T00:00:01Z`,
			status: "success",
			session_id: id,
		});
	});
	return { events, hooks };
}
```

`cwd` is created inside `machine()`, so this must be called from within it — which is why `opportunities` is an option on `machine()` rather than rows assembled by the caller.

`machine()` creates `cwd` itself, so `PLACEHOLDER_CWD` cannot be filled in before the call. Extend `machine()` with an `opportunities?: number` option that generates these rows internally once `cwd` is known, rather than trying to thread the path in from outside. Put the helper beside `machine()` and give it a comment saying why it exists.

```ts
it("does not call a conditional writer stopped just because its output is older than its events", async () => {
	// scribe, healthy: sessions every day, nothing worth distilling for a
	// week. No writeHooks and no writeEvents, so `lastWrite` is undefined
	// and the output's age is not evidence about anything.
	const { cwd, home, configDir, env } = machine({
		plugins: ["scribe"],
		projectKeys: ["aaaaaaaaaaaa"],
		opportunities: 6,
		files: [
			[join("scribe", "aaaaaaaaaaaa", "2026-08-29-s.md"), "2026-08-29T00:00:00Z"],
		],
		events: [
			{
				event_type: "scribe.captured",
				timestamp: "2026-09-05T09:00:00.000Z",
				session_id: "opp-5",
				payload: {},
			},
		],
	});
	const v = verdictFor(await surveyStreams({ cwd, home, configDir, env, now: NOW }), "scribe");
	expect(v?.kind).toBe("recording");
});

it("does not call a clean repo's curator stopped over months-old findings", async () => {
	const { cwd, home, configDir, env } = machine({
		plugins: ["curator"],
		projectKeys: ["aaaaaaaaaaaa"],
		opportunities: 6,
		files: [
			[join("curator", "aaaaaaaaaaaa", "findings", "f.json"), "2026-06-01T00:00:00Z"],
		],
		events: [
			{
				event_type: "curator.scan.complete",
				timestamp: "2026-09-05T09:00:00.000Z",
				session_id: "opp-5",
				payload: {},
			},
		],
	});
	const v = verdictFor(await surveyStreams({ cwd, home, configDir, env, now: NOW }), "curator");
	expect(v?.kind).toBe("recording");
});

it("does not call compass stopped after an hour of read-only Bash", async () => {
	// compass-bash-gate fires on every Bash; compass.* is emitted only on a
	// write-pattern match. The gap between them is not evidence.
	const { cwd, home, configDir, env } = machine({
		plugins: ["compass"],
		projectKeys: ["aaaaaaaaaaaa"],
		opportunities: 6,
		events: [
			{
				event_type: "compass.gate.checked",
				timestamp: "2026-09-05T09:00:00.000Z",
				session_id: "opp-5",
				payload: {},
			},
		],
		hooks: [
			{
				hook: "compass-bash-gate",
				timestamp: "2026-09-05T11:55:00Z",
				status: "success",
				session_id: "opp-5",
			},
		],
	});
	const v = verdictFor(await surveyStreams({ cwd, home, configDir, env, now: NOW }), "compass");
	expect(v?.kind).not.toBe("stopped");
});

it("calls lineage stopped when its hook keeps firing but its write event has stopped", async () => {
	// The false negative this design must not lose. lineage-post-tool-use
	// fires constantly; `lineage.change.recorded` is emitted at the ledger
	// write site, so its silence IS the writes stopping.
	const { cwd, home, configDir, env } = machine({
		plugins: ["lineage"],
		projectKeys: ["aaaaaaaaaaaa"],
		opportunities: 6,
		files: [[join("lineage", "aaaaaaaaaaaa", "changes.jsonl"), "2026-01-15T00:00:00Z"]],
		events: [
			{
				event_type: "lineage.change.recorded",
				timestamp: "2026-01-15T00:00:00.000Z",
				session_id: "opp-0",
				payload: {},
			},
		],
		hooks: [
			{
				hook: "lineage-post-tool-use",
				timestamp: "2026-09-05T11:00:00Z",
				status: "success",
				session_id: "opp-5",
			},
		],
	});
	const v = verdictFor(await surveyStreams({ cwd, home, configDir, env, now: NOW }), "lineage");
	expect(v?.kind).toBe("stopped");
});

it("reports unknown, not stopped, when too few opportunities have elapsed to judge", async () => {
	// The idle-machine case, and the one the wall clock got backwards: a
	// stream silent for months on a repo nobody has opened has not had the
	// chances that would make its silence mean anything.
	const { cwd, home, configDir, env } = machine({
		plugins: ["lineage"],
		projectKeys: ["aaaaaaaaaaaa"],
		opportunities: 2,
		files: [[join("lineage", "aaaaaaaaaaaa", "changes.jsonl"), "2026-01-15T00:00:00Z"]],
		events: [
			{
				event_type: "lineage.change.recorded",
				timestamp: "2026-01-15T00:00:00.000Z",
				session_id: "opp-0",
				payload: {},
			},
		],
	});
	const v = verdictFor(await surveyStreams({ cwd, home, configDir, env, now: NOW }), "lineage");
	expect(v?.kind).toBe("unknown");
});

it("does not count subagent sessions as opportunities", async () => {
	// 91 sessions of ours, none of which ran a hook - the measured shape
	// that made a raw session count unusable. Against a `session.start`
	// denominator this reads `stopped`; it must read `unknown`.
	const events: unknown[] = [];
	for (let i = 0; i < 91; i++) {
		events.push({
			event_type: "session.start",
			timestamp: `2026-09-03T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
			session_id: `subagent-${i}`,
			payload: { working_directory: "SET_BY_MACHINE" },
		});
	}
	// `machine()`'s own `projectKeys` support already rewrites
	// working_directory to the real cwd; follow whatever mechanism it uses.
	const { cwd, home, configDir, env } = machine({
		plugins: ["lineage"],
		projectKeys: ["aaaaaaaaaaaa"],
		subagentSessions: 91,
		files: [[join("lineage", "aaaaaaaaaaaa", "changes.jsonl"), "2026-01-15T00:00:00Z"]],
		events: [
			{
				event_type: "lineage.change.recorded",
				timestamp: "2026-01-15T00:00:00.000Z",
				session_id: "s",
				payload: {},
			},
		],
	});
	const v = verdictFor(await surveyStreams({ cwd, home, configDir, env, now: NOW }), "lineage");
	expect(v?.kind).toBe("unknown");
});
```

Add `subagentSessions?: number` to `machine()` alongside `opportunities?: number`: the first generates `session.start` rows with no hook records, the second generates them with.

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @onlooker/cli exec vitest run src/__tests__/streams.test.ts -t "conditional writer|clean repo's curator|read-only Bash|write event has stopped|too few opportunities|subagent sessions"
```

Expected: the scribe, curator and compass cases FAIL with `expected 'stopped' to be 'recording'`; the lineage write-event case FAILS with `expected 'recording' to be 'stopped'`. Record the actual output — if any of them already passes, stop and work out why before writing implementation, because the test is not exercising the change.

- [ ] **Step 3: Add the timestamp helper**

In `apps/cli/src/streams.ts`, replacing `isFreshEnoughToRecord`:

```ts
/**
 * The newer of two ISO timestamps, `""` meaning absent.
 *
 * Epoch-compared rather than lexical, because callers mix timestamps from
 * both logs and the two write different precision - see the Global
 * Constraints and `scanHooks`'s `since` comment.
 */
function newerOf(a: string, b: string): string {
	if (a === "") return b;
	if (b === "") return a;
	return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}
```

- [ ] **Step 4: Delete the wall clock**

Remove `export const RECORDING_FRESHNESS_LIMIT_MS` and its docstring, and `isFreshEnoughToRecord`. Then:

```bash
grep -rn "RECORDING_FRESHNESS_LIMIT_MS\|isFreshEnoughToRecord" apps/cli/src
```

Every hit must be removed, including the import and the assertions in `streams.test.ts` that name the constant. Tests that exercised *stale evidence reads unknown* keep their intent but move to the opportunity denominator — rewrite them rather than deleting them.

- [ ] **Step 5: Rewrite `computeVerdict`**

```ts
function computeVerdict(
	entry: StreamEntry,
	fresh: ReturnType<typeof outputFreshness> | undefined,
	events: Awaited<ReturnType<typeof scanEvents>>,
	hooks: Awaited<ReturnType<typeof scanHooks>>,
	now: Date,
): Verdict {
	// Unreadable sources never yield a clean bill - the promise this module
	// makes everywhere. Checked before anything else so no branch below can
	// certify a stream off evidence we could not actually read.
	if (events.missing) {
		return {
			kind: "unknown",
			detail: "the event log could not be read",
		};
	}

	// --- alive: did this plugin run at all? -----------------------------
	// Both axes, because neither alone covers the table. Several entries
	// have no unconditional event (counsel emits only when it writes the
	// brief; warden only on a blocked gate or a detected threat), and
	// archivist has no distinguishing prefix at all - its only emission,
	// onlooker.artifact.ready, is shared. Hooks cover all of them, because
	// hook-health's EXIT trap registers a firing before any bail path.
	let lastLife = "";
	for (const prefix of entry.events) {
		lastLife = newerOf(lastLife, events.lastByPrefix[prefix] ?? "");
	}
	for (const hook of entry.hooks) {
		lastLife = newerOf(lastLife, hooks.hooks[hook]?.last ?? "");
	}

	// --- lastWrite: did the downstream move, where that is even askable? -
	// Defined only where a write signal exists. Where none does, output
	// mtime is NOT a substitute: a week-old scribe `.md` means nothing was
	// worth distilling, and treating its age as evidence is the false alarm
	// this whole change exists to remove.
	const writeHooks = entry.writeHooks ?? [];
	const writeEvents = entry.writeEvents ?? [];

	let lastWrite: string | undefined;
	if (entry.output === null) {
		// An `output: null` stream writes no files by design, so its EVENTS
		// are its downstream - the substitution the old `output === null`
		// branch made, preserved here rather than lost to the unified rule.
		// Without it ecosystem's real failure shape goes undetected: its
		// trackers died on the outage date while its hooks kept firing, and
		// a liveness axis that counted those hooks would read `recording`
		// forever.
		//
		// So for these entries the axes SPLIT: `alive` is hooks only (below
		// it is recomputed to exclude events), and events play output's
		// part here. `writeHooks` gates it for the same reason it always
		// did - warden's hooks fire on every tool call and emit only on a
		// blocked gate or a detected threat, so without the gate a healthy
		// warden reads stopped the moment routine activity outruns its rare
		// emissions.
		if (writeHooks.length > 0) {
			lastWrite = "";
			for (const prefix of entry.events) {
				lastWrite = newerOf(lastWrite, events.lastByPrefix[prefix] ?? "");
			}
		}
	} else if (writeHooks.length > 0 || writeEvents.length > 0) {
		lastWrite = fresh?.mtime ?? "";
		for (const type of writeEvents) {
			lastWrite = newerOf(lastWrite, events.lastByType[type] ?? "");
		}
		// A write hook's own last firing is not a write - only its firing
		// COUNT since the last known write is evidence, and that is what
		// the stall check below consumes. Deliberately not folded in here.
	}

	// For an `output: null` entry the event axis is the downstream being
	// judged, so it cannot also serve as proof of life - that would compare
	// a signal against itself and never report anything.
	if (entry.output === null) {
		lastLife = "";
		for (const hook of entry.hooks) {
			lastLife = newerOf(lastLife, hooks.hooks[hook]?.last ?? "");
		}
	}

	// --- the denominator ------------------------------------------------
	const sinceLife = lastLife === "" ? null : opportunitiesSince(events, hooks, lastLife);

	if (lastLife === "") {
		// Never seen alive. Could be a fresh enable, could be broken. The
		// count of opportunities that have passed with nothing at all is
		// the only thing that separates them.
		const everything = opportunitiesSince(events, hooks, "1970-01-01T00:00:00.000Z");
		if (everything >= SESSION_STALL_THRESHOLD) {
			return {
				kind: "stopped",
				detail: `no events and no hook firings across ${everything} sessions`,
			};
		}
		return {
			kind: "unknown",
			detail: `no sign of life yet, and only ${everything} sessions to judge from`,
		};
	}

	if (sinceLife !== null && sinceLife >= SESSION_STALL_THRESHOLD) {
		return {
			kind: "stopped",
			detail: `last sign of life ${stamp(lastLife)}, ${sinceLife} sessions ago`,
		};
	}

	// Alive. Whether it should also have WRITTEN is a separate question, and
	// only askable where the table records a signal for it.
	if (lastWrite === undefined) {
		return {
			kind: "recording",
			detail: `last sign of life ${stamp(lastLife)}`,
		};
	}

	if (lastWrite === "") {
		return {
			kind: "unknown",
			detail: `alive since ${stamp(lastLife)}, but no output written yet`,
		};
	}

	const sinceWrite = opportunitiesSince(events, hooks, lastWrite);
	if (sinceWrite >= SESSION_STALL_THRESHOLD) {
		return {
			kind: "stopped",
			detail: `${outputLabel(entry)} last changed ${stamp(lastWrite)}, ${sinceWrite} sessions ago, while the stream kept running`,
		};
	}

	return {
		kind: "recording",
		detail: `${outputLabel(entry)} last changed ${stamp(lastWrite)}`,
	};
}
```

This deletes the `entry.output === null` branch, the `outputAt === null` branch, the `writeHooks.length === 0` fallback and the firing-count loop. That is the point: they were four answers to two questions. Read the old function once more before deleting to confirm no guard it carried is dropped silently — in particular `events.missing`, which is preserved above, and `fresh.unreadable`, which stays in `judge()` and is untouched.

Note `clearsCadenceFloor` and `toleranceFor` may become unreferenced. Do not delete them in this task; Task 9 decides, once the suite is green and it is clear whether `writeGateHours` still has a consumer.

- [ ] **Step 6: Add the `stamp` helper**

The detail strings above call `stamp`, which Task 8 defines properly. For now, add a placeholder implementation so this task compiles and its tests can run, and leave the sub-day formatting to Task 8:

```ts
/** Date for a detail string. Task 8 widens this to include the time when the gap is under a day. */
function stamp(iso: string): string {
	return iso.slice(0, 10);
}
```

- [ ] **Step 7: Thread `now` out if it is now unused**

`computeVerdict` no longer reads `now`. Run typecheck; if Biome or `tsc` flags the unused parameter, remove it from `computeVerdict`'s signature and from `judge`'s call — but keep `now` on `judge` and `surveyStreams`, because `clearsCadenceFloor` and the injectable-clock contract in `surveyStreams`'s docstring still depend on it.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
pnpm --filter @onlooker/cli exec vitest run src/__tests__/streams.test.ts
```

Expected: the six new tests PASS. Other tests in the file will fail — they assert the old branch behavior and old detail strings. Work through them one at a time, and for each decide explicitly: does this test encode a behavior the design deliberately changed (rewrite it), or has the change broken something real (fix the code)? Write the reasoning for each rewritten test in its comment. **Do not delete a failing test to make the suite green.**

- [ ] **Step 9: Full gate**

```bash
pnpm --filter @onlooker/cli test
pnpm --filter @onlooker/cli lint
pnpm --filter @onlooker/cli typecheck
```

Expected: all green, lint 0 errors 0 warnings.

- [ ] **Step 10: Commit**

```bash
git add apps/cli/src/streams.ts apps/cli/src/__tests__/streams.test.ts
```

Then `/commit`. Subject: `fix(cli): stop reading a quiet stream as a dead one :relieved:`. Body should name the three false positives, the lineage false negative the change must not lose, and the wall clock's removal. Refs `onlooker-ac5`.

---

## Task 7: The verification pass

Populate `writeEvents` for all seventeen entries from the plugin sources. This is the bulk of the work and the part that must not be guessed.

**Files:**
- Modify: `apps/cli/src/streams.ts` (the `STREAMS` table, ~lines 231–755)
- Read: `~/.claude-personal/plugins/marketplaces/onlooker-community/plugins/<plugin>/scripts/hooks/*.sh`
- Test: `apps/cli/src/__tests__/streams.test.ts`

**Interfaces:**
- Consumes: `StreamEntry.writeEvents` (Task 5), the rule (Task 6).
- Produces: table data only.

- [ ] **Step 1: Enumerate what each plugin actually emits**

For each of the seventeen entries, find every emission site:

```bash
MP=~/.claude-personal/plugins/marketplaces/onlooker-community/plugins
grep -rnE '_emit_event|emit_event |_emit ' $MP/<plugin>/scripts/ | head -30
```

Emission helper names differ per plugin (`lineage_emit_event`, `curator_emit`, `historian_emit`, `emit_safe`). Do not assume one name.

Cross-check against what the machine has actually seen, which catches an emission site that never fires in practice:

```bash
python3 - <<'PY'
import json, collections
c = collections.Counter()
with open('/Users/meaganwaller/.onlooker/logs/onlooker-events.jsonl', errors='replace') as f:
    for line in f:
        try: e = json.loads(line)
        except Exception: continue
        t = e.get('event_type', '')
        if t: c[t] += 1
for k, v in sorted(c.items()): print(f"{v:8}  {k}")
PY
```

- [ ] **Step 2: Decide each type against one question**

For every event type: **does emitting it imply the analytical output named by this entry's `output` was written?**

Yes only when the emit call and the write are the same code path with no bail between them. Known-good example, verified: `lineage-post-tool-use.sh:261` and `:340` call `lineage_emit_event "lineage.change.recorded"` at the ledger write site.

No whenever the emit sits on a scan/gate/heartbeat path. `curator.scan.complete` fires on every scan whether or not a finding changed; `governor.session.complete` fires on every session.

**When the source does not clearly settle it, set nothing.** An empty `writeSignals` routes to liveness, which cannot produce a false `stopped`. A wrong `writeEvents` can.

- [ ] **Step 2b: Re-examine `writeHooks` on the three `output: null` entries**

Task 6 changed what `writeHooks` *means* for compass, warden and ecosystem: it no longer feeds a firing count, it gates whether the event axis is judged as the downstream at all. Their existing values were set under the old meaning and need re-reading against the new one.

compass is the one to look at hardest. Its `writeHooks: ["compass-bash-gate"]` is justified in the table as "a write-pattern match reliably emits" — but the hook fires on *every* Bash call and emits only on a match, and hook-health's `EXIT` trap logs the firing either way. So the hook's firing does not imply an emission was due, which is precisely the implication `writeHooks` now asserts for these entries. The bead documents this as a live false positive: an hour of read-only Bash after the last file-modifying command reads `stopped`.

If the source confirms that reading, compass's `writeHooks` should be emptied, which routes it to liveness and makes the Task 6 compass test pass for the right reason rather than incidentally. Check warden and ecosystem the same way; warden's entry already documents why its hooks do not qualify.

- [ ] **Step 3: Record the decision in each entry's comment**

Follow the shape the existing `writeHooks` comments use — the reasoning, and the file and line that justifies it:

```ts
	{
		plugin: "lineage",
		output: "lineage",
		events: ["lineage"],
		// `lineage.change.recorded` is emitted at the ledger write site
		// itself (`lineage-post-tool-use.sh:261` and `:340`, both immediately
		// after the record is appended), so its silence IS the writes
		// stopping. This is what lets a frozen lineage be caught while
		// `lineage-post-tool-use` keeps firing - 2678 times in this repo's
		// sessions since 2026-08-30, against a ledger that had not moved.
		writeEvents: ["lineage.change.recorded"],
		hooks: ["lineage-post-tool-use"],
		perProject: true,
	},
```

- [ ] **Step 4: Verify the guard test now has something to check**

The first test from Task 5 asserts every `writeEvents` value matches one of its entry's `events` prefixes. It passed vacuously before; now it has data.

```bash
pnpm --filter @onlooker/cli exec vitest run src/__tests__/streams.test.ts -t "writeEvents"
```

Expected: PASS. A failure here means a typo in an event type — fix the table, not the test.

- [ ] **Step 5: Run against the real machine**

```bash
pnpm --filter @onlooker/cli build && node apps/cli/dist/onlooker.mjs doctor; echo "exit=$?"
```

Compare against the pre-change baseline, captured 2026-09-05:

```
archivist    unknown    output last changed 2026-08-07, no events recorded to compare
assayer      recording  output last changed 2026-09-05
bursar       recording  output last changed 2026-09-05
ecosystem    recording  last event 2026-09-05
inspector    recording  last event 2026-09-05
librarian    unknown    events since 2026-08-03, but no output yet - cannot tell ...
lineage      recording  output last changed 2026-09-05
exit=1
```

The four `recording` verdicts must stay `recording` — those streams are genuinely healthy and a regression here is a false alarm on a live machine. Detail strings will change; kinds must not, except where the design intends it. If a kind changes, explain it before continuing.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/streams.ts
```

Then `/commit`. Subject: `feat(cli): record which events actually mean a write happened :books:`.

---

## Task 8: Detail strings that survive a sub-day gap

`compass-bash-gate fired 2026-09-05, but the last event was 2026-09-05` is a verdict contradicting its own explanation — the real gap was 2h55m and the string prints dates only.

**Files:**
- Modify: `apps/cli/src/streams.ts` (`stamp`, added in Task 6)
- Test: `apps/cli/src/__tests__/streams.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("stamp", () => {
	it("prints a date for a gap measured in days", () => {
		expect(stampFor("2026-09-05T11:55:00Z", new Date("2026-09-12T00:00:00Z"))).toBe("2026-09-05");
	});

	it("prints the time too when the gap is under a day, so the detail can explain itself", () => {
		// The compass verdict that read "fired 2026-09-05, but the last event
		// was 2026-09-05" - two identical dates presented as a discrepancy.
		expect(stampFor("2026-09-05T11:55:00Z", new Date("2026-09-05T12:00:00Z"))).toBe(
			"2026-09-05 11:55",
		);
	});
});
```

Export `stamp` under a testable name (`stampFor`, taking the reference instant explicitly) rather than reading a clock inside it — the file's existing tests inject `now` everywhere for the reason its `surveyStreams` docstring gives: a test that depends on wall time fails at midnight.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @onlooker/cli exec vitest run src/__tests__/streams.test.ts -t "stamp"
```

Expected: FAIL on the second case — `expected '2026-09-05' to be '2026-09-05 11:55'`.

- [ ] **Step 3: Implement**

```ts
/**
 * How a timestamp reads inside a verdict's detail.
 *
 * Date alone for anything a day or more old, which is every ordinary stall.
 * Date and time when the gap is under a day, because a date-only rendering
 * of a sub-day gap produces a detail that refutes itself - the real verdict
 * this fixes read `compass-bash-gate fired 2026-09-05, but the last event
 * was 2026-09-05`, presenting two identical strings as a discrepancy, on a
 * gap of 2h55m.
 *
 * `reference` is passed rather than read from a clock so callers stay
 * testable - see `surveyStreams`'s `now`.
 */
export function stampFor(iso: string, reference: Date): string {
	const gap = reference.getTime() - new Date(iso).getTime();
	if (gap >= 24 * 60 * 60 * 1000) return iso.slice(0, 10);
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
```

Replace the Task 6 placeholder `stamp` with calls to `stampFor(iso, now)`. This is why `now` is kept on `judge` — thread it into `computeVerdict` again if Task 6 removed it.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @onlooker/cli exec vitest run src/__tests__/streams.test.ts
```

Expected: PASS, whole file green. Detail-string assertions written in Task 6 may need the time appended — update them.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/streams.ts apps/cli/src/__tests__/streams.test.ts
```

Then `/commit`. Subject: `fix(cli): let a sub-day gap explain itself :speech_balloon:`.

---

## Task 9: Final verification and dead-code sweep

- [ ] **Step 1: Check what the rewrite orphaned**

```bash
grep -rn "clearsCadenceFloor\|toleranceFor\|EVENT_OUTPUT_TOLERANCE_MS\|CADENCE_FLOOR_MULTIPLIER\|writeGateHours" apps/cli/src
```

If a symbol is referenced only by its own definition and its own unit tests, it is dead. `EVENT_OUTPUT_TOLERANCE_MS` almost certainly is — the gap-versus-tolerance comparison it existed for is gone. `writeGateHours` may be: the new rule counts opportunities rather than hours, so a gated writer no longer needs a wall-clock allowance. Decide each explicitly and record the reasoning in the commit; do not leave a constant in place "just in case," and do not delete one that a surviving branch still consults.

- [ ] **Step 2: Full monorepo gates**

```bash
pnpm --filter @onlooker/cli test
pnpm --filter @onlooker/cli lint
pnpm typecheck
pnpm lint
./node_modules/.bin/turbo run test --force
```

Expected: `apps/cli` 0 errors 0 warnings; the rest of the monorepo at its existing warning baseline, unchanged. Report the test count against the 257 baseline and account for the difference.

- [ ] **Step 3: Real-machine check**

```bash
pnpm --filter @onlooker/cli build
node apps/cli/dist/onlooker.mjs doctor; echo "exit=$?"
```

Then re-run the seventeen-entry survey with every entry force-enabled, the way the spec's evidence was gathered, and confirm counsel, governor and tribunal now read `stopped` rather than `unknown` — that is the capability half of this bead, and it is the one thing no unit test proves.

- [ ] **Step 4: Update the bead**

```bash
bd close onlooker-ac5 --reason "<what shipped, what the real machine reports now, what stayed open>"
```

State plainly whether both directions were fixed. If the capability half did not land, say so and file a follow-up rather than closing over it.

- [ ] **Step 5: Open the PR**

Use the `/pr` skill. The PR should lead with the measurement that reshaped the design — that a raw session count could not work, and why — because that is the part a reviewer cannot reconstruct from the diff.

---

## Self-review

**Spec coverage.** `writeEvents` field → Tasks 5, 7. The unified `alive`/`lastWrite` rule → Task 6. Opportunity denominator replacing the wall clock → Tasks 2, 3, 4, 6. `SESSION_STALL_THRESHOLD` = 5 → Task 5. Per-event-type conditionality → Task 1 (the spec asserted full event types without noticing `EventScan` had no per-type map; Task 1 closes that gap). Detail strings → Task 8. Verification pass → Task 7. Testing section, including the subagent case → Task 6 Step 1. Error handling → Task 6 Step 5, `events.missing` first. Follow-ups → untouched by design.

**Known soft spots, flagged rather than hidden.**

- Task 6 Step 8 says "other tests will fail" without enumerating which. That is honest — the current 257 tests were written against branches this task deletes, and predicting the exact set would be guesswork. The instruction to justify each rewrite individually, and the prohibition on deleting tests to go green, is the control.
- Task 7 is one task covering seventeen entries. It resists splitting: the decision rule is identical for each, and the entries share one file and one guard test. If it runs long, split by entry group at execution time rather than restructuring the plan.
- `machine()` gains `opportunities` and `subagentSessions` options in Task 6. Those helper edits are specified in prose rather than as a finished diff, because the helper's internals depend on how it currently threads `cwd` into the fixture rows, which the implementer will have in front of them.
