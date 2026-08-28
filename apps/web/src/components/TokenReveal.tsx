import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { MintedMachine } from "../api/machinesApi";
import { PALETTE } from "./palette";
import { Button, Panel } from "./ui";

/**
 * The one-time reveal.
 *
 * `handleCreateMachine` returns the raw token in the create response and
 * nowhere else, ever - only its SHA-256 is stored - so this really is the only
 * chance. Every decision below follows from that one fact:
 *
 * - The only way out is "I've saved it". Escape does not close it and neither
 *   does the backdrop, because those are the two gestures a person makes
 *   without having decided anything.
 * - Focus is trapped, so Tab cannot walk into the nav behind the modal - that
 *   closes off every in-app link while the reveal is open. The spec asked for
 *   a prompt on navigating away, which reads as `useBlocker` - unavailable
 *   here, because main.tsx mounts BrowserRouter rather than a data router.
 *   See the 2026-08-25 amendment.
 * - `beforeunload` covers reload, tab close, and a Back that leaves the
 *   document entirely. It does not cover an in-app Back: a same-document
 *   history pop is a `popstate`, which React Router handles client-side and
 *   which fires no `beforeunload`, so it unmounts this dialog with no prompt
 *   and the token is lost - recoverable only by revoking the machine and
 *   minting another (the dialog says so below). A history-sentinel guard was
 *   tried and reverted; onlooker-1bz has the detail and tracks closing the
 *   gap for real.
 * - A failed copy says failed. Telling someone their only copy is on the
 *   clipboard when it is not is the worst outcome this component has.
 */
export default function TokenReveal({
	machine,
	onDismiss,
}: {
	machine: MintedMachine;
	onDismiss: () => void;
}) {
	const dialogRef = useRef<HTMLDivElement>(null);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
		"idle",
	);

	useEffect(() => {
		const warn = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			// preventDefault alone is the current spec; returnValue is what
			// actually raises the prompt in Chrome and Safari today.
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, []);

	useEffect(() => {
		// So a screen reader announces the dialog, and so Tab starts inside it
		// rather than at the top of the document.
		dialogRef.current?.focus();
	}, []);

	const keepFocusInside = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			// Stop it here rather than let it bubble. Nothing listens today, but
			// if an app-level "Escape closes the overlay" handler ever appears,
			// this dialog should not answer to it.
			event.stopPropagation();
			return;
		}
		if (event.key !== "Tab") return;

		const focusable =
			dialogRef.current?.querySelectorAll<HTMLElement>("button");
		if (!focusable || focusable.length === 0) return;

		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		const active = document.activeElement;
		// The container itself counts as "at the start". Focus lands on it at
		// mount, so without this a Shift+Tab pressed before any forward Tab
		// matches neither branch, falls through to the browser's own backward
		// navigation, and walks straight out of the dialog into the nav behind
		// it - where Enter is a client-side route change that fires no
		// beforeunload and calls no onDismiss. The token would go with it.
		if (event.shiftKey && (active === first || active === dialogRef.current)) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && active === last) {
			event.preventDefault();
			first.focus();
		}
	};

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(machine.token);
			setCopyState("copied");
		} catch {
			// Includes the case where there is no clipboard API at all - an
			// insecure context, or a browser that withholds it.
			setCopyState("failed");
		}
	};

	return (
		<div
			style={{
				position: "fixed",
				inset: 0,
				background: "rgba(0, 0, 0, 0.6)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				padding: "1rem",
				zIndex: 10,
			}}
		>
			{/*
			  No onClick on the backdrop. Click-outside-to-close would be the
			  third way to lose the token by accident, after a timeout and
			  Escape, and it is the one people trigger without noticing.
			*/}
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="token-reveal-title"
				tabIndex={-1}
				onKeyDown={keepFocusInside}
				style={{ width: "100%", maxWidth: "34rem" }}
			>
				<Panel>
					<h2
						id="token-reveal-title"
						style={{
							margin: "0 0 0.75rem",
							fontFamily: "var(--font-display)",
							fontSize: "var(--text-display-md)",
							letterSpacing: "1px",
						}}
					>
						Save this token now
					</h2>

					<p style={{ margin: "0 0 1rem" }}>
						This is the only time the token for <strong>{machine.name}</strong>{" "}
						will be shown. It is not stored anywhere it can be read back.
					</p>

					<code
						style={{
							display: "block",
							padding: "0.75rem",
							marginBottom: "0.75rem",
							background: "var(--ground)",
							border: `2px solid ${PALETTE.border}`,
							// The value is 69 characters and must survive being
							// selected by hand when the clipboard is unavailable.
							wordBreak: "break-all",
							// --font-data, not an ad-hoc monospace stack: it's the
							// brand's data face, already used by apps/website.
							fontFamily: "var(--font-data)",
						}}
					>
						{machine.token}
					</code>

					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: "0.75rem",
							flexWrap: "wrap",
							marginBottom: "1rem",
						}}
					>
						<Button onClick={copy}>Copy token</Button>
						{copyState === "copied" ? (
							<span style={{ color: PALETTE.muted }}>Copied.</span>
						) : null}
						{copyState === "failed" ? (
							<span role="alert" style={{ color: PALETTE.danger }}>
								Copy failed — select the token above and copy it by hand.
							</span>
						) : null}
					</div>

					<p style={{ color: PALETTE.muted, margin: "0 0 1rem" }}>
						Lost it? Revoke this machine and mint another. There is no way to
						recover this value.
					</p>

					<Button onClick={onDismiss}>I&apos;ve saved it</Button>
				</Panel>
			</div>
		</div>
	);
}
