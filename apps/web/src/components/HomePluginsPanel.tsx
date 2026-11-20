/**
 * The home page's Plugins panel: what each Onlooker plugin did in the last 7
 * days, and which installed ones sent nothing (ONL-298).
 *
 * Presentational, like HomeSessionsPanel. HomePage hands it the window's
 * sessions and what the machines' inventories say is installed; a read that
 * failed or is still running arrives as such, so the panel never names a
 * plugin silent on evidence it does not have.
 */

import { useId } from "react";
import { Link } from "react-router-dom";
import type { SessionSummary } from "../api/sessionsApi";
import { silentPlugins } from "../lib/installedPlugins";
import { describePluginWeek, rollupPlugins } from "../lib/pluginRollup";
import { plural } from "../lib/sessionRollup";
import { PALETTE } from "./palette";
import { Panel } from "./ui";

/** What the inventories say is installed, by bare plugin name. */
export type Installed =
	| { kind: "loading" }
	| { kind: "failed" }
	| { kind: "loaded"; names: string[] };

const muted = { color: PALETTE.muted, fontSize: "0.85em" } as const;

function silentLine(
	installed: Installed,
	complete: boolean,
	sessions: SessionSummary[],
): string {
	if (installed.kind === "loading")
		return "Checking which plugins are installed…";
	// A partial list would call plugins silent that a failed machine ran.
	if (installed.kind === "failed")
		return "Couldn't check which plugins are installed.";
	// An unread session may hold the events that would clear a plugin.
	if (!complete)
		return "Not every session this week was loaded, so quiet plugins aren't listed.";
	if (installed.names.length === 0)
		return "No machine has reported its installed plugins.";
	const silent = silentPlugins(installed.names, sessions);
	return silent.length === 0
		? "Every installed Onlooker plugin sent events this week."
		: `Installed, no events in 7 days: ${silent.join(", ")}.`;
}

export default function HomePluginsPanel({
	sessions,
	complete,
	installed,
}: {
	/** Already filtered to the window. */
	sessions: SessionSummary[];
	/** False when more pages remain that may hold sessions in the window. */
	complete: boolean;
	installed: Installed;
}) {
	const listId = useId();
	const { rows, unclassified } = rollupPlugins(sessions);

	return (
		<Panel title="Plugins" icon="Plug">
			{rows.length === 0 && unclassified.length === 0 ? (
				<p style={{ margin: 0, color: PALETTE.muted }}>
					No plugin events in the last 7 days.
				</p>
			) : (
				<>
					{complete ? null : (
						<p style={{ margin: 0, ...muted }}>
							From the most recent {plural(sessions.length, "session")}.
						</p>
					)}
					{rows.length > 0 ? (
						<>
							<p id={listId} style={{ margin: 0, ...muted }}>
								This week
							</p>
							<ul
								data-testid="home-plugins"
								aria-labelledby={listId}
								style={{
									margin: "var(--space-1) 0 0",
									padding: 0,
									listStyle: "none",
								}}
							>
								{rows.map((week) => {
									const text = describePluginWeek(week);
									const flagged = `${week.failed} failed`;
									return (
										<li key={week.plugin}>
											<span>{week.plugin}</span>:{" "}
											{week.failed > 0 ? (
												<>
													<span style={{ color: PALETTE.danger }}>
														{flagged}
													</span>
													{text.slice(flagged.length)}
												</>
											) : (
												text
											)}
										</li>
									);
								})}
							</ul>
						</>
					) : null}
					{unclassified.length > 0 ? (
						<p style={{ margin: "var(--space-2) 0 0" }}>
							Unclassified: {unclassified.join(", ")}.
						</p>
					) : null}
				</>
			)}

			<p
				data-testid="home-plugins-silent"
				style={{ margin: "var(--space-3) 0 0", ...muted }}
			>
				{silentLine(installed, complete, sessions)}
			</p>

			<p style={{ margin: "var(--space-3) 0 0" }}>
				<Link to="/sessions" style={{ color: PALETTE.accent }}>
					Plugin activity per session
				</Link>
			</p>
		</Panel>
	);
}
