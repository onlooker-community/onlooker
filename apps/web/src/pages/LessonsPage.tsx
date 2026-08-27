import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet, useMatch } from "react-router-dom";
import { type Lesson, type LessonStatus, listLessons } from "../api/lessonsApi";
import { PALETTE } from "../components/palette";
import { EmptyState, Panel, StatusBadge } from "../components/ui";
import { describeError } from "../lib/apiErrors";
import "./lessons.css";

// The pool, read by a person. A layout route rather than a page: it fetches
// one page of lessons and holds them, and /lessons/:id renders its detail out
// of that list through the Outlet context - so clicking down the left column
// issues no requests at all. The list returns full bodies for exactly this
// reason. See the design's Section 5.
//
// Selection is a ROUTE and not component state. Making it state would cost the
// back button, deep links, and any ability to paste someone a lesson. It is
// also what lets one breakpoint serve both widths: narrow shows the list at
// /lessons and the detail at /lessons/:id, rather than needing a second layout.

/** What the detail pane reads off the Outlet. */
export interface LessonsContext {
	lessons: Lesson[];
	/**
	 * Write a status the server has already accepted into the loaded page, so
	 * the row and the detail agree without a refetch. Not an optimistic
	 * update - the only caller runs it after the round-trip returns.
	 */
	patchLesson: (id: string, status: LessonStatus) => void;
}

const row = {
	display: "block",
	padding: "0.75rem",
	borderBottom: `2px solid ${PALETTE.border}`,
	textDecoration: "none",
	color: "var(--ink)",
};

/**
 * An instant, rendered so its value survives being read by a machine.
 * `toLocaleDateString` alone would make any assertion about it depend on the
 * runner's locale. Same call MachinesPage makes.
 */
function When({ iso }: { iso: string }) {
	return (
		<time dateTime={iso} style={{ color: PALETTE.muted, fontSize: "0.8rem" }}>
			{new Date(iso).toLocaleDateString()}
		</time>
	);
}

export default function LessonsPage() {
	const [lessons, setLessons] = useState<Lesson[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	// Which pane the narrow layout should show. The layout route does not
	// receive the child's params, so the path is matched directly.
	const detail = useMatch("/lessons/:id");

	const load = useCallback(async () => {
		setLoadError(null);
		try {
			const page = await listLessons();
			setLessons(page.lessons);
		} catch (error) {
			setLessons(null);
			setLoadError(describeError(error, "Could not load the pool."));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const patchLesson = useCallback((id: string, status: LessonStatus) => {
		setLessons((current) =>
			current === null
				? current
				: current.map((lesson) =>
						lesson.id === id ? { ...lesson, status } : lesson,
					),
		);
	}, []);

	const context: LessonsContext = { lessons: lessons ?? [], patchLesson };

	return (
		<div className="lessons-layout" data-pane={detail ? "detail" : "list"}>
			<div className="lessons-list">
				{loadError ? (
					<EmptyState
						title="Could not load the pool"
						action={{ label: "Retry", onClick: () => void load() }}
					>
						{loadError}
					</EmptyState>
				) : lessons === null ? (
					<p style={{ color: PALETTE.muted }}>Loading the pool...</p>
				) : lessons.length === 0 ? (
					<EmptyState title="Nothing has synced yet">
						Lessons arrive when a machine pushes them.{" "}
						{/*
						  A link and not EmptyState's action button. The button
						  is for Retry; one that navigated would read as an
						  action and be a link wearing the wrong control.
						*/}
						<NavLink to="/machines" style={{ color: PALETTE.accent }}>
							Connect a machine
						</NavLink>{" "}
						to start.
					</EmptyState>
				) : (
					<Panel title="The pool">
						<nav aria-label="Lessons">
							{lessons.map((lesson) => (
								// NavLink, not Link: it sets aria-current="page" on the
								// selected one, which is the only thing telling a screen
								// reader which row the detail pane is showing.
								<NavLink
									key={lesson.id}
									to={`/lessons/${lesson.id}`}
									style={({ isActive }) => ({
										...row,
										background: isActive ? "var(--panel)" : "transparent",
										borderLeft: isActive
											? `4px solid ${PALETTE.accent}`
											: "4px solid transparent",
									})}
								>
									<span style={{ display: "block", marginBottom: "0.35rem" }}>
										{lesson.claim}
									</span>
									<span
										style={{
											display: "flex",
											gap: "0.5rem",
											alignItems: "center",
										}}
									>
										<StatusBadge status={lesson.status} />
										<When iso={lesson.promoted_at} />
									</span>
								</NavLink>
							))}
						</nav>
					</Panel>
				)}
			</div>

			<div className="lessons-detail">
				{detail ? (
					<Outlet context={context} />
				) : (
					<Panel>
						<p style={{ margin: 0, color: PALETTE.muted }}>
							Select a lesson to read its rationale and evidence.
						</p>
					</Panel>
				)}
			</div>
		</div>
	);
}
