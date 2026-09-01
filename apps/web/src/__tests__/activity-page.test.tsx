// Pinned above every import that could touch a Date, before anything in this
// file (or a dependency it pulls in) has a chance to resolve a default
// timezone. ActivityPage groups events by `toLocaleDateString`, so the day a
// timestamp falls on depends on the runner's zone - the fixture's seq-3 and
// seq-2 events are both meant to land on 2026-08-31, but at offsets around
// +7 to +9 (Bangkok, Shanghai, Tokyo) 18:00 UTC rolls into the next local
// day, splitting one heading into two and failing the grouping assertion.
// No offset choice for the fixture fixes this: for any two instants, some
// band of the real -12..+14 offset range splits them. Pinning the zone is
// the only fix that isn't fragile. No other test in this repo asserts on a
// formatted date, so there's no established pattern to match here.
process.env.TZ = "UTC";

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({
			user: { id: "u1", email: "someone@example.com", name: "Someone" },
			loading: false,
			logout: vi.fn(),
			refresh: vi.fn(),
			sessionExpiresAt: null,
			sessionExpiringSoon: false,
		}),
		RequireAuth: ({ children }: { children: React.ReactNode }) => children,
	},
}));

// Three events: two share a day (seq 3 and seq 2, both 2026-08-31) and one
// falls on a different day (seq 1, 2026-08-30). Kept in descending seq order,
// matching the API's real ordering (lessons.ts:472), so this also exercises
// the grouping loop's adjacency assumption honestly.
//
// Two events sharing a day is the point: a heading-count assertion against
// events that are ALL on different days would pass even if the merge branch
// were deleted and every event got its own heading. With seq 3 and seq 2
// merged, the assertion can only stay at 2 headings if the merge actually
// happens - see the "groups events under a heading per day" test.
//
// The status event carries status "retracted" on purpose - see the test that
// asserts the word never renders.
const POPULATED = {
	events: [
		{
			seq: 3,
			kind: "create",
			at: "2026-08-31T18:00:00Z",
			lesson_id: "l3",
			claim: "Cache node_modules between CI runs",
			applies_to: null,
			status: "active",
		},
		{
			seq: 2,
			kind: "status",
			at: "2026-08-31T14:00:00Z",
			lesson_id: "l2",
			claim: "Pin vitest and vite to compatible majors",
			applies_to: null,
			status: "retracted",
		},
		{
			seq: 1,
			kind: "create",
			at: "2026-08-30T09:00:00Z",
			lesson_id: "l1",
			claim: "Prefer explicit imports",
			applies_to: null,
			status: "active",
		},
	],
	cursor: null,
	has_more: false,
};

const EMPTY = { events: [], cursor: null, has_more: false };

// Mutable because the mock closes over it, so it MUST be reset per test.
// Reassigning at the end of the one test that changes it is not enough: a test
// added after that one would inherit whatever the last one left behind, and an
// empty feed renders an empty state that looks like a legitimate pass.
const fetchState = {
	data: POPULATED as unknown,
	loading: false,
	error: null as string | null,
};

beforeEach(() => {
	fetchState.data = POPULATED;
	fetchState.loading = false;
	fetchState.error = null;
});

vi.mock("../hooks/useAuthenticatedFetch", () => ({
	useAuthenticatedFetch: () => ({ ...fetchState, refetch: vi.fn() }),
}));

const { default: App } = await import("../App");

function renderAppAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<App />
		</MemoryRouter>,
	);
}

describe("/activity", () => {
	it("renders inside the shell", () => {
		renderAppAt("/activity");
		expect(
			screen.getByRole("link", { name: /lessons/i }).getAttribute("href"),
		).toBe("/lessons");
	});

	it("shows each event's claim", () => {
		renderAppAt("/activity");
		expect(screen.getByText(/pin vitest and vite/i)).toBeDefined();
		expect(screen.getByText(/prefer explicit imports/i)).toBeDefined();
	});

	// Three events, two of them (seq 3 and seq 2) on the same day: if grouping
	// actually merges same-day events, this yields 2 headings, not 3. A
	// heading count alone can't distinguish real merging from no merging at
	// all unless at least two fixture events share a day - which is why this
	// isn't "one event per day".
	it("groups events under a heading per day", () => {
		renderAppAt("/activity");
		expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
	});

	// A status row names no state on purpose: lesson_feed records THAT a status
	// changed, not to what, so labeling an old event with the lesson's current
	// status would be wrong for anything that changed twice.
	it("does not label a status event with the lesson's current status", () => {
		renderAppAt("/activity");
		expect(screen.queryByText(/retracted/i)).toBeNull();
	});
});

describe("/activity when the feed is empty", () => {
	// The common case for a new account, so it needs written copy rather than
	// a blank panel. beforeEach puts the populated fixture back afterward.
	it("explains the empty state instead of rendering nothing", () => {
		fetchState.data = EMPTY;
		renderAppAt("/activity");
		expect(screen.getByText(/nothing has happened yet/i)).toBeDefined();
	});
});
