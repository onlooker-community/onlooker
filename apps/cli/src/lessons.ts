import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type TLesson, ZLesson } from "@onlooker-community/lesson-contract";
import { onlookerDir } from "./config";

/** The server's own ceiling. A larger batch comes back 400 `batch_too_large`. */
export const MAX_BATCH = 100;

/**
 * What a look at the disk found.
 *
 * Three outcomes rather than an array, because "no lessons" has three causes
 * that deserve different sentences: the directory does not exist, the ecosystem
 * has never run here, or there is genuinely nothing approved yet. The last is
 * the expected state until the promotion step ships, so a bare empty array
 * would make the normal case indistinguishable from a broken install.
 */
export type Discovery =
	| { kind: "no-onlooker-dir"; path: string }
	| { kind: "no-librarian-dir"; path: string }
	| { kind: "found"; files: string[] };

export function discoverApproved(
	env: NodeJS.ProcessEnv = process.env,
): Discovery {
	const root = onlookerDir(env);
	if (!existsSync(root)) return { kind: "no-onlooker-dir", path: root };

	const librarian = join(root, "librarian");
	if (!existsSync(librarian)) {
		return { kind: "no-librarian-dir", path: librarian };
	}

	// librarian/<12-hex project key>/lessons/approved/*.json. An explicit path
	// rather than a recursive walk: lessons have exactly one home, and naming it
	// is what lets the three outcomes above stay distinguishable.
	//
	// `approved` only. `proposals/` holds candidates awaiting judgment, and
	// pushing one would put an unjudged claim into a pool built on consensus.
	const files: string[] = [];
	for (const project of readdirSync(librarian)) {
		const approved = join(librarian, project, "lessons", "approved");
		if (!existsSync(approved)) continue;
		for (const entry of readdirSync(approved)) {
			if (entry.endsWith(".json")) files.push(join(approved, entry));
		}
	}
	return { kind: "found", files: files.sort() };
}

export type Parsed =
	| { ok: true; lesson: TLesson }
	| { ok: false; file: string; error: string };

/**
 * Read one lesson and hold it to the same schema apps/api holds it to.
 *
 * `ZLesson` is imported rather than reimplemented, which is the argument for
 * writing this in TypeScript at all: a lesson the API would reject fails here
 * first, with the same message, and there is no second copy of the schema free
 * to drift from the first.
 */
export function parseLesson(file: string): Parsed {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { ok: false, file, error: (error as Error).message };
	}

	const result = ZLesson.safeParse(raw);
	if (!result.success) {
		const first = result.error.issues[0];
		return {
			ok: false,
			file,
			error: `${first.path.join(".") || "(root)"}: ${first.message}`,
		};
	}
	return { ok: true, lesson: result.data };
}

export function batch<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size));
	return out;
}
