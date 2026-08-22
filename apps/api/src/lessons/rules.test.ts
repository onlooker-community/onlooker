import type { TLesson } from "@onlooker-community/lesson-contract";
import { describe, expect, it } from "vitest";
import { checkCrossFieldRules } from "./rules.js";

/** A lesson that violates nothing, so each test can break exactly one thing. */
function validLesson(overrides: Partial<TLesson> = {}): TLesson {
	return {
		id: "01KZ45MKAM734ZS7JK24D2DK0R",
		schema_version: 2,
		claim: "Pin rollup when vite is below 6",
		rationale: "The bundled rollup version drifts",
		evidence: { artifact_ids: [], resolution: "pinned rollup to 3.29.4" },
		applies_to: {
			stack: ["vite"],
			scope: { kind: "versioned", versions: { vite: "<6" } },
			file_patterns: [],
			task_kinds: [],
		},
		visibility: "private",
		consensus: { judges: 3, agreed: 2, decided_at: "2026-08-22T00:00:00.000Z" },
		status: "active",
		superseded_by: null,
		source: "local",
		author_key: "a".repeat(32),
		promoted_at: "2026-08-22T00:00:00.000Z",
		...overrides,
	} as TLesson;
}

describe("a lesson that violates nothing", () => {
	it("produces no violations", () => {
		expect(checkCrossFieldRules(validLesson())).toEqual([]);
	});
});

// Rule 1 - delegated from ZConsensus in lesson.ts.
describe("consensus.agreed <= consensus.judges", () => {
	it("rejects more agreement than judges", () => {
		const violations = checkCrossFieldRules(
			validLesson({
				consensus: {
					judges: 2,
					agreed: 3,
					decided_at: "2026-08-22T00:00:00.000Z",
				},
			}),
		);

		expect(violations).toHaveLength(1);
		expect(violations[0].rule).toBe("consensus_agreed_within_judges");
	});

	it("allows unanimous agreement", () => {
		expect(
			checkCrossFieldRules(
				validLesson({
					consensus: {
						judges: 3,
						agreed: 3,
						decided_at: "2026-08-22T00:00:00.000Z",
					},
				}),
			),
		).toEqual([]);
	});
});

// Rule 2 - delegated from ZAppliesTo in applies-to.ts. This matters more than
// it looks: a versions key naming something absent from stack means the lesson
// either never matches or the constraint is silently skipped, and skipping it
// yields a lesson that never expires.
describe("every versions key names a stack entry", () => {
	it("rejects a key that is not in stack", () => {
		const violations = checkCrossFieldRules(
			validLesson({
				applies_to: {
					stack: ["vite"],
					scope: { kind: "versioned", versions: { nothing: "<6" } },
					file_patterns: [],
					task_kinds: [],
				},
			}),
		);

		expect(violations).toHaveLength(1);
		expect(violations[0].rule).toBe("versions_key_in_stack");
	});

	it("ignores the rule for a version-independent lesson", () => {
		expect(
			checkCrossFieldRules(
				validLesson({
					applies_to: {
						stack: ["vite"],
						scope: {
							kind: "version_independent",
							justification: "This is about a config file name",
						},
						file_patterns: [],
						task_kinds: [],
					},
				}),
			),
		).toEqual([]);
	});
});

// Rule 3 - delegated from the VERSION_RANGE comment in primitives.ts, which
// says rejecting an inverted range "means comparing magnitudes, which a regex
// cannot do" and belongs in server-side ingest. This is that ingest.
describe("a two-sided range admits at least one version", () => {
	it("rejects an inverted range", () => {
		const violations = checkCrossFieldRules(
			validLesson({
				applies_to: {
					stack: ["vite"],
					scope: { kind: "versioned", versions: { vite: ">6 <2" } },
					file_patterns: [],
					task_kinds: [],
				},
			}),
		);

		expect(violations).toHaveLength(1);
		expect(violations[0].rule).toBe("range_admits_a_version");
	});

	// Wider than "not inverted", deliberately: >=4 <4 is not inverted and still
	// matches nothing, which is the same defect by a different route.
	it("rejects an empty range whose bounds are equal", () => {
		const violations = checkCrossFieldRules(
			validLesson({
				applies_to: {
					stack: ["vite"],
					scope: { kind: "versioned", versions: { vite: ">=4 <4" } },
					file_patterns: [],
					task_kinds: [],
				},
			}),
		);

		expect(violations[0].rule).toBe("range_admits_a_version");
	});

	it("allows an inclusive range pinning one version", () => {
		expect(
			checkCrossFieldRules(
				validLesson({
					applies_to: {
						stack: ["vite"],
						scope: { kind: "versioned", versions: { vite: ">=4 <=4" } },
						file_patterns: [],
						task_kinds: [],
					},
				}),
			),
		).toEqual([]);
	});

	it("allows a normal two-sided range", () => {
		expect(
			checkCrossFieldRules(
				validLesson({
					applies_to: {
						stack: ["vite"],
						scope: { kind: "versioned", versions: { vite: ">=4 <6" } },
						file_patterns: [],
						task_kinds: [],
					},
				}),
			),
		).toEqual([]);
	});

	it("allows a single-sided range, which can never be empty", () => {
		expect(
			checkCrossFieldRules(
				validLesson({
					applies_to: {
						stack: ["vite"],
						scope: { kind: "versioned", versions: { vite: "<6" } },
						file_patterns: [],
						task_kinds: [],
					},
				}),
			),
		).toEqual([]);
	});
});

// Each rule is reported independently, so a client fixing one does not
// discover the next on the following round trip.
describe("multiple violations", () => {
	it("reports all of them at once", () => {
		const violations = checkCrossFieldRules(
			validLesson({
				consensus: {
					judges: 1,
					agreed: 5,
					decided_at: "2026-08-22T00:00:00.000Z",
				},
				applies_to: {
					stack: ["vite"],
					scope: { kind: "versioned", versions: { nothing: ">6 <2" } },
					file_patterns: [],
					task_kinds: [],
				},
			}),
		);

		expect(violations.map((v) => v.rule).sort()).toEqual([
			"consensus_agreed_within_judges",
			"range_admits_a_version",
			"versions_key_in_stack",
		]);
	});
});
