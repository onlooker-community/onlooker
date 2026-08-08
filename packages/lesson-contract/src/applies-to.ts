import { z } from "zod";
import { VERSION_RANGE } from "./primitives.js";

/**
 * Version constraints for a lesson whose truth depends on versions.
 *
 * Non-emptiness is enforced twice on purpose, because neither mechanism
 * reaches the other side. .check() covers runtime parsing, which is what
 * apps/api relies on at ingest. .meta() covers the emitted JSON Schema, which
 * is what the shell-based plugins validate against. Zod refinements are
 * silently dropped by z.toJSONSchema, and .meta() does not affect parsing, so
 * using only .meta() would leave the enforcement boundary accepting values the
 * published artifact rejects.
 */
const ZVersions = z
	.record(z.string().min(1), z.string().regex(VERSION_RANGE))
	.check((ctx) => {
		if (Object.keys(ctx.value).length === 0) {
			ctx.issues.push({
				code: "custom",
				input: ctx.value,
				message: "versions must not be empty",
			});
		}
	})
	.meta({
		description:
			"Comparator-prefixed version ranges keyed by stack entry, for " +
			'example {"vite": "<6"}. A two-sided range reads lower bound ' +
			"then upper bound. Multiple entries combine with AND: every " +
			"entry must match for the lesson to still apply.",
		minProperties: 1,
	});

/**
 * How a lesson's applicability is bounded in time.
 *
 * A tagged union rather than an optional map, because one field cannot carry
 * two meanings. "This lesson has no version dependency" and "the transform
 * could not infer a version" are different facts, and an empty map expressed
 * both. A lesson with no version constraint never expires, so an inference
 * failure used to mint an immortal lesson silently.
 *
 * The version_independent branch demands a justification precisely so that a
 * transform which simply failed has nothing to put there. It cannot default
 * into this branch; it fails validation instead. The justification is also
 * what the tribunal's scope_accuracy criterion scores.
 */
export const ZScope = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("versioned"), versions: ZVersions }),
	z.strictObject({
		kind: z.literal("version_independent"),
		justification: z
			.string()
			.min(1)
			.describe(
				"Why this lesson holds regardless of version. Judged, not assumed.",
			),
	}),
]);
export type TScope = z.infer<typeof ZScope>;

/**
 * What retrieval matches a lesson against.
 *
 * scope is the field that makes staleness structural. Scoping a lesson to
 * vite <6 means a session on vite 8 never matches it, so the lesson retires
 * itself by construction rather than waiting for someone to review it.
 *
 * Every key of scope.versions must name an entry in stack. That is deliberately
 * NOT enforced here, for the same reason ZConsensus does not enforce
 * agreed <= judges: it is a cross-field rule, JSON Schema cannot express one,
 * and a .check() would make this package reject values the published artifact
 * accepts. The plugins that produce lessons validate against that artifact and
 * cannot import this package, so an invisible rule would fail them with no way
 * to have known. Cross-field rules belong at ingest, where both sides see the
 * same error.
 *
 * A key naming something absent from stack is a defect: depending on how
 * retrieval treats an unmatched key, the lesson either never matches or the
 * constraint is skipped, and skipping it produces a lesson that never expires.
 */
export const ZAppliesTo = z
	.strictObject({
		stack: z.array(z.string().min(1)).min(1),
		scope: ZScope,
		file_patterns: z.array(z.string().min(1)),
		task_kinds: z.array(z.string().min(1)),
	})
	.describe(
		"Every key of scope.versions must name an entry in stack. That rule " +
			"is enforced at ingest, not by this schema, because JSON Schema " +
			"cannot express a constraint spanning two fields.",
	);
export type TAppliesTo = z.infer<typeof ZAppliesTo>;
