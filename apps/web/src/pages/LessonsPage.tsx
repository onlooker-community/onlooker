import { useEffect, useRef, useState } from "react";
import { NavLink, useOutlet } from "react-router-dom";
import { type LabelMap, listLabels } from "../api/labelsApi";
import type { Lesson, LessonStatus, RetractableOrg } from "../api/lessonsApi";
import { listProjects, type Project } from "../api/projectsApi";
import { Icon } from "../components/Icon";
import { LoadMore } from "../components/LoadMore";
import ProjectFilter from "../components/ProjectFilter";
import { PALETTE } from "../components/palette";
import {
	Button,
	Chip,
	EmptyState,
	Panel,
	Plate,
	STATUS_ICONS,
	StatusBadge,
} from "../components/ui";
import { When } from "../components/When";
import { useLessonPool } from "../hooks/useLessonPool";
import { entryKeys, projectEntries } from "../lib/projectEntries";
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
	 * Which of `lessons` the signed-in account owns, by id.
	 *
	 * The pool returns other people's public lessons once the push tier opens,
	 * and the write path stays owner-scoped, so the detail pane needs this to
	 * decide whether to offer a status control at all. Accumulated across
	 * pages exactly like `lessons`, so the two never disagree about a row.
	 */
	ownedIds: string[];
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
	/**
	 * The names of the authors of the org lessons on this page, by lesson id.
	 *
	 * Carried beside the documents for the reason `ownedIds` is: a lesson
	 * body is the published contract's shape and nothing server-computed
	 * belongs in it. A key is absent when the author has no name set - the
	 * server does not invent a label, and neither does this page.
	 *
	 * Accumulated across pages exactly like `ownedIds`, so the two never
	 * disagree about a row.
	 */
	authors: Record<string, string>;
	/**
	 * Which org, if any, the signed-in account may retract each org lesson
	 * in, by lesson id.
	 *
	 * The server decides what the caller may act on; this page renders what
	 * it is handed rather than re-deriving ownership or membership. Carried
	 * beside the documents for the reason `authors` is, and accumulated
	 * across pages exactly like it, so the two never disagree about a row.
	 */
	retractableIn: Record<string, RetractableOrg>;
	/**
	 * Which of `lessons` had an author whose account has since been
	 * anonymized, by id.
	 *
	 * Carried beside the documents for the reason `authors` is: a lesson
	 * body is the published contract's shape and nothing server-computed
	 * belongs in it. The label this renders as ("Former member") is this
	 * client's wording, never the server's - a literal in a name field
	 * cannot be told apart from a member who set that as their actual name.
	 *
	 * Accumulated across pages exactly like `authors`, so the two never
	 * disagree about a row.
	 */
	formerAuthors: string[];
	/**
	 * The viewer's names for project keys, as Sessions sets them (ONL-189).
	 *
	 * Read once rather than per page: a label belongs to the viewer, not to a
	 * lesson, so nothing about paging or a filter changes it. Empty until
	 * read and empty if the read fails, and every key then shows as itself.
	 */
	labels: LabelMap;
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

// No project selected. The hook only reads the keys' contents, but one
// constant keeps a render from handing it a new array it has to join again.
const NO_KEYS: readonly string[] = [];

const row = {
	display: "flex",
	gap: "var(--space-3)",
	alignItems: "center",
	padding: "var(--space-3)",
	borderBottom: `2px solid ${PALETTE.border}`,
	textDecoration: "none",
	color: "var(--ink)",
};

export default function LessonsPage() {
	// Not part of the pool's query, so not in useLessonPool: see the context
	// field's comment.
	const [labels, setLabels] = useState<LabelMap>(new Map());
	const [filter, setFilter] = useState<"" | LessonStatus>("");
	// Empty until read, and empty if the read fails: the control then doesn't
	// show, and the page is what it was without one.
	const [projects, setProjects] = useState<Project[]>([]);
	// A name rather than an entry, so a rename that regroups keys can't leave a
	// stale set of keys behind.
	const [selected, setSelected] = useState<string | null>(null);
	// Set when the notice is pressed, read once the new page lands. The press
	// unmounts the button, which leaves focus on <body>; the first row is where
	// the reader was headed. Same rule as LoadMore: only when focus really was
	// lost, so a reader who moved on is left where they went.
	const focusFirstRow = useRef(false);
	const navRef = useRef<HTMLElement | null>(null);

	const entries = projectEntries(projects, labels);
	const entry = entries.find((option) => option.name === selected) ?? null;
	const {
		lessons,
		ownedIds,
		authors,
		retractableIn,
		formerAuthors,
		loadError,
		poolSettled,
		cursor,
		loadingMore,
		moreError,
		ended,
		fresh,
		reload,
		loadMore,
		patchLesson,
	} = useLessonPool(filter, entry ? entryKeys(entry) : NO_KEYS);

	useEffect(() => {
		if (!focusFirstRow.current || lessons === null) return;
		focusFirstRow.current = false;
		if (document.activeElement !== document.body) return;
		navRef.current?.querySelector("a")?.focus();
	}, [lessons]);

	// Its own effect, for the labels' reason and one more: a failure here
	// must never blank the pool.
	useEffect(() => {
		let active = true;
		listProjects()
			.then(({ projects: loaded }) => {
				if (active) setProjects(loaded);
			})
			.catch(() => {
				// Deliberately quiet: the page works without the control.
			});
		return () => {
			active = false;
		};
	}, []);

	// Its own effect rather than part of load(), so a filter change does not
	// reread it and a failure here never blanks a pool that loaded fine -
	// SessionsPage keeps the same read apart for the same reason.
	useEffect(() => {
		let active = true;
		listLabels()
			.then((loaded) => {
				if (active) setLabels(loaded);
			})
			.catch(() => {
				// Deliberately quiet: a key shown as itself is not wrong.
			});
		return () => {
			active = false;
		};
	}, []);

	const context: LessonsContext = {
		lessons: lessons ?? [],
		ownedIds,
		poolSettled,
		patchLesson,
		authors,
		retractableIn,
		formerAuthors,
		labels,
	};

	// The matched child, or null when no lesson is open. Asking the router
	// rather than matching "/lessons/:id" here keeps App's route table the one
	// place that path is written: renaming it there used to leave this layout
	// on its placeholder, with the narrow layout hiding the detail entirely
	// (ONL-75).
	const outlet = useOutlet(context);
	const detail = outlet !== null;

	// "N+" when every row on the fresh read was new and there were more: the
	// count is then a floor, and saying exactly N would be a guess.
	const freshCount = fresh ? `${fresh.count}${fresh.more ? "+" : ""}` : null;
	const freshLabel = fresh
		? fresh.count === 1 && !fresh.more
			? "1 new lesson, show it"
			: `${freshCount} new lessons, show them`
		: null;

	// The live region's whole text, computed once rather than duplicated
	// between the region and whatever branch below happens to be showing -
	// the two can say the same thing (an empty state's title, a count) without
	// being the same JSX, since the region has to exist even when the branch
	// it is summarizing does not render its own heading (the loading paragraph,
	// the row list).
	//
	// The empty title has one source for the same reason: the region and the
	// heading below must not disagree about which empty this is. A project
	// names itself ahead of a status, since it is the narrower claim.
	const emptyTitle = entry
		? `No lessons in ${entry.name}`
		: filter
			? (FILTERS.find((option) => option.value === filter)?.empty ??
				"No lessons")
			: "Nothing has synced yet";
	const freshSuffix = freshCount ? ` · ${freshCount} new` : "";
	const resultSummary = loadError
		? "Could not load the pool"
		: lessons === null
			? "Loading the pool…"
			: lessons.length === 0
				? `${emptyTitle}${freshSuffix}`
				: `${lessons.length} lesson${lessons.length === 1 ? "" : "s"}${freshSuffix}`;

	return (
		<div className="lessons-layout" data-pane={detail ? "detail" : "list"}>
			<div className="lessons-list">
				{entries.length > 0 ? (
					<div style={{ marginBottom: "1rem" }}>
						<ProjectFilter
							entries={entries}
							value={entry?.name ?? null}
							onChange={setSelected}
						/>
					</div>
				) : null}
				<div style={{ marginBottom: "1rem" }}>
					<label
						htmlFor="lesson-status"
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
				{/*
				  One persistent region, present in every branch below, rather
				  than a role appearing only on the branches that need it. A
				  screen reader reliably announces content CHANGING inside a
				  region that is already there; a region that appears at the
				  same moment as its own text is not something NVDA, JAWS and
				  VoiceOver agree on. Panel and its <nav> of rows stay outside
				  this element entirely - the region carries a short summary
				  (a count, or the state's own title), never the rows, so a
				  fifty-row pool does not read every claim aloud on a filter
				  change.
				*/}
				<p
					role="status"
					aria-live="polite"
					style={{
						margin: "0 0 var(--space-2)",
						fontFamily: "var(--font-data)",
						fontSize: "var(--text-data-sm)",
						letterSpacing: "1px",
						textTransform: "uppercase",
						color: PALETTE.muted,
					}}
				>
					{resultSummary}
				</p>
				{/*
				  Above every branch, so an empty list shows it too. The hook only
				  sets `fresh` once page 1 is showing without an error, so it
				  cannot appear over the loading or error states.
				*/}
				{freshLabel ? (
					<div style={{ marginBottom: "var(--space-2)" }}>
						<Button
							variant="ghost"
							onClick={() => {
								focusFirstRow.current = true;
								reload();
							}}
						>
							{freshLabel}
						</Button>
					</div>
				) : null}
				{loadError ? (
					<EmptyState
						title="Could not load the pool"
						action={{ label: "Retry", onClick: reload }}
					>
						{loadError}
					</EmptyState>
				) : lessons === null ? (
					// Not <Loading>: the region above already carries the role="status"
					// duty for this exact text - resultSummary reads "Loading the
					// pool…" too while lessons is null - so mounting the primitive's
					// own role="status" paragraph here sat a second live region next
					// to the first, both announcing the same words at once. Same
					// hazard the "load more" retirement message reasons about further
					// down this file, just triggered by mount instead of by a click.
					// This mirrors the primitive's look without a second role.
					<p style={{ color: PALETTE.muted }}>{resultSummary}</p>
				) : lessons.length === 0 ? (
					entry || filter ? (
						// An empty FILTER result and an empty POOL say different
						// things. Telling someone whose pool is full to "connect a
						// machine" because they filtered to a status nothing holds,
						// or a project with no lessons, would be a lie, and the kind
						// that makes a person doubt everything else the page says.
						<EmptyState title={emptyTitle}>
							{entry
								? "Nothing you can read in the pool matches that project."
								: "Nothing in the pool holds that status right now."}
						</EmptyState>
					) : (
						<EmptyState
							title="Nothing has synced yet"
							icon="ChestTreasure"
							tone="teal"
						>
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
						<nav aria-label="Lessons" ref={navRef}>
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
									<Plate
										tone={lesson.status === "active" ? "teal" : "red"}
										icon={STATUS_ICONS[lesson.status]}
									/>
									<span style={{ minWidth: 0, flex: 1 }}>
										<span
											style={{
												display: "block",
												marginBottom: "var(--space-1)",
												fontSize: "var(--text-body-md)",
											}}
										>
											{lesson.claim}
										</span>
										<span
											style={{
												display: "flex",
												gap: "var(--space-2)",
												alignItems: "center",
												flexWrap: "wrap",
											}}
										>
											<StatusBadge status={lesson.status} />
											{lesson.applies_to.stack[0] ? (
												<Chip>{lesson.applies_to.stack[0]}</Chip>
											) : null}
											{authors[lesson.id] ? (
												<span data-testid="lesson-author">
													{authors[lesson.id]}
												</span>
											) : null}
											<When
												iso={lesson.promoted_at}
												style={{
													color: PALETTE.muted,
													fontSize: "var(--text-body-sm)",
												}}
											/>
										</span>
									</span>
								</NavLink>
							))}
						</nav>

						<LoadMore
							cursor={cursor}
							loading={loadingMore}
							ended={ended}
							endLabel="That's the whole pool."
							error={moreError}
							onLoadMore={loadMore}
							style={{ marginTop: "1rem" }}
						/>
					</Panel>
				)}
			</div>

			<div className="lessons-detail">
				{outlet ?? (
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
