# Contract Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the contract able to assert what its own documentation promises — nested shapes, exact error codes, and response headers — then use that to close two mock/API divergences and one unasserted invariant.

**Architecture:** `shapeFailures` gains recursion into plain objects and path-qualified failure messages. `ContractCase` gains an optional `headers` field, honored by both runners. The mock stops omitting `Content-Type` on success and gets its `status_not_allowed` wording corrected. Separately, `listLessonsPage` asserts the `has_more`/`cursor` pairing at the point it builds it.

**Tech Stack:** TypeScript, Vitest 4.1.9, Biome, pnpm + turbo.

## Global Constraints

- **`packages/api-contract` has no test script, no vitest dependency, and no test file.** Task 1 wires it. Until then, any test written there does not run — not locally through `pnpm test`, and not in CI.
- **Both runners must honor any new `ContractCase` field.** `apps/web/src/api/api-contract.test.ts` and `apps/api/src/contract.test.ts` are deliberately symmetric. A field checked on one side only is worse than no field: it passes on the side that does not look, which is exactly the divergence the contract exists to catch.
- **Pin structure and identifiers, never message text.** `error.code` is API surface a client branches on and gets pinned exactly. `error.message` is prose for a person; pinning it fails the contract on a copy edit.
- **Nested comparison is subset, like the top level.** Adding a field to an error envelope stays allowed; renaming or dropping one does not.
- **American English** in every comment, identifier and string.
- Commits: `<type>(<scope>): <subject> :emoji:`, subject **≤72 characters including the emoji**, body wrapped at 80, why-focused, ending with a `Refs:` line naming the beads that task closes.
- Never `git add -A` or `git add .` — stage intentionally.
- Gates from the repo root before every commit: `pnpm test`, `pnpm typecheck`, `pnpm lint`. All three green. `pnpm lint` currently reports 9 pre-existing warnings in `@onlooker/web` and `@onlooker/auth-react` that are not yours.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `packages/api-contract/src/index.test.ts` | The comparator's own tests. The first test file this package has ever had. |
| `packages/api-contract/vitest.config.ts` | Points vitest at `src/*.test.ts`. |

**Modified:**

| File | Change |
|---|---|
| `packages/api-contract/package.json` | `test` script, `vitest` devDependency. |
| `packages/api-contract/src/index.ts` | Recursion + paths in `shapeFailures`; `headers?` on `ContractCase`; the new cases. |
| `apps/web/src/api/api-contract.test.ts` | Honor `headers`. |
| `apps/api/src/contract.test.ts` | Honor `headers`. |
| `apps/web/src/api/mockApi.ts` | `Content-Type` on success; `status_not_allowed` wording. |
| `apps/api/src/db/lessons.ts` | The `has_more`/`cursor` assertion. |

---

## Notes for whoever builds this

**Measured before this plan was written, so you do not have to re-derive it:**

- `shapeFailures({error:{code:"bad_request",message:"nope"}}, {error:{code:expectString}})` returns **one failure**. It should return `[]`. That is the bug.
- `shapeFailures({error:{kode:"bad_request"}}, {error:expectObject})` returns **`[]`**. A renamed key passes.
- The three expectations are `Symbol.for(...)` values, so `typeof want === "object"` cannot catch them. Placement of the recursion branch relative to the symbol checks does not affect correctness.
- The file contains **one** `error: expectObject` and **zero** assertions on `code` or `message`.

**The old comparator returns a failure for every object expectation.** So a carelessly written test can look green against the broken version for the wrong reason. Task 1 has a revert step for exactly this.

---

### Task 1: Give the package a test harness and fix the comparator

**Files:**
- Create: `packages/api-contract/vitest.config.ts`, `packages/api-contract/src/index.test.ts`
- Modify: `packages/api-contract/package.json`, `packages/api-contract/src/index.ts:521-555`

**Interfaces:**
- Produces: `shapeFailures(actual, expected)` with recursion and path-qualified messages. Tasks 2 and 3 write cases that depend on it.

- [ ] **Step 1: Wire the package for tests**

`packages/api-contract/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { include: ["src/*.test.ts"] },
});
```

In `packages/api-contract/package.json`, add to `scripts`:

```json
"test": "vitest run",
```

and to `devDependencies`:

```json
"vitest": "^4.1.9",
```

Then `pnpm install` from the repo root. `turbo.json`'s `test` task picks the package up automatically once the script exists — there is no list to register in.

- [ ] **Step 2: Write the failing tests**

`packages/api-contract/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expectArray, expectObject, expectString, shapeFailures } from "./index";

const ERROR_BODY = { error: { code: "bad_request", message: "nope" } };

describe("shapeFailures", () => {
	it("passes a body that satisfies a nested expectation", () => {
		expect(shapeFailures(ERROR_BODY, { error: { code: expectString } })).toEqual([]);
	});

	// The bug this file exists for. Before the fix, `error: expectObject` was the
	// only expressible error assertion, and it says nothing about the contents -
	// so renaming `code` passed the whole suite.
	it("catches a renamed key inside a nested object", () => {
		const failures = shapeFailures(
			{ error: { kode: "bad_request" } },
			{ error: { code: expectString } },
		);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("error.code");
	});

	it("catches a nested key whose value is the wrong type", () => {
		const failures = shapeFailures(
			{ error: { code: 42 } },
			{ error: { code: expectString } },
		);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("error.code");
	});

	// Path qualification is not cosmetic: the same key name can now appear at
	// two depths, and `"code" should be a non-empty string` does not say which.
	it("names the full path in a nested failure, not just the key", () => {
		const failures = shapeFailures({ error: {} }, { error: { code: expectString } });
		expect(failures[0]).toContain("error.code");
		expect(failures[0]).not.toBe('missing "code"');
	});

	it("pins a nested value exactly when given a literal", () => {
		expect(
			shapeFailures(ERROR_BODY, { error: { code: "bad_request" } }),
		).toEqual([]);
		expect(
			shapeFailures(ERROR_BODY, { error: { code: "something_else" } }),
		).toHaveLength(1);
	});

	// Subset at every depth, matching the top level. An API adding a field to an
	// error envelope breaks no client.
	it("allows extra keys inside a nested object", () => {
		expect(
			shapeFailures(ERROR_BODY, { error: { code: expectString } }),
		).toEqual([]);
	});

	it("recurses more than one level", () => {
		expect(
			shapeFailures(
				{ a: { b: { c: "deep" } } },
				{ a: { b: { c: expectString } } },
			),
		).toEqual([]);
		expect(
			shapeFailures({ a: { b: { c: 1 } } }, { a: { b: { c: expectString } } }),
		).toHaveLength(1);
	});

	it("reports a nested expectation against a non-object", () => {
		const failures = shapeFailures(
			{ error: "a string" },
			{ error: { code: expectString } },
		);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("error");
	});

	// The three symbols must keep working, at both depths.
	it("keeps the symbols working at the top level", () => {
		expect(
			shapeFailures(
				{ o: {}, a: [], s: "x" },
				{ o: expectObject, a: expectArray, s: expectString },
			),
		).toEqual([]);
	});

	it("supports the symbols inside a nested object", () => {
		expect(
			shapeFailures({ w: { o: {}, a: [], s: "x" } }, { w: { o: expectObject, a: expectArray, s: expectString } }),
		).toEqual([]);
	});

	it("still compares a non-object expectation by equality", () => {
		expect(shapeFailures({ n: 1 }, { n: 1 })).toEqual([]);
		expect(shapeFailures({ n: 1 }, { n: 2 })).toHaveLength(1);
	});

	it("still reports a missing top-level key", () => {
		expect(shapeFailures({}, { error: expectObject })).toEqual(['missing "error"']);
	});
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm --filter @onlooker/api-contract test`
Expected: several failures. The nested ones fail because the old comparator returns a failure for every object expectation; the path ones fail because messages are key-only.

- [ ] **Step 4: Write the implementation**

In `packages/api-contract/src/index.ts`, give `shapeFailures` an internal path parameter and a recursion branch. Replace the function body:

```ts
export function shapeFailures(
	actual: unknown,
	expected: Record<string, unknown>,
	/**
	 * Key prefix for failure messages, so a nested failure reads `error.code`
	 * rather than `code`. Internal - callers pass nothing.
	 */
	path = "",
): string[] {
	if (typeof actual !== "object" || actual === null) {
		return [
			`${path || "body"} is ${actual === null ? "null" : typeof actual}, not an object`,
		];
	}
	const value = actual as Record<string, unknown>;

	return Object.entries(expected).flatMap(([key, want]) => {
		const here = path ? `${path}.${key}` : key;
		if (!(key in value)) return [`missing "${here}"`];
		const got = value[key];

		if (want === expectObject) {
			return typeof got === "object" && got !== null && !Array.isArray(got)
				? []
				: [`"${here}" should be an object, got ${describe(got)}`];
		}
		if (want === expectArray) {
			return Array.isArray(got)
				? []
				: [`"${here}" should be an array, got ${describe(got)}`];
		}
		if (want === expectString) {
			return typeof got === "string" && got.length > 0
				? []
				: [`"${here}" should be a non-empty string, got ${describe(got)}`];
		}

		// A plain object expectation describes a nested shape, and is compared as
		// a subset just like the top level. Before this branch existed the value
		// fell through to `got === want` below - a reference comparison against a
		// fresh object literal, which failed unconditionally. So nobody could
		// write a nested expectation, everyone reached for `expectObject`, and
		// that says nothing about the contents. A renamed `code` passed the suite.
		//
		// Placement relative to the symbol checks above is not load-bearing: the
		// three expectations are `Symbol.for(...)` values, and `typeof aSymbol` is
		// "symbol", so this guard cannot catch them wherever it sits.
		if (typeof want === "object" && want !== null && !Array.isArray(want)) {
			return shapeFailures(got, want as Record<string, unknown>, here);
		}

		return got === want
			? []
			: [`"${here}" should be ${String(want)}, got ${describe(got)}`];
	});
}
```

Note the non-object branch now uses `path || "body"`, so a top-level call still reports `body is null, not an object` while a nested one reports `error is a string, not an object`.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/api-contract test`
Expected: PASS, 12 tests.

- [ ] **Step 6: Prove the tests can fail the way they must**

Delete the recursion branch you just added — leaving the value to fall through to `got === want`, which is the old behavior. Confirm the nested tests fail. Restore it.

**Report which tests failed and how many.** The old comparator returns a failure for every object expectation, so a test asserting `toHaveLength(1)` could pass against it for entirely the wrong reason. This step is what distinguishes a real guard from one that agrees with both implementations.

- [ ] **Step 7: Run the full gates, then commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add packages/api-contract/package.json packages/api-contract/vitest.config.ts packages/api-contract/src/index.test.ts packages/api-contract/src/index.ts pnpm-lock.yaml
```

Subject: `fix(contract): let a nested expectation mean something :mag:`
Body: what the old reference comparison did, and why the package had no tests until now.
`Refs: onlooker-boh`

---

### Task 2: Response headers, honored by both runners

**Files:**
- Modify: `packages/api-contract/src/index.ts` (the `ContractCase` interface), `apps/web/src/api/api-contract.test.ts:54-66`, `apps/api/src/contract.test.ts:80-85`, `apps/web/src/api/mockApi.ts:440`

**Interfaces:**
- Consumes: `ContractCase` from Task 1's file.
- Produces: `ContractCase.headers?: Record<string, string>`, checked by both runners.

- [ ] **Step 1: Add the field**

In `packages/api-contract/src/index.ts`, inside `ContractCase`, after `body`:

```ts
	/**
	 * Response headers that must match. Names are compared case-insensitively,
	 * because HTTP header names are; values exactly.
	 *
	 * Subset, like `body`: a response may carry headers a case does not name.
	 * Added because the mock omitted Content-Type on success responses while the
	 * API set it everywhere, and there was no way to say so - onlooker-5em had
	 * already fixed the same divergence on the error path, without a guard.
	 */
	headers?: Record<string, string>;
```

- [ ] **Step 2: Make the mock send it**

`apps/web/src/api/mockApi.ts:440` — the `json()` helper's success responses gain `Content-Type: application/json`, matching what `apps/api` already does everywhere. Read the helper before editing; if it already sets other headers, add to them rather than replacing.

- [ ] **Step 3: Add a case that pins it**

In `packages/api-contract/src/index.ts`, add to the case list:

**A suitable case already exists — do not add a new one.** `packages/api-contract/src/index.ts:382` is `"lesson pool, empty"`: `GET /api/lessons`, status 200, already pinning `lessons` and `cursor`. Add one key to it:

```ts
			headers: { "Content-Type": "application/json" },
```

It is the right case because it exercises a JSON success path and already carries a body, so a Content-Type divergence and a shape divergence fail together in one place rather than in two.

- [ ] **Step 4: Teach both runners to check it**

In **both** `apps/web/src/api/api-contract.test.ts` and `apps/api/src/contract.test.ts`, after the `status` assertion and before the body block:

```ts
			if (entry.headers) {
				for (const [name, want] of Object.entries(entry.headers)) {
					expect(
						response.headers.get(name),
						`${entry.name}: header ${name}`,
					).toBe(want);
				}
			}
```

`Headers.get` is case-insensitive by specification, which is what satisfies the interface's promise about names.

- [ ] **Step 5: Run both suites and watch them pass**

Run: `pnpm --filter @onlooker/web test && pnpm --filter @onlooker/api test`
Expected: PASS on both. If the mock side fails, Step 2 did not land — the case is doing its job.

- [ ] **Step 6: Prove the check runs on both sides**

Temporarily change the pinned value to `application/xml` and confirm **both** suites fail. Restore.

**Report both failures.** A `headers` field honored by only one runner would pass on the side that does not look, which is precisely the class of divergence this task exists to close — and it would look completely fine from the other side.

- [ ] **Step 7: Run the full gates, then commit**

Subject: `feat(contract): let a case pin the headers a response sends :label:`
Body: why the field is needed at all, and why both runners had to change together.
`Refs: onlooker-jws`

---

### Task 3: The mock's message, and an error code the contract can now see

**Files:**
- Modify: `apps/web/src/api/mockApi.ts:696`, `packages/api-contract/src/index.ts` (one case)

- [ ] **Step 1: Correct the mock's wording**

`status_not_allowed` is at **`apps/web/src/api/mockApi.ts:716`** (the bead says 696; it has moved). Its message is one sentence; the API sends three at `apps/api/src/routes/lessons-browser.ts:106-111`. Read the API's version and copy it exactly.

Corrected, not pinned: `error.message` is prose for a person, and a case guarding it would fail on a copy edit.

- [ ] **Step 2: Pin the code that identifies it**

**There is no contract case for this today** — `status_not_allowed` appears in `mockApi.ts` and nowhere in the contract, which is part of why the divergence went unnoticed. Add one, modeled on the existing `/api/lessons/:id/status` case at `packages/api-contract/src/index.ts:483` (read it for the path and `init` shape it uses):

```ts
		body: { error: { code: "status_not_allowed" } },
```

This is the assertion that was impossible before Task 1 — a nested literal, reaching the equality path now that recursion gets there.

Getting a real `status_not_allowed` out of both sides needs a lesson in a state whose transition is refused. If the fixture cannot produce one without significant new setup, **say so and stop rather than inventing a fixture** — an assertion on a response the suite cannot actually provoke is worse than no assertion.

- [ ] **Step 3: Run both suites**

Run: `pnpm --filter @onlooker/web test && pnpm --filter @onlooker/api test`
Expected: PASS on both.

- [ ] **Step 4: Prove the new assertion is live**

Change the pinned code to `status_not_allowedx` and confirm both suites fail with a message naming `error.code`. Restore.

**Report the failure text.** If it says `"code"` rather than `"error.code"`, Task 1's path qualification did not survive, and every nested failure in the repository will be ambiguous.

- [ ] **Step 5: Run the full gates, then commit**

Subject: `fix(web): give the mock the message the API actually sends :speech_balloon:`
Body: why the wording is corrected but not pinned, and why the code is.
`Refs: onlooker-jws`

---

### Task 4: Assert the `has_more` invariant where it is produced

**Files:**
- Modify: `apps/api/src/db/lessons.ts:413` (`listLessonsPage`)
- Test: `apps/api/src/db/lessons.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/db/lessons.test.ts`:

```ts
// The browser keys its Load more control off `cursor`, so has_more: true with a
// null cursor would silently hide the tail of the pool - the same quiet lie the
// control was built to end, one layer down. The pairing holds by construction
// today (hasMore derives from rows.length > limit, and limit clamps to >= 1), so
// this pins a property that is currently true by accident of the implementation
// rather than by statement.
it("never reports more pages without a cursor to fetch them with", async () => {
	// Signature is listLessonsPage(db, userId, opts) - three arguments, not two.
	// The returned field is `hasMore` (camelCase); `has_more` is the wire name
	// the route maps it to, and does not exist here.
	const page = await listLessonsPage(db, USER_ID, { limit: 1 });
	if (page.hasMore) {
		expect(page.cursor).not.toBeNull();
	}
	expect(typeof page.hasMore).toBe("boolean");
});
```

Read the file's existing setup before writing this — use whatever fixture, `db` handle and user id the neighbouring tests use; `USER_ID` above is a placeholder for whatever they call it. Seed at least two lessons so `hasMore` is genuinely true rather than vacuously false; a test that only ever sees `hasMore: false` asserts nothing.

`LessonPage` is `{ lessons: unknown[]; cursor: string | null; hasMore: boolean }` (`apps/api/src/db/lessons.ts:398`).

- [ ] **Step 2: Run it**

Run: `pnpm --filter @onlooker/api exec vitest run src/db/lessons.test.ts`
Expected: PASS — the invariant holds today. This test documents it; the assertion in Step 3 enforces it.

- [ ] **Step 3: Add the runtime assertion**

In `listLessonsPage`, where the return value is built:

```ts
	// Assert rather than trust: this holds by construction today, but the
	// construction is three separate facts (hasMore derives from a row count,
	// limit clamps to >= 1, the cursor comes from the last row) and a change to
	// any one of them breaks it silently. The browser would hide the tail of the
	// pool and say nothing.
	if (hasMore && cursor === null) {
		throw new Error(
			"listLessonsPage: has_more is true with no cursor; the tail would be unreachable",
		);
	}
```

The return is built at `apps/api/src/db/lessons.ts:460-464` as
`{ lessons: page, cursor: hasMore && last ? encodeCursor(...) : null, hasMore }`.
`hasMore` is in scope; the cursor is an expression, so compute it into a local
first and return that, rather than evaluating `encodeCursor` twice.

- [ ] **Step 4: Prove the assertion fires**

Temporarily force `cursor` to `null` while `hasMore` is true and confirm the throw. Restore.

**Report what you did to force it.** If you cannot construct the violation without editing the function, say so — that is worth knowing, and it means the invariant is more strongly held than the spec assumed.

- [ ] **Step 5: Run the full gates, then commit**

Subject: `fix(api): refuse to promise a page with no way to reach it :straight_ruler:`
Body: why an assertion rather than only a test, and what the browser does if it breaks.
`Refs: onlooker-y9f`

---

## Closing out

```bash
pnpm test && pnpm typecheck && pnpm lint
git status
```

Open the PR with `/pr`. Do not push to `main`.

After merge, close `onlooker-boh`, `onlooker-jws` and `onlooker-y9f`.

---

## Self-review

**Spec coverage.**

| Spec requirement | Task |
|---|---|
| §1 pin structure and identifiers, not messages | 3 (message corrected, code pinned) |
| §2 recursion into plain objects | 1 |
| §2 nested comparison is subset | 1 (explicit test) |
| §2 no new helper for exact values | 1 (literal test), 3 (real use) |
| §2 failure messages name the path | 1 (test + Task 3 Step 4 re-checks it) |
| §3 `headers?` on `ContractCase` | 2 |
| §3 both runners honor it | 2 (Step 6 proves both) |
| §3 mock sends Content-Type on success | 2 |
| §4 mock's `status_not_allowed` wording | 3 |
| §5 `hasMore`/`cursor` assertion | 4 |
| §6 comparator tests checked by reverting | 1 Step 6 |
| §6 header check verified on both runners | 2 Step 6 |
| §6 invariant verified by violating it | 4 Step 4 |

**Placeholder scan.** No TBDs. Every code step carries its code. Four steps ask the implementer to *report* rather than decide: 1/6, 2/6, 3/4 and 4/4 — all of them revert-checks, because this plan's whole subject is assertions that do not assert.

**Type consistency.** `shapeFailures`'s third parameter is `path`, defaulted, internal — Tasks 2–4 never pass it. `ContractCase.headers` is `Record<string, string>` in the interface and read with `Object.entries` in both runners. `expectString` / `expectObject` / `expectArray` keep their existing names and meanings.

**Two risks worth naming.** Task 1 adds a `test` script to a package that has never had one, so `pnpm test` at the root will start running a suite that did not exist — if the root command's behavior changes in some way beyond "more tests run," that is worth reporting rather than working around. And Task 4's test needs at least two seeded lessons to exercise `has_more: true`; if the existing fixture cannot produce that, the test is vacuous and the implementer should say so rather than assert on a `false` that proves nothing.
