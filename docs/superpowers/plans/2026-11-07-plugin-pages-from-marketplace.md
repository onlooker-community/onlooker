# Plugin Pages From the Marketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The onlooker.dev plugin pages read the plugin list, versions and descriptions from ecosystem's marketplace at build time, keep a short hand-written part per plugin, and `/plugins` opens past the launch gate.

**Architecture:** `src/lib/marketplace.ts` fetches `marketplace.json` and every `plugin.json` from ecosystem's `main` on GitHub, falling back to a committed fixture unless `MARKETPLACE_REQUIRED=1`. `src/data/plugins/` keeps one small prose file per plugin and a `joinPlugins` that pairs each marketplace entry with its prose, throwing when one is missing. The two prerendered pages render the join. Then the gate admits `/plugins`.

**Tech Stack:** Astro 6 (prerendered pages in `output: "server"`), TypeScript, Vitest 4 (`getViteConfig`, Astro container), Biome, pnpm + turbo.

Spec: `docs/superpowers/specs/2026-11-07-plugin-pages-from-marketplace-design.md`.

## Global Constraints

* Edit tracked files with the Edit/Write tools, never with shell redirects, `sed -i` or heredocs. Generating content with a script is fine; write its output into the repo with Write.
* Commits go through `/git-workflow:commit`. A subagent without that skill mirrors its contract: `<type>(website): <subject> :emoji:`, American English, a why-focused body.
* Run one test file with `pnpm --filter @onlooker/website test <name>`, with no `--`. `pnpm --filter @onlooker/website test` runs them all.
* Gates before every commit: `pnpm --filter @onlooker/website test`, `pnpm --filter @onlooker/website typecheck`, `pnpm --filter @onlooker/website lint`.
* American English in code, comments and copy.
* Raw base URL, verbatim: `https://raw.githubusercontent.com/onlooker-community/ecosystem/main/`.
* README base URL, verbatim: `https://github.com/onlooker-community/ecosystem/blob/main/`.
* Env flag, verbatim: `MARKETPLACE_REQUIRED`, set to `"1"`. Any other value, or unset, means "fall back".
* Install line, verbatim: `/plugin install <name>@onlooker-community`.
* Each test is checked by ablation: remove the code it covers, watch it fail, restore it. Record each ablation in the task report.
* The ecosystem checkout is at `~/src/github.com/onlooker-community/ecosystem`. Read it; never edit it.

---

### Task 1: Read the marketplace, with a fixture and a production-only failure

**Files:**
- Create: `apps/website/src/lib/marketplace.ts`
- Create: `apps/website/src/data/plugins/marketplace.fixture.json`
- Create: `apps/website/src/__tests__/marketplace.test.ts`
- Modify: `turbo.json` (the `build.env` array)
- Modify: `.github/workflows/deploy.yml` (the `deploy-production` job's `Build` step)

**Interfaces:**
- Produces:
  ```ts
  export interface MarketplacePlugin { name: string; version: string; description: string; readmeUrl: string }
  export interface Marketplace { source: "github" | "fixture"; plugins: MarketplacePlugin[] }
  export function fetchMarketplace(options?: { fetch?: typeof fetch; required?: boolean; warn?: (message: string) => void }): Promise<Marketplace>
  export function readMarketplace(): Promise<Marketplace> // memoized; required = process.env.MARKETPLACE_REQUIRED === "1"
  ```

- [ ] **Step 1: Write the failing tests**

`apps/website/src/__tests__/marketplace.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import fixture from "../data/plugins/marketplace.fixture.json";
import { fetchMarketplace } from "../lib/marketplace";

const RAW = "https://raw.githubusercontent.com/onlooker-community/ecosystem/main/";

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
			return broken.response;
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
			{ path: ".claude-plugin/marketplace.json", response: new TypeError("fetch failed") },
		],
		[
			"a non-200",
			{
				path: "plugins/archivist/.claude-plugin/plugin.json",
				response: new Response("gone", { status: 404 }),
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
				fetchMarketplace({ fetch: github(broken), required: true, warn: vi.fn() }),
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @onlooker/website test marketplace`
Expected: FAIL, unable to resolve `../lib/marketplace` and the fixture.

- [ ] **Step 3: Write the fixture**

Generate it from the local ecosystem checkout, with a script in the scratchpad (not the repo), printing to stdout:

```js
// scratchpad/fixture.mjs - run: node scratchpad/fixture.mjs
import { readFileSync } from "node:fs";
const E = `${process.env.HOME}/src/github.com/onlooker-community/ecosystem/`;
const m = JSON.parse(readFileSync(`${E}.claude-plugin/marketplace.json`, "utf8"));
// Same rule as directory() in marketplace.ts: "./" is the root, "./plugins/x" is "plugins/x/".
const directory = (source) => {
	const path = source.replace(/^\.\//, "").replace(/\/$/, "");
	return path === "" ? "" : `${path}/`;
};
const out = m.plugins.map(({ name, source }) => {
	const dir = directory(source);
	const p = JSON.parse(readFileSync(`${E}${dir}.claude-plugin/plugin.json`, "utf8"));
	return {
		name,
		version: p.version,
		description: p.description,
		readmeUrl: `https://github.com/onlooker-community/ecosystem/blob/main/${dir}README.md`,
	};
});
console.log(JSON.stringify(out, null, "\t"));
```

Check the output has 18 entries, `ecosystem` first, and that `ecosystem`'s `readmeUrl` ends `/blob/main/README.md` while archivist's ends `/blob/main/plugins/archivist/README.md`. Then Write it to `apps/website/src/data/plugins/marketplace.fixture.json`.

- [ ] **Step 4: Write the module**

`apps/website/src/lib/marketplace.ts`:

```ts
import fixture from "../data/plugins/marketplace.fixture.json";

/**
 * The plugin list, versions and descriptions, read from ecosystem's
 * marketplace while the site builds. The plugin pages are prerendered, so this
 * runs once per build and never on a request.
 *
 * Hand-copied versions went stale the afternoon ONL-263 was filed: ecosystem
 * bumps a plugin about twice a day. So the facts that drift come from the
 * marketplace, and only prose lives in this repository.
 *
 * A failed read fails the build only where it ships. The production deploy
 * sets MARKETPLACE_REQUIRED=1; everywhere else - a laptop offline, CI's test
 * jobs during a GitHub outage - falls back to the committed fixture and says
 * so, because `pnpm build` builds every package and a website fetch should not
 * block an API deploy.
 */

const RAW = "https://raw.githubusercontent.com/onlooker-community/ecosystem/main/";
const BLOB = "https://github.com/onlooker-community/ecosystem/blob/main/";

export interface MarketplacePlugin {
	name: string;
	version: string;
	description: string;
	readmeUrl: string;
}

export interface Marketplace {
	source: "github" | "fixture";
	plugins: MarketplacePlugin[];
}

interface Options {
	fetch?: typeof fetch;
	required?: boolean;
	warn?: (message: string) => void;
}

/** "./" is the repository root; "./plugins/x" is "plugins/x/". */
function directory(source: string): string {
	const path = source.replace(/^\.\//, "").replace(/\/$/, "");
	return path === "" ? "" : `${path}/`;
}

async function json(read: typeof fetch, path: string): Promise<unknown> {
	const response = await read(`${RAW}${path}`);
	if (!response.ok) throw new Error(`${path} answered ${response.status}`);
	return response.json();
}

function field(manifest: unknown, key: string, path: string): string {
	const value = (manifest as Record<string, unknown> | null)?.[key];
	if (typeof value !== "string" || value === "")
		throw new Error(`${path} has no ${key}`);
	return value;
}

async function fromGitHub(read: typeof fetch): Promise<MarketplacePlugin[]> {
	const listing = (await json(read, ".claude-plugin/marketplace.json")) as {
		plugins?: { name: string; source: string }[];
	};
	if (!Array.isArray(listing?.plugins))
		throw new Error("marketplace.json has no plugins");
	return Promise.all(
		listing.plugins.map(async ({ name, source }) => {
			const dir = directory(source);
			const path = `${dir}.claude-plugin/plugin.json`;
			const manifest = await json(read, path);
			field(manifest, "name", path);
			return {
				name,
				version: field(manifest, "version", path),
				description: field(manifest, "description", path),
				readmeUrl: `${BLOB}${dir}README.md`,
			};
		}),
	);
}

export async function fetchMarketplace(
	options: Options = {},
): Promise<Marketplace> {
	const {
		fetch: read = fetch,
		required = false,
		warn = (message) => console.warn(message),
	} = options;
	try {
		return { source: "github", plugins: await fromGitHub(read) };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		if (required)
			throw new Error(`Could not read the ecosystem marketplace: ${reason}`);
		warn(
			`[marketplace] using the committed fixture, not GitHub: ${reason}`,
		);
		return { source: "fixture", plugins: fixture };
	}
}

let memo: Promise<Marketplace> | undefined;

/** One read per build, shared by every page that asks. */
export function readMarketplace(): Promise<Marketplace> {
	memo ??= fetchMarketplace({
		required: process.env.MARKETPLACE_REQUIRED === "1",
	});
	return memo;
}
```

If `resolveJsonModule` is not already on for the website's tsconfig, typecheck will say so; it is on in `@onlooker/config-typescript` if `astro check` accepts the import as-is. Do not change tsconfig without reporting it.

- [ ] **Step 5: Wire the flag**

In `turbo.json`, add `"MARKETPLACE_REQUIRED"` to `tasks.build.env`, after `"LOG_LEVEL"` (the list is roughly alphabetical; keep it so).

In `.github/workflows/deploy.yml`, in the `deploy-production` job's `Build` step `env:` block (the one that sets `SENTRY_AUTH_TOKEN`, `SENTRY_RELEASE` and `PUBLIC_MONITORING_RELEASE`), add, matching the surrounding comment style:

```yaml
          # The website's plugin pages read ecosystem's marketplace from GitHub
          # while this step builds them. Everywhere else a failed read falls
          # back to a committed fixture; here it fails the build, so
          # onlooker.dev never ships the fixture's versions. See
          # apps/website/src/lib/marketplace.ts.
          MARKETPLACE_REQUIRED: '1'
```

Do not add it to `deploy-staging`: the website deploys only from production.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/website test marketplace`
Expected: PASS, 12 tests.

- [ ] **Step 7: Ablate**

One at a time, restoring after each: (a) make `fetchMarketplace` ignore `required`; (b) drop the `response.ok` check; (c) drop the `version` field check; (d) remove `MARKETPLACE_REQUIRED` from `turbo.json`; (e) remove it from `deploy.yml`. Each must fail at least one test. Record which.

- [ ] **Step 8: Gates and commit**

Run the three gates. Commit `marketplace.ts`, the fixture, the test, `turbo.json` and `deploy.yml` together: `feat(website): read plugin versions from the ecosystem marketplace`, body citing ONL-263.

---

### Task 2: Pages render the marketplace joined to slim prose

**Files:**
- Modify: `apps/website/src/data/plugins/types.ts`
- Modify: `apps/website/src/data/plugins/index.ts`
- Modify: all 16 `apps/website/src/data/plugins/<name>.ts`
- Create: `apps/website/src/data/plugins/customs.ts`, `apps/website/src/data/plugins/ecosystem.ts`
- Rewrite: `apps/website/src/data/plugins/echo.ts`
- Modify: `apps/website/src/pages/plugins/[slug].astro`, `apps/website/src/pages/plugins/index.astro`
- Create: `apps/website/src/__tests__/plugin-pages.test.ts`

**Interfaces:**
- Consumes: `readMarketplace`, `MarketplacePlugin` from Task 1; the fixture at `src/data/plugins/marketplace.fixture.json`.
- Produces:
  ```ts
  export type PluginCategory = "substrate" | "memory" | "analysis" | "safety" | "testing" | "governance" | "quality";
  export interface PluginProse { slug: string; name: string; tagline: string; category: PluginCategory; problem: string; howItWorks: string[] }
  export type PluginPage = MarketplacePlugin & PluginProse;
  export const allProse: PluginProse[];
  export function joinPlugins(plugins: MarketplacePlugin[]): PluginPage[]; // throws when an entry has no prose
  ```

- [ ] **Step 1: Write the failing tests**

`apps/website/src/__tests__/plugin-pages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { allProse, joinPlugins } from "../data/plugins";
import fixture from "../data/plugins/marketplace.fixture.json";

// The fixture stands in for the marketplace because tests run offline. The
// production build makes the same join against live data, and joinPlugins
// throws there too, so a plugin cannot ship without a page.
describe("plugin pages and the marketplace", () => {
	it("give every marketplace plugin a prose file", () => {
		const prose = new Set(allProse.map((p) => p.slug));
		expect(fixture.map((p) => p.name).filter((n) => !prose.has(n))).toEqual(
			[],
		);
	});

	it("keep no prose file for a plugin the marketplace does not list", () => {
		const listed = new Set(fixture.map((p) => p.name));
		expect(allProse.map((p) => p.slug).filter((s) => !listed.has(s))).toEqual(
			[],
		);
	});

	it("refuse to build a marketplace plugin with no prose", () => {
		expect(() =>
			joinPlugins([
				...fixture,
				{
					name: "newcomer",
					version: "0.1.0",
					description: "Just shipped.",
					readmeUrl: "https://github.com/onlooker-community/ecosystem/blob/main/plugins/newcomer/README.md",
				},
			]),
		).toThrow(/newcomer/);
	});

	it("take version and description from the marketplace, not the prose", () => {
		const [first] = joinPlugins([{ ...fixture[1], version: "9.9.9", description: "Live." }]);
		expect(first.version).toBe("9.9.9");
		expect(first.description).toBe("Live.");
	});

	it("keep two to four how-it-works lines per plugin", () => {
		for (const p of allProse) {
			expect(p.howItWorks.length, p.slug).toBeGreaterThanOrEqual(2);
			expect(p.howItWorks.length, p.slug).toBeLessThanOrEqual(4);
		}
	});
});
```

Note `fixture[1]` is a plugin, not `ecosystem` (Task 1 put ecosystem first).

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter @onlooker/website test plugin-pages`
Expected: FAIL, `allProse` and `joinPlugins` are not exported.

- [ ] **Step 3: Slim the types**

Replace `apps/website/src/data/plugins/types.ts` with:

```ts
import type { MarketplacePlugin } from "../../lib/marketplace";

export type PluginCategory =
	| "substrate"
	| "memory"
	| "analysis"
	| "safety"
	| "testing"
	| "governance"
	| "quality";

/**
 * The part of a plugin page a person writes. Everything that drifts - the
 * version, the description, whether the plugin exists at all - comes from the
 * marketplace (src/lib/marketplace.ts). Keep this short: capabilities lists,
 * config blocks and event tables were the parts that went stale first, and
 * the README linked from every page carries that detail.
 */
export interface PluginProse {
	/** Equals the marketplace entry's `name`. */
	slug: string;
	/** Display name, e.g. "Archivist". */
	name: string;
	tagline: string;
	category: PluginCategory;
	problem: string;
	/** Two to four lines, each true of the plugin's README. */
	howItWorks: string[];
}

export type PluginPage = MarketplacePlugin & PluginProse;
```

- [ ] **Step 4: Trim the 15 existing prose files mechanically**

For every existing file except `echo.ts`: change `PluginData` to `PluginProse` in the import and the annotation; delete `version`, `hero`, `capabilities`, `config`, `events`, `tables`, `tags`, `idealFor`, `skillCommands`, `interventionExample`. Keep `slug`, `name`, `tagline`, `category`, `problem`, `howItWorks` as they are; if `howItWorks` has more than four lines, keep the first four. Task 3 rewrites their content against the READMEs; this task changes shape only.

- [ ] **Step 5: Write customs, ecosystem and echo**

Read `~/src/github.com/onlooker-community/ecosystem/README.md`, `plugins/customs/README.md` and `plugins/echo/README.md` first. Every claim must be true of the README you read; nothing the README does not say. Each file has the shape below. Write `problem` as one paragraph, in the voice of the existing files.

* `ecosystem.ts` — `slug: "ecosystem"`, `name: "Ecosystem"`, `category: "substrate"`. What every plugin needs installed first: the shared storage root and canonical event emission.
* `customs.ts` — `slug: "customs"`, `name: "Customs"`, `category: "safety"`. The outbound secret gate.
* `echo.ts` — `category: "testing"`. Say plainly that it ships no hooks: it is a measurement harness that asks whether an LLM judge discriminates between inputs more reliably than it reproduces itself, and its runtime was retired (ONL-103). No claim that it scores your prompts as you work.

```ts
import type { PluginProse } from "./types";

export const customs: PluginProse = {
	slug: "customs",
	name: "Customs",
	tagline: "…",
	category: "safety",
	problem: "…",
	howItWorks: ["…", "…"],
};
```

(The `…` are the prose you write from the README; there is no fixed text.)

- [ ] **Step 6: Rewrite the index**

Replace `apps/website/src/data/plugins/index.ts` with:

```ts
import type { MarketplacePlugin } from "../../lib/marketplace";
import { archivist } from "./archivist";
import { assayer } from "./assayer";
import { bursar } from "./bursar";
import { cartographer } from "./cartographer";
import { compass } from "./compass";
import { counsel } from "./counsel";
import { curator } from "./curator";
import { customs } from "./customs";
import { echo } from "./echo";
import { ecosystem } from "./ecosystem";
import { governor } from "./governor";
import { historian } from "./historian";
import { inspector } from "./inspector";
import { librarian } from "./librarian";
import { lineage } from "./lineage";
import { scribe } from "./scribe";
import { tribunal } from "./tribunal";
import type { PluginPage, PluginProse } from "./types";
import { warden } from "./warden";

export type { PluginCategory, PluginPage, PluginProse } from "./types";

export const allProse: PluginProse[] = [
	ecosystem,
	archivist,
	assayer,
	bursar,
	cartographer,
	compass,
	counsel,
	curator,
	customs,
	echo,
	governor,
	historian,
	inspector,
	librarian,
	lineage,
	scribe,
	tribunal,
	warden,
];

const proseBySlug = new Map(allProse.map((p) => [p.slug, p]));

/**
 * One page per marketplace entry, in marketplace order. An entry with no prose
 * throws rather than being skipped: a skipped plugin is how customs went
 * without a page, and nothing said so.
 */
export function joinPlugins(plugins: MarketplacePlugin[]): PluginPage[] {
	return plugins.map((plugin) => {
		const prose = proseBySlug.get(plugin.name);
		if (!prose)
			throw new Error(
				`The marketplace lists ${plugin.name}, and src/data/plugins/ has no page for it.`,
			);
		return { ...prose, ...plugin };
	});
}
```

- [ ] **Step 7: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/website test plugin-pages`
Expected: PASS, 5 tests.

- [ ] **Step 8: Rewrite the plugin page**

In `apps/website/src/pages/plugins/[slug].astro`, replace everything above `<style>` with:

```astro
---
import type { PluginCategory, PluginPage } from "../../data/plugins";
import { joinPlugins } from "../../data/plugins";
import Layout from "../../layouts/Layout.astro";
import { readMarketplace } from "../../lib/marketplace";

export const prerender = true;

export async function getStaticPaths() {
	const { plugins } = await readMarketplace();
	return joinPlugins(plugins).map((plugin) => ({
		params: { slug: plugin.slug },
		props: { plugin },
	}));
}

const { plugin } = Astro.props as { plugin: PluginPage };

const categoryLabel: Record<PluginCategory, string> = {
	substrate: "Required",
	memory: "Memory",
	analysis: "Analysis",
	safety: "Safety",
	testing: "Testing",
	governance: "Governance",
	quality: "Quality",
};
---

<Layout
  title={`${plugin.name} — Onlooker Plugins`}
  description={plugin.description}
>
  <main>
    <nav class="breadcrumb" aria-label="Breadcrumb">
      <a href="/">Home</a>
      <span class="sep">/</span>
      <a href="/plugins/">Plugins</a>
      <span class="sep">/</span>
      <span>{plugin.name}</span>
    </nav>

    <header class="hero">
      <div class="hero-meta">
        <span class="category-badge">{categoryLabel[plugin.category]}</span>
        <span class="version">v{plugin.version} on main</span>
      </div>
      <p class="tagline">{plugin.tagline}</p>
      <h1>{plugin.name}</h1>
      <p class="subhead">{plugin.description}</p>

      <div class="install-block">
        <span class="install-label">Install</span>
        <code class="install-command">/plugin install {plugin.slug}@onlooker-community</code>
      </div>
    </header>

    <div class="content">
      <section class="section">
        <h2 class="section-heading">Problem</h2>
        <p class="prose">{plugin.problem}</p>
      </section>

      <section class="section">
        <h2 class="section-heading">How it works</h2>
        <ol class="steps">
          {plugin.howItWorks.map((step) => <li>{step}</li>)}
        </ol>
      </section>

      <div class="docs-cta">
        <span class="docs-label">Full documentation</span>
        <a class="docs-link" href={plugin.readmeUrl} target="_blank" rel="noopener">
          The {plugin.name} README on GitHub →
        </a>
      </div>
    </div>
  </main>
</Layout>
```

In the `<style>` block: rename `.install-coming` to `.install-command` and drop its `opacity: 0.6`; delete the rules for `.capabilities` (three rules), the table rules (`.table-wrap` through `td code.dim`), `.code-block` (two), `.intervention` (two), `.tags` and `.tag`. Keep `.docs-cta`, `.docs-label`, `.docs-link` and the media query.

- [ ] **Step 9: Rewrite the index page**

In `apps/website/src/pages/plugins/index.astro`, replace the frontmatter with:

```astro
---
import type { PluginCategory } from "../../data/plugins";
import { joinPlugins } from "../../data/plugins";
import Layout from "../../layouts/Layout.astro";
import { readMarketplace } from "../../lib/marketplace";

export const prerender = true;

const pages = joinPlugins((await readMarketplace()).plugins);
const base = pages.filter((p) => p.category === "substrate");
const plugins = pages.filter((p) => p.category !== "substrate");

const categoryOrder: Exclude<PluginCategory, "substrate">[] = [
	"memory",
	"analysis",
	"safety",
	"testing",
	"governance",
	"quality",
];

const categoryLabel: Record<Exclude<PluginCategory, "substrate">, string> = {
	memory: "Memory",
	analysis: "Analysis",
	safety: "Safety",
	testing: "Testing",
	governance: "Governance",
	quality: "Quality",
};

const grouped = categoryOrder.map((cat) => ({
	cat,
	plugins: plugins.filter((p) => p.category === cat),
}));
---
```

Change the subhead to: `Open-source Claude Code plugins. Install the ecosystem plugin first; every other plugin builds on it.` Before `<div class="plugin-list">`, render the base layer:

```astro
    <section class="category-section">
      <h2 class="category-heading">
        <span class="category-badge">Install first</span>
      </h2>
      <div class="plugin-grid">
        {base.map((plugin) => (
          <a class="plugin-card" href={`/plugins/${plugin.slug}/`}>
            <div class="card-top">
              <span class="plugin-name">{plugin.name}</span>
              <span class="plugin-version">v{plugin.version}</span>
            </div>
            <p class="plugin-tagline">{plugin.tagline}</p>
            <p class="plugin-sub">{plugin.description}</p>
            <div class="card-footer">
              <span class="card-link">View plugin →</span>
            </div>
          </a>
        ))}
      </div>
    </section>
```

Replace the `categoryOrder.map(...)` block with `grouped.map(({ cat, plugins }) => ...)`, same markup as above per card, skipping a group with no plugins. `plugin.hero.subheadline` becomes `plugin.description`; card `href`s end in `/`.

- [ ] **Step 10: Build it**

Run: `pnpm --filter @onlooker/website build`. It must succeed, and with the network up the log has no `[marketplace]` warning. Then run `MARKETPLACE_REQUIRED=1 pnpm --filter @onlooker/website build`; it must also succeed, which proves the live marketplace joins with every prose file. Confirm `apps/website/dist/client/plugins/customs/index.html` exists. It is still a redirect document until Task 4 opens the gate; that is expected.

- [ ] **Step 11: Ablate**

(a) Make `joinPlugins` skip an entry with no prose instead of throwing; (b) delete `customs` from `allProse`; (c) spread `plugin` before `prose` in `joinPlugins`. Each must fail a test.

- [ ] **Step 12: Gates and commit**

`feat(website): build plugin pages from the marketplace and slim prose`, body citing ONL-263.

---

### Task 3: Make every page's prose true of what ships

**Files:**
- Modify: the 15 prose files Task 2 trimmed (every plugin except `customs`, `ecosystem`, `echo`)
- Report: a table of description disagreements, in the task report

**Interfaces:**
- Consumes: `PluginProse` from Task 2. No interface changes.

This task is writing, not code. Its test is Task 2's suite staying green, and its review is a reader comparing each file to its README.

- [ ] **Step 1: For each plugin, read its README**

`~/src/github.com/onlooker-community/ecosystem/plugins/<name>/README.md`. Read the whole file before writing.

- [ ] **Step 2: Rewrite `tagline`, `problem` and `howItWorks`**

Rules:
* Every sentence is true of the README as it stands today. If the README does not say it, the page does not.
* `howItWorks` is two to four lines. Name the hook or trigger each line runs on, as the README names it (e.g. `SessionStart`, `Stop`, a slash command).
* No version numbers, counts or thresholds that the marketplace or the README can change without this file changing. ("Ranks by recency" is fine; "re-injects 5 items" is not.)
* Keep `category` unless the README makes it plainly wrong; report any change.
* Archivist: its README describes mining commits. The page must not describe PreCompact/PostCompact extraction unless the README still does.

- [ ] **Step 3: Record description disagreements**

For each plugin, compare the `description` in its `plugin.json` (it is in the fixture) to its README. In the task report, list every plugin where the description says something the README contradicts or no longer says, quoting the description's phrase and the README's. Do not edit ecosystem, and do not override the description on the site.

- [ ] **Step 4: Gates and commit**

`docs(website): rewrite plugin pages against each plugin's README`, body citing ONL-263.

---

### Task 4: Open /plugins past the launch gate

**Files:**
- Modify: `apps/website/src/lib/launch-gate.ts`
- Modify: `apps/website/src/__tests__/launch-gate.test.ts`
- Modify: `apps/website/src/layouts/Layout.astro`
- Modify: `apps/website/src/__tests__/layout-meta.test.ts`

**Interfaces:**
- Consumes: none from earlier tasks.

- [ ] **Step 1: Write the failing tests**

In `launch-gate.test.ts`, move `/plugins` and `/plugins/archivist` from the gated list to the admitted list, add `/plugins/` and `/plugins/archivist/` to the admitted list, add `/pluginsx` to the gated list, and replace the comment above the gated list with:

```ts
	// /blogx and /pluginsx are the prefix matches a careless startsWith would
	// let through.
```

In `layout-meta.test.ts`, add inside the `describe`:

```ts
	it("links to the plugin pages from the nav", async () => {
		expect(await render({})).toMatch(
			/<a class="nav-link" href="\/plugins\/"[^>]*>Plugins<\/a>/,
		);
	});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter @onlooker/website test launch-gate`, then `pnpm --filter @onlooker/website test layout-meta`.
Expected: the four admitted `/plugins` cases and the nav test fail.

- [ ] **Step 3: Open the gate**

In `launch-gate.ts`, the function body becomes:

```ts
	return (
		pathname === "/" ||
		pathname === "/blog" ||
		pathname.startsWith("/blog/") ||
		pathname === "/plugins" ||
		pathname.startsWith("/plugins/")
	);
```

Leave the doc comment as it is; it still describes the rule.

In `Layout.astro`, before the Blog link:

```astro
          <a class="nav-link" href="/plugins/">Plugins</a>
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/website test`
Expected: PASS, every file.

- [ ] **Step 5: Check a real build**

```bash
env -u SITE_LAUNCHED pnpm --filter @onlooker/website build
head -c 200 apps/website/dist/client/plugins/index.html
head -c 200 apps/website/dist/client/plugins/customs/index.html
```

Neither may start with `<title>Redirecting`. Paste both outputs into the report.

- [ ] **Step 6: Ablate**

Remove the `/plugins/` prefix clause; the admitted `/plugins/archivist` case must fail. Remove the nav link; the nav test must fail.

- [ ] **Step 7: Gates and commit**

`feat(website): open the plugin pages past the launch gate`, body with `Fixes ONL-264`.

---

## After the tasks (controller)

* File one Linear issue on team ONL, labels `ecosystem` and `bug`, project onlooker.dev, from Task 3's disagreement table: the marketplace descriptions that contradict their READMEs. Link ONL-263.
* Close-out: final whole-branch review, then the PR with `Fixes ONL-263` and `Fixes ONL-264`.
