import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import fixture from "../data/plugins/marketplace.fixture.json";
import { fetchMarketplace } from "../lib/marketplace";

const RAW =
	"https://raw.githubusercontent.com/onlooker-community/ecosystem/main/";

const marketplace = {
	plugins: [
		{ name: "ecosystem", source: "./" },
		{ name: "archivist", source: "./plugins/archivist" },
	],
};
const manifests: Record<string, unknown> = {
	".claude-plugin/plugin.json": {
		name: "ecosystem",
		version: "2.0.0",
		description: "The substrate.",
	},
	"plugins/archivist/.claude-plugin/plugin.json": {
		name: "archivist",
		version: "0.10.0",
		description: "Mines commits.",
	},
};

/** A fetch that serves the files above, with one path optionally broken. */
function github(broken?: { path: string; response: Response | Error }) {
	return vi.fn(async (input: string | URL | Request) => {
		const path = String(input).slice(RAW.length);
		if (broken && path === broken.path) {
			if (broken.response instanceof Error) throw broken.response;
			// A clone, because the same Response backs a fallback test and a
			// required test, and a body can be read once.
			return broken.response.clone();
		}
		if (path === ".claude-plugin/marketplace.json")
			return Response.json(marketplace);
		if (path in manifests) return Response.json(manifests[path]);
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
}

describe("fetchMarketplace", () => {
	it("reads every plugin's version and description from GitHub", async () => {
		const result = await fetchMarketplace({ fetch: github() });
		expect(result).toEqual({
			source: "github",
			plugins: [
				{
					name: "ecosystem",
					version: "2.0.0",
					description: "The substrate.",
					readmeUrl:
						"https://github.com/onlooker-community/ecosystem/blob/main/README.md",
				},
				{
					name: "archivist",
					version: "0.10.0",
					description: "Mines commits.",
					readmeUrl:
						"https://github.com/onlooker-community/ecosystem/blob/main/plugins/archivist/README.md",
				},
			],
		});
	});

	const failures: [string, Parameters<typeof github>[0]][] = [
		[
			"a request that throws",
			{
				path: ".claude-plugin/marketplace.json",
				response: new TypeError("fetch failed"),
			},
		],
		[
			"a non-200",
			{
				path: "plugins/archivist/.claude-plugin/plugin.json",
				// A valid manifest body, so only the status can be what fails it.
				response: Response.json(
					{ name: "archivist", version: "0.10.0", description: "x" },
					{ status: 404 },
				),
			},
		],
		[
			"JSON that does not parse",
			{
				path: ".claude-plugin/marketplace.json",
				response: new Response("{not json", { status: 200 }),
			},
		],
		[
			"a plugin.json without a version",
			{
				path: "plugins/archivist/.claude-plugin/plugin.json",
				response: Response.json({ name: "archivist", description: "x" }),
			},
		],
	];

	for (const [what, broken] of failures) {
		it(`falls back to the fixture on ${what}, and says why`, async () => {
			const warn = vi.fn();
			const result = await fetchMarketplace({ fetch: github(broken), warn });
			expect(result).toEqual({ source: "fixture", plugins: fixture });
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0][0]).toMatch(/fixture/);
		});

		it(`throws on ${what} when the marketplace is required`, async () => {
			await expect(
				fetchMarketplace({
					fetch: github(broken),
					required: true,
					warn: vi.fn(),
				}),
			).rejects.toThrow(/marketplace/i);
		});
	}
});

describe("the fixture", () => {
	it("holds ecosystem and at least one plugin, each fully described", () => {
		expect(fixture.map((p) => p.name)).toContain("ecosystem");
		expect(fixture.length).toBeGreaterThan(1);
		for (const p of fixture) {
			expect(p.version).toMatch(/^\d+\.\d+\.\d+/);
			expect(p.description.length).toBeGreaterThan(0);
			expect(p.readmeUrl).toMatch(
				/^https:\/\/github\.com\/onlooker-community\/ecosystem\/blob\/main\//,
			);
		}
	});
});

// The flag only matters if it reaches the build. turbo passes a task only the
// env vars its `env` list names, so a flag missing there makes production fall
// back as quietly as a flag nobody set.
describe("MARKETPLACE_REQUIRED reaches the production build", () => {
	const root = new URL("../../../../", import.meta.url);

	it("is in turbo's build env", () => {
		const turbo = JSON.parse(readFileSync(new URL("turbo.json", root), "utf8"));
		expect(turbo.tasks.build.env).toContain("MARKETPLACE_REQUIRED");
	});

	it("is set on the production job's Build step", () => {
		const deploy = readFileSync(
			new URL(".github/workflows/deploy.yml", root),
			"utf8",
		);
		const job = deploy.slice(deploy.indexOf("\n  deploy-production:"));
		const build = job.slice(
			job.indexOf("- name: Build\n"),
			job.indexOf("- name:", job.indexOf("- name: Build\n") + 1),
		);
		expect(build).toMatch(/MARKETPLACE_REQUIRED: ['"]1['"]/);
	});
});
