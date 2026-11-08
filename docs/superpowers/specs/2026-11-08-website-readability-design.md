# Website Readability — Design

Linear: none yet. The workspace hit its free issue limit on 2026-11-08, so
this is tracked as bead `onlooker-yc7m` until an issue can be filed.

**onlooker.dev's background grid stops competing with the text, the pixel
face appears only at sizes it can render, and breadcrumbs and tags line up
with the column they sit in.**

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-11-08.
Sections marked *(measured)* were read from this repository on 2026-11-08.

## The problem *(measured)*

* **The grid is drawn at border strength.** `body::before` in
  `apps/website/src/styles/globals.css` draws 60px lines in `--border`, which
  is `--edge` (`#6b64a8`). Against `--ground` that is 3.71:1 by day and 3.04:1
  at night, while body text (`--ink`) is 10.28:1 and 11.27:1. It is
  `position: fixed`, so its radial mask fades relative to the viewport. Body
  text always scrolls over the strongest part.
* **Abaddon is drawn at sizes it cannot render.** `packages/brand/tokens.css`
  and `assets.css` say the face renders cleanly only at integer multiples of
  its 16px design size. Every rule that uses it breaks that:

  | Selector | File | Size |
  | -- | -- | -- |
  | `.headline` | `pages/index.astro` | `clamp(42px, 7vw, 84px)` |
  | `h1` | `pages/plugins/index.astro` | `clamp(32px, 5vw, 56px)` |
  | `h1` | `pages/plugins/[slug].astro` | `clamp(28px, 5vw, 48px)` |
  | `.post-header h1` | `styles/globals.css` | `clamp(28px, 5vw, 40px)` |
  | `.post-title` | `styles/globals.css` | `22px` |
  | `.prose h2, .prose h3` | `styles/globals.css` | inherited, `17px` scale |

* **Breadcrumbs inherit the site header.** The header is a bare `<nav>` in
  `layouts/Layout.astro`, styled by a global `nav { … }` rule with
  `justify-content: space-between`, `padding: 28px 48px` and a bottom border.
  The four breadcrumbs are also `<nav>` elements (`layouts/BlogPost.astro`,
  `pages/blog/tags/[tag].astro`, `pages/plugins/[slug].astro`,
  `pages/plugins/index.astro`), so each one is spread across the column,
  inset 48px and underlined.
* **Post tags are indented.** The tag list sits inside `.prose`, and
  `.prose ul, .prose ol { padding-left: 1.4em }` reaches it.

## Decisions *(approved)*

* **Grid: faint, and fades out.** It stays on every page, much lighter, and
  scrolls away with the top of the page.
* **Pixel type for page titles only.** Page titles stay in Abaddon at legal
  sizes. Blog list titles and article h2/h3 use the body sans in bold.
* **Landing headline:** 48px on phones, 80px at ≥768px.

## Out of scope *(approved)*

* The radar circles and the teal glow (`body::after`).
* ONL-270, the landing page's missing reduced-motion fallback.

## 1. The grid

* The line color is a new derived token in `globals.css`, `--grid-line`:
  `color-mix(in srgb, var(--edge) N%, var(--ground))`, with `N` chosen so the
  line measures 1.1–1.3:1 against `--ground` in both themes. One `N` serves
  both, set by whichever theme needs more.
* `body::before` uses `--grid-line`, becomes `position: absolute`, and spans
  the top `100vh` of the page. Its mask fades to transparent by the bottom
  edge, so the grid scrolls away with the header.

## 2. Pixel type

* Abaddon is used only at a multiple of 16px. A breakpoint steps between two
  legal sizes; `clamp()` and `vw` sizes are not used with it.
* **Page titles, Abaddon:**
  * blog post h1, blog index h1, plugins index h1, plugin page h1: `32px`, and
    `48px` at `min-width: 768px`. The blog index h1 is currently the body
    sans and moves to Abaddon.
  * landing `.headline`: `48px`, and `80px` at `min-width: 768px`.
* **Body sans, bold:**
  * `.post-title`: `var(--text-body-lg)` (1.25rem).
  * `.prose h2`: `1.5rem`. `.prose h3`: `1.2rem`.

## 3. Breadcrumbs

* The header `<nav>` in `Layout.astro` gets `class="site-nav"`. The global
  `nav` rule and the `nav` selectors in its two media queries become
  `.site-nav`.
* Breadcrumbs keep `<nav aria-label="Breadcrumb">` and their existing
  `.breadcrumb` styles, now without the header's padding, spacing and border.

## 4. Tags

* `.prose ul, .prose ol` becomes `.prose :is(ul, ol):not([class])`. Markdown
  lists carry no class and keep their indent; `.post-tags` loses it.

## Tests

In `apps/website/src/__tests__/`.

1. `derived-surfaces.test.ts`: `--grid-line` measures between 1.1 and 1.3
   against `--ground` in both themes.
2. A new `display-sizes.test.ts`: every rule in the website's `.css` and
   `.astro` files that sets `font-family: var(--display)` (or
   `var(--font-display)`) declares its own `font-size`, so an inherited size
   fails. That size, and every `font-size` declared for the same selector
   anywhere else in the file (a media block that only resizes it, say), is
   a px value that is a multiple of 16.
3. `globals.css` has no bare `nav` selector.
4. `layout-meta.test.ts`: the rendered layout's header nav has the class
   `site-nav`, and a blog post's breadcrumb does not.

Each test is checked by ablation: remove the code it covers and watch it
fail.

## Verification

Run the site locally and screenshot the blog index, a blog post, a plugin
page and the landing page, in both themes, at 1440px and 375px. Check that
the top-right nav is not clipped.
