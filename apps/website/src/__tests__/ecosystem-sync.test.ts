import { describe, expect, it } from "vitest";
import { type Fixture, readmePath, summarize } from "../lib/ecosystem-sync";
import type { MarketplacePlugin } from "../lib/marketplace";

const BLOB = "https://github.com/onlooker-community/ecosystem/blob/main/";
const A = "a".repeat(40);
const B = "b".repeat(40);

function plugin(
	name: string,
	version = "1.0.0",
	description = `${name} does things.`,
): MarketplacePlugin {
	const dir = name === "ecosystem" ? "" : `plugins/${name}/`;
	return { name, version, description, readmeUrl: `${BLOB}${dir}README.md` };
}

const before: Fixture = {
	commit: A,
	plugins: [plugin("ecosystem"), plugin("archivist", "0.10.0")],
};

// Not named `after`: Biome reads that as vitest's after hook.
function next(plugins: MarketplacePlugin[]): Fixture {
	return { commit: B, plugins };
}

describe("readmePath", () => {
	it("is the README's path in ecosystem", () => {
		expect(readmePath(plugin("ecosystem"))).toBe("README.md");
		expect(readmePath(plugin("archivist"))).toBe("plugins/archivist/README.md");
	});

	it("refuses a README that is not on ecosystem's main", () => {
		expect(() =>
			readmePath({
				...plugin("archivist"),
				readmeUrl: "https://example.com/x",
			}),
		).toThrow(/archivist/);
	});
});

describe("summarize", () => {
	it("finds no change when nothing differs", () => {
		const sync = summarize({ before, after: before, changedFiles: [] });
		expect(sync.changed).toBe(false);
	});

	// A new ecosystem commit alone is not a change: recording every one would
	// reopen the PR twice a day for nothing. READMEs that are not a plugin's
	// own, like measurement write-ups, do not count either.
	it("finds no change when only unrelated ecosystem files moved", () => {
		const sync = summarize({
			before,
			after: next(before.plugins),
			changedFiles: [
				"plugins/archivist/src/extract.ts",
				"plugins/librarian/docs/measurements/2026-10-24-hooks-off/README.md",
			],
		});
		expect(sync.changed).toBe(false);
	});

	it("reports a version bump", () => {
		const sync = summarize({
			before,
			after: next([plugin("ecosystem"), plugin("archivist", "0.11.0")]),
			changedFiles: [],
		});
		expect(sync.changed).toBe(true);
		expect(sync.body).toContain("`archivist` 0.10.0 → 0.11.0");
	});

	it("reports a new description", () => {
		const sync = summarize({
			before,
			after: next([
				plugin("ecosystem"),
				plugin("archivist", "0.10.0", "Now says something else."),
			]),
			changedFiles: [],
		});
		expect(sync.changed).toBe(true);
		expect(sync.body).toContain("Now says something else.");
	});

	it("reports an added plugin and the prose file it needs", () => {
		const sync = summarize({
			before,
			after: next([...before.plugins, plugin("newcomer", "0.1.0")]),
			changedFiles: ["plugins/newcomer/README.md"],
		});
		expect(sync.changed).toBe(true);
		expect(sync.body).toContain("`newcomer` 0.1.0");
		expect(sync.body).toContain("apps/website/src/data/plugins/newcomer.ts");
	});

	it("reports a removed plugin", () => {
		const sync = summarize({
			before,
			after: next([plugin("ecosystem")]),
			changedFiles: [],
		});
		expect(sync.changed).toBe(true);
		expect(sync.body).toMatch(/### Removed\n\n- `archivist`/);
	});

	it("reports a changed README even when the facts did not change", () => {
		const sync = summarize({
			before,
			after: next(before.plugins),
			changedFiles: ["README.md", "plugins/archivist/README.md"],
		});
		expect(sync.changed).toBe(true);
		expect(sync.body).toContain("`plugins/archivist/README.md`");
		expect(sync.body).toContain("apps/website/src/data/plugins/archivist.ts");
		expect(sync.body).toContain("apps/website/src/data/plugins/ecosystem.ts");
	});

	it("links the ecosystem range it covers", () => {
		const sync = summarize({
			before,
			after: next([plugin("ecosystem"), plugin("archivist", "0.11.0")]),
			changedFiles: [],
		});
		expect(sync.body).toContain(
			`https://github.com/onlooker-community/ecosystem/compare/${A}...${B}`,
		);
	});
});
