import { useEffect, useState } from "react";
import { auth } from "../auth";

function formatRemaining(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Visual session indicator (WS3, Task 3.2). Renders nothing unless the session
 * has a known expiry. Within the warning window it surfaces a banner with a
 * live countdown and a "Stay signed in" action that triggers a manual refresh.
 *
 * Reads only derived state (`sessionExpiresAt`, `sessionExpiringSoon`) — never
 * the token itself — so nothing sensitive reaches the DOM.
 */
export default function SessionExpiryBanner() {
	const { user, sessionExpiresAt, sessionExpiringSoon, refresh } =
		auth.useAuth();
	const [now, setNow] = useState(() => Date.now());

	// Tick once a second only while a warning is showing — no timer otherwise.
	useEffect(() => {
		if (!sessionExpiringSoon) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [sessionExpiringSoon]);

	if (!user || sessionExpiresAt === null) return null;
	if (!sessionExpiringSoon) return null;

	const remainingMs = sessionExpiresAt - now;
	const expired = remainingMs <= 0;

	return (
		<div
			role="alert"
			style={{
				marginBottom: "1rem",
				padding: "0.75rem 1rem",
				borderRadius: 0,
				// A filled plate, like FormMessage - this is the same class of
				// thing, a role="alert" notice, and it should read as one. Gold is
				// the brand's attention color and plate-ink on it is 12.02 in both
				// themes, because plates do not shift.
				//
				// The outline is not trim. A plate is constant while the page under
				// it is not, so the fill only marks the banner's edge at night
				// (12.02 against the ground, where plate-ink would be 1.00). By day
				// the fill is 1.07 and the outline carries it at 11.27. Each covers
				// exactly where the other fails; dropping either leaves the banner
				// with no boundary in one theme.
				border: "2px solid var(--plate-ink)",
				backgroundColor: "var(--plate-gold)",
				color: "var(--plate-ink)",
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: "1rem",
			}}
		>
			<span>
				{expired
					? "Your session has expired. Refreshing…"
					: `Your session expires in ${formatRemaining(remainingMs)}.`}
			</span>
			<button
				type="button"
				onClick={() => void refresh()}
				style={{
					padding: "0.4rem 0.9rem",
					cursor: "pointer",
					// Sits on the gold plate, so it takes the plate's own ink for
					// both label and border - 12.02 against that fill, constant in
					// both themes. Nothing here reads against the page.
					border: "2px solid var(--plate-ink)",
					borderRadius: 0,
					backgroundColor: "transparent",
					color: "var(--plate-ink)",
					fontFamily: "var(--font-data)",
					fontSize: "var(--text-data-md)",
					letterSpacing: "1px",
					textTransform: "uppercase",
				}}
			>
				Stay signed in
			</button>
		</div>
	);
}
