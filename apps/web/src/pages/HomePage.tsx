import type { IconName } from "@onlooker/brand";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type LabelMap, listLabels } from "../api/labelsApi";
import { getMachineInventory, listMachines } from "../api/machinesApi";
import {
	listSessions,
	type SessionSummary,
	type SessionsPage,
} from "../api/sessionsApi";
import HomePluginsPanel, {
	type Installed,
} from "../components/HomePluginsPanel";
import HomeSessionsPanel from "../components/HomeSessionsPanel";
import { Loading, Panel } from "../components/ui";
import { describeError } from "../lib/apiErrors";
import { type Windowed, windowDays, withinWindow } from "../lib/homeWindow";
import {
	installedOnlookerPlugins,
	reportingMachines,
} from "../lib/installedPlugins";
import type { Load } from "../lib/load";

// The landing page for a signed-in person (ONL-298): a summary of the last 7
// days, each panel linking through to its section. Every panel loads and
// fails on its own, so one failed read blanks one panel rather than the page.

/** One page of 200, as SessionsPage asks for, so the two read the same rows. */
export const SESSIONS_LIMIT = 200;

/**
 * The loading and failed states a home panel shows for a read, so each panel
 * states only what it draws once the read has arrived.
 */
function PanelFor<T>({
	load,
	title,
	icon,
	loading,
	failed,
	children,
}: {
	load: Load<T>;
	title: string;
	icon: IconName;
	loading: string;
	failed: (message: string) => ReactNode;
	children: (value: T) => ReactNode;
}) {
	if (load.kind === "loading")
		return (
			<Panel title={title} icon={icon}>
				<Loading label={loading} />
			</Panel>
		);
	if (load.kind === "failed")
		return (
			<Panel title={title} icon={icon}>
				{failed(load.message)}
			</Panel>
		);
	return <>{children(load.value)}</>;
}

export default function HomePage() {
	// Fixed at mount: the window must not move under rows already loaded.
	const [now] = useState(() => new Date());
	const [sessions, setSessions] = useState<Load<SessionsPage>>({
		kind: "loading",
	});
	// Empty until read, and empty if the read fails: every repository then
	// shows its key, as on the Sessions page.
	const [labels, setLabels] = useState<LabelMap>(new Map());
	const [installed, setInstalled] = useState<Installed>({ kind: "loading" });

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
		listMachines()
			.then(({ machines }) =>
				Promise.all(
					reportingMachines(machines).map((machine) =>
						getMachineInventory(machine.id).then((read) => read.inventory),
					),
				),
			)
			.then((inventories) => {
				if (active)
					setInstalled({
						kind: "loaded",
						names: installedOnlookerPlugins(inventories),
					});
			})
			.catch(() => {
				// Any one failure voids the list: see the Plugins panel's silent line.
				if (active) setInstalled({ kind: "failed" });
			});
		return () => {
			active = false;
		};
	}, []);

	// Every panel reads the same window, so it is cut once, here.
	const week = useMemo<Load<Windowed<SessionSummary>>>(
		() =>
			sessions.kind === "loaded"
				? {
						kind: "loaded",
						value: withinWindow(
							sessions.value.sessions,
							(session) => session.started_at,
							now,
							sessions.value.has_more,
						),
					}
				: sessions,
		[sessions, now],
	);

	return (
		<div style={{ display: "grid", gap: "var(--space-5)", maxWidth: "720px" }}>
			<PanelFor
				load={week}
				title="Recent sessions"
				icon="Monitor"
				loading="Loading your sessions…"
				failed={(message) => (
					<p role="alert" style={{ margin: 0 }}>
						{`Could not load your sessions. ${message}`.trim()}
					</p>
				)}
			>
				{(windowed) => (
					<HomeSessionsPanel
						sessions={windowed.rows}
						complete={windowed.complete}
						days={windowDays(now)}
						labels={labels}
					/>
				)}
			</PanelFor>
			<PanelFor
				load={week}
				title="Plugins"
				icon="Plug"
				loading="Loading plugin activity…"
				failed={() => (
					// Not an alert: the sessions panel already announced this failure.
					<p style={{ margin: 0 }}>
						Plugin activity comes from your sessions, which could not be loaded.
					</p>
				)}
			>
				{(windowed) => (
					<HomePluginsPanel
						sessions={windowed.rows}
						complete={windowed.complete}
						installed={installed}
					/>
				)}
			</PanelFor>
		</div>
	);
}
