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
	]) {
		it(`lets ${path} through`, () => {
			expect(isPublicBeforeLaunch(path)).toBe(true);
		});
	}

	// /plugins stays behind the gate until its pages match the marketplace
	// (ONL-263); ONL-264 adds it here. /blogx is the prefix match a careless
	// startsWith("/blog") would let through.
	for (const path of [
		"/plugins",
		"/plugins/archivist",
		"/blogx",
		"/signup",
		"",
	]) {
		it(`keeps ${JSON.stringify(path)} behind the gate`, () => {
			expect(isPublicBeforeLaunch(path)).toBe(false);
		});
	}
});
