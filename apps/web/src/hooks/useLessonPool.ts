import { useCallback, useEffect, useRef, useState } from "react";
import {
	type Lesson,
	type LessonStatus,
	listLessons,
	type RetractableOrg,
} from "../api/lessonsApi";
import { describeError } from "../lib/apiErrors";

// The pool's query lifecycle, out of LessonsPage (ONL-75). Every write to the
// pool's state happens in this file, beside the sequence guard that decides
// which writes are allowed. The page only renders what this returns.
//
// That is the point of the split, not tidiness. The one real defect the
// two-pane branch shipped with was an append flag that `load()` never reset
// and a `finally` the sequence guard never covered. No single task's diff held
// both halves, so no per-task review could see it. Here the two cannot drift
// apart without the drift being in one file.

export interface LessonPool {
	/** Null until the first page of the current query lands. */
	lessons: Lesson[] | null;
	ownedIds: string[];
	authors: Record<string, string>;
	retractableIn: Record<string, RetractableOrg>;
	formerAuthors: string[];
	loadError: string | null;
	/** See `LessonsContext.poolSettled` for why this never goes back to false. */
	poolSettled: boolean;
	cursor: string | null;
	loadingMore: boolean;
	moreError: string | null;
	ended: boolean;
	/**
	 * Lessons on a fresh read of page 1 that no loaded page holds, or null.
	 * `more` is set when every row on that read was new and the server had
	 * more, so the count is a floor and not the total.
	 */
	fresh: { count: number; more: boolean } | null;
	/** Start the current query over, as the error state's Retry does. */
	reload: () => void;
	loadMore: () => void;
	patchLesson: (id: string, status: LessonStatus) => void;
}

/**
 * The pool for one query: a status, or none, and the project keys of the
 * selected project, or none. A new query starts over from the first page.
 */
export function useLessonPool(
	filter: "" | LessonStatus,
	projectKeys: readonly string[],
): LessonPool {
	const [lessons, setLessons] = useState<Lesson[] | null>(null);
	// Moves with `lessons` everywhere - replaced on load, appended on
	// loadMore, and left alone by patchLesson, which changes a status and
	// never an owner.
	const [ownedIds, setOwnedIds] = useState<string[]>([]);
	// Moves with `lessons` the same way `ownedIds` does - replaced on load,
	// merged on loadMore, left alone by patchLesson, which changes a status
	// and never an author.
	const [authors, setAuthors] = useState<Record<string, string>>({});
	// Moves with `lessons` the same way `authors` does - replaced on load,
	// merged on loadMore, left alone by patchLesson, which changes a status
	// and never an org's authority.
	const [retractableIn, setRetractableIn] = useState<
		Record<string, RetractableOrg>
	>({});
	// Moves with `lessons` the same way `authors` does - replaced on load,
	// merged on loadMore, left alone by patchLesson, which changes a status
	// and never who anchors a lesson.
	const [formerAuthors, setFormerAuthors] = useState<string[]>([]);
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
	const [ended, setEnded] = useState(false);
	// Set by the visibility check below, cleared by `load()`. A lesson that
	// reaches the pool above the last row shown never comes back through
	// Load more, which asks for rows older than that one (ONL-262).
	const [fresh, setFresh] = useState<{ count: number; more: boolean } | null>(
		null,
	);

	// Which request is newest. Two filter changes inside one round-trip issue
	// two requests, and without this whichever SETTLES last would win rather
	// than whichever was ASKED last - leaving the select reading one status
	// while the list shows another. A stale rejection is worse still: it
	// would blank a list a newer request had already filled.
	const requestSeq = useRef(0);
	// The query, by its `requestSeq`, that a loadMore is outstanding for, or
	// null. This is the guard, not `loadingMore`, which is committed state: two
	// presses before a render both read it as false and appended the same page
	// twice (ONL-73). A ref is set the moment the first press runs. Keyed by
	// the query so a new one, which bumps `requestSeq`, is never blocked by a
	// page the old one still has out.
	const moreInFlight = useRef<number | null>(null);
	// Which query, by its `requestSeq`, has a `load()` outstanding, or null. A
	// check while one is out would compare a page against a list that is about
	// to be replaced.
	const loadInFlight = useRef<number | null>(null);
	// One visibility check at a time. Switching tabs back and forth inside a
	// round-trip would otherwise send one request per switch.
	const checkInFlight = useRef(false);

	// A string, so `load` changes when the keys do and not on every render.
	const projectKey = projectKeys.join("\n");
	const query = useCallback(
		() => ({
			...(filter ? { statuses: [filter] } : {}),
			...(projectKey ? { project: projectKey.split("\n") } : {}),
		}),
		[filter, projectKey],
	);

	const load = useCallback(async () => {
		const seq = ++requestSeq.current;
		loadInFlight.current = seq;
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
		// And `ended` with them, for the third time in the same breath: a new
		// query has not reached its own end, whatever the last one found. This
		// is the reset that makes an `ended` flag safe here at all - it is why
		// the end-of-pool message cannot be derived from `cursor === null`,
		// which this line also produces on every filter change.
		setEnded(false);
		// And the notice: whatever it counted was measured against the list
		// this query is replacing.
		setFresh(null);
		try {
			const page = await listLessons(query());
			if (seq !== requestSeq.current) return;
			setLessons(page.lessons);
			// `?? []` is not defensive padding: a page without `owned_ids` -
			// an older API still rolling out under a newer bundle - would
			// otherwise throw out of this handler and blank the pool entirely.
			// Empty is also the safe reading, since it offers no status
			// control rather than one that cannot succeed.
			setOwnedIds(page.owned_ids ?? []);
			// `?? {}`, for the identical reason the line above defaults to `[]`:
			// a page without `authors` - an older API still rolling out under a
			// newer bundle - would otherwise throw out of this handler and
			// blank the pool entirely. Empty is also the safe reading, since
			// no page renders a name it cannot attribute.
			setAuthors(page.authors ?? {});
			// `?? {}`, for the identical reason the two lines above default: a
			// page without `retractable_in` - an older API still rolling out
			// under a newer bundle - would otherwise throw out of this handler
			// and blank the pool entirely. Empty is also the safe reading,
			// since it offers no retract control rather than one that cannot
			// succeed.
			setRetractableIn(page.retractable_in ?? {});
			// `?? []`, for the identical reason the lines above default: a page
			// without `former_authors` - an older API still rolling out under a
			// newer bundle - would otherwise throw out of this handler and blank
			// the pool entirely. Empty is also the safe reading, since no page
			// says an author has left when it cannot confirm one has.
			setFormerAuthors(page.former_authors ?? []);
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
			setOwnedIds([]);
			setAuthors({});
			setRetractableIn({});
			setFormerAuthors([]);
			setCursor(null);
			setLoadError(describeError(error, "Could not load the pool."));
		} finally {
			// Guarded too: if a superseded request settles while the newest is
			// still in flight, flipping this to true would tell the detail pane
			// the pool is settled while `lessons` is still empty - and it would
			// conclude an id is absent and fetch a lesson that is about to
			// arrive.
			if (seq === requestSeq.current) setPoolSettled(true);
			if (loadInFlight.current === seq) loadInFlight.current = null;
		}
	}, [query]);

	useEffect(() => {
		void load();
	}, [load]);

	// Re-ask for page 1 when the tab comes back, and count what the list does
	// not hold. Only once the current query's page 1 is showing: before then
	// there is nothing to compare against, and after a failure the error
	// state's Retry is already the way forward.
	useEffect(() => {
		if (lessons === null || loadError) return;
		const held = new Set(lessons.map((lesson) => lesson.id));
		const onVisibilityChange = async () => {
			if (document.visibilityState !== "visible") return;
			if (loadInFlight.current !== null || checkInFlight.current) return;
			// Read, not minted, the way loadMore reads it: the check belongs to
			// the query on screen, and a new query moving the counter discards it.
			const seq = requestSeq.current;
			checkInFlight.current = true;
			try {
				const page = await listLessons(query());
				if (seq !== requestSeq.current) return;
				const count = page.lessons.filter(
					(lesson) => !held.has(lesson.id),
				).length;
				setFresh(
					count === 0
						? null
						: { count, more: count === page.lessons.length && page.has_more },
				);
			} catch {
				// Deliberately quiet. This is a background check, and the list on
				// screen is still a true answer to the question it was asked.
			} finally {
				checkInFlight.current = false;
			}
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", onVisibilityChange);
	}, [lessons, loadError, query]);

	const loadMore = async () => {
		if (!cursor || moreInFlight.current === requestSeq.current) return;
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
		moreInFlight.current = seq;
		setLoadingMore(true);
		setMoreError(null);
		try {
			// The filter travels with the cursor. A cursor is a position within
			// ONE query's ordering, so paging with a different filter than the
			// one that minted it walks a boundary that query never established.
			// The project is part of that query exactly as the status is.
			const page = await listLessons({ ...query(), cursor });
			if (seq !== requestSeq.current) return;
			setLessons((current) => [...(current ?? []), ...page.lessons]);
			setOwnedIds((current) => [...current, ...(page.owned_ids ?? [])]);
			setAuthors((current) => ({ ...current, ...(page.authors ?? {}) }));
			setRetractableIn((current) => ({
				...current,
				...(page.retractable_in ?? {}),
			}));
			setFormerAuthors((current) => [
				...current,
				...(page.former_authors ?? []),
			]);
			setCursor(page.has_more ? page.cursor : null);
			// Behind the same seq guard as the append itself: a page that lands
			// after the filter has moved on must not report ITS end as the end
			// of the query now on screen.
			setEnded(!page.has_more);
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
			// Only this call's own claim. A newer query's loadMore holds the ref
			// under its own seq by now, and clearing that would reopen the gap.
			if (moreInFlight.current === seq) moreInFlight.current = null;
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

	return {
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
		reload: () => void load(),
		loadMore: () => void loadMore(),
		patchLesson,
	};
}
