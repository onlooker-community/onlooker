# Lesson Contract v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an inference failure in the lesson transform incapable of producing a lesson that never expires, and widen `author_key` to a collision-safe width.

**Architecture:** `applies_to.versions` is replaced by `applies_to.scope`, a zod discriminated union on `kind`. The `versioned` branch requires a non-empty version map; the `version_independent` branch requires a written justification. `ZAuthorKey` widens from 12 to 32 hex, decoupled from `ZProjectKey`. Both schemas bump `schema_version` to 2. Every change regenerates the published JSON Schema in the same task, so the committed artifact never drifts from the zod source.

**Tech Stack:** TypeScript, zod 4.4.3, vitest, Biome, pnpm workspaces.

**Bead:** onlooker-i9j. Resolves onlooker-7jn and onlooker-5oz.

**Spec:** `docs/superpowers/specs/2026-08-08-promotion-pipeline-design.md`, Section 1.

## Global Constraints

- **zod is pinned to `4.4.3`.** Do not upgrade it. `z.toJSONSchema` behavior is load-bearing here.
- **Refinements never reach the JSON Schema.** `.check()` and `.refine()` are silently dropped by `z.toJSONSchema`. Any rule that must reach the plugins has to be expressed as a regex, a native zod constraint, or an explicit `.meta()` key.
- **`.meta()` does not affect runtime parsing.** It only annotates the emitted artifact. A rule needed on both sides must be written twice, once each way.
- **`.meta()` merges with `.describe()`** rather than replacing it — verified in 4.4.3. Prefer a single `.meta({ description, ... })` call over both.
- **Formatting is Biome with tabs.** Run `pnpm --filter @onlooker/lesson-contract lint:fix` before committing if unsure.
- **American English** in all comments and commit messages.
- **All commits route through the `/commit` skill**, per the repository's CLAUDE.md. Do not hand-write `git commit -m`.
- **`pnpm --filter @onlooker/lesson-contract build` regenerates the JSON Schema** — its script is `tsc --project tsconfig.build.json && node scripts/emit-json-schema.mjs`, so the emit always runs against a fresh `dist/`. Never run `emit-json-schema.mjs` directly against a stale build.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/lesson-contract/src/applies-to.ts` | `ZVersions`, `ZScope`, `ZAppliesTo` — the union that makes staleness structural | 1 |
| `packages/lesson-contract/src/applies-to.test.ts` | runtime behavior of the union, including the empty-map rejection | 1 |
| `packages/lesson-contract/src/json-schema.test.ts` | guards that constraints survive emission; paths move into the union | 1 |
| `packages/lesson-contract/src/index.ts` | barrel; gains `ZScope` / `TScope` | 1 |
| `packages/lesson-contract/src/primitives.ts` | `ZAuthorKey` widens; `ZProjectKey` unchanged | 2 |
| `packages/lesson-contract/src/lesson.ts` | `schema_version` literal; stale comments about `applies_to.versions` | 1, 3 |
| `packages/lesson-contract/src/lesson.test.ts` | fixture tracks all three changes | 1, 2, 3 |
| `packages/lesson-contract/src/counter-observation.ts` | `schema_version` literal | 3 |
| `packages/lesson-contract/src/counter-observation.test.ts` | fixture tracks author_key and version | 2, 3 |
| `packages/lesson-contract/schema/*.schema.json` | generated; regenerated at the end of every task | 1, 2, 3 |

Each task ends with the full suite green and the committed schema matching the
zod source. That is why regeneration is folded into every task rather than
saved for the end — the drift guard in `json-schema.test.ts` fails the moment
the source changes without a rebuild.

### A decision this plan makes that the spec does not cover

`ZCounterObservation` also declares `schema_version: z.literal(1)`, and its
`author_key` widens in Task 2, so its wire shape changes too. Section 1 of the
spec discusses only the Lesson's version. **This plan bumps both to 2 in Task
3.** Leaving them split would mean a v1 counter-observation carrying a v2-width
`author_key`, so the version number would no longer identify the shape. Raise
it with the spec author if that is wrong; it is the one judgment call here.

---

## Task 1: Replace `applies_to.versions` with the `scope` union

Resolves onlooker-7jn.

**Files:**
- Modify: `packages/lesson-contract/src/applies-to.ts` (full rewrite, 29 lines)
- Modify: `packages/lesson-contract/src/applies-to.test.ts` (full rewrite)
- Modify: `packages/lesson-contract/src/json-schema.test.ts:18-28` and `:53-58`
- Modify: `packages/lesson-contract/src/lesson.ts:10-22` (comments only)
- Modify: `packages/lesson-contract/src/lesson.test.ts:17-22` (fixture only)
- Modify: `packages/lesson-contract/src/index.ts:1`
- Regenerate: `packages/lesson-contract/schema/lesson.schema.json`

**Interfaces:**
- Consumes: `VERSION_RANGE` from `./primitives.js` (unchanged by this task)
- Produces: `ZScope` and `TScope`, exported from the barrel. `ZAppliesTo` keeps
  its name but its `versions` key is gone, replaced by `scope`. Shape:
  `{ stack: string[], scope: TScope, file_patterns: string[], task_kinds: string[] }`
  where `TScope` is
  `{ kind: "versioned", versions: Record<string, string> }` or
  `{ kind: "version_independent", justification: string }`.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `packages/lesson-contract/src/applies-to.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ZAppliesTo } from "./applies-to.js";

const valid = {
	stack: ["vitest", "vite"],
	scope: { kind: "versioned", versions: { vite: "<6", vitest: ">=4" } },
	file_patterns: ["**/vite.config.*", "**/package.json"],
	task_kinds: ["test-setup", "ci"],
};

const withVersions = (versions: Record<string, string>) => ({
	...valid,
	scope: { kind: "versioned", versions },
});

describe("ZAppliesTo", () => {
	it("accepts the stale vitest lesson's applicability", () => {
		expect(ZAppliesTo.parse(valid)).toEqual(valid);
	});

	it("accepts a two-sided range", () => {
		expect(ZAppliesTo.safeParse(withVersions({ vite: ">=4 <6" })).success).toBe(
			true,
		);
	});

	it("accepts a full three-part version", () => {
		expect(ZAppliesTo.safeParse(withVersions({ vite: ">=4.1.2" })).success).toBe(
			true,
		);
	});

	it("rejects a range with no comparator", () => {
		expect(ZAppliesTo.safeParse(withVersions({ vite: "4" })).success).toBe(false);
	});

	it("rejects free text where a range belongs", () => {
		expect(ZAppliesTo.safeParse(withVersions({ vite: "potato" })).success).toBe(
			false,
		);
	});

	it("rejects two bounds facing the same direction", () => {
		for (const range of [">4 >6", "<4 <2"]) {
			expect(ZAppliesTo.safeParse(withVersions({ vite: range })).success).toBe(
				false,
			);
		}
	});

	it("rejects an exact match carrying a second bound", () => {
		expect(ZAppliesTo.safeParse(withVersions({ vite: "=4 <6" })).success).toBe(
			false,
		);
	});

	it("requires at least one stack entry so a lesson cannot match everything", () => {
		expect(ZAppliesTo.safeParse({ ...valid, stack: [] }).success).toBe(false);
	});

	// The heart of onlooker-7jn. An empty map used to be legal and meant both
	// "no version dependency" and "inference failed", so a failed transform
	// silently produced a lesson that never expires.
	it("rejects an empty versions map, which could never expire", () => {
		expect(ZAppliesTo.safeParse(withVersions({})).success).toBe(false);
	});

	it("accepts a version-independent lesson that justifies itself", () => {
		expect(
			ZAppliesTo.safeParse({
				...valid,
				scope: {
					kind: "version_independent",
					justification:
						"The --frozen-lockfile flag has meant the same thing in every " +
						"pnpm major, so no version bound applies.",
				},
			}).success,
		).toBe(true);
	});

	it("rejects version_independent with no justification, so a failed inference cannot land here", () => {
		expect(
			ZAppliesTo.safeParse({
				...valid,
				scope: { kind: "version_independent" },
			}).success,
		).toBe(false);
	});

	it("rejects an empty justification", () => {
		expect(
			ZAppliesTo.safeParse({
				...valid,
				scope: { kind: "version_independent", justification: "" },
			}).success,
		).toBe(false);
	});

	it("rejects an unknown scope kind", () => {
		expect(
			ZAppliesTo.safeParse({ ...valid, scope: { kind: "whenever" } }).success,
		).toBe(false);
	});

	it("rejects the v1 shape that put versions at the top level", () => {
		const { scope, ...withoutScope } = valid;
		expect(
			ZAppliesTo.safeParse({ ...withoutScope, versions: { vite: "<6" } })
				.success,
		).toBe(false);
	});
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @onlooker/lesson-contract test`

Expected: FAIL. Most cases error because `scope` is an unrecognized key on a
`strictObject` and `versions` is missing.

- [ ] **Step 3: Write the union**

Replace the entire contents of `packages/lesson-contract/src/applies-to.ts`:

```ts
import { z } from "zod";
import { VERSION_RANGE } from "./primitives.js";

/**
 * Version constraints for a lesson whose truth depends on versions.
 *
 * Non-emptiness is enforced twice on purpose, because neither mechanism
 * reaches the other side. .check() covers runtime parsing, which is what
 * apps/api relies on at ingest. .meta() covers the emitted JSON Schema, which
 * is what the shell-based plugins validate against. Zod refinements are
 * silently dropped by z.toJSONSchema, and .meta() does not affect parsing, so
 * using only .meta() would leave the enforcement boundary accepting values the
 * published artifact rejects.
 */
const ZVersions = z
	.record(z.string().min(1), z.string().regex(VERSION_RANGE))
	.check((ctx) => {
		if (Object.keys(ctx.value).length === 0) {
			ctx.issues.push({
				code: "custom",
				input: ctx.value,
				message: "versions must not be empty",
			});
		}
	})
	.meta({
		description:
			'Comparator-prefixed version ranges keyed by stack entry, for ' +
			'example {"vite": "<6"}. A two-sided range reads lower bound ' +
			"then upper bound. Multiple entries combine with AND: every " +
			"entry must match for the lesson to still apply.",
		minProperties: 1,
	});

/**
 * How a lesson's applicability is bounded in time.
 *
 * A tagged union rather than an optional map, because one field cannot carry
 * two meanings. "This lesson has no version dependency" and "the transform
 * could not infer a version" are different facts, and an empty map expressed
 * both. A lesson with no version constraint never expires, so an inference
 * failure used to mint an immortal lesson silently.
 *
 * The version_independent branch demands a justification precisely so that a
 * transform which simply failed has nothing to put there. It cannot default
 * into this branch; it fails validation instead. The justification is also
 * what the tribunal's scope_accuracy criterion scores.
 */
export const ZScope = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("versioned"), versions: ZVersions }),
	z.strictObject({
		kind: z.literal("version_independent"),
		justification: z
			.string()
			.min(1)
			.describe(
				"Why this lesson holds regardless of version. Judged, not assumed.",
			),
	}),
]);
export type TScope = z.infer<typeof ZScope>;

/**
 * What retrieval matches a lesson against.
 *
 * scope is the field that makes staleness structural. Scoping a lesson to
 * vite <6 means a session on vite 8 never matches it, so the lesson retires
 * itself by construction rather than waiting for someone to review it.
 */
export const ZAppliesTo = z.strictObject({
	stack: z.array(z.string().min(1)).min(1),
	scope: ZScope,
	file_patterns: z.array(z.string().min(1)),
	task_kinds: z.array(z.string().min(1)),
});
export type TAppliesTo = z.infer<typeof ZAppliesTo>;
```

- [ ] **Step 4: Export the new type from the barrel**

In `packages/lesson-contract/src/index.ts`, replace line 1:

```ts
export {
	type TAppliesTo,
	type TScope,
	ZAppliesTo,
	ZScope,
} from "./applies-to.js";
```

- [ ] **Step 5: Update the lesson fixture**

In `packages/lesson-contract/src/lesson.test.ts`, replace the `applies_to`
block (lines 17-22):

```ts
	applies_to: {
		stack: ["vitest", "vite"],
		scope: { kind: "versioned", versions: { vite: "<6", vitest: ">=4" } },
		file_patterns: ["**/vite.config.*"],
		task_kinds: ["test-setup", "ci"],
	},
```

- [ ] **Step 6: Update the two stale comments in `lesson.ts`**

In `packages/lesson-contract/src/lesson.ts`, replace lines 9-22 (the `ZStatus`
doc comment and its `.describe`) so both say `scope` instead of
`applies_to.versions`:

```ts
/**
 * Lifecycle states. Note what is absent: there is no "expired".
 *
 * When applies_to.scope stops matching, nothing happens to the record at all.
 * Storing an expired state would require a job sweeping the pool to set it,
 * which is the review-queue failure mode this design exists to avoid.
 */
export const ZStatus = z
	.enum(["active", "refuted", "superseded", "retracted"])
	.describe(
		"Lifecycle state. There is no 'expired' state: expiry is structural " +
			"— when applies_to.scope stops matching, this field does not " +
			"change.",
	);
```

- [ ] **Step 7: Move the JSON Schema assertions into the union**

In `packages/lesson-contract/src/json-schema.test.ts`, add this helper directly
below the imports:

```ts
/**
 * The versioned branch of applies_to.scope. Found by discriminator rather than
 * by index so the test does not depend on how zod happens to order oneOf.
 */
const versionedBranch = (json: Record<string, any>) =>
	json.properties.applies_to.properties.scope.oneOf.find(
		(branch: any) => branch.properties.kind.const === "versioned",
	);
```

Replace the test at lines 18-28 with:

```ts
	it("keeps the version-range pattern, which refinements would have lost", () => {
		const json = z.toJSONSchema(ZLesson) as Record<string, any>;
		const pattern =
			versionedBranch(json).properties.versions.additionalProperties.pattern;

		expect(pattern).toBeDefined();
		expect(new RegExp(pattern).test("<6")).toBe(true);
		expect(new RegExp(pattern).test(">=4 <6")).toBe(true);
		expect(new RegExp(pattern).test("potato")).toBe(false);
	});

	// The artifact half of the non-empty rule. Its runtime twin lives in
	// applies-to.test.ts. Both are asserted because .meta() does not affect
	// parsing and .check() does not reach the artifact, so the two can drift.
	it("carries the non-empty versions rule into the artifact", () => {
		const json = z.toJSONSchema(ZLesson) as Record<string, any>;
		expect(versionedBranch(json).properties.versions.minProperties).toBe(1);
	});

	it("publishes both scope branches so plugins can emit either", () => {
		const json = z.toJSONSchema(ZLesson) as Record<string, any>;
		const kinds = json.properties.applies_to.properties.scope.oneOf.map(
			(branch: any) => branch.properties.kind.const,
		);
		expect(kinds.sort()).toEqual(["version_independent", "versioned"]);
	});
```

Replace the test at lines 53-58 with:

```ts
	it("carries the versions AND-combining rule into the artifact", () => {
		const json = z.toJSONSchema(ZLesson) as Record<string, any>;
		expect(versionedBranch(json).properties.versions.description).toMatch(/AND/);
	});
```

- [ ] **Step 8: Rebuild so the committed schema matches the source**

Run: `pnpm --filter @onlooker/lesson-contract build`

Expected: writes `schema/lesson.schema.json` and
`schema/counter-observation.schema.json`. `git diff` should show `scope` with
its `oneOf` replacing the old `versions` key in the lesson schema.

- [ ] **Step 9: Run the full suite**

Run: `pnpm --filter @onlooker/lesson-contract test`

Expected: PASS, including the committed-schema drift guard.

- [ ] **Step 10: Lint**

Run: `pnpm --filter @onlooker/lesson-contract lint`

Expected: no findings. If Biome reports formatting, run `lint:fix` and re-run
the suite.

- [ ] **Step 11: Commit**

Use the `/commit` skill with these files:

```
packages/lesson-contract/src/applies-to.ts
packages/lesson-contract/src/applies-to.test.ts
packages/lesson-contract/src/json-schema.test.ts
packages/lesson-contract/src/lesson.ts
packages/lesson-contract/src/lesson.test.ts
packages/lesson-contract/src/index.ts
packages/lesson-contract/schema/lesson.schema.json
```

Suggested subject: `fix(lesson-contract): make an unexpiring lesson unrepresentable :lock:`

The body should explain that an empty versions map meant both "no version
dependency" and "inference failed", so a failed transform silently produced a
lesson that never expires.

---

## Task 2: Widen `ZAuthorKey` to 32 hex

Resolves onlooker-5oz.

**Files:**
- Modify: `packages/lesson-contract/src/primitives.ts:23-36`
- Modify: `packages/lesson-contract/src/lesson.test.ts:28` (fixture) plus a new case
- Modify: `packages/lesson-contract/src/counter-observation.test.ts:12` (fixture) plus a new case
- Regenerate: both files in `packages/lesson-contract/schema/`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ZAuthorKey` now matches `/^[0-9a-f]{32}$/`. `ZProjectKey` is
  unchanged at `/^[0-9a-f]{12}$/`. Any fixture with a 12-hex `author_key`
  becomes invalid.

- [ ] **Step 1: Write the failing tests**

In `packages/lesson-contract/src/lesson.test.ts`, change the fixture's
`author_key` field to a 32-character value:

```ts
	author_key: "b3f1c2d4e5a67890b3f1c2d4e5a67890",
```

Then add this case as the **last** test inside the `describe("ZLesson")` block
— appending rather than inserting keeps Task 3's references stable:

```ts
	it("rejects the old 12-hex author_key width", () => {
		expect(
			ZLesson.safeParse({ ...valid, author_key: "b3f1c2d4e5a6" }).success,
		).toBe(false);
	});
```

In `packages/lesson-contract/src/counter-observation.test.ts`, change the
fixture's `author_key` field:

```ts
	author_key: "c4d5e6f7a8b90123c4d5e6f7a8b90123",
```

Then add this case as the **last** test inside the
`describe("ZCounterObservation")` block:

```ts
	it("rejects the old 12-hex author_key width", () => {
		expect(
			ZCounterObservation.safeParse({
				...valid,
				author_key: "c4d5e6f7a8b9",
			}).success,
		).toBe(false);
	});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @onlooker/lesson-contract test`

Expected: FAIL. The 32-hex fixtures are rejected by the current 12-hex regex,
and both new cases fail because 12 hex is still accepted.

- [ ] **Step 3: Widen the primitive**

In `packages/lesson-contract/src/primitives.ts`, replace lines 23-36:

```ts
/**
 * Opaque 32-character hex author identifier, derived per visibility scope as
 * HMAC(user_secret, scope). Pinning the format matters: this field carries
 * the unlinkability guarantee, and an unconstrained string would happily
 * accept a plaintext email address.
 *
 * Deliberately wider than ZProjectKey. project_key is a local-only label with
 * no security role, while author_key is what org revocation and public
 * blocking act on, so a collision would block an innocent author alongside a
 * bad actor. 128 bits makes that negligible; truncating further buys nothing,
 * because the field is not size-constrained anywhere that matters.
 */
export const ZAuthorKey = z
	.string()
	.regex(/^[0-9a-f]{32}$/)
	.describe(
		"Derived per visibility scope from the author's secret; not " +
			"linkable across scopes.",
	);
export type TAuthorKey = z.infer<typeof ZAuthorKey>;
```

Leave `ZProjectKey` (lines 15-21) exactly as it is.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @onlooker/lesson-contract test`

Expected: FAIL on the drift guard only — the committed schema still carries the
old pattern. Every other test passes.

- [ ] **Step 5: Rebuild so the committed schema matches**

Run: `pnpm --filter @onlooker/lesson-contract build`

Expected: both schema files now show `"pattern": "^[0-9a-f]{32}$"` for
`author_key`, and `project_key` still shows `{12}` in the lesson schema.

- [ ] **Step 6: Run the full suite**

Run: `pnpm --filter @onlooker/lesson-contract test`

Expected: PASS.

- [ ] **Step 7: Commit**

Use the `/commit` skill with these files:

```
packages/lesson-contract/src/primitives.ts
packages/lesson-contract/src/lesson.test.ts
packages/lesson-contract/src/counter-observation.test.ts
packages/lesson-contract/schema/lesson.schema.json
packages/lesson-contract/schema/counter-observation.schema.json
```

Suggested subject: `fix(lesson-contract): widen author_key to 128 bits :key:`

The body should explain that `author_key` is what org revocation and public
blocking act on, so a collision blocks an innocent author alongside a bad
actor, and that `project_key` stays at 12 because it has no security role.

---

## Task 3: Bump `schema_version` to 2

**Files:**
- Modify: `packages/lesson-contract/src/lesson.ts` (the `schema_version` line in `ZLesson`)
- Modify: `packages/lesson-contract/src/counter-observation.ts` (the `schema_version` line in `ZCounterObservation`)
- Modify: `packages/lesson-contract/src/lesson.test.ts` (fixture, plus the test titled `rejects a schema_version other than 1`)
- Modify: `packages/lesson-contract/src/counter-observation.test.ts` (fixture, plus a new case)

Line numbers are deliberately omitted here: Tasks 1 and 2 both edit these test
files, so anchor on the fixture field and the test title instead.
- Regenerate: both files in `packages/lesson-contract/schema/`

**Interfaces:**
- Consumes: nothing new.
- Produces: both `ZLesson` and `ZCounterObservation` accept only
  `schema_version: 2`. This is the version the `apps/api` ingest boundary will
  key its `N` / `N-1` window on.

- [ ] **Step 1: Write the failing tests**

In `packages/lesson-contract/src/lesson.test.ts`, change the fixture's
`schema_version` field:

```ts
	schema_version: 2,
```

Replace the test titled `rejects a schema_version other than 1` with:

```ts
	it("rejects any schema_version other than 2", () => {
		for (const schema_version of [1, 3]) {
			expect(ZLesson.safeParse({ ...valid, schema_version }).success).toBe(
				false,
			);
		}
	});
```

In `packages/lesson-contract/src/counter-observation.test.ts`, change the
fixture's `schema_version` field:

```ts
	schema_version: 2,
```

Then add this case inside the `describe("ZCounterObservation")` block:

```ts
	it("rejects any schema_version other than 2", () => {
		for (const schema_version of [1, 3]) {
			expect(
				ZCounterObservation.safeParse({ ...valid, schema_version }).success,
			).toBe(false);
		}
	});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @onlooker/lesson-contract test`

Expected: FAIL. Both fixtures are rejected because the literal is still 1, and
both new cases fail because 1 is still accepted.

- [ ] **Step 3: Bump both literals**

In `packages/lesson-contract/src/lesson.ts`, inside `ZLesson`, change
`schema_version: z.literal(1)` to:

```ts
	schema_version: z.literal(2),
```

In `packages/lesson-contract/src/counter-observation.ts`, inside
`ZCounterObservation`, make the identical change:

```ts
	schema_version: z.literal(2),
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @onlooker/lesson-contract test`

Expected: FAIL on the drift guard only. Every other test passes.

- [ ] **Step 5: Rebuild so the committed schema matches**

Run: `pnpm --filter @onlooker/lesson-contract build`

Expected: both schema files show `"const": 2` for `schema_version`.

- [ ] **Step 6: Run the full suite**

Run: `pnpm --filter @onlooker/lesson-contract test`

Expected: PASS.

- [ ] **Step 7: Verify the whole workspace still builds**

Run: `pnpm --filter @onlooker/lesson-contract typecheck && pnpm --filter @onlooker/lesson-contract lint`

Expected: both clean. Nothing outside this package imports the contract yet, so
no other workspace package should need changes. If something does, stop and
report it rather than editing it here.

- [ ] **Step 8: Commit**

Use the `/commit` skill with these files:

```
packages/lesson-contract/src/lesson.ts
packages/lesson-contract/src/counter-observation.ts
packages/lesson-contract/src/lesson.test.ts
packages/lesson-contract/src/counter-observation.test.ts
packages/lesson-contract/schema/lesson.schema.json
packages/lesson-contract/schema/counter-observation.schema.json
```

Suggested subject: `feat(lesson-contract)!: bump schema_version to 2 :arrow_up:`

The body should note that the scope union and the wider `author_key` both
change the wire shape, and that the counter-observation bumps alongside the
lesson so the version still identifies the shape.

- [ ] **Step 9: Close the beads**

```bash
bd close onlooker-i9j onlooker-7jn onlooker-5oz --reason="Lesson contract v2 shipped: applies_to.scope union makes an unexpiring lesson unrepresentable, author_key widened to 128 bits."
```

---

## Definition of Done

- `pnpm --filter @onlooker/lesson-contract test` passes, including the
  committed-schema drift guard
- An empty `versions` map is rejected **at runtime and in the emitted JSON
  Schema**, asserted by two separate tests in two separate files
- `version_independent` without a justification is rejected
- `author_key` requires 32 hex; `project_key` still requires 12
- Both schemas declare `schema_version: 2`
- `schema/lesson.schema.json` and `schema/counter-observation.schema.json` are
  committed and match a fresh build
- onlooker-i9j, onlooker-7jn and onlooker-5oz are closed

## Not in this plan

The transform, the tribunal rubric, and the approved pool live in the
`onlooker-community` plugin repo and are tracked by onlooker-97e. Sections 2
and 3 of the spec cover them. Nothing in this plan touches `apps/api`, which
does not consume the contract yet.

**No `N-1` translation layer is built**, and that is deliberate rather than an
omission. The spec commits the server to accepting `schema_version` `N` and
`N-1`, but no plugin has ever emitted a v1 lesson, so there is nothing to
translate. Building the path now would mean maintaining a no-op. It belongs
with the `apps/api` ingest endpoint in subsystem 3, by which point there will
be real v2 producers to keep working across a future bump to 3.
