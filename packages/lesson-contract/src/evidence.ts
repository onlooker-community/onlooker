import { z } from "zod";
import { ZProjectKey, ZUlid } from "./primitives.js";

/**
 * One stack entry's version, as observed rather than claimed.
 *
 * source says where it was read: a lockfile, a manifest's declared range, a
 * mise pin, a CI workflow's action pin, a component's own plugin.json or
 * package.json, or a probe of the machine. basis says when: at the commit
 * the session ran on, at HEAD because no earlier commit existed, or on the
 * machine when the transform ran. A probe is always "machine", which is why
 * the jury is shown it.
 *
 * flavor is for the tools whose BSD and GNU builds disagree (awk, grep,
 * sed). A version number alone doesn't say which one a lesson was seen on.
 */
export const ZObservation = z.strictObject({
	version: z.string().min(1),
	source: z.enum([
		"lockfile",
		"manifest",
		"mise",
		"workflow",
		"component",
		"probe",
	]),
	basis: z.enum(["session_commit", "head", "machine"]),
	flavor: z.enum(["gnu", "bsd"]).optional(),
});
export type TObservation = z.infer<typeof ZObservation>;

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
	observed_on: z
		.record(z.string().min(1), ZObservation)
		.optional()
		.describe("Keyed by stack entry. Every key must be in applies_to.stack."),
	unresolved: z
		.array(z.string().min(1))
		.optional()
		.describe(
			"Stack entries no source could version. An entry that was observed " +
				"but whose version yields no range belongs in observed_on, not here.",
		),
});
export type TEvidence = z.infer<typeof ZEvidence>;
