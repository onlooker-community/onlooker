import { useEffect, useState } from "react";
import { type LabelMap, listLabels } from "../api/labelsApi";
import { listSessions, type SessionsPage } from "../api/sessionsApi";
import HomeSessionsPanel from "../components/HomeSessionsPanel";
import { Loading, Panel } from "../components/ui";
import { describeError } from "../lib/apiErrors";
import { windowDays, withinWindow } from "../lib/homeWindow";

// The landing page for a signed-in person (ONL-298): a summary of the last 7
// days, each panel linking through to its section. Every panel loads and
// fails on its own, so one failed read blanks one panel rather than the page.

/** One page of 200, as SessionsPage asks for, so the two read the same rows. */
export const SESSIONS_LIMIT = 200;

/**
 * A read in three states. "Failed" is kept apart from "loaded and empty" so a
 * panel can never render an empty week for a read that did not succeed.
 */
type Load<T> =
	| { kind: "loading" }
	| { kind: "loaded"; value: T }
	| { kind: "failed"; message: string };

export default function HomePage() {
	// Fixed at mount: the window must not move under rows already loaded.
	const [now] = useState(() => new Date());
	const [sessions, setSessions] = useState<Load<SessionsPage>>({
		kind: "loading",
	});
	// Empty until read, and empty if the read fails: every repository then
	// shows its key, as on the Sessions page.
	const [labels, setLabels] = useState<LabelMap>(new Map());

	useEffect(() => {
		let active = true;
		listSessions({ limit: SESSIONS_LIMIT })
			.then((page) => {
				if (active) setSessions({ kind: "loaded", value: page });
			})
			.catch((error: unknown) => {
				if (active) {
					setSessions({
						kind: "failed",
						// No fallback sentence: the alert already opens with one, and
						// a non-Error rejection would otherwise read it twice.
						message: describeError(error, ""),
					});
				}
			});
		listLabels()
			.then((loaded) => {
				if (active) setLabels(loaded);
			})
			.catch(() => {
				// Deliberately quiet; see the state's own comment.
			});
		return () => {
			active = false;
		};
	}, []);

	return (
		<div style={{ display: "grid", gap: "var(--space-6)" }}>
			{sessions.kind === "loading" ? (
				<Panel title="Recent sessions" icon="Monitor">
					<Loading label="Loading your sessions…" />
				</Panel>
			) : sessions.kind === "failed" ? (
				<Panel title="Recent sessions" icon="Monitor">
					<p role="alert" style={{ margin: 0 }}>
						{`Could not load your sessions. ${sessions.message}`.trim()}
					</p>
				</Panel>
			) : (
				(() => {
					const windowed = withinWindow(
						sessions.value.sessions,
						(session) => session.started_at,
						now,
						sessions.value.has_more,
					);
					return (
						<HomeSessionsPanel
							sessions={windowed.rows}
							complete={windowed.complete}
							days={windowDays(now)}
							labels={labels}
						/>
					);
				})()
			)}
		</div>
	);
}
