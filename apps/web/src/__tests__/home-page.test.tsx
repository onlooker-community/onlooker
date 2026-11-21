process.env.TZ = "UTC";

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "../api/lessonsApi";
import type { Inventory, Machine } from "../api/machinesApi";
import type { SessionSummary } from "../api/sessionsApi";
import HomePage from "../pages/HomePage";

const mocks = vi.hoisted(() => ({
	listSessions: vi.fn(),
	listLabels: vi.fn(),
	listMachines: vi.fn(),
	getMachineInventory: vi.fn(),
	listActivity: vi.fn(),
}));

vi.mock("../api/machinesApi", () => ({
	listMachines: mocks.listMachines,
	getMachineInventory: mocks.getMachineInventory,
}));

vi.mock("../api/sessionsApi", () => ({
	SESSION_ENDPOINTS: { sessions: "/api/sessions" },
	listSessions: mocks.listSessions,
}));

// importOriginal so labelIdentity stays real, as sessions-page.test.tsx does.
vi.mock("../api/labelsApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/labelsApi")>()),
	listLabels: mocks.listLabels,
}));

// importOriginal so the types and endpoints stay real; only the read is faked.
vi.mock("../api/lessonsApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/lessonsApi")>()),
	listActivity: mocks.listActivity,
}));

function session(over: Partial<SessionSummary> = {}): SessionSummary {
	return {
		session_id: "s1",
		machine_id: "m1",
		started_at: "2026-11-18T10:00:00Z",
		ended_at: "2026-11-18T11:00:00Z",
		event_count: 40,
		counts_by_prefix: {},
		counts_by_type: {},
		counts_by_project: {},
		plugins: [],
		prompts: 3,
		compactions: 0,
		...over,
	};
}

function machine(over: Partial<Machine> = {}): Machine {
	return {
		id: "m1",
		name: "laptop",
		created_at: "2026-11-01T00:00:00Z",
		last_used_at: null,
		revoked_at: null,
		removed_at: null,
		inventory_at: "2026-11-18T00:00:00Z",
		plugin_count: 1,
		org_id: null,
		...over,
	};
}

function inventory(ids: string[]): Inventory {
	return {
		schema_version: 1,
		collected_at: "2026-11-18T00:00:00Z",
		project: null,
		plugins: ids.map((id) => ({
			id,
			scopes: [
				{
					scope: "user",
					version: "1.0.0",
					git_commit_sha: null,
					installed_at: null,
					last_updated: null,
					enabled: true,
				},
			],
		})),
	};
}

function activity(over: Partial<ActivityEvent> = {}): ActivityEvent {
	return {
		seq: 1,
		kind: "create",
		at: "2026-11-18T09:00:00Z",
		lesson_id: "l1",
		claim: "A lesson",
		...over,
	};
}

function renderPage() {
	return render(
		<MemoryRouter>
			<HomePage />
		</MemoryRouter>,
	);
}

describe("HomePage", () => {
	beforeEach(() => {
		// Date only, so promises and Testing Library's polling still run.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-18T15:00:00Z"));
		mocks.listSessions.mockReset();
		mocks.listLabels.mockReset();
		mocks.listLabels.mockResolvedValue(new Map());
		mocks.listMachines.mockReset();
		mocks.getMachineInventory.mockReset();
		mocks.listMachines.mockResolvedValue({ machines: [] });
		mocks.listActivity.mockReset();
		mocks.listActivity.mockResolvedValue({
			events: [],
			cursor: null,
			has_more: false,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("asks for one page of 200", async () => {
		mocks.listSessions.mockResolvedValue({
			sessions: [],
			cursor: null,
			has_more: false,
		});
		renderPage();
		await screen.findByText(/no sessions in the last 7 days/i);
		expect(mocks.listSessions).toHaveBeenCalledWith({ limit: 200 });
	});

	it("shows loading until the sessions arrive", () => {
		mocks.listSessions.mockReturnValue(new Promise(() => {}));
		renderPage();
		// Several panels load at once; the sessions panel is first.
		expect(screen.getAllByRole("status")[0].textContent).toMatch(
			/loading your sessions/i,
		);
	});

	it("counts only the sessions inside the window", async () => {
		mocks.listSessions.mockResolvedValue({
			sessions: [
				session({ session_id: "in" }),
				session({
					session_id: "out",
					started_at: "2026-11-10T10:00:00Z",
					ended_at: "2026-11-10T11:00:00Z",
				}),
			],
			cursor: "next",
			has_more: true,
		});
		renderPage();
		expect(
			(await screen.findByTestId("home-sessions-headline")).textContent,
		).toBe(
			"In the last 7 days your machines reported 1 session, 1h 0m in all.",
		);
	});

	it("says most recent when 200 rows don't reach back to the window's start", async () => {
		mocks.listSessions.mockResolvedValue({
			sessions: [session()],
			cursor: "next",
			has_more: true,
		});
		renderPage();
		expect(
			(await screen.findByTestId("home-sessions-headline")).textContent,
		).toMatch(/^The most recent 1 session/);
	});

	// A failed read is not an empty week.
	it("says it could not load, and never shows the empty state, when the read fails", async () => {
		mocks.listSessions.mockRejectedValue(new Error("Server unreachable"));
		renderPage();
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toMatch(/could not load your sessions/i);
		expect(alert.textContent).toMatch(/server unreachable/i);
		expect(screen.queryByText(/no sessions in the last 7 days/i)).toBeNull();
	});

	// Labels only rename keys. Without them every repository shows its key,
	// which is what the Sessions page does too.
	it("still renders the panel when the labels read fails", async () => {
		mocks.listLabels.mockRejectedValue(new Error("nope"));
		mocks.listSessions.mockResolvedValue({
			sessions: [
				session({
					counts_by_project: {
						aaaaaaaaaaaa: { basis: "remote", event_count: 30 },
					},
				}),
			],
			cursor: null,
			has_more: false,
		});
		renderPage();
		expect(await screen.findByTestId("home-sessions-headline")).toBeTruthy();
		// The raw key is the fallback, not a blank.
		expect(screen.getByText("aaaaaaaaaaaa")).toBeTruthy();
	});

	it("shows the week's plugin activity from the same sessions", async () => {
		mocks.listSessions.mockResolvedValue({
			sessions: [
				session({
					counts_by_type: { "historian.retrieval.surfaced": 4 },
					counts_by_prefix: { historian: 4 },
				}),
			],
			has_more: false,
		});
		renderPage();

		expect(
			await screen.findByText("historian", { selector: "li span" }),
		).toBeDefined();
		expect(screen.getByRole("list", { name: "This week" }).textContent).toBe(
			"historian: produced 4 in 1 session",
		);
	});

	it("reads the inventory of each reporting machine only", async () => {
		mocks.listSessions.mockResolvedValue({ sessions: [], has_more: false });
		mocks.listMachines.mockResolvedValue({
			machines: [
				machine({ id: "live" }),
				machine({ id: "never", inventory_at: null }),
				machine({ id: "gone", revoked_at: "2026-11-02T00:00:00Z" }),
			],
		});
		mocks.getMachineInventory.mockResolvedValue({
			inventory: inventory(["counsel@onlooker-community"]),
			inventory_at: "2026-11-18T00:00:00Z",
		});
		renderPage();

		expect(
			await screen.findByText("Installed, no events in 7 days: counsel."),
		).toBeDefined();
		expect(mocks.getMachineInventory.mock.calls).toEqual([["live"]]);
	});

	it("says it couldn't check when one inventory read fails", async () => {
		mocks.listSessions.mockResolvedValue({ sessions: [], has_more: false });
		mocks.listMachines.mockResolvedValue({
			machines: [machine({ id: "a" }), machine({ id: "b" })],
		});
		mocks.getMachineInventory
			.mockResolvedValueOnce({
				inventory: inventory(["counsel@onlooker-community"]),
				inventory_at: "2026-11-18T00:00:00Z",
			})
			.mockRejectedValueOnce(new Error("boom"));
		renderPage();

		expect(
			await screen.findByText("Couldn't check which plugins are installed."),
		).toBeDefined();
		expect(screen.queryByText(/Installed, no events/)).toBeNull();
	});

	it("says it couldn't check when the machine list fails", async () => {
		mocks.listSessions.mockResolvedValue({ sessions: [], has_more: false });
		mocks.listMachines.mockRejectedValue(new Error("down"));
		renderPage();

		expect(
			await screen.findByText("Couldn't check which plugins are installed."),
		).toBeDefined();
		expect(mocks.getMachineInventory).not.toHaveBeenCalled();
	});

	// One alert for one failure: the Plugins panel says why it is empty
	// without announcing the same failure a second time.
	it("raises one alert when the sessions read fails", async () => {
		mocks.listSessions.mockRejectedValue(new Error("down"));
		renderPage();

		expect(await screen.findAllByRole("alert")).toHaveLength(1);
		expect(
			screen.getByText(
				"Plugin activity comes from your sessions, which could not be loaded.",
			),
		).toBeDefined();
	});

	it("asks for the first page of lesson activity", async () => {
		mocks.listSessions.mockResolvedValue({ sessions: [], has_more: false });
		renderPage();
		await screen.findByText(/no lesson activity yet/i);
		expect(mocks.listActivity).toHaveBeenCalledWith();
	});

	it("counts only the lesson activity inside the window", async () => {
		mocks.listSessions.mockResolvedValue({ sessions: [], has_more: false });
		mocks.listActivity.mockResolvedValue({
			events: [
				activity({ seq: 2 }),
				activity({ seq: 1, at: "2026-11-05T09:00:00Z" }),
			],
			cursor: "next",
			has_more: true,
		});
		renderPage();
		expect(
			(await screen.findByTestId("home-lessons-headline")).textContent,
		).toBe("1 published in the last 7 days");
	});

	it("says latest N events when the page doesn't reach back to the window's start", async () => {
		mocks.listSessions.mockResolvedValue({ sessions: [], has_more: false });
		mocks.listActivity.mockResolvedValue({
			events: [activity()],
			cursor: "next",
			has_more: true,
		});
		renderPage();
		expect(
			(await screen.findByTestId("home-lessons-headline")).textContent,
		).toBe("1 published in your latest 1 event");
	});

	// Older events exist, so the feed is not empty and "yet" would be false.
	it("says the week was quiet when the feed's events are all older", async () => {
		mocks.listSessions.mockResolvedValue({ sessions: [], has_more: false });
		mocks.listActivity.mockResolvedValue({
			events: [activity({ at: "2026-11-01T09:00:00Z" })],
			cursor: null,
			has_more: false,
		});
		renderPage();
		expect(
			await screen.findByText("No lesson activity in the last 7 days."),
		).toBeDefined();
	});

	// A failed read is not a quiet week, and it blanks only its own panel.
	it("says it could not load lesson activity, and never shows the empty state", async () => {
		mocks.listSessions.mockResolvedValue({ sessions: [], has_more: false });
		mocks.listActivity.mockRejectedValue(new Error("Server unreachable"));
		renderPage();
		const alerts = await screen.findAllByRole("alert");
		expect(alerts).toHaveLength(1);
		expect(alerts[0].textContent).toBe(
			"Could not load your lesson activity. Server unreachable",
		);
		expect(screen.queryByText(/no lesson activity/i)).toBeNull();
		expect(
			await screen.findByText(/no sessions in the last 7 days/i),
		).toBeDefined();
	});
});
