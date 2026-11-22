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
		subordinate: null,
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
			"In the last 7 days your machines reported 2 sessions, 2h 0m in all.",
		);
	});

	it("says what it loaded, not a total, when capped", () => {
		renderPanel({ sessions: [session()], complete: false });
		expect(screen.getByTestId("home-sessions-headline").textContent).toBe(
			"The most recent 1 session your machines reported, 1h 0m in all.",
		);
	});

	it("says how many spawned sessions it left out", () => {
		renderPanel({
			sessions: [
				session({ session_id: "a" }),
				session({ session_id: "b", subordinate: true }),
				session({ session_id: "c", subordinate: true }),
			],
		});
		expect(screen.getByTestId("home-sessions-headline").textContent).toBe(
			"In the last 7 days your machines reported 1 session, 1h 0m in all. 2 more were started by another session or a script and aren't counted.",
		);
	});

	it("says every session was spawned, in one sentence", () => {
		renderPanel({
			sessions: [
				session({ session_id: "a", subordinate: true }),
				session({ session_id: "b", subordinate: true }),
			],
		});
		expect(screen.getByTestId("home-sessions-headline").textContent).toBe(
			"In the last 7 days your machines reported 2 sessions, all started by another session or a script, so none are counted.",
		);
	});

	it("says it as the most recent when capped and all spawned", () => {
		renderPanel({
			sessions: [session({ subordinate: true })],
			complete: false,
		});
		expect(screen.getByTestId("home-sessions-headline").textContent).toBe(
			"The most recent session your machines reported was started by another session or a script, so it isn't counted.",
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

	describe("the stat band", () => {
		const band = () => within(screen.getByTestId("stat-band"));

		it("shows sessions, time and failures as three numbers", () => {
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
			expect(band().getByText("2")).toBeTruthy();
			expect(band().getByText("sessions")).toBeTruthy();
			expect(band().getByText("2h 0m")).toBeTruthy();
			expect(band().getByText("of session time")).toBeTruthy();
			expect(band().getByText("0")).toBeTruthy();
			expect(band().getByText("plugin failures")).toBeTruthy();
		});

		it("uses singular labels for one", () => {
			renderPanel({
				sessions: [
					session({ counts_by_type: { "historian.embedder.failed": 1 } }),
				],
			});
			expect(band().getByText("session")).toBeTruthy();
			expect(band().getByText("plugin failure")).toBeTruthy();
		});

		it("sums failures across sessions", () => {
			renderPanel({
				sessions: [
					session({
						session_id: "a",
						counts_by_type: { "historian.embedder.failed": 2 },
					}),
					session({
						session_id: "b",
						counts_by_type: { "governor.ledger.write_failed": 1 },
					}),
				],
			});
			expect(band().getByText("3")).toBeTruthy();
			expect(band().getByText("plugin failures")).toBeTruthy();
		});
	});

	describe("the captions", () => {
		it("names the busiest day when one day holds the most time", () => {
			renderPanel({
				sessions: [
					session({ session_id: "a" }),
					session({
						session_id: "b",
						started_at: "2026-11-16T09:00:00Z",
						ended_at: "2026-11-16T09:30:00Z",
					}),
				],
			});
			expect(
				screen.getByText("The busiest day was Wednesday, November 18."),
			).toBeTruthy();
		});

		// Naming one of two equal days would be a pick, not a finding.
		it("names no busiest day on a tie", () => {
			renderPanel({
				sessions: [
					session({ session_id: "a" }),
					session({
						session_id: "b",
						started_at: "2026-11-16T10:00:00Z",
						ended_at: "2026-11-16T11:00:00Z",
					}),
				],
			});
			expect(screen.queryByText(/busiest/)).toBeNull();
			expect(
				screen.getByText("Time reported each day, newest first."),
			).toBeTruthy();
		});

		it("says of the loaded days when capped", () => {
			renderPanel({ sessions: [session()], complete: false });
			expect(
				screen.getByText(
					"Of the days loaded, the busiest was Wednesday, November 18.",
				),
			).toBeTruthy();
		});
	});

	describe("worth a look", () => {
		const failing = (id: string, startedAt: string, count: number) =>
			session({
				session_id: id,
				started_at: startedAt,
				ended_at: startedAt,
				counts_by_type: { "historian.embedder.failed": count },
			});

		it("is absent when nothing failed", () => {
			renderPanel({ sessions: [session()] });
			expect(screen.queryByTestId("home-worth-a-look")).toBeNull();
			expect(screen.queryByText("Worth a look")).toBeNull();
		});

		it("says which plugin failed, how often and when, and links to Sessions", () => {
			renderPanel({
				sessions: [failing("a", "2026-11-17T10:00:00Z", 2)],
			});
			const cards = within(screen.getByTestId("home-worth-a-look"));
			expect(
				cards.getByText(
					/^Historian failed twice in a session on Tuesday, November 17\./,
				),
			).toBeTruthy();
			expect(
				cards.getByRole("link", { name: "Open Sessions" }).getAttribute("href"),
			).toBe("/sessions");
		});

		it("names the worst first and says how many it left out", () => {
			renderPanel({
				sessions: [
					failing("a", "2026-11-18T10:00:00Z", 1),
					failing("b", "2026-11-17T10:00:00Z", 5),
					failing("c", "2026-11-16T10:00:00Z", 1),
					failing("d", "2026-11-15T10:00:00Z", 1),
				],
			});
			const texts = Array.from(
				screen.getByTestId("home-worth-a-look").querySelectorAll("p"),
				(p) => p.textContent ?? "",
			);
			expect(texts).toHaveLength(3);
			expect(texts[0]).toMatch(/failed 5 times/);
			expect(screen.getByText("1 more not shown.")).toBeTruthy();
		});
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
