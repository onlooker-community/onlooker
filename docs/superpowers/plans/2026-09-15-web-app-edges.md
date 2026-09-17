# The Web App's Edges — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `apps/web` the edges its interior already has — a real entry, a real 404, per-route browser titles, and one loading state instead of four.

**Architecture:** Chrome is derived from the route table rather than wired into each page, the way `AppShell` already derives every `h1` from `SECTIONS`. `SECTIONS` and its path matcher move to their own module so pure logic can be tested without mounting React; titles resolve through that same matcher; a `Protected` wrapper composes `RequireAuth` + `AppShell` + a loading fallback once instead of five times.

**Tech Stack:** React 18, react-router-dom v6, TypeScript, Vitest + @testing-library/react (jsdom), Biome. Tests run with `pnpm --filter @onlooker/web test`.

Spec: `docs/superpowers/specs/2026-09-15-web-app-edges-design.md`. Bead: `onlooker-lo1x`.

## Global Constraints

- **Never import from `apps/web/src/monitoring.provider.ts` in main-bundle code.** It is the lazily-imported provider chunk; an import pulls 50.95 kB back into the main bundle, which grows silently and fails nothing. `PARAMETERIZED_ROUTES`/`routeName()` live there and must not be reused.
- **Inline styles with `var()` are the house idiom**, not debt — brand tokens are CSS custom properties and React passes `var()` through untouched. Do not introduce stylesheets or a CSS-in-JS library.
- **Colors come from `PALETTE` in `apps/web/src/components/palette.ts`.** Never a raw hex. A plate is a filled background; an accent is ink on a ground. Using one as the other caused a 1.35-contrast bug.
- **Ellipsis is `…` (U+2026)**, one character, in every string this plan touches.
- **Edit tracked files with Edit/Write, never `sed -i` or heredocs** — the `lineage` plugin hooks `PostToolUse` on the file tools, and a shell edit is invisible to it.
- **American English** in comments, identifiers, and copy.
- Commit messages follow `<type>(<scope>): <subject> :emoji:` — run them through the `/commit` skill.

---

### Task 1: Move `SECTIONS` and its matcher to their own module

`AppShell` resolves which section a path belongs to with an inline `SECTIONS.find(...)`. Task 3 needs the same answer. Two copies of a prefix rule is the drift `onlooker-eqb` was filed about, so it becomes one exported function — in its own module, so a pure-logic test does not have to mount React or pull `../auth` (which reaches for the API client at module scope).

**Files:**
- Create: `apps/web/src/components/sections.ts`
- Modify: `apps/web/src/components/AppShell.tsx` (remove the `SECTIONS` literal at lines 22–38 and the `section` lookup at lines 63–68)
- Test: `apps/web/src/__tests__/sections.test.ts`

**Interfaces:**
- Produces: `SECTIONS` (unchanged shape: readonly array of `{ to: string; label: string; icon: IconName }`), and `sectionFor(pathname: string): (typeof SECTIONS)[number] | undefined`.
- `AppShell` re-exports `SECTIONS` so `apps/web/src/__tests__/shell-headings.test.tsx:62` — which does `const { SECTIONS } = await import("../components/AppShell")` — keeps working untouched.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/sections.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sectionFor } from "../components/sections";

// Pure path logic, no render: this is the rule AppShell uses to pick the h1
// and titles.ts uses to pick the document title, so it is worth pinning on
// its own rather than only through whatever a page happens to render.
describe("sectionFor", () => {
	it("matches a section exactly", () => {
		expect(sectionFor("/lessons")?.label).toBe("Lessons");
	});

	// The reason /lessons/:id shows "Lessons" rather than no heading at all.
	it("matches a child of a section", () => {
		expect(sectionFor("/lessons/01J8Z4K2M3N4P5Q6R7S8T9V0W1")?.label).toBe(
			"Lessons",
		);
	});

	// The slash in the prefix is load-bearing and this is what proves it.
	// Without it a future /lessons-archive would render under the Lessons
	// heading and mark the Lessons nav link as the current page.
	it("does not match a sibling that merely shares a prefix", () => {
		expect(sectionFor("/lessons-archive")).toBeUndefined();
	});

	it("returns undefined for a path in no section", () => {
		expect(sectionFor("/login")).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @onlooker/web test -- sections.test.ts`
Expected: FAIL — `Failed to resolve import "../components/sections"`.

- [ ] **Step 3: Create the module**

Create `apps/web/src/components/sections.ts`. Move the `SECTIONS` literal out of `AppShell.tsx` **with its comments intact** — they record brand-doc decisions (why Basket rather than ChestTreasure, why CatHead) that are not re-derivable:

```ts
import type { IconName } from "./Icon";

// Exported so the heading test can be driven off this list rather than a
// hand-written copy of it: a route added here is covered without anyone
// remembering to extend the test.
export const SECTIONS = [
	// Basket, not ChestTreasure: the brand doc's mapping named ChestTreasure
	// for the approved pool, but it measures 9% legible against the night
	// panel this renders on. See onlooker-1kr, and the amendment on the
	// 2026-08-11 brand spec.
	{ to: "/lessons", label: "Lessons", icon: "Basket" },
	{ to: "/machines", label: "Machines", icon: "Key" },
	// Book: the log-shaped icon in the brand set, and the one not already
	// spoken for by lessons, machines, settings or profile.
	{ to: "/activity", label: "Activity", icon: "Book" },
	{ to: "/settings", label: "Settings", icon: "Gear" },
	// CatHead is an extension of the brand doc's mapping, not one of its
	// entries - the set has no person icon, and it is the most person-like
	// thing in it. See the doc's Icons section.
	{ to: "/profile", label: "Profile", icon: "CatHead" },
] as const satisfies readonly { to: string; label: string; icon: IconName }[];

/**
 * Which section a path belongs to, or undefined for a path outside the shell.
 *
 * Exact match or a `to`-plus-slash prefix, so /lessons/:id resolves to Lessons.
 * Prefix alone would be wrong in principle - /lessons would also match a future
 * /lessons-archive - and the slash costs nothing.
 *
 * Lives here rather than inside AppShell because titles.ts asks the same
 * question. Two copies of this rule is exactly the drift that onlooker-eqb was
 * filed about, one level down.
 */
export function sectionFor(
	pathname: string,
): (typeof SECTIONS)[number] | undefined {
	return SECTIONS.find(
		(candidate) =>
			pathname === candidate.to || pathname.startsWith(`${candidate.to}/`),
	);
}
```

`import type` for `IconName` is deliberate: a value import would pull `Icon.tsx` and React into a module that is otherwise pure.

- [ ] **Step 4: Rewire `AppShell.tsx`**

Delete the `SECTIONS` literal (old lines 22–38). Add to the imports:

```tsx
import { SECTIONS, sectionFor } from "./sections";
```

Re-export it directly below the imports, with the reason:

```tsx
// Re-exported because shell-headings.test.tsx drives its cases off
// `SECTIONS` imported from here. The list itself lives in ./sections so the
// path matcher beside it can be tested without mounting React.
export { SECTIONS };
```

Replace the inline lookup (old lines 63–68) with:

```tsx
	const section = sectionFor(location.pathname);
```

Keep the long comment above it that explains why the heading comes from `SECTIONS` — it is about the heading, not about the lookup, and is still true.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @onlooker/web test`
Expected: PASS — the new `sections.test.ts` cases, and `shell-headings.test.tsx` still passing through the re-export.

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm --filter @onlooker/web typecheck && pnpm --filter @onlooker/web lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/sections.ts apps/web/src/components/AppShell.tsx apps/web/src/__tests__/sections.test.ts
```

Then run `/commit`. The why: one definition of "which section is this path", because titles are about to ask the same question.

---

### Task 2: One `<Loading>` primitive

Four pages render a page-level loading state four different ways, in three stylings and two ellipsis conventions. Three of the four are also silent to a screen reader — only `LessonDetail` sets `role="status"`.

**Files:**
- Modify: `apps/web/src/components/ui.tsx` (add the export)
- Modify: `apps/web/src/pages/ActivityPage.tsx:109`
- Modify: `apps/web/src/pages/ProfilePage.tsx:32`
- Modify: `apps/web/src/pages/MachinesPage.tsx:271`
- Modify: `apps/web/src/pages/LessonDetail.tsx:250-252`
- Modify: `scripts/source-guards.test.sh` (add the guard)
- Test: `apps/web/src/__tests__/ui.test.tsx` (extend)

**Interfaces:**
- Consumes: `PALETTE` from `./palette` (already imported by `ui.tsx`).
- Produces: `Loading({ label }: { label: string })`. Tasks 4, 5 and 6 render it.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/__tests__/ui.test.tsx`, inside the existing top-level `describe` or as a new one:

```tsx
describe("Loading", () => {
	it("announces itself to a screen reader", () => {
		render(<Loading label="Loading machines…" />);

		// role="status" is the whole point of having one of these rather than
		// four hand-rolled paragraphs: three of the four call sites this
		// replaces rendered a bare <p>, so a screen reader was told nothing
		// was happening at all.
		expect(screen.getByRole("status").textContent).toBe("Loading machines…");
	});
});
```

Add `Loading` to the existing `import { ... } from "../components/ui";` line at the top of that file.

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @onlooker/web test -- ui.test.tsx`
Expected: FAIL — `Loading is not exported` / `Loading is not defined`.

- [ ] **Step 3: Add the primitive**

In `apps/web/src/components/ui.tsx`, beside `EmptyState`:

```tsx
/**
 * The page-level "still fetching" line.
 *
 * One component because there were four: a bare <p> on Activity and Profile, a
 * muted one on Machines, an inline one on LessonDetail, and two spellings of
 * the ellipsis between them. Three of the four were also silent - `role`
 * defaults to nothing on a <p>, so a screen reader was told a loading page was
 * an empty one.
 *
 * Distinct from EmptyState: empty is a finished answer, loading is not an
 * answer yet, and giving them one component would make "no machines" and "not
 * yet known" look alike.
 */
export function Loading({ label }: { label: string }) {
	return (
		<p role="status" style={{ color: PALETTE.muted }}>
			{label}
		</p>
	);
}
```

- [ ] **Step 4: Replace the four call sites**

`ActivityPage.tsx:109` — add `Loading` to its existing `ui` import, then:

```tsx
	if (events === null) return <Loading label="Loading your activity…" />;
```

`ProfilePage.tsx:32`:

```tsx
			{loading && <Loading label="Loading your profile…" />}
```

`MachinesPage.tsx:271`:

```tsx
				) : machines === null ? (
					<Loading label="Loading machines…" />
```

`LessonDetail.tsx:250-252` — replace the whole `<p role="status" …>` element:

```tsx
				<Loading label="Loading that lesson…" />
```

Each file needs `Loading` added to its import from `../components/ui`. `MachinesPage` and `LessonDetail` may end up with an unused `PALETTE` import — remove it only if Biome flags it; both use `PALETTE` elsewhere.

- [ ] **Step 5: Add the source guard**

In `scripts/source-guards.test.sh`, following the style of the existing blocks, add a case asserting no page rolls its own loading paragraph:

Use the file's existing `pass "<description>"` / `fail "<description>" "<detail>"`
helpers (defined at lines 15–24) and its `${ROOT}` prefix — do not add new
helpers:

```bash
echo "source-guards: one loading state, not four"

# Matches a JSX text node beginning with "Loading" - either `<p>Loading …` on
# one line, or a line whose first non-space token is `Loading <word>`, which is
# the wrapped form LessonDetail used.
#
# Heuristic by construction: it cannot see a label built at runtime, and it is
# not trying to. It catches the shape that actually recurred four times, so the
# fifth page cannot quietly add a fifth spelling.
offenders="$(grep -rnE '(>[[:space:]]*Loading|^[[:space:]]+Loading [a-z])' \
	"${ROOT}/apps/web/src" --include='*.tsx' 2>/dev/null |
	grep -v 'components/ui.tsx' || true)"

if [[ -n "${offenders}" ]]; then
	fail "no page renders its own loading paragraph" "found in:${offenders}"
else
	pass "no page renders its own loading paragraph"
fi

# The second check, following the pattern the lesson-query guard above
# establishes: without it this passes trivially the day the primitive is
# deleted and every call site with it.
if grep -q 'export function Loading' "${ROOT}/apps/web/src/components/ui.tsx"; then
	pass "ui.tsx is where the loading state lives"
else
	fail "ui.tsx is where the loading state lives" "no Loading export found there"
fi
```

- [ ] **Step 6: Run everything**

Run: `pnpm --filter @onlooker/web test && bash scripts/source-guards.test.sh`
Expected: all web tests pass; source-guards reports one more passing test than before.

- [ ] **Step 7: Verify the guard can actually fail**

Temporarily re-add `<p>Loading something…</p>` to `ActivityPage.tsx`, run `bash scripts/source-guards.test.sh`, confirm it FAILS and names the file, then revert. A guard nobody has watched fail is a guard that might match nothing.

- [ ] **Step 8: Typecheck, lint, commit**

Run: `pnpm --filter @onlooker/web typecheck && pnpm --filter @onlooker/web lint`

```bash
git add apps/web/src/components/ui.tsx apps/web/src/pages/ActivityPage.tsx apps/web/src/pages/ProfilePage.tsx apps/web/src/pages/MachinesPage.tsx apps/web/src/pages/LessonDetail.tsx apps/web/src/__tests__/ui.test.tsx scripts/source-guards.test.sh
```

Then run `/commit`. The why: four spellings of one state, three of them silent to a screen reader.

---

### Task 3: Per-route browser titles

`index.html:6` sets `<title>Onlooker</title>` and nothing ever changes it, so every tab, history entry, bookmark and screen-reader page announcement says the same thing.

**Files:**
- Create: `apps/web/src/titles.ts`
- Modify: `apps/web/src/App.tsx` (call the hook in `App()`)
- Modify: `scripts/source-guards.test.sh` (add the coverage guard)
- Test: `apps/web/src/__tests__/titles.test.ts`

**Interfaces:**
- Consumes: `sectionFor` from `./components/sections` (Task 1).
- Produces: `titleFor(pathname: string): string` and `useDocumentTitle(): void`.

**Design note — this supersedes one line of the spec.** The spec has the 404 setting its own title. It cannot: React runs child effects before parent effects, so a `NotFoundPage` effect would be overwritten by `App`'s hook on the same navigation. The fallback therefore *becomes* the not-found title, and the risk the spec worried about — a future route nobody listed getting titled "Page not found" — is closed by the source guard in Step 5 instead, which fails the build rather than mislabeling the page.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/titles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { titleFor } from "../titles";

describe("titleFor", () => {
	// Section first, product second: a tab strip truncates from the right, so
	// the half worth keeping goes on the left.
	it("names the section before the product", () => {
		expect(titleFor("/machines")).toBe("Machines · Onlooker");
	});

	it("titles a lesson under its section", () => {
		expect(titleFor("/lessons/01J8Z4K2M3N4P5Q6R7S8T9V0W1")).toBe(
			"Lessons · Onlooker",
		);
	});

	it("titles a route that has no section", () => {
		expect(titleFor("/login")).toBe("Sign in · Onlooker");
	});

	// The token-carrying routes are the reason this matches by prefix rather
	// than by equality.
	it("titles a parameterized route outside the shell", () => {
		expect(titleFor(`/reset-password/${"a".repeat(64)}`)).toBe(
			"Choose a new password · Onlooker",
		);
	});

	// Anything not listed renders the catch-all route, so the fallback is the
	// not-found title. scripts/source-guards.test.sh is what keeps that from
	// mislabeling a real route somebody forgot to list.
	it("falls back to the not-found title", () => {
		expect(titleFor("/nothing-here")).toBe("Page not found · Onlooker");
	});
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @onlooker/web test -- titles.test.ts`
Expected: FAIL — `Failed to resolve import "../titles"`.

- [ ] **Step 3: Write the module**

Create `apps/web/src/titles.ts`:

```ts
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { sectionFor } from "./components/sections";

const PRODUCT = "Onlooker";

/**
 * Routes outside the shell that still deserve a name.
 *
 * SECTIONS already names the five shell routes; this is everything else a
 * person can land on. Matched by prefix, because /reset-password and
 * /verify-email carry a token.
 *
 * NOT the place for a parameterized-route list in general: PARAMETERIZED_ROUTES
 * in monitoring.provider.ts does that job for transaction naming and cannot be
 * imported here - it lives in the lazily loaded provider chunk, and an import
 * would pull 50.95 kB back into the main bundle without failing anything.
 */
const TITLES: readonly (readonly [string, string])[] = [
	["/login", "Sign in"],
	["/signup", "Create account"],
	["/forgot-password", "Reset your password"],
	["/reset-password", "Choose a new password"],
	["/verify-email", "Verify your email"],
] as const;

const NOT_FOUND = "Page not found";

/**
 * The document title for a path.
 *
 * Section first, product second: a tab strip truncates from the right, so the
 * specific half is the half that survives.
 *
 * The fallback is the not-found title rather than the bare product name,
 * because a path matching neither list renders the catch-all route and IS the
 * not-found page. The 404 cannot set this itself - React runs child effects
 * before parent ones, so the hook below would overwrite whatever it set. What
 * keeps this from mislabeling a real route nobody listed is the source guard,
 * not this function.
 */
export function titleFor(pathname: string): string {
	const section = sectionFor(pathname);
	if (section) return `${section.label} · ${PRODUCT}`;

	for (const [prefix, title] of TITLES) {
		if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
			return `${title} · ${PRODUCT}`;
		}
	}

	return `${NOT_FOUND} · ${PRODUCT}`;
}

/**
 * Keep document.title in step with the route.
 *
 * Mounted once in App rather than called by each page, for the same reason
 * AppShell renders every h1 from SECTIONS: a per-route, boring property that
 * each page has to remember is a property some page will forget. See
 * onlooker-eqb.
 */
export function useDocumentTitle(): void {
	const { pathname } = useLocation();

	useEffect(() => {
		document.title = titleFor(pathname);
	}, [pathname]);
}
```

- [ ] **Step 4: Mount it in `App.tsx`**

Add the import and call it as the first statement of `App()`, beside the existing `useLocation()`:

```tsx
import { useDocumentTitle } from "./titles";
```

```tsx
export default function App() {
	const location = useLocation();

	// Once, here, rather than in each page - see titles.ts.
	useDocumentTitle();
```

- [ ] **Step 5: Add the coverage guard**

In `scripts/source-guards.test.sh`, add a block asserting every route `App.tsx` declares is named somewhere, so the fallback can stay "Page not found" safely:

```bash
echo "source-guards: every route App declares has a title"

# Extracts the leading segment of every path= in App.tsx, skips the catch-all
# and the root redirect - neither renders a page of its own - and asserts each
# is named in sections.ts or titles.ts.
#
# This is what makes the not-found FALLBACK safe. Without it, adding a route
# and forgetting to name it would title a real page "Page not found", which
# claims something false rather than merely unhelpful.
missing=""
while read -r route; do
	case "${route}" in
		'*' | '/' | '' | :*) continue ;;
	esac
	segment="${route%%/*}"
	if ! grep -q "\"/${segment}\"" "${ROOT}/apps/web/src/components/sections.ts" &&
		! grep -q "\"/${segment}\"" "${ROOT}/apps/web/src/titles.ts"; then
		missing="${missing} /${segment}"
	fi
done < <(grep -oE 'path="[^"]*"' "${ROOT}/apps/web/src/App.tsx" |
	sed -E 's/path="\/?([^"]*)"/\1/')

if [[ -n "${missing}" ]]; then
	fail "no route in App.tsx is missing a title" "unnamed:${missing}"
else
	pass "no route in App.tsx is missing a title"
fi
```

The `:*` case skips the `:id` child route, whose path is a parameter rather
than a segment anyone navigates to by name.

- [ ] **Step 6: Run everything**

Run: `pnpm --filter @onlooker/web test && bash scripts/source-guards.test.sh`
Expected: PASS.

- [ ] **Step 7: Verify the guard can fail**

Temporarily add `<Route path="/reports" element={<div />} />` to `App.tsx`, run the guard, confirm it FAILS naming `/reports`, then revert.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
git add apps/web/src/titles.ts apps/web/src/App.tsx apps/web/src/__tests__/titles.test.ts scripts/source-guards.test.sh
```

Then run `/commit`. The why: every tab said "Onlooker".

---

### Task 4: `<Protected>` and the blank refresh

`RequireAuth` takes a `loadingFallback` and defaults it to `null` (`packages/auth-react/src/index.tsx:563`); `apps/web` has never passed one. A hard refresh of any of the five authenticated routes paints a blank page until the session resolves.

**Files:**
- Modify: `apps/web/src/App.tsx` (add `Protected`, rewrite the five route elements at lines 65–123)
- Test: `apps/web/src/__tests__/protected-loading.test.tsx`

**Interfaces:**
- Consumes: `Loading` from `./components/ui` (Task 2); `AppShell`; `auth` from `./auth`.
- Produces: `Protected({ children }: { children: ReactNode })`, used by every authenticated route.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/protected-loading.test.tsx`. The `auth` mock here deliberately reproduces `RequireAuth`'s real contract instead of passing children straight through, because the thing under test is whether `apps/web` supplies a fallback at all:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// Unlike the other route tests, RequireAuth is NOT a passthrough here. It
// honors loadingFallback exactly as packages/auth-react does, because the bug
// this covers is that apps/web never passed one - a passthrough mock would
// render the page and the test would pass against the broken code.
vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({
			user: null,
			loading: true,
			logout: vi.fn(),
			refresh: vi.fn(),
			sessionExpiresAt: null,
			sessionExpiringSoon: false,
		}),
		RequireAuth: ({
			loadingFallback,
		}: {
			children: React.ReactNode;
			loadingFallback?: React.ReactNode;
		}) => loadingFallback ?? null,
	},
}));

const { default: App } = await import("../App");

describe("an authenticated route while the session is still loading", () => {
	// The symptom was a blank white page on every hard refresh of five routes.
	// Asserting on the nav rather than on the loading text is deliberate: the
	// nav is the part whose absence people actually experienced.
	it("renders the app frame rather than nothing", () => {
		render(
			<MemoryRouter initialEntries={["/machines"]}>
				<App />
			</MemoryRouter>,
		);

		expect(screen.getByRole("navigation", { name: /sections/i })).toBeDefined();
		expect(screen.getByRole("status").textContent).toMatch(/loading/i);
	});
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @onlooker/web test -- protected-loading.test.tsx`
Expected: FAIL — `Unable to find an accessible element with the role "navigation"`. That failure *is* the bug: with no fallback passed, `RequireAuth` renders nothing.

- [ ] **Step 3: Add `Protected` to `App.tsx`**

Above `export default function App()`:

```tsx
/**
 * Every authenticated route: the guard, the chrome, and what to show while the
 * session is still resolving.
 *
 * The third of those is why this exists. RequireAuth's loadingFallback
 * defaults to null and nothing here ever passed one, so a hard refresh of any
 * shell route painted a blank page - no nav, no heading - until the session
 * came back. Composing it once means a sixth route gets the fallback by using
 * this wrapper rather than by someone remembering a prop.
 *
 * AppShell renders correctly with a null user; it already guards that case for
 * the header (`{user ? … : null}`), so the frame can be drawn before anyone is
 * known to be signed in.
 *
 * A signed-out person hitting a shell URL sees this frame briefly before
 * RequireAuth redirects them to /login. That is the accepted cost: the
 * alternative was a blank screen for everyone, including the signed-in case,
 * which is the common one.
 */
function Protected({ children }: { children: ReactNode }) {
	return (
		<auth.RequireAuth
			loadingFallback={
				<AppShell>
					<Loading label="Loading your session…" />
				</AppShell>
			}
		>
			<AppShell>{children}</AppShell>
		</auth.RequireAuth>
	);
}
```

Add the imports:

```tsx
import type { ReactNode } from "react";
import { Loading } from "./components/ui";
```

- [ ] **Step 4: Rewrite the five route elements**

Replace each `<auth.RequireAuth><AppShell>…</AppShell></auth.RequireAuth>` with `<Protected>…</Protected>`:

```tsx
						<Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
						<Route path="/profile" element={<Protected><ProfilePage /></Protected>} />
						{/*
						  A layout route. LessonsPage fetches one page and renders the
						  list; the :id child renders its detail out of that same
						  in-memory list through the Outlet context, so clicking a row
						  issues no request. Deep links fall back to GET
						  /api/lessons/:id, which is the one case memory cannot answer.
						*/}
						<Route path="/lessons" element={<Protected><LessonsPage /></Protected>}>
							<Route path=":id" element={<LessonDetail />} />
						</Route>
						<Route path="/machines" element={<Protected><MachinesPage /></Protected>} />
						<Route path="/activity" element={<Protected><ActivityPage /></Protected>} />
```

Keep the `/lessons` layout-route comment exactly as it is — it explains the Outlet contract, which is unchanged. Let Biome reformat the line wrapping.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @onlooker/web test`
Expected: PASS, including the existing `machines-route.test.tsx`, `account-routes-in-shell.test.tsx` and `shell-headings.test.tsx`, whose passthrough `RequireAuth` mocks are unaffected.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
git add apps/web/src/App.tsx apps/web/src/__tests__/protected-loading.test.tsx
```

Then run `/commit`. The why: a hard refresh showed nothing at all, on five routes, because a default of `null` was never overridden.

---

### Task 5: A real 404

`<Route path="*" element={<div>404 Not Found</div>} />` — outside the shell, unstyled, no heading.

**Files:**
- Create: `apps/web/src/pages/NotFoundPage.tsx`
- Modify: `apps/web/src/components/ui.tsx` (`EmptyState` gains `headingLevel`)
- Modify: `apps/web/src/App.tsx:124` (the catch-all route)
- Test: `apps/web/src/__tests__/not-found.test.tsx`

**Interfaces:**
- Consumes: `EmptyState`, `Loading` from `./components/ui`; `AppShell`; `auth`.
- Produces: `NotFoundPage` (default export). `EmptyState` gains `headingLevel?: 1 | 2`, default `2` — every existing call site keeps its current output.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/not-found.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = {
	user: null as { id: string; email: string } | null,
	loading: false,
};

vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({
			...authState,
			logout: vi.fn(),
			refresh: vi.fn(),
			sessionExpiresAt: null,
			sessionExpiringSoon: false,
		}),
		RequireAuth: ({ children }: { children: React.ReactNode }) => children,
	},
}));

const { default: App } = await import("../App");

function renderAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<App />
		</MemoryRouter>,
	);
}

describe("a path that matches nothing", () => {
	beforeEach(() => {
		authState.user = null;
		authState.loading = false;
	});

	// An h1, not an h2. AppShell deliberately renders no heading for a route
	// absent from SECTIONS, so if this page does not carry its own the page has
	// no h1 at all.
	it("leads with a first-level heading", () => {
		renderAt("/nothing-here");

		expect(
			screen.getByRole("heading", { level: 1, name: /page not found/i }),
		).toBeDefined();
	});

	// Not behind RequireAuth on purpose: someone who mistypes a URL should be
	// told the page does not exist, not asked to log in for it.
	it("does not send a signed-out visitor to log in", () => {
		renderAt("/nothing-here");

		expect(screen.queryByLabelText(/password/i)).toBeNull();
		expect(screen.queryByRole("navigation", { name: /sections/i })).toBeNull();
	});

	it("keeps the nav for someone who is signed in", () => {
		authState.user = { id: "u1", email: "someone@example.com" };

		renderAt("/nothing-here");

		expect(screen.getByRole("navigation", { name: /sections/i })).toBeDefined();
	});

	// A signed-in person heading somewhere real must not be told it does not
	// exist while their session is still resolving.
	it("says nothing about missing pages while the session loads", () => {
		authState.loading = true;

		renderAt("/nothing-here");

		expect(screen.queryByText(/page not found/i)).toBeNull();
		expect(screen.getByRole("status").textContent).toMatch(/loading/i);
	});
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @onlooker/web test -- not-found.test.tsx`
Expected: FAIL — no heading found; the current route renders a bare `<div>`.

- [ ] **Step 3: Give `EmptyState` a heading level**

In `apps/web/src/components/ui.tsx`, add to the props and destructuring:

```tsx
	/**
	 * Render the title as an h1 instead of an h2.
	 *
	 * Defaults to 2 because an EmptyState normally sits inside a page whose h1
	 * AppShell already rendered from SECTIONS. The 404 is the exception: it has
	 * no SECTIONS entry, so AppShell renders no heading and this is the page's
	 * only one.
	 */
	headingLevel = 2,
```

```tsx
	headingLevel?: 1 | 2;
```

Then, inside the component body before the `return`:

```tsx
	const Heading = headingLevel === 1 ? "h1" : "h2";
```

and replace the `<h2 …>{title}</h2>` element with `<Heading …>{title}</Heading>`, keeping every style property exactly as it is — the size is deliberate and should not change with the level.

- [ ] **Step 4: Write the page**

Create `apps/web/src/pages/NotFoundPage.tsx`:

```tsx
import { Link } from "react-router-dom";
import { auth } from "../auth";
import AppShell from "../components/AppShell";
import { PALETTE } from "../components/palette";
import { EmptyState, Loading } from "../components/ui";

/**
 * The catch-all, in three states because it has three audiences.
 *
 * Deliberately NOT behind RequireAuth. Someone who mistypes a URL should be
 * told the page does not exist; asking them to log in first answers a question
 * they did not ask and hides the one they did.
 *
 * The loading state is bare rather than wrapped in AppShell - the opposite of
 * Protected. Protected is entered by someone already heading into the app, so
 * drawing the frame early is the fix. Here the visitor may not be signed in at
 * all, and showing them the whole app chrome for a moment would be its own
 * flash. What both share is that neither says "not found" before it knows.
 */
export default function NotFoundPage() {
	const { user, loading } = auth.useAuth();

	if (loading) return <Loading label="Loading your session…" />;

	const body = (
		<EmptyState headingLevel={1} title="Page not found" icon="Eye">
			That address does not match anything here.{" "}
			<Link to={user ? "/lessons" : "/login"} style={{ color: PALETTE.accent }}>
				{user ? "Back to the pool" : "Sign in"}
			</Link>
		</EmptyState>
	);

	return user ? <AppShell>{body}</AppShell> : body;
}
```

`EmptyState`'s `action` prop is not used here because it takes an `onClick` and this is a navigation, which belongs in a link a person can middle-click.

- [ ] **Step 5: Route it**

In `App.tsx`, add the import and replace line 124:

```tsx
import NotFoundPage from "./pages/NotFoundPage";
```

```tsx
						<Route path="*" element={<NotFoundPage />} />
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @onlooker/web test`
Expected: PASS, including the existing `ui.test.tsx` — `headingLevel` defaults to 2, so no existing `EmptyState` changes.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
git add apps/web/src/pages/NotFoundPage.tsx apps/web/src/components/ui.tsx apps/web/src/App.tsx apps/web/src/__tests__/not-found.test.tsx
```

Then run `/commit`. The why: a mistyped URL answered with an unstyled div and no heading.

---

### Task 6: `/` becomes a redirect

`HomePage` is a 21-line stub reading "Welcome to the Onlooker platform", outside `AppShell` and outside `RequireAuth`. It predates `onlooker-yfw`, which deleted the placeholder dashboard and made `/lessons` the landing route; this never followed.

**Files:**
- Delete: `apps/web/src/pages/HomePage.tsx`
- Modify: `apps/web/src/App.tsx` (the `/` route and the `HomePage` import)
- Test: `apps/web/src/__tests__/root-redirect.test.tsx`

**Interfaces:**
- Consumes: `Loading`, `auth`, `Navigate` from `react-router-dom`.
- Produces: `RootRedirect` (module-private to `App.tsx`).

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/root-redirect.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = {
	user: null as { id: string; email: string } | null,
	loading: false,
};

vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({
			...authState,
			logout: vi.fn(),
			refresh: vi.fn(),
			sessionExpiresAt: null,
			sessionExpiringSoon: false,
		}),
		RequireAuth: ({ children }: { children: React.ReactNode }) => children,
	},
}));

// Export names taken from apps/web/src/api/lessonsApi.ts: the signed-in case
// lands on /lessons, which fetches on mount, and a mock missing an export the
// page imports fails at module load rather than in the assertion.
vi.mock("../api/lessonsApi", () => ({
	LESSON_ENDPOINTS: { lessons: "/api/lessons" },
	listLessons: () => Promise.resolve({ lessons: [], nextCursor: null }),
	getLesson: vi.fn(),
	setLessonStatus: vi.fn(),
	listActivity: () => Promise.resolve({ events: [], nextCursor: null }),
}));

const { default: App } = await import("../App");

describe("/", () => {
	beforeEach(() => {
		authState.user = null;
		authState.loading = false;
	});

	it("sends a signed-out visitor to log in", async () => {
		render(
			<MemoryRouter initialEntries={["/"]}>
				<App />
			</MemoryRouter>,
		);

		expect(await screen.findByLabelText(/password/i)).toBeDefined();
	});

	it("sends a signed-in person to the pool", async () => {
		authState.user = { id: "u1", email: "someone@example.com" };

		render(
			<MemoryRouter initialEntries={["/"]}>
				<App />
			</MemoryRouter>,
		);

		expect(
			await screen.findByRole("navigation", { name: /sections/i }),
		).toBeDefined();
	});

	// The bug this route is most likely to grow. Deciding on an unresolved
	// session would bounce a signed-in person refreshing / to the login form
	// and then back, which reads as having been logged out.
	it("decides nothing while the session is still loading", () => {
		authState.loading = true;

		render(
			<MemoryRouter initialEntries={["/"]}>
				<App />
			</MemoryRouter>,
		);

		expect(screen.queryByLabelText(/password/i)).toBeNull();
		expect(screen.getByRole("status").textContent).toMatch(/loading/i);
	});
});
```

`LESSON_ENDPOINTS`'s real shape is in `apps/web/src/api/lessonsApi.ts:14`; the stub above only has to satisfy the import, not match it field for field.

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @onlooker/web test -- root-redirect.test.tsx`
Expected: FAIL — `/` renders `HomePage`, so neither the login form nor the nav appears.

- [ ] **Step 3: Add `RootRedirect`**

In `App.tsx`, beside `Protected`:

```tsx
/**
 * `/` is a decision, not a page.
 *
 * onlooker-yfw deleted the placeholder dashboard - handler, contract cases,
 * mock branch and page - and landed RequireAuth on /lessons. The landing route
 * moved then; HomePage stayed behind saying "Welcome to the Onlooker platform"
 * over a link to the pool.
 *
 * It waits for the session rather than guessing. Redirecting on an unresolved
 * one would send a signed-in person refreshing / to /login and then back,
 * which reads as having been logged out.
 *
 * AppShell's Sign out navigates here, so signing out resolves through this one
 * decision rather than through a second copy of it.
 */
function RootRedirect() {
	const { user, loading } = auth.useAuth();

	if (loading) return <Loading label="Loading your session…" />;

	return <Navigate to={user ? "/lessons" : "/login"} replace />;
}
```

Add `Navigate` to the `react-router-dom` import.

- [ ] **Step 4: Route it and delete the page**

```tsx
						<Route path="/" element={<RootRedirect />} />
```

Remove `import HomePage from "./pages/HomePage";` and delete the file:

```bash
git rm apps/web/src/pages/HomePage.tsx
```

- [ ] **Step 5: Run everything**

Run: `pnpm --filter @onlooker/web test && bash scripts/source-guards.test.sh`
Expected: PASS. The title guard from Task 3 skips `/`, which renders no page of its own.

- [ ] **Step 6: Check nothing else linked to HomePage**

Run: `grep -rn "HomePage" apps/web/src`
Expected: no matches.

- [ ] **Step 7: Typecheck, lint, build, commit**

Run: `pnpm --filter @onlooker/web typecheck && pnpm --filter @onlooker/web lint && pnpm --filter @onlooker/web build`

The build matters here specifically: it is the check that the main bundle did not grow. Compare the reported index chunk against the 94.98 kB gzip baseline recorded in `onlooker-0tnr.5`, and if it moved, find out why before committing.

```bash
git add apps/web/src/App.tsx apps/web/src/__tests__/root-redirect.test.tsx
```

Then run `/commit`. The why: the landing route moved in `onlooker-yfw` and this never followed.

---

### Task 7 (optional — drop freely): one ellipsis in button labels

**This task is separable and adds no capability.** 13 explicit `loadingLabel="…"` call sites across 8 files plus 7 `"Working..."` defaults, all spelling the ellipsis `...`. That is real review burden and real conflict surface in files this work does not otherwise touch, for a character nobody has complained about, in a control far less prominent than a page-level loading line. Do it only if the inconsistency is worth those 20 edits to you; nothing before this depends on it.

**Files:**
- Modify: `apps/web/src/components/form.tsx:237`, `apps/web/src/components/ui.tsx:379` (the `"Working..."` defaults)
- Modify: `apps/web/src/components/LoadMore.tsx:77`
- Modify: `apps/web/src/pages/LoginPage.tsx:99`, `SignupPage.tsx:129`, `ForgotPasswordPage.tsx:97`, `ResetPasswordPage.tsx:188`, `MachinesPage.tsx:254`, `LessonDetail.tsx:457`
- Modify: `apps/web/src/pages/SettingsPage.tsx:116,215,308,367`
- Modify: `apps/web/src/__tests__/auth-form.test.tsx:77`, `apps/web/src/__tests__/ui.test.tsx:41`

- [ ] **Step 1: Find every one of them**

```bash
grep -rn 'loadingLabel="[^"]*\.\.\."' apps/web/src
grep -rn '"Working\.\.\."' apps/web/src
```

- [ ] **Step 2: Replace `...` with `…` in each**

Use Edit per file. Do not touch `...` anywhere it is not a `loadingLabel` or the `"Working..."` default — spread syntax and prose elsewhere are not in scope.

- [ ] **Step 3: Confirm none are left**

```bash
grep -rn 'loadingLabel="[^"]*\.\.\."' apps/web/src; echo "(no output = done)"
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @onlooker/web test`
Expected: PASS. The two test fixtures assert on their own strings, so they must be updated in the same pass or they fail — which is the point of including them above.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
git add apps/web/src apps/web/src/__tests__
```

Then run `/commit`. The why: one spelling of one character, so the pass that settled it does not leave two.

---

## Final verification

- [ ] `pnpm --filter @onlooker/web test` — all green
- [ ] `pnpm --filter @onlooker/web typecheck` — clean
- [ ] `pnpm --filter @onlooker/web lint` — no new findings (a small number of pre-existing `mockApi` warnings are expected)
- [ ] `bash scripts/source-guards.test.sh` — passes, with two more tests than before
- [ ] `pnpm --filter @onlooker/web build` — succeeds, main bundle still ~94.98 kB gzip
- [ ] Manual walk with `pnpm dev`: hard-refresh `/machines` and confirm the nav paints immediately rather than a blank page; visit `/nothing-here` signed in and signed out; visit `/` in both states; watch the tab title change as you move between sections
- [ ] `bd close onlooker-lo1x`
