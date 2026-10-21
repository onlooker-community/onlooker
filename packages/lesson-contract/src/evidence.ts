import { z } from "zod";
import { ZProjectKey, ZUlid } from "./primitives.js";

/**
 * The receipts behind a claim. resolution is required: a lesson that says
 * "this breaks" without "and this fixed it" is a warning, not a lesson, and
 * it gives tribunal judges nothing to check the claim against.
 *
 * session_ids may be empty. A lesson mined from a commit has no session that
 * honestly produced it - on a squash-merged repository the commit on main is
 * made by GitHub, and the session that did the work is not recorded anywhere
 * a commit can reach. Its receipts are artifact_ids, project_key and
 * observed_at. An empty string is still refused: that was the placeholder
 * ONL-82 removed, and an empty array is the honest form of the same absence.
 */
export const ZEvidence = z.strictObject({
	artifact_ids: z.array(ZUlid).min(1),
	session_ids: z.array(z.string().min(1)),
	project_key: ZProjectKey,
	observed_at: z.iso.datetime(),
	resolution: z.string().min(1),
});
export type TEvidence = z.infer<typeof ZEvidence>;
