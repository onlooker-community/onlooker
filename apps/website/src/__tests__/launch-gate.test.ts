import { describe, expect, it } from "vitest";
import { isPublicBeforeLaunch } from "../lib/launch-gate";

describe("isPublicBeforeLaunch", () => {
	for (const path of [
		"/",
		"/blog",
		"/blog/",
		"/blog/contrast-arena",
		"/blog/contrast-arena/",
		"/blog/tags/measurements",
		"/blog/rss.xml",
		"/plugins",
		"/plugins/",
		"/plugins/archivist",
		"/plugins/archivist/",
		"/glossary",
		"/glossary/",
		"/changelog",
		"/changelog/",
		"/changelog/2026-11-20/",
		"/changelog/rss.xml",
	]) {
		it(`lets ${path} through`, () => {
			expect(isPublicBeforeLaunch(path)).toBe(true);
		});
	}

	// /blogx and /pluginsx are the prefix matches a careless startsWith would
	// let through. The glossary is one page, so nothing under it is public.
	for (const path of [
		"/blogx",
		"/pluginsx",
		"/changelogx",
		"/glossaryx",
		"/glossary/anything",
		"/signup",
		"",
	]) {
		it(`keeps ${JSON.stringify(path)} behind the gate`, () => {
			expect(isPublicBeforeLaunch(path)).toBe(false);
		});
	}
});
