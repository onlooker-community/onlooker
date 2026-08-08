import { z } from "zod";
import { VERSION_RANGE } from "./primitives.js";

/**
 * What retrieval matches a lesson against.
 *
 * versions is the field that makes staleness structural. Scoping a lesson to
 * vite <6 means a session on vite 8 never matches it, so the lesson retires
 * itself by construction rather than waiting for someone to review it.
 *
 * An empty versions map is allowed: some lessons genuinely do not depend on
 * a version. Such a lesson never expires on its own and can only leave the
 * pool through refutation or supersession.
 */
export const ZAppliesTo = z.strictObject({
	stack: z.array(z.string().min(1)).min(1),
	versions: z
		.record(z.string().min(1), z.string().regex(VERSION_RANGE))
		.describe(
			"Comparator-prefixed version ranges keyed by stack entry, for " +
				'example {"vite": "<6"}. A two-sided range reads lower bound ' +
				"then upper bound. Multiple entries combine with AND: every " +
				"entry must match for the lesson to still apply.",
		),
	file_patterns: z.array(z.string().min(1)),
	task_kinds: z.array(z.string().min(1)),
});
export type TAppliesTo = z.infer<typeof ZAppliesTo>;
