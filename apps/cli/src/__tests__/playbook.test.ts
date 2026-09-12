import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { describe, expect, it } from "vitest";
import { judge } from "../playbook";

const base = JSON.parse(
	readFileSync(join(__dirname, "fixtures", "lesson.json"), "utf8"),
) as TLesson;

const lesson = (over: Partial<TLesson>): TLesson =>
	({ ...base, ...over }) as TLesson;

const ctx = (
	installed: Record<string, string>,
	changedFiles: string[] | null = null,
) => ({ installed: new Map(Object.entries(installed)), changedFiles });

describe("judge — status", () => {
	// Surfacing a refuted lesson as advice is worse than surfacing nothing:
	// it is this pipeline's failure dressed up as its output.
	it.each(["refuted", "superseded", "retracted"])("excludes %s", (status) => {
		const v = judge(
			lesson({ status } as Partial<TLesson>),
			ctx({ vite: "5.0.0" }),
		);

		expect(v.kind).toBe("excluded");
		if (v.kind !== "excluded") return;
		expect(v.reason).toContain(status);
	});

	it("admits active", () => {
		expect(judge(base, ctx({ vite: "5.0.0" })).kind).toBe("applies");
	});
});

describe("judge — applicability", () => {
	it("applies when every version constraint is satisfied", () => {
		expect(judge(base, ctx({ vite: "5.2.1" })).kind).toBe("applies");
	});

	// Structural staleness: the lesson retires itself on vite 6 without anyone
	// reviewing it.
	it("excludes when a constraint is unsatisfied", () => {
		const v = judge(base, ctx({ vite: "6.0.0" }));

		expect(v.kind).toBe("excluded");
		if (v.kind !== "excluded") return;
		expect(v.reason).toMatch(/vite/);
	});

	// The trap applies-to.ts names: skipping the constraint mints a lesson
	// that never expires, and calling it a non-match hides one silently.
	it("cannot tell when the package is not installed", () => {
		const v = judge(base, ctx({}));

		expect(v.kind).toBe("cannot-tell");
		if (v.kind !== "cannot-tell") return;
		expect(v.reason).toMatch(/vite/);
	});

	it("cannot tell when the installed version will not parse", () => {
		const v = judge(base, ctx({ vite: "workspace:*" }));

		expect(v.kind).toBe("cannot-tell");
		if (v.kind !== "cannot-tell") return;
		expect(v.reason).toMatch(/workspace/);
	});

	it("applies a version_independent lesson with no version gate", () => {
		const free = lesson({
			applies_to: {
				...base.applies_to,
				scope: { kind: "version_independent", justification: "Holds for all." },
			},
		});

		expect(judge(free, ctx({ vite: "99.0.0" })).kind).toBe("applies");
	});

	// Every stack entry, not any: a lesson naming two is about how they
	// interact, so the strict direction is the safe one.
	it("cannot tell when one of several stack entries is missing", () => {
		const pair = lesson({
			applies_to: { ...base.applies_to, stack: ["vite", "vitest"] },
		});

		const v = judge(pair, ctx({ vite: "5.2.1" }));

		expect(v.kind).toBe("cannot-tell");
		if (v.kind !== "cannot-tell") return;
		expect(v.reason).toMatch(/vitest/);
	});

	// A vite lesson has no business reaching a project with no vite, even
	// when it claims to hold regardless of version.
	it("still gates a version_independent lesson on stack presence", () => {
		const free = lesson({
			applies_to: {
				...base.applies_to,
				scope: { kind: "version_independent", justification: "Holds." },
			},
		});

		expect(judge(free, ctx({})).kind).toBe("cannot-tell");
	});
});

describe("judge — relevance", () => {
	it("marks a lesson whose pattern matches a changed file", () => {
		const v = judge(base, ctx({ vite: "5.2.1" }, ["src/worker.ts"]));

		expect(v).toMatchObject({ kind: "applies", changed: true });
		if (v.kind !== "applies") return;
		expect(v.matchedPatterns).toEqual(["src/worker.ts"]);
	});

	// Demoted, never hidden. Hiding on a weak signal is how a reader silently
	// withholds the thing someone needed.
	it("still applies when no pattern matches", () => {
		const v = judge(base, ctx({ vite: "5.2.1" }, ["README.md"]));

		expect(v).toMatchObject({ kind: "applies", changed: false });
	});

	// No git signal is not the same as nothing matching.
	it("is not marked changed when the working tree is unknown", () => {
		const v = judge(base, ctx({ vite: "5.2.1" }, null));

		expect(v).toMatchObject({ kind: "applies", changed: false });
	});

	// Nothing in a CLI invocation knows the task, so filtering on task_kinds
	// would drop lessons on a guess.
	it("never excludes on task_kinds", () => {
		const odd = lesson({
			applies_to: { ...base.applies_to, task_kinds: ["nothing-like-this"] },
		});

		expect(judge(odd, ctx({ vite: "5.2.1" })).kind).toBe("applies");
	});

	it("matches a glob pattern against the working tree", () => {
		const glob = lesson({
			applies_to: { ...base.applies_to, file_patterns: ["src/**/*.ts"] },
		});

		const v = judge(glob, ctx({ vite: "5.2.1" }, ["src/deep/thing.ts"]));

		expect(v).toMatchObject({ kind: "applies", changed: true });
	});

	it("is not changed when the lesson names no patterns at all", () => {
		const none = lesson({
			applies_to: { ...base.applies_to, file_patterns: [] },
		});

		const v = judge(none, ctx({ vite: "5.2.1" }, ["src/worker.ts"]));

		expect(v).toMatchObject({ kind: "applies", changed: false });
	});
});
