import type { ProjectEntry } from "../lib/projectEntries";
import { Icon } from "./Icon";
import { PALETTE } from "./palette";

/**
 * Narrows a page to one project by name (ONL-209).
 *
 * A native select, as LessonsPage's status filter is: the control a keyboard
 * and a screen reader already know how to drive.
 */
export default function ProjectFilter({
	entries,
	value,
	onChange,
}: {
	entries: ProjectEntry[];
	/** The selected entry's name, or null for every project. */
	value: string | null;
	onChange: (name: string | null) => void;
}) {
	return (
		<div>
			<label
				htmlFor="project-filter"
				style={{
					display: "flex",
					alignItems: "center",
					gap: "var(--space-1)",
					marginBottom: "0.35rem",
					fontFamily: "var(--font-data)",
					fontSize: "var(--text-data-sm)",
					letterSpacing: "1px",
					textTransform: "uppercase",
					color: PALETTE.muted,
				}}
			>
				<Icon name="MagnifyingGlass" />
				Project
			</label>
			<select
				id="project-filter"
				value={value ?? ""}
				onChange={(event) => onChange(event.target.value || null)}
				style={{
					padding: "0.4rem 0.5rem",
					background: "var(--ground)",
					color: "var(--ink)",
					border: `2px solid ${PALETTE.border}`,
					borderRadius: 0,
					fontFamily: "var(--font-body)",
				}}
			>
				<option value="">All projects</option>
				{entries.map((entry) => (
					<option key={entry.name} value={entry.name}>
						{entry.name}
					</option>
				))}
			</select>
		</div>
	);
}
