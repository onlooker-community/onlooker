# Error Envelope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `apps/web`'s mock, the real API, and the shared error parser agree on one error envelope, so a user sees the message the API actually sent instead of "Request failed with status N".

**Architecture:** The API's envelope is the source of truth — it is deployed, it is pinned by `middleware/error.test.ts`, and the mock exists to imitate it rather than the reverse. So the mock and the parser move to the API's shape, and new `api-contract` cases pin it on both implementations so it cannot drift again.

**Tech Stack:** React 18, Cloudflare Workers, vitest 4, pnpm workspace.

**Bead:** `onlooker-5em` (P1) — blocks `onlooker-yfw` (PR 4 of the lesson pool surface)

## The bug, precisely

Three files disagree:

| Where | Shape |
|---|---|
| `apps/api/src/middleware/error.ts:36` | `{ success: false, error: { code, message, details } }` |
| `apps/web/src/api/mockApi.ts:672` | `{ error: "<code>", message, details }` — no `success`, `error` is a string, no `Content-Type` |
| `packages/auth-react/src/index.tsx:102-109` | reads `data.error` as the **code** and `data.message` as the **message** |

`apps/web/src/api/client.ts:15` builds on that parser via `createAuthApiClient`, so it handles every request the app makes. Against the mock it is correct. Against the real API:

- `data.error` is the `{ code, message }` **object**, so `AuthApiError.code` — typed `string` at `packages/auth-core/src/index.ts:113` — holds an object. `err.code === "some_code"` is therefore **false in production and true against the mock**.
- `data.message` is **undefined**, so every non-401 error message falls back to `Request failed with status ${status}`.

The 401 branch returns before reading the body, so 401s are unaffected. Everything else is broken.

This is the experience `apps/web/src/lib/apiErrors.ts` documents in its own comment — "meaningless, and reading like a bug they had caused" — and attributes to 501 stubs that no longer exist. The stubs are gone; the generic messages are not, because the real cause is this mismatch.

## Global Constraints

- **The API's envelope is the source of truth. Do not change `apps/api/src/middleware/error.ts`.** It is deployed, and `apps/api/src/middleware/error.test.ts` already pins it.
- **The parser and the mock must land in the same commit.** Fix either alone and the suite is red in between — see Task 1's note.
- `apps/api` declares `@onlooker/auth-core` as a dependency but imports nothing from it in `src`. The parser change therefore does not reach the API. Do not "fix" that unused dependency here.
- The 401 path in the parser returns before reading the body and must keep doing so — it clears the token and fires `onUnauthorized`.
- Do not use `as any`. The current casts are what let this bug exist; the replacement narrows to a real type.
- American English. Conventional Commits with a mood emoji, subject **≤72 characters including the emoji** — several commits on recent branches have exceeded this. Commits go through the `/commit` skill.
- Branch off `main`; everything lands via a PR.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/auth-react/src/index.tsx` | The single error parser | Modify: read the API's envelope |
| `apps/web/src/api/mockApi.ts` | The mock's error serializer | Modify: emit the API's envelope |
| `apps/web/src/api/client.test.ts` | Fake API responses | Modify: use the real shape |
| `apps/web/src/__tests__/auth-integration.test.ts` | Fake API responses | Modify: use the real shape |
| `packages/auth-react/src/api-client.test.ts` | Parser behavior | **Create** |
| `packages/api-contract/src/index.ts` | The shared contract table | Modify: pin the envelope + validation |

**Nothing in `apps/api/src` changes in this plan.** If a contract case fails against the real API, the case is wrong — report it rather than adjusting the API.

---

### Task 1: One envelope, one parser

**Files:**
- Modify: `packages/auth-react/src/index.tsx:102-109`
- Modify: `apps/web/src/api/mockApi.ts:672-682`
- Create: `packages/auth-react/src/api-client.test.ts`
- Modify: `apps/web/src/api/client.test.ts`
- Modify: `apps/web/src/__tests__/auth-integration.test.ts`

**Interfaces:**
- Consumes: `AuthApiError(status, code, message, details?)` from `packages/auth-core/src/index.ts:111`, unchanged.
- Produces: for any non-401 error response, `AuthApiError.code` is the API's `error.code` **string** and `.message` is the API's `error.message`. Task 2's contract cases pin the wire shape this produces.

**Why this is one task and not two.** Fixing the parser first leaves it reading `data.error.code` while the mock still sends a string — `.code` is `undefined`, every message falls back, and the web suite goes red. Fixing the mock first leaves the parser reading an object as the code — same result. The two halves are one contract change and only make sense together.

- [ ] **Step 1: Write the failing parser test**

Create `packages/auth-react/src/api-client.test.ts`.

**There is no existing test for `createAuthApiClient` anywhere** — `auth.test.tsx` covers `createReactAuth` only. That absence is a large part of why this bug survived: the single error-parsing path in the codebase had no coverage at all. So this is a new file rather than an addition to an existing one.

The inline `tokenStorage` literal below matches the idiom already used in `auth.test.tsx:7-11`.

```ts
import { describe, expect, it } from "vitest";
import { createAuthApiClient } from "./index";

/** The three methods AuthTokenStorage requires; none of them matter here. */
const noStorage = {
	getToken: () => null,
	setToken: () => {},
	clearToken: () => {},
};

describe("error envelope", () => {
	// The API wraps every error as { success: false, error: { code, message } }
	// via a shared errorHandler. The parser used to read `data.error` as the
	// code, which against that envelope is an OBJECT, and `data.message`, which
	// is undefined - so every non-401 error surfaced as "Request failed with
	// status N" and `err.code === "some_code"` was false in production while
	// true against the mock.
	it("reads the code and message out of the API's envelope", async () => {
		const client = createAuthApiClient({
			baseUrl: "https://api.test",
			tokenStorage: noStorage,
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						success: false,
						error: {
							code: "status_not_allowed",
							message: "A lesson may be retracted or made active again.",
						},
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				),
		});

		await expect(client.get("/thing")).rejects.toMatchObject({
			status: 400,
			code: "status_not_allowed",
			message: "A lesson may be retracted or made active again.",
		});
	});

	it("falls back when a response carries no envelope at all", async () => {
		const client = createAuthApiClient({
			baseUrl: "https://api.test",
			tokenStorage: noStorage,
			fetchImpl: async () => new Response("not json", { status: 500 }),
		});

		await expect(client.get("/thing")).rejects.toMatchObject({
			status: 500,
			code: "unknown_error",
			message: "Request failed with status 500",
		});
	});
});
```

`baseUrl`, `tokenStorage` and `fetchImpl` are the real option names — see `AuthApiClientOptions` at `packages/auth-react/src/index.tsx:58`. `fetchImpl` is optional and falls back to global `fetch`, so passing it is what makes these tests hermetic.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @onlooker/auth-react test
```

Expected: the first test FAILS — `code` is the `{ code, message }` object and `message` is `"Request failed with status 400"`. The second test should already pass, since a body-less response falls back today too.

- [ ] **Step 3: Fix the parser**

In `packages/auth-react/src/index.tsx`, replace the `if (!response.ok)` block:

```tsx
		if (!response.ok) {
			// apps/api wraps every error through a shared errorHandler as
			// { success: false, error: { code, message, details } }. Reading
			// `data.error` as the code - which this did - yields an OBJECT
			// against the real API and a string against a mock, so a check like
			// `err.code === "not_found"` passed in development and failed in
			// production. The narrow type below is deliberate: the `as any` that
			// used to be here is what let the two shapes go unnoticed.
			const envelope = data as {
				error?: { code?: string; message?: string; details?: unknown };
			};
			throw new AuthApiError(
				response.status,
				envelope.error?.code ?? "unknown_error",
				envelope.error?.message ??
					`Request failed with status ${response.status}`,
				envelope.error?.details,
			);
		}
```

Leave the 401 branch above it exactly as it is.

- [ ] **Step 4: Fix the mock to emit the same envelope**

In `apps/web/src/api/mockApi.ts`, replace `errorResponse`:

```ts
function errorResponse(error: unknown): Response {
	if (error instanceof AuthApiError) {
		// Byte-identical to apps/api's errorHandler, including the header. A
		// mock that answers in a different shape than the thing it stands in
		// for is worse than no mock: it makes development pass and production
		// fail. The Content-Type was missing here too.
		return new Response(
			JSON.stringify({
				success: false,
				error: {
					code: error.code,
					message: error.message,
					details: error.details,
				},
			}),
			{
				status: error.status,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
	const message = error instanceof Error ? error.message : String(error);
	throw new Error(message);
}
```

Note `instanceof` already narrows, so the `const apiError = error as AuthApiError` line that was here is redundant — drop it.

- [ ] **Step 5: Update the fake responses in the web tests**

`apps/web/src/api/client.test.ts` and `apps/web/src/__tests__/auth-integration.test.ts` build fake API responses in the old bare shape. Rather than editing each literal, add a helper near the top of each file and route the error responses through it:

```ts
/** An error body in the shape apps/api actually returns. */
function apiError(code: string, message = "Something went wrong") {
	return { success: false, error: { code, message } };
}
```

Then replace each `{ error: "some_code" }` body with `apiError("some_code")`.

Most of these are 401s, which the parser short-circuits before reading the body — but they should still be realistic, because a test fixture that lies about the wire shape is how this bug survived. The 500, 503 and 404 cases in `client.test.ts` do go through the body parse and will exercise the new path.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm --filter @onlooker/auth-react test
pnpm --filter @onlooker/web test
```

Expected: both PASS. If a web test fails on a message string, read it carefully before changing it — it may be asserting the old fallback text and now correctly receiving the real message.

- [ ] **Step 7: Commit**

```bash
git add packages/auth-react/src/index.tsx packages/auth-react/src/api-client.test.ts \
        apps/web/src/api/mockApi.ts apps/web/src/api/client.test.ts \
        apps/web/src/__tests__/auth-integration.test.ts
```

Then invoke `/commit`. Suggested message:

```text
fix(web): show the error the API sent, not the status code :speech_balloon:

The mock answered { error: "<code>", message } while apps/api answers
{ success: false, error: { code, message } }, and the shared parser read
the mock's shape. Against the real API that made every non-401 message
fall back to "Request failed with status N", and put an object in
AuthApiError.code - so `err.code === "..."` was true in development and
false in production.

The mock and the parser move together because neither half works alone.

Refs: onlooker-5em
```

---

### Task 2: Pin the envelope in the contract

**Files:**
- Modify: `packages/api-contract/src/index.ts`

**Interfaces:**
- Consumes: the envelope both implementations now emit, from Task 1.
- Produces: contract cases that fail if either side's error shape drifts again.

**Why this could not be done before Task 1.** The mock would have failed the case. That is exactly why the case belongs with the fix rather than in the PR that discovered the drift.

- [ ] **Step 1: Add the case**

In `packages/api-contract/src/index.ts`, add to the array returned by `authenticatedCases`. `expectObject` is already imported at the top of the file.

```typescript
		{
			name: "an error carries the shared envelope",
			path: "/api/lessons/01NOPE00000000000000000000",
			init: { method: "GET" },
			status: 404,
			// The one case that pins an ERROR body rather than just its status.
			// Every other error case here asserts status alone, which is how the
			// mock and apps/api managed to disagree about this shape for months:
			// the suite built to catch drift could not see it. `error` must be an
			// object, not a bare code string - that difference put an object in
			// AuthApiError.code and made `err.code === "..."` false in production.
			body: {
				success: false,
				error: expectObject,
			},
			forbidden: NO_SECRETS,
		},
```

- [ ] **Step 2: Run both contract runners**

```bash
pnpm --filter @onlooker/api test src/contract.test.ts
pnpm --filter @onlooker/web test src/api/api-contract.test.ts
```

Expected: both PASS, because Task 1 made the two sides agree. If the web side fails, Task 1's mock change is incomplete — fix that rather than weakening this case.

- [ ] **Step 3: Commit**

```bash
git add packages/api-contract/src/index.ts
```

Then invoke `/commit`. Suggested message:

```text
test(contract): pin the error envelope, not just the status :lock:

Every error case in this table asserted status alone, so the mock and
apps/api disagreeing about the error body was invisible to the one suite
written to catch exactly that. This is the case that would have caught it.

Refs: onlooker-5em
```

---

### Task 3: Make the mock validate what the API validates

**Files:**
- Modify: `apps/web/src/api/mockApi.ts`
- Modify: `packages/api-contract/src/index.ts`

**Interfaces:**
- Consumes: the mock's pool branches added for `onlooker-yj5`, near `mockApi.ts:634`.
- Produces: two more contract cases, and mock validation matching `handleBrowseLessons`.

**Why this is here.** `apps/api/src/routes/lessons-browser.ts` rejects an unknown `?status` with 400 `invalid_status` and a cursor it did not mint with 400 `invalid_cursor`. The mock does neither, and no contract case covers either — so that divergence can drift indefinitely, the same way the envelope did. Two cases and about ten lines of mock close it.

- [ ] **Step 1: Add the failing contract cases**

In `packages/api-contract/src/index.ts`, add to `authenticatedCases`:

```typescript
		{
			name: "an unknown lesson status is rejected",
			path: "/api/lessons?status=banana",
			init: { method: "GET" },
			status: 400,
			forbidden: NO_SECRETS,
		},
		{
			name: "a cursor this server did not mint is rejected",
			path: "/api/lessons?cursor=not-a-real-cursor",
			init: { method: "GET" },
			status: 400,
			forbidden: NO_SECRETS,
		},
```

- [ ] **Step 2: Run both runners to verify the split**

```bash
pnpm --filter @onlooker/api test src/contract.test.ts
pnpm --filter @onlooker/web test src/api/api-contract.test.ts
```

Expected: the API side PASSES (it already validates both), the web side FAILS both cases with 200 instead of 400. That split is the drift these cases exist to expose.

- [ ] **Step 3: Add the validation to the mock**

In `apps/web/src/api/mockApi.ts`, inside the `GET /api/lessons` branch added for the lesson pool, before returning the empty pool:

```ts
		// Mirrors handleBrowseLessons in apps/api. The mock accepting a query
		// the API rejects is the same class of divergence as the error envelope:
		// it makes a broken request look fine in development.
		const query = new URLSearchParams(path.split("?")[1] ?? "");

		for (const status of query.getAll("status")) {
			if (!["active", "refuted", "superseded", "retracted"].includes(status)) {
				throw new AuthApiError(
					400,
					"invalid_status",
					"status must be one of active, refuted, superseded, retracted",
				);
			}
		}

		// The real cursor is base64 of `<promoted_at>\n<id>`; anything else was
		// not minted here. The mock's pool is always empty, so a well-formed
		// cursor still yields nothing - only the rejection needs to match.
		const cursor = query.get("cursor");
		if (cursor !== null) {
			let decoded: string | null = null;
			try {
				decoded = atob(cursor);
			} catch {
				decoded = null;
			}
			// decodeCursor requires BOTH parts non-empty, not merely two of them:
			// `!promotedAt || !id` in apps/api/src/db/lessons.ts. Counting parts
			// alone accepts "\nabc" and "abc\n", which the API rejects - the same
			// under-rejection this task exists to close, pointed at the mock.
			const parts = decoded === null ? [] : decoded.split("\n");
			if (parts.length !== 2 || !parts[0] || !parts[1]) {
				throw new AuthApiError(
					400,
					"invalid_cursor",
					"That cursor was not issued by this server; start from the first page",
				);
			}
		}
```

- [ ] **Step 4: Run both runners to verify they pass**

```bash
pnpm --filter @onlooker/api test src/contract.test.ts
pnpm --filter @onlooker/web test src/api/api-contract.test.ts
```

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/mockApi.ts packages/api-contract/src/index.ts
```

Then invoke `/commit`. Suggested message:

```text
fix(web): reject in the mock what the API already rejects :no_entry:

The API answers 400 for an unknown ?status and for a cursor it did not
mint. The mock accepted both, so a malformed request looked fine in
development and failed only against the real thing - the same divergence
the error envelope had, in a place the contract also could not see.

Refs: onlooker-5em
```

---

### Task 4: Verify the workspace and open the PR

**Files:** none.

- [ ] **Step 1: Run every gate**

```bash
pnpm test && pnpm lint && pnpm typecheck && pnpm build
```

Expected: all pass, all exit 0. Report the actual output — do not claim green without it.

Note: `apps/api/src/middleware/auth.ts` emits two `useOptionalChain` **warnings**. They are pre-existing, tracked as `onlooker-xl2`, and do not fail the gate. Do not fix them here.

- [ ] **Step 2: Confirm the API was not touched**

```bash
git diff main..HEAD -- apps/api/src
```

Expected: **empty.** The API's envelope is the source of truth in this plan, and nothing in it should have moved.

- [ ] **Step 3: Confirm no `as any` was reintroduced**

```bash
git diff main..HEAD | grep -n "as any" || echo "none"
```

Expected: `none`. The casts are what let the two shapes diverge unnoticed.

- [ ] **Step 4: Open the PR**

Invoke the `/pr` skill. Flag for reviewers: this changes user-visible error text everywhere in the app; the parser and mock had to move together; and `onlooker-yfw` (PR 4) was blocked on this.

- [ ] **Step 5: Close the bead once merged**

```bash
bd close onlooker-5em --reason "Envelope unified and pinned by contract in <PR>."
```

---

## Notes on what this plan deliberately does not do

**It does not change the API's envelope.** That would be a breaking change to a deployed contract, and `middleware/error.test.ts` already pins the current shape. The mock exists to imitate the API; when they disagree, the mock is what is wrong.

**It does not remove `apps/api`'s unused `@onlooker/auth-core` dependency.** `apps/api/package.json` declares it and `apps/api/src` imports nothing from it. That is worth deleting — this repository has removed unused packages before — but it is a separate concern and would widen a bug-fix PR into dependency cleanup.

**It does not add a `success: true` wrapper to success responses.** The API returns success payloads bare, deliberately: `middleware/error.ts:18` records that wrapping in `{ success: true, data }` was tried and removed because nothing on the receiving end unwrapped it. Only the error path carries `success`.
