import type { ApiClient, LabelUpload } from "./api";
import { deleteUploaded } from "./commands/project-labels";
import { readConfig } from "./config";
import type { Candidate } from "./label-candidates";
import { type Resolved, resolveProject } from "./project-key";
import { remoteLabel, rootLabel } from "./project-label";

export interface LabelPlan {
	labels: LabelUpload[];
	/** Keys not named, by why. */
	skipped: Record<string, number>;
}

const WHY: Record<Extract<Resolved, { kind: "none" }>["why"], string> = {
	missing: "directory gone",
	"not-a-repo": "not a repo",
	"no-git": "git not found",
};

/**
 * Name each candidate whose directory still resolves to the key the session
 * reported (ONL-197, problems 2 and 4). The newest directory is tried first;
 * a key is skipped, once, only when none of its directories verify, and
 * counted under the newest directory's reason.
 */
export function planLabels(
	candidates: Candidate[],
	resolve: (dir: string) => Resolved = resolveProject,
): LabelPlan {
	const plan: LabelPlan = { labels: [], skipped: {} };
	for (const candidate of candidates) {
		let why: string | null = null;
		let label: string | null = null;
		for (const dir of candidate.dirs) {
			const found = resolve(dir);
			let reason: string;
			if (found.kind === "none") {
				reason = WHY[found.why];
			} else if (
				found.kind !== candidate.basis ||
				found.key !== candidate.key
			) {
				reason = "remote changed";
			} else {
				label =
					found.kind === "remote"
						? remoteLabel(found.url)
						: rootLabel(found.root);
				if (label !== null) break;
				reason = "no name";
			}
			why ??= reason;
		}
		if (label !== null) {
			plan.labels.push({
				project_key: candidate.key,
				basis: candidate.basis,
				label,
			});
		} else if (why !== null) {
			plan.skipped[why] = (plan.skipped[why] ?? 0) + 1;
		}
	}
	return plan;
}

/**
 * Upload this machine's labels, or finish an opt-out, describing the outcome
 * rather than throwing. Non-fatal and never silent, like the other reports;
 * nothing is said when every candidate was named.
 */
export async function reportProjectLabels(
	client: ApiClient,
	env: NodeJS.ProcessEnv,
	candidates: Candidate[],
	fetchImpl?: typeof fetch,
): Promise<string | null> {
	const config = readConfig(env);
	if (config.projectLabelsPending === "delete") {
		const note = await deleteUploaded(env, fetchImpl);
		return readConfig(env).projectLabelsPending === "delete" ? note : null;
	}
	if (config.projectLabels !== true) return null;

	const plan = planLabels(candidates);
	const skipped = Object.entries(plan.skipped)
		.map(([why, n]) => `${why}: ${n}`)
		.join(", ");
	const skippedCount = Object.values(plan.skipped).reduce((a, b) => a + b, 0);
	if (plan.labels.length === 0) {
		return skippedCount === 0
			? null
			: `Project labels: none sent, ${skippedCount} skipped (${skipped})`;
	}
	try {
		const { stored, skipped: refused } = await client.putProjectLabels(
			plan.labels,
		);
		const total = skippedCount + refused;
		if (total === 0) return null;
		const parts =
			refused > 0
				? [skipped, `not reported: ${refused}`].filter(Boolean).join(", ")
				: skipped;
		return `Project labels: ${stored} sent, ${total} skipped (${parts})`;
	} catch (error) {
		return `Project labels not sent: ${(error as Error).message}`;
	}
}
