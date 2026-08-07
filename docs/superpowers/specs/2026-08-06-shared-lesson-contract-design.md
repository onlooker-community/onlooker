# Shared Lesson Contract — Design

**Status:** In progress — sections 1–2 approved, 3–5 pending
**Bead:** onlooker-66u (Design: Shared Lesson contract for cross-machine Playbooks)
**Date:** 2026-08-06

---

## Resuming this document

Sections 1 and 2 are approved and settled. Pick up at **Section 3: visibility and trust tiers in detail**, then Section 4 (staleness and lifecycle) and Section 5 (package placement and validation). Do not re-litigate sections 1–2 or the decisions in "Settled context" below; they were reached over a full brainstorming pass.

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
| 6 | Visual design system | 5 | inline styles |

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

  // ── Lifecycle (reserved; minimal now) ──
  "status": "active | refuted | superseded",
  "superseded_by": null,

  // ── Provenance ──
  "source": "local | org | public",
  "author_key": "pseudonymous",
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

## Section 3 — Visibility and trust tiers *(pending)*

Next up. Open questions to work through:

- What exactly does `author_key` mean across tiers — stable per user, per org, or per machine?
- Can a lesson move between tiers after publication (private -> org -> public), and what re-gating does that require?
- How does an org revoke a lesson a member published?
- Does the public pool need moderation beyond consensus, or is refutation sufficient?

## Section 4 — Staleness and lifecycle *(pending)*

- How does `status: refuted` get set — who or what refutes a lesson?
- Does contradicting evidence from a later session automatically refute?
- Supersession semantics when a newer lesson covers the same `applies_to` space.

## Section 5 — Package placement and validation *(pending)*

- Likely home: `@onlooker/types`, which currently declares `main: "index.ts"` and an `./integration` subpath that **do not exist** and has zero importers (bead onlooker-2a1). Fixing that is a prerequisite.
- Schema validation approach — zod is already a dependency in `packages/types` and `packages/cache`.
- How the contract is versioned as `schema_version` advances.
