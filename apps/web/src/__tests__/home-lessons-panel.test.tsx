process.env.TZ = "UTC";

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../api/lessonsApi";
import HomeLessonsPanel from "../components/HomeLessonsPanel";

function event(over: Partial<ActivityEvent>): ActivityEvent {
	return {
		seq: 1,
		kind: "create",
		at: "2026-11-18T10:00:00Z",
		lesson_id: "l1",
		claim: "claim",
		...over,
	};
}

// Newest first, as /api/activity returns them.
const week = [
	event({
		seq: 4,
		lesson_id: "l4",
		claim: "Fourth",
		at: "2026-11-18T12:00:00Z",
	}),
	event({
		seq: 3,
		kind: "status",
		lesson_id: "l3",
		claim: "Third",
		at: "2026-11-17T12:00:00Z",
	}),
	event({
		seq: 2,
		lesson_id: "l2",
		claim: "Second",
		at: "2026-11-16T12:00:00Z",
	}),
	event({
		seq: 1,
		lesson_id: "l1",
		claim: "First",
		at: "2026-11-15T12:00:00Z",
	}),
];

function renderPanel(
	events: ActivityEvent[],
	{ complete = true, feedEmpty = false } = {},
) {
	return render(
		<MemoryRouter>
			<HomeLessonsPanel
				events={events}
				complete={complete}
				feedEmpty={feedEmpty}
			/>
		</MemoryRouter>,
	);
}

const headline = () => screen.getByTestId("home-lessons-headline").textContent;

describe("HomeLessonsPanel", () => {
	it("counts the week's events in its headline", () => {
		renderPanel(week);
		expect(headline()).toBe("3 published · 1 status change in the last 7 days");
	});

	it("says latest N events when the week is capped", () => {
		renderPanel(week.slice(0, 2), { complete: false });
		expect(headline()).toBe(
			"1 published · 1 status change in your latest 2 events",
		);
	});

	it("lists the latest 3 events, newest first, each linking to its lesson", () => {
		renderPanel(week);
		const items = screen
			.getByRole("list", { name: "Latest lesson activity" })
			.querySelectorAll("li");
		expect(items).toHaveLength(3);
		const links = Array.from(items).map((li) => li.querySelector("a"));
		expect(links.map((a) => a?.textContent)).toEqual([
			"Fourth",
			"Third",
			"Second",
		]);
		expect(links.map((a) => a?.getAttribute("href"))).toEqual([
			"/lessons/l4",
			"/lessons/l3",
			"/lessons/l2",
		]);
	});

	it("says what happened and on which day", () => {
		renderPanel(week);
		const items = screen
			.getByRole("list", { name: "Latest lesson activity" })
			.querySelectorAll("li");
		expect(items[0].textContent).toMatch(/Published · /);
		expect(items[1].textContent).toMatch(/Status changed · /);
		// The instant survives as an attribute, so this doesn't depend on the
		// runner's locale.
		expect(items[1].querySelector("time")?.getAttribute("dateTime")).toBe(
			"2026-11-17T12:00:00Z",
		);
	});

	it("points at onlooker sync when the feed holds nothing yet", () => {
		renderPanel([], { feedEmpty: true });
		expect(screen.getByText(/No lesson activity yet\./)).toBeDefined();
		expect(screen.getByText("onlooker sync")).toBeDefined();
		expect(screen.queryByTestId("home-lessons-headline")).toBeNull();
	});

	// "Yet" would be false: the feed has events, just none this week.
	it("says the week was quiet when only older events exist", () => {
		renderPanel([], { feedEmpty: false });
		expect(
			screen.getByText("No lesson activity in the last 7 days."),
		).toBeDefined();
		expect(screen.queryByText(/yet/)).toBeNull();
	});

	it("links to the full feed, loaded or empty", () => {
		const { unmount } = renderPanel(week);
		expect(
			screen
				.getByRole("link", { name: "All lesson activity" })
				.getAttribute("href"),
		).toBe("/activity");
		unmount();
		renderPanel([], { feedEmpty: true });
		expect(
			screen
				.getByRole("link", { name: "All lesson activity" })
				.getAttribute("href"),
		).toBe("/activity");
	});
});
