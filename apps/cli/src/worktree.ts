import { execFileSync } from "node:child_process";

/**
 * Files the working tree has changed, relative to the repository root.
 *
 * This is the only subprocess in the CLI. Nothing else here shells out, and
 * that was a property worth keeping - but the alternatives are parsing `.git`
 * by hand or asking a person to list their own changed files, and both are
 * worse than one well-guarded `git` call.
 *
 * Null on every failure: no git on PATH, not a repository, a git that errors.
 * Relevance only ever splits the output into "about what you are changing" and
 * "applies to this project", so losing it must never cost the answer itself.
 *
 * Null and `[]` mean different things and both are used. Null is "git could
 * not say"; empty is "git says you are changing nothing".
 */
export function changedFiles(cwd: string): string[] | null {
	try {
		const out = execFileSync(
			"git",
			["status", "--porcelain=v1", "--untracked-files=all"],
			{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
		return (
			out
				.split("\n")
				.filter(Boolean)
				// "XY path", and "XY old -> new" for a rename. The new name is the
				// one that exists to be matched against a pattern.
				.map((line) => line.slice(3).split(" -> ").pop() ?? "")
				.map((path) => path.replace(/^"|"$/g, ""))
				.filter(Boolean)
		);
	} catch {
		return null;
	}
}

/**
 * Glob matching, deliberately small: `*` within a segment, `**` across them,
 * `?` for a single character.
 *
 * Everything else is a literal, regex metacharacters included - an unescaped
 * dot would make `src.worker.ts` match anything under `src/`. A pattern this
 * cannot express fails to match rather than matching something unintended,
 * which is the safe direction for a matcher that decides what a person is
 * shown.
 */
export function matchesPattern(file: string, pattern: string): boolean {
	const expanded = pattern
		.split(/(\*\*\/|\*\*|\*|\?)/)
		.filter(Boolean)
		.map((part) => {
			// `**/` may match nothing at all, so `src/**/*.ts` covers
			// `src/worker.ts` as well as `src/deep/worker.ts`.
			if (part === "**/") return "(?:.*/)?";
			if (part === "**") return ".*";
			if (part === "*") return "[^/]*";
			if (part === "?") return "[^/]";
			return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		})
		.join("");

	return new RegExp(`^${expanded}$`).test(file);
}
