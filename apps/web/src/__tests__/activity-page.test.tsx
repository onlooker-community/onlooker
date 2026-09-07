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
// matching the real ordering from `listActivityPage`'s `ORDER BY f.seq DESC`
// in apps/api/src/db/lessons.ts, so this also matches what the API actually
// returns.
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

const mocks = vi.hoisted(() => ({ listActivity: vi.fn() }));

// importOriginal rather than a bare factory: App's route table pulls in
// LessonsPage, which imports listLessons from this same module. A factory that
// returned only listActivity would leave that binding undefined at module
// evaluation, breaking a route this file never renders.
vi.mock("../api/lessonsApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/lessonsApi")>()),
	listActivity: mocks.listActivity,
}));

beforeEach(() => {
	mocks.listActivity.mockReset().mockResolvedValue(POPULATED);
});

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

	it("shows each event's claim", async () => {
		renderAppAt("/activity");
		expect(await screen.findByText(/pin vitest and vite/i)).toBeDefined();
		expect(screen.getByText(/prefer explicit imports/i)).toBeDefined();
	});

	// Three events, two of them (seq 3 and seq 2) on the same day: if grouping
	// actually merges same-day events, this yields 2 headings, not 3.
	it("groups events under a heading per day", async () => {
		renderAppAt("/activity");
		expect(await screen.findAllByRole("heading", { level: 2 })).toHaveLength(2);
	});

	// A status row names no state on purpose. The await is load-bearing: a
	// queryByText against a page that has not rendered yet returns null and
	// passes vacuously, so this must wait for real content before asserting an
	// absence.
	it("does not label a status event with the lesson's current status", async () => {
		renderAppAt("/activity");
		await screen.findByText(/pin vitest and vite/i);
		expect(screen.queryByText(/retracted/i)).toBeNull();
	});
});

describe("/activity when the feed is empty", () => {
	// The common case for a new account, so it needs written copy rather than
	// a blank panel. beforeEach puts the populated fixture back afterward.
	it("explains the empty state instead of rendering nothing", async () => {
		mocks.listActivity.mockResolvedValue(EMPTY);
		renderAppAt("/activity");
		expect(await screen.findByText(/nothing has happened yet/i)).toBeDefined();
	});
});
