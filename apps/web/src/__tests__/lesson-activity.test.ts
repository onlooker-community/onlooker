import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../api/lessonsApi";
import {
	describeKind,
	describeLessonWeek,
	tallyActivity,
} from "../lib/lessonActivity";

function event(kind: string, seq = 1): ActivityEvent {
	return {
		seq,
		kind,
		at: "2026-11-18T10:00:00Z",
		lesson_id: `l${seq}`,
		claim: `claim ${seq}`,
	};
}

describe("describeKind", () => {
	it("uses the feed's words for the two kinds it knows", () => {
		expect(describeKind("create")).toBe("Published");
		expect(describeKind("status")).toBe("Status changed");
	});

	// A kind newer than this build is shown as it is, not hidden.
	it("passes an unknown kind through", () => {
		expect(describeKind("merged")).toBe("merged");
	});
});

describe("tallyActivity", () => {
	it("counts each kind and the total", () => {
		expect(
			tallyActivity([
				event("create", 1),
				event("status", 2),
				event("create", 3),
				event("merged", 4),
			]),
		).toEqual({ published: 2, statusChanges: 1, total: 4 });
	});

	it("counts nothing in an empty feed", () => {
		expect(tallyActivity([])).toEqual({
			published: 0,
			statusChanges: 0,
			total: 0,
		});
	});
});

describe("describeLessonWeek", () => {
	it("names both kinds over a complete week", () => {
		expect(
			describeLessonWeek({ published: 2, statusChanges: 1, total: 3 }, true),
		).toBe("2 published · 1 status change in the last 7 days");
	});

	it("pluralizes status changes", () => {
		expect(
			describeLessonWeek({ published: 1, statusChanges: 2, total: 3 }, true),
		).toBe("1 published · 2 status changes in the last 7 days");
	});

	it("leaves out a kind with no events", () => {
		expect(
			describeLessonWeek({ published: 0, statusChanges: 1, total: 1 }, true),
		).toBe("1 status change in the last 7 days");
		expect(
			describeLessonWeek({ published: 3, statusChanges: 0, total: 3 }, true),
		).toBe("3 published in the last 7 days");
	});

	// The loaded page stops short of the window's start, so a count for the
	// week would claim rows nobody read.
	it("says latest N events when the week is capped", () => {
		expect(
			describeLessonWeek({ published: 1, statusChanges: 1, total: 2 }, false),
		).toBe("1 published · 1 status change in your latest 2 events");
		expect(
			describeLessonWeek({ published: 1, statusChanges: 0, total: 1 }, false),
		).toBe("1 published in your latest 1 event");
	});

	it("falls back to an event count when only unknown kinds are present", () => {
		expect(
			describeLessonWeek({ published: 0, statusChanges: 0, total: 1 }, true),
		).toBe("1 event in the last 7 days");
	});
});
