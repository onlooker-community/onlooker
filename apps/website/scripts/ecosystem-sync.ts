/**
 * Regenerates the marketplace fixture and the ecosystem sync PR's body.
 *
 * Usage:
 *   tsx apps/website/scripts/ecosystem-sync.ts <commit> <before.json> \
 *     <changed-files.txt> <fixture-out.json> <body-out.md>
 *
 * Prints `changed` or `unchanged`, and writes the two output files only when
 * changed. Run by scripts/ecosystem-sync.sh, which owns the git and GitHub
 * side; this owns only the data. The read is the site's own loader at a
 * pinned commit, so the fixture is exactly what a build would read, and the
 * decision is summarize(), tested in src/__tests__/ecosystem-sync.test.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { type Fixture, summarize } from "../src/lib/ecosystem-sync";
import { fromGitHub } from "../src/lib/marketplace";

async function main(): Promise<void> {
	const [commit, beforePath, changedPath, fixtureOut, bodyOut] =
		process.argv.slice(2);
	if (
		!commit ||
		!beforePath ||
		!changedPath ||
		!fixtureOut ||
		!bodyOut ||
		!/^[0-9a-f]{40}$/.test(commit)
	) {
		console.error(
			"usage: ecosystem-sync.ts <commit> <before.json> <changed-files.txt> <fixture-out.json> <body-out.md>",
		);
		process.exit(2);
	}

	const before = JSON.parse(readFileSync(beforePath, "utf8")) as Fixture;
	const changedFiles = readFileSync(changedPath, "utf8")
		.split("\n")
		.filter(Boolean);
	const after: Fixture = { commit, plugins: await fromGitHub(fetch, commit) };

	const sync = summarize({ before, after, changedFiles });
	if (sync.changed) {
		writeFileSync(fixtureOut, `${JSON.stringify(after, null, "\t")}\n`);
		writeFileSync(bodyOut, sync.body);
	}
	console.log(sync.changed ? "changed" : "unchanged");
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
