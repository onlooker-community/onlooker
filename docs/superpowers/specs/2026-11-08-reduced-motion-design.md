# Reduced Motion — Design

Linear: ONL-270.

**Every animated block on onlooker.dev rests visible, and a reader who asks
for reduced motion gets no animation at all.**

## The problem *(measured 2026-11-08)*

* Six blocks start at `opacity: 0` and are revealed by the global `fade-up`
  animation with `forwards` fill. Five are in `pages/index.astro`: `.eyebrow`,
  `.headline`, `.subhead`, `.form-wrap` and `.pills`. The sixth is
  `.latest-post` in `components/blog/LatestPost.astro`.
* `Layout.astro` puts two infinite animations on every page:
  * `.logo-pulse::after` runs `pulse-ring`.
  * `.radar-sweep::after` runs `radar-rotate`.
* Nothing under `apps/website/src` mentions `prefers-reduced-motion`.
* The two hazards:
  * A reader who asked for reduced motion still gets a staggered fade, a
    pulsing logo and a rotating sweep.
  * Anything that stops an animation from running leaves those six blocks
    invisible, because invisible is their resting state.

## Decisions *(approved)*

* **The resting state is visible.** The six blocks drop `opacity: 0`. Their
  animation fill changes from `forwards` to `both`, so each is still hidden
  through its delay by `fade-up`'s first keyframe and lands on its resting
  state. Normal-motion readers see the same sequence as today.
* **One global rule turns animation off.** `globals.css` gains
  `@media (prefers-reduced-motion: reduce)` with
  `*, *::before, *::after { animation: none !important; }`. The selector is
  global so the next animated block is covered without anyone remembering
  this rule. `!important` lets it beat scoped page styles. Under it:
  * The six blocks render in place at full opacity.
  * The pulse ring sits still at its resting style.
  * The radar sweep line stays still.
* **Transitions stay.** The 0.15s color, background, border and opacity
  hover transitions don't move anything.
* Rejected: shortening every animation to 0.01ms. It keeps invisible as the
  resting state, so the second hazard stays.

## Tests

In `apps/website/src/__tests__/`. The stylesheet parser in
`display-sizes.test.ts` moves to a shared, non-test module, `stylesheets.ts`,
and both tests import it. A new test, `reduced-motion.test.ts`, reads every
`.css` file and every `.astro` `<style>` block, and checks:

1. No rule that declares an `animation` also declares `opacity: 0`.
2. Every rule that runs `fade-up` uses `both` or `backwards` fill. Without
   it, a visible block would flash during its delay before fading in.
3. `globals.css` has a `prefers-reduced-motion: reduce` rule. That rule's
   selector covers `*`, `*::before` and `*::after`, and it declares
   `animation: none !important`.
4. At least six `fade-up` rules are found, so the test can't pass because
   the parser stopped seeing them.

Each test is checked by ablation.

## Verification

* Run `astro dev` and load `/`.
* With normal motion, the six blocks are hidden at load and end at
  opacity 1.
* With the reduced-motion rule's declarations applied unconditionally: the
  six blocks compute `animation-name: none` and opacity 1, and both `::after`
  pseudo-elements compute `animation-name: none`. The browser tool can't
  emulate the media query, which is why this check applies the rule's
  declarations by hand.

## Out of scope

* Hover transitions.
* The plugin pages' hover effects.
