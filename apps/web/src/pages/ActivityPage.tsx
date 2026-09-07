import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type ActivityEvent, listActivity } from "../api/lessonsApi";
import { PALETTE } from "../components/palette";
import { Button, EmptyState, Panel } from "../components/ui";
import { describeError } from "../lib/apiErrors";

/** The day an event belongs to, in the reader's own timezone. */
function dayKey(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString(undefined, {
		weekday: "long",
		month: "long",
		day: "numeric",
	});
}

function timeOf(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleTimeString(undefined, { timeStyle: "short" });
}

/**
 * What happened, in the order the feed recorded it.
 *
 * A `status` row says only that the status changed. lesson_feed has no from/to
 * columns, and naming the lesson's CURRENT status on a past event would be
 * wrong for anything that changed twice - a lesson retracted in March and
 * reinstated in April would show both events as "active". See the design spec.
 */
function describeKind(kind: string): string {
	if (kind === "create") return "Published";
	if (kind === "status") return "Status changed";
	return kind;
}

export default function ActivityPage() {
	const [events, setEvents] = useState<ActivityEvent[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const [moreError, setMoreError] = useState<string | null>(null);

	useEffect(() => {
		// An `active` flag, not a request sequence number. LessonsPage carries a
		// requestSeq (LessonsPage.tsx:119) because a filter change mints a second
		// query, and without one whichever request SETTLES last would win rather
		// than whichever was ASKED last. This screen has no filter, so there is no
		// second query and nothing to order. What does still apply is an unmount
		// mid-flight, which is all this guards.
		let active = true;
		listActivity()
			.then((page) => {
				if (!active) return;
				setEvents(page.events);
				// `has_more` and not `cursor !== null`. They agree today, because
				// listActivityPage derives hasMore as `rows.length > limit` and so
				// always has a last row to mint a cursor from - but they are two
				// facts and only one of them is the question being asked. See the
				// same reasoning at LessonsPage's load().
				setCursor(page.has_more ? page.cursor : null);
			})
			.catch((error: unknown) => {
				if (!active) return;
				setLoadError(describeError(error, "Could not load your activity."));
			});
		return () => {
			active = false;
		};
	}, []);

	const loadMore = async () => {
		// The whole of the concurrency control this screen needs: no filter means
		// no query to supersede, so the only race is a second click while the
		// first append is still out.
		if (!cursor || loadingMore) return;
		setLoadingMore(true);
		setMoreError(null);
		try {
			const page = await listActivity({ cursor });
			setEvents((current) => [...(current ?? []), ...page.events]);
			setCursor(page.has_more ? page.cursor : null);
		} catch (error) {
			// The pages already loaded stay. A failed append is a missing tail.
			setMoreError(describeError(error, "Could not load more activity."));
		} finally {
			setLoadingMore(false);
		}
	};

	if (loadError) {
		return (
			<div style={{ maxWidth: "640px" }}>
				<EmptyState title="Could not load your activity">
					{loadError}
				</EmptyState>
			</div>
		);
	}

	if (events === null) return <p>Loading your activity…</p>;

	if (events.length === 0) {
		return (
			<div style={{ maxWidth: "640px" }}>
				<EmptyState title="Nothing has happened yet">
					Lessons you publish and statuses you change will show up here, newest
					first.
				</EmptyState>
			</div>
		);
	}

	// Grouped into a Map keyed by day rather than merging same-day events that
	// are merely adjacent in `events`. Adjacency is not guaranteed: two
	// concurrent writes for one user can commit with `seq` ascending but the
	// SAME `at`, because createLessonsWithFeed and transitionLesson (in
	// apps/api/src/db/lessons.ts) each capture `now` before their retry loop,
	// so a batch that retries after a seq collision reuses it. If such events
	// straddle local midnight, same-day rows are not adjacent in the feed. A
	// Map merges them correctly regardless of position, so this grouping does
	// not depend on the API's ordering at all - and `key={group.day}` on the
	// Panel below is safe because a Map has each day at most once.
	const groups = new Map<string, ActivityEvent[]>();
	for (const event of events) {
		const day = dayKey(event.at);
		const existing = groups.get(day);
		if (existing) existing.push(event);
		else groups.set(day, [event]);
	}
	const days = [...groups.entries()].map(([day, dayEvents]) => ({
		day,
		events: dayEvents,
	}));

	return (
		<div style={{ maxWidth: "640px", display: "grid", gap: "var(--space-4)" }}>
			{days.map((group) => (
				<Panel key={group.day} title={group.day} icon="Book">
					{group.events.map((event) => (
						<div
							key={event.seq}
							style={{
								display: "flex",
								gap: "var(--space-3)",
								padding: "0.35rem 0",
							}}
						>
							<span style={{ color: "var(--ink-dim)", flex: "none" }}>
								{timeOf(event.at)}
							</span>
							<span style={{ flex: "none" }}>{describeKind(event.kind)}</span>
							<Link to={`/lessons/${event.lesson_id}`}>{event.claim}</Link>
						</div>
					))}
				</Panel>
			))}

			{cursor ? (
				<Button
					loading={loadingMore}
					loadingLabel="Loading…"
					onClick={() => void loadMore()}
				>
					Load more
				</Button>
			) : null}

			{moreError ? (
				<p role="alert" style={{ color: PALETTE.danger }}>
					{moreError}
				</p>
			) : null}
		</div>
	);
}
