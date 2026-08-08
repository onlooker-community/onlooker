# Shared Lesson Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@onlooker/lesson-contract` — the single zod definition of a Lesson, plus the generated JSON Schema artifact that lets shell-based plugins in a separate repository validate against the same contract.

**Architecture:** One zod schema is the source of truth. A build step runs `z.toJSONSchema` over it to emit `schema/*.schema.json`, which is the artifact that crosses the repo boundary. `apps/api` will later import the zod schema directly and enforce at the sync endpoint. This plan builds the contract package only — no sync endpoint, no storage, no retrieval.

**Tech Stack:** TypeScript 5.6, zod 4.4.3, vitest 4.1.9, tsc build (mirrors `packages/auth-core`), pnpm workspace + turbo.

**Spec:** `docs/superpowers/specs/2026-08-06-shared-lesson-contract-design.md`

## Global Constraints

- **Never use `.refine()` for a constraint that must cross the repo boundary.** Verified in this workspace: `z.toJSONSchema` **silently drops** refinements — no error, the constraint simply vanishes from the emitted artifact. A refined constraint would be enforced server-side and absent from what plugins validate against. Use `.regex()`, which survives as `pattern`. Cross-field rules that cannot be expressed without `.refine()` belong in server-side ingest logic, not in this schema.
- **Always use `z.strictObject`, never `z.object`.** Verified in this workspace: `z.object` silently *strips* unknown keys and reports success, yet emits `additionalProperties: false` into the JSON Schema. That is the same divergence in the opposite direction — a plugin validating against the artifact would reject a payload the server quietly accepts and mangles. `z.strictObject` rejects unknown keys, which both matches the emitted schema and is the right behavior for a wire contract, where an unrecognized field means the sender knows something the receiver does not.
- zod pinned to `4.4.3` exactly — matches `packages/types` and `packages/cache`. `pnpm-workspace.yaml` sets `saveExact: true`.
- Package mirrors `packages/auth-core`: `type: module`, `main: dist/index.js`, build via `tsc --project tsconfig.build.json`, `test: vitest run`, no vitest config file (defaults pick up `src/**/*.test.ts`).
- Biome: `{"root": false, "extends": ["@onlooker/config-biome/library.json"]}`. Root config sets **tabs**, line width 80. Do not extend the bare package name — see bead onlooker-go2.
- `schema_version` is `1` for both record types in this plan.
- American English throughout.
- No changes to `turbo.json` task *registration* are needed: generic `build` / `lint` / `test` / `typecheck` tasks already apply to every workspace package, and `pnpm-workspace.yaml` already globs `packages/*`. One change to task `outputs` was needed post-review: the generic `build` task only declared `dist/**` and `.next/**`, so `schema/**` had to be added — this is the one package whose build writes outside `dist/`, and without it a warm turbo cache could restore `dist/` without regenerating the committed schema artifact.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/lesson-contract/package.json` | manifest, scripts, deps |
| `packages/lesson-contract/tsconfig.json` | compiler options (extends shared base) |
| `packages/lesson-contract/tsconfig.build.json` | excludes tests from `dist` |
| `packages/lesson-contract/biome.json` | lint config |
| `packages/lesson-contract/src/primitives.ts` | `ZUlid`, `ZProjectKey`, `VERSION_RANGE` |
| `packages/lesson-contract/src/evidence.ts` | `ZEvidence` |
| `packages/lesson-contract/src/applies-to.ts` | `ZAppliesTo` — the staleness mechanism |
| `packages/lesson-contract/src/lesson.ts` | `ZLesson` composed from the above |
| `packages/lesson-contract/src/counter-observation.ts` | `ZCounterObservation` |
| `packages/lesson-contract/src/index.ts` | barrel — the package's public surface |
| `packages/lesson-contract/scripts/emit-json-schema.mjs` | writes `schema/*.schema.json` from `dist/` |
| `packages/lesson-contract/schema/*.schema.json` | generated artifact, committed |

Files are split by contract concern rather than by layer, so a change to applicability rules touches one file.

---

## Task 1: Package skeleton and evidence schema

**Files:**
- Create: `packages/lesson-contract/package.json`
- Create: `packages/lesson-contract/tsconfig.json`
- Create: `packages/lesson-contract/tsconfig.build.json`
- Create: `packages/lesson-contract/biome.json`
- Create: `packages/lesson-contract/src/primitives.ts`
- Create: `packages/lesson-contract/src/evidence.ts`
- Test: `packages/lesson-contract/src/evidence.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ZUlid`, `TUlid`, `ZProjectKey` from `./primitives.js`; `ZEvidence`, `TEvidence` from `./evidence.js`.

- [ ] **Step 1: Create the package manifest**

`packages/lesson-contract/package.json`:

```json
{
	"name": "@onlooker/lesson-contract",
	"version": "0.0.1",
	"private": true,
	"type": "module",
	"main": "dist/index.js",
	"types": "dist/index.d.ts",
	"scripts": {
		"build": "tsc --project tsconfig.build.json && node scripts/emit-json-schema.mjs",
		"dev": "tsc --watch",
		"lint": "biome check src",
		"lint:fix": "biome check --write src",
		"typecheck": "tsc --noEmit",
		"test": "vitest run"
	},
	"dependencies": {
		"zod": "4.4.3"
	},
	"devDependencies": {
		"@onlooker/config-biome": "workspace:*",
		"@onlooker/config-typescript": "workspace:*",
		"typescript": "^5.6.3",
		"vitest": "^4.1.9"
	}
}
```

- [ ] **Step 2: Create the three config files**

`packages/lesson-contract/tsconfig.json`:

```json
{
	"extends": "@onlooker/config-typescript/base.json",
	"compilerOptions": {
		"outDir": "dist",
		"declaration": true,
		"module": "ESNext",
		"target": "ES2022",
		"moduleResolution": "bundler"
	},
	"include": ["src"],
	"exclude": ["node_modules"]
}
```

`packages/lesson-contract/tsconfig.build.json`:

```json
{
	"extends": "./tsconfig.json",
	"exclude": [
		"node_modules",
		"dist",
		"**/*.test.ts",
		"**/*.spec.ts",
		"**/__tests__/**"
	]
}
```

`packages/lesson-contract/biome.json`:

```json
{
	"root": false,
	"extends": ["@onlooker/config-biome/library.json"]
}
```

- [ ] **Step 3: Install so pnpm links the workspace package**

Run: `pnpm install`
Expected: `Scope: all 14 workspace projects` (was 13).

- [ ] **Step 4: Write the failing test**

`packages/lesson-contract/src/evidence.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ZEvidence } from "./evidence.js";

const valid = {
	artifact_ids: ["01KZ45MKAM734ZS7JK24D2DK0R"],
	session_ids: ["e967f5f9-1234-4321-8888-abcdefabcdef"],
	project_key: "6a7678979e31",
	observed_at: "2026-08-03T15:59:48Z",
	resolution: "Upgraded vite 5.4.11 to 8.0.16; 267 tests pass.",
};

describe("ZEvidence", () => {
	it("accepts a real archivist-shaped artifact reference", () => {
		expect(ZEvidence.parse(valid)).toEqual(valid);
	});

	it("requires a resolution, because a claim without a fix is a warning", () => {
		const { resolution, ...withoutResolution } = valid;
		expect(ZEvidence.safeParse(withoutResolution).success).toBe(false);
	});

	it("rejects an empty resolution string", () => {
		expect(ZEvidence.safeParse({ ...valid, resolution: "" }).success).toBe(
			false,
		);
	});

	it("requires at least one artifact id", () => {
		expect(ZEvidence.safeParse({ ...valid, artifact_ids: [] }).success).toBe(
			false,
		);
	});

	it("requires at least one session id", () => {
		expect(ZEvidence.safeParse({ ...valid, session_ids: [] }).success).toBe(
			false,
		);
	});

	it("rejects a lowercase ulid", () => {
		expect(
			ZEvidence.safeParse({
				...valid,
				artifact_ids: ["01kz45mkam734zs7jk24d2dk0r"],
			}).success,
		).toBe(false);
	});

	it("rejects a project_key that is not 12 hex characters", () => {
		expect(
			ZEvidence.safeParse({ ...valid, project_key: "onlooker" }).success,
		).toBe(false);
	});
});
```

`session_ids` requires `.min(1)` — post-review fix, see Important finding M1: every
artifact came from a session, so an empty `session_ids` alongside a non-empty
`artifact_ids` is not a state the producer should be able to reach.

- [ ] **Step 5: Run the test and confirm it fails**

Run: `pnpm --filter @onlooker/lesson-contract test`
Expected: FAIL — `Failed to resolve import "./evidence.js"`.

- [ ] **Step 6: Write the primitives**

`packages/lesson-contract/src/primitives.ts`:

```ts
import { z } from "zod";

/**
 * ULID in Crockford base32, matching the archivist artifact convention
 * (for example 01KZ45MKAM734ZS7JK24D2DK0R). Uppercase only; I, L, O and U
 * are excluded from the alphabet.
 *
 * Expressed as a regex rather than a refinement on purpose: refinements are
 * silently dropped by z.toJSONSchema, so they would not reach the plugins
 * that validate against the published artifact.
 */
export const ZUlid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export type TUlid = z.infer<typeof ZUlid>;

/**
 * Opaque 12-character hex project hash. The project_key to remote_url
 * mapping lives only in the local manifest.json, so a shared lesson carries
 * technical facts without revealing which repository produced them.
 */
export const ZProjectKey = z.string().regex(/^[0-9a-f]{12}$/);
export type TProjectKey = z.infer<typeof ZProjectKey>;

/**
 * Opaque 12-character hex author identifier, derived per visibility scope as
 * HMAC(user_secret, scope). Pinning the format matters: this field carries
 * the unlinkability guarantee, and an unconstrained string would happily
 * accept a plaintext email address.
 */
export const ZAuthorKey = z
	.string()
	.regex(/^[0-9a-f]{12}$/)
	.describe(
		"Derived per visibility scope from the author's secret; not " +
			"linkable across scopes.",
	);
export type TAuthorKey = z.infer<typeof ZAuthorKey>;
```

`ZAuthorKey` is a post-review addition (Important finding 2): `author_key` was
originally left as `z.string().min(1)`, the only identity-bearing field in the
package without a format, even though the spec's unlinkability argument
depends on it being an opaque HMAC output rather than a plaintext identity.

- [ ] **Step 7: Write the evidence schema**

`packages/lesson-contract/src/evidence.ts`:

```ts
import { z } from "zod";
import { ZProjectKey, ZUlid } from "./primitives.js";

/**
 * The receipts behind a claim. resolution is required: a lesson that says
 * "this breaks" without "and this fixed it" is a warning, not a lesson, and
 * it gives tribunal judges nothing to check the claim against.
 */
export const ZEvidence = z.strictObject({
	artifact_ids: z.array(ZUlid).min(1),
	session_ids: z.array(z.string().min(1)).min(1),
	project_key: ZProjectKey,
	observed_at: z.iso.datetime(),
	resolution: z.string().min(1),
});
export type TEvidence = z.infer<typeof ZEvidence>;
```

- [ ] **Step 8: Run the test and confirm it passes**

Run: `pnpm --filter @onlooker/lesson-contract test`
Expected: PASS — 7 tests.

- [ ] **Step 9: Commit**

```bash
git add packages/lesson-contract pnpm-lock.yaml
git commit -m "feat(lesson-contract): add package skeleton and evidence schema :sparkles:"
```

---

## Task 2: Applicability and version ranges

This is the load-bearing task. `applies_to.versions` is what makes staleness structural — a lesson scoped to `vite <6` stops matching once a project moves to vite 8, with no review queue and no expiry job. If this field accepts garbage, the entire staleness mechanism silently fails.

**Files:**
- Modify: `packages/lesson-contract/src/primitives.ts` (add `VERSION_RANGE`)
- Create: `packages/lesson-contract/src/applies-to.ts`
- Test: `packages/lesson-contract/src/applies-to.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1's evidence; adds to `primitives.js`.
- Produces: `VERSION_RANGE` (a `RegExp`) from `./primitives.js`; `ZAppliesTo`, `TAppliesTo` from `./applies-to.js`.

- [ ] **Step 1: Write the failing test**

`packages/lesson-contract/src/applies-to.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ZAppliesTo } from "./applies-to.js";

const valid = {
	stack: ["vitest", "vite"],
	versions: { vite: "<6", vitest: ">=4" },
	file_patterns: ["**/vite.config.*", "**/package.json"],
	task_kinds: ["test-setup", "ci"],
};

describe("ZAppliesTo", () => {
	it("accepts the stale vitest lesson's applicability", () => {
		expect(ZAppliesTo.parse(valid)).toEqual(valid);
	});

	it("accepts a two-sided range", () => {
		expect(
			ZAppliesTo.safeParse({ ...valid, versions: { vite: ">=4 <6" } }).success,
		).toBe(true);
	});

	it("accepts a full three-part version", () => {
		expect(
			ZAppliesTo.safeParse({ ...valid, versions: { vite: ">=4.1.2" } })
				.success,
		).toBe(true);
	});

	it("rejects a range with no comparator", () => {
		expect(
			ZAppliesTo.safeParse({ ...valid, versions: { vite: "4" } }).success,
		).toBe(false);
	});

	it("rejects free text where a range belongs", () => {
		expect(
			ZAppliesTo.safeParse({ ...valid, versions: { vite: "potato" } }).success,
		).toBe(false);
	});

	it("rejects two bounds facing the same direction", () => {
		for (const range of [">4 >6", "<4 <2"]) {
			expect(
				ZAppliesTo.safeParse({ ...valid, versions: { vite: range } }).success,
			).toBe(false);
		}
	});

	it("rejects an exact match carrying a second bound", () => {
		expect(
			ZAppliesTo.safeParse({ ...valid, versions: { vite: "=4 <6" } }).success,
		).toBe(false);
	});

	it("requires at least one stack entry so a lesson cannot match everything", () => {
		expect(ZAppliesTo.safeParse({ ...valid, stack: [] }).success).toBe(false);
	});

	it("allows an empty versions map for version-independent lessons", () => {
		expect(ZAppliesTo.safeParse({ ...valid, versions: {} }).success).toBe(true);
	});
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @onlooker/lesson-contract test`
Expected: FAIL — `Failed to resolve import "./applies-to.js"`.

- [ ] **Step 3: Add the version range pattern to primitives**

Append to `packages/lesson-contract/src/primitives.ts`:

```ts
const VERSION_PART = String.raw`\d+(\.\d+)?(\.\d+)?`;
const COMPARATOR = "(<|<=|>|>=|=)";

/**
 * A comparator-prefixed version range: "<6", ">=4", ">=4 <6", ">=4.1.2".
 *
 * A bare "4" is rejected deliberately. It could mean "exactly 4" or "4 and
 * above", and this field decides whether a lesson is still true, so an
 * ambiguous value is worse than a rejected one.
 *
 * A two-sided range must read lower bound first, upper bound second, so
 * ">4 >6", "<4 <2" and "=4 <6" are all rejected. Without that constraint a
 * pair of same-facing comparators would validate as a "range" while
 * describing no interval at all.
 *
 * Residual limitation: ">6 <2" still validates. Rejecting it means comparing
 * magnitudes, which a regex cannot do and which .refine() must not do here
 * (refinements vanish from the emitted JSON Schema). That check belongs with
 * the other cross-field rules in server-side ingest.
 *
 * Built with RegExp rather than a literal so the pattern stays inside the
 * 80-column limit; z.toJSONSchema reads .source either way, so it still
 * emits as `pattern`.
 */
export const VERSION_RANGE = new RegExp(
	`^(${COMPARATOR}${VERSION_PART}|(>|>=)${VERSION_PART} (<|<=)${VERSION_PART})$`,
);
```

- [ ] **Step 4: Write the applicability schema**

`packages/lesson-contract/src/applies-to.ts`:

```ts
import { z } from "zod";
import { VERSION_RANGE } from "./primitives.js";

/**
 * What retrieval matches a lesson against.
 *
 * versions is the field that makes staleness structural. Scoping a lesson to
 * vite <6 means a session on vite 8 never matches it, so the lesson retires
 * itself by construction rather than waiting for someone to review it.
 *
 * An empty versions map is allowed: some lessons genuinely do not depend on
 * a version. Such a lesson never expires on its own and can only leave the
 * pool through refutation or supersession.
 */
export const ZAppliesTo = z.strictObject({
	stack: z.array(z.string().min(1)).min(1),
	versions: z.record(z.string().min(1), z.string().regex(VERSION_RANGE)),
	file_patterns: z.array(z.string().min(1)),
	task_kinds: z.array(z.string().min(1)),
});
export type TAppliesTo = z.infer<typeof ZAppliesTo>;
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm --filter @onlooker/lesson-contract test`
Expected: PASS — 16 tests total.

- [ ] **Step 6: Commit**

```bash
git add packages/lesson-contract/src
git commit -m "feat(lesson-contract): validate version ranges so staleness cannot rot :lock:"
```

---

## Task 3: The Lesson record

**Files:**
- Create: `packages/lesson-contract/src/lesson.ts`
- Create: `packages/lesson-contract/src/index.ts`
- Test: `packages/lesson-contract/src/lesson.test.ts`

**Interfaces:**
- Consumes: `ZUlid` from `./primitives.js`, `ZEvidence` from `./evidence.js`, `ZAppliesTo` from `./applies-to.js`.
- Produces: `ZVisibility`, `ZStatus`, `ZSource`, `ZConsensus`, `ZLesson`, `TLesson` — all re-exported from `./index.js`.

- [ ] **Step 1: Write the failing test**

`packages/lesson-contract/src/lesson.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ZLesson } from "./lesson.js";

const valid = {
	id: "01KZ8FMKAM734ZS7JK24D2DK0R",
	schema_version: 1,
	claim: "Pin vitest and vite to compatible majors; vitest >=4 needs vite >=6.",
	rationale:
		"vitest 4 imports vite/module-runner, a subpath vite 5 does not export.",
	evidence: {
		artifact_ids: ["01KZ45MKAM734ZS7JK24D2DK0R"],
		session_ids: ["e967f5f9-1234-4321-8888-abcdefabcdef"],
		project_key: "6a7678979e31",
		observed_at: "2026-08-03T15:59:48Z",
		resolution: "Upgraded vite 5.4.11 to 8.0.16; 267 tests pass.",
	},
	applies_to: {
		stack: ["vitest", "vite"],
		versions: { vite: "<6", vitest: ">=4" },
		file_patterns: ["**/vite.config.*"],
		task_kinds: ["test-setup", "ci"],
	},
	visibility: "public",
	consensus: { judges: 3, agreed: 3, decided_at: "2026-08-06T12:00:00Z" },
	status: "active",
	superseded_by: null,
	source: "local",
	author_key: "b3f1c2d4e5a6",
	promoted_at: "2026-08-06T12:00:01Z",
};

describe("ZLesson", () => {
	it("accepts a complete lesson", () => {
		expect(ZLesson.parse(valid)).toEqual(valid);
	});

	it("accepts every lifecycle state including retracted", () => {
		for (const status of ["active", "refuted", "superseded", "retracted"]) {
			expect(ZLesson.safeParse({ ...valid, status }).success).toBe(true);
		}
	});

	it("rejects expired as a status, because expiry is not a state", () => {
		expect(ZLesson.safeParse({ ...valid, status: "expired" }).success).toBe(
			false,
		);
	});

	it("accepts a superseded_by pointer", () => {
		expect(
			ZLesson.safeParse({
				...valid,
				status: "superseded",
				superseded_by: "01KZ9AMKAM734ZS7JK24D2DK0R",
			}).success,
		).toBe(true);
	});

	it("rejects an unknown visibility tier", () => {
		expect(ZLesson.safeParse({ ...valid, visibility: "team" }).success).toBe(
			false,
		);
	});

	it("rejects a schema_version other than 1", () => {
		expect(ZLesson.safeParse({ ...valid, schema_version: 2 }).success).toBe(
			false,
		);
	});

	it("rejects unknown top-level fields", () => {
		expect(ZLesson.safeParse({ ...valid, injected: true }).success).toBe(false);
	});

	it("rejects an email address as an author_key", () => {
		expect(
			ZLesson.safeParse({
				...valid,
				author_key: "meagan@example.com",
			}).success,
		).toBe(false);
	});
});
```

The `author_key` rejection test is a post-review addition (Important finding 2)
that only passes once `author_key` uses `ZAuthorKey` rather than
`z.string().min(1)`; see Step 3 below.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @onlooker/lesson-contract test`
Expected: FAIL — `Failed to resolve import "./lesson.js"`.

- [ ] **Step 3: Write the lesson schema**

`packages/lesson-contract/src/lesson.ts`:

```ts
import { z } from "zod";
import { ZAppliesTo } from "./applies-to.js";
import { ZEvidence } from "./evidence.js";
import { ZAuthorKey, ZUlid } from "./primitives.js";

export const ZVisibility = z.enum(["private", "org", "public"]);
export type TVisibility = z.infer<typeof ZVisibility>;

/**
 * Lifecycle states. Note what is absent: there is no "expired".
 *
 * When applies_to.versions stops matching, nothing happens to the record at
 * all. Storing an expired state would require a job sweeping the pool to set
 * it, which is the review-queue failure mode this design exists to avoid.
 */
export const ZStatus = z.enum([
	"active",
	"refuted",
	"superseded",
	"retracted",
]);
export type TStatus = z.infer<typeof ZStatus>;

export const ZSource = z.enum(["local", "org", "public"]);
export type TSource = z.infer<typeof ZSource>;

/**
 * The tribunal's verdict.
 *
 * agreed <= judges is deliberately NOT enforced here. Expressing it would
 * require .refine(), which z.toJSONSchema silently drops, so the rule would
 * hold server-side and be invisible in the published artifact. Cross-field
 * rules belong in ingest logic where both sides can see the same error.
 */
export const ZConsensus = z.strictObject({
	judges: z.number().int().min(1),
	agreed: z.number().int().min(0),
	decided_at: z.iso.datetime(),
});
export type TConsensus = z.infer<typeof ZConsensus>;

export const ZLesson = z.strictObject({
	id: ZUlid,
	schema_version: z.literal(1),

	claim: z.string().min(1),
	rationale: z.string().min(1),

	evidence: ZEvidence,
	applies_to: ZAppliesTo,

	visibility: ZVisibility,
	consensus: ZConsensus,

	status: ZStatus,
	superseded_by: ZUlid.nullable(),

	source: ZSource,
	author_key: ZAuthorKey,
	promoted_at: z.iso.datetime(),
});
export type TLesson = z.infer<typeof ZLesson>;
```

`author_key` uses `ZAuthorKey` from `primitives.js` rather than
`z.string().min(1)` — post-review fix, see Important finding 2 and Step 6 of
Task 1.

- [ ] **Step 4: Write the barrel**

`packages/lesson-contract/src/index.ts`:

```ts
export { ZAppliesTo, type TAppliesTo } from "./applies-to.js";
export { ZEvidence, type TEvidence } from "./evidence.js";
export {
	ZConsensus,
	ZLesson,
	ZSource,
	ZStatus,
	ZVisibility,
	type TConsensus,
	type TLesson,
	type TSource,
	type TStatus,
	type TVisibility,
} from "./lesson.js";
export {
	VERSION_RANGE,
	ZAuthorKey,
	ZProjectKey,
	ZUlid,
	type TAuthorKey,
	type TProjectKey,
	type TUlid,
} from "./primitives.js";
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm --filter @onlooker/lesson-contract test`
Expected: PASS — 24 tests total.

The "rejects unknown top-level fields" test is what `z.strictObject` buys. With a plain `z.object` it would fail: zod strips the unknown key and reports success, while the emitted JSON Schema still says `additionalProperties: false`. If this test ever goes red, something has been downgraded to `z.object` and the artifact no longer describes the server.

- [ ] **Step 6: Run typecheck and lint**

Run: `pnpm --filter @onlooker/lesson-contract typecheck && pnpm --filter @onlooker/lesson-contract lint`
Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add packages/lesson-contract/src
git commit -m "feat(lesson-contract): add the Lesson record and its lifecycle states :sparkles:"
```

---

## Task 4: Counter-observations

Section 4 routes refutation through accumulated counter-observations rather than letting any single report set a status. This is the record a consumer files; the tribunal, not the reporter, later decides.

**Files:**
- Create: `packages/lesson-contract/src/counter-observation.ts`
- Modify: `packages/lesson-contract/src/index.ts`
- Test: `packages/lesson-contract/src/counter-observation.test.ts`

**Interfaces:**
- Consumes: `ZUlid` from `./primitives.js`.
- Produces: `ZCounterObservation`, `TCounterObservation`.

- [ ] **Step 1: Write the failing test**

`packages/lesson-contract/src/counter-observation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ZCounterObservation } from "./counter-observation.js";

const valid = {
	id: "01KZB1MKAM734ZS7JK24D2DK0R",
	schema_version: 1,
	lesson_id: "01KZ8FMKAM734ZS7JK24D2DK0R",
	observed_at: "2026-08-07T09:15:00Z",
	artifact_ids: ["01KZB2MKAM734ZS7JK24D2DK0R"],
	session_id: "aa11bb22-3344-4556-8899-ccddeeff0011",
	summary: "Applied the vite pin on a matching project; tests still failed.",
	author_key: "c4d5e6f7a8b9",
};

describe("ZCounterObservation", () => {
	it("accepts a well-formed counter-observation", () => {
		expect(ZCounterObservation.parse(valid)).toEqual(valid);
	});

	it("requires the lesson it contradicts", () => {
		const { lesson_id, ...withoutLesson } = valid;
		expect(ZCounterObservation.safeParse(withoutLesson).success).toBe(false);
	});

	it("requires its own evidence, so a bare complaint cannot be filed", () => {
		expect(
			ZCounterObservation.safeParse({ ...valid, artifact_ids: [] }).success,
		).toBe(false);
	});

	it("rejects a malformed lesson_id", () => {
		expect(
			ZCounterObservation.safeParse({ ...valid, lesson_id: "nope" }).success,
		).toBe(false);
	});

	it("rejects a smuggled verdict, because the reporter does not decide", () => {
		expect(
			ZCounterObservation.safeParse({ ...valid, status: "refuted" }).success,
		).toBe(false);
	});

	it("rejects an email address as an author_key", () => {
		expect(
			ZCounterObservation.safeParse({
				...valid,
				author_key: "meagan@example.com",
			}).success,
		).toBe(false);
	});
});
```

The `author_key` rejection test is a post-review addition (Important finding
2), matching the one added to `lesson.test.ts` in Task 3.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @onlooker/lesson-contract test`
Expected: FAIL — `Failed to resolve import "./counter-observation.js"`.

- [ ] **Step 3: Write the schema**

`packages/lesson-contract/src/counter-observation.ts`:

```ts
import { z } from "zod";
import { ZAuthorKey, ZUlid } from "./primitives.js";

/**
 * A consumer's report that a lesson did not hold in a context where it
 * matched.
 *
 * There is intentionally no verdict field. A single failure is weak evidence:
 * the lesson may have been applied incorrectly, the context may differ
 * subtly, the failure may be unrelated. Counter-observations accumulate and
 * trigger tribunal re-judgment; the tribunal sets the lesson's status.
 * Letting reporters set it directly would also make refutation a trivial
 * denial-of-service vector.
 */
export const ZCounterObservation = z.strictObject({
	id: ZUlid,
	schema_version: z.literal(1),
	lesson_id: ZUlid,
	observed_at: z.iso.datetime(),
	artifact_ids: z.array(ZUlid).min(1),
	session_id: z.string().min(1),
	summary: z.string().min(1),
	author_key: ZAuthorKey,
});
export type TCounterObservation = z.infer<typeof ZCounterObservation>;
```

`author_key` uses `ZAuthorKey`, matching the change made to `lesson.ts` in
Task 3.

- [ ] **Step 4: Add it to the barrel**

Add to `packages/lesson-contract/src/index.ts`, keeping exports alphabetical by module:

```ts
export {
	ZCounterObservation,
	type TCounterObservation,
} from "./counter-observation.js";
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm --filter @onlooker/lesson-contract test`
Expected: PASS — 30 tests total.

- [ ] **Step 6: Commit**

```bash
git add packages/lesson-contract/src
git commit -m "feat(lesson-contract): add counter-observations for refutation :mag:"
```

---

## Task 5: Emit the JSON Schema artifact

This is what crosses the repo boundary. The guard test in Step 5 is the most important test in the package: it proves the constraints actually survive into the artifact rather than being silently dropped.

**Files:**
- Create: `packages/lesson-contract/scripts/emit-json-schema.mjs`
- Create: `packages/lesson-contract/schema/lesson.schema.json` (generated)
- Create: `packages/lesson-contract/schema/counter-observation.schema.json` (generated)
- Test: `packages/lesson-contract/src/json-schema.test.ts`

**Interfaces:**
- Consumes: `ZLesson`, `ZCounterObservation` from `./index.js`.
- Produces: two committed JSON Schema files.

- [ ] **Step 1: Write the emit script**

`packages/lesson-contract/scripts/emit-json-schema.mjs`:

```js
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ZCounterObservation, ZLesson } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../schema");
mkdirSync(outDir, { recursive: true });

const artifacts = [
	["lesson", ZLesson],
	["counter-observation", ZCounterObservation],
];

for (const [name, schema] of artifacts) {
	const json = z.toJSONSchema(schema);
	writeFileSync(
		resolve(outDir, `${name}.schema.json`),
		`${JSON.stringify(json, null, 2)}\n`,
	);
	console.log(`wrote schema/${name}.schema.json`);
}
```

The script reads from `dist/` rather than `src/`, so it runs as plain JavaScript with no TypeScript loader. `package.json` already chains it after `tsc` in the `build` script.

- [ ] **Step 2: Build to generate the artifacts**

Run: `pnpm --filter @onlooker/lesson-contract build`
Expected: `wrote schema/lesson.schema.json` and `wrote schema/counter-observation.schema.json`.

- [ ] **Step 3: Write the guard test**

`packages/lesson-contract/src/json-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ZCounterObservation, ZLesson } from "./index.js";

describe("emitted JSON Schema", () => {
	it("keeps the version-range pattern, which refinements would have lost", () => {
		const json = z.toJSONSchema(ZLesson) as Record<string, any>;
		const pattern =
			json.properties.applies_to.properties.versions.additionalProperties
				.pattern;

		expect(pattern).toBeDefined();
		expect(new RegExp(pattern).test("<6")).toBe(true);
		expect(new RegExp(pattern).test(">=4 <6")).toBe(true);
		expect(new RegExp(pattern).test("potato")).toBe(false);
	});

	it("keeps the ULID pattern on ids", () => {
		const json = z.toJSONSchema(ZLesson) as Record<string, any>;
		const pattern = json.properties.id.pattern;

		expect(new RegExp(pattern).test("01KZ8FMKAM734ZS7JK24D2DK0R")).toBe(true);
		expect(new RegExp(pattern).test("not-a-ulid")).toBe(false);
	});

	it("lists every lifecycle state so plugins see retracted too", () => {
		const json = z.toJSONSchema(ZLesson) as Record<string, any>;
		expect(json.properties.status.enum).toEqual([
			"active",
			"refuted",
			"superseded",
			"retracted",
		]);
	});

	it("emits a counter-observation schema with no status field", () => {
		const json = z.toJSONSchema(ZCounterObservation) as Record<string, any>;
		expect(Object.keys(json.properties)).not.toContain("status");
	});
});
```

Post-review, two more tests were added to this file (Important findings 1 and
4): one that reads the committed `schema/lesson.schema.json` from disk and
deep-equals it against a live `z.toJSONSchema(ZLesson)`, guarding the
*artifact* rather than just the emission function; and one asserting the
`applies_to.versions` AND-combining rule actually reaches the emitted
`description`. That brings this file to 6 tests, and the package to 36.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm --filter @onlooker/lesson-contract test`
Expected: PASS — 36 tests total.

If the first assertion fails with `pattern` undefined, a `.refine()` has crept in somewhere in the chain. Replace it with a regex; do not weaken the test.

- [ ] **Step 5: Verify the whole workspace still passes**

Run from the repo root:

```bash
pnpm build && pnpm lint && pnpm typecheck && pnpm test
```

Expected: build 9/9, lint 12/12, typecheck 12/12, test 9/9. Counts each increase by one because the new package joins the workspace.

- [ ] **Step 6: Commit**

```bash
git add packages/lesson-contract
git commit -m "feat(lesson-contract): emit the JSON Schema that crosses the repo boundary :outbox_tray:"
```

---

## Out of scope for this plan

Deliberately excluded — each belongs to a later subsystem in the spec's scope table:

- **The sync endpoint and its `N` / `N-1` translation.** Subsystem 3 (sync + storage). This plan builds the contract that endpoint will enforce.
- **Version-range *matching*.** `VERSION_RANGE` validates the syntax; deciding whether vite 8.0.16 satisfies `<6` is Waypoint's job, subsystem 4.
- **HMAC derivation of `author_key`.** The contract types the field as a string; producing it belongs with the promotion pipeline, subsystem 2.
- **The counter-observation threshold.** Flagged as an open number in the spec. It governs when re-judgment fires, which is pipeline behavior, not contract shape — this plan is not blocked on it.
- **Publishing the JSON Schema to a URL.** Check the existing `onlooker-schemas` Worker first.
