import { useEffect, useState } from "react";
import {
	type LabelMap,
	labelIdentity,
	listLabels,
	setLabel,
} from "../api/labelsApi";
import { listMachines, type Machine } from "../api/machinesApi";
import { listProjects, type Project } from "../api/projectsApi";
import {
	type NamedProject,
	NameEditor,
	RepositoryName,
} from "../components/ProjectName";
import { PALETTE } from "../components/palette";
import { EmptyState, Loading, Panel } from "../components/ui";
import { When } from "../components/When";
import { describeError } from "../lib/apiErrors";
import { plural } from "../lib/sessionRollup";

// Every project key the server knows, with the user's name for it (ONL-209).
// Sessions names the keys among its loaded sessions; this lists them all, so
// a key can be found and renamed without first finding a session that used it.

/** A row's identity, matching how a label is scoped. */
function rowKey(project: Project): string {
	return `${project.machine_id ?? ""}:${project.project_key}`;
}

/** What naming needs of a listed project. */
function namedOf(project: Project): NamedProject {
	return { key: project.project_key, machineId: project.machine_id };
}

/**
 * Where a key was seen. A root key hashes a local path, so it names a
 * repository only on the machine that reported it; saying which machine keeps
 * it from reading as portable as a remote key.
 */
function seenOn(project: Project, machines: Machine[] | null): string {
	if (project.basis === "remote") return "Every machine";
	if (project.basis === null) return "Seen on a lesson";
	const name = machines?.find((m) => m.id === project.machine_id)?.name;
	return `${name ?? "one machine"} only`;
}

export default function ProjectsPage() {
	const [projects, setProjects] = useState<Project[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	// Null until read, and null if the read fails: a root key then says "one
	// machine", as Sessions does. Nothing on the page is wrong without them.
	const [machines, setMachines] = useState<Machine[] | null>(null);
	// Empty until read, and empty if the read fails: every key shows as itself.
	const [labels, setLabels] = useState<LabelMap>(new Map());
	const [editing, setEditing] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		listProjects()
			.then((loaded) => {
				if (active) setProjects(loaded.projects);
			})
			.catch((error: unknown) => {
				if (!active) return;
				setLoadError(describeError(error, "Could not load your projects."));
			});
		listLabels()
			.then((loaded) => {
				if (active) setLabels(loaded);
			})
			.catch(() => {
				// Deliberately quiet; see the state's own comment.
			});
		listMachines()
			.then((loaded) => {
				if (active) setMachines(loaded.machines);
			})
			.catch(() => {
				// Deliberately quiet; see the state's own comment.
			});
		return () => {
			active = false;
		};
	}, []);

	// Applies what the server stored - trimmed - rather than what was typed,
	// and only once it is stored: a refused name never shows as if it took.
	const rename = async (project: NamedProject, label: string | null) => {
		const stored = await setLabel(project.key, project.machineId, label);
		setLabels((current) => {
			const next = new Map(current);
			const identity = labelIdentity(project.key, project.machineId);
			if (stored === null) next.delete(identity);
			else next.set(identity, stored);
			return next;
		});
	};

	if (loadError) {
		return (
			<div style={{ maxWidth: "640px" }}>
				<EmptyState title="Could not load your projects">
					{loadError}
				</EmptyState>
			</div>
		);
	}

	if (projects === null) return <Loading label="Loading your projects…" />;

	if (projects.length === 0) {
		return (
			<div style={{ maxWidth: "640px" }}>
				<EmptyState title="No projects yet">
					A project appears here once a machine reports a session in a
					repository.
				</EmptyState>
			</div>
		);
	}

	return (
		<div style={{ maxWidth: "640px" }}>
			<Panel title="Your projects" icon="Document">
				<ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
					{projects.map((project) => {
						const named = namedOf(project);
						const name =
							labels.get(labelIdentity(named.key, named.machineId)) ?? null;
						return (
							<li
								key={rowKey(project)}
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
										project={named}
										current={name}
										onRename={rename}
										onDone={() => setEditing(null)}
									/>
								) : (
									<RepositoryName
										project={named}
										name={name}
										onEdit={() => setEditing(rowKey(project))}
									/>
								)}
								{/* RepositoryName already shows the key when there is no name. */}
								{name ? (
									<span
										style={{
											flex: "none",
											fontFamily: "var(--font-data)",
											color: PALETTE.muted,
										}}
									>
										{project.project_key}
									</span>
								) : null}
								<span style={{ flex: "none", color: PALETTE.muted }}>
									{seenOn(project, machines)}
								</span>
								<span style={{ marginLeft: "auto", color: PALETTE.muted }}>
									{plural(project.sessions, "session")} ·{" "}
									{plural(project.events, "event")}
									{project.last_seen_at ? (
										<>
											{" "}
											· Last seen <When iso={project.last_seen_at} />
										</>
									) : null}
								</span>
							</li>
						);
					})}
				</ul>
			</Panel>
		</div>
	);
}
