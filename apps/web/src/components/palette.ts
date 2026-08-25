// Values are CSS custom properties from @onlooker/brand, resolved at render
// time - React inline styles pass var() through untouched. Plates are constant
// across themes; the text accents shift. See the brand spec.
//
// Lifted here from form.tsx so ui.tsx imports the same object rather than
// re-deriving it. The plate/accent distinction below is the thing being
// protected: getting it wrong once cost a 1.35-contrast bug.
export const PALETTE = {
	// A plate is a filled background and is constant across themes; an accent
	// is ink on a ground and shifts. One key cannot be both - using the plate
	// as text put links at 1.35 contrast in day mode.
	plateTeal: "var(--plate-teal)",
	plateRed: "var(--plate-red)",
	plateInk: "var(--plate-ink)",
	accent: "var(--teal)",
	danger: "var(--red)",
	// Not var(--edge): TextField's --ground fill sits on --panel when
	// nested in AuthCard (signup, forgot-password, reset-password) - the
	// mirror of AuthCard's own case, same 1.70/1.37 fallback-free edge.
	// On the settings page, which has no AuthCard wrapper, it sits
	// directly on the page's own --ground - fill and surrounding are
	// identical there, so the border is the only boundary at all.
	// ink-dim clears every one of these. (LoginPage is hand-rolled and
	// doesn't use TextField at all - see Task 4.)
	border: "var(--ink-dim)",
	borderError: "var(--red)",
	muted: "var(--ink-dim)",
	track: "var(--panel)",
} as const;
