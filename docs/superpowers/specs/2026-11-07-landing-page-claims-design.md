# Landing Page Claims — Design

Linear: ONL-267. Related: ONL-259 (the blog, shipped), ONL-263 and ONL-264
(the plugin pages, still gated).

**`/` stays a waitlist for the hosted product, but every claim on it names
something that ships today, and it links to the blog's latest post.**

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-11-07.
Sections marked *(measured)* were read on 2026-11-07.

## Where the page is today *(measured)*

`apps/website/src/pages/index.astro` holds an eyebrow ("Coming Soon"), a
headline, a subhead, the waitlist form and six pills.

* "Waypoint hint engine" and "Shared Playbooks" name nothing that exists.
* "13+ plugins" undercounts. `ecosystem/.claude-plugin/marketplace.json` lists
  18 entries: the `ecosystem` base plugin, 16 others, and `echo`, which ships
  no hooks since ONL-103. Whether that is 16, 17 or 18 depends on what counts.
* The subhead's "making every agent smarter than the last" points at nothing a
  reader can check.
* "Claude Code native", "Local-first" and "Open source plugins" are true. The
  ecosystem repo is public and MIT licensed.
* The page does not link to the blog.

## Decisions *(approved)*

**Same shape, honest copy.** The page keeps its hero and waitlist. A "what runs
today" strip or a full landing page would duplicate the plugin pages ONL-264
will open; the landing page can grow once they are public.

**Drop the plugin count.** A number here goes stale before ONL-263 settles
where the count comes from. When ONL-264 opens `/plugins/`, a "Browse the
plugins" pill can link there.

## Copy *(approved)*

* **Eyebrow:** `Hosted version coming soon`. The plugins already ship; only the
  hosted product is coming.
* **Headline:** unchanged — "Your agents are / *learning the hard way.*"
* **Subhead:** "Onlooker is a set of open-source Claude Code plugins that watch
  what your agents do: which change wrote which line, which claims the commands
  actually back up, what a session decided before its context ran out.
  Everything stays on your machine." (lineage, assayer, archivist.)
* **Form note:** `No spam. Hosted early access + launch updates only.`
* **Pills**, in this order:
  * `Claude Code plugins`
  * `MIT licensed`, linking to
    `https://github.com/onlooker-community/ecosystem/blob/main/LICENSE`
  * `Local-first`
  * `Source on GitHub`, linking to
    `https://github.com/onlooker-community/ecosystem`
* **Latest post line**, under the pills:
  `Latest post: <title> →`, linking to the newest published post.

Removed: "Coming Soon", "13+ plugins", "Waypoint hint engine", "Shared
Playbooks", "Open source plugins" (folded into the subhead and the license
pill), and the subhead's "smarter than the last".

## Design *(approved)*

* **`src/components/blog/LatestPost.astro`** (new, beside `PostList.astro`). Props: `post?` with `id` and
  `data.title`. Renders `Latest post:` and a link to `postPath(post.id)` whose
  text is the title followed by ` →`. Renders nothing when `post` is undefined,
  so a build with no published post shows no dead line.
* **`index.astro`** calls `publishedPosts()` from `src/data/blog.ts`, the only
  reader of the collection, so the draft filter applies. It passes the first
  post to `LatestPost`. The page stays `prerender = true`.
* The two linked pills are `<a class="pill">` with `target` unset (same tab).
  Their hover changes the border to `--accent` and nothing else: no new
  background, so no new derived surface and nothing new for
  `derived-surfaces.test.ts`.
* Unchanged: the form, the formsubmit.co endpoint, the telemetry script, the
  640px responsive rule, the launch gate (`/` and `/blog/**` are already
  public; GitHub is external).

## Testing *(approved)*

* `src/__tests__/latest-post.test.ts`, through `AstroContainer`:
  * links the title to `/blog/<id>/`;
  * renders no link and no "Latest post" text when `post` is undefined.
* `src/__tests__/landing-copy.test.ts`, reading `index.astro` as text:
  * none of `Waypoint`, `Playbook`, `13+`, `smarter than the last` appear;
  * `https://github.com/onlooker-community/ecosystem` appears;
  * `https://formsubmit.co/ajax/early@onlooker.dev` still appears.
  * Prove the retired-claims test by ablation: restore one claim, watch it
    fail, revert.
* Manual: `astro build`, confirm `dist/` has the latest-post link on the index
  page, then screenshot `/` at 360px in light and dark — pills wrap, no
  horizontal scroll.

## Out of scope

* The plugin pages and their count (ONL-263, ONL-264).
* A glossary (ONL-265).
* Any change to the headline's design, the form's behavior or the nav.
