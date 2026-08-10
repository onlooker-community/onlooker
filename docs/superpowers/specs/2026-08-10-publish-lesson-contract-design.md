# Publishing the Lesson Contract — Design

**Status:** Approved — not yet implemented
**Date:** 2026-08-10
**Bead:** `onlooker-1kg`

---

## Why this exists

`packages/lesson-contract` generates `lesson.schema.json` and
`counter-observation.schema.json`. Nothing publishes them, so no consumer
outside this repo can obtain the contract we own.

The ecosystem repo shipped its lesson transform on 2026-08-09 and worked around
this by vendoring copies into `plugins/librarian/schema/*.subschema.json`, since
its hooks are bash and cannot import our zod source. Its guard,
`scripts/lint/check-lesson-schema-drift.mjs`, is explicit that it is a
placeholder — it verifies only that `PROVENANCE.json` still pins
`schema_version: 2` and that the vendored files parse. Nothing compares against
us.

So a bump to `schema_version: 3` leaves their copies at 2 with a green check,
and their transform keeps emitting against a contract that no longer exists.
The API's ingest validation would reject those lessons, which is the correct
backstop, but it converts a deliberate change here into a mystery outage there.

### What this is not

An earlier draft of this work proposed consolidating
`github.com/onlooker-community/schema` into this monorepo, on the premise that
its HTTP publishing was broken. **That premise was false.**
`schema.onlooker.dev/schemas/event.v1.json` returns `200` with valid JSON, as
does `/schemas/payload/session.json`. That repo's `public/schemas/` is
gitignored build output produced by `scripts/prepare-static-assets.js` during
deploy — not evidence of a broken pipeline. The consolidation spec was withdrawn
and its bead (`onlooker-bzj`) closed as invalid.

That repo works. This design touches nothing in it.

## What ships

`packages/lesson-contract` becomes the first published package in this
repository.

| | |
|---|---|
| published name | `@onlooker-community/lesson-contract` |
| current internal name | `@onlooker/lesson-contract` (private) |
| registry scope | `@onlooker-community` — the scope the org already publishes `schema` under |

The rename is required: `@onlooker/*` are private workspace names and that scope
is not ours on the registry. `@onlooker-community/lesson-contract` is currently
a `404` there, so the name is free.

**The rename costs nothing internally.** The only occurrence of
`@onlooker/lesson-contract` anywhere in this repository is its own
`package.json` — no source file imports it, and `turbo.json` does not name it.
Nothing in `apps/api` consumes it either, so the ingest-side enforcement the
promotion pipeline design describes is still future work and is not disturbed
here.

### Package shape

```jsonc
{
  "name": "@onlooker-community/lesson-contract",
  "version": "2.0.0",
  "exports": {
    ".":          { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./schema/*": "./schema/*"
  },
  "files": ["dist", "schema"]
}
```

`private: true` is removed. The `./schema/*` export is what the ecosystem's
check consumes; the root export serves any future TypeScript consumer.

`dist/` is gitignored, so CI must build before packing. `schema/` is committed,
so the JSON artifacts are in git and ship without a build — but the build is
still required for `dist/`.

### Versioning: package major tracks `schema_version`

Publish at **`2.0.0`**, because the contract is at `schema_version: 2`.

The emitted schema already declares its own version — `schema_version` is
`{"type": "number", "const": 2}` in `lesson.schema.json` — and the ecosystem's
`PROVENANCE.json` pins the same number. Aligning the package major with it makes
the relationship legible at a glance and makes the rule mechanical: a
`schema_version` bump is a breaking change, so it is a major bump. Ordinary
additive changes move the minor.

This spends semver majors faster than a typical library. That is acceptable for
a contract package, where a schema change genuinely is breaking for consumers.

**If you would rather not couple them**, publish at `1.0.0` and treat the two
numbers as independent — the rest of this design is unchanged. The coupling is a
convenience, not a requirement.

## Two guards

The publishing mechanism is the easy half. Both failure modes below are silent,
and both recreate the staleness this bead exists to remove.

### Guard 1 — committed schema stale against the zod source

Someone edits `src/*.ts` and does not rebuild, so `schema/*.json` no longer
describes the contract. Everything downstream then consumes a lie.

Emission is byte-deterministic — verified by rebuilding and comparing
checksums, which were identical — so CI can simply rebuild and assert nothing
changed:

```bash
pnpm --filter @onlooker-community/lesson-contract build
git diff --exit-code packages/lesson-contract/schema/
```

A non-empty diff fails the job. This guard is independent of publishing and
worth having regardless.

### Guard 2 — schema changed without a version bump

The schema changes and the version does not, so nothing publishes and consumers
keep resolving the old contract while our source has moved. This is the original
failure, relocated to our side of the line.

CI fails when `packages/lesson-contract/schema/**` differs from the merge base
while `packages/lesson-contract/package.json`'s `version` does not.

## Publishing

On merge to `main`: if `package.json`'s version differs from the registry's
latest for that name, build, pack, and publish. Otherwise do nothing.

No release-please, no changelog automation, no config enumerating which of the
ten private packages and three apps to exclude. The version in `package.json` is
the single source of truth, and Guard 2 is what stops it being forgotten.

Requires an `NPM_TOKEN` secret. This repo has never published anything, so this
is its first publish credential — scope it to publish-only.

**The first publish is manual-ish by nature:** the package does not exist on the
registry yet, so the "version differs from latest" comparison has no latest to
compare against. The implementation must treat "not found on registry" as
"publish it," not as an error.

## Verification

Every check observes the artifact, not a green job.

| Claim | How it is checked |
|---|---|
| the tarball contains what we think | `npm pack --dry-run` file list, read before the first publish |
| it published | `npm view @onlooker-community/lesson-contract version` |
| a consumer can actually import the schema | in a scratch dir: install the published version, `import` the schema subpath, assert `schema_version.const === 2` |
| Guard 1 fails when it should | edit a zod field, do not rebuild, confirm CI fails |
| Guard 2 fails when it should | change the schema, leave the version alone, confirm CI fails |

The last two matter most. A guard that has never been observed failing is
indistinguishable from one that cannot fail — this repository produced two of
those in a week, and a third that I mistakenly reported as a third. Break each
one deliberately and watch it catch.

## Out of scope

**Everything in the ecosystem repo.** Adding the dependency and upgrading
`check-lesson-schema-drift.mjs` from a provenance-pin check to a real comparison
is their work. This makes it possible; it does not do it. Worth telling them
once the package is on the registry.

**The third representation.** `librarian-lesson-validate.sh` enforces the
contract with hand-written `jq` rules mirroring the vendored JSON. Publishing
closes the gap between our zod and their vendored copies and does nothing about
their jq mirroring by hand. That gap is theirs and remains open.

**`counter-observation.schema.json` consumers.** It ships in the package because
it is generated alongside, but nothing consumes it yet, and the
counter-observation threshold is still an open number in the promotion pipeline
design. No consumer work is implied.

**Changelog automation.** If publishing becomes frequent enough to want one,
release-please is the org's existing pattern and can be added later without
undoing any of this.
