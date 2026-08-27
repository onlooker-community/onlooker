import { type ReactNode, useEffect, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { getLesson, type Lesson } from "../api/lessonsApi";
import { PALETTE } from "../components/palette";
import { Chip, EmptyState, Panel, StatusBadge } from "../components/ui";
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
			<h3
				style={{
					margin: "0 0 0.35rem",
					fontFamily: "var(--font-display)",
					fontSize: "12px",
					letterSpacing: "1px",
					textTransform: "uppercase",
					color: PALETTE.muted,
				}}
			>
				{label}
			</h3>
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
	const { lessons, poolSettled } = useOutletContext<LessonsContext>();

	// The loaded page is the source of truth whenever it holds this id, so a
	// retraction written into it by patchLesson shows here without a refetch.
	const listed = lessons.find((lesson) => lesson.id === id) ?? null;

	const [fetched, setFetched] = useState<Lesson | null>(null);
	const [fetchError, setFetchError] = useState<string | null>(null);

	useEffect(() => {
		// Nothing to do while the id is in memory, and nothing to decide until
		// the pool has been asked at all - `listed` being null before then means
		// "not checked yet", not "not present". Effects run child-first, so
		// without poolSettled this fires before LessonsPage's own load() has
		// even started, for every id, including ones already in the pool.
		if (!id || listed || !poolSettled) return;

		let live = true;
		setFetchError(null);
		getLesson(id)
			.then((lesson) => {
				if (live) setFetched(lesson);
			})
			.catch((error) => {
				if (live)
					setFetchError(describeError(error, "Could not load that lesson."));
			});

		// The list pane stays mounted while the detail changes, so a slow
		// response for a lesson the user has already navigated away from would
		// otherwise overwrite the one they are looking at.
		return () => {
			live = false;
		};
	}, [id, listed, poolSettled]);

	const lesson = listed ?? (fetched?.id === id ? fetched : null);

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

	if (fetchError) {
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
				<p style={{ color: PALETTE.muted }}>Loading that lesson...</p>
			</>
		);
	}

	const { applies_to: appliesTo, consensus, evidence } = lesson;

	return (
		<>
			{back}
			<Panel>
				{/*
				  The claim leads, because it is the thing being trusted or
				  not. Everything below it exists to justify or qualify it.
				*/}
				<h1 style={{ marginTop: "0.5rem", fontSize: "1.25rem" }}>
					{lesson.claim}
				</h1>
				<div
					style={{
						display: "flex",
						gap: "0.5rem",
						alignItems: "center",
						marginBottom: "1.25rem",
					}}
				>
					<StatusBadge status={lesson.status} />
					<time dateTime={lesson.promoted_at} style={{ color: PALETTE.muted }}>
						Promoted {new Date(lesson.promoted_at).toLocaleDateString()}
					</time>
				</div>

				<Field label="Rationale">
					<p style={{ margin: 0 }}>{lesson.rationale}</p>
				</Field>

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
		</>
	);
}
