import type { TLesson } from "@onlooker-community/lesson-contract";
import { satisfies } from "./ranges";
import type { InstalledStack } from "./stack";
import { matchesPattern } from "./worktree";

/**
 * What this machine can say about one lesson, right now.
 *
 * Three outcomes rather than a boolean, because "does not apply" and "cannot
 * tell" are different claims and only one of them is ever knowable from an
 * unresolved constraint.
 */
export type Verdict =
	| { kind: "applies"; changed: boolean; matchedPatterns: string[] }
	| { kind: "cannot-tell"; reason: string }
	| { kind: "excluded"; reason: string };

export interface JudgeContext {
	installed: InstalledStack;
	/** Null when git could not say; empty when it says nothing changed. */
	changedFiles: string[] | null;
}

/**
 * Three gates, in order. Each answers a different question, and collapsing
 * them is how a reader starts lying.
 *
 * Pure on purpose - no disk, no git - so these tests state applicability rules
 * rather than fixture plumbing.
 */
export function judge(lesson: TLesson, context: JudgeContext): Verdict {
	// Gate 1: status. Only active lessons are advice. Surfacing a refuted one
	// is worse than surfacing nothing - it is this pipeline's failure dressed
	// as its output.
	if (lesson.status !== "active") {
		return {
			kind: "excluded",
			reason: `status is ${lesson.status}, so this is not advice`,
		};
	}

	const { stack, scope, file_patterns } = lesson.applies_to;

	// Gate 2: applicability, where structural staleness lives.
	//
	// Every stack entry must be present, not just one: a lesson naming two is
	// about how they interact. Absent means cannot-tell, never does-not-apply,
	// because a project whose dependencies are not installed is one we cannot
	// answer about rather than one nothing applies to.
	const missing = stack.filter((name) => !context.installed.has(name));
	if (missing.length > 0) {
		return {
			kind: "cannot-tell",
			reason: `not installed here: ${missing.join(", ")}`,
		};
	}

	if (scope.kind === "versioned") {
		for (const [name, range] of Object.entries(scope.versions)) {
			const version = context.installed.get(name);
			// A versions key naming something absent from stack is the defect
			// applies-to.ts describes. Skipping the constraint would mint a
			// lesson that never expires, so it resolves to cannot-tell.
			if (version === undefined) {
				return { kind: "cannot-tell", reason: `not installed here: ${name}` };
			}

			const verdict = satisfies(version, range);
			if (verdict === "unparseable") {
				return {
					kind: "cannot-tell",
					reason: `could not compare ${name} ${version} against "${range}"`,
				};
			}
			if (verdict === "unsatisfied") {
				return {
					kind: "excluded",
					reason: `${name} ${version} is outside "${range}"`,
				};
			}
		}
	}

	// Gate 3: relevance. This only ever annotates - a pattern that does not
	// match demotes a lesson, it never hides one, because hiding on a weak
	// signal is how a reader withholds the thing someone needed.
	//
	// task_kinds is deliberately not consulted: nothing in a CLI invocation
	// knows the task, so filtering on it would drop lessons on a guess.
	const changedFiles = context.changedFiles;
	const matchedPatterns =
		changedFiles === null
			? []
			: file_patterns.filter((pattern) =>
					changedFiles.some((file) => matchesPattern(file, pattern)),
				);

	return {
		kind: "applies",
		changed: matchedPatterns.length > 0,
		matchedPatterns,
	};
}
