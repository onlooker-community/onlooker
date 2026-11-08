# Plugin Pages From the Marketplace — Design

Linear: ONL-263 (content), ONL-264 (the launch gate). One PR fixes both.

**The plugin pages read the plugin list, versions and descriptions from
ecosystem's marketplace at build time, keep a short hand-written part per
plugin, and a check fails when the two disagree. Then `/plugins` opens.**

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-11-07.
Sections marked *(measured)* were read from this repository and from
`onlooker-community/ecosystem` on 2026-11-07.

## The problem *(measured)*

`apps/website/src/data/plugins/` holds one hand-written file per plugin.

* Versions drift faster than anyone can copy them. ONL-263, filed the same
  afternoon, lists archivist 0.9.7; it is 0.10.0, and librarian is 0.27.0.
  Ecosystem has 32 commits touching `plugins/*/.claude-plugin/plugin.json`
  since 2026-10-24.
* The marketplace lists 18 entries: `ecosystem` and 17 plugins. The site has
  16 pages. customs has none; echo is presented as a working plugin, and it
  ships no hooks (ONL-103).
* Archivist's page describes PreCompact/PostCompact extraction. So does
  archivist's own `plugin.json` description.
* `/plugins` builds as a redirect to `/`: `src/middleware.ts` runs while Astro
  prerenders, and `isPublicBeforeLaunch` (`src/lib/launch-gate.ts`) names only
  `/` and `/blog`.
* `pnpm build` builds every package, and runs in CI's quality and test jobs and
  in both deploy jobs (`.github/workflows/deploy.yml`). The website deploys
  only from the production job, after its Build step.
* `turbo.json` lists every env var `build` may see. An unlisted variable does
  not reach the task.
* Ecosystem is public. Every plugin has a `README.md`.

## Decisions *(approved)*

* **Read at build.** Not a committed snapshot, and not dropping versions.
* **A failed fetch fails only the production website build.** Elsewhere it
  falls back to a committed fixture and says so. Amended after the final
  review: the production job's main Build step runs before the API and Web
  deploys, so a strict check there would let a GitHub outage block an API
  deploy. The website is built in its own step, just before its deploy, and
  only that step is strict.
* **Slim pages.** Generated facts, plus a short hand-written part. Capabilities
  lists, config blocks and event tables go.
* **A stale description is fixed in ecosystem,** not overridden on the site.
* **ecosystem gets a page,** shown apart from the plugins as the base layer.
* **One PR.** Content lands before the gate opens.

## Out of scope *(approved)*

* A scheduled rebuild. A version bump in ecosystem reaches the site at the next
  onlooker production deploy. Pages say the version is what is on `main`.
* Rewriting ecosystem's descriptions. They are listed in a Linear issue for the
  ecosystem repo, and the site shows them unchanged until that lands.

## Reading the marketplace: `src/lib/marketplace.ts`

* Fetches `.claude-plugin/marketplace.json`, then each entry's
  `.claude-plugin/plugin.json` under its `source`, from
  `https://raw.githubusercontent.com/onlooker-community/ecosystem/main/`.
* Returns `{ source: "github" | "fixture"; plugins: MarketplacePlugin[] }`,
  where `MarketplacePlugin` is `{ name, version, description, readmeUrl }`.
  `readmeUrl` points at the README on GitHub under the entry's `source`.
* Any failure is one failure: network, a non-200, JSON that does not parse, or
  an entry whose `plugin.json` lacks `name`, `version` or `description`.
* On failure, with `MARKETPLACE_REQUIRED=1`, it throws with the reason and the
  build fails. Without it, it logs one warning line naming the reason and
  returns `src/data/plugins/marketplace.fixture.json`, with `source: "fixture"`.
* The result is memoized for the build, so every page shares one set of
  requests.
* `MARKETPLACE_REQUIRED` is declared through `astro:env`, beside
  `SITE_LAUNCHED`, and the pages pass it in. Amended after the final review:
  the Cloudflare adapter prerenders in workerd, where `process.env` does not
  carry it, so a `process.env` read saw `undefined` and the strict build
  shipped the fixture (reproduced 2026-11-07).
* In the production job, the main Build step skips the website. A Build
  Website step directly before Deploy Website to Production builds it with
  `MARKETPLACE_REQUIRED` on.

## Hand-written prose: `src/data/plugins/<name>.ts`

* `PluginProse` is `{ slug, name, tagline, category, problem, howItWorks }`.
  `howItWorks` is two to four lines, each checked against the plugin's README
  on 2026-11-07. `slug` equals the marketplace `name`.
* Every other `PluginData` field goes: `hero`, `capabilities`, `config`,
  `events`, `tables`, `tags`, `idealFor`, `skillCommands`,
  `interventionExample`.
* New files: `customs.ts`, `ecosystem.ts`. `echo.ts` is rewritten to describe
  the measurement harness its README describes.
* A page is the join of one marketplace entry and its prose. A marketplace
  entry with no prose file throws when `MARKETPLACE_REQUIRED` is on, naming
  the plugin. Otherwise it warns and leaves that plugin off the site, so an
  ecosystem release never turns onlooker's PR CI red (amended after the final
  review). The test below still fails when the committed fixture lists a
  plugin with no prose. A prose file with no entry is never rendered, and the
  test fails on it too.
* While writing the prose, every plugin whose `plugin.json` description
  disagrees with its README is listed, and one Linear issue for the ecosystem
  repo records them.

## Pages

* `/plugins/<name>`: name, version ("on main"), the marketplace description,
  tagline, problem, how it works, the install line
  `/plugin install <name>@onlooker-community`, and a link to the README. The
  `<meta>` description is the marketplace description.
* `/plugins`: ecosystem first, on its own, as what every plugin requires; then
  the plugins grouped by category, as today.

## The gate (ONL-264)

* `isPublicBeforeLaunch` also admits `/plugins` and `/plugins/*`.
* The nav links to Plugins again.
* A production build emits real pages: after
  `env -u SITE_LAUNCHED pnpm --filter @onlooker/website build`,
  `apps/website/dist/client/plugins/index.html` does not start with
  `<title>Redirecting`.

## Tests

In `apps/website/src/__tests__/`, with `fetch` stubbed where the module is
under test.

1. Every fixture entry has a prose file, and every prose file has a fixture
   entry.
2. `marketplace.ts` returns GitHub's data when every request succeeds.
3. A failed request, a non-200, bad JSON, and a `plugin.json` missing a field
   each fall back to the fixture without `MARKETPLACE_REQUIRED`, and each
   throws with it.
4. `turbo.json`'s `build.env` lists `MARKETPLACE_REQUIRED`, and the production
   Build step in `deploy.yml` sets it.
5. The gate admits `/plugins`, `/plugins/` and `/plugins/archivist`, and still
   redirects `/pluginsx`.

Each test is checked by ablation: remove the code it covers and watch it fail.
