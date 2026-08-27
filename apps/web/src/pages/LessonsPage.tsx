import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useMatch } from "react-router-dom";
import { type Lesson, type LessonStatus, listLessons } from "../api/lessonsApi";
import { PALETTE } from "../components/palette";
import { Button, EmptyState, Panel, StatusBadge } from "../components/ui";
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
	 * Whether any load attempt has ever settled - successfully or not. Not
	 * "the current one has settled": once true it stays true, including
	 * while a later filter's load is still in flight.
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
	// Whether any load attempt has ever settled - guarded below so a
	// superseded request cannot flip it early, and never reset back to false
	// once true - so this is NOT "the current load has settled": a status
	// filter re-runs `load()`, and if the new filter excludes the lesson the
	// detail pane has open, `listed` goes null - but LessonDetail mirrors
	// that lesson into its own state the last time it WAS listed, so this
	// staying true lets its fetch guard see that mirrored copy instead of
	// treating the pool as unasked again and re-fetching a lesson it is
	// already showing.
	const [poolSettled, setPoolSettled] = useState(false);
	const [filter, setFilter] = useState<"" | LessonStatus>("");
	// Cleared by `load()` the moment a new query starts, not once it resolves
	// - see the comment there. That still leaves one painted frame between a
	// filter change and the effect that calls `load()` running, because
	// `useEffect` is passive: React commits the `filter` state and the DOM it
	// produces first, THEN runs effects. Closing that fully would mean
	// storing the cursor together with the sequence number that minted it
	// (`useState<{ value: string; seq: number } | null>`) so a stale render
	// could be told apart from a current one without waiting on an effect at
	// all. Considered and left out: one frame is not the hundreds of
	// milliseconds a round-trip takes, and nothing here can be clicked
	// without user input landing inside a real frame to begin with.
	const [cursor, setCursor] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const [moreError, setMoreError] = useState<string | null>(null);

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
		setMoreError(null);
		// A new query starts over: any in-flight loadMore belongs to the query
		// being replaced, and any cursor left over from it names a boundary
		// this query never established. Cleared here, synchronously, rather
		// than waiting for this load to resolve - otherwise the OLD "Load
		// more" button stays mounted and clickable for the whole round-trip,
		// and a click during that window would send the NEW filter paired
		// with the OLD cursor.
		setCursor(null);
		// `loadingMore` clears here too, for the same reason: the OLD
		// loadMore's flight is not THIS query's concern. Without this, a
		// filter change made while a loadMore was outstanding would remount
		// "Load more" - once this query's own page arrives with more to give
		// - already reading "Loading..." and disabled, for a request nobody
		// watching it ever started. It would stay that way until the stale
		// request finally settles, which client.ts's retries can stretch to
		// ~45s. The matching guard lives in loadMore's `finally`, below.
		setLoadingMore(false);
		try {
			const page = await listLessons(filter ? { statuses: [filter] } : {});
			if (seq !== requestSeq.current) return;
			setLessons(page.lessons);
			// `has_more` and not `cursor !== null`, because those are two facts
			// and only one of them is the question being asked - even though,
			// today, they always agree. `listLessonsPage` derives `hasMore` as
			// `rows.length > limit`, which guarantees a defined `last` row
			// whenever it is true, so the pool cannot currently answer
			// `has_more: true` with `cursor: null`. That guarantee is asserted
			// nowhere, though - if it ever broke, this line would silently drop
			// the tail, since reading `page.cursor` here behaves identically to
			// reading `cursor !== null` under exactly the disagreement this
			// comment defends against. The fix belongs where the pairing is
			// produced - an assertion in `listLessonsPage` - not as a client
			// branch defending against a shape the server cannot currently send.
			setCursor(page.has_more ? page.cursor : null);
		} catch (error) {
			if (seq !== requestSeq.current) return;
			setLessons(null);
			setCursor(null);
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

	const loadMore = async () => {
		if (!cursor || loadingMore) return;
		// Not `++requestSeq.current`: loadMore continues the query load() most
		// recently started rather than starting a new one, so it reads the
		// current sequence number instead of minting the next one. Comparing
		// against it below is what lets a filter change - which DOES increment
		// this - discard a page that lands after the query it belonged to has
		// already been replaced.
		//
		// Defensive rather than load-bearing now that `load()` clears `cursor`
		// synchronously: the button that starts a loadMore disappears the
		// instant a new query begins, so no loadMore can even be INITIATED
		// while a load() is in flight, and which of the two bumps the counter
		// stops being something either path can observe. Left in place because
		// it is still the semantically correct shape - loadMore continues a
		// query, it does not start one - and because that guarantee lives in
		// render timing, not in this function.
		const seq = requestSeq.current;
		setLoadingMore(true);
		setMoreError(null);
		try {
			// The filter travels with the cursor. A cursor is a position within
			// ONE query's ordering, so paging with a different filter than the
			// one that minted it walks a boundary that query never established.
			const page = await listLessons({
				...(filter ? { statuses: [filter] } : {}),
				cursor,
			});
			if (seq !== requestSeq.current) return;
			setLessons((current) => [...(current ?? []), ...page.lessons]);
			setCursor(page.has_more ? page.cursor : null);
		} catch (error) {
			if (seq !== requestSeq.current) return;
			// The pages already loaded stay. A failed append is a missing tail,
			// not a reason to throw away what the person is reading.
			setMoreError(describeError(error, "Could not load more lessons."));
		} finally {
			// Guarded: `load()` clearing `loadingMore` synchronously (above)
			// means a second loadMore can start - and set this flag true again
			// - while THIS call, the superseded one, is still out there settling
			// late. An unconditional clear here would end that second, genuinely
			// in-flight request's loading state early: re-enabling the button
			// mid-request and risking a duplicate append of the very page it is
			// already fetching.
			if (seq === requestSeq.current) setLoadingMore(false);
		}
	};

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

						{cursor ? (
							<div style={{ marginTop: "1rem" }}>
								<Button
									loading={loadingMore}
									loadingLabel="Loading..."
									onClick={() => void loadMore()}
								>
									Load more
								</Button>
							</div>
						) : null}

						{moreError ? (
							<p role="alert" style={{ color: PALETTE.danger }}>
								{moreError}
							</p>
						) : null}
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
