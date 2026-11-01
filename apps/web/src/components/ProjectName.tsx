/**
 * The controls that show a project's name and change it (ONL-189).
 *
 * Shared by the By repository panel on Sessions and the Projects page. Both
 * own which row is being edited and where the labels live; these own only the
 * name, its rename button and the editor.
 */

import { type KeyboardEvent, useState } from "react";
import { describeError } from "../lib/apiErrors";
import { PALETTE } from "./palette";
import { Button } from "./ui";

/** What naming needs of a project: `ProjectRollup` and a listed project both fit. */
export type NamedProject = { key: string; machineId: string | null };

export function RepositoryName({
	project,
	name,
	onEdit,
}: {
	project: NamedProject;
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

export function NameEditor({
	project,
	current,
	onRename,
	onDone,
}: {
	project: NamedProject;
	current: string | null;
	onRename: (project: NamedProject, label: string | null) => Promise<void>;
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
