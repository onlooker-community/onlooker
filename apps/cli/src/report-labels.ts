import type { ApiClient, LabelUpload } from "./api";
import { deleteUploaded } from "./commands/project-labels";
import { type CliConfig, readConfig } from "./config";
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
 * Directories tried per key. Each is up to three git runs, and a key seen in
 * dozens of worktrees must not stall the sync; past the newest few, an older
 * directory is unlikely to verify where they did not.
 */
const MAX_DIRS = 5;

/** The server's MAX_LABELS, in apps/api/src/routes/machine-project-labels.ts. */
const MAX_LABELS = 500;

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
		for (const dir of candidate.dirs.slice(0, MAX_DIRS)) {
			const found = resolve(dir);
			let reason: string;
			if (found.kind === "none") {
				reason = WHY[found.why];
			} else if (
				found.kind !== candidate.basis ||
				found.key !== candidate.key
			) {
				// The remote, the basis or the root moved since the session.
				reason = "key changed";
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

export interface ReportLabelsOptions {
	/**
	 * Whether this sync's session report landed. The server names a key only
	 * if this machine has reported it, so without that nothing is uploaded; a
	 * pending deletion runs either way.
	 */
	upload: boolean;
	fetchImpl?: typeof fetch;
	resolve?: (dir: string) => Resolved;
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
	options: ReportLabelsOptions,
): Promise<string | null> {
	// Everything, not just the PUT: an unreadable cli.json, a git failure
	// `resolveProject` rethrows, or a disk error inside the deletion must not
	// escape and cost the lesson push that follows this report.
	try {
		return await reportLabels(client, env, candidates, options);
	} catch (error) {
		return `Project labels not sent: ${(error as Error).message}`;
	}
}

/** On, with no deletion owed: the only state in which anything is uploaded. */
const uploading = (config: CliConfig) =>
	config.projectLabels === true && config.projectLabelsPending === undefined;

async function reportLabels(
	client: ApiClient,
	env: NodeJS.ProcessEnv,
	candidates: Candidate[],
	{ upload, fetchImpl, resolve = resolveProject }: ReportLabelsOptions,
): Promise<string | null> {
	const config = readConfig(env);
	if (config.projectLabelsPending === "delete") {
		const note = await deleteUploaded(env, fetchImpl);
		return readConfig(env).projectLabelsPending === "delete" ? note : null;
	}
	if (!upload || config.projectLabels !== true) return null;

	const plan = planLabels(candidates, resolve);
	const skipped = Object.entries(plan.skipped)
		.map(([why, n]) => `${why}: ${n}`)
		.join(", ");
	const skippedCount = Object.values(plan.skipped).reduce((a, b) => a + b, 0);
	if (plan.labels.length === 0) {
		return skippedCount === 0
			? null
			: `Project labels: none sent, ${skippedCount} skipped (${skipped})`;
	}
	// The server refuses a body over its cap whole, so the first 500 in
	// candidate order go and the rest are counted. A machine has tens of
	// projects, so this is a guard, not a queue.
	const labels = plan.labels.slice(0, MAX_LABELS);
	const heldBack = plan.labels.length - labels.length;

	// Read again: git ran for every candidate since the first read, and an
	// `off` in that time must win over the choice this sync started with.
	if (!uploading(readConfig(env))) return null;
	let answer: { stored?: unknown; skipped?: unknown };
	try {
		answer = await client.putProjectLabels(labels);
	} catch (error) {
		return `Project labels not sent: ${(error as Error).message}`;
	}
	// And once more: an `off` while the PUT was in flight may have deleted
	// before these rows landed, so they are deleted again.
	if (!uploading(readConfig(env))) {
		const deleted = await deleteUploaded(env, fetchImpl);
		return `Project labels turned off during this sync${deleted === null ? "." : `: ${deleted}`}`;
	}
	// `api.ts` casts the body rather than validating it, so a 200 of another
	// shape would otherwise print "undefined sent".
	const { stored, skipped: refused } = answer;
	if (typeof stored !== "number" || typeof refused !== "number") {
		return "Project labels not sent: unexpected response";
	}

	const total = skippedCount + refused;
	if (total === 0 && heldBack === 0) return null;
	const parts =
		refused > 0
			? [skipped, `not reported: ${refused}`].filter(Boolean).join(", ")
			: skipped;
	return [
		`Project labels: ${stored} sent`,
		...(total > 0 ? [`${total} skipped (${parts})`] : []),
		...(heldBack > 0 ? [`${heldBack} held back (${MAX_LABELS} per sync)`] : []),
	].join(", ");
}
