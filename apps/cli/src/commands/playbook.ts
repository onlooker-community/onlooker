import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ZLesson } from "@onlooker-community/lesson-contract";
import { judge, type Verdict } from "../playbook";
import { migrateLegacyPool, mirrorDir } from "../pool";
import { resolveStack } from "../stack";
import { changedFiles } from "../worktree";

interface Entry {
	id: string;
	claim: string;
	verdict: Verdict;
}

/**
 * Which mirrored lessons apply to this project, and which are about what you
 * are changing right now.
 *
 * A playbook is a saved-query view over a pool - the lesson contract's own
 * definition - and this is that query, supplied as the built-in default view.
 * It is the first thing to read the mirror at all; until now `sync` wrote
 * lessons to disk that nothing ever opened.
 */
export async function playbook(opts: {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	json?: boolean;
}): Promise<string> {
	const env = opts.env ?? process.env;
	const cwd = opts.cwd ?? process.cwd();

	// First, so a machine that pulled before the rename is not quietly reading
	// an empty new directory beside its populated old one.
	const migration = migrateLegacyPool(env);

	const dir = mirrorDir(env);
	let files: string[];
	try {
		files = readdirSync(dir).filter(
			(f) => f.endsWith(".json") && f !== "cursor.json",
		);
	} catch {
		files = [];
	}

	const { installed } = resolveStack(cwd);
	const changed = changedFiles(cwd);

	const entries: Entry[] = [];
	const invalid: string[] = [];

	for (const file of files) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
		} catch (error) {
			invalid.push(`${file}: ${(error as Error).message}`);
			continue;
		}

		const parsed = ZLesson.safeParse(raw);
		if (!parsed.success) {
			// Reported, never skipped. This command is the only place a person
			// would ever see a mirrored record the contract refuses.
			const issue = parsed.error.issues[0];
			invalid.push(
				`${file}: ${issue?.path.join(".") || "(root)"}: ${
					issue?.message ?? "did not match the lesson contract"
				}`,
			);
			continue;
		}

		entries.push({
			id: parsed.data.id,
			claim: parsed.data.claim,
			verdict: judge(parsed.data, { installed, changedFiles: changed }),
		});
	}

	const applying = entries.filter((e) => e.verdict.kind === "applies");
	const changedGroup = applying.filter(
		(e) => e.verdict.kind === "applies" && e.verdict.changed,
	);
	const appliesGroup = applying.filter(
		(e) => e.verdict.kind === "applies" && !e.verdict.changed,
	);
	const cannotTell = entries.filter((e) => e.verdict.kind === "cannot-tell");
	const excluded = entries.filter((e) => e.verdict.kind === "excluded");

	if (opts.json) {
		return JSON.stringify(
			{
				migration,
				changed: changedGroup.map(describe),
				applies: appliesGroup.map(describe),
				cannotTell: cannotTell.map(describe),
				excluded: excluded.map(describe),
				invalid,
			},
			null,
			2,
		);
	}

	const lines: string[] = [];
	if (migration !== null) lines.push(migration);

	// An empty mirror and "nothing applies" are different facts. Saying the
	// second when the first is true tells someone their pool is irrelevant
	// when it is merely absent.
	if (entries.length === 0 && invalid.length === 0) {
		lines.push(
			`Nothing has been mirrored yet: ${dir} holds no lessons. Run \`onlooker sync\` to receive some.`,
		);
		return lines.join("\n");
	}

	section(lines, "About what you are changing", changedGroup);
	section(lines, "Applies to this project", appliesGroup);
	section(lines, "Cannot tell", cannotTell);
	section(lines, "Excluded", excluded);

	if (invalid.length > 0) {
		lines.push(
			"",
			`${invalid.length} mirrored file(s) the contract refuses:`,
			...invalid.map((line) => `  ${line}`),
		);
	}

	return lines.join("\n").trimStart();
}

function describe(entry: Entry) {
	return {
		id: entry.id,
		claim: entry.claim,
		verdict: entry.verdict.kind,
		reason: reasonOf(entry.verdict),
		changed: entry.verdict.kind === "applies" && entry.verdict.changed,
	};
}

/**
 * Every verdict carries one. A verdict without its reason is a claim rather
 * than a finding - nobody can check it, and checking it is the point.
 */
function reasonOf(verdict: Verdict): string {
	if (verdict.kind === "applies") {
		return verdict.matchedPatterns.length > 0
			? `matches ${verdict.matchedPatterns.join(", ")} in your working tree`
			: "stack and version constraints are satisfied";
	}
	return verdict.reason;
}

function section(lines: string[], heading: string, entries: Entry[]): void {
	if (entries.length === 0) return;
	lines.push("", `${heading} (${entries.length}):`);
	for (const entry of entries) {
		lines.push(`  ${entry.id}  ${entry.claim}`);
		lines.push(`    ${reasonOf(entry.verdict)}`);
	}
}
