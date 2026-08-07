# Shared Lesson Contract — Design

**Status:** Complete — all five sections approved
**Bead:** onlooker-66u (Design: Shared Lesson contract for cross-machine Playbooks)
**Date:** 2026-08-06, sections 3–5 added 2026-08-07

---

## Reading this document

All five sections are settled. The design covers **the lesson contract only** — see the scope table below for the five sub-projects that depend on it, each of which needs its own spec.

The next step from here is an implementation plan, not implementation.

---

## Settled context

These came out of brainstorming and constrain everything downstream.

| # | Question | Decision |
|---|---|---|
| 1 | What is the hosted app for? | **Shared Playbooks** — cross-person lesson sharing. Chosen because it is the one capability genuinely impossible local-first. |
| 2 | What is the unit? | **A lesson.** Playbooks are saved-query views over a pool, not containers. |
| 3 | How does a lesson reach a session? | **Tiered** — a cheap always-on set for the current context, plus a deep queryable pool on demand. This is the "Waypoint hint engine" already named on the landing page. |
| 4 | What earns auto-injection? | **Tribunal-style N-agent consensus.** Reuses an existing plugin and keeps promotion automatic. |
| 5 | Who shares with whom? | **Private / org / public in one pool from the start.** Lessons carry visibility; promotion rules differ per tier. |
| 6 | Contract shape | **Claim + evidence + applicability**, with a reserved `status` field so lifecycle work is additive rather than a migration. |

### Scope

This spec covers **the lesson contract only**. The following are separate sub-projects, each needing its own spec → plan → implementation cycle:

| # | Subsystem | Depends on | State today |
|---|---|---|---|
| 1 | **Lesson contract** ← *this spec* | — | librarian emits something adjacent locally |
| 2 | Promotion pipeline | 1 | tribunal exists, not wired to this |
| 3 | Sync + storage | 1, 2 | nothing; `apps/api` is auth-only |
| 4 | Waypoint retrieval | 1, 3 | nothing; named on landing page |
| 5 | Web app | 1–4 | auth scaffold only |
| 6 | Visual design system | 5 | brand exists in `apps/website` (`globals.css` tokens); `apps/web` uses none of it — 71 inline styles, no CSS, no fonts (bead onlooker-pbh) |

---

## The driving constraint: lessons rot

A real archivist artifact in this repo, `~/.onlooker/archivist/6a7678979e31/decisions/01KZ45MKAM734ZS7JK24D2DK0R.json`:

```json
{
  "summary": "Vitest 4.1.9 / Vite 5.x version mismatch confirmed as real, blocking bug.",
  "detail": "Running `pnpm test` reproduces failures in @onlooker/auth-react and @onlooker/db...",
  "files": ["packages/auth-react", "packages/db"],
  "source": "local"
}
```

This is **no longer true.** `apps/web` moved to vite 8.0.16 and all 267 tests pass. The claim was accurate when captured and became false without anything noticing.

It surfaced at the start of the 2026-08-06 session as background context and had to be actively disproven before work could start. Shared and auto-injected under decision 4, it would have sent someone else down the same dead end.

**Therefore: staleness must be structural, not a later phase.** A contract that relies on review queues or expiry jobs to catch rot has already failed — nobody reviews a memory store, which is the entire reason it accumulates.

Note also `"source": "local"` — the existing local schema already has a field anticipating non-local artifacts.

---

## Section 1 — The Lesson schema *(approved)*

```jsonc
{
  "id": "01KZ8F...",              // ULID, matches archivist convention
  "schema_version": 1,

  // ── The claim: what is asserted to be true generally ──
  "claim": "Pin vitest and vite to compatible majors; vitest >=4 needs vite >=6.",
  "rationale": "vitest 4 imports vite/module-runner, a subpath vite 5 does not export.",

  // ── Evidence: the receipts ──
  "evidence": {
    "artifact_ids": ["01KZ45MKAM734ZS7JK24D2DK0R"],
    "session_ids": ["e967f5f9-..."],
    "project_key": "6a7678979e31",          // opaque hash, never the repo name
    "observed_at": "2026-08-03T15:59:48Z",
    "resolution": "Upgraded vite 5.4.11 -> 8.0.16; 267 tests pass."
  },

  // ── Applicability: what Waypoint matches on ──
  "applies_to": {
    "stack": ["vitest", "vite"],
    "versions": { "vite": "<6", "vitest": ">=4" },
    "file_patterns": ["**/vite.config.*", "**/package.json"],
    "task_kinds": ["test-setup", "ci"]
  },

  // ── Trust ──
  "visibility": "private | org | public",
  "consensus": { "judges": 3, "agreed": 3, "decided_at": "..." },

  // ── Lifecycle (see Section 4; expiry is NOT a status) ──
  "status": "active | refuted | superseded | retracted",
  "superseded_by": null,

  // ── Provenance ──
  "source": "local | org | public",
  "author_key": "...",            // HMAC(user_secret, scope) — see Section 3
  "promoted_at": "..."
}
```

### Why these choices

**`applies_to.versions` is load-bearing.** The stale vitest lesson becomes scoped to `vite <6`. A session on vite 8.0.16 never matches it, so the lesson retires itself by construction — no review queue, no expiry job, no human noticing it went bad. This is what makes staleness structural rather than procedural.

**`evidence.resolution` is required.** A lesson that says "this breaks" without "and this fixed it" is a warning, not a lesson. It is also what gives tribunal judges something to check the claim against.

**`project_key` stays the opaque hash.** `manifest.json` holds the `project_key -> remote_url` mapping locally only, so a public lesson carries technical facts without leaking that the work happened in a private repo.

### Known cost

`applies_to` cannot be reliably inferred from an artifact. Something must produce it — most likely a Haiku call at candidate time, mirroring how librarian already classifies types. This is the transform step that shape B buys at the price of.

---

## Section 2 — The promotion pipeline *(approved)*

```
archivist artifacts                        EXISTS  session-scoped facts
  └→ librarian: durability filter          EXISTS  cheap pre-LLM, marker phrases + repetition
     └→ type classifier (Haiku, >=0.6)     EXISTS  user/feedback/project/reference
        └→ conflict/dup detect (Jaccard)   EXISTS  local, keeps queue high-signal
           ═══════════════════════════════════════════════════════════
           └→ lesson transform (Haiku)     NEW     claim, rationale, applies_to
              └→ tribunal gate             NEW     N judges: claim vs. evidence
                 └→ publish to pool        NEW     visibility-scoped
```

Everything above the line already runs locally. The new work is three steps, and only the last talks to a server.

### Transform and judging run locally

Raw artifacts carry repo paths, code excerpts, and occasionally secrets. Server-side judging would require uploading artifacts in order to judge them, which would make "local-first" marketing rather than architecture.

Running both locally means **only the finished Lesson ever leaves the machine** — a claim, a rationale, version ranges, and hashed provenance.

Cost: tokens per promotion, borne by the user. `bursar` already exists to make that visible.

### Gating differs per tier

| Visibility | Gate | Rationale |
|---|---|---|
| `private` | none | It is yours; you are the only consumer |
| `org` | local consensus, trusted | The org boundary already implies trust |
| `public` | local consensus **+ server-side re-judge** | Self-reported consensus is gameable by a modified client |

The `public` row matters: a modified client can simply assert `{judges: 3, agreed: 3}`. The server therefore runs its own independent judges before a lesson enters the public pool. Private and org skip this — no adversary, no cost.

### Promotion stays propose-only

Librarian's ADR-001 commits to never writing to the typed memory store without explicit user confirmation. Publishing to *other people* should be at least as gated, so a human confirms before anything leaves the machine. Auto-publish stays off, exactly as auto-promote is today.

---

## Section 3 — Visibility and trust tiers *(approved)*

### `author_key` is derived per scope, not global

```
author_key = HMAC(user_master_secret, scope)
scope = "private" | "org:<org_id>" | "public"
```

The field has three jobs, and two of them pull against each other: an org needs stable attribution in order to revoke, the public pool needs stable identity in order to block a bad actor, and an observer must not be able to correlate everything a person has ever published.

Deriving per scope satisfies all three. Org identity and public identity are unlinkable to observers, while each stays stable within its own pool.

Per-machine derivation is wrong: it fragments one person's identity across their laptops for no benefit, and org revocation would silently miss lessons published from a second machine.

### Visibility only moves up; downward is retraction

`private -> org -> public`, re-gated at each step, with `public` requiring the server-side re-judge from Section 2. A tier may be skipped — `org` is not a required waypoint.

`public -> private` is a fiction. Once a lesson is public, other machines have pulled it; flipping the field back recalls nothing and leaves the record lying about its own reach. The honest operation is `status: retracted`, which is the reserved `status` field from decision 6 paying for itself.

A lesson keeps its `id` across promotion, so `evidence.artifact_ids` and supersession links stay valid.

### Org-visible lessons belong to the org

Publishing into an org transfers custody. The author keeps attribution through `author_key`; they do not keep control.

- Any org admin can retract any lesson in org scope.
- A member leaving retracts nothing.

The alternative — lessons evaporating when someone departs — drains org knowledge at exactly the moment it is most valuable, which defeats the purpose of sharing. The cost is real and accepted: you cannot take your lessons with you.

### The public pool needs a second lens, not more judges

Tribunal judges ask whether the claim follows from the evidence. That is correctness. A lesson can be entirely correct and still unfit to publish:

- "Set `NODE_TLS_REJECT_UNAUTHORIZED=0` to fix cert errors in CI" — true, effective, terrible.
- A lesson whose `evidence.resolution` quotes a config block containing a live API key.
- A lesson naming an internal hostname or a colleague.

Correctness judges pass all three. Redundant judges catch the same class of error; different lenses catch different classes.

| Lens | Asks | Status |
|---|---|---|
| correctness | does the claim follow from the evidence? | exists (Section 2) |
| safety / disclosure | does this leak a secret or an identity, or advocate a harmful practice? | **new, public tier only** |

Plus a reactive `report -> retract` path, because the safety lens will miss things.

**Correctness rots; harm does not.** `applies_to.versions` retires a stale correctness claim by construction. A leaked credential never expires on its own. That asymmetry is why safety needs both a gate and a way to reach back, while correctness needed only scoping.

### One pool, filtered on read

Decision 5 keeps all visibilities in one store, so retrieval filters by viewer: `private` matches the requester's own scope key, `org` checks membership, `public` passes.

That filter **is** the security boundary. A bug there leaks private lessons, so it belongs in exactly one place rather than spread across every query site.

---

## Section 4 — Staleness and lifecycle *(approved)*

### Expiry is not a status

When `applies_to.versions` stops matching, nothing happens to the record. The lesson is simply not selected. No state change, no scan, no job.

This is Section 1's structural staleness doing the work, and it handles the majority of rot silently. Storing an "expired" status would require something sweeping the pool to set it — the review-queue failure mode this design exists to avoid.

Lifecycle states therefore cover only what expiry cannot reach:

| State | Means | Set by |
|---|---|---|
| `active` | in play | promotion |
| `refuted` | wrong **within its own declared scope** | consensus |
| `superseded` | a better lesson covers this ground | consensus |
| `retracted` | should not be shared regardless of correctness | org admin / safety report |

The vitest lesson that motivated this spec was never refuted. It was true, and then the world moved. That is expiry. Refutation is for claims that were wrong even in their stated scope — something `applies_to` can never catch.

### Contradiction is a signal, not a verdict

```
consumer files counter-observation   (own artifact_ids, session_id)
  └→ counter-observations accumulate on the lesson
     └→ threshold crossed -> triggers re-judgment
        └→ tribunal weighs claim vs. original evidence + counter-evidence
           └→ tribunal sets status, not the reporter
```

Auto-refuting on contradicting evidence is tempting and wrong. A session failing while a lesson matched is weak evidence: the lesson may have been applied incorrectly, the context may differ subtly, the failure may be unrelated. A lesson that merely failed to help is not wrong. Auto-refutation is also a trivial denial-of-service vector.

Routing refutation through consensus keeps a single authority over truth claims and makes refutation **symmetric with promotion** — the same machinery, run in the opposite direction. Nothing enters the pool without consensus; nothing is invalidated without it either.

One deliberate asymmetry: refutation should be **cheaper to trigger** than promotion. A wrong lesson actively misleads, while a missing lesson merely fails to help. Fail toward removal.

**Open number:** the counter-observation threshold is currently guesswork. Too high and wrong lessons persist; too low and a couple of unlucky sessions can bury a good one. It needs a real value before implementation.

### Supersession is detected locally, confirmed by consensus

Overlapping `applies_to` is not conflict. "vite <6 + vitest >=4 -> upgrade vite" and "vite <6 + rollup 3 -> pin rollup" can both hold. Auto-superseding on overlap would produce constant false positives.

Section 2's pipeline already runs conflict/dup detection locally. Extend that step: when a new candidate substantially overlaps an existing lesson **and its claim differs**, treat it as a supersession candidate and send both to the tribunal together. If confirmed, set `status: superseded` and `superseded_by: <new id>`.

### Retrieval semantics

| Status | Injected into context? | Reachable on explicit lookup? |
|---|---|---|
| `active` | yes | yes |
| `superseded` | no — follows `superseded_by` | yes |
| `refuted` | no | yes, with counter-evidence attached |
| `retracted` | no | no, except to the retracting admin |

**Nothing is deleted.** Every state change is a visibility change plus a link. Provenance stays intact, and a mistaken refutation is recoverable rather than destructive.

Superseded lessons staying reachable is what should have happened to the artifact that motivated this spec: worthless as advice, genuinely useful as history — it records that the mismatch was real on 2026-08-03 and how it resolved.

Re-judgment runs where promotion runs — locally for `private` and `org`, server-side for `public` — so Section 2's trust model holds without a second set of rules.

---

## Section 5 — Package placement and validation *(approved)*

### The defining constraint is a repo boundary

| Side | What it is | Can it import a zod package? |
|---|---|---|
| server | `apps/api` sync + storage, `apps/web` | yes |
| local | archivist / librarian / tribunal | **no** — shell-based, separate repo |

The plugins are not in this repository. `apps/website/src/data/plugins/` is marketing copy for 16 plugin pages; the implementations live in the Claude Code plugin ecosystem and are driven by shell scripts.

Per Section 2, transform and tribunal judging run locally. **The side that produces Lessons is the side that cannot import the schema.**

### Zod is the source of truth, JSON Schema is the published artifact

```
packages/lesson-contract/lesson.ts     ZLesson (zod)       <- single definition
  ├→ z.toJSONSchema(ZLesson)           lesson.schema.json  <- generated, published
  │    └→ local plugins validate against it (or simply conform)
  └→ apps/api imports ZLesson directly
       └→ sync endpoint rejects malformed lessons   <- the real boundary
```

Zod 4.4.3 ships `z.toJSONSchema` (verified in this workspace), so this costs a build step rather than a second implementation. One definition, two artifacts, no drift.

The server must validate regardless: Section 2 established that a modified client can lie, so client-side validation was never a trust boundary. Publishing the JSON Schema is a convenience for plugin authors, not a security control.

An `onlooker-schemas` Worker already exists in the Cloudflare account (created 2026-05-21) and may already be a schema-hosting service. Check it before building another.

### Versioning, given the two sides cannot be upgraded atomically

- Additive optional field -> same `schema_version`
- New required field, or changed meaning -> increment
- **The server accepts `N` and `N-1`, translating up on ingest**

The `N-1` window is forced by the repo boundary. Plugins ship on their own cadence; without a grace window every schema bump breaks every plugin that has not yet updated.

### Placement: a dedicated package, not `@onlooker/types`

| | `@onlooker/types/lesson` | **`packages/lesson-contract`** |
|---|---|---|
| Setup | zero — `./*` already resolves | new package |
| Inherited deps | drags in `node-html-parser` | zod only |
| Neighbors | 7 zero-importer vendored schemas (`ZActionClass`, `ZOverlay`, …) | only the contract |
| JSON Schema build step | odd fit | natural home |

The inherited dependency decides it. A wire contract has no business depending on an HTML parser, and anything importing `@onlooker/types/lesson` would acquire one. A dedicated package also gives the contract a clear owner, which matters once `schema_version` starts advancing.

Note that `@onlooker/types` is `private: true`, as any workspace package would be — publishing the JSON Schema, not the TypeScript package, is what crosses the repo boundary.
