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
				borderRadius: "6px",
				border: "1px solid #f0c36d",
				backgroundColor: "#fdf6e3",
				color: "#7a5c00",
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
					border: "1px solid #7a5c00",
					borderRadius: "4px",
					backgroundColor: "transparent",
					color: "#7a5c00",
				}}
			>
				Stay signed in
			</button>
		</div>
	);
}
