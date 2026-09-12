import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./enablement";

/** Installed version per package name. An absent key means not installed. */
export type InstalledStack = Map<string, string>;

/**
 * What this project actually runs.
 *
 * Read from `node_modules`, never from `package.json`'s declared ranges. A
 * declared `^5.2.0` against a lockfile pinning 6.x would keep a lesson scoped
 * `<6` alive, which is precisely the false positive that structural staleness
 * exists to prevent - and comparing a range against a range is fuzzy in a way
 * comparing a version against a range is not.
 *
 * An absent key means "not installed", which the matcher reads as *cannot
 * tell* rather than as *does not apply*. A project whose dependencies are not
 * installed yet is one we cannot answer about, not one that nothing applies
 * to.
 */
export function resolveStack(cwd: string): {
	root: string | null;
	installed: InstalledStack;
} {
	const root = repoRoot(cwd);
	const installed: InstalledStack = new Map();
	if (root === null) return { root: null, installed };

	const modules = join(root, "node_modules");
	if (!existsSync(modules)) return { root, installed };

	for (const entry of safeReaddir(modules)) {
		// .bin, .pnpm, .vite and friends are machinery, not packages.
		if (entry.startsWith(".")) continue;
		if (entry.startsWith("@")) {
			// A scope directory holds packages rather than being one.
			for (const scoped of safeReaddir(join(modules, entry))) {
				record(installed, modules, `${entry}/${scoped}`);
			}
			continue;
		}
		record(installed, modules, entry);
	}

	return { root, installed };
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/**
 * One package's version, skipping anything unreadable.
 *
 * A single broken manifest must not cost the whole resolution. The lesson that
 * needed that package reports as cannot-tell, which is the honest outcome, and
 * every other lesson is still answerable.
 */
function record(into: InstalledStack, modules: string, name: string): void {
	try {
		const manifest = JSON.parse(
			readFileSync(join(modules, ...name.split("/"), "package.json"), "utf8"),
		) as { version?: unknown };
		if (typeof manifest.version === "string") into.set(name, manifest.version);
	} catch {
		return;
	}
}
