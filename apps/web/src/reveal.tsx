import {
	createContext,
	type ReactNode,
	useContext,
	useMemo,
	useState,
} from "react";
import { createPortal } from "react-dom";
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
