import { type ReactNode, useEffect, useRef, useState } from "react";
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
	Lead,
	LeadValue,
	Panel,
	Plate,
	STATUS_ICONS,
	StatusBadge,
} from "../components/ui";
import { When } from "../components/When";
import { useLessonPool } from "../hooks/useLessonPool";
import { entryKeys, projectEntries } from "../lib/projectEntries";
import { plural } from "../lib/sessionRollup";
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
	/**
	 * Narrow the pool to one stack, as the detail pane's stack chips do.
	 *
	 * The detail is where the control lives because a list row is a link, and
	 * a button inside a link is not something a keyboard or a screen reader can
	 * be expected to drive. The server answers it (ONL-14): filtering here
	 * would filter one loaded page and call it the pool.
	 */
	filterByStack: (stack: string) => void;
}

/**
 * The status select's options.
 *
 * Both filters the page offers are answered by the server across the whole
 * pool: `status` from its own column, stack from lesson_stacks (ONL-14).
 * Neither is applied to the loaded page, which would be wrong the moment a
 * second page exists.
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

// Still read aloud, not drawn: where an empty state or an error is already on
// screen saying the same words, a second copy above it is noise to the eye.
// The region itself stays, for the reason its own comment gives.
const VISUALLY_HIDDEN = {
	position: "absolute",
	width: "1px",
	height: "1px",
	margin: "-1px",
	padding: 0,
	overflow: "hidden",
	clip: "rect(0, 0, 0, 0)",
	whiteSpace: "nowrap",
	border: 0,
} as const;

const row = {
	display: "flex",
	gap: "var(--space-3)",
	// Top-aligned: a claim runs to two or three lines, and a plate centered
	// beside them floats at the middle of the row instead of beside its first.
	alignItems: "flex-start",
	padding: "0.875rem var(--space-3)",
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
	// One stack at a time, though the API takes several: a chip names one,
	// and nothing on the page offers a second.
	const [stack, setStack] = useState<string | null>(null);
	// Set when the stack filter is cleared, read once the chip that held focus
	// is gone. Same reason as focusFirstRow below: the press unmounts the
	// button and leaves focus on <body>.
	const focusStatus = useRef(false);
	const statusRef = useRef<HTMLSelectElement | null>(null);
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
	} = useLessonPool(filter, entry ? entryKeys(entry) : NO_KEYS, stack);

	useEffect(() => {
		if (!focusStatus.current || stack !== null) return;
		focusStatus.current = false;
		statusRef.current?.focus();
	}, [stack]);

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
		filterByStack: setStack,
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
	// names itself ahead of a stack, and a stack ahead of a status, the
	// narrower claim first.
	const emptyTitle = entry
		? `No lessons in ${entry.name}`
		: stack
			? `No lessons for ${stack}`
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

	// What the loaded page holds, said as a sentence. It describes the view the
	// filters leave, not the pool: a project, stack or status narrows it, and
	// the sentence names each so it cannot be read as a count of everything.
	// While a cursor remains the rows are only the first pages, so it says
	// "loaded so far" rather than claiming a total. The active tally is left
	// off under a status filter, where it would only repeat the filter.
	// Not a live region: the status paragraph above already announces the
	// count, and a second one would speak the same change twice.
	let lead: ReactNode = null;
	if (!loadError && lessons !== null && lessons.length > 0) {
		const counted = plural(
			lessons.length,
			filter ? `${filter} lesson` : "lesson",
		);
		const scope = `${entry ? ` in ${entry.name}` : ""}${stack ? ` for ${stack}` : ""}`;
		const active = lessons.filter(
			(lesson) => lesson.status === "active",
		).length;
		const tail = filter ? null : active === lessons.length ? (
			", all active"
		) : (
			<>
				, <LeadValue>{`${active} active`}</LeadValue>
			</>
		);
		lead = (
			<div className="lessons-lead">
				<Lead testId="lessons-headline">
					{cursor === null ? (
						<>
							The pool holds <LeadValue>{counted}</LeadValue>
							{scope}
							{tail}.
						</>
					) : (
						<>
							The pool has <LeadValue>{counted}</LeadValue>
							{scope} loaded so far
							{tail}.
						</>
					)}
				</Lead>
			</div>
		);
	}

	// The pool is empty and nothing narrows it: the one case where there is
	// nothing to select and nothing to filter, so the empty state takes the
	// whole width rather than sitting in a column beside a pane with no job.
	const emptyPool =
		!loadError &&
		lessons !== null &&
		lessons.length === 0 &&
		!entry &&
		!stack &&
		!filter;
	// An empty state or an error is on screen saying what the status line says.
	const stateSpeaks = Boolean(loadError) || (lessons?.length ?? 1) === 0;

	return (
		<div
			className="lessons-layout"
			data-pane={detail ? "detail" : "list"}
			data-empty={emptyPool && !detail ? "true" : undefined}
		>
			{lead}
			<div className="lessons-list">
				{/*
				  The filters side by side and wrapping, as the mockup has them,
				  rather than stacked: two short controls do not each need a
				  line of a narrow column.
				*/}
				<div
					style={{
						display: "flex",
						flexWrap: "wrap",
						gap: "var(--space-4)",
						marginBottom: "var(--space-4)",
					}}
				>
					{entries.length > 0 ? (
						<ProjectFilter
							entries={entries}
							value={entry?.name ?? null}
							onChange={setSelected}
						/>
					) : null}
					<div>
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
							ref={statusRef}
							value={filter}
							onChange={(event) =>
								setFilter(event.target.value as "" | LessonStatus)
							}
							style={{
								minHeight: "44px",
								padding: "0 var(--space-3)",
								background: "var(--ground)",
								color: "var(--ink)",
								border: `2px solid ${PALETTE.border}`,
								borderRadius: 0,
								fontFamily: "var(--font-body)",
								fontSize: "var(--text-body-md)",
							}}
						>
							{FILTERS.map((option) => (
								<option key={option.value || "all"} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					</div>
				</div>
				{stack ? (
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: "var(--space-2)",
							marginBottom: "1rem",
						}}
					>
						<Chip>{`Stack: ${stack}`}</Chip>
						<Button
							variant="ghost"
							onClick={() => {
								focusStatus.current = true;
								setStack(null);
							}}
						>
							Clear stack
						</Button>
					</div>
				) : null}
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
					style={
						stateSpeaks
							? VISUALLY_HIDDEN
							: {
									margin: "0 0 var(--space-2)",
									fontFamily: "var(--font-data)",
									fontSize: "var(--text-data-sm)",
									letterSpacing: "1px",
									textTransform: "uppercase",
									color: PALETTE.muted,
								}
					}
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
					entry || stack || filter ? (
						// An empty FILTER result and an empty POOL say different
						// things. Telling someone whose pool is full to "connect a
						// machine" because they filtered to a status nothing holds,
						// or a project with no lessons, would be a lie, and the kind
						// that makes a person doubt everything else the page says.
						<EmptyState title={emptyTitle}>
							{entry
								? "Nothing you can read in the pool matches that project."
								: stack
									? "Nothing you can read in the pool lists that stack."
									: "Nothing in the pool holds that status right now."}
						</EmptyState>
					) : (
						<Panel title="Nothing has synced yet" icon="Eye">
							<div
								style={{
									display: "flex",
									gap: "var(--space-4)",
									alignItems: "flex-start",
								}}
							>
								<Plate tone="teal" icon="ChestTreasure" size={32} />
								<div>
									<p
										style={{
											margin: 0,
											fontSize: "1.05rem",
											lineHeight: 1.6,
										}}
									>
										Lessons arrive when a machine pushes them. Once one does,
										each shows up here with its rationale and the evidence
										behind it.
									</p>
									<p style={{ margin: "var(--space-3) 0 0" }}>
										{/*
										  A link and not a button. A button here would read as
										  an action this page performs, and it is a place to
										  go.
										*/}
										<NavLink to="/machines" style={{ color: PALETTE.accent }}>
											Connect a machine
										</NavLink>{" "}
										to start.
									</p>
								</div>
							</div>
						</Panel>
					)
				) : (
					<Panel title="The pool" open>
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
										// The open row reads brightest, as well as filled.
										color: isActive ? "var(--ink-hi)" : "var(--ink)",
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
												marginBottom: "var(--space-2)",
												fontSize: "var(--text-body-md)",
												lineHeight: 1.5,
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
				{outlet ??
					(lessons !== null && lessons.length === 0 ? null : (
						<Panel>
							<p style={{ margin: 0, color: PALETTE.muted }}>
								Select a lesson to read its rationale and evidence.
							</p>
						</Panel>
					))}
			</div>
		</div>
	);
}
