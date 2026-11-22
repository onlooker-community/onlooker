import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../api/sessionsApi";
import HomePluginsPanel, {
	type Installed,
} from "../components/HomePluginsPanel";

function session(over: Partial<SessionSummary>): SessionSummary {
	return {
		session_id: "s",
		machine_id: "m1",
		started_at: "2026-11-18T10:00:00Z",
		ended_at: "2026-11-18T11:00:00Z",
		event_count: 1,
		counts_by_prefix: {},
		counts_by_type: {},
		counts_by_project: {},
		plugins: [],
		prompts: 1,
		compactions: 0,
		subordinate: null,
		...over,
	};
}

const historianWeek = [
	session({
		counts_by_type: {
			"historian.retrieval.surfaced": 4,
			"governor.ledger.write_failed": 2,
		},
		counts_by_prefix: { historian: 4, governor: 2 },
	}),
];

function renderPanel(
	sessions: SessionSummary[],
	installed: Installed = { kind: "loaded", names: [], reporting: 1 },
	complete = true,
) {
	return render(
		<MemoryRouter>
			<HomePluginsPanel
				sessions={sessions}
				complete={complete}
				installed={installed}
			/>
		</MemoryRouter>,
	);
}

const silentLine = () => screen.getByTestId("home-plugins-silent").textContent;

describe("HomePluginsPanel", () => {
	it("lists each plugin's week, failures first", () => {
		renderPanel(historianWeek);

		const list = screen.getByRole("list", { name: "This week" });
		expect(
			Array.from(list.querySelectorAll("li")).map((li) => li.textContent),
		).toEqual([
			"governor: 2 failed in 1 session",
			"historian: produced 4 in 1 session",
		]);
	});

	it("says so when no plugin sent events", () => {
		renderPanel([]);
		expect(
			screen.getByText("No plugin events in the last 7 days."),
		).toBeDefined();
		expect(screen.queryByRole("list")).toBeNull();
	});

	it("says the most recent sessions when a capped week has no rows", () => {
		renderPanel(
			[session({})],
			{ kind: "loaded", names: [], reporting: 1 },
			false,
		);
		expect(
			screen.getByText("No plugin events in the most recent 1 session."),
		).toBeDefined();
		expect(
			screen.queryByText("No plugin events in the last 7 days."),
		).toBeNull();
	});

	it("names unclassified plugins rather than dropping them", () => {
		renderPanel([session({ counts_by_type: { "someplugin.new.thing": 1 } })]);
		expect(screen.getByText("Unclassified: someplugin.")).toBeDefined();
	});

	it("names installed plugins that sent no events", () => {
		renderPanel(historianWeek, {
			kind: "loaded",
			names: ["counsel", "ecosystem", "historian", "warden"],
			reporting: 1,
		});
		expect(silentLine()).toBe(
			"Installed, no events in 7 days: counsel, warden.",
		);
	});

	it("says every installed plugin sent events when none were quiet", () => {
		renderPanel(historianWeek, {
			kind: "loaded",
			names: ["historian"],
			reporting: 1,
		});
		expect(silentLine()).toBe(
			"Every installed Onlooker plugin sent events this week.",
		);
	});

	it("says no machine has reported when nothing is installed", () => {
		renderPanel(historianWeek, { kind: "loaded", names: [], reporting: 0 });
		expect(silentLine()).toBe("No machine has reported its installed plugins.");
	});

	it("says no Onlooker plugins are installed when machines reported none", () => {
		renderPanel(historianWeek, { kind: "loaded", names: [], reporting: 2 });
		expect(silentLine()).toBe("No Onlooker plugins are installed.");
	});

	// A partial list would call plugins silent that a failed machine may have
	// run.
	it("lists nothing when an inventory could not be read", () => {
		renderPanel(historianWeek, { kind: "failed" });
		expect(silentLine()).toBe("Couldn't check which plugins are installed.");
	});

	it("says it is checking while inventories load", () => {
		renderPanel(historianWeek, { kind: "loading" });
		expect(silentLine()).toBe("Checking which plugins are installed…");
	});

	// An unread session may hold the very events that would clear a plugin.
	it("lists no quiet plugins when the week is capped", () => {
		renderPanel(
			historianWeek,
			{ kind: "loaded", names: ["counsel", "historian"], reporting: 1 },
			false,
		);
		expect(screen.getByText("From the most recent 1 session.")).toBeDefined();
		expect(silentLine()).toBe(
			"Not every session this week was loaded, so quiet plugins aren't listed.",
		);
	});

	it("links through to the sessions", () => {
		renderPanel(historianWeek);
		expect(
			screen
				.getByRole("link", { name: "Plugin activity per session" })
				.getAttribute("href"),
		).toBe("/sessions");
	});
});
