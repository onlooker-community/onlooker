# Contract Integrity — Design

Closes `onlooker-boh`, `onlooker-jws` and `onlooker-y9f`.

Applies to `packages/api-contract`, both contract runners
(`apps/web/src/api/api-contract.test.ts`, `apps/api/src/contract.test.ts`),
`apps/web/src/api/mockApi.ts`, and `apps/api/src/db/lessons.ts`.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-08-30 and are
decisions rather than proposals. Open questions are collected at the end.

## Boundary

**In scope:** making `shapeFailures` able to express what its own documentation
promises, giving `ContractCase` a way to pin response headers, correcting two
mock/API divergences, and asserting one invariant where it is produced.

**Out of scope:** pinning error *message* text, adding new contract cases beyond
those needed to cover the divergences named here, and any change to what the API
actually returns. This work changes what the contract can *see*, not what the
system does.

---

## Section 0 — What is already true *(context, not decisions)*

**The contract cannot assert anything about an error's contents, and its own
comment says otherwise.** `ContractCase.body`'s doc comment reads: *"Compared as
a subset, so adding a field to a response is allowed and renaming or dropping one
is not."* That holds at the top level and is false one level down.

`shapeFailures` (`packages/api-contract/src/index.ts:521`) checks three symbols —
`expectObject`, `expectArray`, `expectString` — and then falls through to
`got === want` at :551. A nested expectation is a fresh object literal, so that
comparison is by reference.

Measured on 2026-08-30, both directions:

| Call | Returns | Should return |
|---|---|---|
| `shapeFailures({error:{code:"bad_request",message:"nope"}}, {error:{code:expectString}})` | 1 failure | `[]` |
| `shapeFailures({error:{kode:"bad_request"}}, {error:expectObject})` | `[]` | a failure |

Those compound. A nested expectation fails against a body that matches it, so
nobody writes one; the fallback is `error: expectObject`, which asserts the error
is an object and nothing else. Counted in the same file: **one** case uses
`error: expectObject`, and **zero** assert on `code` or `message`. A renamed
`code` or a vanished `message` passes the whole suite.

**`ContractCase` has no response-header field.** It carries `name`, `path`,
`init`, `status`, `body?` and `forbidden?`. The `headers` that appear at :84 and
:486 are on the *request* side, in the `json()` helper. So the Content-Type
divergence in `onlooker-jws` is not merely unpinned — it is currently
inexpressible.

**Content-Type has diverged twice.** `onlooker-5em` fixed the mock omitting it on
*error* responses. The success path was left, and nothing guards either.

**Both runners are symmetric and would each need to honor a new field.**
`apps/web/src/api/api-contract.test.ts:54-66` and
`apps/api/src/contract.test.ts:80-85` each check `status`, then `body` through
`shapeFailures`, then `forbidden`. A field checked in one and not the other is
worse than no field: it would pass on the side that does not look.

**The `has_more`/`cursor` pairing holds by construction, not by statement.**
`listLessonsPage` (`apps/api/src/db/lessons.ts:413`) derives `hasMore` from
`rows.length > limit` and clamps `limit` to at least 1, so a page with
`hasMore: true` always holds at least one row and its last row's cursor is
defined. Nothing asserts it. The browser keys its Load more control off `cursor`,
so `has_more: true` with `cursor: null` would silently hide the tail.

---

## Section 1 — How far the contract pins *(approved)*

**Structure plus identifiers. Not message text.**

- **Structure** — shapes, types, presence, status codes, and now response
  headers.
- **Identifiers** — `error.code` pinned to its exact value on cases that carry
  one. A client branches on `code`; it is API surface.
- **Not messages** — `error.message` is prose for a person to read. Pinning it
  would fail the contract on a copy edit and force the mock to carry text whose
  only purpose is imitation.

This is what splits `onlooker-jws` in two. The Content-Type divergence gets
pinned. The `status_not_allowed` wording gets corrected in the mock and left
unpinned, because a case guarding it would be a case that fails for the wrong
reason.

---

## Section 2 — The comparator *(approved)*

`shapeFailures` recurses when the expected value is a plain object — not an
array, not null.

**Placement relative to the symbol checks does not matter**, and it is worth
saying so because it looks like it should. The three expectations are
`Symbol.for(...)` values, and `typeof aSymbol` is `"symbol"`, not `"object"` — so
a `typeof want === "object" && want !== null && !Array.isArray(want)` guard
cannot catch them wherever it sits. Put it directly before the `got === want`
fallthrough, next to the branch it is replacing for object values, because that
is where a reader looking for "what happens to a non-symbol expectation" will
look.

**Nested comparison is subset, matching the top level.** Adding a field to an
error envelope stays allowed; renaming or dropping one does not. Consistency is
the reason: one rule for the whole structure is easier to hold than a rule that
changes with depth, and `forbidden` already covers "must not appear."

**No new helper is needed to pin an exact value.** Once recursion works,
`{ error: { code: "batch_too_large" } }` reaches the existing `got === want` path
with a string on both sides. `expectString` remains available for cases where any
non-empty code will do.

**Failure messages must name the path.** A failure reported as `"code" should be
a non-empty string` is ambiguous once the same key can appear at two depths. It
should read `error.code`. Without this the fix makes debugging worse than the
vacuous assertion it replaces.

---

## Section 3 — Response headers *(approved)*

`ContractCase` gains:

```ts
/**
 * Response headers that must match. Names are compared case-insensitively
 * (HTTP header names are), values exactly.
 *
 * Subset, like `body`: a response may carry headers a case does not name.
 */
headers?: Record<string, string>;
```

**Both runners check it**, in the same position relative to the other checks.
This is the part most at risk of being half-done: a `headers` field honored only
by `apps/api`'s runner would pass on the mock side while the mock diverged, which
is precisely the failure the contract exists to prevent.

The mock's `json()` helper (`mockApi.ts:440`) starts setting `Content-Type:
application/json` on success responses, matching what the API already does
everywhere. Cases that exercise a JSON success path pin it.

---

## Section 4 — The mock's message *(approved)*

`mockApi.ts:696`'s `status_not_allowed` message becomes the API's three-sentence
version (`apps/api/src/routes/lessons-browser.ts:106-111`).

Corrected, not pinned. Section 1 settles why: the contract asserts `code`, and
`code` is what distinguishes this response from any other.

---

## Section 5 — The `has_more` invariant *(approved)*

`listLessonsPage` asserts that `has_more: true` implies a non-null cursor, at the
point the pair is constructed.

This is the piece not in `packages/api-contract`, and it is a unit assertion
rather than a contract case. It belongs with this work because it is the same
failure class — a property that is true, that the system depends on, and that
nothing checks. The browser hides the tail of the pool if it ever stops being
true, which is the same quiet lie the Load more control was built to end.

Assert rather than merely test: the invariant should hold at runtime, not only
under the conditions a test happens to construct.

---

## Section 6 — Testing

**The comparator's own tests are the load-bearing ones**, because every other
assertion in the repository now depends on it being right:

- A nested expectation matching a matching body returns `[]` — the case that
  fails today.
- A nested expectation against a renamed key returns a failure naming the path.
- A nested expectation against a *missing* key returns a failure, not a silent
  pass.
- Depth beyond two levels behaves the same way.
- The three symbols still work at the top level and now work nested.
- A non-object expected value still compares by equality.

**Each must be checked by reverting the fix**, not merely observed to pass. A
comparator test that passes against the old identity comparison is testing
nothing — and the old behavior is the one that returns a failure for everything,
so a carelessly written test can look green for the wrong reason.

**Header checking is verified on both runners.** A test that only exercises one
proves half of the thing this section exists for.

**The invariant is verified by violating it.** Construct a page that would pair
`has_more: true` with a null cursor and confirm the assertion fires.

---

## Section 7 — Sequencing

1. The comparator (Section 2). Everything else that pins a nested value depends
   on it.
2. Header support in `ContractCase` and both runners, plus the mock's
   `Content-Type` (Section 3).
3. The mock's message (Section 4). Independent of 1 and 2.
4. The `has_more` invariant (Section 5). Independent of everything.

Steps 3 and 4 can be reordered freely. Steps 1 and 2 cannot be skipped ahead of
the cases that use them.

---

## Open questions

None. The two decisions carried out of the design conversation — that the
contract pins structure and identifiers but not message text, and that response
headers are worth a new field on `ContractCase` — are recorded in Sections 1 and
3 with the alternatives that were rejected.

Two smaller calls were made without being raised, and are recorded here so they
can be disagreed with: nested comparison is **subset** rather than exact, for
consistency with the top level; and pinning an exact `code` needs **no new
helper**, because a string literal lands on the existing equality path once
recursion works.

One thing to watch during implementation rather than decide now: fixing the
comparator may turn existing passing cases red, if any of them contain a nested
expectation that has been silently failing — there should be none, since such a
case could never have passed, but a case added and then loosened would look like
this. If a case goes red, the case is the evidence and the comparator is correct.
