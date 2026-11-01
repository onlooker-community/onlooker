/**
 * The loaded sessions, per repository (ONL-184), and where they are named
 * (ONL-189).
 *
 * A repository is its project key - an opaque 12-hex hash - until the user
 * names it here. The name is theirs, typed rather than derived, so nothing
 * leaves their machine to produce it; the key stays in a title so a named
 * row can still be matched to what the CLI reports.
 *
 * lib/sessionRollup.ts's rollupProjects does the grouping, including the
 * remote/root distinction this renders, and SessionsPage resolves machine
 * names and owns the labels. This component owns only which row is being
 * edited.
 */

import { useState } from "react";
import {
	type ProjectRollup,
	type ProjectsRollup,
	plural,
} from "../lib/sessionRollup";
import { type NamedProject, NameEditor, RepositoryName } from "./ProjectName";
import { PALETTE } from "./palette";
import { Panel } from "./ui";

/**
 * Show at most this many repositories, for the reason SessionsSummary caps
 * its days: the panel sits above the feed, and the feed is the page.
 */
const MAX_VISIBLE_REPOSITORIES = 7;

/** A row's identity, matching rollupProjects' own grouping. */
function rowKey(project: ProjectRollup): string {
	return `${project.machineId ?? ""}:${project.key}`;
}

export default function RepositoriesSummary({
	rollup,
	complete,
	machineName,
	nameOf,
	onRename,
}: {
	rollup: ProjectsRollup;
	/** False when more pages remain, so these totals are not the history's. */
	complete: boolean;
	/** A machine's name, or null while the machines read has not landed. */
	machineName: (machineId: string) => string | null;
	/** The user's name for a repository, or null to show its key. */
	nameOf: (project: ProjectRollup) => string | null;
	/** Store a name, or clear it with null. Rejects with what the server said. */
	onRename: (project: NamedProject, label: string | null) => Promise<void>;
}) {
	// One row at a time. Opening a second editor abandons the first's draft,
	// which is what a click elsewhere in a list is understood to mean.
	const [editing, setEditing] = useState<string | null>(null);

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
						key={rowKey(project)}
						data-testid="repository-row"
						style={{
							display: "flex",
							flexWrap: "wrap",
							alignItems: "baseline",
							gap: "var(--space-3)",
							padding: "0.2rem 0",
						}}
					>
						{editing === rowKey(project) ? (
							<NameEditor
								project={project}
								current={nameOf(project)}
								onRename={onRename}
								onDone={() => setEditing(null)}
							/>
						) : (
							<RepositoryName
								project={project}
								name={nameOf(project)}
								onEdit={() => setEditing(rowKey(project))}
							/>
						)}
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
