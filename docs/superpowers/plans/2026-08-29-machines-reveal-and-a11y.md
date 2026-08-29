# Machines Reveal and Accessibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move a revealed machine token somewhere routine navigation cannot destroy it, make the background unreachable while it is shown, and close the focus and semantics gaps in the revoke flow.

**Architecture:** A `RevealProvider` mounted below `AuthProvider` and above `<Routes>` owns the revealed machine; `TokenReveal` renders from it through a portal to `document.body`. That single placement fixes two beads and makes a third possible — with the dialog out of `<main>`, `AppShell` can take `inert`. Two smaller changes to `MachinesPage` restore focus after a revoke and give the list its boundaries back.

**Tech Stack:** React 18.3.1, react-router-dom (`BrowserRouter`), TypeScript, Vitest + Testing Library + jsdom, Biome.

## Global Constraints

- **`inert` must be written as `inert={open ? "" : undefined}`, never `inert={open}`.** Measured on React 18.3.1: the string form renders the attribute, the **boolean form is silently dropped**. `inert={isOpen}` is the natural thing to write, produces no attribute, and leaves the accessibility fix looking implemented while doing nothing.
- **The revealed token is held in memory only.** Never `sessionStorage`, never `localStorage`, never a URL. A reload losing it is expected and already covered by `beforeunload`.
- **Do not reattempt a `popstate` history guard.** One was written and reverted during `onlooker-k7w` for leaving orphan history entries that broke Back for the whole session. `useBlocker` is unavailable — `main.tsx` mounts `BrowserRouter`, not a data router.
- **`@testing-library/jest-dom` is NOT set up in this workspace.** `toHaveTextContent`, `toBeInTheDocument` and friends do not exist. Assert with plain DOM: `expect(el.textContent).toBe(...)`, `.toMatch(...)`, `expect(el).toBeTruthy()`. See `token-reveal.test.tsx:38` for the house style. Do not add the dependency to make a matcher work.
- **American English** in every comment, identifier and user-facing string.
- Commits: `<type>(<scope>): <subject> :emoji:`, **subject ≤72 characters including the emoji**, body wrapped at 80, why-focused, ending with a `Refs:` line naming the beads that task closes.
- Never `git add -A` or `git add .` — stage intentionally.
- Gates from the repo root before every commit: `pnpm test`, `pnpm typecheck`, `pnpm lint`. All three green. `pnpm lint` currently reports 9 pre-existing warnings in `@onlooker/web` and `@onlooker/auth-react` that are not yours.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `apps/web/src/reveal.tsx` | The provider, its hook, and the portal that renders the dialog. One file because the three are useless apart. |
| `apps/web/src/__tests__/reveal.test.tsx` | Lifetime: what preserves the reveal and what ends it. |

**Modified:**

| File | Change |
|---|---|
| `apps/web/src/App.tsx` | Wrap `<Routes>` in `RevealProvider`; render `<RevealHost />`. |
| `apps/web/src/pages/MachinesPage.tsx` | Set the reveal through the hook instead of local state; row focus after revoke; `role="status"`; list semantics. |
| `apps/web/src/components/AppShell.tsx` | Take `inert` while a reveal is open. |
| `apps/web/src/components/TokenReveal.tsx` | Unchanged behavior; no longer positions itself as a page child. |
| `apps/web/src/__tests__/machines-page.test.tsx` | Wrap renders in the provider; new focus, status and list tests. |
| `apps/web/src/__tests__/app-shell.test.tsx` | Assert `inert` appears and clears. |

---

## Notes for whoever builds this

**`inert={isOpen}` will pass review and do nothing.** See Global Constraints. If you write it the natural way, the attribute never renders and Task 3's test is the only thing standing between that and a shipped no-op. Do not weaken that test to make it pass.

**The provider's placement depends on something unrelated.** `App` wraps `<Routes>` in an `ErrorBoundary` using `resetKey={location.pathname}` rather than `key=`. With `key=`, the subtree remounts on every navigation, the provider goes with it, and `onlooker-1bz` returns with every test green except one. That was verified on 2026-08-29 at `App.tsx:31`. If you find `key=` there, stop and say so — the plan is built on `resetKey`.

**Existing tests render `<MachinesPage />` bare.** Once the page reads from the provider they need wrapping. Wrap them; do not add a fallback to local state so they keep passing. A component that works without its provider is a component whose provider can be silently removed.

---

### Task 1: The provider

**Files:**
- Create: `apps/web/src/reveal.tsx`, `apps/web/src/__tests__/reveal.test.tsx`

**Interfaces:**
- Produces: `MintedMachine` (re-exported from `./api/machinesApi`, which already owns it), `RevealProvider({ children }: { children: ReactNode })`, `useReveal(): { revealed: MintedMachine | null; reveal: (m: MintedMachine) => void; dismiss: () => void }`, `RevealHost()`. Tasks 2–4 consume these.

- [ ] **Step 1: Write the failing test**

`apps/web/src/__tests__/reveal.test.tsx`:

```tsx
import { render, screen, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RevealProvider, RevealHost, useReveal } from "../reveal";

const MACHINE = { id: "m1", name: "work laptop", token: `onlk_${"a".repeat(64)}` };

/** Drives the hook from outside the dialog, the way MachinesPage will. */
function Driver() {
	const { reveal, dismiss, revealed } = useReveal();
	return (
		<div>
			<button type="button" onClick={() => reveal(MACHINE)}>mint</button>
			<button type="button" onClick={dismiss}>drop</button>
			<span data-testid="state">{revealed ? "open" : "closed"}</span>
		</div>
	);
}

describe("reveal provider", () => {
	it("starts with nothing revealed", () => {
		render(<RevealProvider><Driver /></RevealProvider>);
		expect(screen.getByTestId("state").textContent).toBe("closed");
	});

	it("holds a minted machine until dismissed", () => {
		render(<RevealProvider><Driver /></RevealProvider>);
		act(() => { screen.getByText("mint").click(); });
		expect(screen.getByTestId("state").textContent).toBe("open");
		act(() => { screen.getByText("drop").click(); });
		expect(screen.getByTestId("state").textContent).toBe("closed");
	});

	// The whole point of the provider. A component that unmounts and remounts -
	// which is what a route change does to a page - must not take the token
	// with it, because the provider is above the thing being remounted.
	it("survives a child unmounting and remounting", () => {
		function Swapper({ show }: { show: boolean }) {
			return <RevealProvider>{show ? <Driver /> : <span>gone</span>}<Driver /></RevealProvider>;
		}
		const { rerender } = render(<Swapper show={true} />);
		act(() => { screen.getAllByText("mint")[0].click(); });
		rerender(<Swapper show={false} />);
		expect(screen.getByTestId("state").textContent).toBe("open");
	});

	// Using the hook outside its provider is a wiring mistake that would
	// otherwise show up as a token that silently never appears.
	it("refuses to be used outside its provider", () => {
		expect(() => render(<Driver />)).toThrow(/RevealProvider/);
	});

	it("renders nothing when there is nothing to reveal", () => {
		render(<RevealProvider><RevealHost /></RevealProvider>);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("renders the dialog into document.body, not into its parent", () => {
		const { container } = render(
			<RevealProvider><Driver /><RevealHost /></RevealProvider>,
		);
		act(() => { screen.getAllByText("mint")[0].click(); });
		const dialog = screen.getByRole("dialog");
		expect(dialog).not.toBeNull();
		// The portal is what lets AppShell take `inert` without inerting the
		// dialog too. If this ever renders inside the tree, Task 3 breaks
		// silently - the shell would inert its own dialog.
		expect(container.contains(dialog)).toBe(false);
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/reveal.test.tsx`
Expected: FAIL — `Failed to resolve import "../reveal"`.

- [ ] **Step 3: Write the implementation**

`apps/web/src/reveal.tsx`:

```tsx
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { MintedMachine } from "./api/machinesApi";
import TokenReveal from "./components/TokenReveal";

// Re-exported, not redeclared. `api/machinesApi.ts` already owns this shape as
// `createMachine`'s return type, and both TokenReveal and MachinesPage import
// it from there. A structurally-identical second copy would typecheck happily
// and drift the moment the API grows a field.
export type { MintedMachine } from "./api/machinesApi";

interface RevealValue {
	revealed: MintedMachine | null;
	reveal: (machine: MintedMachine) => void;
	dismiss: () => void;
}

const RevealContext = createContext<RevealValue | null>(null);

/**
 * Holds the one machine token that has been revealed but not yet dismissed.
 *
 * Mounted below `AuthProvider` and above `<Routes>`, deliberately. Below, so a
 * logout can clear it; above, so neither a route change nor `RequireAuth`'s
 * redirect on session expiry can unmount it. The token was previously held in
 * `MachinesPage`, which meant any of those destroyed it - a credential shown
 * exactly once, recoverable only by revoking the machine and minting another.
 *
 * In memory only. A reload still loses it, and `beforeunload` warns first;
 * writing a live credential to storage to avoid a warning the user has already
 * seen would be a worse trade than the bug this fixes.
 */
export function RevealProvider({ children }: { children: ReactNode }) {
	const [revealed, setRevealed] = useState<MintedMachine | null>(null);
	const value = useMemo<RevealValue>(
		() => ({
			revealed,
			reveal: setRevealed,
			dismiss: () => setRevealed(null),
		}),
		[revealed],
	);
	return <RevealContext.Provider value={value}>{children}</RevealContext.Provider>;
}

export function useReveal(): RevealValue {
	const value = useContext(RevealContext);
	// Throwing rather than returning a no-op: a missing provider would
	// otherwise present as a mint that succeeds and shows nothing, which is
	// indistinguishable from the bug this file exists to fix.
	if (!value) throw new Error("useReveal must be used inside a RevealProvider");
	return value;
}

/**
 * Renders the dialog, if there is one, into `document.body`.
 *
 * The portal is not cosmetic. `TokenReveal` used to be a descendant of
 * `AppShell`'s `<main>`, which is why the shell could not simply be marked
 * `inert` while the dialog was open - it would have inerted the dialog too.
 */
export function RevealHost() {
	const { revealed, dismiss } = useReveal();
	if (!revealed) return null;
	return createPortal(
		<TokenReveal machine={revealed} onDismiss={dismiss} />,
		document.body,
	);
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/reveal.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the full gates, then commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add apps/web/src/reveal.tsx apps/web/src/__tests__/reveal.test.tsx
```

Subject: `feat(web): give a revealed token somewhere to live :shield:`
Body: why the token cannot stay in the page, and why the hook throws rather than returning a no-op.

---

### Task 2: Wire it in, and end it on logout

**Files:**
- Modify: `apps/web/src/App.tsx`, `apps/web/src/pages/MachinesPage.tsx`, `apps/web/src/__tests__/machines-page.test.tsx`
- Test: `apps/web/src/__tests__/reveal.test.tsx` (add the logout case)

**Interfaces:**
- Consumes: `RevealProvider`, `RevealHost`, `useReveal`, `MintedMachine` from `../reveal`.
- Produces: `MachinesPage` no longer owns reveal state.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/__tests__/reveal.test.tsx`:

```tsx
// Logout is the one thing that must end a reveal and does NOT come free from
// the provider's placement: AuthProvider sits above it, so nothing propagates
// down. A credential left on screen after a deliberate sign-out is not
// acceptable, and this is the only test that would notice.
it("clears the reveal when the user is no longer signed in", () => {
	function Harness({ signedIn }: { signedIn: boolean }) {
		return (
			<RevealProvider signedIn={signedIn}>
				<Driver />
			</RevealProvider>
		);
	}
	const { rerender } = render(<Harness signedIn={true} />);
	act(() => { screen.getByText("mint").click(); });
	expect(screen.getByTestId("state").textContent).toBe("open");
	rerender(<Harness signedIn={false} />);
	expect(screen.getByTestId("state").textContent).toBe("closed");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/reveal.test.tsx`
Expected: FAIL — `RevealProvider` takes no `signedIn` prop, so the reveal stays open.

- [ ] **Step 3: Teach the provider about sign-out**

In `apps/web/src/reveal.tsx`, change the signature and add the effect:

```tsx
export function RevealProvider({
	children,
	signedIn = true,
}: {
	children: ReactNode;
	/**
	 * Passed in rather than read from `useAuth` so the provider can be tested
	 * without an auth context, and so the dependency points one way.
	 */
	signedIn?: boolean;
}) {
	const [revealed, setRevealed] = useState<MintedMachine | null>(null);

	// AuthProvider is above this one, so a sign-out does not reach the state
	// below it on its own. Without this, a deliberate logout would leave a live
	// credential on screen.
	useEffect(() => {
		if (!signedIn) setRevealed(null);
	}, [signedIn]);

	const value = useMemo<RevealValue>(
		() => ({ revealed, reveal: setRevealed, dismiss: () => setRevealed(null) }),
		[revealed],
	);
	return <RevealContext.Provider value={value}>{children}</RevealContext.Provider>;
}
```

Add `useEffect` to the React import.

- [ ] **Step 4: Mount it in `App.tsx`**

Wrap the existing `<Routes>` — which currently sits inside `<ErrorBoundary>` — and render the host beside it:

```tsx
<RevealProvider signedIn={Boolean(user)}>
	<Routes>
		{/* unchanged */}
	</Routes>
	<RevealHost />
</RevealProvider>
```

Read `user` from `auth.useAuth()` in `App`. That hook comes from
`createReactAuth` and works anywhere inside `AuthProvider`; `main.tsx` mounts
`BrowserRouter > AuthProvider > App`, so `App` qualifies. Import
`RevealProvider` and `RevealHost` from `./reveal`.

**Leave `resetKey={location.pathname}` on the `ErrorBoundary` exactly as it is.** Changing it to `key=` remounts this provider on every navigation and restores `onlooker-1bz`.

- [ ] **Step 5: Move `MachinesPage` off local state**

Replace `const [revealed, setRevealed] = useState<MintedMachine | null>(null);` with:

```tsx
const { revealed, reveal } = useReveal();
```

At the mint site, `setRevealed(created)` becomes `reveal(created)`. Delete the `{revealed ? <TokenReveal .../> : null}` block near the end of the page — `RevealHost` renders it now. Keep the `revealed` read in the mint guard (`if (!trimmed || minting || revealed) return;`) so a second mint cannot start while one is displayed. Remove the now-unused `TokenReveal` import.

- [ ] **Step 6: Wrap the existing page tests**

`machines-page.test.tsx` renders `<MachinesPage />` bare. Wrap each render:

```tsx
render(
	<RevealProvider>
		<MachinesPage />
		<RevealHost />
	</RevealProvider>,
);
```

Do **not** give `useReveal` a fallback so the bare renders keep working. A component that works without its provider is one whose provider can be deleted without a test noticing.

- [ ] **Step 7: Run everything, then commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS. Report the `@onlooker/web` test count before and after.

Subject: `fix(web): stop navigation from eating a revealed token :link:`
Body: why the provider sits where it does, and why logout needed wiring by hand.
Include `Refs: onlooker-kxe, onlooker-1bz`.

---

### Task 3: Make the background unreachable

**Files:**
- Modify: `apps/web/src/components/AppShell.tsx`, `apps/web/src/__tests__/app-shell.test.tsx`

**Interfaces:**
- Consumes: `useReveal` from `../reveal`.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/__tests__/app-shell.test.tsx`:

```tsx
import { RevealProvider, RevealHost, useReveal } from "../reveal";

const MACHINE = { id: "m1", name: "work laptop", token: `onlk_${"a".repeat(64)}` };

function Minter() {
	const { reveal } = useReveal();
	return <button type="button" onClick={() => reveal(MACHINE)}>mint</button>;
}

describe("AppShell while a token is revealed", () => {
	// aria-modal is advisory: a screen reader's virtual cursor can still browse
	// into the nav the focus trap exists to protect. `inert` is what actually
	// removes it, from the accessibility tree and from focus together.
	it("is inert while the reveal is open and not before", () => {
		const { container } = render(
			<MemoryRouter>
				<RevealProvider>
					<AppShell><Minter /></AppShell>
					<RevealHost />
				</RevealProvider>
			</MemoryRouter>,
		);
		const shell = container.firstElementChild as HTMLElement;
		expect(shell.hasAttribute("inert")).toBe(false);
		act(() => { screen.getByText("mint").click(); });
		expect(shell.hasAttribute("inert")).toBe(true);
	});

	it("stops being inert once the reveal is dismissed", () => {
		const { container } = render(
			<MemoryRouter>
				<RevealProvider>
					<AppShell><Minter /></AppShell>
					<RevealHost />
				</RevealProvider>
			</MemoryRouter>,
		);
		const shell = container.firstElementChild as HTMLElement;
		act(() => { screen.getByText("mint").click(); });
		act(() => { screen.getByRole("button", { name: /saved it/i }).click(); });
		expect(shell.hasAttribute("inert")).toBe(false);
	});
});
```

If the dismiss control's accessible name does not match that regex, read `TokenReveal.tsx` and use its actual label rather than loosening the query to something that matches any button.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/app-shell.test.tsx`
Expected: FAIL — `expected false to be true`, because nothing sets the attribute yet.

- [ ] **Step 3: Write the implementation**

In `apps/web/src/components/AppShell.tsx`, read the reveal and set the attribute on the outermost `<div>`:

```tsx
const { revealed } = useReveal();
```

```tsx
<div
	// Written as a string, not a boolean. React 18.3.1 renders `inert=""` and
	// silently drops `inert={true}` - so `inert={Boolean(revealed)}` would
	// leave this looking correct and doing nothing. Measured, not assumed.
	inert={revealed ? "" : undefined}
	style={{ minHeight: "100vh", fontFamily: "var(--font-body)" }}
>
```

TypeScript's JSX types for React 18 do not know `inert`. Add it once, next to the component:

```tsx
declare module "react" {
	interface HTMLAttributes<T> {
		// React 18 has no typing for `inert`; React 19 adds it. Declared here
		// rather than cast at the use site so there is one place to delete when
		// this workspace moves to 19.
		inert?: "";
	}
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/app-shell.test.tsx`
Expected: PASS.

- [ ] **Step 5: Prove the test can fail the way it must**

Change `inert={revealed ? "" : undefined}` to `inert={Boolean(revealed)}` — the natural, wrong form. Confirm the first test fails. Restore.

**Report whether it failed.** If it passes with the boolean form, the assertion is not checking the rendered attribute and needs fixing before this task is done. This step exists because the boolean form is what someone will write during a future refactor.

- [ ] **Step 6: Run the full gates, then commit**

Subject: `fix(web): put the app shell out of reach behind the dialog :lock:`
Body: why `inert` rather than `aria-hidden`, and why the string form is load-bearing.
Include `Refs: onlooker-aky`.

---

### Task 4: Focus and announcement after a revoke

**Files:**
- Modify: `apps/web/src/pages/MachinesPage.tsx`, `apps/web/src/__tests__/machines-page.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// A revoked machine keeps its row, but the ConfirmAction inside it returns
// null once revoked_at is set - so the confirm button unmounts while holding
// focus and the next Tab restarts at the top of the document. The row is a
// stable target precisely because revoked rows persist.
it("moves focus to the row after a revoke instead of dropping it", async () => {
	renderPage();
	fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
	fireEvent.click(screen.getByRole("button", { name: "Yes, revoke" }));
	await waitFor(() => {
		expect(document.activeElement).not.toBe(document.body);
	});
	expect((document.activeElement as HTMLElement).dataset.machineRow).toBe("m1");
});

// The live region is rendered on every pass, empty until it has something to
// say. A region mounted together with its message is the shape screen readers
// do not reliably announce.
it("keeps a status region mounted before it has anything to announce", () => {
	renderPage();
	expect(screen.getByRole("status")).toBeTruthy();
	expect(screen.getByRole("status").textContent).toBe("");
});

it("names the machine it revoked", async () => {
	renderPage();
	fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
	fireEvent.click(screen.getByRole("button", { name: "Yes, revoke" }));
	await waitFor(() => {
		expect(screen.getByRole("status").textContent).toMatch(/work laptop/i);
	});
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/machines-page.test.tsx`
Expected: FAIL — no status region, focus on `<body>`.

- [ ] **Step 3: Write the implementation**

Add state and a ref map:

```tsx
const [revokedName, setRevokedName] = useState("");
const rowRefs = useRef(new Map<string, HTMLDivElement>());
```

`revoke` currently takes `(id: string)`, so neither the machine's name nor the
machine itself is in scope inside it. **Change its signature to take the
machine** and update the single call site:

```tsx
const revoke = async (machine: Machine) => {
	setRevoking(machine.id);
	// ...rest of the existing body unchanged...
```

```tsx
onConfirm={() => void revoke(machine)}
```

`pending={revoking === machine.id}` is unaffected — `revoking` still holds an id.

Then, **inside the `try`, after `await load()`**, so it runs only when the
revoke actually succeeded:

```tsx
setRevokedName(machine.name);
// The row element survives the refetch - revoked machines keep their row - so
// this ref is still the same node the person was standing on when the confirm
// button under their focus unmounted.
rowRefs.current.get(machine.id)?.focus();
```

Not in the `finally`: a failed revoke leaves the machine live, and announcing
"Revoked X" for something still working is worse than announcing nothing.

On the row `<div>`, make it a focus target and register it:

```tsx
<div
	key={machine.id}
	data-machine-row={machine.id}
	ref={(el) => {
		if (el) rowRefs.current.set(machine.id, el);
		else rowRefs.current.delete(machine.id);
	}}
	// Focusable only by script. The row is not a control, but it is where a
	// person was standing when the control under their focus unmounted.
	tabIndex={-1}
	style={row}
>
```

Render the region unconditionally, near the top of the page's returned markup:

```tsx
{/*
  Always mounted, empty until it has something to say. A live region that
  appears at the same moment as its text is the shape screen readers skip.
*/}
<p role="status" style={{ margin: 0 }}>
	{revokedName ? `Revoked ${revokedName}.` : ""}
</p>
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/machines-page.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full gates, then commit**

Subject: `fix(web): keep focus where the revoke happened :dart:`
Body: why the row is the target rather than the heading, and why the region is always mounted.
Include `Refs: onlooker-tj9`.

---

### Task 5: Give the list its boundaries back

**Files:**
- Modify: `apps/web/src/pages/MachinesPage.tsx`, `apps/web/src/__tests__/machines-page.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// The markup was a table before the visual-language pass, with column and row
// headers. The visible Created/Last used labels already recover what the
// column headers did; what was lost is the boundary between machines and the
// count. A screen reader currently hears one continuous run.
it("exposes the machines as a list with one item per machine", async () => {
	renderPage();
	const list = await screen.findByRole("list");
	expect(within(list).getAllByRole("listitem")).toHaveLength(2);
});
```

Add `within` to the `@testing-library/react` import. This assumes the fixture in this file has two machines — check it and use the real count rather than changing the fixture.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/machines-page.test.tsx`
Expected: FAIL — `Unable to find an accessible element with the role "list"`.

- [ ] **Step 3: Write the implementation**

On the container that wraps `machines.map(...)`, inside `<Panel title="Your machines">`:

```tsx
<div role="list">
```

On each row `<div>`, alongside the attributes Task 4 added:

```tsx
role="listitem"
```

Not a restored `<table>`: only the row boundaries and the item count are
missing, and a list restores exactly those without undoing a styling decision
that was made deliberately.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/machines-page.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full gates, then commit**

Subject: `fix(web): let a screen reader hear where one machine ends :ear:`
Body: why a list rather than the table that was there before.
Include `Refs: onlooker-tj9`.

---

## Closing out

```bash
pnpm test && pnpm typecheck && pnpm lint
git status
```

Open the PR with `/pr`. Do not push to `main`.

After merge, close `onlooker-kxe`, `onlooker-1bz`, `onlooker-aky` and `onlooker-tj9`.

---

## Self-review

**Spec coverage.**

| Spec requirement | Task |
|---|---|
| §1 provider below `AuthProvider`, above `Routes` | 1, 2 |
| §1 portal to `document.body` | 1 |
| §1 in memory only | 1 (no storage anywhere) |
| §1 the `resetKey` dependency | Notes + Task 2 Step 4 |
| §2 dismissal ends it | 1 |
| §2 logout ends it, wired deliberately | 2 |
| §2 expiry and navigation do **not** end it | 1 (remount test), 2 |
| §3 `inert` on `AppShell` | 3 |
| §4 focus the row after revoke | 4 |
| §4 status region mounted before it has content | 4 |
| §5 `role="list"` / `role="listitem"` | 5 |
| §6 attribute tests must be able to fail | 3 Step 5 |

**Placeholder scan.** No TBDs. Every code step carries its code. Two steps ask the implementer to report rather than decide: Task 2 Step 7 (test counts) and Task 3 Step 5 (the revert check).

**Type consistency.** `MintedMachine`, `RevealProvider`, `RevealHost`, `useReveal` are defined in Task 1 and used under those names in 2 and 3. `RevealProvider` gains an optional `signedIn` prop in Task 2; Task 1's tests omit it, which is why it defaults to `true`. `rowRefs` and `data-machine-row` are introduced in Task 4 and reused by Task 5's `role="listitem"` on the same element.

**One risk worth naming.** Task 2 changes `MachinesPage`'s mint guard to read `revealed` from the provider rather than local state. If a second mint is somehow started while a reveal is open, the provider's `reveal()` would replace the displayed token with the new one — losing the first without a prompt. The guard prevents it today, and Task 2 keeps the guard, but nothing tests that path. Worth a follow-up bead rather than scope here.
