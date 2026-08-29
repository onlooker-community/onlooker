import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { createPortal } from "react-dom";
// The leaf config module, not `./api/client`. This needs one string - the
// localStorage key the session lives under - and `api/config` is env constants
// with no side effects, where importing the client would pull the whole
// transport layer, its mock fetch and its retry machinery into a component
// that makes no requests. `client.ts` builds `activeApiConfig` from this same
// object, so the key is identical to the one `auth.ts` hands auth-react.
import { apiConfig } from "./api/config";
import type { MintedMachine } from "./api/machinesApi";
import TokenReveal from "./components/TokenReveal";

// The create response, and the only moment the raw token exists anywhere the
// browser can read it, already has a home in api/machinesApi.ts - re-export it
// rather than declare a second copy of the same shape here, which would let
// the two drift apart silently the moment either one gains a field.
export type { MintedMachine };

interface RevealValue {
	revealed: MintedMachine | null;
	reveal: (machine: MintedMachine) => void;
	dismiss: () => void;
}

const RevealContext = createContext<RevealValue | null>(null);

/**
 * Holds the one machine token that has been revealed but not yet dismissed.
 *
 * Mounted above `<Routes>`, deliberately: neither a route change nor
 * `RequireAuth`'s redirect on session expiry can unmount it. The token was
 * previously held in `MachinesPage`, which meant any of those destroyed it - a
 * credential shown exactly once, recoverable only by revoking the machine and
 * minting another.
 *
 * Nothing here watches the auth state, and that is the point. A session expiry
 * nulls `user` through the very same code path a deliberate logout takes -
 * `expireSession` -> `requestLocalLogout` -> `performLogout({callApi:false})`
 * -> `resetState` - so an effect keyed on "is someone signed in" cannot tell
 * the two apart, and would end the reveal on the one signal that must never
 * end it: the proactive refresh failing while the person is in their password
 * manager, taking the token off a screen nobody touched.
 *
 * A deliberate sign-out does have to clear it, so the two places that call
 * `logout()` - `AppShell`'s Sign out and `SettingsPage`'s account deletion -
 * call `dismiss()` first. An explicit call at a deliberate gesture, rather
 * than an inference from state that has two causes. The `storage` listener
 * below is the third case, which neither button can see.
 *
 * **What the `storage` listener cannot tell apart.** It sees another tab
 * clearing the session, and a deliberate sign-out and a failed refresh clear
 * the same key. So with two tabs open, a background tab's expiry does end a
 * reveal in this one - the guarantee above is a single-tab guarantee. The
 * trade was made knowingly: the alternative leaves a live credential on a
 * screen its owner believes is signed out. Narrowing it further needs a signal
 * that says *why* the token went away, which localStorage does not carry.
 *
 * In memory only. A reload still loses it, and `beforeunload` warns first;
 * writing a live credential to storage to avoid a warning the user has already
 * seen would be a worse trade than the bug this fixes.
 */
export function RevealProvider({ children }: { children: ReactNode }) {
	const [revealed, setRevealed] = useState<MintedMachine | null>(null);

	// Signing out in another tab is a third kind of logout, and the two
	// dismiss() call sites cannot see it: auth-react handles a cross-tab
	// sign-out by calling resetState() directly, never through expireSession
	// and never through either button. This tab just redirects to /login - with
	// the credential still on screen, until this listener.
	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			// A `storage` event never fires in the tab that caused the write. So
			// this tab's own expiry is silence here and the reveal survives it,
			// which is the discrimination `signedIn` could not make. See the
			// doc comment above for what this still cannot tell apart.
			//
			// Both conditions mirror auth-react's own cross-tab handler
			// (packages/auth-react/src/index.tsx). A null key is
			// `localStorage.clear()`, which it also treats as a sign-out; if the
			// two disagreed about what ends a session, the disagreement would
			// look exactly like the bug this exists to fix.
			if (event.key !== null && event.key !== apiConfig.tokenStorageKey) {
				return;
			}
			// Another tab signing in, or finishing a refresh, writes a *new*
			// token to this same key. That event proves the session is healthy,
			// so only a cleared value counts.
			if (event.newValue !== null) return;
			setRevealed(null);
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, []);

	const value = useMemo<RevealValue>(
		() => ({
			revealed,
			reveal: setRevealed,
			dismiss: () => setRevealed(null),
		}),
		[revealed],
	);
	return (
		<RevealContext.Provider value={value}>{children}</RevealContext.Provider>
	);
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
