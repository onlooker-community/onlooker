# Promotion Pipeline — Design

**Status:** Complete — all four sections approved
**Subsystem:** 2 of 6, per the [shared lesson contract spec](2026-08-06-shared-lesson-contract-design.md)
**Beads:** onlooker-7jn (applies_to ambiguity), onlooker-5oz (author_key width)
**Date:** 2026-08-08

---

## Reading this document

Subsystem 1 shipped: `packages/lesson-contract` defines the Lesson and emits its
JSON Schema. This spec covers subsystem 2, which turns archivist artifacts into
Lessons and decides which ones are good enough to share.

The design spans two repositories. Only Section 1 lands here; Sections 2 and 3
are a handoff to the plugin repo, recorded here so the whole pipeline stays
coherent in one document.

---

## Boundary

The pipeline stops at a **local approved pool**. Nothing crosses the network.

```
archivist artifacts                      EXISTS
 └→ durability filter                    EXISTS  cheap, pre-LLM
    └→ type classifier (Haiku)           EXISTS  user/feedback/project/reference
       └→ conflict/dup detect (Jaccard)  EXISTS  keeps the queue high-signal
          ══════════════════════════════════════
          └→ lesson transform (Haiku)    NEW     claim, rationale, applies_to
             └→ human picks + visibility NEW     propose-only, per ADR-001
                └→ tribunal gate         NEW     one-shot, visibility-scoped
                   └→ approved pool      NEW     local; subsystem 3 drains it
```

Subsystem 3 (sync + storage) does not exist — `apps/api` is auth-only — so
"publish to pool" from Section 2 of the contract spec has nowhere to go yet.
Ending at a local pool keeps this subsystem buildable and testable today, and
leaves subsystem 3 a queue to drain rather than a protocol to negotiate.

**Out of scope:** counter-observations and re-judgment. Both require consumers
of shared lessons, which needs subsystems 3 and 4. The contract spec's open
counter-observation threshold stays open; see [Open questions](#open-questions).

### Where the work lands

| Repo | What |
|---|---|
| this one | Section 1 — the contract change, `schema_version` 2, regenerated JSON Schema |
| plugin repo | Sections 2–3 — transform, rubric, approved pool |

The split is forced by Section 5 of the contract spec: transform and judging run
locally, and the local plugins are shell-based in a separate repository, so the
side that produces Lessons is the side that cannot import zod.

---

## Section 1 — The contract change *(approved)*

`schema_version` goes to **2**, carrying both fixes at once. Bundling them is
deliberate: each alone would force a bump, and nothing consumes the contract
yet, so two changes cost exactly one migration.

### `applies_to.scope` — resolving onlooker-7jn

The bug is that one field carries two meanings. `versions: {}` reads as both
"this lesson has no version dependency" and "the transform could not infer
versions," and nothing downstream can tell them apart. A lesson with no version
constraint never expires, so an inference failure silently mints an immortal
lesson — the exact failure the contract exists to prevent.

The fix makes the ambiguity unrepresentable rather than detectable:

```ts
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
  .meta({ minProperties: 1 });

export const ZScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("versioned"), versions: ZVersions }),
  z.strictObject({
    kind: z.literal("version_independent"),
    justification: z.string().min(1),
  }),
]);

export const ZAppliesTo = z.strictObject({
  stack: z.array(z.string().min(1)).min(1),
  scope: ZScope,                      // replaces the former `versions` field
  file_patterns: z.array(z.string().min(1)),
  task_kinds: z.array(z.string().min(1)),
});
```

`versions` moves inside a tagged branch and must be non-empty. `ZAppliesTo` no
longer has a `versions` key of its own; `stack`, `file_patterns` and
`task_kinds` are unchanged. The escape hatch
for genuinely version-independent lessons still exists, but it demands a written
`justification` — and that justification is something the jury scores. A
transform that failed to infer versions cannot produce a valid lesson by
accident, because the alternative branch requires an argument it has no basis to
make. Inference failure becomes a validation error instead of a bad lesson.

**Non-emptiness is enforced twice because neither mechanism alone suffices.**
Zod refinements are silently dropped by `z.toJSONSchema`, and `.meta()` injects
into the artifact without affecting runtime validation. Verified in zod 4.4.3:

| mechanism | rejects `{}` at runtime | emits `minProperties: 1` |
|---|---|---|
| `.check()` alone | yes | no |
| `.meta()` alone | **no** | yes |
| both | yes | yes |

`.meta()` alone is the dangerous case. Section 5 of the contract spec makes the
`apps/api` ingest the real enforcement boundary, so a server importing `ZLesson`
would have accepted empty maps while the published schema declared them invalid
— the lax side being the one that enforces. Tests assert each behavior
separately, matching the existing pattern in `json-schema.test.ts` that guards
constraints against being lost in emission.

### Cross-field rules the ingest endpoint must enforce

Some constraints span two fields, and JSON Schema cannot express those at all.
They are deliberately absent from `packages/lesson-contract` rather than added
as `.check()` calls, because a check would make the package reject values the
published artifact accepts — and the shell-based plugins validate against that
artifact and cannot import the package. An invisible rule would fail them with
no way to have known. Each is documented in a `.describe()` so it reaches the
artifact as prose, and each must be implemented when the sync endpoint is built:

| Rule | Where it is described |
|---|---|
| `consensus.agreed <= consensus.judges` | `ZConsensus` in `lesson.ts` |
| every key of `applies_to.scope.versions` names an entry in `applies_to.stack` | `ZAppliesTo` in `applies-to.ts` |

The second matters more than it looks. Depending on how retrieval treats a key
naming something absent from `stack`, the lesson either never matches or the
constraint is silently skipped — and skipping it yields a lesson that never
expires, which is the failure class the `applies_to.scope` union exists to
close, reached by a different route.

A record is kept rather than an array of `{name, range}` pairs. An array makes
`minItems: 1` native and avoids the double mechanism, but trades the empty-map
ambiguity for a duplicate-key one: nothing would stop two entries for `vite`,
and JSON Schema's `uniqueItems` compares whole items, not keys. Record keys are
unique by construction.

The comment at `applies-to.ts:11-13` currently documents the empty map as
intended behavior. It is rewritten, because the design intent is what changed.

### `ZAuthorKey` widens to 32 hex — resolving onlooker-5oz

12 lowercase hex is 48 bits, giving a birthday bound near 16M identities per
scope. Unlinkability is unaffected by truncation, so the concern is collision,
and Section 3 of the contract spec gives `author_key` two jobs where collision
does damage: org revocation and public blocking. A collision means an innocent
author is blocked alongside a bad actor, or a revoked member shares an identity
with someone still present.

`ZAuthorKey` widens to `/^[0-9a-f]{32}$/`. `ZProjectKey` stays at 12 — it is a
local-only opaque label with no security role. The two were never coupled beyond
convention; they are already separate declarations that happened to share a
regex. Truncating below a full 128-bit HMAC buys nothing, since the field is not
size-constrained anywhere that matters.

### No `N-1` translation layer

Section 5 commits the server to accepting `schema_version` `N` and `N-1`. No
plugin emits v1 lessons today, so there is nothing to translate — and nothing
to accept: `ZLesson` pins `schema_version` to the literal `2` and rejects
everything else, v1 included. The `N-1` window exists for the next bump, once
something upstream of it actually produces `N-1` lessons; building a
translation path for a version that was never produced would be a no-op with
a maintenance cost.

---

## Section 2 — The pipeline *(approved)*

Librarian gains a fifth stage; tribunal gains a rubric. Neither plugin learns a
new shape.

Librarian already owns every upstream step — artifact reader, durability filter,
Haiku classifier, Jaccard dedup, proposal queue — so the lesson transform is one
more stage on a chain that exists. The decisive argument against a new plugin is
the watermark: librarian's `last_scan.json` already tracks which artifacts have
been considered, and a separate plugin would need a second copy of that state,
free to drift.

### State

```
~/.onlooker/librarian/<project-key>/
  lessons/approved/<ulid>.json   jury passed; awaiting subsystem 3
  lessons/declined.jsonl         artifact_id + verdict + reason
```

**The declined ledger closes a hole in one-shot rejection.** The watermark
advances past a rejected artifact, so without a record a drop is either silently
permanent or — on a rescan — re-pays Opus tokens to re-judge the same failing
candidates every session. Recording the verdict makes drops auditable, keeps
re-runs cheap, and produces the data needed to tune the rubric. It is
append-only and never re-judged automatically.

### The gate is one-shot

Tribunal's default loop retries the Actor with judge critiques up to
`max_iterations`. Promotion overrides this to **1**. Below threshold, a candidate
is dropped rather than repaired.

Section 4 of the contract spec establishes the asymmetry this follows from:
refutation should be cheaper to trigger than promotion, because a wrong lesson
actively misleads while a missing one merely fails to help. Fail toward removal.
One-shot also bounds token cost per promotion, and avoids a transform that
learns to satisfy judges rather than the evidence. Nothing is lost permanently —
the artifact remains, and the declined entry records why.

### Confirmation precedes judging

The human picks which candidates go to the jury, and their intended visibility,
before any Opus tokens are spent.

This splits the two filters along their natural lines. The human judges intent —
"do I want to share anything about this?" — which is cheap and which only they
can do. The jury judges quality, which is expensive and which only it can do.
Asking the human to pre-filter for quality would defeat the jury; asking the
jury to guess intent would spend Opus tokens on every durable artifact whether
or not anyone wanted it shared. Cost scales with intent, not artifact volume.

This also keeps promotion propose-only, consistent with librarian's ADR-001.

---

## Section 3 — Visibility-scoped gating and the rubric *(approved)*

The jury is not something every lesson passes through. Section 2 of the contract
spec gives `private` no gate at all, so gating is scoped by intended visibility —
which the human has just chosen.

| Intended visibility | What runs | Why |
|---|---|---|
| `private` | no jury; straight to pool | you are the only consumer |
| `org` | `lesson-promotion` rubric | the org boundary already implies trust |
| `public` | `lesson-promotion` + disclosure lens | self-reported consensus is gameable |

Opus cost therefore attaches only to lessons someone intends to share.

The `public` server-side re-judge from the contract spec is subsystem 3's
concern. Local consensus for public lessons runs here; the pool records the
intended visibility so subsystem 3 knows what still needs server judging.

### The `lesson-promotion` rubric

| Criterion | Weight | `min_pass` | Asks |
|---|---|---|---|
| `grounding` | 0.45 | 0.7 | does the claim follow from `evidence` and `resolution`? |
| `scope_accuracy` | 0.35 | 0.7 | does `applies_to` correctly bound the claim? |
| `generality` | 0.20 | 0.6 | is this a lesson, or a session-scoped fact? |

`score_threshold: 0.75`, `gate_policy: majority`,
`aggregation_method: weighted_mean`, `judge_types: ["standard", "adversarial"]`
— all tribunal defaults. The single override is `max_iterations: 1`.

`scope_accuracy` is where onlooker-7jn is enforced at the judgment layer. The
schema guarantees a `version_independent` lesson *carries* a justification; this
criterion asks whether the justification is true. Both are needed: the schema
stops the accident, the jury stops the lazy excuse.

### The disclosure lens for public lessons

Tribunal already ships `tribunal-judge-security` with it disabled by default.
Enabling it for the public tier is exactly the second lens Section 3 of the
contract spec asks for, so no new judge agent is required.

| Criterion | Weight | `min_pass` | Asks |
|---|---|---|---|
| `disclosure` | 0.30 | **0.9** | leaks a secret or an identity, or advocates a harmful practice? |

The high `min_pass` is a deliberate near-veto. Correctness rots; harm does not.
A stale correctness claim retires itself through `applies_to`, but a leaked
credential never expires on its own, so disclosure gets a floor that a strong
weighted mean cannot average away. The correctness criteria need no such floor.

---

## Section 4 — Failure modes and testing *(approved)*

### "Judged and failed" is not "could not judge"

Only real verdicts enter `declined.jsonl`. Infrastructure failure leaves the
candidate in proposals, untouched. Conflating the two would let a single
transient outage permanently bury good candidates behind a watermark that has
already moved past them.

| Failure | Handling |
|---|---|
| Haiku emits malformed JSON | declined, `transform_invalid`; never reaches the jury |
| transform cannot infer scope | fails schema validation; declined. This is onlooker-7jn's fix working |
| `version_independent` with a hollow justification | schema passes; `scope_accuracy` catches it |
| tribunal unreachable, or judge errors | **not** declined; stays in proposals |
| jury below quorum for `majority` | treated as unjudged, not rejected |
| same artifact promoted twice | watermark, ledger, and pool all keyed by `artifact_id` |

A secret reaching `evidence.resolution` is caught only at the public tier. Org
scope relies on org trust, per Section 3 of the contract spec. This follows the
approved design rather than adding a gate it deliberately omitted, but it is the
sharpest residual risk here.

### Tests in this repo

- the `versioned` branch rejects `{}` at runtime, **and** the emitted schema
  carries `minProperties: 1` — asserted separately, since the two mechanisms
  were proven able to disagree
- `version_independent` requires a non-empty `justification`; an unknown `kind`
  is rejected
- the version-range pattern still survives inside the union — the existing
  assertion's path moves from `applies_to.properties.versions` to the
  `versioned` branch of `scope.oneOf`
- `author_key` matches 32 hex; `project_key` still matches 12
- `schema_version` is the literal `2`; the committed-schema drift guard passes

Two migration chores fall out. Every fixture carrying a 12-hex `author_key`
needs widening. And `emit-json-schema.mjs` reads from `../dist/index.js`, so the
package must be built before the schema is regenerated, or the committed
artifact goes stale without failing loudly.

### Handoff acceptance test

The artifact that motivated the contract spec is real and still on disk:
`~/.onlooker/archivist/6a7678979e31/decisions/01KZ45MKAM734ZS7JK24D2DK0R.json`.

It should transform to `kind: "versioned"` with
`{"vite": "<6", "vitest": ">=4"}`, and a session on vite 8.0.16 must not match
it. The artifact that started this becomes the test that proves it works.

---

## Open questions

**The counter-observation threshold remains unset.** Section 4 of the contract
spec flagged it as guesswork needing a real value before implementation. It is
not needed here — counter-observations require consumers of shared lessons, so
the number belongs with subsystem 3 or 4, whichever first puts lessons in front
of a reader.
