# The Web App's Edges — Design

Bead: `onlooker-lo1x`. `apps/web` only.

The authenticated interior of the app is built out — the lessons pool and its
detail pane, machines, activity, settings, profile, every one of them inside
`AppShell`. Its edges are not. This is about the places a person arrives,
waits, mistypes, and leaves.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-15.
Sections marked *(measured)* were read on this machine on 2026-09-15 against
`main` at `b8b4b6e`; each names the file it came from.

## What is wrong *(measured)*

**A refresh shows nothing at all.** `RequireAuth` takes a `loadingFallback` and
defaults it to `null` *(`packages/auth-react/src/index.tsx:563`)*, and `apps/web`
never passes one — there is no call site anywhere in the app. So
`if (auth.loading) return <>{loadingFallback}</>` renders empty, and a hard
refresh of `/lessons`, `/machines`, `/activity`, `/settings` or `/profile` paints
a blank white page — no nav, no heading, no frame — until the session resolves.
Five routes, every reload. This is the largest of the five problems here and the
least visible in a screenshot, because it is a state you pass through.

**Loading text disagrees with itself four ways.**

| Where | What it renders |
|---|---|
| `ActivityPage.tsx:109` | bare `<p>Loading your activity…</p>` |
| `ProfilePage.tsx:32` | bare `<p>Loading your profile…</p>` |
| `MachinesPage.tsx:271` | muted `<p>Loading machines...</p>` |
| `LessonDetail.tsx:251` | inline `Loading that lesson...` |

Three stylings and two ellipsis conventions, plus four more `loadingLabel`
strings on buttons (`"Logging in..."`, `"Sending..."`, `"Minting..."`,
`"Working..."`).

**Every page has the same title.** `apps/web/index.html:6` sets
`<title>Onlooker</title>` and nothing ever changes it. No page calls
`document.title`; there is no title hook. So every browser tab, every history
entry, every bookmark, and every screen reader's page announcement says
"Onlooker" regardless of where you are.

**The 404 is a bare div.** `<Route path="*" element={<div>404 Not Found</div>} />`
*(`App.tsx:124`)* — outside the shell, unstyled, no heading.

**`/` is a leftover.** A 21-line `HomePage` with inline styles, outside
`AppShell` and outside `RequireAuth`, reading "Welcome to the Onlooker platform"
over a link to the pool. It predates `onlooker-yfw`, which deleted the
placeholder dashboard — handler, both contract cases, the mock branch,
`DashboardData` and `DashboardPage` — and landed `RequireAuth` on `/lessons`.
The landing route already moved; this did not follow it.

## Why derive from the route table *(approved)*

Every one of these could be fixed by editing five pages. That is the approach
this repository already tried and already rejected once.

`onlooker-eqb` was filed because two of the five shell routes named themselves
nowhere in their heading outline — `/activity`'s first heading was a date — and
`/settings` announced "Settings, current page" above an `h1` reading "Account
settings". The fix was not to correct five headings. It was to render the
heading from `SECTIONS`, the one place a route's name is defined, so the pages
*cannot* drift. `AppShell.tsx` says it plainly: a sixth route "gets a heading by
existing rather than by someone remembering."

Titles and loading frames are the same kind of property as headings — per-route,
boring, and exactly the kind of thing a new route silently omits. So they hang
off the same mechanism. The cost is real and worth naming: `SECTIONS` becomes
load-bearing for three things instead of one, and a mistake in it now shows up
in three places.

The pieces that are not route-shaped — the loading state inside `LessonDetail`,
which is a child pane rather than a route section — get a shared primitive
instead. Deriving those from a route list would be forcing the mechanism past
where it fits.

## Constraint: the route list that exists cannot be used *(measured)*

`PARAMETERIZED_ROUTES` and `routeName()` already exist and already answer "which
route pattern is this path" *(`apps/web/src/monitoring.provider.ts:25-37`)*.
They are the obvious thing to reuse and must not be reused.

`monitoring.provider.ts` is the lazily-imported provider chunk. `monitoring.ts`
is deliberately provider-free so that `@sentry/*` stays out of the main bundle;
that split took the main bundle from 149.56 kB to 94.98 kB gzip and moved 50.95
kB into a chunk that loads after the app. An import from the main bundle would
pull the provider chunk back into it and undo that silently — the bundle would
grow, and nothing would fail.

Titles therefore need their own source in the main bundle. The duplication is
accepted deliberately: `PARAMETERIZED_ROUTES` covers three parameterized
patterns for transaction naming, and the title list covers named routes for
display. They overlap on `/lessons/:id` and nowhere else.

## The design *(approved)*

### 1. One section matcher

`AppShell` resolves which section a path belongs to — exact match, or `to` plus
a slash as a prefix so `/lessons/:id` resolves to Lessons, with the slash there
so a future `/lessons-archive` does not match. Extract that predicate to an
exported function beside `SECTIONS`.

Both the shell and the title logic then ask one question of one definition. Two
copies of a prefix rule is precisely the drift `onlooker-eqb` was about.

### 2. Titles

A single `useDocumentTitle()` effect, mounted once in `App.tsx` rather than
called per page, resolving in order:

1. a `SECTIONS` match → its `label`
2. a `TITLES` entry → its title (the five auth routes, which have no `SECTIONS`
   label today)
3. otherwise → `Onlooker`

The 404 sets its own title rather than being listed in `TITLES`. `*` is not a
path, so the resolver has nothing to match it on, and making "Page not found"
the resolver's fallback would title any future route that nobody listed as a
page that does not exist — claiming something false rather than something
unhelpful. The bare product name is the right fallback precisely because it is
never wrong.

Format is `Lessons · Onlooker`: most specific first, because a tab strip truncates
from the right and the section is the part worth keeping.

A new section route gets a title by existing. A new non-section route falls back
to the bare product name — wrong in the sense of unhelpful, never wrong in the
sense of claiming to be a different page.

### 3. `<Protected>`

Each of the five authenticated routes repeats `RequireAuth` wrapping `AppShell`
wrapping the page, and not one passes `loadingFallback`. Compose it once:

```tsx
<Route path="/machines" element={<Protected><MachinesPage /></Protected>} />
```

`Protected` supplies `loadingFallback={<AppShell><Loading …/></AppShell>}`, so a
refresh paints the nav and the section heading immediately and fills the body in
after. `AppShell` already tolerates a null user — `{user ? … : null}` at
`AppShell.tsx:162` — so it renders correctly mid-restore without change.

This collapses the route table, and a sixth authenticated route gets the
fallback by using the wrapper rather than by remembering a prop.

### 4. `<Loading>`

A primitive in `ui.tsx`, taking a label, styled once with `PALETTE.muted`,
settling on `…`. It replaces the four divergent call sites, and the four button
`loadingLabel` strings get the same ellipsis in the same pass — same
inconsistency, different surface.

### 5. The 404

Three states, because the page has three audiences:

- **signed in** — inside `AppShell`, so the nav survives a mistyped URL
- **signed out** — bare and centered, with a route to `/login`
- **loading** — `AppShell` wrapping `<Loading>`, the same frame `Protected`
  supplies, so an unresolved session does not flash "not found" at somebody who
  is signed in and heading somewhere real. The 404 renders this itself; it is
  not behind `Protected`.

It renders an `h1`. `AppShell` deliberately renders no heading for a route absent
from `SECTIONS`, and a page whose only heading is an `h2` is its own defect, so
`EmptyState` gains `headingLevel?: 1 | 2` defaulting to 2. The alternative — an
`AppShell` title override — was rejected as the larger change to the more
load-bearing component.

The 404 is deliberately **not** behind `RequireAuth`. A signed-out person who
mistypes a URL should be told the page does not exist, not asked to log in for
it.

### 6. `/`

A redirect with no page. Signed in → `/lessons`; signed out → `/login`.
`HomePage.tsx` is deleted.

It waits on `auth.loading` before deciding. Redirecting on an unresolved session
would bounce a signed-in user who refreshes `/` to `/login` and then back, which
reads as being logged out and is the bug this route is most likely to grow.

`AppShell`'s sign-out already navigates to `/`, which now resolves to `/login`
through this one decision rather than through a second copy of it.

## Testing *(approved)*

- `/` redirects both ways, and does not bounce while the session is loading
- the 404 renders in all three auth states, and carries an `h1`
- `document.title` for each section route, each auth route, and the 404
- `RequireAuth`'s loading state renders chrome rather than a blank — asserted on
  the nav being present, since that is the symptom
- a guard test failing on a bare `Loading` string outside `ui.tsx`, in the shape
  of the existing `source-guards` tests, so the consistency cannot quietly rot

## Out of scope

- Any dashboard at `/`. `onlooker-yfw` deleted the placeholder one on purpose,
  along with its API endpoint; rebuilding it needs a new endpoint before it could
  show anything true.
- The inline-style idiom. `palette.ts` documents it as deliberate — brand
  tokens are CSS custom properties and React passes `var()` through untouched.
  It is the house style, not debt.
- `apps/website`, which is a separate Astro app with its own edges.
