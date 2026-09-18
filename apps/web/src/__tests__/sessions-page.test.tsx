// Pinned for the same reason activity-page.test.tsx pins it: SessionsPage
// groups rows by `toLocaleDateString`, so the day a timestamp falls on
// depends on the runner's zone. See that file's comment for the full case.
process.env.TZ = "UTC";

import { act, fireEvent, render, screen } from "@testing-library/react";
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
});

describe("/sessions with a session logged", () => {
	it("renders a session's shape", async () => {
		renderAppAt("/sessions");

		expect(await screen.findByText(/6,311 tool/i)).toBeDefined();
		expect(screen.getByText(/100 session/i)).toBeDefined();
		expect(screen.getByText(/81 skill/i)).toBeDefined();
	});

	it("groups sessions by day", async () => {
		mocks.listSessions.mockResolvedValue(TWO_DAYS);
		renderAppAt("/sessions");

		expect(await screen.findAllByRole("heading", { level: 2 })).toHaveLength(2);
	});
});
