import { type CSSProperties, useEffect, useRef } from "react";
import { PALETTE } from "./palette";
import { Button } from "./ui";

/**
 * The presentational half of paging: the button, the message that replaces it
 * when there is nothing left to ask for, and the alert when an append fails.
 *
 * Lifted from ActivityPage and LessonsPage, which had grown identical copies
 * of it and had already drifted apart on a character. Deliberately holds no
 * part of the query lifecycle - no cursor of its own, no request, no sequence
 * number. `ended` is passed in rather than derived from `cursor === null`
 * because those are not the same fact: LessonsPage's `load()` clears the
 * cursor synchronously on every filter change, so a component that read the
 * end off the cursor would announce the pool exhausted in the middle of a
 * refetch. Only the page knows which of those two things happened, and it
 * knows it in one place - the seq-guarded line right after the page lands.
 */
export function LoadMore({
	cursor,
	loading,
	ended,
	endLabel,
	error,
	onLoadMore,
	style,
}: {
	/** Non-null when there is another page to ask for. */
	cursor: string | null;
	loading: boolean;
	/** True once an append this control started came back with no more to give. */
	ended: boolean;
	/** What this page calls running out. Page content, so the page supplies it. */
	endLabel: string;
	error: string | null;
	onLoadMore: () => void;
	/** Merged into the wrapper, for spacing the host page owns. */
	style?: CSSProperties;
}) {
	const endRef = useRef<HTMLParagraphElement | null>(null);

	useEffect(() => {
		if (!ended) return;
		// Only when the unmounting button was the thing holding focus. Someone
		// who pressed Load more and then moved on - into the rows, or a link -
		// is standing somewhere deliberately, and pulling them back here would
		// be a second defect wearing the first one's clothes. `document.body`
		// is exactly the state the button's removal leaves behind, so testing
		// for it targets the loss itself rather than guessing at intent.
		if (document.activeElement !== document.body) return;
		endRef.current?.focus();
	}, [ended]);

	// Nothing to say: no next page, no ending worth announcing, no failure.
	// Returning null rather than an empty wrapper because the wrapper carries
	// the host page's spacing, and an empty one would leave that spacing
	// behind as a gap under a list that has simply stopped.
	if (!cursor && !ended && !error) return null;

	return (
		// A grid rather than plain flow, which unifies something the two copies
		// of this control had also drifted on: the feed's button was a direct
		// child of a grid and stretched, the pool's sat in a block div and hugged
		// its text. One component cannot keep both. Stretching is the one kept -
		// a control that ends a list reads as a full-width rule under it, and it
		// is the newer of the two.
		<div style={{ display: "grid", gap: "var(--space-2)", ...style }}>
			{cursor ? (
				<Button
					loading={loading}
					// Not a prop. This is chrome rather than page content, and the
					// two copies of this control diverged on precisely this string
					// - "Loading…" against "Loading..." - while both were free to
					// spell it themselves. Every other pending control in the app
					// uses ASCII dots, including `Button`'s and `SubmitButton`'s
					// own "Working..." defaults; U+2026 is for prose.
					loadingLabel="Loading..."
					onClick={onLoadMore}
				>
					Load more
				</Button>
			) : null}

			{ended ? (
				// Not a live region, unlike MachinesPage's status paragraph and
				// unlike the pool's own result summary directly above this. Both
				// of those must speak when focus cannot come to them; this one is
				// rendered at the exact moment a press retired the button under
				// the reader's finger, so moving focus here announces it once.
				// Adding `role="status"` on top would make one press on the pool
				// speak three times: the new count, this region's arrival, and
				// the focus move.
				<p
					ref={endRef}
					// Focusable only by script - it is a destination, not a stop
					// on the way through the page.
					tabIndex={-1}
					style={{ margin: 0, color: PALETTE.muted }}
				>
					{endLabel}
				</p>
			) : null}

			{error ? (
				<p role="alert" style={{ color: PALETTE.danger }}>
					{error}
				</p>
			) : null}
		</div>
	);
}
