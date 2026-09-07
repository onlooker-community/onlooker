# Inert Coverage and the Deferred Announcement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the page behind an open token reveal unreachable on every route, and stop the revoke announcement being silently swallowed when it lands while that reveal is open.

**Architecture:** `inert` moves off `AppShell` and onto a new `InertWhileRevealed` wrapper around `<Routes>` in `App.tsx`, so it covers the six routes `AppShell` never wrapped. `RevealHost` already portals the dialog to `document.body`, so the dialog stays outside the inert subtree by construction. Separately, `MachinesPage` parks a revoke announcement in a ref while a reveal is open and flushes it into state after dismissal, so the text arrives as a mutation while the region is live.

**Tech Stack:** React 18.3.1, react-router-dom 6.28, TypeScript, Vitest 4 + jsdom 24, React Testing Library 15, biome.

**Spec:** `docs/superpowers/specs/2026-09-07-inert-coverage-and-deferred-announcement-design.md`

**Beads:** `onlooker-zq1` (Task 1), `onlooker-5o4` (Tasks 2–3). **Branch:** `fix/inert-covers-every-route`.

## Global Constraints

- **Edit tracked files with `Edit`/`Write`, never with `sed`/heredocs.** The `lineage` and `inspector` plugins hook `PostToolUse` on the file tools only; a shell edit moves the same bytes invisibly and `/lineage` then answers "no record" for a line that was demonstrably written. See the repo `CLAUDE.md`.
- **`inert` must be written as `""`, never a boolean.** React 18.3.1 renders `inert=""` and silently drops `inert={true}`, so `inert={Boolean(revealed)}` looks correct and does nothing. This was measured, not assumed — see the comment at `AppShell.tsx:60-64`.
- **American English** in all comments and commit messages.
- **Commits go through the `/commit` skill**, every time, including small ones.
- **Do not push or open a PR** until Task 3 completes.
- Test command from `apps/web`: `pnpm test`. Single file: `pnpm vitest run src/__tests__/<file>`.
- Lint: `pnpm lint` (biome). Typecheck: `pnpm typecheck`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/web/src/reveal.tsx` | Owns the revealed token, the portal host, and now the inert wrapper | Add `InertWhileRevealed`; receive the `declare module "react"` shim |
| `apps/web/src/App.tsx` | Route table | Wrap `<Routes>` in `<InertWhileRevealed>` |
| `apps/web/src/components/AppShell.tsx` | Chrome around authenticated routes | Remove `inert` and the typing shim |
| `apps/web/src/pages/MachinesPage.tsx` | Mint / list / revoke | Park and flush the revoke announcement |
| `apps/web/src/__tests__/reveal.test.tsx` | The reveal module in isolation | Receives the two relocated `inert` tests |
| `apps/web/src/__tests__/app-shell.test.tsx` | AppShell in isolation | Delete the now-false `inert` describe block |
| `apps/web/src/__tests__/reveal-across-the-app.test.tsx` | The reveal against the real route table | Add the non-shell-route coverage test |
| `apps/web/src/__tests__/machines-page.test.tsx` | MachinesPage behavior | Add the deferral tests |
| `docs/superpowers/specs/2026-08-29-machines-reveal-and-a11y-design.md` | The originating spec | Add an amendment |

---

## Task 1: Hoist `inert` to cover every route

Closes `onlooker-zq1`.

**Files:**
- Modify: `apps/web/src/reveal.tsx` (add export at end of file)
- Modify: `apps/web/src/App.tsx:57-128` (wrap `<Routes>`), import at `:18`
- Modify: `apps/web/src/components/AppShell.tsx:9-16` (delete shim), `:67` (delete `inert`), `:45` (narrow the destructure)
- Test: `apps/web/src/__tests__/reveal-across-the-app.test.tsx`, `apps/web/src/__tests__/reveal.test.tsx`, `apps/web/src/__tests__/app-shell.test.tsx`

**Interfaces:**
- Consumes: `useReveal(): RevealValue` from `reveal.tsx`, already exported.
- Produces: `InertWhileRevealed({ children }: { children: ReactNode })` — a named export from `apps/web/src/reveal.tsx`. Renders a single `<div>` carrying `inert=""` while a reveal is open. Task 2 does not use it.

- [ ] **Step 1: Write the failing test for non-shell-route coverage**

In `apps/web/src/__tests__/reveal-across-the-app.test.tsx`, extend the existing `Elsewhere` helper (currently at `:107-115`) with a second destination, replacing the component body:

```tsx
function Elsewhere() {
	const navigate = useNavigate();
	return (
		<>
			<button type="button" onClick={() => navigate("/settings")}>
				back to settings
			</button>
			{/*
			  A route that does not render AppShell, which is where `inert` used
			  to live. HomePage is public, so RequireAuth does not redirect and
			  the reveal is judged on this route rather than on /login's.
			*/}
			<button type="button" onClick={() => navigate("/")}>
				out to the home page
			</button>
		</>
	);
}
```

Then add this test inside the existing `describe("a revealed token across the app", ...)` block:

```tsx
	// onlooker-zq1. The reveal survives a route change by design, so it can
	// follow a person onto a route that renders no AppShell - and `inert` used
	// to live on AppShell, so those routes had nothing behind the dialog but
	// `aria-modal`, which is advisory. This fails against the old placement.
	it("keeps the page inert after following the reveal off the shell", async () => {
		const { container } = await renderApp("/machines");
		await mintFromMachinesPage();

		fireEvent.click(screen.getByRole("button", { name: /out to the home page/i }));

		// Really on HomePage: AppShell is gone, so its nav and its copy of the
		// user's name are gone with it.
		expect(
			await screen.findByRole("heading", { name: /onlooker/i }),
		).toBeTruthy();
		expect(screen.queryByLabelText(/machine name/i)).toBeNull();
		// The reveal came along, which is the precondition that makes the rest
		// of this test meaningful rather than vacuous.
		expect(screen.getByRole("dialog")).toBeTruthy();

		// The wrapper is App's first rendered element - ErrorBoundary and
		// RevealProvider emit no DOM of their own.
		const wrapper = container.firstElementChild as HTMLElement;
		expect(wrapper.hasAttribute("inert")).toBe(true);
	});
```

- [ ] **Step 2: Run the test and verify it fails**

Run from `apps/web`:

```bash
pnpm vitest run src/__tests__/reveal-across-the-app.test.tsx -t "keeps the page inert"
```

Expected: FAIL on the final assertion — `expected false to be true`. The wrapper does not exist yet, so `container.firstElementChild` is whatever App renders first and it carries no `inert`.

If it fails on an earlier assertion instead, the navigation or the reveal is broken and the fix below will not address it — stop and diagnose before continuing.

- [ ] **Step 3: Add `InertWhileRevealed` to `reveal.tsx`**

Append to `apps/web/src/reveal.tsx`, after `RevealHost`:

```tsx
declare module "react" {
	interface HTMLAttributes<T> {
		// React 18 has no typing for `inert`; React 19 adds it. Declared here
		// rather than cast at the use site so there is one place to delete when
		// this workspace moves to 19.
		inert?: "";
	}
}

/**
 * Marks everything behind an open reveal unreachable, on every route.
 *
 * This wraps `<Routes>` rather than living on `AppShell`, which is where it
 * started. `AppShell` covers only the authenticated routes, so the six that do
 * not render it - `/`, `/login`, `/signup`, `/forgot-password`,
 * `/reset-password/:token`, `/verify-email/:token` - and the 404 had nothing
 * behind the dialog but `aria-modal`. That is advisory: a screen reader's
 * virtual cursor browses straight through it into the page underneath. The
 * reveal deliberately survives route changes, so it can reach every one of
 * those routes. That was `onlooker-zq1`.
 *
 * Safe only because `RevealHost` portals into `document.body`, which puts the
 * dialog outside `<Routes>` entirely - marking this subtree inert cannot
 * disable the dialog it exists to protect. Moving that portal back into the
 * tree breaks this silently; `reveal.test.tsx` pins it.
 *
 * `inert` rather than `aria-hidden`, because `inert` removes focusability too
 * and the two would otherwise need to be kept in step by hand.
 */
export function InertWhileRevealed({ children }: { children: ReactNode }) {
	const { revealed } = useReveal();
	return (
		<div
			// Written as a string, not a boolean. React 18.3.1 renders `inert=""`
			// and silently drops `inert={true}` - so `inert={Boolean(revealed)}`
			// would leave this looking correct and doing nothing. Measured, not
			// assumed.
			inert={revealed ? "" : undefined}
		>
			{children}
		</div>
	);
}
```

- [ ] **Step 4: Wrap `<Routes>` in `App.tsx`**

Change the import at `apps/web/src/App.tsx:18` from:

```tsx
import { RevealHost, RevealProvider } from "./reveal";
```

to:

```tsx
import { InertWhileRevealed, RevealHost, RevealProvider } from "./reveal";
```

Then wrap the route table. `<Routes>` opens at `:57` and closes at `:127`, with `<RevealHost />` on `:128`; put `<InertWhileRevealed>` immediately inside `<RevealProvider>` and close it immediately after `</Routes>`, leaving `<RevealHost />` outside:

```tsx
			<RevealProvider>
				<InertWhileRevealed>
					<Routes>
						{/* ...every existing <Route> unchanged... */}
					</Routes>
				</InertWhileRevealed>
				{/*
				  Outside the wrapper above, and portaled to document.body
				  besides. Both are required: a dialog inside the inert subtree
				  would be disabled by the very attribute meant to protect it.
				*/}
				<RevealHost />
			</RevealProvider>
```

Do not reindent the `<Route>` elements in the same commit if it makes the diff unreadable — but if your formatter reindents them, let it; `pnpm lint` is the arbiter.

- [ ] **Step 5: Remove `inert` from `AppShell`**

In `apps/web/src/components/AppShell.tsx`, delete the entire `declare module "react"` block at `:9-16` (it now lives in `reveal.tsx`), and delete the `inert` prop at `:67` together with the four comment lines above it, collapsing the wrapper div at `:62-68` to:

```tsx
	return (
		<div style={{ minHeight: "100vh", fontFamily: "var(--font-body)" }}>
```

The destructure at `:45` reads `const { revealed, dismiss } = useReveal();`. After this change `revealed` has no remaining reader in the file — only `dismiss`, in `handleLogout` — so biome will flag it. Narrow it to:

```tsx
	const { dismiss } = useReveal();
```

Do **not** touch `handleLogout`. Its `dismiss()` call and the comment above it stay exactly as they are: the comment argues the call is the only thing clearing the token on a browser that ignores `inert`, and that reasoning is unaffected by where `inert` lives.

- [ ] **Step 6: Run the new test and verify it passes**

```bash
pnpm vitest run src/__tests__/reveal-across-the-app.test.tsx
```

Expected: PASS, all tests in the file.

- [ ] **Step 7: Relocate the two `inert` tests off `AppShell`**

`app-shell.test.tsx:181-222` asserts `AppShell` takes `inert`, which is now false and will fail. The behavior did not disappear, so the tests move rather than die.

Delete the whole `describe("AppShell while a token is revealed", ...)` block from `apps/web/src/__tests__/app-shell.test.tsx` (`:181` to the closing `});` at `:222`), along with the `MACHINE` const and `Minter` helper at `:166-179` **if nothing else in that file uses them** — check with `grep -n "MACHINE\|Minter" src/__tests__/app-shell.test.tsx` before deleting, and drop any imports (`RevealProvider`, `RevealHost`, `useReveal`, `act`) left unused.

Add to `apps/web/src/__tests__/reveal.test.tsx`, after the `describe("reveal provider", ...)` block. `InertWhileRevealed` must be added to the existing import from `../reveal` at `:4`:

```tsx
describe("the inert wrapper", () => {
	// aria-modal is advisory: a screen reader's virtual cursor can still browse
	// into the page the focus trap exists to protect. `inert` is what actually
	// removes it, from the accessibility tree and from focus together.
	//
	// Moved here from app-shell.test.tsx when `inert` was hoisted off AppShell
	// so it would cover the routes AppShell does not render (onlooker-zq1).
	it("is inert while the reveal is open and not before", () => {
		const { container } = render(
			<RevealProvider>
				<InertWhileRevealed>
					<Driver />
				</InertWhileRevealed>
				<RevealHost />
			</RevealProvider>,
		);
		const wrapper = container.firstElementChild as HTMLElement;
		expect(wrapper.hasAttribute("inert")).toBe(false);
		act(() => {
			screen.getAllByText("mint")[0].click();
		});
		expect(wrapper.hasAttribute("inert")).toBe(true);
	});

	it("stops being inert once the reveal is dismissed", () => {
		const { container } = render(
			<RevealProvider>
				<InertWhileRevealed>
					<Driver />
				</InertWhileRevealed>
				<RevealHost />
			</RevealProvider>,
		);
		const wrapper = container.firstElementChild as HTMLElement;
		act(() => {
			screen.getAllByText("mint")[0].click();
		});
		act(() => {
			screen.getByRole("button", { name: /saved it/i }).click();
		});
		expect(wrapper.hasAttribute("inert")).toBe(false);
	});
});
```

- [ ] **Step 8: Update the stale comment in `reveal.test.tsx`**

The comment at `reveal.test.tsx:101-103` names the old design and a task number from a finished plan. Replace those three comment lines with:

```tsx
		// The portal is what lets the page take `inert` without inerting the
		// dialog too. If this ever renders inside the tree, InertWhileRevealed
		// breaks silently - the wrapper would inert its own dialog.
```

- [ ] **Step 9: Run the full web suite, lint, and typecheck**

```bash
pnpm test && pnpm lint && pnpm typecheck
```

Expected: all green. If `app-shell.test.tsx` fails, Step 7's deletion was incomplete. If `typecheck` reports `inert` is not a valid prop, the `declare module` block did not make it into `reveal.tsx` in Step 3.

- [ ] **Step 10: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add src/reveal.tsx src/App.tsx src/components/AppShell.tsx \
        src/__tests__/reveal.test.tsx src/__tests__/app-shell.test.tsx \
        src/__tests__/reveal-across-the-app.test.tsx
```

Message shape — `fix(web): ...`, subject ≤72 chars including a mood emoji, body explaining that `inert` covered only the routes `AppShell` wrapped and the reveal outlives those routes. Reference `Refs onlooker-zq1`.

---

## Task 2: Defer the revoke announcement

Closes the code half of `onlooker-5o4`; Task 3 closes the bead.

**Files:**
- Modify: `apps/web/src/pages/MachinesPage.tsx:56` (add ref), `:105-113` (park), plus a new effect
- Test: `apps/web/src/__tests__/machines-page.test.tsx`

**Interfaces:**
- Consumes: `useReveal()` — already imported and destructured at `MachinesPage.tsx:53` as `const { revealed, reveal } = useReveal();`. No signature changes.
- Produces: nothing other tasks consume. Entirely internal to `MachinesPage`.

- [ ] **Step 1: Write the failing test**

Add `act` to the `@testing-library/react` import at `machines-page.test.tsx:1-7`. Add a minted-machine fixture next to the others at `:28`:

```tsx
const MINTED = {
	id: "m9",
	name: "second laptop",
	token: `onlk_${"b".repeat(64)}`,
};
```

Then add this test:

```tsx
describe("MachinesPage when a revoke lands under an open reveal", () => {
	// onlooker-5o4. The status region lives inside the subtree that goes inert
	// while a reveal is open, so a write here is dropped from the accessibility
	// tree with no sign. jsdom does not implement `inert` and so cannot see
	// that half at all - what this pins is the half it can see, that we do not
	// write while the dialog is up and do write once it closes.
	it("holds the announcement until the reveal is dismissed", async () => {
		withMachines(USED);
		let settleRevoke: (value: unknown) => void = () => {};
		mocks.revokeMachine.mockReturnValue(
			new Promise((resolve) => {
				settleRevoke = resolve;
			}),
		);
		mocks.createMachine.mockResolvedValue(MINTED);

		await renderPage();

		// Revoke, and leave it in flight.
		fireEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));
		fireEvent.click(screen.getByRole("button", { name: /yes, revoke/i }));
		await waitFor(() => expect(mocks.revokeMachine).toHaveBeenCalled());

		// Mint on top of it. The guard at MachinesPage's `mint` does not prevent
		// this ordering - the revoke was already in flight when it ran.
		fireEvent.change(screen.getByLabelText(/machine name/i), {
			target: { value: "second laptop" },
		});
		fireEvent.click(screen.getByRole("button", { name: /mint token/i }));
		await screen.findByRole("dialog");

		// Let the revoke land underneath the open dialog.
		withMachines({ ...USED, revoked_at: "2026-09-07T00:00:00.000Z" });
		await act(async () => {
			settleRevoke({ success: true });
		});

		const status = document.querySelector('[role="status"]') as HTMLElement;
		expect(status.textContent).toBe("");

		fireEvent.click(screen.getByRole("button", { name: /saved it/i }));

		await waitFor(() =>
			expect(status.textContent).toBe("Revoked work laptop."),
		);
	});

	// The ordinary path has to keep working: with no dialog up there is nothing
	// to wait for, and deferring here would delay every announcement forever.
	it("announces immediately when no reveal is open", async () => {
		withMachines(USED);
		mocks.revokeMachine.mockResolvedValue({ success: true });

		await renderPage();

		fireEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));
		withMachines({ ...USED, revoked_at: "2026-09-07T00:00:00.000Z" });
		fireEvent.click(screen.getByRole("button", { name: /yes, revoke/i }));

		const status = document.querySelector('[role="status"]') as HTMLElement;
		await waitFor(() =>
			expect(status.textContent).toBe("Revoked work laptop."),
		);
	});
});
```

- [ ] **Step 2: Run the tests and verify the first fails**

```bash
pnpm vitest run src/__tests__/machines-page.test.tsx -t "when a revoke lands under an open reveal"
```

Expected: "holds the announcement until the reveal is dismissed" FAILS with `expected 'Revoked work laptop.' to be ''` — today the write happens immediately regardless of the dialog. "announces immediately when no reveal is open" should PASS already; it is the regression guard, not the driver.

- [ ] **Step 3: Add the pending ref**

In `apps/web/src/pages/MachinesPage.tsx`, after the `revokedName` state at `:56`:

```tsx
	const [revokedName, setRevokedName] = useState("");
	// Parked here rather than written straight to state when a reveal is open.
	// See the revoke handler and the flush effect below for why (onlooker-5o4).
	const pendingRevokedName = useRef<string | null>(null);
```

`useRef` is already imported — the file uses it for `rowRefs` and `statusRef`.

- [ ] **Step 4: Park the name instead of writing it**

In `revoke`, replace the single line `setRevokedName(machine.name);` (at `:112`, immediately after `await load();`) with:

```tsx
			// While a reveal is open this whole subtree is inert, and an inert
			// subtree is out of the accessibility tree - so this write would be
			// dropped with no sign at all. Park it for the effect below.
			//
			// role="status" is the politeness level that promises not to
			// interrupt, and the reveal is a credential shown exactly once and
			// unrecoverable if missed. Announcing over it would honor the letter
			// of the live region and violate its purpose, so this waits.
			if (revealed) {
				pendingRevokedName.current = machine.name;
			} else {
				setRevokedName(machine.name);
			}
```

Leave the focus line below it and its long comment untouched.

- [ ] **Step 5: Add the flush effect**

Add after the existing `useEffect(() => { void load(); }, [load]);` at `:71-73`:

```tsx
	// The flush has to be a mutation performed while the region is live.
	// Parking the text into state early and letting the subtree merely stop
	// being inert would announce nothing: a node re-entering the accessibility
	// tree carrying content it already had is not a change, and screen readers
	// announce changes. So the text must arrive after the dialog closes, which
	// is exactly what this does.
	//
	// Deliberately not carried across an unmount. If the person navigates away
	// while the reveal is up this page goes with it, and announcing "Revoked
	// work laptop." to someone now standing on /settings describes a screen
	// they have left.
	useEffect(() => {
		if (revealed) return;
		const pending = pendingRevokedName.current;
		if (pending === null) return;
		pendingRevokedName.current = null;
		setRevokedName(pending);
	}, [revealed]);
```

- [ ] **Step 6: Run the tests and verify both pass**

```bash
pnpm vitest run src/__tests__/machines-page.test.tsx
```

Expected: PASS, all tests in the file. The pre-existing revoke tests at `:236` and `:266` must still pass — if "revokes on confirmation and reloads the list" broke, Step 4 changed behavior on the no-reveal path, which it must not.

- [ ] **Step 7: Run the full suite, lint, and typecheck**

```bash
pnpm test && pnpm lint && pnpm typecheck
```

Expected: all green.

- [ ] **Step 8: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add src/pages/MachinesPage.tsx src/__tests__/machines-page.test.tsx
```

Message shape — `fix(web): ...`, body explaining that an inert subtree is out of the accessibility tree so the announcement was dropped, and that deferring preserves both the information and `role="status"`'s politeness. Reference `Refs onlooker-5o4`.

---

## Task 3: Verify in a real browser, amend the spec, close the beads

The premise of `onlooker-5o4` — that `inert` removes the region from the accessibility tree — cannot be verified in this suite, because jsdom does not implement `inert`. This task supplies the evidence the suite structurally cannot.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-29-machines-reveal-and-a11y-design.md`
- No source changes.

- [ ] **Step 1: Start the dev server**

From `apps/web`:

```bash
pnpm dev
```

Expected: Vite serves on `http://localhost:5173`.

- [ ] **Step 2: Confirm `inert` is applied on a non-shell route**

Drive a real Chrome via the `claude-in-chrome` tools. Sign in, mint a token on `/machines` to open the reveal, then navigate to `/` without dismissing it (the browser's own Back, or the address bar — the nav is inert by design).

With the dialog still open, evaluate in the page:

```js
document.querySelector("#root > div").hasAttribute("inert")
```

Expected: `true`. Record the result. This is Task 1's claim confirmed in an engine that actually implements the attribute — jsdom's pass proves the attribute is written, not that it does anything.

- [ ] **Step 3: Confirm the premise of onlooker-5o4**

Back on `/machines` with a reveal open, evaluate:

```js
const status = document.querySelector('[role="status"]');
({
  text: status.textContent,
  hiddenFromA11y: status.closest("[inert]") !== null,
});
```

Expected: `text` is `""` (Task 2 parked it) and `hiddenFromA11y` is `true` — the region does sit inside an inert subtree, which is what made the old immediate write unobservable.

For the stronger check, open Chrome DevTools' Accessibility pane on that node, or use the CDP accessibility tree, and confirm the region is not present in it while inert. Record what you actually observe, including if it disagrees with the bead — a disagreement is a finding, not a failure.

- [ ] **Step 4: Confirm the announcement arrives after dismissal**

Dismiss the dialog with "I've saved it", then evaluate:

```js
const status = document.querySelector('[role="status"]');
({ text: status.textContent, stillInert: status.closest("[inert]") !== null });
```

Expected: `text` is `"Revoked <name>."` and `stillInert` is `false`. The text arriving *after* the subtree went live is the whole mechanism.

- [ ] **Step 5: Amend the originating spec**

Add to the end of `docs/superpowers/specs/2026-08-29-machines-reveal-and-a11y-design.md`:

```markdown
---

## Amendment, 2026-09-07 — Sections 3 and 4 were not independent

This document's implementation order calls Section 4 "Independent of 1–3."
That was wrong, and `onlooker-5o4` is the consequence.

Section 3 puts `inert` on `AppShell`. Section 4 puts a `role="status"` region
inside `AppShell`. An inert subtree is removed from the accessibility tree, so
a revoke that settled while a reveal was open wrote its announcement into a
region no screen reader could observe, and the announcement was dropped with
no sign.

Section 3's placement was also narrower than it read: `AppShell` wraps only the
authenticated routes, and the reveal deliberately survives route changes, so
six routes had nothing behind the dialog but advisory `aria-modal`. That was
`onlooker-zq1`.

Both are corrected in
`2026-09-07-inert-coverage-and-deferred-announcement-design.md`. `inert` now
lives on a wrapper around every route, and the announcement waits for
dismissal rather than being written into an inert region.

The "Independent of 1–3" claim is left in place above rather than edited. It
was the reasoning at the time, and a spec that quietly rewrites its own history
teaches the next reader nothing.
```

- [ ] **Step 6: Commit the amendment**

Use the `/commit` skill. Stage exactly:

```bash
git add docs/superpowers/specs/2026-08-29-machines-reveal-and-a11y-design.md
```

Message shape — `docs(web): ...`, body naming the interaction the original spec's independence claim missed.

- [ ] **Step 7: Record the browser findings on the beads and close them**

```bash
bd update onlooker-5o4 --notes "<what the browser actually showed in Steps 2-4>"
bd close onlooker-zq1
bd close onlooker-5o4
```

Close `onlooker-5o4` on the browser observation, not on the green suite — per the spec's Consequences section. If Step 3 disagreed with the bead's premise, do **not** close it; report the disagreement instead.

- [ ] **Step 8: Stop the dev server and open the PR**

Kill the `pnpm dev` process. Then use the `/pr` skill.

The PR body must state plainly that `onlooker-5o4` is verified by browser observation rather than by CI, and why a test could not do it: jsdom does not implement `inert`, so a test of that premise would pass while reporting the opposite of the browser.

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: Section 1 (hoist) → Task 1; the `#root` rejection → Task 1 Step 3's rationale and the plan's choice of a wrapper node; Section 2 (defer) → Task 2; Section 2's "local to MachinesPage, lost on unmount" → Task 2 Step 5's second comment paragraph; "why this is not generalized" → no task, correctly, since it is a decision not to act; Section 3 (testing) → Task 1 Steps 1–2, Task 2 Steps 1–2, and Task 3 for the part jsdom cannot reach; Consequences → Task 3 Steps 5–7.

**Placeholders.** None. Every code step carries the literal code. Task 3 Step 7's `bd update --notes` is intentionally written as a placeholder for an *observation*, which cannot be known before the observation is made — the step says what to record.

**Type consistency.** `InertWhileRevealed` is spelled identically in Task 1 Steps 3, 4, 7, and 8 and in the File Structure table. `pendingRevokedName` is spelled identically in Task 2 Steps 3, 4, and 5. `revealed` comes from the existing destructure at `MachinesPage.tsx:53` and is not redeclared. `Driver` in Task 1 Step 7 is the existing helper in `reveal.test.tsx:12-25`, not a new one — it exposes both a "mint" button and the dialog's own dismiss, which is what both relocated tests need.
