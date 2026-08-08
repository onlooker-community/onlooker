import { z } from "zod";
import { ZAppliesTo } from "./applies-to.js";
import { ZEvidence } from "./evidence.js";
import { ZAuthorKey, ZUlid } from "./primitives.js";

export const ZVisibility = z.enum(["private", "org", "public"]);
export type TVisibility = z.infer<typeof ZVisibility>;

/**
 * Lifecycle states. Note what is absent: there is no "expired".
 *
 * When applies_to.scope stops matching, nothing happens to the record at all.
 * Storing an expired state would require a job sweeping the pool to set it,
 * which is the review-queue failure mode this design exists to avoid.
 */
export const ZStatus = z
	.enum(["active", "refuted", "superseded", "retracted"])
	.describe(
		"Lifecycle state. There is no 'expired' state: expiry is structural " +
			"— when applies_to.scope stops matching, this field does not " +
			"change.",
	);
export type TStatus = z.infer<typeof ZStatus>;

export const ZSource = z.enum(["local", "org", "public"]);
export type TSource = z.infer<typeof ZSource>;

/**
 * The tribunal's verdict.
 *
 * agreed <= judges is deliberately NOT enforced here. Expressing it would
 * require .refine(), which z.toJSONSchema silently drops, so the rule would
 * hold server-side and be invisible in the published artifact. Cross-field
 * rules belong in ingest logic where both sides can see the same error.
 */
export const ZConsensus = z
	.strictObject({
		judges: z.number().int().min(1),
		agreed: z.number().int().min(0),
		decided_at: z.iso.datetime(),
	})
	.describe(
		"The tribunal's verdict. agreed <= judges is enforced at ingest, " +
			"not by this schema.",
	);
export type TConsensus = z.infer<typeof ZConsensus>;

export const ZLesson = z.strictObject({
	id: ZUlid,
	schema_version: z.literal(1),

	claim: z.string().min(1),
	rationale: z.string().min(1),

	evidence: ZEvidence,
	applies_to: ZAppliesTo,

	visibility: ZVisibility,
	consensus: ZConsensus,

	status: ZStatus,
	superseded_by: ZUlid.nullable().describe(
		"The id of the lesson that replaced this one.",
	),

	source: ZSource,
	author_key: ZAuthorKey,
	promoted_at: z.iso.datetime(),
});
export type TLesson = z.infer<typeof ZLesson>;
