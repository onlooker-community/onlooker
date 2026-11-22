import { z } from "astro/zod";

// Pure, like blog-posts.ts and for the same reason: vitest runs without
// astro:content, so the rules a test checks have to live outside it.

/** The headings an entry may use, in the order it must use them (ONL-302). */
export const SECTIONS = [
	"Plugins",
	"onlooker.dev",
	"Hosted feed",
	"Reliability",
	"Behind the scenes",
] as const;

const DAY_MS = 86_400_000;

export const entrySchema = z
	.object({
		title: z.string().min(1),
		weekStart: z.coerce.date(),
		weekEnd: z.coerce.date(),
		summary: z.string().min(1),
		// Versions from each plugin's own CHANGELOG.md, never the root one,
		// which can carry duplicates (ONL-175).
		plugins: z
			.array(
				z.object({
					name: z.string().min(1),
					version: z.string().regex(/^\d+\.\d+\.\d+$/, {
						message:
							"version must be x.y.z, from the plugin's own CHANGELOG.md",
					}),
				}),
			)
			.default([]),
		draft: z.boolean().default(false),
	})
	.refine((d) => d.weekEnd.valueOf() - d.weekStart.valueOf() === 6 * DAY_MS, {
		message: "weekEnd must be six days after weekStart",
		path: ["weekEnd"],
	});

export type EntryData = z.infer<typeof entrySchema>;

export type EntryLike = { id: string; body?: string; data: EntryData };

/** A frontmatter date back as the day it names, "2026-11-20". */
export function isoDay(d: Date): string {
	return d.toISOString().slice(0, 10);
}

const MONTH = new Intl.DateTimeFormat("en-US", {
	month: "long",
	timeZone: "UTC",
});

/** "November 14 to 20, 2026", naming a month or year again only when it changes. */
export function formatWeek(start: Date, end: Date): string {
	const [sm, em] = [MONTH.format(start), MONTH.format(end)];
	const [sd, ed] = [start.getUTCDate(), end.getUTCDate()];
	const [sy, ey] = [start.getUTCFullYear(), end.getUTCFullYear()];
	if (sy !== ey) return `${sm} ${sd}, ${sy} to ${em} ${ed}, ${ey}`;
	if (sm !== em) return `${sm} ${sd} to ${em} ${ed}, ${ey}`;
	return `${sm} ${sd} to ${ed}, ${ey}`;
}

// With the slash, for the reason postPath gives.
export function entryPath(id: string): string {
	return `/changelog/${id}/`;
}

/** The entries a build publishes, newest week first. */
export function selectPublishedEntries<
	T extends { data: { draft: boolean; weekEnd: Date } },
>(entries: readonly T[], dropDrafts: boolean): T[] {
	return entries
		.filter((e) => !dropDrafts || !e.data.draft)
		.sort((a, b) => b.data.weekEnd.valueOf() - a.data.weekEnd.valueOf());
}

/** RSS items in the order given; publishedEntries() has already sorted them. */
export function entryFeedItems(entries: readonly EntryLike[]) {
	return entries.map((entry) => ({
		title: entry.data.title,
		description: entry.data.summary,
		pubDate: entry.data.weekEnd,
		link: entryPath(entry.id),
	}));
}

const FENCE = /^(```|~~~)/;
const HEADING = /^##\s+(.+?)\s*$/;
// What changelog:new leaves in each section. It renders as nothing.
const MDX_COMMENT = /\{\/\*[\s\S]*?\*\/\}/g;

/**
 * What is wrong with an entry body's `##` headings. A zod schema sees only
 * frontmatter, so the entry page's getStaticPaths runs this, where a throw
 * stops the build (see undefinedTermIds for why a render-time throw doesn't).
 * A draft may keep the empty sections changelog:new scaffolds.
 */
export function sectionProblems(body: string, draft: boolean): string[] {
	const sections: { name: string; content: string }[] = [];
	let inFence = false;
	for (const line of body.split("\n")) {
		if (FENCE.test(line.trim())) inFence = !inFence;
		const heading = inFence ? null : HEADING.exec(line);
		if (heading) sections.push({ name: heading[1], content: "" });
		else if (sections.length > 0)
			sections[sections.length - 1].content += `${line}\n`;
	}

	const order = SECTIONS.join(", ");
	const known: readonly string[] = SECTIONS;
	const problems: string[] = [];
	const seen = new Set<string>();
	let last = -1;
	for (const { name, content } of sections) {
		const index = known.indexOf(name);
		if (index === -1) {
			problems.push(`unknown section "${name}"; use one of: ${order}`);
			continue;
		}
		if (seen.has(name)) {
			problems.push(`section "${name}" appears twice`);
			continue;
		}
		seen.add(name);
		if (index < last)
			problems.push(`section "${name}" is out of order; the order is ${order}`);
		last = Math.max(last, index);
		if (!draft && content.replace(MDX_COMMENT, "").trim() === "")
			problems.push(`section "${name}" is empty; leave it out`);
	}
	if (!draft && sections.length === 0)
		problems.push("a published entry needs at least one section");
	return problems;
}

/**
 * Everything that should stop the build for one entry, each prefixed with
 * its id. `knownPlugins` is the slugs that have a page under /plugins/.
 */
export function entryProblems(
	entry: EntryLike,
	knownPlugins: ReadonlySet<string>,
): string[] {
	const problems: string[] = [];
	const end = isoDay(entry.data.weekEnd);
	if (entry.id !== end)
		problems.push(
			`the file is named ${entry.id} but weekEnd is ${end}; name it ${end}.mdx`,
		);
	for (const plugin of entry.data.plugins) {
		if (!knownPlugins.has(plugin.name))
			problems.push(`plugins: no plugin page for "${plugin.name}"`);
	}
	// What changelog:new writes. The empty-section check catches the rest.
	if (!entry.data.draft) {
		if (entry.data.title.startsWith("Draft:"))
			problems.push(
				'title still starts with "Draft:"; write the entry\'s title',
			);
		if (entry.data.summary.startsWith("Draft."))
			problems.push(
				"summary is still the scaffold's placeholder; write one or two sentences",
			);
	}
	problems.push(...sectionProblems(entry.body ?? "", entry.data.draft));
	return problems.map((p) => `${entry.id}: ${p}`);
}
