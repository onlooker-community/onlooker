import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { onlookerDir } from "./config";

/**
 * ULID in Crockford base32, mirroring `ZUlid` in the lesson contract.
 *
 * Duplicated deliberately. This is the one place a filename is built from
 * server-supplied data, and a constraint enforced two packages away is not a
 * constraint this module can rely on - a future contract that loosened the id
 * would silently turn into a path here.
 */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * This machine's copy of the hosted pool.
 *
 * CLI-owned, and deliberately not inside librarian's tree. A received lesson
 * has no project key, so it has no honest home under `librarian/<key>/`; and
 * sync reads librarian's `approved/` to decide what to push, so a mirror
 * written there would feed itself straight back.
 *
 * Nothing reads this directory yet. That is known and accepted - the retrieval
 * layer that would consume it is not installed - and sync reports arrival
 * counts every run so an empty mirror reads as empty rather than as silence.
 */
export function poolDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(onlookerDir(env), "pool");
}

/** Beside the data it describes, not in `cli.json` - see `writeCursor`. */
export function cursorPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(poolDir(env), "cursor.json");
}

/**
 * The highest sequence this machine has durably written, or 0.
 *
 * A missing file is the first-run case and means "send me everything".
 * Anything else - malformed JSON, a seq that is not an integer, a permissions
 * problem - throws. Quietly falling back to 0 would re-download the pool and
 * report a corrupt file as a fresh machine, which is the same
 * successful-looking silence this codebase keeps finding.
 */
export function readCursor(env: NodeJS.ProcessEnv = process.env): number {
	const path = cursorPath(env);
	if (!existsSync(path)) return 0;

	const parsed = JSON.parse(readFileSync(path, "utf8")) as { seq?: unknown };
	if (typeof parsed.seq !== "number" || !Number.isInteger(parsed.seq)) {
		throw new Error(`${path} does not hold an integer seq`);
	}
	return parsed.seq;
}

/**
 * Record how far this machine has mirrored.
 *
 * Kept beside the lessons rather than in `cli.json`, which holds durable
 * config including the machine token: mixing fast-moving sync state into that
 * file means a corrupt write costs the token too.
 */
export function writeCursor(
	seq: number,
	env: NodeJS.ProcessEnv = process.env,
): void {
	mkdirSync(poolDir(env), { recursive: true });
	atomicWrite(cursorPath(env), `${JSON.stringify({ seq }, null, 2)}\n`);
}

export type PoolWrite = "created" | "updated" | "unchanged";

/**
 * Upsert one lesson by id.
 *
 * `unchanged` is distinguished from `updated` so sync can say how much of a
 * window was genuinely new. On a healthy machine most arrivals are unchanged:
 * the server re-sends a whole window after an interrupted run, and that is
 * supposed to be cheap and boring rather than look like activity.
 */
export function writeLesson(
	lesson: TLesson,
	env: NodeJS.ProcessEnv = process.env,
): PoolWrite {
	if (!ULID.test(lesson.id)) {
		throw new Error(
			`refusing to write a lesson whose id is not a ULID: ${lesson.id}`,
		);
	}

	const dir = poolDir(env);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${lesson.id}.json`);
	const next = `${JSON.stringify(lesson, null, 2)}\n`;

	if (existsSync(path)) {
		if (readFileSync(path, "utf8") === next) return "unchanged";
		atomicWrite(path, next);
		return "updated";
	}

	atomicWrite(path, next);
	return "created";
}

/**
 * Write through a temp file and rename.
 *
 * A half-written lesson is invalid JSON, and a half-written cursor is worse -
 * it is a number nobody can trust, which is the one thing this design cannot
 * afford. Rename is atomic within a directory, so a reader sees either the old
 * content or the new one and never a partial write.
 */
function atomicWrite(path: string, contents: string): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, contents);
	renameSync(tmp, path);
}
