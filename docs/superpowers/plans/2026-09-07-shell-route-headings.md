# Shell Route Headings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every `AppShell` route exactly one `h1` naming that section, rendered once by the shell rather than five times by the pages, and give `Button` the ghost treatment `SettingsPage` already hand-rolls twice.

**Architecture:** `AppShell` looks the current pathname up in its own `SECTIONS` list and renders the matching label as the page `h1`. Because the label already lives there, no page hand-copies a string that must match. `SettingsPage` drops its own `h1`, `ProfilePage` retitles the panel that would now duplicate it, and `LessonDetail`'s claim demotes to `h2` so `/lessons/:id` has one `h1` rather than two.

**Tech Stack:** React 18.3.1, react-router-dom 6.28, TypeScript, Vitest 4 + jsdom 24, React Testing Library 15, biome.

**Spec:** `docs/superpowers/specs/2026-09-07-shell-route-headings-design.md`

**Beads:** `onlooker-eqb`, `onlooker-8ce`. **Branch:** `feat/shell-routes-name-themselves`.

## Global Constraints

- **Edit tracked files with `Edit`/`Write`, never with `sed`/heredocs.** The `lineage` and `inspector` plugins hook `PostToolUse` on the file tools only; a shell edit moves the same bytes invisibly and `/lineage` then answers "no record" for a line that was demonstrably written. See the repo `CLAUDE.md`.
- **`h1` text is exactly the `SECTIONS` label** — `Lessons`, `Machines`, `Activity`, `Settings`, `Profile`. Never a longer descriptive form; that equality is what the test in Task 2 asserts.
- **Flat variant strings, never a `tone` prop.** `ui.tsx` reserves `tone` for "which of two constant plate FILLS backs an icon" (`Panel`'s comment). A second meaning would be exactly the collision that comment prevents.
- **American English** in all comments and commit messages.
- **Commits go through the `/commit` skill**, every time.
- **Do not push or open a PR** until Task 3 completes.
- Test command from `apps/web`: `pnpm test`. Single file: `pnpm vitest run src/__tests__/<file>`.
- Lint: `pnpm lint`. Typecheck: `pnpm typecheck`. Both must be clean before each commit.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/web/src/components/ui.tsx` | Shared primitives | `Button` gains `ghost` and `ghost-danger` |
| `apps/web/src/components/AppShell.tsx` | Chrome around authenticated routes | Export `SECTIONS`; render the page `h1` |
| `apps/web/src/pages/SettingsPage.tsx` | Account settings | Drop its `h1`; three buttons adopt `ghost` |
| `apps/web/src/pages/ProfilePage.tsx` | Account overview | Retitle the panel that would duplicate the `h1` |
| `apps/web/src/pages/LessonDetail.tsx` | One lesson | Every heading shifts down one level |
| `apps/web/src/__tests__/ui.test.tsx` | Primitives | Ghost variant tests |
| `apps/web/src/__tests__/shell-headings.test.tsx` | **New** — the policy | One `h1` per shell route, driven off `SECTIONS` |
| `apps/web/src/__tests__/lessons-page.test.tsx` | Lessons surface | Heading-level assertions if any moved |

**Task order matters and is not arbitrary.** Task 2 is deliberately one task rather than three: adding the shell `h1` without also removing `SettingsPage`'s would put two `h1`s on `/settings`, and without also shifting `LessonDetail` would put two on `/lessons/:id`. There is no point between those edits where the app is correct, so there is no reviewable boundary to split on.

---

## Task 1: `Button` gains the ghost variants

Half of `onlooker-8ce`. Independent of Tasks 2 and 3 — nothing breaks if this lands alone.

**Files:**
- Modify: `apps/web/src/components/ui.tsx:290-347` (`Button`)
- Test: `apps/web/src/__tests__/ui.test.tsx` (append inside `describe("Button", ...)`, which closes at `:69`)

**Interfaces:**
- Produces: `Button`'s `variant` prop widens from `"primary" | "danger"` to `"primary" | "danger" | "ghost" | "ghost-danger"`. Every other prop (`children`, `onClick`, `loading`, `loadingLabel`, `disabled`, `describedBy`) is unchanged. Task 3 consumes this.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("Button", ...)` block in `apps/web/src/__tests__/ui.test.tsx`, before its closing `});` at `:69`:

```tsx
	// The treatment SettingsPage hand-rolled twice before the system owned it:
	// the border and the ink carry the meaning, and nothing is filled. A ghost
	// that quietly kept the plate would look right in isolation and wrong
	// beside the filled button it is meant to read as lesser than.
	it("carries a ghost with a border and no fill", () => {
		render(
			<Button onClick={() => {}} variant="ghost">
				Resend
			</Button>,
		);
		const button = screen.getByRole("button", { name: "Resend" });
		expect(button.style.background).toBe("transparent");
		expect(button.style.color).toBe("var(--ink)");
		expect(button.style.border).toBe("2px solid var(--ink-dim)");
		// The plate's dropped shadow is what reads as "filled and raised".
		expect(button.style.boxShadow).toBe("none");
	});

	// --red on the page ground, matching the section heading. This is the
	// delete *trigger*, which must not outrank the confirm it opens.
	it("carries a destructive ghost in red, still unfilled", () => {
		render(
			<Button onClick={() => {}} variant="ghost-danger">
				Delete my account
			</Button>,
		);
		const button = screen.getByRole("button", { name: "Delete my account" });
		expect(button.style.background).toBe("transparent");
		expect(button.style.color).toBe("var(--red)");
		expect(button.style.border).toBe("2px solid var(--red)");
	});

	// A ghost must not become a filled button when it goes inert - that would
	// make a disabled control the loudest thing on the panel.
	it("stays unfilled while inert", () => {
		render(
			<Button onClick={() => {}} variant="ghost" disabled>
				Resend
			</Button>,
		);
		const button = screen.getByRole("button", { name: "Resend" });
		expect(button.style.background).toBe("transparent");
		expect(button.style.color).toBe("var(--ink-dim)");
	});
```

- [ ] **Step 2: Run the tests and verify they fail**

From `apps/web`:

```bash
pnpm vitest run src/__tests__/ui.test.tsx -t "ghost"
```

Expected: FAIL. `variant="ghost"` is not yet an accepted value, so `plate` falls through to `PALETTE.plateTeal` and `background` is the teal plate rather than `transparent`.

- [ ] **Step 3: Widen the variant type**

In `apps/web/src/components/ui.tsx`, change `Button`'s prop type at `:301`:

```tsx
	variant?: "primary" | "danger" | "ghost" | "ghost-danger";
```

- [ ] **Step 4: Compute the surface from the variant**

In `apps/web/src/components/ui.tsx`, replace the single `plate` line at `:318` with:

```tsx
	const plate = variant === "danger" ? PALETTE.plateRed : PALETTE.plateTeal;
	const isGhost = variant === "ghost" || variant === "ghost-danger";

	// Ghost carries its meaning in ink and border rather than in a fill, for
	// the two places a filled plate would be wrong: a control that only opens
	// a confirmation (a filled danger button would outrank the actual confirm
	// below it), and a secondary action sitting beside a filled one.
	//
	// Both colors were measured on the page ground before this variant
	// existed, in the inline copies this replaces: --red is 7.94/6.48 as text
	// and clears 3:1 as a border; --ink is 11.27/10.28 and --ink-dim clears
	// 3:1 as its border at 8.06/6.56.
	const ghostInk = variant === "ghost-danger" ? "var(--red)" : "var(--ink)";
	const ghostEdge = variant === "ghost-danger" ? "var(--red)" : "var(--ink-dim)";

	// Split out rather than four nested ternaries inline: a ghost differs from
	// a plate on every one of these, and inert differs again within each.
	const surface = isGhost
		? {
				background: "transparent",
				color: inert ? "var(--ink-dim)" : ghostInk,
				border: `2px solid ${inert ? "var(--ink-dim)" : ghostEdge}`,
				// Never raised. The shadow is what reads as filled.
				boxShadow: "none",
			}
		: {
				background: inert ? "var(--panel)" : plate,
				color: inert ? "var(--ink)" : PALETTE.plateInk,
				border: inert
					? "2px solid var(--ink-dim)"
					: `2px solid ${PALETTE.plateInk}`,
				boxShadow: inert ? "none" : "4px 4px 0 var(--shadow)",
			};
```

Then in the `style` object, replace the four lines `background`, `color`, `border` and `boxShadow` with a spread, leaving `padding` and everything below it untouched:

```tsx
			style={{
				padding: "0.5rem 1rem",
				...surface,
				borderRadius: 0,
				cursor: inert ? "not-allowed" : "pointer",
				fontFamily: "var(--font-data)",
				fontSize: "var(--text-data-md)",
				letterSpacing: "1px",
				textTransform: "uppercase",
			}}
```

- [ ] **Step 5: Run the tests and verify they pass**

```bash
pnpm vitest run src/__tests__/ui.test.tsx
```

Expected: PASS, all tests in the file. The two pre-existing plate tests (`"fills with a plate and never an accent"` at `:52` and `"fills with the red plate when it is destructive"` at `:59`) must still pass — if either broke, the spread reordered something it should not have.

- [ ] **Step 6: Full suite, lint, typecheck**

```bash
pnpm test && pnpm lint && pnpm typecheck
```

Expected: all green.

- [ ] **Step 7: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add src/components/ui.tsx src/__tests__/ui.test.tsx
```

Message shape — `feat(web): ...`, body explaining that the treatment already existed twice inline and the system now owns it. `Refs onlooker-8ce`.

---

## Task 2: The shell names the page

Closes `onlooker-eqb`. One atomic change — see the note under File Structure for why this is not three tasks.

**Files:**
- Modify: `apps/web/src/components/AppShell.tsx:2` (import), `:19` (export `SECTIONS`), `:34` (location), inside `<main>`
- Modify: `apps/web/src/pages/SettingsPage.tsx:55` (delete the `h1`)
- Modify: `apps/web/src/pages/ProfilePage.tsx:44` (retitle the panel)
- Modify: `apps/web/src/pages/LessonDetail.tsx:322` (`h1`→`h2`), `:34-41` (one line of the comment above `Field`'s `h3`, which does **not** move)
- Create: `apps/web/src/__tests__/shell-headings.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `SECTIONS` becomes a named export of `apps/web/src/components/AppShell.tsx`, typed `readonly { to: string; label: string; icon: IconName }[]` via its existing `as const`. The new test file imports it. Nothing else consumes it.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/shell-headings.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// The same seam account-routes-in-shell.test.tsx uses: App reaches for the API
// client at module scope and RequireAuth would bounce an unauthenticated
// render. Everything else stays real, because the thing under test is the
// shell's wiring rather than any single page.
vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({
			user: { id: "u1", email: "someone@example.com", name: "Someone" },
			loading: false,
			logout: vi.fn(),
			refresh: vi.fn(),
			sessionExpiresAt: null,
			sessionExpiringSoon: false,
		}),
		RequireAuth: ({ children }: { children: React.ReactNode }) => children,
	},
}));

// Every shell page fetches on mount. The heading comes from AppShell rather
// than from any page, so it is there whichever branch a page renders - but
// stubbing keeps these tests about the heading rather than about timing, and
// keeps unhandled rejections out of the output.
vi.mock("../hooks/useAuthenticatedFetch", () => ({
	useAuthenticatedFetch: () => ({
		data: null,
		loading: false,
		error: null,
		refetch: vi.fn(),
	}),
}));
vi.mock("../api/accountApi", () => ({
	getProfile: () => Promise.resolve({ user: null }),
	updateProfile: vi.fn(),
	changePassword: vi.fn(),
	deleteAccount: vi.fn(),
	resendVerificationEmail: vi.fn(),
}));
vi.mock("../api/machinesApi", () => ({
	MACHINE_ENDPOINTS: { machines: "/api/machines" },
	listMachines: () => Promise.resolve({ machines: [] }),
	createMachine: vi.fn(),
	revokeMachine: vi.fn(),
}));

const { default: App } = await import("../App");
const { SECTIONS } = await import("../components/AppShell");

function renderAppAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<App />
		</MemoryRouter>,
	);
}

describe("the page heading on shell routes", () => {
	// Driven off SECTIONS rather than a hand-written list, so a route added to
	// the nav is covered without anyone remembering to extend this test. That
	// is what makes this a policy rather than a description of five pages.
	//
	// Equality, not a match: the whole reason the h1 is rendered from SECTIONS
	// is so the heading and the nav label cannot drift. Before this, the nav
	// announced "Settings, current page" and the first heading then said
	// "Account settings".
	it.each(SECTIONS.map((section) => [section.to, section.label]))(
		"names %s with an h1 reading exactly %s",
		(to, label) => {
			renderAppAt(to);
			const headings = screen.getAllByRole("heading", { level: 1 });
			expect(headings).toHaveLength(1);
			expect(headings[0].textContent).toBe(label);
		},
	);

	// The regression this design is most likely to suffer. /lessons/:id renders
	// LessonDetail inside LessonsPage through an Outlet, so re-promoting the
	// claim to h1 would put two on the route - and a test that only looked at
	// /lessons would never see it.
	it("keeps one h1 on a lesson detail route", () => {
		renderAppAt("/lessons/some-lesson-id");
		const headings = screen.getAllByRole("heading", { level: 1 });
		expect(headings).toHaveLength(1);
		expect(headings[0].textContent).toBe("Lessons");
	});
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
pnpm vitest run src/__tests__/shell-headings.test.tsx
```

Expected: FAIL. `SECTIONS` is not exported yet, so the import throws before any assertion runs. That is a real failure but not yet the interesting one — Step 3 makes it export, and the run in Step 6 is where the assertions do the work.

- [ ] **Step 3: Export `SECTIONS` and render the heading**

In `apps/web/src/components/AppShell.tsx`, add `useLocation` to the router import at `:2`:

```tsx
import { NavLink, useLocation, useNavigate } from "react-router-dom";
```

Change `const SECTIONS = [` at `:19` to:

```tsx
export const SECTIONS = [
```

Add the location read beside the existing hooks (currently `:34-36`):

```tsx
	const { user, logout } = auth.useAuth();
	const navigate = useNavigate();
	const location = useLocation();
	const { dismiss } = useReveal();

	// The page heading comes from SECTIONS rather than from the page, which is
	// the whole of the fix for onlooker-eqb. Two of the five shell routes named
	// themselves nowhere in the heading outline - /activity's first heading was
	// a date - and /settings disagreed with its own nav label. Rendering the
	// label from the one place it is defined means the five pages cannot drift,
	// and a sixth route gets a heading by existing.
	//
	// Exact match or a `to`-plus-slash prefix, so /lessons/:id resolves to
	// Lessons. Prefix alone would be wrong in principle - /lessons would also
	// match a future /lessons-archive - and the slash costs nothing.
	//
	// A shell route with no SECTIONS entry renders no h1. Every shell route
	// today is a nav destination; one deliberately absent from the nav would be
	// a larger question than this. See the design's Section 2.
	const section = SECTIONS.find(
		(candidate) =>
			location.pathname === candidate.to ||
			location.pathname.startsWith(`${candidate.to}/`),
	);
```

Then inside `<main>`, between `<SessionExpiryBanner />` and `{children}`:

```tsx
				<SessionExpiryBanner />
				{/*
				  After the banner deliberately. The banner warns that a silent
				  token refresh failed, which is session chrome rather than page
				  content - someone who needs it should not have to pass the
				  page title first.
				*/}
				{section ? (
					<h1
						style={{
							margin: "0 0 var(--space-3)",
							// The readable face, not the pixel one, matching the
							// page heading LessonDetail already established: a
							// heading here leads by size and weight rather than
							// by face.
							fontFamily: "var(--font-body)",
							fontSize: "var(--text-body-lg)",
						}}
					>
						{section.label}
					</h1>
				) : null}
				{children}
```

- [ ] **Step 4: Remove `SettingsPage`'s own `h1`**

In `apps/web/src/pages/SettingsPage.tsx`, delete the line at `:55`:

```tsx
			<h1>Account settings</h1>
```

Delete the line entirely. The shell now renders `Settings` for this route. This is `onlooker-8ce`'s first item, resolved by deletion rather than by restyling.

- [ ] **Step 5: Retitle `ProfilePage`'s panel**

In `apps/web/src/pages/ProfilePage.tsx:44`, change:

```tsx
				<Panel title="Profile" icon="CatHead">
```

to:

```tsx
				{/*
				  Not "Profile": the shell now renders that as the page h1
				  directly above, and the panel would repeat it. "Account
				  details" is what it holds. Not untitled either - Panel renders
				  its icon inside the h2, so an untitled panel would silently
				  drop CatHead.
				*/}
				<Panel title="Account details" icon="CatHead">
```

- [ ] **Step 6: Demote `LessonDetail`'s claim to `h2`**

**Only the claim moves.** In `apps/web/src/pages/LessonDetail.tsx`, change the `<h1` at `:322` to `<h2`, and its closing `</h1>` to `</h2>`. Leave every style property on it unchanged — the claim keeps its type treatment and only its level changes.

**Do not touch the `<h3` at `:42`, and do not touch `Panel`.** The spec's Section 4 was corrected on this point during planning. `Panel` renders a literal `<h2>` at `ui.tsx:154` and is shared by every page, so moving it would shift headings on `/machines`, `/settings`, `/profile` and `/activity` too — where `Panel`'s `h2` under the shell's `h1` is already right. Since `Panel` stays `h2`, `Field` stays `h3` beneath it.

The resulting outline on `/lessons/:id`:

```
h1  Lessons          (AppShell)
h2  The pool         (Panel, the list)
h2  <the claim>      (LessonDetail)
h2  Applies to       (Panel, in the detail)
h3    Versions       (Field)
```

Then edit — do not rewrite — the comment at `:34-41`. Only its top link changed; `Field` under `Panel` is untouched, so the first two lines and the last two stay exactly as they are. Change only the document-order line:

```tsx
			{/*
			  h3, not h2: `Field` only ever renders inside a titled `Panel`
			  (Applies to / Why it was trusted), and that title is itself the
			  h2. Nesting this under it as an h3 is correct document order -
			  h1 (the section, from AppShell) -> h2 (the claim, and the panels
			  beside it) -> h3 (the field) - not a skip.
			  The font size is an explicit inline style below, so this is a
			  semantic-only change - nothing here should look different.
			*/}
```

- [ ] **Step 7: Run the new test and verify it passes**

```bash
pnpm vitest run src/__tests__/shell-headings.test.tsx
```

Expected: PASS, six tests — five from `it.each` over `SECTIONS`, plus the lesson-detail case.

If the `/lessons/:id` case fails with two `h1`s, Step 6's `h1`→`h2` did not land. If it fails with the wrong text, the matcher in Step 3 is matching the wrong section.

- [ ] **Step 8: Run the full suite and fix the fallout**

```bash
pnpm test
```

Two files were checked against this change while planning and are expected to **pass unchanged** — if either fails, something went wider than intended:

- `account-routes-in-shell.test.tsx:121` asserts no heading named `/^profile$/i` **on `/settings`**. `/settings` now renders `h1 Settings`, so this still holds. Its `/profile` tests assert on links and field text, not headings.
- `activity-page.test.tsx:133` counts `level: 2` headings and expects 2. An `h1` does not change the `h2` count.

`lessons-page.test.tsx` queries claims via `findByRole("heading", { name: ... })` **without a level**, so the claim moving from `h1` to `h2` does not break them. If any assertion there does pin a level, update it to the new level — the heading did move, and the test was right to notice.

- [ ] **Step 9: Lint and typecheck**

```bash
pnpm lint && pnpm typecheck
```

Expected: clean. If biome reports an unused `useLocation`, Step 3's `section` lookup did not land.

- [ ] **Step 10: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add src/components/AppShell.tsx src/pages/SettingsPage.tsx \
        src/pages/ProfilePage.tsx src/pages/LessonDetail.tsx \
        src/__tests__/shell-headings.test.tsx
```

Add `src/__tests__/lessons-page.test.tsx` only if Step 8 required changes there.

Message shape — `feat(web): ...`, body explaining that two of five routes named themselves nowhere in the outline and that rendering from `SECTIONS` is what stops the heading and the nav label drifting. `Refs onlooker-eqb`.

---

## Task 3: Settings adopts the ghost

Closes `onlooker-8ce`.

**Files:**
- Modify: `apps/web/src/pages/SettingsPage.tsx` — the resend button (was `:114-124`, now shifted up one line by Task 2's deletion), and `DeleteAccountSection`'s two buttons
- Test: `apps/web/src/__tests__/account-routes-in-shell.test.tsx` is the existing coverage; no new test file

**Interfaces:**
- Consumes: `Button` with `variant="ghost"` and `variant="ghost-danger"` from Task 1, plus its existing `loading` / `loadingLabel` / `disabled` props.
- Produces: nothing.

- [ ] **Step 1: Confirm `Button` is imported in `SettingsPage`**

```bash
grep -n "from \"../components/ui\"" src/pages/SettingsPage.tsx
```

If `Button` is not in that import list, add it. `SubmitButton`, `TextField` and `FormMessage` come from `../components/form` and are unrelated.

- [ ] **Step 2: Convert the resend-verification button**

Replace the raw `<button>` (the one whose label is `Resend verification email`) with:

```tsx
				<Button
					onClick={resend}
					variant="ghost"
					loading={state === "sending"}
					loadingLabel="Sending..."
				>
					Resend verification email
				</Button>
```

Note the mapping: the old control used `disabled={state === "sending"}` plus a ternary on its label. `Button` expresses exactly that as `loading` + `loadingLabel`, and its comment explains why pending is announced rather than `disabled` — setting the attribute moves focus to `<body>` the instant the button the person just pressed goes inert.

- [ ] **Step 3: Convert the delete trigger**

In `DeleteAccountSection`, replace the raw `<button>` labelled `Delete my account` with:

```tsx
				<Button onClick={() => setConfirming(true)} variant="ghost-danger">
					Delete my account
				</Button>
```

Its reasoning — that a filled danger button here would outrank the actual confirm below it, and that `--red` matches the section heading — moved into `ui.tsx` in Task 1, so it is not lost by deleting the inline comment.

- [ ] **Step 4: Convert the cancel button**

Replace the raw `<button>` inside the confirm form (the one that calls `setConfirming(false)`) with:

```tsx
						<Button
							onClick={() => {
								setConfirming(false);
								setConfirmText("");
								setError(null);
							}}
							variant="ghost"
							disabled={loading}
						>
							Cancel
						</Button>
```

Use whatever label the existing button has rather than assuming `Cancel` — read it first and keep it.

**One real difference to know about.** The inline cancel used `padding: "0.75rem 1.5rem"` to sit beside `SubmitButton` (`padding: "0.75rem"`), while `Button` uses `padding: "0.5rem 1rem"`. Their container is `<div style={{ display: "flex", gap: "0.75rem" }}>`, and flex defaults to `align-items: stretch`, so the two should still render the same height — only the text inset changes. This is reasoned, not measured, which is why Step 6 looks at it in a browser.

- [ ] **Step 5: Run the suite, lint, typecheck**

```bash
pnpm test && pnpm lint && pnpm typecheck
```

Expected: all green. `account-routes-in-shell.test.tsx` exercises `/settings`; if it fails on a missing button name, a label changed in Steps 2–4 when it should not have.

- [ ] **Step 6: Look at the delete-confirm row in a browser**

The padding change in Step 4 is the one thing in this plan that a jsdom test cannot judge — computed layout is exactly what jsdom does not do.

From `apps/web`, run the dev server against the in-memory mock so `/settings` is reachable without standing up wrangler and D1:

```bash
VITE_API_BASE_URL= VITE_USE_MOCK_API=true pnpm dev
```

Do **not** create a `.env.development.local` for this — a hook blocks writes to `.env` files, and the process environment works.

Sign in and go to `/settings`. Ask the person you are working with to do the sign-in — do not type credentials yourself. Open the delete confirmation and check that `Permanently delete` and the cancel button beside it are the same height and share a baseline. If they are not, give `Button` the taller padding only where it sits beside a `SubmitButton`, or leave the cancel inline with a comment saying why — and say which you did.

Stop the dev server when done.

- [ ] **Step 7: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add src/pages/SettingsPage.tsx
```

Message shape — `feat(web): ...`, body explaining that three hand-rolled copies of one treatment become one variant. `Refs onlooker-8ce`.

- [ ] **Step 8: Close the beads and open the PR**

```bash
bd close onlooker-eqb
bd close onlooker-8ce
```

Record anything the browser check in Step 6 turned up with `bd update <id> --append-notes`. **Use `--append-notes`, never `--notes`** — `--notes` replaces the whole NOTES body and only warns after the write has already happened.

Then use the `/pr` skill. The PR body should state the policy in one line, note that the bead said four routes and there are five, and say that `8ce`'s first item was dissolved by moving the `h1` into the shell rather than fixed in place.

---

## Self-Review

**Spec coverage.** Section 1 (one `h1`, named for the section) → Task 2 Steps 3 and 7. Section 2 (`AppShell` renders it, matching rule, placement, type, the stated limit) → Task 2 Step 3, with the limit written into the code comment. Section 3 (per-page consequences) → Task 2 Steps 4 and 5. Section 4 (`LessonDetail` shifts) → Task 2 Step 6. Section 5 (ghost variants, flat strings, rejected alternatives) → Task 1. Section 6 (testing) → Task 2 Step 1 for both named assertions, Task 1 Step 1 for the variant. Consequences → Task 3 Step 8.

**Placeholders.** None. Two steps are deliberately conditional rather than vague: Task 2 Step 8 says which two test files were checked and expected to pass, and what to do if `lessons-page.test.tsx` pins a level; Task 3 Step 4 says to read the cancel button's real label rather than assuming it.

**Type consistency.** `variant?: "primary" | "danger" | "ghost" | "ghost-danger"` is written identically in Task 1 Step 3 and consumed as `ghost` / `ghost-danger` in Task 3 Steps 2–4. `SECTIONS` is the same name in Task 2 Steps 1 and 3 and in the File Structure table. `section` is the local in Task 2 Step 3, used only there. `isGhost`, `ghostInk`, `ghostEdge` and `surface` are all introduced and consumed within Task 1 Step 4.
