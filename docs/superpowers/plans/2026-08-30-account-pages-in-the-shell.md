# Account Pages in the Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `/settings` and `/profile` inside `AppShell` so signed-in users keep the app's navigation, and give Profile sole ownership of the account overview.

**Architecture:** Three tasks in dependency order. `Panel` first gains a `variant` so it can carry the two colored borders Settings needs; then Profile is rebuilt on it; then Settings. Each task is a route change plus a component rewrite plus tests, and each leaves the app working.

**Tech Stack:** React 19, React Router 7, TypeScript, Vitest + @testing-library/react, Biome.

**Spec:** `docs/superpowers/specs/2026-08-30-account-pages-in-the-shell-design.md`
**Bead:** `onlooker-e5a`

## Global Constraints

- **Edit tracked files with `Edit`/`Write`/`MultiEdit`, never the shell.** Required by `CLAUDE.md`; `lineage` and `inspector` only observe tool calls, so a `sed`/heredoc edit is invisible to them.
- **American English** in all comments, identifiers, and copy.
- Run commands from `apps/web`. Test: `../../node_modules/.bin/vitest run <path>`. Typecheck: `../../node_modules/.bin/tsc --noEmit`. Lint: `../../node_modules/.bin/biome check src`.
- Commit through the `/commit` skill. Conventional commits, subject ≤72 chars including a mood emoji, body explains *why*.
- Do not touch: the five auth pages, `form.tsx`, `AuthCard`, `AppShell.tsx`, `packages/brand`.
- `Panel`'s existing callers pass no `variant` and must render byte-identically.

---

### Task 1: Panel carries a meaningful border

`Panel` renders a fixed `2px solid ${PALETTE.border}`. Settings has two sections whose border color is signal — gold for "verify your email", red for "delete account" — and they lose that meaning when they become Panels unless Panel can express it.

**Files:**
- Modify: `apps/web/src/components/ui.tsx:112-150` (the `Panel` function)
- Test: `apps/web/src/__tests__/ui.test.tsx:141` (the existing `describe("Panel")` block)

**Interfaces:**
- Consumes: `PALETTE` from `../components/palette`, already imported in both files.
- Produces: `Panel({ title?, icon?, variant?, children })` where `variant?: "notice" | "danger"`. Tasks 2 and 3 rely on this exact prop name and these exact values.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe("Panel", ...)` block in `apps/web/src/__tests__/ui.test.tsx`:

```tsx
	// The two Settings sections that carry a colored border carry it as signal:
	// "verify your email" is a call to action and "delete account" is
	// destructive. A Panel with one fixed border color cannot say either, so
	// moving those sections onto Panel without this would quietly drop the
	// distinction rather than restyle it.
	it("uses the default border when it has no variant", () => {
		const { container } = render(<Panel title="Plain">body</Panel>);
		const section = container.querySelector("section");
		expect(section?.style.border).toBe(`2px solid ${PALETTE.border}`);
	});

	it("borders a notice in gold", () => {
		const { container } = render(
			<Panel title="Verify" variant="notice">
				body
			</Panel>,
		);
		const section = container.querySelector("section");
		expect(section?.style.border).toBe("2px solid var(--gold)");
	});

	it("borders a danger in red", () => {
		const { container } = render(
			<Panel title="Delete" variant="danger">
				body
			</Panel>,
		);
		const section = container.querySelector("section");
		expect(section?.style.border).toBe("2px solid var(--red)");
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `../../node_modules/.bin/vitest run src/__tests__/ui.test.tsx -t Panel`

Expected: the default-border test PASSES (it describes current behavior), and the two variant tests FAIL — both will report `2px solid <PALETTE.border value>` where gold or red was expected, because `Panel` ignores the unknown prop.

If the two variant tests pass, stop: the prop already exists and this task is wrong.

- [ ] **Step 3: Add the variant to Panel**

In `apps/web/src/components/ui.tsx`, change the `Panel` signature and its border. The full replacement for the props block and the `<section>` style:

```tsx
export function Panel({
	title,
	icon,
	variant,
	children,
}: {
	title?: string;
	icon?: IconName;
	/**
	 * A colored edge, for the two cases where the border itself is the
	 * message: `notice` for something the reader has to act on, `danger` for
	 * something destructive.
	 *
	 * Not `tone` and not `accent`, both of which already mean something else
	 * in this file. `tone` is which of two constant plate FILLS backs an icon
	 * (`Plate`, `EmptyState`). `accent` is a TEXT color that shifts with the
	 * theme, defined in opposition to a plate - `Button` is tested to fill
	 * "with a plate and never an accent". `variant` follows `Button`, where
	 * `danger` already means exactly this.
	 *
	 * Named for what the border is for rather than what color it is, so the
	 * prop does not become a lie if gold is ever retuned.
	 */
	variant?: "notice" | "danger";
	children: ReactNode;
}) {
	const border =
		variant === "notice"
			? "var(--gold)"
			: variant === "danger"
				? "var(--red)"
				: PALETTE.border;
	return (
		<section
			style={{
				background: "var(--panel)",
				border: `2px solid ${border}`,
				borderRadius: 0,
				padding: "1rem",
			}}
		>
```

Leave the rest of the function — the `title`/`icon` heading and `{children}` — exactly as it is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `../../node_modules/.bin/vitest run src/__tests__/ui.test.tsx`

Expected: PASS, including every pre-existing `Panel`, `Plate`, `Button`, `StatusBadge`, `Chip` and `EmptyState` test. The default-border test is the guard that existing callers did not shift.

- [ ] **Step 5: Run the full web suite, typecheck and lint**

```bash
../../node_modules/.bin/vitest run
../../node_modules/.bin/tsc --noEmit
../../node_modules/.bin/biome check src
```

Expected: all pass. `/lessons` and `/machines` tests exercise `Panel` and must be unchanged.

- [ ] **Step 6: Commit**

Use the `/commit` skill with `apps/web/src/components/ui.tsx` and `apps/web/src/__tests__/ui.test.tsx`. The body should say why the border is signal rather than decoration, and why the prop is `variant` rather than `tone` or `accent`.

---

### Task 2: Profile inside the shell

`ProfilePage` renders no `AppShell`, so it has no navigation and hand-rolls a two-link `<nav>` instead. It also duplicates Settings' account overview. This task makes it the single owner of that overview and puts it inside the app's chrome.

**Files:**
- Modify: `apps/web/src/pages/ProfilePage.tsx` (whole file)
- Modify: `apps/web/src/App.tsx:74-82` (the `/profile` route)
- Create: `apps/web/src/__tests__/account-routes-in-shell.test.tsx`

**Interfaces:**
- Consumes: `Panel` and `Button` from `../components/ui` (Task 1 for `variant`, though this task passes none); `AppShell` from `../components/AppShell`; `useAuthenticatedFetch` from `../hooks/useAuthenticatedFetch`; `UserProfile` from `../types/api`.
- Produces: `/profile` renders `AppShell`. Task 3 adds `/settings` assertions to the same test file created here.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/account-routes-in-shell.test.tsx`. This renders the real `App` at a route, which is the only way to assert a route is wrapped — `app-shell.test.tsx`'s `renderShell` mounts `AppShell` directly and would pass no matter how `App` is wired.

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// App reaches for the API client at module scope and RequireAuth would bounce
// an unauthenticated render, so auth is the seam - the same one
// app-error-boundary.test.tsx uses. Everything else stays real, because the
// thing under test is App's wiring rather than any single page.
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

// ProfilePage fetches on mount. Left unmocked it would try a real request and
// the page would render its loading branch, which still renders the shell -
// but a stub keeps the test about routing rather than about timing.
vi.mock("../hooks/useAuthenticatedFetch", () => ({
	useAuthenticatedFetch: () => ({
		data: {
			name: "Someone",
			email: "someone@example.com",
			createdAt: "2026-01-01T00:00:00.000Z",
			lastLoginAt: "2026-08-30T00:00:00.000Z",
		},
		loading: false,
		error: null,
		refetch: vi.fn(),
	}),
}));

const { default: App } = await import("../App");

function renderAppAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<App />
		</MemoryRouter>,
	);
}

describe("account routes", () => {
	// The whole point of the change: before this, a signed-in person who
	// reached /profile lost the navigation and had to use browser-back.
	it("renders /profile inside the shell", () => {
		renderAppAt("/profile");
		const href = (name: RegExp) =>
			screen.getByRole("link", { name }).getAttribute("href");
		expect(href(/lessons/i)).toBe("/lessons");
		expect(href(/machines/i)).toBe("/machines");
		expect(href(/settings/i)).toBe("/settings");
	});

	// The hand-rolled <nav> existed only because there was no shell. Leaving it
	// would mean two sets of links to the same places.
	it("does not keep a second set of links on /profile", () => {
		renderAppAt("/profile");
		expect(screen.getAllByRole("link", { name: /lessons/i })).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `../../node_modules/.bin/vitest run src/__tests__/account-routes-in-shell.test.tsx`

Expected: FAIL. The first test errors with `Unable to find role="link"` for `/machines` — the current `ProfilePage` renders links to `/lessons` and `/settings` only, and no shell.

- [ ] **Step 3: Rewrite ProfilePage**

Replace the whole of `apps/web/src/pages/ProfilePage.tsx`:

The shell is applied in the route, not here — that is the pattern `/lessons` and `/machines` already use in `App.tsx`, and Step 4 does it. This component stays a plain page.

```tsx
import { Button, Panel } from "../components/ui";
import { useAuthenticatedFetch } from "../hooks/useAuthenticatedFetch";
import type { UserProfile } from "../types/api";

function formatDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div style={{ display: "flex", padding: "0.35rem 0" }}>
			<dt style={{ width: "140px", color: "var(--ink-dim)" }}>{label}</dt>
			<dd style={{ margin: 0 }}>{value}</dd>
		</div>
	);
}

// The account overview lives here and only here. Settings used to carry a
// second copy that had already drifted - it said "Member since" where this
// says "Account created", and it never showed last login at all.
export default function ProfilePage() {
	const { data, loading, error, refetch } =
		useAuthenticatedFetch<UserProfile>("/api/users/me");

	return (
		<div style={{ maxWidth: "640px" }}>
			{loading && <p>Loading your profile…</p>}

			{error && !loading && (
				<Panel title="Profile" icon="CatHead" variant="danger">
					<p style={{ marginTop: 0 }}>Could not load your profile: {error}</p>
					<Button onClick={() => refetch()}>Retry</Button>
				</Panel>
			)}

			{data && !loading && (
				<Panel title="Profile" icon="CatHead">
					<dl style={{ margin: 0 }}>
						<Row label="Name" value={data.name} />
						<Row label="Email" value={data.email} />
						<Row label="Account created" value={formatDate(data.createdAt)} />
						<Row label="Last login" value={formatDate(data.lastLoginAt)} />
					</dl>
				</Panel>
			)}
		</div>
	);
}
```

Note what left: the `<h1>Profile</h1>` (the Panel's title replaces it), the hand-rolled `<nav>` (AppShell supplies it), the outer `margin: "0 auto"` and `padding: "2rem"` (AppShell owns page padding), and the unstyled `<button>`.

- [ ] **Step 4: Wrap the /profile route**

`App.tsx:89-100` wraps `/lessons` as `<auth.RequireAuth><AppShell><LessonsPage /></AppShell></auth.RequireAuth>`. Follow that shape exactly:

```tsx
					<Route
						path="/profile"
						element={
							<auth.RequireAuth>
								<AppShell>
									<ProfilePage />
								</AppShell>
							</auth.RequireAuth>
						}
					/>
```

`AppShell` is already imported in `App.tsx` for `/lessons` and `/machines`; no new import is needed.

- [ ] **Step 5: Run the test to verify it passes**

Run: `../../node_modules/.bin/vitest run src/__tests__/account-routes-in-shell.test.tsx`

Expected: PASS, both tests.

- [ ] **Step 6: Run the full suite, typecheck and lint**

```bash
../../node_modules/.bin/vitest run
../../node_modules/.bin/tsc --noEmit
../../node_modules/.bin/biome check src
```

Expected: all pass. Pay attention to `app-error-boundary.test.tsx`, which renders at `/profile` three times — it mocks `ProfilePage` to throw, so the boundary should still catch it, now inside the shell.

- [ ] **Step 7: Commit**

Use the `/commit` skill with `apps/web/src/pages/ProfilePage.tsx`, `apps/web/src/App.tsx`, and `apps/web/src/__tests__/account-routes-in-shell.test.tsx`.

---

### Task 3: Settings inside the shell

`SettingsPage` renders no shell either, and carries the duplicate account overview this plan is removing. Its four sections become Panels with icons; two of them keep their colored border through Task 1's `variant`.

**Files:**
- Modify: `apps/web/src/pages/SettingsPage.tsx`
- Modify: `apps/web/src/App.tsx:66-73` (the `/settings` route)
- Modify: `apps/web/src/__tests__/account-routes-in-shell.test.tsx` (add the `/settings` cases)

**Interfaces:**
- Consumes: `Panel` with `variant?: "notice" | "danger"` from Task 1; `AppShell`; the `renderAppAt` helper from the test file created in Task 2.
- Produces: nothing later tasks depend on. This is the last task.

- [ ] **Step 1: Write the failing tests**

Add to `describe("account routes", ...)` in `apps/web/src/__tests__/account-routes-in-shell.test.tsx`. `SettingsPage` calls `getProfile()` on mount, so `accountApi` needs a stub — add this `vi.mock` beside the existing ones at the top of the file:

```tsx
vi.mock("../api/accountApi", () => ({
	getProfile: () =>
		Promise.resolve({
			user: {
				id: "u1",
				name: "Someone",
				email: "someone@example.com",
				emailVerified: true,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		}),
	updateProfile: vi.fn(),
	changePassword: vi.fn(),
	deleteAccount: vi.fn(),
	resendVerificationEmail: vi.fn(),
}));
```

Then the cases:

```tsx
	it("renders /settings inside the shell", () => {
		renderAppAt("/settings");
		const href = (name: RegExp) =>
			screen.getByRole("link", { name }).getAttribute("href");
		expect(href(/lessons/i)).toBe("/lessons");
		expect(href(/machines/i)).toBe("/machines");
		expect(href(/profile/i)).toBe("/profile");
	});

	// One fact, one home. Settings and Profile both showed the account
	// overview and had already drifted - Settings said "Member since" and
	// never showed last login. Profile owns it now, and this is what stops
	// the second copy growing back.
	it("does not show an account overview on /settings", () => {
		renderAppAt("/settings");
		expect(screen.queryByRole("heading", { name: /^profile$/i })).toBeNull();
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `../../node_modules/.bin/vitest run src/__tests__/account-routes-in-shell.test.tsx`

Expected: both new tests FAIL. The shell test errors finding a `/machines` link; the overview test finds the `<h2>Profile</h2>` that `ProfileOverview` still renders.

- [ ] **Step 3: Convert the sections to Panels and drop the overview**

In `apps/web/src/pages/SettingsPage.tsx`:

1. Add `Panel` to the imports: `import { Panel } from "../components/ui";`
2. Delete the `sectionStyle` constant (lines 28-33), the `ProfileOverview` function, and the `Row` function.
3. Delete `<ProfileOverview user={display} />` from the render tree.
4. Replace each section's wrapper. `EmailVerificationNotice`:

```tsx
	return (
		<Panel title="Verify your email" icon="Letter" variant="notice">
```

`UpdateProfileSection`:

```tsx
	return (
		<Panel title="Update profile" icon="Pencil">
```

`ChangePasswordSection`:

```tsx
	return (
		<Panel title="Change password" icon="Locked">
```

`DeleteAccountSection`:

```tsx
	return (
		<Panel title="Delete account" icon="Trashbin" variant="danger">
```

In each, delete the `<h2 style={{ marginTop: 0 }}>…</h2>` that followed the opening tag — `Panel`'s `title` renders it now — and change the closing `</section>` to `</Panel>`.

`Locked` rather than `Key` for the password section: `Key` is already the nav icon for `/machines`, and one icon meaning two things is worse than a slightly less obvious icon.

5. Correct the comment at line 38. It currently reads:

```tsx
	// /settings renders without AppShell, so a reveal opened on /machines can
	// still be on screen here - the provider lives above the whole route table.
```

Replace with:

```tsx
	// The reveal provider lives above the whole route table, so a reveal opened
	// on /machines can still be on screen here. AppShell marks the page behind
	// it inert, but only the delete-account path below can decide to end it.
```

6. Remove the now-redundant `<FormLink to="/lessons">Back to the pool</FormLink>` and the flex wrapper around the `<h1>` — AppShell provides that navigation. Keep the `<h1>Account settings</h1>`, and drop the outer `margin: "0 auto"` and `padding: "2rem"`:

```tsx
	return (
		<div style={{ maxWidth: "640px" }}>
			<h1>Account settings</h1>
```

If `FormLink` is now unused in the file, remove it from the `../components/form` import.

- [ ] **Step 4: Wrap the /settings route**

In `apps/web/src/App.tsx`:

```tsx
					<Route
						path="/settings"
						element={
							<auth.RequireAuth>
								<AppShell>
									<SettingsPage />
								</AppShell>
							</auth.RequireAuth>
						}
					/>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `../../node_modules/.bin/vitest run src/__tests__/account-routes-in-shell.test.tsx`

Expected: PASS, all four cases.

- [ ] **Step 6: Run the full suite, typecheck and lint**

```bash
../../node_modules/.bin/vitest run
../../node_modules/.bin/tsc --noEmit
../../node_modules/.bin/biome check src
```

Expected: all pass. Two files need attention if they fail:

- `reveal-across-the-app.test.tsx` references `/settings` twice. If it asserted anything that depended on `/settings` lacking a shell, that assertion is now wrong and should be updated to match the new behavior — not deleted.
- `login-page.test.tsx` references `/settings`; check it is only as a redirect target.

- [ ] **Step 7: Commit**

Use the `/commit` skill with `apps/web/src/pages/SettingsPage.tsx`, `apps/web/src/App.tsx`, and `apps/web/src/__tests__/account-routes-in-shell.test.tsx`.

- [ ] **Step 8: Close the bead**

```bash
bd close onlooker-e5a
```

Then note on `onlooker-zq1` that `/settings` and `/profile` are now covered by AppShell's `inert`, leaving `/` and `/login` — the bead stays open:

```bash
bd update onlooker-zq1 --append-notes "Narrowed by onlooker-e5a: /settings and /profile now render AppShell, so they are covered by its inert. Remaining uncovered routes are / and /login. This does not preempt hoisting inert above the route table, which is still the fuller fix."
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: the `Panel` change is Task 1; Profile's shell, Panel rebuild, dropped `<nav>` and `Button` are Task 2; Settings' shell, four Panels with icons, dropped `ProfileOverview` and corrected comment are Task 3. The accessibility effect is recorded in Task 3 Step 8 as a note on `onlooker-zq1` rather than a code change, which matches the spec's claim that this narrows rather than closes it. The spec's testing section named four items; three are covered by the new test file and the fourth (`reveal-across-the-app.test.tsx`) is a check in Task 3 Step 6.

**Placeholder scan.** No TBDs. Every code step carries the actual code. The one conditional instruction — "if `FormLink` is now unused, remove it from the import" — is a mechanical check with a determinate answer, not a deferred decision.

**Type consistency.** `variant?: "notice" | "danger"` is defined in Task 1 and used with those exact values in Tasks 2 and 3. `renderAppAt` is defined in Task 2 and reused in Task 3. `Row` is defined locally in the Task 2 `ProfilePage` rewrite and deleted from `SettingsPage` in Task 3 — two components with the same name in different files, which is why Task 3 says to delete rather than import it.

**One thing this review changed.** Task 2 originally had Step 3 write `ProfilePage` with its own `AppShell` wrapper and Step 4 revert it in favor of route-level wrapping. Writing code in order to delete it two steps later is a plan defect however it is justified, so Step 3 now produces a plain page and Step 4 does the wrapping, matching how `/lessons` and `/machines` are already routed.

**One risk the plan cannot fully resolve in advance.** Task 3 Step 6 asks the implementer to check `reveal-across-the-app.test.tsx`, which references `/settings` twice. Whether those references assert something that depends on `/settings` lacking a shell can only be settled by reading the failure if it comes. The instruction is deliberately to update such an assertion rather than delete it — a test that breaks because behavior intentionally changed still has to keep testing something.
