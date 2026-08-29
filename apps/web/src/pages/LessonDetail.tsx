import { AuthApiError } from "@onlooker/auth-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import {
	type BrowserStatus,
	getLesson,
	type Lesson,
	setLessonStatus,
} from "../api/lessonsApi";
import { ConfirmAction } from "../components/ConfirmAction";
import { Icon } from "../components/Icon";
import { PALETTE } from "../components/palette";
import {
	Button,
	Chip,
	EmptyState,
	Panel,
	STATUS_ICONS,
	StatusBadge,
} from "../components/ui";
import { When } from "../components/When";
import { describeError } from "../lib/apiErrors";
import type { LessonsContext } from "./LessonsPage";

// One lesson, read in full. Rendered out of the list LessonsPage already
// holds, because the list returns full bodies - so clicking down the column
// issues nothing. GET /api/lessons/:id is the fallback for the one case that
// cannot work that way: an id not in any loaded page, which is what a pasted
// link is.

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div style={{ marginBottom: "1rem" }}>
			{/*
			  h2, not h3: the two panels wrapping this each carry their own h2
			  title (Applies to / Why it was trusted), so this stays a sibling
			  h2 rather than nesting under it - h1 (the claim) -> h2 throughout,
			  in both panels, with no skip. The font size is an explicit inline
			  style below, so this is a semantic-only change - nothing here
			  should look different.
			*/}
			<h2
				style={{
					margin: "0 0 0.35rem",
					fontFamily: "var(--font-data)",
					fontSize: "var(--text-data-sm)",
					letterSpacing: "1px",
					textTransform: "uppercase",
					color: PALETTE.muted,
				}}
			>
				{label}
			</h2>
			{children}
		</div>
	);
}

function Chips({ values }: { values: string[] }) {
	return (
		<div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
			{values.map((value) => (
				<Chip key={value}>{value}</Chip>
			))}
		</div>
	);
}

export default function LessonDetail() {
	const { id } = useParams();
	const { lessons, poolSettled, patchLesson } =
		useOutletContext<LessonsContext>();

	// The loaded page is the source of truth whenever it holds this id, so a
	// retraction written into it by patchLesson shows here without a refetch.
	const listed = lessons.find((lesson) => lesson.id === id) ?? null;

	const [fetched, setFetched] = useState<Lesson | null>(null);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [actionError, setActionError] = useState<{
		message: string;
		retryable: boolean;
		attempted: BrowserStatus;
	} | null>(null);
	// Bumped whenever a transition settles for the lesson still on screen -
	// success or failure alike. ConfirmAction owns "armed" internally now, so
	// this is what stands in for the old `setConfirming(false)`: folded into
	// ConfirmAction's key below, it forces a fresh, unarmed instance the same
	// way a lesson change does.
	const [settleCount, setSettleCount] = useState(0);

	// The id in scope right now, read from inside `transition`'s async
	// continuation. A plain closure over `id` would read the value from the
	// render the click happened in, which is exactly the value that has gone
	// stale once the user has navigated on - this ref is what lets that
	// continuation notice the difference.
	const currentId = useRef(id);
	currentId.current = id;

	// LessonDetail is reconciled in place when :id changes - same route
	// element, same position - so neither of these resets on its own. A stale
	// error or a stuck "Working..." from the previous id must not bleed into
	// this one. Same defect fetchError had below, in the one flow here where
	// getting it wrong is destructive. ConfirmAction's armed state used to be
	// reset here too; it now disarms itself through `resetToken` below.
	useEffect(() => {
		setActionError(null);
		setPending(false);
	}, [id]);

	// The list can vanish underneath this pane: a failed filter refetch sets
	// lessons back to null, and without this the pane would blank a lesson the
	// user is reading and then re-fetch one it already had. The list query
	// failing says nothing about the lesson on screen.
	useEffect(() => {
		if (listed) setFetched(listed);
	}, [listed]);

	useEffect(() => {
		// Nothing to do while the id is in memory, and nothing to decide until
		// the pool has been asked at all - `listed` being null before then means
		// "not checked yet", not "not present". Effects run child-first, so
		// without poolSettled this fires before LessonsPage's own load() has
		// even started, for every id, including ones already in the pool.
		//
		// `fetched?.id === id` also holds: a filter refetch can null out
		// `listed` for the lesson currently open, and without this an already-
		// held copy would be fetched again just because the list no longer
		// carries it.
		if (!id || listed || !poolSettled || fetched?.id === id) return;

		let live = true;
		setFetchError(null);
		getLesson(id)
			.then((lesson) => {
				if (live) setFetched(lesson);
			})
			.catch((error) => {
				// A fallback distinct from the EmptyState title below, so a
				// non-Error rejection - which describeError has no way to
				// produce today - would not print the same sentence twice.
				if (live)
					setFetchError(describeError(error, "That lesson could not be read."));
			});

		// The list pane stays mounted while the detail changes, so a slow
		// response for a lesson the user has already navigated away from would
		// otherwise overwrite the one they are looking at.
		return () => {
			live = false;
		};
	}, [id, listed, poolSettled]);

	const lesson = listed ?? (fetched?.id === id ? fetched : null);

	const transition = async (next: BrowserStatus) => {
		if (!id || pending) return;
		// Captured once, up front: `id` from `useParams` can change under this
		// same call while it is in flight, and every write below needs to know
		// which lesson it was actually asked to move, not which one is on
		// screen when the promise settles.
		const target = id;
		setPending(true);
		setActionError(null);
		try {
			await setLessonStatus(target, next);
			// AFTER the round-trip, never before. The server returns { id, seq }
			// rather than the lesson, but it wrote body.status and the status
			// column together in one batch - so writing the status it just
			// accepted is reflecting its answer, not guessing at it. Ungated by
			// `currentId`: the server did write, so the list must carry that
			// regardless of where the user has since navigated.
			patchLesson(target, next);
			setFetched((current) =>
				current && current.id === target
					? { ...current, status: next }
					: current,
			);
		} catch (error) {
			// transitionLesson can exhaust its sequence retries, which apps/api
			// turns into a 503 whose message says nothing was written. That is a
			// guarantee no other failure here makes, and it is the difference
			// between "press it again" and "do not". Read off `code` rather than
			// the message, because describeError only carries the text.
			const retryable =
				error instanceof AuthApiError && error.code === "sequence_contention";
			// Gated: a rejection that settles after the user has moved to
			// another lesson must not paint this one's error under that one.
			if (currentId.current === target) {
				setActionError({
					message: describeError(
						error,
						"Could not change that lesson's status.",
					),
					retryable,
					attempted: next,
				});
			}
		} finally {
			// Gated, and true either way the round-trip went: a live "Yes,
			// retract" surviving a failure sits directly over an error saying
			// the same click would fail again, and a request that settles for
			// a lesson the user has left must not touch the one now showing.
			if (currentId.current === target) {
				setPending(false);
				setSettleCount((count) => count + 1);
			}
		}
	};

	const back = (
		// Narrow shows one pane at a time, so this is the only way back to the
		// list. lessons.css hides it above the breakpoint, where the list is
		// already beside it.
		<Link
			className="lessons-back"
			to="/lessons"
			style={{ color: PALETTE.accent }}
		>
			← All lessons
		</Link>
	);

	// `!lesson` and not just `fetchError`: LessonDetail is not remounted when
	// :id changes - same route element, same position - so an error from a
	// previous, absent id survives in state. Once `listed` finds the new id in
	// memory there is something to show instead, and the stale error should
	// not win the render just because nothing has cleared it yet.
	if (fetchError && !lesson) {
		return (
			<>
				{back}
				<EmptyState title="Could not load that lesson">{fetchError}</EmptyState>
			</>
		);
	}

	if (!lesson) {
		return (
			<>
				{back}
				<p role="status" style={{ color: PALETTE.muted }}>
					Loading that lesson...
				</p>
			</>
		);
	}

	const { applies_to: appliesTo, consensus, evidence } = lesson;

	// A retracted lesson can be made active again; an active one can be
	// retracted. Those are the only two a human may assert - and apps/api
	// enforces that with a 400 regardless of what this renders. `null` for the
	// other two statuses, which get no control at all.
	const next: BrowserStatus | null =
		lesson.status === "active"
			? "retracted"
			: lesson.status === "retracted"
				? "active"
				: null;
	const verb = next === "retracted" ? "Retract" : "Make active";

	return (
		<>
			{back}
			{/*
			  Judgment above the rule, facts below. Status, then the claim -
			  the one thing here that must be read carefully, so it stays
			  unboxed and leads - then the rationale that justifies it. A rule
			  separates that judgment from the two panels answering the two
			  questions the remaining six facts actually split into. Retract
			  sits last, beneath both: it reaches every mirror on its next
			  delta pull, so the evidence is passed on the way to the button,
			  not after it.
			*/}
			<div
				style={{
					display: "flex",
					gap: "var(--space-4)",
					alignItems: "center",
					flexWrap: "wrap",
					marginBottom: "var(--space-3)",
				}}
			>
				<span
					style={{
						display: "flex",
						alignItems: "center",
						gap: "var(--space-1)",
					}}
				>
					<Icon name={STATUS_ICONS[lesson.status]} />
					<StatusBadge status={lesson.status} />
				</span>
				<span
					style={{
						display: "flex",
						alignItems: "center",
						gap: "var(--space-1)",
					}}
				>
					<Icon name="Trophy" />
					<time dateTime={lesson.promoted_at} style={{ color: PALETTE.muted }}>
						Promoted {new Date(lesson.promoted_at).toLocaleDateString()}
					</time>
				</span>
			</div>

			{/*
			  The claim leads, because it is the thing being trusted or not -
			  and it stays in the readable face. It is a sentence, not chrome,
			  and pixel type is measurably harder to read at length: it leads
			  by size and weight here, not by face.
			*/}
			<h1
				style={{
					margin: "0 0 var(--space-3)",
					fontFamily: "var(--font-body)",
					fontSize: "var(--text-body-lg)",
				}}
			>
				{lesson.claim}
			</h1>

			<p style={{ margin: "0 0 var(--space-4)" }}>{lesson.rationale}</p>

			<hr
				style={{
					border: "none",
					borderTop: `2px solid ${PALETTE.border}`,
					margin: "0 0 var(--space-4)",
				}}
			/>

			<div className="lessons-detail-panels">
				<Panel title="Applies to" icon="MagnifyingGlass">
					<Field label="Stack">
						<Chips values={appliesTo.stack} />
					</Field>

					<Field label="Scope">
						{appliesTo.scope.kind === "versioned" ? (
							<Chips
								values={Object.entries(appliesTo.scope.versions).map(
									([name, range]) => `${name} ${range}`,
								)}
							/>
						) : (
							// The justification is the point of this branch: a lesson
							// with no version constraint never expires, so the reason
							// is judged rather than assumed.
							<p style={{ margin: 0 }}>{appliesTo.scope.justification}</p>
						)}
					</Field>

					{appliesTo.file_patterns.length > 0 ? (
						<Field label="Files">
							<Chips values={appliesTo.file_patterns} />
						</Field>
					) : null}

					{appliesTo.task_kinds.length > 0 ? (
						<Field label="Tasks">
							<Chips values={appliesTo.task_kinds} />
						</Field>
					) : null}
				</Panel>

				<Panel title="Why it was trusted" icon="Trophy">
					<Field label="Consensus">
						<p style={{ margin: 0 }}>
							{consensus.agreed} of {consensus.judges} judges agreed on{" "}
							<When iso={consensus.decided_at} />
						</p>
					</Field>

					<Field label="What was observed">
						<p style={{ margin: 0 }}>{evidence.resolution}</p>
						<p style={{ margin: "0.35rem 0 0", color: PALETTE.muted }}>
							<When iso={evidence.observed_at} />
							{" · "}
							{evidence.session_ids.length} session
							{evidence.session_ids.length === 1 ? "" : "s"}
							{" · "}
							{evidence.artifact_ids.length} artifact
							{evidence.artifact_ids.length === 1 ? "" : "s"}
						</p>
					</Field>

					<Field label="Provenance">
						{/*
						  project_key and author_key are opaque by design - the
						  mapping to a repository lives only in a local manifest,
						  and author_key carries the unlinkability guarantee. They
						  are shown because they are what a person correlates two
						  lessons by, not because they mean anything on their own.
						*/}
						<Chips
							values={[
								`source: ${lesson.source}`,
								`visibility: ${lesson.visibility}`,
								`project: ${evidence.project_key}`,
							]}
						/>
					</Field>
				</Panel>
			</div>

			{next ? (
				<div>
					<ConfirmAction
						trigger={verb}
						question={
							next === "retracted"
								? "Stop trusting this lesson everywhere?"
								: "Trust this lesson again everywhere?"
						}
						confirmLabel={`Yes, ${verb.toLowerCase()}`}
						variant={next === "retracted" ? "danger" : "primary"}
						pending={pending}
						// LessonDetail is reconciled in place when :id changes - same
						// route element, same position - so nothing here resets on its
						// own. An armed confirm prompt following the user onto a
						// lesson they never opened one on puts a live "Yes, retract"
						// over the wrong claim, and a retraction reaches every mirror
						// on its next delta pull. `id` covers navigating to a new
						// lesson; `settleCount` covers a round trip settling - success
						// or failure alike - for the one still on screen, which needs
						// the same disarm and used to live here as
						// `setConfirming(false)` in `transition`'s finally.
						resetToken={`${id}:${settleCount}`}
						onConfirm={() => void transition(next)}
					/>

					{actionError ? (
						<div role="alert" style={{ marginTop: "0.75rem" }}>
							<p style={{ color: PALETTE.danger, margin: "0 0 0.5rem" }}>
								{actionError.message}
							</p>
							{/*
							  Offered only where the server promised nothing was
							  written. A 400 would fail identically on a second
							  press, and a button that reliably fails is worse
							  than no button.
							*/}
							{actionError.retryable ? (
								<Button
									loading={pending}
									loadingLabel="Working..."
									// The status this same failure was raised
									// against, not the current `next` - if the
									// pool refetches between the failure and this
									// click and the lesson's status has since
									// moved, `next` would have flipped too and
									// this would retry the opposite transition.
									onClick={() => void transition(actionError.attempted)}
								>
									Try again
								</Button>
							) : null}
						</div>
					) : null}
				</div>
			) : null}
		</>
	);
}
