# Brand the Auth Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `apps/web`'s auth pages onto the shared brand, starting with the
shared form components that all five of them render.

**Architecture:** `apps/web/src/components/form.tsx` exports the six primitives
every auth page uses and holds its own `PALETTE` constant. Point that constant at
the brand tokens, then apply the plate treatment. A rendering test comes first,
because nothing currently tests this form and it is how people log in.

**Tech Stack:** React 18, vitest, `@testing-library/react`, jsdom, pnpm 11.0.9.

**Spec:** `docs/superpowers/specs/2026-08-11-brand-16bit-design.md`
**Visual reference:** <https://claude.ai/code/artifact/47220d2c-c92f-44df-b4c1-852cd4890e95>

## Global Constraints

- **Skin only.** No flow changes, no markup restructuring, no component API
  changes. Props, element order and accessibility attributes stay exactly as
  they are.
- **The existing accessibility wiring is load-bearing and must survive:**
  `role="alert"` on errors, `role="status"` on success, `aria-invalid`,
  `aria-describedby`, `aria-live="polite"` on the strength meter, and the
  `htmlFor`/`id` label association. Task 1 pins these so a restyle cannot
  quietly drop one.
- **Plates are constant across themes; text accents shift.** Plate tokens are
  `--plate-gold` `#ffdf40`, `--plate-teal` `#00d4aa`, `--plate-red` `#ff8a8a`,
  `--plate-ink` `#221f38`. Never redefine them per theme.
- **Pixel type is display and chrome only.** `--font-display` for headings and
  buttons; body copy, labels, hints and errors stay on `--font-body`.
- **CSS custom properties work in React inline styles.** `color: "var(--ink)"`
  is valid. No restructuring into classes is needed or wanted.
- **The repo's biome `lineWidth` is 80.** Two previous tasks broke the
  repo-wide lint gate by ignoring this. Run `lint` before reporting done.
- **`npx` is blocked** by a mise-only policy. Use `pnpm --filter <pkg> exec`.
- All commits route through the `/commit` skill. American English throughout.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/web/vite.config.ts` | add the jsdom test environment | 1 |
| `apps/web/package.json` | test deps, then the brand dep | 1, 2 |
| `apps/web/src/__tests__/auth-form.test.tsx` | the guard — renders the form | 1 |
| `apps/web/src/main.tsx` | import the brand stylesheets | 2 |
| `apps/web/src/components/form.tsx` | `PALETTE` → tokens, then the treatment | 2, 3 |

Three tasks. Task 1 is separable because it is a pure safety net with no visual
change — a reviewer could accept it and reject the styling. Task 2 is the
smallest change that proves the tokens reach the app. Task 3 is the visual work,
and by then a broken form fails a gate.

---

## Task 1: Make the form testable before touching it

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/vite.config.ts`
- Create: `apps/web/src/__tests__/auth-form.test.tsx`

**Interfaces:**
- Produces: a jsdom test environment for `apps/web`, and a suite that fails if
  the auth form stops rendering or loses its accessibility wiring. Tasks 2 and 3
  rely on it.

**Why this is first.** `apps/web`'s only existing test,
`src/__tests__/auth-integration.test.ts`, exercises the API client, token store
and header injection. It never renders a component. It would pass with the login
form completely broken — and this is the form people log in through.

- [ ] **Step 1: Add the test dependencies**

`packages/auth-react` already does component testing; mirror its versions
exactly rather than picking new ones. Add to `apps/web/package.json`
`devDependencies`:

```json
"@testing-library/react": "^15.0.6",
"jsdom": "^24.1.1"
```

Then, from the repo root:

```bash
pnpm install
```

- [ ] **Step 2: Give apps/web a jsdom test environment**

`apps/web/vite.config.ts` currently has no `test` block, so vitest runs in the
default node environment — which is why the existing logic-only test works and
why rendering would fail. Replace the file with:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
	},
	test: {
		globals: true,
		environment: "jsdom",
		include: ["src/**/*.test.{ts,tsx}"],
		exclude: ["dist/**/*", "node_modules/**/*"],
	},
});
```

Note the import order — biome sorts imports, and `@vitejs/plugin-react` sorts
before `vite`.

- [ ] **Step 3: Write the failing test**

Create `apps/web/src/__tests__/auth-form.test.tsx`. This asserts behavior and
accessibility, never colors — a brand change must not break it, but a broken
form must:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
	AuthCard,
	FormLink,
	FormMessage,
	SubmitButton,
	TextField,
} from "../components/form";

function renderInRouter(ui: React.ReactNode) {
	return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("AuthCard", () => {
	it("renders its title and children", () => {
		renderInRouter(
			<AuthCard title="Sign in">
				<p>form body</p>
			</AuthCard>,
		);
		expect(screen.getByRole("heading", { name: "Sign in" })).toBeDefined();
		expect(screen.getByText("form body")).toBeDefined();
	});

	// The card renders a <form> only when given onSubmit. Losing that would
	// break submit-on-enter without breaking anything visible.
	it("is a form when it has a submit handler", () => {
		const { container } = renderInRouter(
			<AuthCard title="Sign in" onSubmit={() => {}}>
				<p>body</p>
			</AuthCard>,
		);
		expect(container.querySelector("form")).not.toBeNull();
	});
});

describe("TextField", () => {
	it("associates its label with its input", () => {
		renderInRouter(
			<TextField id="email" label="Email" value="" onChange={() => {}} />,
		);
		// getByLabelText only resolves through a real htmlFor/id pairing.
		expect(screen.getByLabelText("Email")).toBeDefined();
	});

	it("exposes errors to assistive technology", () => {
		renderInRouter(
			<TextField
				id="email"
				label="Email"
				value=""
				onChange={() => {}}
				error="Email is required"
			/>,
		);
		const input = screen.getByLabelText("Email");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(input.getAttribute("aria-describedby")).toContain("email-error");
		expect(screen.getByRole("alert").textContent).toBe("Email is required");
	});
});

describe("SubmitButton", () => {
	it("submits and shows its label", () => {
		renderInRouter(<SubmitButton>Sign in</SubmitButton>);
		const button = screen.getByRole("button", { name: "Sign in" });
		expect(button.getAttribute("type")).toBe("submit");
		expect((button as HTMLButtonElement).disabled).toBe(false);
	});

	it("disables and relabels while loading", () => {
		renderInRouter(
			<SubmitButton loading loadingLabel="Signing in...">
				Sign in
			</SubmitButton>,
		);
		const button = screen.getByRole("button", { name: "Signing in..." });
		expect((button as HTMLButtonElement).disabled).toBe(true);
	});
});

describe("FormMessage", () => {
	it("announces errors as alerts", () => {
		renderInRouter(<FormMessage kind="error">Login failed</FormMessage>);
		expect(screen.getByRole("alert").textContent).toBe("Login failed");
	});

	it("announces success as status", () => {
		renderInRouter(<FormMessage kind="success">Check your email</FormMessage>);
		expect(screen.getByRole("status").textContent).toBe("Check your email");
	});
});

describe("FormLink", () => {
	it("renders a link to its target", () => {
		renderInRouter(<FormLink to="/signup">Create an account</FormLink>);
		const link = screen.getByRole("link", { name: "Create an account" });
		expect(link.getAttribute("href")).toBe("/signup");
	});
});
```

- [ ] **Step 4: Run it and watch it fail for the right reason**

```bash
pnpm --filter @onlooker/web test
```

Expected on the first run before Step 2's config is in place: failures about
`document is not defined`. If Step 2 is already applied, the suite should pass —
in which case skip to Step 5. **If it fails for any other reason, stop and
report** rather than adjusting assertions to match: these assertions describe
the form's current, correct behavior.

- [ ] **Step 5: Prove the guard can fail**

The whole point is that this catches a broken form. Break one deliberately:
in `apps/web/src/components/form.tsx`, change the `TextField` label's
`htmlFor={id}` to `htmlFor="wrong"`, then:

```bash
pnpm --filter @onlooker/web test
```

Expected: the two `TextField` tests fail — `getByLabelText("Email")` can no
longer resolve. Restore `htmlFor={id}`, re-run, confirm green, and confirm
`git diff apps/web/src/components/form.tsx` is empty.

- [ ] **Step 6: Confirm the gates**

```bash
pnpm --filter @onlooker/web lint
pnpm --filter @onlooker/web typecheck
pnpm test
```

Expected: all green, and `pnpm test` still reports **15 tasks**, not 16.
`apps/web` already has a `test` script, so adding a test file adds cases to an
existing turbo task rather than a new one. What should change is the case count
inside `@onlooker/web`, from 5 to 15.

- [ ] **Step 7: Commit**

Use the `/commit` skill with `apps/web/package.json`, `apps/web/vite.config.ts`,
`apps/web/src/__tests__/auth-form.test.tsx` and `pnpm-lock.yaml`.

Suggested subject: `test(web): cover the auth form before restyling it :safety_vest:`

The body should say that the existing suite tests the API layer and never
renders a component, so it would pass with the login form broken.

---

## Task 2: Point the palette at the brand

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/components/form.tsx:9-26`

**Interfaces:**
- Consumes: the rendering suite from Task 1.
- Produces: brand tokens available throughout `apps/web`, and a `PALETTE` whose
  values are `var(--token)` references. Task 3 builds the plate treatment on
  these.

- [ ] **Step 1: Depend on the brand package**

Add to `apps/web/package.json` `dependencies`:

```json
"@onlooker/brand": "workspace:*"
```

Then from the repo root:

```bash
pnpm install
```

- [ ] **Step 2: Import the stylesheets at the entry point**

`apps/web` imports no CSS today. In `apps/web/src/main.tsx`, add these two
imports below the existing ones:

```ts
import "@onlooker/brand/tokens.css";
import "@onlooker/brand/assets.css";
```

Biome sorts imports; run `pnpm --filter @onlooker/web lint` afterward and let it
place them if it objects.

- [ ] **Step 3: Give the app the brand ground**

Still in `main.tsx`, nothing sets a page background — the app would render brand
colors on the browser's default white. Add after the imports:

```ts
document.documentElement.style.background = "var(--ground)";
document.documentElement.style.color = "var(--ink)";
document.documentElement.style.fontFamily = "var(--font-body)";
```

This is deliberately three lines at the entry point rather than a new
stylesheet: `apps/web` has no CSS file to put it in, and creating one is
restructuring this plan does not want.

- [ ] **Step 4: Repoint PALETTE and STRENGTH_COLORS**

In `apps/web/src/components/form.tsx`, replace lines 9-26 with:

```ts
// Values are CSS custom properties from @onlooker/brand, resolved at render
// time - React inline styles pass var() through untouched. Plates are constant
// across themes; the text accents shift. See the brand spec.
const PALETTE = {
	primary: "var(--plate-teal)",
	danger: "var(--red)",
	success: "var(--teal)",
	border: "var(--edge)",
	borderError: "var(--red)",
	muted: "var(--ink-dim)",
	track: "var(--panel)",
} as const;

// The meter ramps from failing to strong. It reuses the semantic tokens rather
// than a private scale so it tracks the theme like everything else.
const STRENGTH_COLORS = [
	"var(--red)",
	"var(--red)",
	"var(--gold)",
	"var(--gold)",
	"var(--teal)",
	"var(--teal)",
] as const;
```

**The ramp is three hues, not six.** `packages/brand` ships exactly `--red`,
`--gold` and `--teal` as semantic accents — there is no `--amber`, despite one
appearing in the visual reference artifact. Do not invent a token or drop in a
hex to get a smoother gradient; a six-step ramp built from three real tokens is
correct here, and the meter already conveys strength through how many segments
fill, not through hue alone.

- [ ] **Step 5: Verify nothing broke**

```bash
pnpm --filter @onlooker/web test
pnpm --filter @onlooker/web lint
pnpm --filter @onlooker/web typecheck
```

Expected: all green. Task 1's suite asserts behavior, not color, so a palette
swap must not move it.

- [ ] **Step 6: Look at it**

```bash
pnpm --filter @onlooker/web dev
```

Open the login page. Expected: indigo ground, lavender text, a teal submit
button. It will still look like a generic form in brand colors — the plate
treatment is Task 3. **Report anything illegible.**

- [ ] **Step 7: Commit**

Use the `/commit` skill with `apps/web/package.json`, `apps/web/src/main.tsx`,
`apps/web/src/components/form.tsx` and `pnpm-lock.yaml`.

Suggested subject: `feat(web): put the auth form on the shared brand tokens :art:`

---

## Task 3: The plate treatment

**Files:**
- Modify: `apps/web/src/components/form.tsx`

**Interfaces:**
- Consumes: the tokens wired in Task 2 and the rendering suite from Task 1.

Every change below is a style value. **Do not touch any prop, any element, any
`aria-*` attribute, or the order of anything.**

- [ ] **Step 1: AuthCard becomes a plate**

Replace the `style` object in `AuthCard` (around line 58):

```ts
	const style: CSSProperties = {
		maxWidth: "420px",
		margin: "4rem auto",
		padding: "2rem",
		background: "var(--panel)",
		border: "2px solid var(--edge)",
		// Hard offset, no blur - the 16-bit look has no soft shadows.
		boxShadow: "6px 6px 0 var(--shadow)",
	};
```

And give the heading the display face — this is chrome, so pixel type belongs
here. Replace the `<h1>` at line 43:

```tsx
			<h1
				style={{
					marginBottom: subtitle ? "0.25rem" : "1rem",
					fontFamily: "var(--font-display)",
					color: "var(--ink-hi)",
					fontSize: "24px",
					letterSpacing: "0.5px",
				}}
			>
				{title}
			</h1>
```

- [ ] **Step 2: TextField gets a hard edge**

Replace the `input`'s `style` (around line 118):

```tsx
					style={{
						width: "100%",
						padding: "0.5rem",
						boxSizing: "border-box",
						background: "var(--ground)",
						color: "var(--ink)",
						border: `2px solid ${
							error ? PALETTE.borderError : PALETTE.border
						}`,
						borderRadius: 0,
						fontFamily: "var(--font-body)",
					}}
```

`borderRadius: 0` is deliberate — rounded corners are the single strongest
signal against this aesthetic.

- [ ] **Step 3: SubmitButton uses the plate family**

Replace the whole `style` object and the `bg` line (around line 169):

```tsx
	const isDisabled = loading || disabled;
	const plate =
		variant === "danger" ? "var(--plate-red)" : "var(--plate-teal)";
	return (
		<button
			type="submit"
			disabled={isDisabled}
			style={{
				width: "100%",
				padding: "0.75rem",
				// Plates are constant across themes, so this pair is 8.32 in
				// both. The old white-on-#ccc disabled state was 1.61.
				background: isDisabled ? "var(--panel)" : plate,
				color: isDisabled ? "var(--ink)" : "var(--plate-ink)",
				border: "2px solid var(--edge)",
				boxShadow: isDisabled ? "none" : "4px 4px 0 var(--shadow)",
				borderRadius: 0,
				cursor: isDisabled ? "not-allowed" : "pointer",
				fontFamily: "var(--font-display)",
				fontSize: "14px",
				letterSpacing: "1px",
				textTransform: "uppercase",
			}}
		>
```

- [ ] **Step 4: FormMessage becomes a bordered plate**

Replace its `style` (around line 201). The old hardcoded `#fdecea` and `#e6f4ea`
backgrounds cannot track a theme:

```tsx
			style={{
				color,
				border: `2px solid ${color}`,
				background: `color-mix(in srgb, ${color} 12%, transparent)`,
				borderRadius: 0,
				padding: "0.75rem",
				marginBottom: "1rem",
				fontSize: "0.9rem",
				fontFamily: "var(--font-body)",
			}}
```

- [ ] **Step 5: Square off the strength meter**

In `PasswordStrengthMeter`, change the segment `borderRadius: "2px"` to
`borderRadius: 0` and its `height` from `"4px"` to `"6px"`. Change nothing
else — the `aria-hidden` and `aria-live` attributes stay exactly as they are.

- [ ] **Step 6: Verify the suite still passes**

```bash
pnpm --filter @onlooker/web test
```

Expected: green. If any test fails, a style edit touched structure or an
attribute — **revert that edit** rather than changing the test. Task 1's
assertions describe correct behavior.

- [ ] **Step 7: Look at every auth page**

```bash
pnpm --filter @onlooker/web dev
```

Visit `/login`, `/signup` and `/forgot-password` directly.

**Two routes take a token parameter** — they are `/reset-password/:token` and
`/verify-email/:token`, so the bare paths hit the catch-all route and render
nothing useful. Visit them with any placeholder segment, for example
`/reset-password/test` and `/verify-email/test`. The token will be rejected,
which is fine: the point is to see the card, the message and the button in
their error state, which is the state most likely to look wrong.

Check each: the card reads as a plate, the button is legible, an error state is
readable, and the signup page's strength meter tracks.

Toggle your OS between light and dark. Both must be legible — day is a lighter
lavender ground, not an inversion.

**Report anything hard to read rather than adjusting a token locally.** The
palette is contract-tested in `packages/brand`; a readability problem here means
a wrong token was chosen, not a wrong palette.

- [ ] **Step 8: Confirm the gates**

```bash
pnpm build && pnpm test && pnpm lint
```

- [ ] **Step 9: Commit**

Use the `/commit` skill with `apps/web/src/components/form.tsx`.

Suggested subject: `feat(web): give the auth form the plate treatment :art:`

The body should note that the disabled button's contrast went from 1.61 to a
legible pair, which was a pre-existing accessibility failure rather than
something this change introduced.

---

## Definition of Done

- All five auth pages render in the brand: `/login`, `/signup`,
  `/forgot-password`, `/reset-password`, `/verify-email`
- `apps/web` has a rendering suite that has been **observed failing** on a
  deliberately broken label association, and restored
- Every accessibility attribute the form had before it still has: `role="alert"`,
  `role="status"`, `aria-invalid`, `aria-describedby`, `aria-live`, and label
  association
- Both themes are legible, checked by eye on every page
- `pnpm build && pnpm test && pnpm lint` green

## Not in this plan

**The other four pages.** `DashboardPage` (6 inline styles), `ProfilePage` (13),
`SettingsPage` (20), `HomePage` (1) and `SessionExpiryBanner` (2). They are the
signed-in surface, they share no component layer with the auth pages, and they
want their own pass.

**`LoginPage`'s own 7 inline styles.** They sit outside the shared components.
Leave them; if the page looks wrong after Task 3, report it rather than
widening scope mid-task.

**Icons.** No pixel icon is used here. `Eye` on the password field and `Locked`
on the card are obvious later additions, but they are new elements, and this
plan changes only style values.

**Any component API change.** Props stay as they are.
