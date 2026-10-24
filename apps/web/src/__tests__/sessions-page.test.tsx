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
			counts_by_project: {},
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
			counts_by_project: {},
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
			counts_by_project: {},
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
		// By testid rather than `getByText(/6,311 tool/).closest("div")`. The
		// old query inferred the row from one of its children, so it depended
		// on the breakdown and the metrics sharing a single element - and broke
		// the moment ONL-173 gave the row two lines, without anything being
		// wrong. The testid is what this assertion actually means by "a row".
		const row = screen.getByTestId("session-row");
		expect(within(row).getByText(/5 prompts/)).toBeTruthy();
		expect(within(row).getByText(/1 compaction/)).toBeTruthy();
		expect(within(row).getByText(/6,311 tool/i)).toBeTruthy();
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
			counts_by_project: {},
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

	// ONL-173. Before this, every row printed the machine name, so a
	// single-machine account - the common case - rendered the same word down
	// the entire feed between the time and the metrics.
	describe("the machine name, repeated only where it informs", () => {
		const TWO_MACHINES = {
			machines: [
				...ONE_MACHINE.machines,
				{
					id: "m2",
					name: "desktop",
					created_at: "2026-08-01T00:00:00Z",
					last_used_at: "2026-09-01T00:00:00Z",
					revoked_at: null,
					inventory_at: null,
					plugin_count: null,
				},
			],
		};

		/** Three sessions on ONE day: same machine twice, then a different one. */
		const ONE_DAY_TWO_MACHINES = {
			sessions: [
				{
					session_id: "a",
					machine_id: "m1",
					started_at: "2026-09-16T12:00:00Z",
					ended_at: "2026-09-16T12:05:00Z",
					event_count: 10,
					counts_by_prefix: { tool: 10 },
					counts_by_project: {},
					plugins: [],
					prompts: 1,
					compactions: 0,
				},
				{
					session_id: "b",
					machine_id: "m1",
					started_at: "2026-09-16T11:00:00Z",
					ended_at: "2026-09-16T11:05:00Z",
					event_count: 10,
					counts_by_prefix: { tool: 10 },
					counts_by_project: {},
					plugins: [],
					prompts: 1,
					compactions: 0,
				},
				{
					session_id: "c",
					machine_id: "m2",
					started_at: "2026-09-16T10:00:00Z",
					ended_at: "2026-09-16T10:05:00Z",
					event_count: 10,
					counts_by_prefix: { tool: 10 },
					counts_by_project: {},
					plugins: [],
					prompts: 1,
					compactions: 0,
				},
			],
			cursor: null,
			has_more: false,
		};

		it("names the machine on the first row, drops the repeat, and says it again when it changes", async () => {
			mocks.listSessions.mockResolvedValue(ONE_DAY_TWO_MACHINES);
			mocks.listMachines.mockResolvedValue(TWO_MACHINES);
			renderAppAt("/sessions");

			await screen.findByText(/12:00/);
			const rows = screen.getAllByTestId("session-row");
			expect(rows).toHaveLength(3);

			// Asserted per row rather than by counting occurrences across the
			// page: "work laptop appears once" would also pass if it appeared
			// on the wrong row.
			expect(within(rows[0]).queryByText("work laptop")).not.toBeNull();
			expect(within(rows[1]).queryByText("work laptop")).toBeNull();
			expect(within(rows[2]).queryByText("desktop")).not.toBeNull();
		});

		it("names it again on the next day, so no panel opens without one", async () => {
			// The comparison is within a day group, not across the feed. Were
			// it across, the second day's first row would inherit the previous
			// day's last machine and print nothing.
			mocks.listSessions.mockResolvedValue(TWO_DAYS);
			mocks.listMachines.mockResolvedValue(ONE_MACHINE);
			renderAppAt("/sessions");

			await screen.findByText(/10:00/);
			const rows = screen.getAllByTestId("session-row");
			expect(rows).toHaveLength(2);
			expect(within(rows[0]).queryByText("work laptop")).not.toBeNull();
			expect(within(rows[1]).queryByText("work laptop")).not.toBeNull();
		});
	});

	describe("the breakdown's hidden tail", () => {
		const NINE_PREFIXES = {
			sessions: [
				{
					session_id: "s1",
					machine_id: "m1",
					started_at: "2026-09-16T10:00:00Z",
					ended_at: "2026-09-16T10:42:00Z",
					event_count: 35,
					counts_by_prefix: {
						memory: 18,
						historian: 7,
						session: 3,
						bursar: 2,
						curator: 2,
						scribe: 1,
					},
					counts_by_project: {},
					plugins: [],
					prompts: 1,
					compactions: 0,
				},
			],
			cursor: null,
			has_more: false,
		};

		it("shows the top three and keeps the rest in a title", async () => {
			mocks.listSessions.mockResolvedValue(NINE_PREFIXES);
			renderAppAt("/sessions");

			const row = await screen.findByTestId("session-row");
			expect(
				within(row).getByText(/18 memory · 7 historian · 3 session/),
			).toBeTruthy();

			// The tail is recoverable rather than discarded: these counts
			// appear nowhere else in the app, and the page used to show all of
			// them. Asserted on the title because that is the only place the
			// hidden ones survive.
			const more = within(row).getByText(/\+3 more/);
			expect(more.getAttribute("title")).toBe(
				"2 bursar · 2 curator · 1 scribe",
			);
		});

		it("says nothing about a tail when every count fits", async () => {
			mocks.listSessions.mockResolvedValue(ONE_SESSION);
			renderAppAt("/sessions");

			const row = await screen.findByTestId("session-row");
			expect(within(row).queryByText(/more$/)).toBeNull();
		});
	});
});

describe("/sessions per repository", () => {
	// Shaped after a real production session (0250bcb5, 2026-10-24): four
	// repositories in one session, one of them root-derived. Plus a second,
	// single-repository session, and one from before the CLI recorded any.
	const MULTI_REPO = {
		sessions: [
			{
				session_id: "s3",
				machine_id: "m1",
				started_at: "2026-09-16T12:00:00Z",
				ended_at: "2026-09-16T12:10:00Z",
				event_count: 41,
				counts_by_prefix: { memory: 41 },
				counts_by_project: {
					"6a7678979e31": { basis: "remote", event_count: 41 },
				},
				plugins: [],
				prompts: 1,
				compactions: 0,
			},
			{
				session_id: "s2",
				machine_id: "m1",
				started_at: "2026-09-16T10:00:00Z",
				ended_at: "2026-09-16T10:42:00Z",
				event_count: 223,
				counts_by_prefix: { tool: 90, inspector: 53, memory: 80 },
				counts_by_project: {
					ee2cfbe428c7: { basis: "remote", event_count: 181 },
					"54460a64b16d": { basis: "remote", event_count: 35 },
					"9701ec23092a": { basis: "remote", event_count: 2 },
					a2241956835d: { basis: "root", event_count: 1 },
				},
				plugins: [],
				prompts: 3,
				compactions: 0,
			},
			{
				session_id: "s1",
				machine_id: "m1",
				started_at: "2026-09-16T09:00:00Z",
				ended_at: "2026-09-16T09:20:00Z",
				event_count: 25,
				counts_by_prefix: { tool: 25 },
				counts_by_project: {},
				plugins: [],
				prompts: 1,
				compactions: 0,
			},
		],
		cursor: null,
		has_more: false,
	};

	it("breaks a multi-repository session down on its row", async () => {
		mocks.listSessions.mockResolvedValue(MULTI_REPO);
		renderAppAt("/sessions");

		const rows = await screen.findAllByTestId("session-row");
		const repos = within(rows[1]).getByTestId("session-repos");
		expect(repos.textContent).toMatch(/181 ee2cfbe428c7 · 35 54460a64b16d/);

		// The tail survives in a title, as the event breakdown's does.
		const more = within(repos).getByText(/\+2 more/);
		expect(more.getAttribute("title")).toBe("2 9701ec23092a · 1 a2241956835d");
	});

	it("says nothing about repositories on a row that carried none", async () => {
		mocks.listSessions.mockResolvedValue(MULTI_REPO);
		renderAppAt("/sessions");

		const rows = await screen.findAllByTestId("session-row");
		expect(within(rows[2]).queryByTestId("session-repos")).toBeNull();
	});

	it("rolls the loaded sessions up per repository", async () => {
		mocks.listSessions.mockResolvedValue(MULTI_REPO);
		renderAppAt("/sessions");

		const panel = await screen.findByTestId("repositories-summary");
		const rows = within(panel).getAllByTestId("repository-row");
		expect(rows.map((r) => r.textContent)).toEqual([
			expect.stringMatching(/ee2cfbe428c7.*1 session · 181 events/),
			expect.stringMatching(/6a7678979e31.*1 session · 41 events/),
			expect.stringMatching(/54460a64b16d.*1 session · 35 events/),
			expect.stringMatching(/9701ec23092a.*1 session · 2 events/),
			expect.stringMatching(/a2241956835d.*1 session · 1 event$/),
		]);
	});

	// A root key hashes a local path, so it names a repository only on the
	// machine that reported it. The row has to say which machine, or it reads
	// as portable as every other key.
	it("names the machine a root-derived key belongs to", async () => {
		mocks.listSessions.mockResolvedValue(MULTI_REPO);
		renderAppAt("/sessions");

		const panel = await screen.findByTestId("repositories-summary");
		const root = within(panel)
			.getAllByTestId("repository-row")
			.find((r) => r.textContent?.includes("a2241956835d"));
		expect(root?.textContent).toMatch(/work laptop only/);
	});

	it("says how many loaded sessions it could not place", async () => {
		mocks.listSessions.mockResolvedValue(MULTI_REPO);
		renderAppAt("/sessions");

		const panel = await screen.findByTestId("repositories-summary");
		expect(
			within(panel).queryByText(/1 session carried no repository/),
		).not.toBeNull();
	});

	// Every row predates the column: nothing to roll up, and a panel that
	// only says "nothing here" is noise above the feed.
	it("renders no panel when no session carried a repository", async () => {
		mocks.listSessions.mockResolvedValue(ONE_SESSION);
		renderAppAt("/sessions");

		await screen.findByTestId("session-row");
		expect(screen.queryByTestId("repositories-summary")).toBeNull();
	});
});
