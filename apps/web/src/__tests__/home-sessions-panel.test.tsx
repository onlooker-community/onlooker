process.env.TZ = "UTC";

import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { labelIdentity } from "../api/labelsApi";
import type { SessionSummary } from "../api/sessionsApi";
import HomeSessionsPanel from "../components/HomeSessionsPanel";

const DAYS = [
	"Wednesday, November 18",
	"Tuesday, November 17",
	"Monday, November 16",
	"Sunday, November 15",
	"Saturday, November 14",
	"Friday, November 13",
	"Thursday, November 12",
];

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

function renderPanel(
	props: Partial<Parameters<typeof HomeSessionsPanel>[0]> = {},
) {
	return render(
		<MemoryRouter>
			<HomeSessionsPanel
				sessions={[]}
				complete={true}
				days={DAYS}
				labels={new Map()}
				{...props}
			/>
		</MemoryRouter>,
	);
}

describe("HomeSessionsPanel", () => {
	it("states the window's total when complete", () => {
		renderPanel({
			sessions: [
				session({ session_id: "a" }),
				session({
					session_id: "b",
					started_at: "2026-11-16T09:00:00Z",
					ended_at: "2026-11-16T10:00:00Z",
				}),
			],
		});
		expect(screen.getByTestId("home-sessions-headline").textContent).toBe(
			"2 sessions · 2h 0m in the last 7 days",
		);
	});

	it("says what it loaded, not a total, when capped", () => {
		renderPanel({ sessions: [session()], complete: false });
		expect(screen.getByTestId("home-sessions-headline").textContent).toBe(
			"most recent 1 session · 1h 0m",
		);
	});

	// Seven bars whatever the data, so a quiet day reads as quiet rather than
	// as missing.
	it("draws a bar for every day in the window, empty days included", () => {
		renderPanel({ sessions: [session()] });
		for (const day of DAYS) expect(screen.getByText(day)).toBeTruthy();
		expect(screen.getAllByText("0 sessions")).toHaveLength(6);
	});

	// Days older than the oldest loaded session were never read, so they are
	// unknown rather than empty. A "0 sessions" bar would claim otherwise.
	it("stops the bars at the oldest loaded day when capped", () => {
		renderPanel({
			complete: false,
			sessions: [
				session({ session_id: "a" }),
				session({
					session_id: "b",
					started_at: "2026-11-16T09:00:00Z",
					ended_at: "2026-11-16T10:00:00Z",
				}),
			],
		});
		for (const day of DAYS.slice(0, 3))
			expect(screen.getByText(day)).toBeTruthy();
		for (const day of DAYS.slice(3)) expect(screen.queryByText(day)).toBeNull();
		expect(screen.getAllByText("0 sessions")).toHaveLength(1);
		expect(screen.getByText("Older days not loaded.")).toBeTruthy();
	});

	it("draws all seven days and no note when complete", () => {
		renderPanel({ sessions: [session()] });
		for (const day of DAYS) expect(screen.getByText(day)).toBeTruthy();
		expect(screen.queryByText("Older days not loaded.")).toBeNull();
	});

	it("adds no note when capped but the oldest loaded day is the window's first", () => {
		renderPanel({
			complete: false,
			sessions: [
				session({
					started_at: "2026-11-12T09:00:00Z",
					ended_at: "2026-11-12T10:00:00Z",
				}),
			],
		});
		expect(screen.queryByText("Older days not loaded.")).toBeNull();
	});

	it("names the top three repositories, by the user's label where there is one", () => {
		const project = (event_count: number) => ({
			basis: "remote" as const,
			event_count,
		});
		renderPanel({
			sessions: [
				session({
					counts_by_project: {
						aaaaaaaaaaaa: project(30),
						bbbbbbbbbbbb: project(20),
						cccccccccccc: project(10),
						dddddddddddd: project(5),
					},
				}),
			],
			labels: new Map([[labelIdentity("aaaaaaaaaaaa", null), "onlooker"]]),
		});
		const list = screen.getByRole("list", { name: "Top repositories" });
		expect(list).toBe(screen.getByTestId("home-repositories"));
		const rows = within(list).getAllByRole("listitem");
		expect(rows.map((row) => row.textContent)).toEqual([
			"onlooker · 30 events",
			"bbbbbbbbbbbb · 20 events",
			"cccccccccccc · 10 events",
		]);
		// A named row keeps its key reachable in a title.
		expect(
			within(rows[0] as HTMLElement)
				.getByText("onlooker")
				.getAttribute("title"),
		).toBe("aaaaaaaaaaaa");
	});

	it("leaves out the repository list when no session carried a repository", () => {
		renderPanel({ sessions: [session()] });
		expect(screen.queryByTestId("home-repositories")).toBeNull();
	});

	it("says so when the window holds no sessions", () => {
		renderPanel({ sessions: [] });
		expect(screen.getByText(/no sessions in the last 7 days/i)).toBeTruthy();
		expect(screen.queryByTestId("home-sessions-headline")).toBeNull();
	});

	it("links to the full feed", () => {
		renderPanel({ sessions: [session()] });
		expect(
			screen.getByRole("link", { name: /all sessions/i }).getAttribute("href"),
		).toBe("/sessions");
	});
});
