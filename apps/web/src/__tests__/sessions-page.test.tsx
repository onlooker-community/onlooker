// Pinned for the same reason activity-page.test.tsx pins it: SessionsPage
// groups rows by `toLocaleDateString`, so the day a timestamp falls on
// depends on the runner's zone. See that file's comment for the full case.
process.env.TZ = "UTC";

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SessionsPage from "../pages/SessionsPage";

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

const mocks = vi.hoisted(() => ({
	listSessions: vi.fn(),
	listMachines: vi.fn(),
}));

vi.mock("../api/sessionsApi", () => ({
	SESSION_ENDPOINTS: { sessions: "/api/sessions" },
	listSessions: mocks.listSessions,
}));

// importOriginal rather than a bare factory: App's route table also pulls in
// MachinesPage, which imports createMachine and revokeMachine from this same
// module. A factory answering only listMachines would leave those bindings
// undefined at module evaluation, breaking a route this file never renders -
// the same reasoning lessons-page.test.tsx gives for lessonsApi.
vi.mock("../api/machinesApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/machinesApi")>()),
	listMachines: mocks.listMachines,
}));

const EMPTY = { sessions: [], cursor: null, has_more: false };
const NO_MACHINES = { machines: [] };

const ONE_MACHINE = {
	machines: [
		{
			id: "m1",
			name: "work laptop",
			created_at: "2026-08-01T00:00:00Z",
			last_used_at: "2026-09-01T00:00:00Z",
			revoked_at: null,
			inventory_at: null,
			plugin_count: null,
		},
	],
};

// A token minted but never presented by `sync` - `last_used_at` stays null
// until then (see machinesApi.ts's own doc comment on `Machine.last_used_at`)
// - not revoked, just never used. This is the case the old `machines.length
// > 0` predicate could not tell apart from `ONE_MACHINE`.
const NOT_YET_SYNCED = {
	machines: [
		{
			id: "m2",
			name: "new laptop",
			created_at: "2026-09-10T00:00:00Z",
			last_used_at: null,
			revoked_at: null,
			inventory_at: null,
			plugin_count: null,
		},
	],
};

// A machine that DID sync, never cleared the reporting threshold, and was
// revoked afterwards. Revoking a token stops it reporting anything new; it
// cannot un-send what it already reported. So this account has synced, and
// the empty state that asks about the past has to say so.
const REVOKED_AFTER_SYNC = {
	machines: [
		{
			id: "m3",
			name: "old laptop",
			created_at: "2026-08-01T00:00:00Z",
			last_used_at: "2026-09-01T00:00:00Z",
			revoked_at: "2026-09-05T00:00:00Z",
			inventory_at: null,
			plugin_count: null,
		},
	],
};

// The shape from the brief's step 2: 6,311 tool, 100 session, 81 skill.
const ONE_SESSION = {
	sessions: [
		{
			session_id: "s1",
			machine_id: "m1",
			started_at: "2026-09-16T10:00:00Z",
			ended_at: "2026-09-16T10:42:00Z",
			event_count: 6492,
			counts_by_prefix: { tool: 6311, session: 100, skill: 81 },
			plugins: ["lineage"],
			prompts: 5,
			compactions: 1,
		},
	],
	cursor: null,
	has_more: false,
};

// Two sessions on different days - the point is a heading-count assertion
// that can only stay at 2 if the grouping actually runs, matching how
// activity-page.test.tsx's own day-grouping fixture is built.
const TWO_DAYS = {
	sessions: [
		{
			session_id: "s2",
			machine_id: "m1",
			started_at: "2026-09-16T10:00:00Z",
			ended_at: "2026-09-16T10:42:00Z",
			event_count: 30,
			counts_by_prefix: { tool: 25, session: 5 },
			plugins: [],
			prompts: 1,
			compactions: 0,
		},
		{
			session_id: "s1",
			machine_id: "m1",
			started_at: "2026-09-15T09:00:00Z",
			ended_at: "2026-09-15T09:20:00Z",
			event_count: 25,
			counts_by_prefix: { tool: 20, session: 5 },
			plugins: [],
			prompts: 1,
			compactions: 0,
		},
	],
	cursor: null,
	has_more: false,
};

beforeEach(() => {
	mocks.listSessions.mockReset().mockResolvedValue(ONE_SESSION);
	mocks.listMachines.mockReset().mockResolvedValue(ONE_MACHINE);
});

const { default: App } = await import("../App");

function renderAppAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<App />
		</MemoryRouter>,
	);
}

describe("/sessions", () => {
	it("renders inside the shell", () => {
		renderAppAt("/sessions");
		expect(
			screen.getByRole("link", { name: /lessons/i }).getAttribute("href"),
		).toBe("/lessons");
	});
});

// The two empty states are different facts and must not read alike. An empty
// pool that told someone to connect a machine when they had simply filtered
// to a status nothing held is the precedent - see LessonsPage.
describe("/sessions when nothing has synced", () => {
	it("says nothing has synced when no machine has reported", async () => {
		mocks.listSessions.mockResolvedValue(EMPTY);
		mocks.listMachines.mockResolvedValue(NO_MACHINES);
		renderAppAt("/sessions");

		expect(await screen.findByText(/no machine has synced/i)).toBeDefined();
		expect(
			screen
				.getByRole("link", { name: /connect a machine/i })
				.getAttribute("href"),
		).toBe("/machines");
	});

	it("says nothing cleared the threshold when machines have synced", async () => {
		mocks.listSessions.mockResolvedValue(EMPTY);
		mocks.listMachines.mockResolvedValue(ONE_MACHINE);
		renderAppAt("/sessions");

		expect(await screen.findByText(/threshold/i)).toBeDefined();
		expect(
			screen.queryByRole("link", { name: /connect a machine/i }),
		).toBeNull();
	});

	// The race the mock harness otherwise cannot reproduce: `mockResolvedValue`
	// settles both reads in the same microtask flush, so nothing in the tests
	// above can tell "gated on the machines read" apart from "raced it." Here
	// the sessions read is real (mockResolvedValue) but the machines read is a
	// promise this test holds open by hand, so it is genuinely still pending
	// when the sessions read lands - not a timing accident.
	it("claims neither fact about machines while that read is still pending", async () => {
		mocks.listSessions.mockResolvedValue(EMPTY);
		let resolveMachines: (value: { machines: unknown[] }) => void = () => {};
		mocks.listMachines.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMachines = resolve;
				}),
		);
		renderAppAt("/sessions");

		// A macrotask flush drains every microtask ahead of it, including the
		// sessions promise's `.then` and the state update it makes - which is
		// the only way to let that settle without asserting on an
		// implementation-only intermediate render.
		await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

		expect(screen.queryByText(/no machine has synced/i)).toBeNull();
		expect(screen.queryByText(/threshold/i)).toBeNull();

		await act(async () => {
			resolveMachines({ machines: [] });
		});

		expect(await screen.findByText(/no machine has synced/i)).toBeDefined();
		expect(screen.queryByText(/threshold/i)).toBeNull();
	});

	// The conflation the whole-branch review found: `hasMachines` used to ask
	// "has this account ever minted a token," not "has any machine ever
	// synced." A token minted but never presented by `sync` must read the
	// same as no machine at all - it is not the fact this page's threshold
	// copy claims either.
	it("says nothing has synced when a machine was minted but never used", async () => {
		mocks.listSessions.mockResolvedValue(EMPTY);
		mocks.listMachines.mockResolvedValue(NOT_YET_SYNCED);
		renderAppAt("/sessions");

		expect(await screen.findByText(/no machine has synced/i)).toBeDefined();
		expect(screen.queryByText(/threshold/i)).toBeNull();
	});

	// The failed-read state and its Retry - previously untested. Neither
	// empty state is safe to guess at when the read that would settle it
	// failed outright, so this asserts the third, honest state and that
	// Retry recovers through the exact same read rather than a dead end.
	it("offers a retry when the machines check fails, and recovers through it", async () => {
		mocks.listSessions.mockResolvedValue(EMPTY);
		mocks.listMachines.mockRejectedValueOnce(new Error("machines API is down"));
		renderAppAt("/sessions");

		expect(
			await screen.findByRole("heading", {
				name: /could not check your machines/i,
			}),
		).toBeDefined();
		expect(await screen.findByText(/machines API is down/i)).toBeDefined();

		mocks.listMachines.mockResolvedValue(NO_MACHINES);
		fireEvent.click(screen.getByRole("button", { name: /retry/i }));

		expect(await screen.findByText(/no machine has synced/i)).toBeDefined();
		expect(mocks.listMachines).toHaveBeenCalledTimes(2);
	});

	// The question this empty state asks is about the past - has anything
	// ever reported - and revoking a token does not reach backwards. A
	// machine that synced, stayed under the threshold, and was revoked later
	// is an account that HAS synced, so telling its owner to go connect a
	// machine is false and sends them somewhere that will not help.
	it("says nothing cleared the threshold when the only synced machine was later revoked", async () => {
		mocks.listSessions.mockResolvedValue(EMPTY);
		mocks.listMachines.mockResolvedValue(REVOKED_AFTER_SYNC);
		renderAppAt("/sessions");

		expect(await screen.findByText(/threshold/i)).toBeDefined();
		expect(screen.queryByText(/no machine has synced/i)).toBeNull();
	});
});

describe("/sessions with a session logged", () => {
	// Two machines reporting on the same day otherwise produce rows that look
	// identical. The id the API returns is a token id, not a name, so the
	// name has to come from the machines list the page already reads to tell
	// its two empty states apart.
	it("names the machine a session came from", async () => {
		mocks.listSessions.mockResolvedValue(ONE_SESSION);
		mocks.listMachines.mockResolvedValue(ONE_MACHINE);
		renderAppAt("/sessions");

		expect(await screen.findByText(/work laptop/i)).toBeDefined();
	});

	// A session outlives the machine that reported it - revoke or delete the
	// token and the history it already sent stays. The row still has to say
	// something, and echoing a raw token id would be worse than admitting the
	// name is gone.
	it("falls back when a session's machine is no longer listed", async () => {
		mocks.listSessions.mockResolvedValue(ONE_SESSION);
		mocks.listMachines.mockResolvedValue(NO_MACHINES);
		renderAppAt("/sessions");

		expect(await screen.findByText(/unknown machine/i)).toBeDefined();
	});

	it("renders a session's shape", async () => {
		renderAppAt("/sessions");

		expect(await screen.findByText(/6,311 tool/i)).toBeDefined();
		expect(screen.getByText(/100 session/i)).toBeDefined();
		expect(screen.getByText(/81 skill/i)).toBeDefined();
	});

	it("groups sessions by day", async () => {
		mocks.listSessions.mockResolvedValue(TWO_DAYS);
		renderAppAt("/sessions");

		// Excludes the summary header's own "What you loaded" heading by name
		// rather than by count: that Panel is a level-2 heading too now, and a
		// bare length check would conflate "one panel per day" with "one panel
		// per day plus the summary."
		const headings = await screen.findAllByRole("heading", { level: 2 });
		const dayHeadings = headings.filter(
			(h) => h.textContent !== "What you loaded",
		);
		expect(dayHeadings).toHaveLength(2);
	});
});

describe("/sessions summary header", () => {
	it("asks for a full page so the header can cover the history", async () => {
		mocks.listSessions.mockResolvedValue(ONE_SESSION);
		mocks.listMachines.mockResolvedValue(ONE_MACHINE);
		await act(async () => {
			render(
				<MemoryRouter>
					<SessionsPage />
				</MemoryRouter>,
			);
		});
		expect(mocks.listSessions).toHaveBeenCalledWith({ limit: 200 });
	});

	// The load-bearing assertion. The header's numbers are derived, and the
	// failure this guards is a rollup that drifts from the rows beside it -
	// which looks authoritative and reads as fact. Compared against the rows
	// actually rendered in the DOM rather than a fixture constant, so a page
	// that silently dropped a row would show a headline that no longer
	// matches what's on screen instead of passing by coincidence.
	//
	// Scoped to the summary Panel's own headline (`sessions-headline`)
	// rather than an anchored page-wide regex: SessionsSummary also renders
	// one "N sessions" row per day, so an unanchored match - or even an
	// anchored one, if a fixture ever put every session on a single day -
	// can find more than one element.
	it("header totals match the rows rendered", async () => {
		mocks.listSessions.mockResolvedValue(TWO_DAYS);
		mocks.listMachines.mockResolvedValue(ONE_MACHINE);
		await act(async () => {
			render(
				<MemoryRouter>
					<SessionsPage />
				</MemoryRouter>,
			);
		});
		const renderedRows = screen.getAllByTestId("session-row");
		const headline = screen.getByTestId("sessions-headline");
		expect(headline.textContent).toMatch(
			new RegExp(`^${renderedRows.length} sessions`),
		);
	});

	it("says most recent rather than a total when more pages remain", async () => {
		mocks.listSessions.mockResolvedValue({
			...ONE_SESSION,
			cursor: "c1",
			has_more: true,
		});
		mocks.listMachines.mockResolvedValue(ONE_MACHINE);
		await act(async () => {
			render(
				<MemoryRouter>
					<SessionsPage />
				</MemoryRouter>,
			);
		});
		expect(screen.getByText(/most recent 1 session/)).toBeTruthy();
	});

	// Scoped to the row itself, not a page-wide getByText: SessionsSummary's
	// own "Longest" line restates this same session's prompts and
	// compactions count, so an unscoped query would find both. "6,311 tool"
	// only ever comes from shapeOf on this row, so its closest row div is an
	// unambiguous anchor for the row this test is actually about.
	it("shows prompts and compactions on a row", async () => {
		mocks.listSessions.mockResolvedValue(ONE_SESSION);
		mocks.listMachines.mockResolvedValue(ONE_MACHINE);
		await act(async () => {
			render(
				<MemoryRouter>
					<SessionsPage />
				</MemoryRouter>,
			);
		});
		const row = screen.getByText(/6,311 tool/i).closest("div");
		expect(row).not.toBeNull();
		expect(within(row as HTMLElement).getByText(/5 prompts/)).toBeTruthy();
		expect(within(row as HTMLElement).getByText(/1 compaction/)).toBeTruthy();
	});

	it("renders no header when there are no sessions", async () => {
		mocks.listSessions.mockResolvedValue(EMPTY);
		mocks.listMachines.mockResolvedValue(ONE_MACHINE);
		await act(async () => {
			render(
				<MemoryRouter>
					<SessionsPage />
				</MemoryRouter>,
			);
		});
		// Not /sessions ·/: SessionsSummary only emits "·" when duration or
		// range is non-empty, so that regex would pass even if the header
		// leaked into this empty state with zeroed totals. Anchoring on the
		// Panel's own heading tests the fact this case is named for - that no
		// header renders at all - rather than a wording detail of one.
		expect(screen.queryByText("What you loaded")).toBeNull();
	});

	// The design's central claim, exercised across a page boundary: nothing
	// else drove `loadMore` and re-checked the header. Every way `loadMore`
	// can go wrong leaves `hasMore` stale-true, which errs toward "most
	// recent" rather than silently overstating a total - but that bias was
	// never actually pinned by a test.
	it("switches from most recent to a total once loadMore exhausts the pages", async () => {
		const SECOND_PAGE_SESSION = {
			session_id: "s3",
			machine_id: "m1",
			started_at: "2026-09-17T10:00:00Z",
			ended_at: "2026-09-17T10:20:00Z",
			event_count: 20,
			counts_by_prefix: { tool: 20 },
			plugins: [],
			prompts: 1,
			compactions: 0,
		};
		mocks.listSessions
			.mockReset()
			.mockResolvedValueOnce({
				sessions: [ONE_SESSION.sessions[0]],
				cursor: "c1",
				has_more: true,
			})
			.mockResolvedValueOnce({
				sessions: [SECOND_PAGE_SESSION],
				cursor: null,
				has_more: false,
			});
		mocks.listMachines.mockResolvedValue(ONE_MACHINE);
		await act(async () => {
			render(
				<MemoryRouter>
					<SessionsPage />
				</MemoryRouter>,
			);
		});

		expect(
			(await screen.findByTestId("sessions-headline")).textContent,
		).toMatch(/^most recent 1 session/);

		fireEvent.click(screen.getByRole("button", { name: /load more/i }));

		await waitFor(() => {
			expect(screen.getAllByTestId("session-row")).toHaveLength(2);
		});
		const headline = screen.getByTestId("sessions-headline");
		expect(headline.textContent).toMatch(/^2 sessions/);
		expect(headline.textContent).not.toMatch(/most recent/);
		expect(mocks.listSessions).toHaveBeenLastCalledWith({
			cursor: "c1",
			limit: 200,
		});
	});
});
