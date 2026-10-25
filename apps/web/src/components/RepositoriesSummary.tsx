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

import { type KeyboardEvent, useState } from "react";
import { describeError } from "../lib/apiErrors";
import {
	type ProjectRollup,
	type ProjectsRollup,
	plural,
} from "../lib/sessionRollup";
import { PALETTE } from "./palette";
import { Button, Panel } from "./ui";

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
	onRename: (project: ProjectRollup, label: string | null) => Promise<void>;
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

function RepositoryName({
	project,
	name,
	onEdit,
}: {
	project: ProjectRollup;
	name: string | null;
	onEdit: () => void;
}) {
	return (
		<>
			{name ? (
				// The key moves to a title rather than disappearing: it is what
				// the CLI and the session lines' tails still speak in.
				<span title={project.key} style={{ flex: "none" }}>
					{name}
				</span>
			) : (
				<span style={{ flex: "none", fontFamily: "var(--font-data)" }}>
					{project.key}
				</span>
			)}
			<button
				type="button"
				onClick={onEdit}
				// Names the row, because "rename" alone repeats down the panel
				// and a screen reader's list of buttons would be seven of them.
				aria-label={`Rename repository ${name ?? project.key}`}
				style={{
					flex: "none",
					padding: 0,
					border: "none",
					background: "none",
					color: PALETTE.muted,
					fontSize: "0.85em",
					textDecoration: "underline",
					cursor: "pointer",
				}}
			>
				rename
			</button>
		</>
	);
}

function NameEditor({
	project,
	current,
	onRename,
	onDone,
}: {
	project: ProjectRollup;
	current: string | null;
	onRename: (project: ProjectRollup, label: string | null) => Promise<void>;
	onDone: () => void;
}) {
	const [draft, setDraft] = useState(current ?? "");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const errorId = `repository-name-error-${project.machineId ?? ""}-${project.key}`;

	const save = async (label: string | null) => {
		if (saving) return;
		setSaving(true);
		setError(null);
		try {
			await onRename(project, label);
			onDone();
		} catch (failure) {
			// The draft stays, so a refused name can be fixed rather than
			// retyped.
			setError(describeError(failure, "Could not save that name."));
			setSaving(false);
		}
	};

	// Blank saves as a clear: an empty name is no name, and the server would
	// refuse it as one.
	const submit = () => void save(draft.trim() === "" ? null : draft);

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") submit();
		if (event.key === "Escape") onDone();
	};

	return (
		<div style={{ flex: "1 1 100%", display: "grid", gap: "0.35rem" }}>
			<div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
				<input
					// biome-ignore lint/a11y/noAutofocus: the editor opens because the user asked for it; focus belongs in it.
					autoFocus
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={onKeyDown}
					aria-label={`Name for ${project.key}`}
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? errorId : undefined}
					maxLength={200}
					style={{
						flex: "1 1 12rem",
						padding: "0.35rem 0.5rem",
						background: "var(--ground)",
						color: "var(--ink)",
						border: `2px solid ${error ? PALETTE.borderError : PALETTE.border}`,
						borderRadius: 0,
						fontFamily: "var(--font-body)",
					}}
				/>
				<Button onClick={submit} loading={saving} loadingLabel="Saving…">
					Save
				</Button>
				{current ? (
					<Button variant="ghost" onClick={() => void save(null)}>
						Clear
					</Button>
				) : null}
				<Button variant="ghost" onClick={onDone}>
					Cancel
				</Button>
			</div>
			{error ? (
				<div
					id={errorId}
					role="alert"
					style={{ color: PALETTE.danger, fontSize: "0.85rem" }}
				>
					{error}
				</div>
			) : null}
		</div>
	);
}
