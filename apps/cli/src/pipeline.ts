import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { onlookerDir } from "./config";

/**
 * What each stage of the lesson pipeline is holding.
 *
 * `sync` used to answer "no approved lessons yet" for four different
 * situations that call for four different responses: nothing has ever
 * proposed a lesson, proposals are waiting on a human, they are waiting on
 * the jury, or they were judged and never promoted. The counts here are what
 * lets one sentence say which.
 *
 * The stage a proposal sits at is a `status` field INSIDE each file, not a
 * directory - `lessons/proposals/` holds every state from `pending` through
 * `rejected`. So this is a read of each file, not a directory listing.
 */
export interface PipelineSurvey {
	/** Project keys with a `lessons/` directory at all. */
	lessonDirs: number;
	/** `pending` - librarian proposed it, no human has reviewed it. */
	pendingReview: number;
	/** `confirmed` - a human confirmed it, the jury has not judged it. */
	awaitingJury: number;
	/** `approved` or `rejected`, with no `promoted_at`. */
	awaitingPromotion: number;
	/** `passed` - a human declined to put it forward. Terminal. */
	passed: number;
	/** Non-empty lines in `declined.jsonl`. Terminal. */
	declined: number;
	/** Status values this CLI does not know, by name and count. */
	unrecognized: Record<string, number>;
	/**
	 * Things this walk could not read: a file that would not parse or carried
	 * no usable status, plus a directory that could not be listed at all. A
	 * directory counts once here no matter how many files it might hold - this
	 * is a "something here is wrong" flag, not a file count.
	 */
	unreadable: number;
}

/**
 * Count what sits at each stage, across every project key.
 *
 * Never throws. This feeds `status`, which is the command someone runs
 * *because* something is wrong - a diagnostic that dies on the state it
 * exists to report is useless at the only moment it matters. Every failure
 * mode below becomes a count instead.
 */
export function surveyPipeline(
	env: NodeJS.ProcessEnv = process.env,
): PipelineSurvey {
	const survey: PipelineSurvey = {
		lessonDirs: 0,
		pendingReview: 0,
		awaitingJury: 0,
		awaitingPromotion: 0,
		passed: 0,
		declined: 0,
		unrecognized: {},
		unreadable: 0,
	};

	const librarian = join(onlookerDir(env), "librarian");
	if (!existsSync(librarian)) return survey;

	let projects: string[];
	try {
		projects = readdirSync(librarian);
	} catch {
		// `existsSync` only proves the path exists at that instant - it can
		// still be a file rather than a directory, be unreadable, or vanish
		// before this call runs. That is itself something worth reporting,
		// not something to swallow and report as "no librarian directory".
		survey.unreadable++;
		return survey;
	}

	for (const project of projects) {
		// `<key>/lessons/`, never `<key>/proposals/`. The latter is librarian's
		// MEMORY proposal queue, held apart from lessons on purpose - see
		// librarian-lesson-storage.sh:8. Counting it here would report memory
		// candidates as lesson candidates.
		const lessons = join(librarian, project, "lessons");
		if (!existsSync(lessons)) continue;
		survey.lessonDirs++;
		countProposals(join(lessons, "proposals"), survey);
		countDeclined(join(lessons, "declined.jsonl"), survey);
	}

	return survey;
}

function countProposals(dir: string, survey: PipelineSurvey): void {
	if (!existsSync(dir)) return;

	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		// Same TOCTOU/permission/not-a-directory gap as the librarian listing
		// above: `existsSync` cannot guarantee the path is still a listable
		// directory by the time we get here. Count it as unreadable rather
		// than skip silently, so this project key's stall shows up instead of
		// vanishing from the totals - and keep going, so one bad key does not
		// cost every other key its count.
		survey.unreadable++;
		return;
	}

	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(join(dir, entry), "utf8"));
		} catch {
			// Counted, not skipped. A file that will not parse is itself a
			// finding, and dropping it would let the totals below claim to
			// describe files nobody could read.
			survey.unreadable++;
			continue;
		}

		const proposal = parsed as Record<string, unknown> | null;
		if (typeof proposal !== "object" || proposal === null) {
			survey.unreadable++;
			continue;
		}

		// A promoted proposal keeps its file here forever: proposals/ is the
		// sole dedup source for an approved lesson, so librarian never prunes
		// it (librarian-lesson-storage.sh:184). Its outcome is already counted
		// downstream, in approved/ or in declined.jsonl. Counting it again
		// would report finished work as stuck, and would grow without bound.
		//
		// Loose equality is deliberate: this field is written by jq in a repo
		// this CLI cannot import, so both "absent" and "written as null" have
		// to mean "not promoted." Tightening this to `!== undefined` would
		// drop every proposal into no bucket at all the day that repo starts
		// writing `promoted_at: null` at creation time.
		if (proposal.promoted_at != null) continue;

		const status = proposal.status;
		if (typeof status !== "string" || status === "") {
			survey.unreadable++;
			continue;
		}

		switch (status) {
			case "pending":
				survey.pendingReview++;
				break;
			case "confirmed":
				survey.awaitingJury++;
				break;
			case "approved":
			case "rejected":
				survey.awaitingPromotion++;
				break;
			case "passed":
				survey.passed++;
				break;
			default:
				// Named, not dropped. This vocabulary is owned by another repo
				// and can grow without telling us. Silently ignoring an
				// unfamiliar status would under-report a real stall and print a
				// confident total - which is the exact defect this module
				// exists to fix, reintroduced one layer down.
				survey.unrecognized[status] = (survey.unrecognized[status] ?? 0) + 1;
		}
	}
}

/**
 * Non-empty lines, rather than parsed entries.
 *
 * `declined.jsonl` is append-only and librarian never re-reads it, so a torn
 * final write must not be able to break a count - and the count does not
 * depend on what shape the entries have.
 */
function countDeclined(path: string, survey: PipelineSurvey): void {
	if (!existsSync(path)) return;
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// Same contract as the two readdirSync guards above: `existsSync`
		// proves the path exists, not that reading it will succeed. A
		// directory named `declined.jsonl`, or a permissions error, has to
		// become a fault - silently reporting 0 declined would print a
		// confident, wrong sentence about a machine whose declined log this
		// walk could not even open.
		survey.unreadable++;
		return;
	}
	survey.declined += raw
		.split("\n")
		.filter((line) => line.trim() !== "").length;
}

/**
 * The three stages a proposal can be stuck at, in pipeline order.
 *
 * Two phrasings from one table, because the same fact reads differently in
 * the two places it appears: `sync` runs them into a sentence where commas
 * are already separating stages, so it needs "confirmed and awaiting a jury";
 * `status` puts each on its own line, where the comma is the clearer break.
 * Keeping both here is what stops the two commands describing the same disk
 * state in different words.
 */
const STAGES = [
	{ key: "pendingReview", inline: "pending review", block: "pending review" },
	{
		key: "awaitingJury",
		inline: "confirmed and awaiting a jury",
		block: "confirmed, awaiting a jury",
	},
	{
		key: "awaitingPromotion",
		inline: "judged and awaiting promotion",
		block: "judged, awaiting promotion",
	},
] as const;

/** Anything at all, at any stage, including the two fault counts. */
function holdsSomething(survey: PipelineSurvey): boolean {
	return (
		STAGES.some((stage) => survey[stage.key] > 0) ||
		survey.passed > 0 ||
		survey.declined > 0 ||
		survey.unreadable > 0 ||
		Object.keys(survey.unrecognized).length > 0
	);
}

/**
 * The faults, phrased the same way in both renderers. Empty when clean, so
 * both callers can append it unconditionally.
 */
function faults(survey: PipelineSurvey): string[] {
	const out: string[] = [];
	if (survey.unreadable > 0) {
		out.push(`${survey.unreadable} that could not be read`);
	}
	// Sorted by name, not by `readdirSync` order: the filesystem's listing
	// order is not deterministic across platforms, and a diagnostic whose
	// output reshuffles between runs on the same disk state is not one
	// anyone can diff or paste into a bug report with confidence.
	const unrecognized = Object.entries(survey.unrecognized).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	for (const [status, count] of unrecognized) {
		out.push(`${count} with an unrecognized status (${status})`);
	}
	return out;
}

/**
 * Everything after "Nothing to sync: " in `sync`'s empty-pool message.
 *
 * All three stall stages are named even at zero. A zero is information here:
 * "2 confirmed and awaiting a jury, 0 pending review" says the stall is not
 * being fed, which is the difference between a backlog and a blockage. It
 * also means there is no rule about which counts appear, and one output to
 * test.
 */
export function pipelineClause(survey: PipelineSurvey): string {
	if (survey.lessonDirs === 0) {
		// A fault outranks the "never ran" reading. `lessonDirs` is also 0 when
		// the walk could not list a directory at all, and reporting that as
		// "the pipeline never ran" would be the same confident-but-wrong
		// sentence this module exists to remove.
		const unread = faults(survey);
		if (unread.length > 0) {
			return `no approved lessons yet, and the pipeline could not be read - ${unread.join(", ")}.`;
		}
		return "no approved lessons yet - librarian has run here, but its lesson pipeline never has. Check that archivist and librarian are enabled.";
	}
	if (!holdsSomething(survey)) {
		return "no approved lessons yet, and nothing at any earlier stage either - librarian has run here but has proposed no lessons. Check that archivist and librarian are enabled.";
	}

	const parts = STAGES.map(
		(stage) => `${survey[stage.key]} ${stage.inline}`,
	).concat(faults(survey));
	return `no approved lessons yet - ${parts.join(", ")}.`;
}

/** The value lines of `status`'s `Pipeline:` block, unlabeled and unpadded. */
export function pipelineLines(survey: PipelineSurvey): string[] {
	if (survey.lessonDirs === 0) {
		// Same precedence as the clause: a directory we could not list is not
		// a pipeline that never ran.
		const unread = faults(survey);
		return unread.length > 0 ? unread : ["no lesson pipeline has run here"];
	}

	const lines = STAGES.map((stage) => `${survey[stage.key]} ${stage.block}`);
	// `declined` always: a jury refusing everything it sees is precisely what
	// someone runs `status` to find out. `passed` only when non-zero - it is a
	// human's decision not to put something forward, not a stall.
	lines.push(`${survey.declined} declined`);
	if (survey.passed > 0) lines.push(`${survey.passed} passed over`);
	return lines.concat(faults(survey));
}
