import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedFiles, matchesPattern } from "../worktree";

/** A real repository, because this module's whole risk is the subprocess. */
function repo(): { root: string; git: (...args: string[]) => void } {
	const root = mkdtempSync(join(tmpdir(), "onlooker-repo-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, stdio: "ignore" });
	git("init");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "T");
	return { root, git };
}

describe("matchesPattern", () => {
	it("matches a literal path", () => {
		expect(matchesPattern("src/worker.ts", "src/worker.ts")).toBe(true);
		expect(matchesPattern("src/other.ts", "src/worker.ts")).toBe(false);
	});

	// `*` stops at a separator and `**` crosses them. Getting this backwards
	// makes every pattern match everything, which is the failure that turns a
	// reader into noise.
	it("keeps * within one segment", () => {
		expect(matchesPattern("src/worker.ts", "src/*.ts")).toBe(true);
		expect(matchesPattern("src/deep/worker.ts", "src/*.ts")).toBe(false);
	});

	it("lets ** cross segments", () => {
		expect(matchesPattern("src/deep/worker.ts", "src/**/*.ts")).toBe(true);
		expect(matchesPattern("src/worker.ts", "src/**/*.ts")).toBe(true);
	});

	it("matches a single character with ?", () => {
		expect(matchesPattern("src/a.ts", "src/?.ts")).toBe(true);
		expect(matchesPattern("src/ab.ts", "src/?.ts")).toBe(false);
	});

	// Regex metacharacters in a pattern are literals, not syntax. An
	// unescaped dot would make "src.worker.ts" match anything in src/.
	it("treats a dot as a dot", () => {
		expect(matchesPattern("srcXworker.ts", "src.worker.ts")).toBe(false);
		expect(matchesPattern("src.worker.ts", "src.worker.ts")).toBe(true);
	});

	it("anchors, so a pattern does not match a longer path", () => {
		expect(matchesPattern("a/src/worker.ts", "src/worker.ts")).toBe(false);
		expect(matchesPattern("src/worker.ts.bak", "src/worker.ts")).toBe(false);
	});
});

describe("changedFiles", () => {
	it("is null outside a git repository", () => {
		expect(
			changedFiles(mkdtempSync(join(tmpdir(), "onlooker-nogit-"))),
		).toBeNull();
	});

	// Relevance only ever splits the output, so losing it must never cost the
	// answer. Every failure degrades rather than throwing.
	it("is null rather than throwing when git cannot answer", () => {
		expect(changedFiles("/definitely/not/a/path")).toBeNull();
	});

	it("lists a modified file, relative to the repo root", () => {
		const { root, git } = repo();
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "worker.ts"), "export {};\n");
		git("add", ".");
		git("commit", "-m", "first");
		writeFileSync(join(root, "src", "worker.ts"), "export const x = 1;\n");

		expect(changedFiles(root)).toContain("src/worker.ts");
	});

	// A file you just created is something you are working on, and a lesson
	// about it is as relevant as one about a modified file.
	it("lists an untracked file too", () => {
		const { root } = repo();
		writeFileSync(join(root, "new.ts"), "export {};\n");

		expect(changedFiles(root)).toContain("new.ts");
	});

	it("is empty in a clean repository", () => {
		const { root, git } = repo();
		writeFileSync(join(root, "a.ts"), "export {};\n");
		git("add", ".");
		git("commit", "-m", "first");

		// Empty is not the same as null: git answered, and the answer is
		// "you are not changing anything".
		expect(changedFiles(root)).toEqual([]);
	});

	it("reports the new name of a renamed file", () => {
		const { root, git } = repo();
		writeFileSync(join(root, "old.ts"), "export {};\n");
		git("add", ".");
		git("commit", "-m", "first");
		git("mv", "old.ts", "new.ts");

		// The new name is what exists to be matched against a pattern.
		expect(changedFiles(root)).toContain("new.ts");
	});
});
