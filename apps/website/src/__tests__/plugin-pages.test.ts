import { describe, expect, it, vi } from "vitest";
import { allProse, joinPlugins } from "../data/plugins";
import marketplaceFixture from "../data/plugins/marketplace.fixture.json";

const fixture = marketplaceFixture.plugins;

// The fixture stands in for the marketplace because tests run offline. The
// production build makes the same join against live data, strictly, and
// joinPlugins throws there, so a plugin cannot ship without a page. Elsewhere
// it only warns, so an ecosystem release cannot fail onlooker's CI; these
// fixture checks are what catch a missing prose file in a PR.
describe("plugin pages and the marketplace", () => {
	it("give every marketplace plugin a prose file", () => {
		const prose = new Set(allProse.map((p) => p.slug));
		expect(fixture.map((p) => p.name).filter((n) => !prose.has(n))).toEqual([]);
	});

	it("keep no prose file for a plugin the marketplace does not list", () => {
		const listed = new Set(fixture.map((p) => p.name));
		expect(allProse.map((p) => p.slug).filter((s) => !listed.has(s))).toEqual(
			[],
		);
	});

	const newcomer = {
		name: "newcomer",
		version: "0.1.0",
		description: "Just shipped.",
		readmeUrl:
			"https://github.com/onlooker-community/ecosystem/blob/main/plugins/newcomer/README.md",
	};

	it("refuse to build a marketplace plugin with no prose when strict", () => {
		expect(() =>
			joinPlugins([...fixture, newcomer], { required: true, warn: vi.fn() }),
		).toThrow(/newcomer/);
	});

	it("warn about and leave out a plugin with no prose when not strict", () => {
		const warn = vi.fn();
		const pages = joinPlugins([...fixture, newcomer], {
			required: false,
			warn,
		});
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0][0]).toMatch(/newcomer/);
		expect(pages.map((p) => p.slug)).toEqual(fixture.map((p) => p.name));
	});

	it("take version and description from the marketplace, not the prose", () => {
		const [first] = joinPlugins(
			[{ ...fixture[1], version: "9.9.9", description: "Live." }],
			{ required: true },
		);
		expect(first.version).toBe("9.9.9");
		expect(first.description).toBe("Live.");
	});

	it("let the marketplace win even if a prose file carries stale fields", () => {
		// The types forbid version and description on prose, so a stale one can only
		// arrive by leftover data. Plant one and check the join still ignores it.
		const prose = allProse.find((p) => p.slug === fixture[1].name);
		if (!prose) throw new Error(`no prose for ${fixture[1].name}`);
		const loose = prose as unknown as Record<string, unknown>;
		Object.assign(loose, { version: "0.0.0", description: "Stale." });
		try {
			const [first] = joinPlugins(
				[{ ...fixture[1], version: "9.9.9", description: "Live." }],
				{ required: true },
			);
			expect(first.version).toBe("9.9.9");
			expect(first.description).toBe("Live.");
		} finally {
			delete loose.version;
			delete loose.description;
		}
	});

	it("keep two to four how-it-works lines per plugin", () => {
		for (const p of allProse) {
			expect(p.howItWorks.length, p.slug).toBeGreaterThanOrEqual(2);
			expect(p.howItWorks.length, p.slug).toBeLessThanOrEqual(4);
		}
	});
});
