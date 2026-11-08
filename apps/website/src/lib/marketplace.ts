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
 * A failed read fails the build only where it ships. The production job's
 * Build Website step sets MARKETPLACE_REQUIRED=true; everywhere else - a laptop
 * offline, CI's test jobs during a GitHub outage - falls back to the committed
 * fixture and says so, because `pnpm build` builds every package and a website
 * fetch should not block an API deploy.
 *
 * The flag is declared through astro:env in astro.config.mjs, and the pages
 * read it and pass it in. This module must not read it itself: the Cloudflare
 * adapter prerenders in workerd, where `process.env` does not carry the shell's
 * environment, so a `process.env` read here saw undefined and a strict build
 * shipped the fixture (reproduced 2026-11-07). And it must not import
 * astro:env, because vitest runs without astro.config.mjs and cannot resolve
 * it.
 */

const RAW = "https://raw.githubusercontent.com/onlooker-community/ecosystem/";
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

async function json(
	read: typeof fetch,
	ref: string,
	path: string,
): Promise<unknown> {
	const response = await read(`${RAW}${ref}/${path}`);
	if (!response.ok) throw new Error(`${path} answered ${response.status}`);
	return response.json();
}

function field(manifest: unknown, key: string, path: string): string {
	const value = (manifest as Record<string, unknown> | null)?.[key];
	if (typeof value !== "string" || value === "")
		throw new Error(`${path} has no ${key}`);
	return value;
}

/**
 * Every plugin's facts, read at `ref`: `main` for a site build, a commit SHA
 * for the ecosystem sync, which records the commit it read. `readmeUrl` stays
 * on main either way, so the fixture the sync writes equals what a build of
 * main reads.
 */
export async function fromGitHub(
	read: typeof fetch,
	ref = "main",
): Promise<MarketplacePlugin[]> {
	const listing = (await json(
		read,
		ref,
		".claude-plugin/marketplace.json",
	)) as {
		plugins?: { name: string; source: string }[];
	};
	if (!Array.isArray(listing?.plugins))
		throw new Error("marketplace.json has no plugins");
	return Promise.all(
		listing.plugins.map(async ({ name, source }) => {
			const dir = directory(source);
			const path = `${dir}.claude-plugin/plugin.json`;
			const manifest = await json(read, ref, path);
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
		warn(`[marketplace] using the committed fixture, not GitHub: ${reason}`);
		return { source: "fixture", plugins: fixture };
	}
}

let memo: Promise<Marketplace> | undefined;

/**
 * One read per build, shared by every page that asks. `required` is
 * MARKETPLACE_REQUIRED from astro:env/server; every page passes the same value,
 * so the first caller's decides.
 */
export function readMarketplace({
	required,
}: {
	required: boolean;
}): Promise<Marketplace> {
	memo ??= fetchMarketplace({ required });
	return memo;
}
