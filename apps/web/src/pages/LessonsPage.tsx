import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useMatch } from "react-router-dom";
import { type Lesson, type LessonStatus, listLessons } from "../api/lessonsApi";
import { PALETTE } from "../components/palette";
import { EmptyState, Panel, StatusBadge } from "../components/ui";
import { When } from "../components/When";
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
	 * Whether the first load attempt has finished - successfully or not.
	 *
	 * The distinction the detail pane needs is not "is the list empty" but
	 * "has the list been asked yet." Without this, an id that IS in the pool
	 * still fires the fallback fetch on a cold mount, because effects run
	 * child-first and the detail asks before the list has started loading -
	 * which defeats the reason the list returns full bodies at all.
	 *
	 * True even when the load FAILED, so a deep link still falls back to
	 * GET /api/lessons/:id rather than hanging on a pool that never arrived.
	 */
	poolSettled: boolean;
	/**
	 * Write a status the server has already accepted into the loaded page, so
	 * the row and the detail agree without a refetch. Not an optimistic
	 * update - the only caller runs it after the round-trip returns.
	 */
	patchLesson: (id: string, status: LessonStatus) => void;
}

/**
 * Status filtering ships; stack filtering does not.
 *
 * Not a matter of effort. `status` is a real column with a real index, so the
 * server can answer it across the whole pool. Stack lives inside the JSON
 * body, and filtering it in the browser would filter one loaded page and call
 * it the pool - which is wrong the moment a second page exists. Deferred
 * whole rather than shipped shrunk: onlooker-4bw.
 */
const FILTERS: { value: "" | LessonStatus; label: string; empty?: string }[] = [
	// "All" carries no `empty`: an unfiltered pool with nothing in it is the
	// empty POOL, which says something else entirely.
	{ value: "", label: "All" },
	{ value: "active", label: "Active", empty: "No active lessons" },
	{ value: "retracted", label: "Retracted", empty: "No retracted lessons" },
	{ value: "refuted", label: "Refuted", empty: "No refuted lessons" },
	{ value: "superseded", label: "Superseded", empty: "No superseded lessons" },
];

const row = {
	display: "block",
	padding: "0.75rem",
	borderBottom: `2px solid ${PALETTE.border}`,
	textDecoration: "none",
	color: "var(--ink)",
};

export default function LessonsPage() {
	const [lessons, setLessons] = useState<Lesson[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	// Whether the CURRENT load attempt has settled - guarded below so a
	// superseded request cannot flip it early, and never reset back to false
	// once true. A status filter re-runs `load()`, and if the new filter
	// excludes the lesson the detail pane has open, `listed` goes null - but
	// LessonDetail mirrors that lesson into its own state the last time it
	// WAS listed, so this staying true lets its fetch guard see that mirrored
	// copy instead of treating the pool as unasked again and re-fetching a
	// lesson it is already showing.
	const [poolSettled, setPoolSettled] = useState(false);
	const [filter, setFilter] = useState<"" | LessonStatus>("");

	// Which request is newest. Two filter changes inside one round-trip issue
	// two requests, and without this whichever SETTLES last would win rather
	// than whichever was ASKED last - leaving the select reading one status
	// while the list shows another. A stale rejection is worse still: it
	// would blank a list a newer request had already filled.
	const requestSeq = useRef(0);

	// Which pane the narrow layout should show. The layout route does not
	// receive the child's params, so the path is matched directly.
	const detail = useMatch("/lessons/:id");

	const load = useCallback(async () => {
		const seq = ++requestSeq.current;
		setLoadError(null);
		try {
			const page = await listLessons(filter ? { statuses: [filter] } : {});
			if (seq !== requestSeq.current) return;
			setLessons(page.lessons);
		} catch (error) {
			if (seq !== requestSeq.current) return;
			setLessons(null);
			setLoadError(describeError(error, "Could not load the pool."));
		} finally {
			// Guarded too: if a superseded request settles while the newest is
			// still in flight, flipping this to true would tell the detail pane
			// the pool is settled while `lessons` is still empty - and it would
			// conclude an id is absent and fetch a lesson that is about to
			// arrive.
			if (seq === requestSeq.current) setPoolSettled(true);
		}
	}, [filter]);

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

	const context: LessonsContext = {
		lessons: lessons ?? [],
		poolSettled,
		patchLesson,
	};

	return (
		<div className="lessons-layout" data-pane={detail ? "detail" : "list"}>
			<div className="lessons-list">
				<div style={{ marginBottom: "1rem" }}>
					<label
						htmlFor="lesson-status"
						style={{
							display: "block",
							marginBottom: "0.35rem",
							fontFamily: "var(--font-display)",
							fontSize: "12px",
							letterSpacing: "1px",
							textTransform: "uppercase",
							color: PALETTE.muted,
						}}
					>
						Status
					</label>
					{/*
					  A native select rather than a new form primitive. One
					  filter does not justify a SelectField in form.tsx, and the
					  native control is what a screen reader and a keyboard
					  already know how to drive.
					*/}
					<select
						id="lesson-status"
						value={filter}
						onChange={(event) =>
							setFilter(event.target.value as "" | LessonStatus)
						}
						style={{
							padding: "0.4rem 0.5rem",
							background: "var(--ground)",
							color: "var(--ink)",
							border: `2px solid ${PALETTE.border}`,
							borderRadius: 0,
							fontFamily: "var(--font-body)",
						}}
					>
						{FILTERS.map((option) => (
							<option key={option.value || "all"} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</div>
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
					filter ? (
						// An empty FILTER result and an empty POOL say different
						// things. Telling someone whose pool is full to "connect a
						// machine" because they filtered to a status nothing holds
						// would be a lie, and the kind that makes a person doubt
						// everything else the page says.
						<EmptyState
							title={
								FILTERS.find((o) => o.value === filter)?.empty ?? "No lessons"
							}
						>
							Nothing in the pool holds that status right now.
						</EmptyState>
					) : (
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
					)
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
										<When
											iso={lesson.promoted_at}
											style={{ color: PALETTE.muted, fontSize: "0.8rem" }}
										/>
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
