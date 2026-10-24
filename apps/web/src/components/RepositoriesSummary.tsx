/**
 * The loaded sessions, per repository (ONL-184).
 *
 * Repositories are named by their project key - an opaque 12-hex hash - because
 * that is all the server has. Turning a key into a name is a separate decision
 * with its own privacy question, and this panel does not pretend otherwise.
 *
 * Presentational: lib/sessionRollup.ts's rollupProjects does the grouping,
 * including the remote/root distinction this renders, and SessionsPage
 * resolves machine names.
 */

import { type ProjectsRollup, plural } from "../lib/sessionRollup";
import { PALETTE } from "./palette";
import { Panel } from "./ui";

/**
 * Show at most this many repositories, for the reason SessionsSummary caps
 * its days: the panel sits above the feed, and the feed is the page.
 */
const MAX_VISIBLE_REPOSITORIES = 7;

export default function RepositoriesSummary({
	rollup,
	complete,
	machineName,
}: {
	rollup: ProjectsRollup;
	/** False when more pages remain, so these totals are not the history's. */
	complete: boolean;
	/** A machine's name, or null while the machines read has not landed. */
	machineName: (machineId: string) => string | null;
}) {
	// Every loaded session predates the column, or ran outside a repository.
	// A panel that only says so is noise above the feed.
	if (rollup.projects.length === 0) return null;

	const visible = rollup.projects.slice(0, MAX_VISIBLE_REPOSITORIES);
	const hiddenCount = rollup.projects.length - visible.length;

	return (
		<Panel title="By repository" icon="Briefcase">
			<div data-testid="repositories-summary">
				{complete ? null : (
					<div style={{ marginBottom: "var(--space-3)", color: PALETTE.muted }}>
						Across the most recent sessions loaded.
					</div>
				)}

				{visible.map((project) => (
					<div
						key={`${project.machineId ?? ""}:${project.key}`}
						data-testid="repository-row"
						style={{
							display: "flex",
							flexWrap: "wrap",
							alignItems: "baseline",
							gap: "var(--space-3)",
							padding: "0.2rem 0",
						}}
					>
						<span style={{ flex: "none", fontFamily: "var(--font-data)" }}>
							{project.key}
						</span>
						{/*
						 * A root key hashes a local path, so it names a repository
						 * only on the machine that reported it. Saying which machine
						 * is what keeps it from reading as portable as the rest.
						 */}
						{project.machineId !== null ? (
							<span style={{ flex: "none", color: PALETTE.muted }}>
								{machineName(project.machineId) ?? "one machine"} only
							</span>
						) : null}
						<span style={{ marginLeft: "auto", color: PALETTE.muted }}>
							{plural(project.sessions, "session")} ·{" "}
							{plural(project.events, "event")}
						</span>
					</div>
				))}

				{hiddenCount > 0 ? (
					<div style={{ padding: "0.2rem 0", color: PALETTE.muted }}>
						{/* Not plural(): it appends a bare "s". */}…{" "}
						{hiddenCount === 1
							? "1 more repository"
							: `${hiddenCount.toLocaleString()} more repositories`}
					</div>
				) : null}

				{rollup.unattributed > 0 ? (
					<div style={{ marginTop: "var(--space-3)", color: PALETTE.muted }}>
						{plural(rollup.unattributed, "session")} carried no repository -
						synced by a CLI older than 2.7.0, or run outside a git repository.
					</div>
				) : null}
			</div>
		</Panel>
	);
}
