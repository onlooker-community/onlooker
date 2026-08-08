import { z } from "zod";
import { ZProjectKey, ZUlid } from "./primitives.js";

/**
 * The receipts behind a claim. resolution is required: a lesson that says
 * "this breaks" without "and this fixed it" is a warning, not a lesson, and
 * it gives tribunal judges nothing to check the claim against.
 */
export const ZEvidence = z.strictObject({
	artifact_ids: z.array(ZUlid).min(1),
	session_ids: z.array(z.string().min(1)).min(1),
	project_key: ZProjectKey,
	observed_at: z.iso.datetime(),
	resolution: z.string().min(1),
});
export type TEvidence = z.infer<typeof ZEvidence>;
