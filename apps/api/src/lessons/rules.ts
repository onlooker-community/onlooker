import type { TLesson } from "@onlooker-community/lesson-contract";

export interface RuleViolation {
	rule: string;
	message: string;
}

/**
 * A two-sided comparator range: ">=4 <6". VERSION_RANGE in the contract has
 * already guaranteed the shape and the comparator ordering by the time this
 * runs, so this only has to pull the four parts out.
 */
const TWO_SIDED = /^(>=?)(\S+) (<=?)(\S+)$/;

/**
 * Compare two dotted version strings by numeric component.
 *
 * Missing components read as zero, so "4" and "4.0.0" compare equal. That is
 * the same reading VERSION_RANGE allows when it accepts a one- or two-component
 * version, and treating them differently here would make ">=4 <4.0.0" behave
 * unlike ">=4 <4".
 */
function compareVersions(a: string, b: string): number {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const difference = (left[i] ?? 0) - (right[i] ?? 0);
		if (difference !== 0) return difference < 0 ? -1 : 1;
	}
	return 0;
}

/**
 * Whether a range matches no version at all.
 *
 * This is deliberately wider than the "not inverted" rule the contract's
 * comment asks for. ">6 <2" is inverted and matches nothing; ">=4 <4" is not
 * inverted and also matches nothing. Both are the same defect - a constraint
 * that can never hold - so both are rejected, and the code is identical.
 *
 * A single-sided range can never be empty, so it is not this function's
 * business. VERSION_RANGE already rejects the one single-sided case that says
 * nothing, an all-zero lower bound like ">=0".
 */
function rangeIsEmpty(range: string): boolean {
	const match = TWO_SIDED.exec(range);
	if (!match) return false;

	const [, lowerOperator, lower, upperOperator, upper] = match;
	const order = compareVersions(lower, upper);

	if (order > 0) return true;
	if (order < 0) return false;

	// Bounds are equal, so the range holds exactly that version - and only when
	// both ends include it.
	return !(lowerOperator === ">=" && upperOperator === "<=");
}

/**
 * The cross-field rules JSON Schema cannot express.
 *
 * These live here rather than in packages/lesson-contract on purpose. A
 * .check() there would make the package reject values the published JSON Schema
 * accepts, and the shell-based plugins validate against that artifact and
 * cannot import the package - so an invisible rule would fail them with no way
 * to have known. Each rule is documented as prose in a .describe() on the
 * relevant schema, and enforced here.
 *
 * Every violation is collected rather than returning on the first, so a client
 * fixing one does not discover the next on the following round trip.
 */
export function checkCrossFieldRules(lesson: TLesson): RuleViolation[] {
	const violations: RuleViolation[] = [];

	// Delegated from ZConsensus in lesson.ts.
	if (lesson.consensus.agreed > lesson.consensus.judges) {
		violations.push({
			rule: "consensus_agreed_within_judges",
			message: `consensus.agreed (${lesson.consensus.agreed}) exceeds consensus.judges (${lesson.consensus.judges})`,
		});
	}

	const { scope, stack } = lesson.applies_to;
	if (scope.kind === "versioned") {
		const declared = new Set(stack);

		for (const [name, range] of Object.entries(scope.versions)) {
			// Delegated from ZAppliesTo in applies-to.ts. A key naming something
			// absent from stack means the lesson either never matches or the
			// constraint is skipped - and skipping it yields a lesson that never
			// expires, which is the failure class the scope union exists to close.
			if (!declared.has(name)) {
				violations.push({
					rule: "versions_key_in_stack",
					message: `applies_to.scope.versions has a key "${name}" that is not in applies_to.stack`,
				});
			}

			// Delegated from the VERSION_RANGE comment in primitives.ts.
			if (rangeIsEmpty(range)) {
				violations.push({
					rule: "range_admits_a_version",
					message: `applies_to.scope.versions["${name}"] is "${range}", which matches no version`,
				});
			}
		}
	}

	return violations;
}
