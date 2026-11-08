import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
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

// The pages pass the flag in, from astro:env. readMarketplace has to hand it
// on: a flag that stops here makes a strict build fall back as quietly as one
// nobody set.
describe("readMarketplace", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	// A fresh module each time, because the read is memoized for the build.
	async function freshRead(required: boolean) {
		vi.resetModules();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not found", { status: 404 })),
		);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { readMarketplace } = await import("../lib/marketplace");
		return readMarketplace({ required });
	}

	it("fails the build on a failed read when required", async () => {
		await expect(freshRead(true)).rejects.toThrow(/marketplace/i);
	});

	it("falls back to the fixture on a failed read when not required", async () => {
		expect((await freshRead(false)).source).toBe("fixture");
	});
});

// The flag only matters if it reaches the build, and twice it did not. A
// process.env read never reached the workerd prerender, so the flag is an
// astro:env field. And the production job builds the website in its own step:
// a strict check in the main Build, which runs before the API and Web deploys,
// would let a GitHub outage block both.
//
// These tests check configuration, which is not the same as checking the flag
// works; the 2026-11-07 fix report records a strict build against a broken URL
// exiting non-zero.
describe("MARKETPLACE_REQUIRED reaches the production website build", () => {
	const root = new URL("../../../../", import.meta.url);
	const deploy = readFileSync(
		new URL(".github/workflows/deploy.yml", root),
		"utf8",
	);

	/** The production job's steps, in order, each as its name and its text. */
	function productionSteps(): { name: string; text: string }[] {
		const start = deploy.indexOf("\n  deploy-production:");
		const rest = deploy.slice(start + 1);
		const end = rest.search(/\n {2}[a-z][\w-]*:\n/);
		const job = end === -1 ? rest : rest.slice(0, end);
		return job
			.split(/\n {6}- /)
			.slice(1)
			.map((text) => ({
				name: text.match(/^name: (.+)/)?.[1] ?? "",
				text,
			}));
	}

	function step(name: string) {
		const found = productionSteps().find((s) => s.name === name);
		if (!found) throw new Error(`deploy-production has no "${name}" step`);
		return found.text;
	}

	it("is declared through astro:env", () => {
		const config = readFileSync(
			new URL("apps/website/astro.config.mjs", root),
			"utf8",
		);
		expect(config).toMatch(/MARKETPLACE_REQUIRED: envField\.boolean\(/);
	});

	it("is in turbo's build env", () => {
		const turbo = JSON.parse(readFileSync(new URL("turbo.json", root), "utf8"));
		expect(turbo.tasks.build.env).toContain("MARKETPLACE_REQUIRED");
	});

	it("is not set on the production job's main Build, which skips the website", () => {
		const build = step("Build");
		expect(build).toMatch(/run: pnpm build --filter='!@onlooker\/website'\n/);
		expect(build).not.toMatch(/MARKETPLACE_REQUIRED/);
	});

	it("is set to true on a Build Website step that builds only the website", () => {
		const build = step("Build Website");
		expect(build).toMatch(/run: pnpm --filter @onlooker\/website build\n/);
		expect(build).toMatch(/MARKETPLACE_REQUIRED: ['"]true['"]/);
	});

	it("runs Build Website after the Web deploy and just before the website's", () => {
		const names = productionSteps().map((s) => s.name);
		const at = names.indexOf("Build Website");
		expect(at).toBeGreaterThan(names.indexOf("Deploy Web to Production"));
		expect(names[at + 1]).toBe("Deploy Website to Production");
	});

	it("is set nowhere else in the workflow", () => {
		expect(deploy.match(/MARKETPLACE_REQUIRED:/g)).toHaveLength(1);
	});
});
