import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectKey, resolveProject } from "../project-key";

// `resolveProject` runs git with this process's environment, so a developer's
// `url.<base>.insteadOf` would rewrite the URL the assertions below expect.
beforeEach(() => {
	vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterEach(() => {
	vi.unstubAllEnvs();
});

// Parity with the ecosystem's _onlooker_sha256_first12. Each pair is a real
// key from this machine's event log, next to the origin URL it came from.
const PARITY: Array<[string, string]> = [
	["remote:git@github.com:onlooker-community/onlooker.git", "6a7678979e31"],
	["remote:git@github.com:onlooker-community/ecosystem.git", "ee2cfbe428c7"],
	["remote:git@github.com:onlooker-community/schema.git", "54460a64b16d"],
];

// Cut off from the developer's global config, which signs commits and seeds
// hooks through a template directory (see worktree.test.ts, ONL-240).
const isolatedGit = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
};

const IDENTITY = [
	"-c",
	"user.email=t@t",
	"-c",
	"user.name=t",
	"-c",
	"commit.gpgsign=false",
];

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, stdio: "ignore", env: isolatedGit });

function repo(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "onlooker-key-")));
	git(dir, "init", "-q");
	git(dir, ...IDENTITY, "commit", "-q", "--allow-empty", "-m", "x");
	return dir;
}

describe("projectKey", () => {
	it.each(PARITY)("%s -> %s", (input, key) => {
		expect(projectKey(input)).toBe(key);
	});
});

describe("resolveProject", () => {
	it("keys a repo with an origin by its URL exactly as git prints it", () => {
		const dir = repo();
		git(
			dir,
			"remote",
			"add",
			"origin",
			"git@github.com:onlooker-community/onlooker.git",
		);
		expect(resolveProject(dir)).toEqual({
			kind: "remote",
			key: "6a7678979e31",
			url: "git@github.com:onlooker-community/onlooker.git",
		});
	});

	it("keys a repo with no origin by its root", () => {
		const dir = repo();
		expect(resolveProject(dir)).toEqual({
			kind: "root",
			key: projectKey(`root:${dir}`),
			root: dir,
		});
	});

	// Problem 2: a session started in a subdirectory names the repo.
	it("resolves a subdirectory to the repo root", () => {
		const dir = repo();
		mkdirSync(join(dir, "src", "deep"), { recursive: true });
		expect(resolveProject(join(dir, "src", "deep"))).toMatchObject({
			root: dir,
		});
	});

	// A linked worktree shares its parent's key, as the shell's does.
	it("resolves a linked worktree to the main checkout", () => {
		const dir = repo();
		const wt = `${dir}-wt`;
		git(dir, ...IDENTITY, "worktree", "add", "-q", wt);
		expect(resolveProject(wt)).toMatchObject({ kind: "root", root: dir });
	});

	// A hook or a `git rebase --exec` exports GIT_DIR; inherited, it would
	// make every directory resolve to that one repo.
	it("ignores an inherited GIT_DIR and GIT_WORK_TREE", () => {
		const dir = repo();
		git(dir, "remote", "add", "origin", "git@github.com:a/mine.git");
		const other = repo();
		git(other, "remote", "add", "origin", "git@github.com:a/other.git");
		vi.stubEnv("GIT_DIR", join(other, ".git"));
		vi.stubEnv("GIT_WORK_TREE", other);
		vi.stubEnv("GIT_COMMON_DIR", join(other, ".git"));
		vi.stubEnv("GIT_INDEX_FILE", join(other, ".git", "index"));
		expect(resolveProject(dir)).toMatchObject({
			kind: "remote",
			url: "git@github.com:a/mine.git",
		});
	});

	it("says a deleted directory is missing", () => {
		const dir = repo();
		rmSync(dir, { recursive: true });
		expect(resolveProject(dir)).toEqual({ kind: "none", why: "missing" });
	});

	it("says a plain directory is not a repo", () => {
		const dir = mkdtempSync(join(tmpdir(), "onlooker-plain-"));
		expect(resolveProject(dir)).toEqual({ kind: "none", why: "not-a-repo" });
	});

	it("says when git is not on PATH", () => {
		const dir = repo();
		const path = process.env.PATH;
		process.env.PATH = "";
		try {
			expect(resolveProject(dir)).toEqual({ kind: "none", why: "no-git" });
		} finally {
			process.env.PATH = path;
		}
	});
});
