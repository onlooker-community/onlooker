import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * The project key the ecosystem's hooks write, rebuilt from git (ONL-197).
 *
 * A reimplementation of `onlooker_project_resolve` in the ecosystem's
 * scripts/lib/onlooker-project-key.sh. That file warns that a JS copy which
 * drifted would stop matching, and that is why nothing here is trusted on
 * its own: a key computed here is only ever compared with the key the hook
 * recorded, and a mismatch means no label, never a wrong one.
 */
export type Resolved =
	| { kind: "remote"; key: string; url: string }
	| { kind: "root"; key: string; root: string }
	| { kind: "none"; why: "missing" | "not-a-repo" | "no-git" };

/** First 12 hex of SHA-256, as `_onlooker_sha256_first12` prints it. */
export function projectKey(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

class NoGit extends Error {}

/**
 * Variables that point git at a repository regardless of `-C`. A sync run
 * from a git hook, or under `git rebase --exec`, inherits them, and every
 * directory would then resolve to that one repo.
 */
const REDIRECTS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_INDEX_FILE",
];

/** Git's stdout without its trailing newline, or null when git said no. */
function git(dir: string, ...args: string[]): string | null {
	const env = { ...process.env };
	for (const name of REDIRECTS) delete env[name];
	try {
		return execFileSync("git", ["-C", dir, ...args], {
			encoding: "utf8",
			env,
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		}).replace(/\n$/, "");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NoGit();
		return null;
	}
}

export function resolveProject(dir: string): Resolved {
	if (!existsSync(dir)) return { kind: "none", why: "missing" };
	try {
		const url = git(dir, "remote", "get-url", "origin");
		if (url) return { kind: "remote", key: projectKey(`remote:${url}`), url };

		if (git(dir, "rev-parse", "--is-inside-work-tree") !== "true") {
			return { kind: "none", why: "not-a-repo" };
		}
		const root = repoRoot(dir);
		if (!root) return { kind: "none", why: "not-a-repo" };
		return { kind: "root", key: projectKey(`root:${root}`), root };
	} catch (error) {
		if (error instanceof NoGit) return { kind: "none", why: "no-git" };
		throw error;
	}
}

/**
 * `onlooker_project_repo_root`: the common dir's parent, real path, so a
 * linked worktree resolves to its main checkout. Falls back to
 * `--show-toplevel` as the shell does.
 */
function repoRoot(dir: string): string | null {
	const common = git(dir, "rev-parse", "--git-common-dir");
	if (common) {
		const absolute = isAbsolute(common) ? common : resolve(dir, common);
		try {
			return realpathSync(dirname(absolute));
		} catch {
			// Falls through to the toplevel, as the shell's does.
		}
	}
	const top = git(dir, "rev-parse", "--show-toplevel");
	if (!top) return null;
	try {
		return realpathSync(top);
	} catch {
		return null;
	}
}
