import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStack } from "../stack";

function project(): string {
	const root = mkdtempSync(join(tmpdir(), "onlooker-stack-"));
	mkdirSync(join(root, ".git"), { recursive: true });
	return root;
}

function installed(root: string, name: string, version: string): void {
	const dir = join(root, "node_modules", ...name.split("/"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
}

describe("resolveStack", () => {
	// The whole point of reading node_modules: a caret over a lockfile pinning
	// 6 must not keep a lesson scoped `<6` alive.
	it("reads the installed version, not the declared range", () => {
		const root = project();
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ dependencies: { vite: "^5.2.0" } }),
		);
		installed(root, "vite", "6.0.1");

		expect(resolveStack(root).installed.get("vite")).toBe("6.0.1");
	});

	it("handles a scoped package", () => {
		const root = project();
		installed(root, "@vitest/coverage-v8", "4.1.9");

		expect(resolveStack(root).installed.get("@vitest/coverage-v8")).toBe(
			"4.1.9",
		);
	});

	// Absent, which the matcher reads as "cannot tell" rather than "does not
	// apply". A project whose dependencies are not installed is one we cannot
	// answer about, not one that nothing applies to.
	it("omits a package that is declared but not installed", () => {
		const root = project();
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ dependencies: { vite: "^5.2.0" } }),
		);

		expect(resolveStack(root).installed.has("vite")).toBe(false);
	});

	it("reports no root outside a repository", () => {
		const loose = mkdtempSync(join(tmpdir(), "onlooker-loose-"));
		expect(resolveStack(loose).root).toBeNull();
	});

	it("resolves nothing when node_modules does not exist", () => {
		const root = project();
		expect(resolveStack(root).installed.size).toBe(0);
	});

	// One unreadable package must not cost the whole resolution - the matcher
	// will report whatever lesson needed it as cannot-tell.
	it("survives a package.json that will not parse", () => {
		const root = project();
		installed(root, "vite", "5.0.0");
		const broken = join(root, "node_modules", "broken");
		mkdirSync(broken, { recursive: true });
		writeFileSync(join(broken, "package.json"), "{ not json");

		expect(resolveStack(root).installed.get("vite")).toBe("5.0.0");
		expect(resolveStack(root).installed.has("broken")).toBe(false);
	});

	it("ignores dot directories like .bin and .pnpm", () => {
		const root = project();
		installed(root, "vite", "5.0.0");
		mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });

		expect(resolveStack(root).installed.has(".bin")).toBe(false);
	});

	it("omits a package whose manifest declares no version", () => {
		const root = project();
		const dir = join(root, "node_modules", "nameless");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));

		expect(resolveStack(root).installed.has("nameless")).toBe(false);
	});
});
