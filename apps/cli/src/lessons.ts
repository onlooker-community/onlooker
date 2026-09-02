import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type TLesson, ZLesson } from "@onlooker-community/lesson-contract";
import { onlookerDir } from "./config";

/** The server's own ceiling. A larger batch comes back 400 `batch_too_large`. */
export const MAX_BATCH = 100;

/**
 * What a look at the disk found.
 *
 * Four outcomes rather than an array, because "no lessons" has four causes that
 * deserve different sentences: the directory does not exist, the ecosystem has
 * never run here, the directory is there and could not be read, or there is
 * genuinely nothing approved yet. The last is the expected state until the
 * promotion step ships, so a bare empty array would make the normal case
 * indistinguishable from a broken install.
 *
 * `unreadable` is a separate outcome rather than an empty `found` because the
 * two claim different things. An empty `found` asserts there are no approved
 * lessons; a path we could not open supports no such claim, and there could be
 * a thousand behind it.
 */
export type Discovery =
	| { kind: "no-onlooker-dir"; path: string }
	| { kind: "no-librarian-dir"; path: string }
	| { kind: "unreadable"; path: string }
	/** `unreadable` names project keys skipped because listing them failed. */
	| { kind: "found"; files: string[]; unreadable: string[] };

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
	// `existsSync` is not enough to make `readdirSync` safe: a path that exists
	// but cannot be listed - a file where a directory belongs (ENOTDIR), a
	// directory without read permission (EACCES) - throws. Both commands call
	// this before anything else, so an unguarded throw here takes out `status`,
	// which is the command someone runs *because* the machine is broken.
	let projects: string[];
	try {
		projects = readdirSync(librarian);
	} catch {
		return { kind: "unreadable", path: librarian };
	}

	const files: string[] = [];
	const unreadable: string[] = [];
	for (const project of projects) {
		const approved = join(librarian, project, "lessons", "approved");
		if (!existsSync(approved)) continue;
		let entries: string[];
		try {
			entries = readdirSync(approved);
		} catch {
			// Named, not skipped, and scoped to this key: one unlistable project
			// must not cost the others their lessons, but it must not vanish
			// either - the count would then be quietly short.
			unreadable.push(approved);
			continue;
		}
		for (const entry of entries) {
			if (entry.endsWith(".json")) files.push(join(approved, entry));
		}
	}
	return { kind: "found", files: files.sort(), unreadable: unreadable.sort() };
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
