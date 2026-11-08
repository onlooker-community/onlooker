import type { MarketplacePlugin } from "./marketplace";

/**
 * What the ecosystem sync PR says, and whether there is one at all.
 *
 * Pure, so it is tested here; the network read is the site's own loader and
 * the git side is scripts/ecosystem-sync.sh. See ONL-277.
 */

/** The committed fixture: the plugins, and the ecosystem commit they came from. */
export interface Fixture {
	commit: string;
	plugins: MarketplacePlugin[];
}

const BLOB = "https://github.com/onlooker-community/ecosystem/blob/main/";
const REPO = "https://github.com/onlooker-community/ecosystem/";
const PROSE = "apps/website/src/data/plugins/";

/**
 * A plugin's README as a path in ecosystem. Taken from readmeUrl, which the
 * loader builds from the marketplace's `source`, so it is the README that
 * plugin's page was written against and never one of the measurement
 * write-ups that also live under plugins/.
 */
export function readmePath(plugin: MarketplacePlugin): string {
	if (!plugin.readmeUrl.startsWith(BLOB))
		throw new Error(
			`${plugin.name}'s readmeUrl is not on ecosystem's main: ${plugin.readmeUrl}`,
		);
	return plugin.readmeUrl.slice(BLOB.length);
}

const short = (sha: string) => sha.slice(0, 7);
const prose = (name: string) => `\`${PROSE}${name}.ts\``;

export function summarize({
	before,
	after,
	changedFiles,
}: {
	before: Fixture;
	after: Fixture;
	changedFiles: string[];
}): { changed: boolean; body: string } {
	const old = new Map(before.plugins.map((p) => [p.name, p]));
	const now = new Map(after.plugins.map((p) => [p.name, p]));

	const added = after.plugins.filter((p) => !old.has(p.name));
	const removed = before.plugins.filter((p) => !now.has(p.name));

	const updated: string[] = [];
	for (const p of after.plugins) {
		const was = old.get(p.name);
		if (!was) continue;
		const parts: string[] = [];
		if (was.version !== p.version)
			parts.push(`\`${p.name}\` ${was.version} → ${p.version}`);
		if (was.description !== p.description)
			parts.push(
				`${parts.length ? "description" : `\`${p.name}\` description`} now: “${p.description}”`,
			);
		if (parts.length) updated.push(`- ${parts.join("; ")}`);
	}

	const touched = new Set(changedFiles);
	const readmes = after.plugins.filter(
		(p) => old.has(p.name) && touched.has(readmePath(p)),
	);

	// Order and links count too: they change the pages even when no version
	// or description did.
	const pluginsDiffer =
		JSON.stringify(before.plugins) !== JSON.stringify(after.plugins);
	const changed = pluginsDiffer || readmes.length > 0;

	const compare = `${REPO}compare/${before.commit}...${after.commit}`;
	const lines = [
		`Brings onlooker.dev's copy of ecosystem's marketplace from [\`${short(before.commit)}\`](${REPO}commit/${before.commit}) to [\`${short(after.commit)}\`](${REPO}commit/${after.commit}) ([compare](${compare})).`,
		"",
		"Merging this deploys onlooker.dev alone, after the `website` approval. Merging also confirms that the prose files listed under READMEs still match their READMEs.",
	];

	if (updated.length)
		lines.push("", "### Versions and descriptions", "", ...updated);
	if (added.length)
		lines.push(
			"",
			"### Added",
			"",
			...added.map(
				(p) =>
					`- \`${p.name}\` ${p.version}. CI fails until it has a prose file, ${prose(p.name)}, listed in \`${PROSE}index.ts\`.`,
			),
		);
	if (removed.length)
		lines.push(
			"",
			"### Removed",
			"",
			...removed.map(
				(p) =>
					`- \`${p.name}\`. CI fails until ${prose(p.name)} and its entry in \`${PROSE}index.ts\` are deleted.`,
			),
		);
	if (readmes.length)
		lines.push(
			"",
			"### READMEs to re-check",
			"",
			...readmes.map(
				(p) =>
					`- \`${readmePath(p)}\` changed ([compare](${compare})). Check ${prose(p.name)} against it.`,
			),
		);
	if (pluginsDiffer && !updated.length && !added.length && !removed.length)
		lines.push("", "Only the plugins' order or README links changed.");

	lines.push(
		"",
		"---",
		"",
		"Opened by `.github/workflows/ecosystem-sync.yml`, which updates this pull request every hour while ecosystem keeps changing. Commits you add to this branch are kept.",
		"",
	);

	return { changed, body: lines.join("\n") };
}
