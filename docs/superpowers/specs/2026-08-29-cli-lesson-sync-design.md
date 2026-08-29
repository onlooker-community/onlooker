# CLI Lesson Sync — Design

Bead: `onlooker-v72`. Closes the production break tracked in `onlooker-33i`.

Applies to `apps/cli` (new), `packages/lesson-contract`, the Homebrew tap at
`onlooker-community/homebrew-tap`, and the archival of
`onlooker-community/onlooker-cli`.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-08-29 and are
decisions, not proposals. Open questions are collected at the end and are the
only things still genuinely undecided.

## Boundary

**In scope:** a new `apps/cli` in this monorepo with three commands — `link`,
`sync`, `status` — that pushes approved lessons to the hosted API; the build and
release machinery to ship it; and the Homebrew formula that installs it.

**Out of scope, deliberately:** event telemetry. The ecosystem's 17 plugins emit
a canonical event envelope to `~/.onlooker/logs/*.jsonl` and nothing on this API
receives it. That gap is real and is the larger half of what the old CLI did, but
it needs an ingest endpoint that does not exist — schema, storage, retention,
cost — and that is a spec of its own. Lessons ship first because their ingest
endpoint already exists, is contract-tested on both implementations, and is what
the machine token authenticates.

**Also out of scope:** the old CLI's onboarding (host detection, the ecosystem
plugin catalog, the install wizard — roughly 1,600 lines) and its flat-file
record store. Neither is needed to get a lesson from disk to the pool.

---

## Section 0 — What is already true *(context, not decisions)*

**The shipped CLI is broken in production, silently.** Verified live on
2026-08-29: `api.onlooker.dev/v1/ingest` and `/v1/auth/link` both return 404
`Route not found`, while `/auth/me` and `/api/lessons` return 401 on the same
host. This monorepo's Worker owns `api.onlooker.dev` — `apps/api/wrangler.toml`
declares it under `[env.production]` — and serves no route under `/v1`. The
endpoints the CLI calls were implemented in `onlooker-community/onlooker-app`, a
Fastify predecessor that this monorepo replaced.

The failure is invisible. `internal/sync/sync.go`'s `sync()` maps every non-2xx
to one generic error, logs `"sync failed — will retry"`, and returns without
marking rows synced. A 404 is therefore indistinguishable from a flaky network:
the daemon retries the same batch every 30 seconds forever while
`~/.onlooker/buffer.db` grows without bound. Tracked as `onlooker-33i`.

**The predecessor is still running.** `api-onlooker.fly.dev/v1/ingest` returns
401, not 404 — the Fly service exists and would accept a valid token. Last commit
there was 2026-07-26.

**The formula is behind the CLI.** `Formula/onlooker.rb` is pinned at v1.10.0
(2026-06-15) while `onlooker-cli`'s latest release is v1.11.2 (2026-08-01). So
`brew install onlooker` today installs June's binary.

**The lesson pool has no producer.** The old CLI contains zero lesson references
— it only ever carried events, boundaries and artifacts. The ecosystem's
`librarian` plugin produces and validates lessons on disk and stops there.
Nothing anywhere calls `POST /lessons`, which is why "Nothing has synced yet" is
production's only possible state on the pool surface.

**Both halves of what this CLI needs already exist.** `POST /api/machines` mints
machine tokens, browser-authenticated by design, revealed once on the Machines
page — the spec for that surface says in as many words "paste it into a plugin's
config." And `POST /lessons` accepts `{ lessons: [...] }`, machine-token
authenticated, at most 100 per batch, with `api-contract` cases pinning it on
both the mock and the real API.

**`librarian`'s storage layout**, from
`plugins/librarian/scripts/lib/librarian-lesson-storage.sh`:

```
<project>/lessons/proposals/<ulid>.json   awaiting human confirmation
<project>/lessons/approved/<ulid>.json    jury passed
<project>/lessons/declined.jsonl          append-only, never re-judged
```

One JSON file per lesson, named by its ULID — which is the id the server dedupes
on. The full path, verified on a real machine on 2026-08-29, is
`$ONLOOKER_DIR/librarian/<12-hex project key>/lessons/`, with one directory per
project.

**Nothing writes to `approved/` yet, and that is the largest fact in this
document.** `librarian_lesson_storage_init` creates the directory, but the
storage script marks the promotion step as *"written by 4z8.4"* — an unbuilt
issue in the ecosystem repository. Measured on the same machine: sixteen project
directories, exactly one with a `lessons/` subtree, containing `proposals/` only.
Two proposals, zero approved lessons.

A proposal is also not a lesson. It is a wrapper:

```
{ id, artifact_id, confirmed_at, status, visibility,
  candidate: { claim, rationale, applies_to, evidence } }
```

Against `ZLesson` it lacks `author_key`, `consensus`, `promoted_at`,
`schema_version`, `source` and `superseded_by`, and its `id` is a short slug
rather than the 26-character ULID the contract requires. Promotion is therefore
real work — judge the candidate to produce `consensus`, derive the author key,
mint a ULID, stamp `promoted_at` — even though `librarian-lesson-judge.sh` and
`librarian-author-key.sh` already exist to help.

**The consequence, accepted deliberately:** this CLI will sync zero lessons until
`4z8.4` ships, and the pool will stay empty. It is built now anyway because it is
small, correct, and ready the moment promotion lands; because it is verifiable
end-to-end today against a hand-written fixture (Section 7); and because the
alternative is blocking a self-contained piece of work in this repository on a
shell plugin in another one.

---

## Section 1 — What the CLI does *(approved)*

Three commands, no background process.

| Command | Behavior |
|---|---|
| `onlooker link` | Prompts for a machine token, verifies it, writes it to config. |
| `onlooker sync` | Reads approved lessons, validates, pushes in batches, reports. |
| `onlooker status` | Whether a token is stored and still authenticates; how many approved lessons exist locally. |

**Rejected: a daemon.** The old CLI watches with fsnotify and syncs on a timer,
installed via `brew services`. Lessons are produced at session end rather than
continuously, and the server dedupes, so there is nothing a daemon buys here
except the machinery to keep it alive. Removing it deletes fsnotify, the SQLite
buffer, launchd, and the failure mode where a dead endpoint fills a database
forever.

**Rejected: onboarding and the record store.** Host detection, the plugin
catalog, the install wizard and the flat-file store are roughly 1,900 lines that
have nothing to do with getting a lesson to the pool. They stay behind in the
archived repo until something needs them.

---

## Section 2 — Linking *(approved)*

`onlooker link` **prompts** for a machine token minted on the Machines page,
verifies it with `GET /lessons?since=0&limit=1`, and writes it to config.

The verification route matters and is easy to get wrong. A machine token
authenticates exactly three routes — `POST /lessons`, `GET /lessons` and `POST
/lessons/:id/status`. It does **not** authenticate `/api/lessons`, which is the
browser's session-authenticated read; pointing `link` at that would reject every
valid token. `GET /lessons` with `since=0&limit=1` is the cheapest call the token
can make and has no side effects, which is what makes it the right probe.

Prompted rather than passed as an argument, so the token does not land in shell
history. It is a credential shown exactly once and recoverable only by revoking
the machine and minting another.

**Rejected: the device-authorization flow the old CLI used.** `POST
/v1/auth/link` returned a `link_url`, the CLI opened a browser and polled `GET
/v1/auth/poll` every three seconds until the user approved. Better UX and it
costs two new API endpoints, a short-lived pending-link record, and a browser
page to claim it — duplicating a credential path that already exists and shipped
with tests. Worth revisiting once lessons are flowing; not worth blocking on.

---

## Section 3 — Sync *(approved)*

`onlooker sync` reads `$ONLOOKER_DIR/librarian/*/lessons/approved/*.json`, parses
each file, validates it against `ZLesson`, and `POST`s to `/lessons` in batches of
at most 100 — the server's `MAX_BATCH`.

**An explicit path, not a recursive glob.** The old CLI tails any `*.jsonl` under
the root recursively, which is right for events because plugins write them in
several places. Lessons have exactly one home, and naming it lets `status`
distinguish three states a recursive glob collapses into one silent zero: no
`$ONLOOKER_DIR` at all, an `$ONLOOKER_DIR` with no `librarian/` directory, and a
real `approved/` that happens to be empty. Given that the third state is the
expected one until promotion ships, telling it apart from the first two is the
difference between "nothing to sync yet" and "your install is wrong."

**The sync is stateless.** No SQLite, no cursor, no watermark, no local record of
what has been sent. `createLessonsWithFeed` returns `created` or `taken` per
lesson, so an id already pushed comes back `taken` rather than erroring, and
re-pushing is free. A crashed run just re-runs.

That is most of the old CLI's machinery deleted, and with it the defect in
`onlooker-33i`: there is no buffer to fill silently, because there is no buffer.

**Validation shares the contract.** The CLI imports `ZLesson` from
`packages/lesson-contract` — the same zod schema `apps/api` validates with. A
lesson the API would reject fails locally first, with the same error, and there
is no second copy of the schema to drift. The Go CLI vendors `event.v1.json` from
the `schema` repo instead, which is the looser coupling this arrangement exists
to avoid.

**Errors distinguish retryable from terminal.** The old CLI's `send()` maps every
status ≥ 400 to one generic error, which is exactly why a 404 read as a flaky
network for two months. This one separates them:

| Condition | Response |
|---|---|
| 401 | The token is bad or revoked. Say so, and name `onlooker link`. |
| 404 | The endpoint is gone. Name the URL that 404'd — this is the failure that hid. |
| 400 | The batch was rejected. Surface the API's message; the contract error names the field. |
| 5xx, timeout, connection refused | Transient. Say it will succeed on a retry. |

Only the last is worth retrying, and since the command is on-demand, "retry"
means the user runs it again rather than a loop that hides the problem.

---

## Section 4 — Language and distribution *(approved)*

**TypeScript, in `apps/cli`, bundled to a single JS file.** It builds with the
turbo tasks already here, and it can import `packages/lesson-contract` directly —
which is the whole argument. This repo has twice built shared-contract packages
to stop drift: `api-contract` after a response-shape mismatch blanked the
dashboard for every logged-in user, and `lesson-contract` for the ecosystem. A
CLI that validates against the same schema the API validates against is that
pattern applied once more.

**The Homebrew formula declares `depends_on "node"`** and installs the bundled
JS with a bin shim. The artifact is small and there is no compile step. Node's
startup cost is irrelevant for a command that runs for half a second, which is
only true because Section 1 rejected the daemon.

**Rejected: a compiled standalone binary** via `bun build --compile` or Node SEA.
Same contract-sharing win with no runtime dependency, but Bun is not in this
monorepo, the artifact runs 55–90MB against Go's few, and it is more build
machinery to maintain for a short-lived command.

**Rejected: Go.** Small static binaries and goreleaser already writes and pushes
the formula, which is a proven path. But it puts a second toolchain in a pnpm
monorepo, and it cannot import the typed contract — it would re-vendor JSON
Schema and be free to drift from the API in exactly the way the shared packages
exist to prevent.

**This monorepo has no release pipeline.** Its workflows are `deploy.yml`,
`heartbeat.yml` and `client-error-monitor.yml`; the root package is `0.0.0` and
private. Tag, build, GitHub release, and formula regeneration are all new
machinery, written here rather than inherited.

---

## Section 5 — The Homebrew migration *(approved)*

**The formula keeps the name `onlooker`.** `Formula/onlooker.rb` already exists
and points at the dead Go binary; replacing its contents means `brew upgrade
onlooker` moves existing users onto the working CLI. The upgrade path is the
deprecation notice, which is the only thing that reaches someone whose daemon has
been quietly buffering into a 404.

**The version starts at 2.0.0.** It has to clear the old CLI's latest release
(v1.11.2) or `brew upgrade` will not take it, and a major bump is honest about
what changed: different language, different repository, no daemon.

**The formula drops the `service` block and gains a caveat.** Today it declares
`run [opt_bin/"onlooker", "daemon"]` with `keep_alive true` under launchd. The
new CLI has no `daemon` command, so anyone who ran `brew services start onlooker`
will have launchd relaunching a binary that rejects the argument. Homebrew cannot
stop that service on our behalf, so the formula must tell the user to run `brew
services stop onlooker`, and the caveat is the only place that message can live.

**`deploy.yml` needs a path filter.** It triggers on any push to `main` with no
path filter and `cancel-in-progress: true`. Once `apps/cli` exists, a CLI-only
commit kicks off an API and web production deploy and can cancel one in flight.
That is a pre-existing hazard this work makes reachable, so it is fixed here.

---

## Section 6 — The old repository *(approved)*

**Archive `onlooker-community/onlooker-cli`; do not delete or rename it.**
Homebrew downloads release assets from that repository — the current formula
points at `releases/download/v1.10.0/…`. Archiving makes it read-only while
keeping every release downloadable, so anyone pinned to an old version keeps
working. Deleting or renaming 404s those URLs.

Archiving happens **after** the formula flips, so there is no window where the
formula points at a repository in an unexpected state.

No final release is cut from it, and no deprecation notice is needed. **The old
CLI was never publicly released** — confirmed on 2026-08-29 — so there is nobody
to migrate and nothing owed. Section 5's formula replacement still keeps the
`onlooker` name, but for tidiness rather than migration: it is the name the tool
should have, and there is no installed base competing for it.

---

## Section 7 — Testing *(approved)*

- **Validation parity.** A lesson rejected by `ZLesson` locally is the same
  lesson the API rejects. This is the property that makes sharing the contract
  worth anything, and it is the one test that would fail if someone vendored a
  second copy of the schema.
- **Batching.** More than 100 approved lessons produces more than one request,
  and no request exceeds `MAX_BATCH`.
- **Error classification, one test per row of Section 3's table.** The 404 case
  matters most: it is the exact failure that hid for two months, and a test that
  a 404 produces a terminal message naming the URL is what stops it recurring.
- **Idempotence.** Running `sync` twice against the same lessons is safe and the
  second run reports them as already present rather than as new.
- **The formula.** Its generated version and `sha256` match the release artifact.
  A formula that installs the wrong bytes fails in a way no unit test sees.
- **End-to-end, against a fixture.** Since `approved/` has no producer yet
  (Section 0), the only way to prove the whole path works is to hand-write one
  contract-valid lesson into `approved/` and watch it reach the pool: `link`,
  `sync`, then the lesson visible at `/lessons` in the browser. That fixture is
  also the thing that will catch a promotion step, when it lands, emitting
  something `ZLesson` rejects — so it belongs in the repository rather than in
  someone's notes.
- **The empty case is a first-class outcome, not an edge.** Until promotion
  ships, zero approved lessons is what every real run returns. `sync` reporting
  "nothing to sync" and exiting successfully is the common path and deserves a
  test saying so, distinct from the three states Section 3 asks `status` to tell
  apart.

---

## Section 8 — Sequencing

Five pieces, each independently reviewable.

| # | What | Visible? |
|---|---|---|
| 1 | `apps/cli` scaffold, config, `link` | Yes |
| 2 | `sync` — glob, validate, batch, push, error classification | Yes |
| 3 | `status` | Yes |
| 4 | Bundle, release workflow, `deploy.yml` path filter | No |
| 5 | Formula regeneration, service-block removal, caveat | Yes |

Piece 4 lands before 5 because a formula pointing at a release that does not
exist is worse than no formula change. The old repository is archived after 5,
per Section 6.

---

## Open questions

None. The three carried out of the design conversation were settled on
2026-08-29.

**Users of the old CLI:** there are none. It was never publicly released, which
removes the only argument for a farewell release and simplifies Section 6 to a
plain archive.

**Where `$ONLOOKER_DIR` puts lessons:** `librarian/<12-hex project key>/lessons/`,
verified against a real installation rather than inferred. Section 3 names the
path explicitly instead of globbing recursively, and Section 0 records the
sixteen project directories it was measured against.

**Whether a `SessionEnd` hook should call `sync`:** not yet, and the trigger was
wrong anyway. Sync has something to do only after a proposal is *promoted*, which
`SessionEnd` does not do and which nothing currently does at all (Section 0). A
hook belongs with the promotion step, in the ecosystem repository, once `4z8.4`
exists — attaching one now would fire on every session end to find an empty
directory.

One thing to watch during implementation rather than decide now: the fixture in
Section 7 is a hand-written lesson, so it encodes one person's reading of
`ZLesson` at one moment. If the promotion step later emits something the fixture
does not resemble, the fixture was the guess and the promotion step is the
evidence — update the fixture, not the contract.
