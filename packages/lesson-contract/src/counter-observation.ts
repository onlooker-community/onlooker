import { z } from "zod";
import { ZUlid } from "./primitives.js";

/**
 * A consumer's report that a lesson did not hold in a context where it
 * matched.
 *
 * There is intentionally no verdict field. A single failure is weak evidence:
 * the lesson may have been applied incorrectly, the context may differ
 * subtly, the failure may be unrelated. Counter-observations accumulate and
 * trigger tribunal re-judgment; the tribunal sets the lesson's status.
 * Letting reporters set it directly would also make refutation a trivial
 * denial-of-service vector.
 */
export const ZCounterObservation = z.strictObject({
	id: ZUlid,
	schema_version: z.literal(1),
	lesson_id: ZUlid,
	observed_at: z.iso.datetime(),
	artifact_ids: z.array(ZUlid).min(1),
	session_id: z.string().min(1),
	summary: z.string().min(1),
	author_key: z.string().min(1),
});
export type TCounterObservation = z.infer<typeof ZCounterObservation>;
