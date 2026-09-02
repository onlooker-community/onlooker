import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { batch, discoverApproved, MAX_BATCH, parseLesson } from "../lessons";

const FIXTURE = join(__dirname, "fixtures", "lesson.json");

function root(): NodeJS.ProcessEnv {
	return { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-lessons-")) };
}

function approvedDir(env: NodeJS.ProcessEnv, key = "4c1de90ab372"): string {
	const dir = join(
		env.ONLOOKER_DIR as string,
		"librarian",
		key,
		"lessons",
		"approved",
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("discoverApproved", () => {
	// Three states a recursive glob would collapse into one silent zero. Until
	// the ecosystem's promotion step ships, the third is the expected one, so
	// telling it from the first two is the difference between "nothing to sync
	// yet" and "your install is wrong".
	it("distinguishes a missing ONLOOKER_DIR", () => {
		const env = {
			ONLOOKER_DIR: join(tmpdir(), "definitely-not-here-onlooker"),
		};
		expect(discoverApproved(env).kind).toBe("no-onlooker-dir");
	});

	it("distinguishes an ONLOOKER_DIR with no librarian directory", () => {
		expect(discoverApproved(root()).kind).toBe("no-librarian-dir");
	});

	it("reports an empty approved directory as found-but-empty", () => {
		const env = root();
		approvedDir(env);
		const found = discoverApproved(env);
		expect(found).toEqual({ kind: "found", files: [], unreadable: [] });
	});

	it("finds lessons across every project", () => {
		const env = root();
		cpSync(FIXTURE, join(approvedDir(env, "4c1de90ab372"), "a.json"));
		cpSync(FIXTURE, join(approvedDir(env, "aaaaaaaaaaaa"), "b.json"));
		const found = discoverApproved(env);
		expect(found.kind).toBe("found");
		expect(found.kind === "found" && found.files).toHaveLength(2);
	});

	// proposals/ holds candidates that have not been judged. Pushing one would
	// put an unjudged claim into a pool whose whole premise is consensus.
	it("never reads proposals", () => {
		const env = root();
		const proposals = join(
			env.ONLOOKER_DIR as string,
			"librarian",
			"k",
			"lessons",
			"proposals",
		);
		mkdirSync(proposals, { recursive: true });
		cpSync(FIXTURE, join(proposals, "p.json"));
		expect(discoverApproved(env)).toMatchObject({ kind: "found", files: [] });
	});

	// A directory that exists but cannot be listed is its own answer, not zero
	// lessons. Reporting `found` with an empty array here would be the silent
	// zero this union exists to prevent - there could be a thousand lessons
	// behind a path we could not open.
	it("distinguishes a librarian directory it cannot list", () => {
		const env = root();
		writeFileSync(join(env.ONLOOKER_DIR as string, "librarian"), "");
		const found = discoverApproved(env);
		expect(found.kind).toBe("unreadable");
		expect(found.kind === "unreadable" && found.path).toContain("librarian");
	});

	// One unlistable project key must not cost the others their lessons, and it
	// must not vanish either: the count would then be quietly short.
	it("names a project it cannot list without losing its siblings", () => {
		const env = root();
		cpSync(FIXTURE, join(approvedDir(env, "aaaaaaaaaaaa"), "a.json"));
		const broken = join(
			env.ONLOOKER_DIR as string,
			"librarian",
			"bbbbbbbbbbbb",
			"lessons",
		);
		mkdirSync(broken, { recursive: true });
		writeFileSync(join(broken, "approved"), "");

		const found = discoverApproved(env);
		expect(found.kind).toBe("found");
		expect(found.kind === "found" && found.files).toHaveLength(1);
		expect(found.kind === "found" && found.unreadable).toHaveLength(1);
	});
});

describe("parseLesson", () => {
	it("accepts the fixture", () => {
		const parsed = parseLesson(FIXTURE);
		expect(parsed.ok).toBe(true);
	});

	// The whole reason this is TypeScript. A lesson the API would reject fails
	// here first, against the same schema, with the same error - and there is no
	// second copy to drift.
	it("rejects a lesson the API would reject, naming the field", () => {
		const env = root();
		const bad = join(approvedDir(env), "bad.json");
		writeFileSync(bad, JSON.stringify({ id: "not-a-ulid", claim: "x" }));
		const parsed = parseLesson(bad);
		expect(parsed.ok).toBe(false);
		expect(parsed.ok === false && parsed.error).toMatch(
			/schema_version|rationale|id/,
		);
	});

	it("reports unreadable JSON without throwing", () => {
		const env = root();
		const broken = join(approvedDir(env), "broken.json");
		writeFileSync(broken, "{ not json");
		expect(parseLesson(broken).ok).toBe(false);
	});
});

describe("batch", () => {
	it("never exceeds the server's limit", () => {
		const batches = batch(
			Array.from({ length: 250 }, (_, i) => i),
			MAX_BATCH,
		);
		expect(batches).toHaveLength(3);
		expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(100);
	});

	it("returns nothing for nothing", () => {
		expect(batch([], MAX_BATCH)).toEqual([]);
	});
});
