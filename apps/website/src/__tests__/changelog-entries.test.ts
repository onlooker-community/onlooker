import { getRssString } from "@astrojs/rss";
import { describe, expect, it } from "vitest";
import {
	entryFeedItems,
	entryPath,
	entryProblems,
	entrySchema,
	formatWeek,
	isoDay,
	SECTIONS,
	sectionProblems,
	selectPublishedEntries,
} from "../lib/changelog-entries";

const valid = {
	title: "A week",
	weekStart: "2026-11-14",
	weekEnd: "2026-11-20",
	summary: "What changed.",
};

const parsed = (over: Record<string, unknown> = {}) =>
	entrySchema.parse({ ...valid, ...over });

const BODY = [
	"## Plugins",
	"",
	"- **A fix.** Why it matters.",
	"",
	"## Reliability",
	"",
	"- **Another.** Why.",
	"",
].join("\n");

describe("entrySchema", () => {
	it("accepts a minimal entry and fills the defaults", () => {
		const data = parsed();
		expect(data.draft).toBe(false);
		expect(data.plugins).toEqual([]);
		expect(data.weekEnd).toEqual(new Date("2026-11-20"));
	});

	it("takes plugin versions", () => {
		expect(
			parsed({ plugins: [{ name: "lineage", version: "0.10.5" }] }).plugins,
		).toEqual([{ name: "lineage", version: "0.10.5" }]);
	});

	it("refuses a version that is not x.y.z", () => {
		expect(() =>
			parsed({ plugins: [{ name: "lineage", version: "v0.10" }] }),
		).toThrow();
	});

	it("refuses an entry with no summary", () => {
		expect(() => parsed({ summary: "" })).toThrow();
	});

	// A week is Saturday to Friday: seven days, the last six after the first.
	it("refuses a week that is not seven days long", () => {
		expect(() => parsed({ weekStart: "2026-11-13" })).toThrow(
			/six days after weekStart/,
		);
	});
});

describe("SECTIONS", () => {
	it("is the closed set, in order", () => {
		expect(SECTIONS).toEqual([
			"Plugins",
			"onlooker.dev",
			"Hosted feed",
			"Reliability",
			"Behind the scenes",
		]);
	});
});

describe("formatWeek", () => {
	const d = (s: string) => new Date(s);

	it("names the month once inside one month", () => {
		expect(formatWeek(d("2026-11-14"), d("2026-11-20"))).toBe(
			"November 14 to 20, 2026",
		);
	});

	it("names both months across a month", () => {
		expect(formatWeek(d("2026-11-28"), d("2026-12-04"))).toBe(
			"November 28 to December 4, 2026",
		);
	});

	it("names both years across a year", () => {
		expect(formatWeek(d("2026-12-26"), d("2027-01-01"))).toBe(
			"December 26, 2026 to January 1, 2027",
		);
	});
});

describe("isoDay and entryPath", () => {
	it("gives the frontmatter day back", () => {
		expect(isoDay(new Date("2026-11-20"))).toBe("2026-11-20");
	});

	it("ends an entry path in a slash", () => {
		expect(entryPath("2026-11-20")).toBe("/changelog/2026-11-20/");
	});
});

describe("selectPublishedEntries", () => {
	const entry = (id: string, weekEnd: string, draft: boolean) => ({
		id,
		data: { weekEnd: new Date(weekEnd), draft },
	});
	const entries = [
		entry("older", "2026-11-13", false),
		entry("draft", "2026-11-27", true),
		entry("newer", "2026-11-20", false),
	];

	it("leaves drafts out when asked, newest week first", () => {
		expect(selectPublishedEntries(entries, true).map((e) => e.id)).toEqual([
			"newer",
			"older",
		]);
	});

	it("keeps drafts otherwise, still newest first", () => {
		expect(selectPublishedEntries(entries, false).map((e) => e.id)).toEqual([
			"draft",
			"newer",
			"older",
		]);
	});

	it("does not reorder its input in place", () => {
		selectPublishedEntries(entries, false);
		expect(entries.map((e) => e.id)).toEqual(["older", "draft", "newer"]);
	});
});

describe("sectionProblems", () => {
	it("passes known sections in order", () => {
		expect(sectionProblems(BODY, false)).toEqual([]);
	});

	it("names an unknown heading", () => {
		expect(sectionProblems("## Plugin\n\n- x\n", false)).toEqual([
			'unknown section "Plugin"; use one of: Plugins, onlooker.dev, Hosted feed, Reliability, Behind the scenes',
		]);
	});

	it("names a heading out of order", () => {
		expect(
			sectionProblems("## Reliability\n\n- x\n\n## Plugins\n\n- y\n", false),
		).toEqual([
			'section "Plugins" is out of order; the order is Plugins, onlooker.dev, Hosted feed, Reliability, Behind the scenes',
		]);
	});

	it("names a heading used twice", () => {
		expect(
			sectionProblems("## Plugins\n\n- x\n\n## Plugins\n\n- y\n", false),
		).toEqual(['section "Plugins" appears twice']);
	});

	// An MDX comment is what changelog:new leaves in each section.
	it("refuses an empty section in a published entry", () => {
		expect(
			sectionProblems(
				"## Plugins\n\n{/* write here */}\n\n## Reliability\n\n- x\n",
				false,
			),
		).toEqual(['section "Plugins" is empty; leave it out']);
	});

	it("allows empty sections in a draft", () => {
		expect(sectionProblems("## Plugins\n\n{/* write here */}\n", true)).toEqual(
			[],
		);
	});

	it("needs at least one section in a published entry", () => {
		expect(sectionProblems("Just prose.\n", false)).toEqual([
			"a published entry needs at least one section",
		]);
	});

	it("ignores ## lines inside a code fence", () => {
		expect(
			sectionProblems("## Plugins\n\n```md\n## Not a section\n```\n", false),
		).toEqual([]);
	});

	it("leaves ### subheadings alone", () => {
		expect(
			sectionProblems("## Plugins\n\n### lineage\n\n- x\n", false),
		).toEqual([]);
	});
});

describe("entryProblems", () => {
	const known = new Set(["lineage", "bursar"]);

	it("passes a well-formed entry", () => {
		expect(
			entryProblems({ id: "2026-11-20", body: BODY, data: parsed() }, known),
		).toEqual([]);
	});

	it("names a file that doesn't match its weekEnd", () => {
		expect(
			entryProblems({ id: "2026-11-21", body: BODY, data: parsed() }, known),
		).toEqual([
			"2026-11-21: the file is named 2026-11-21 but weekEnd is 2026-11-20; name it 2026-11-20.mdx",
		]);
	});

	it("names a plugin with no page", () => {
		expect(
			entryProblems(
				{
					id: "2026-11-20",
					body: BODY,
					data: parsed({ plugins: [{ name: "lineag", version: "1.0.0" }] }),
				},
				known,
			),
		).toEqual(['2026-11-20: plugins: no plugin page for "lineag"']);
	});

	it("prefixes section problems with the entry id", () => {
		expect(
			entryProblems(
				{ id: "2026-11-20", body: "## Plugin\n\n- x\n", data: parsed() },
				known,
			)[0],
		).toMatch(/^2026-11-20: unknown section "Plugin"/);
	});
});

describe("the feed", () => {
	const entries = [
		{ id: "2026-11-20", data: parsed() },
		{
			id: "2026-11-13",
			data: parsed({
				title: "Older",
				weekStart: "2026-11-07",
				weekEnd: "2026-11-13",
			}),
		},
	];

	it("carries each entry's title, summary, week end and path", () => {
		expect(entryFeedItems(entries)[0]).toEqual({
			title: "A week",
			description: "What changed.",
			pubDate: new Date("2026-11-20"),
			link: "/changelog/2026-11-20/",
		});
	});

	it("renders absolute links under onlooker.dev, in the order given", async () => {
		const xml = await getRssString({
			title: "Onlooker changelog",
			description: "test",
			site: "https://onlooker.dev",
			items: entryFeedItems(entries),
		});
		const newer = xml.indexOf(
			"<link>https://onlooker.dev/changelog/2026-11-20/</link>",
		);
		const older = xml.indexOf(
			"<link>https://onlooker.dev/changelog/2026-11-13/</link>",
		);
		expect(newer).toBeGreaterThan(-1);
		expect(older).toBeGreaterThan(newer);
	});
});
