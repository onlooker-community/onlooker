import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type ActivityEvent, listActivity } from "../api/lessonsApi";
import { LoadMore } from "../components/LoadMore";
import { PALETTE } from "../components/palette";
import { EmptyState, Loading, Panel } from "../components/ui";
import { describeError } from "../lib/apiErrors";
import { dayKey, timeOf } from "../lib/dayKey";

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
	const [ended, setEnded] = useState(false);

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
			// Set here rather than read off `cursor` downstream, because "the
			// feed ended" and "there is no cursor" are the same only on this
			// screen. The feed has no filter to restart it, so nothing clears
			// this again - reaching the end is final.
			setEnded(!page.has_more);
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

	if (events === null) return <Loading label="Loading your activity…" />;

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
					{group.events.map((event, index) => (
						/*
						 * Two lines, the claim first. Before this the row was one flat
						 * flex line - time, kind, claim - with every child the same
						 * weight and no separator, so consecutive events ran together
						 * and a long claim wrapped beneath the time and kind with
						 * nothing saying where one event ended. The sessions feed had
						 * the same shape until ONL-173; this was the last page with
						 * it. See ONL-177.
						 *
						 * The CLAIM leads because it is what identifies the event -
						 * the time is already narrowed to this day by the Panel these
						 * rows sit in, which makes it the most tertiary thing on the
						 * row rather than the anchor it used to be positioned as.
						 */
						<div
							key={event.seq}
							data-testid="activity-row"
							style={{
								padding: "var(--space-3) 0",
								// Matching MachinesPage, OrgsPage, LessonsPage and now
								// the sessions feed. The last row omits it rather than
								// doubling against Panel's own edge.
								borderBottom:
									index === group.events.length - 1
										? "none"
										: `2px solid ${PALETTE.border}`,
							}}
						>
							<Link to={`/lessons/${event.lesson_id}`}>{event.claim}</Link>
							<div
								style={{
									marginTop: "0.15rem",
									color: PALETTE.muted,
									fontSize: "0.9em",
								}}
							>
								{timeOf(event.at)} · {describeKind(event.kind)}
							</div>
						</div>
					))}
				</Panel>
			))}

			<LoadMore
				cursor={cursor}
				loading={loadingMore}
				ended={ended}
				endLabel="That's the whole feed."
				error={moreError}
				onLoadMore={() => void loadMore()}
			/>
		</div>
	);
}
