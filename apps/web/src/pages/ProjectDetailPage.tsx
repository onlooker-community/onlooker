import { useEffect, useState } from "react";
import { NavLink, useParams, useSearchParams } from "react-router-dom";
import {
	type LabelMap,
	labelIdentity,
	listLabels,
	setLabel,
} from "../api/labelsApi";
import { type Lesson, listLessons } from "../api/lessonsApi";
import { listMachines, type Machine } from "../api/machinesApi";
import { listProjects, type Project } from "../api/projectsApi";
import { listSessions, type SessionSummary } from "../api/sessionsApi";
import {
	type NamedProject,
	NameEditor,
	RepositoryName,
} from "../components/ProjectName";
import { PALETTE } from "../components/palette";
import StatBand from "../components/StatBand";
import {
	EmptyState,
	Lead,
	LeadValue,
	Loading,
	Panel,
	StatusBadge,
} from "../components/ui";
import { When } from "../components/When";
import { describeError } from "../lib/apiErrors";
import { sessionFilterValue } from "../lib/projectPath";
import { durationMsOf, formatDurationMs, plural } from "../lib/sessionRollup";

// One project, on its own page: what the server saw of it, its recent
// sessions, and the lessons that apply to it. Reached from the Projects list.
// A root key is only meaningful on the machine that reported it, so the
// route carries `?machine=` for those (see lib/projectPath.ts).

/** How many of each to show. The full lists live on Sessions and Lessons. */
const RECENT = 8;

type Read<T> =
	| { kind: "pending" }
	| { kind: "ready"; value: T }
	| { kind: "failed"; message: string };

function useRead<T>(
	load: () => Promise<T>,
	fallback: string,
	deps: unknown[],
): Read<T> {
	const [read, setRead] = useState<Read<T>>({ kind: "pending" });
	// biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's.
	useEffect(() => {
		let active = true;
		setRead({ kind: "pending" });
		load()
			.then((value) => {
				if (active) setRead({ kind: "ready", value });
			})
			.catch((error: unknown) => {
				if (active)
					setRead({ kind: "failed", message: describeError(error, fallback) });
			});
		return () => {
			active = false;
		};
	}, deps);
	return read;
}

function seenOn(project: Project, machines: Machine[] | null): string {
	if (project.basis === "remote") return "every machine";
	if (project.basis === null) return "a lesson only";
	const name = machines?.find((m) => m.id === project.machine_id)?.name;
	return `${name ?? "one machine"} only`;
}

function sessionLine(session: SessionSummary): string {
	const ms = durationMsOf(session);
	const duration = session.ended_at
		? ms === null
			? ""
			: formatDurationMs(ms)
		: "Still running";
	return [duration, plural(session.prompts, "prompt")]
		.filter(Boolean)
		.join(" · ");
}

export default function ProjectDetailPage() {
	const { key = "" } = useParams();
	const [search] = useSearchParams();
	const machineId = search.get("machine");

	const projects = useRead(
		() => listProjects().then((r) => r.projects),
		"Could not load this project.",
		[],
	);
	const sessions = useRead(
		() =>
			listSessions({
				limit: RECENT,
				project: [sessionFilterValue(key, machineId)],
			}),
		"Could not load this project's sessions.",
		[key, machineId],
	);
	const lessons = useRead(
		() => listLessons({ limit: RECENT, project: [key] }),
		"Could not load this project's lessons.",
		[key],
	);
	// Quiet failures, as on the list: nothing here is wrong without them.
	const [machines, setMachines] = useState<Machine[] | null>(null);
	const [labels, setLabels] = useState<LabelMap>(new Map());
	const [labelsSettled, setLabelsSettled] = useState(false);
	const [editing, setEditing] = useState(false);

	useEffect(() => {
		let active = true;
		listMachines()
			.then((loaded) => {
				if (active) setMachines(loaded.machines);
			})
			.catch(() => {});
		listLabels()
			.then((loaded) => {
				if (!active) return;
				setLabels(loaded);
				setLabelsSettled(true);
			})
			.catch(() => {
				if (active) setLabelsSettled(true);
			});
		return () => {
			active = false;
		};
	}, []);

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

	const back = (
		<p style={{ margin: "0 0 var(--space-4)" }}>
			<NavLink to="/projects" style={{ color: PALETTE.accent }}>
				← All projects
			</NavLink>
		</p>
	);

	if (projects.kind === "failed") {
		return (
			<div>
				{back}
				<EmptyState title="Could not load this project">
					{projects.message}
				</EmptyState>
			</div>
		);
	}
	if (projects.kind === "pending" || !labelsSettled) {
		return <Loading label="Loading this project…" />;
	}

	const project = projects.value.find(
		(p) => p.project_key === key && p.machine_id === machineId,
	);
	if (!project) {
		return (
			<div>
				{back}
				<EmptyState title="No such project">
					No project with this key has reported anything to your account.
				</EmptyState>
			</div>
		);
	}

	const named: NamedProject = { key: project.project_key, machineId };
	const name = labels.get(labelIdentity(key, machineId)) ?? null;

	const lessonList: Lesson[] =
		lessons.kind === "ready" ? lessons.value.lessons : [];
	const lessonMore = lessons.kind === "ready" && lessons.value.has_more;
	const lessonCount =
		lessons.kind === "ready"
			? `${lessonList.length.toLocaleString()}${lessonMore ? "+" : ""}`
			: "—";

	return (
		<div>
			{back}
			<div
				style={{
					display: "flex",
					flexWrap: "wrap",
					alignItems: "baseline",
					gap: "var(--space-3)",
					marginBottom: "var(--space-3)",
					fontSize: "var(--text-body-lg)",
					fontWeight: 700,
					color: "var(--ink-hi)",
				}}
			>
				{editing ? (
					<NameEditor
						project={named}
						current={name}
						onRename={rename}
						onDone={() => setEditing(false)}
					/>
				) : (
					<RepositoryName
						project={named}
						name={name}
						onEdit={project.basis === null ? undefined : () => setEditing(true)}
					/>
				)}
			</div>
			{name ? (
				<p
					style={{
						margin: "0 0 var(--space-4)",
						fontFamily: "var(--font-data)",
						fontSize: "0.85em",
						color: PALETTE.muted,
					}}
				>
					{project.project_key}
				</p>
			) : null}

			<Lead testId="project-headline">
				Seen on {seenOn(project, machines)}:{" "}
				<LeadValue>{plural(project.sessions, "session")}</LeadValue> and{" "}
				<LeadValue>{plural(project.events, "event")}</LeadValue>
				{project.last_seen_at ? (
					<>
						, last on <When iso={project.last_seen_at} />
					</>
				) : null}
				.
			</Lead>

			<StatBand
				label="This project in numbers"
				stats={[
					{ value: project.sessions.toLocaleString(), label: "sessions" },
					{ value: project.events.toLocaleString(), label: "events" },
					{ value: lessonCount, label: "lessons" },
				]}
			/>

			<div style={{ marginTop: "var(--space-7)" }}>
				<Panel title="Recent sessions" icon="Monitor" open>
					{sessions.kind === "pending" ? (
						<Loading label="Loading sessions…" />
					) : sessions.kind === "failed" ? (
						<p role="alert" style={{ margin: 0, color: PALETTE.danger }}>
							{sessions.message}
						</p>
					) : sessions.value.sessions.length === 0 ? (
						<p style={{ margin: 0, color: PALETTE.muted }}>
							No sessions have reported this project yet.
						</p>
					) : (
						<>
							<ul
								data-testid="project-sessions"
								style={{ margin: 0, padding: 0, listStyle: "none" }}
							>
								{sessions.value.sessions.map((session) => (
									<li
										key={`${session.machine_id}:${session.session_id}`}
										style={{
											display: "flex",
											flexWrap: "wrap",
											alignItems: "baseline",
											gap: "var(--space-1) var(--space-4)",
											padding: "var(--space-3) 0",
											borderBottom: `2px solid ${PALETTE.border}`,
										}}
									>
										<span style={{ fontWeight: 700, color: "var(--ink-hi)" }}>
											{new Date(session.started_at).toLocaleString()}
										</span>
										<span style={{ color: PALETTE.muted }}>
											{machines?.find((m) => m.id === session.machine_id)
												?.name ?? "unknown machine"}
										</span>
										<span style={{ marginLeft: "auto" }}>
											{sessionLine(session)}
										</span>
									</li>
								))}
							</ul>
							<p style={{ margin: "var(--space-4) 0 0" }}>
								<NavLink to="/sessions" style={{ color: PALETTE.accent }}>
									All sessions
								</NavLink>
							</p>
						</>
					)}
				</Panel>

				<Panel title="Lessons" icon="Basket" open>
					{lessons.kind === "pending" ? (
						<Loading label="Loading lessons…" />
					) : lessons.kind === "failed" ? (
						<p role="alert" style={{ margin: 0, color: PALETTE.danger }}>
							{lessons.message}
						</p>
					) : lessonList.length === 0 ? (
						<p style={{ margin: 0, color: PALETTE.muted }}>
							No lessons apply to this project yet.
						</p>
					) : (
						<>
							<ul
								data-testid="project-lessons"
								style={{ margin: 0, padding: 0, listStyle: "none" }}
							>
								{lessonList.map((lesson) => (
									<li
										key={lesson.id}
										style={{
											display: "flex",
											flexWrap: "wrap",
											alignItems: "baseline",
											gap: "var(--space-2) var(--space-4)",
											padding: "var(--space-3) 0",
											borderBottom: `2px solid ${PALETTE.border}`,
										}}
									>
										<NavLink
											to={`/lessons/${lesson.id}`}
											style={{
												flex: "1 1 24rem",
												color: "var(--ink)",
												lineHeight: 1.5,
											}}
										>
											{lesson.claim}
										</NavLink>
										<StatusBadge status={lesson.status} />
									</li>
								))}
							</ul>
							<p style={{ margin: "var(--space-4) 0 0" }}>
								<NavLink to="/lessons" style={{ color: PALETTE.accent }}>
									All lessons
								</NavLink>
								{lessonMore ? " (more than shown)" : ""}
							</p>
						</>
					)}
				</Panel>
			</div>
		</div>
	);
}
