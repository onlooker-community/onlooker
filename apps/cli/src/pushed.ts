import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { onlookerDir } from "./config";
import { atomicWrite } from "./pool";

/**
 * Which approved lessons the pool confirmed it holds, as of the last sync.
 *
 * `sync` sends every approved lesson every run and lets the API dedupe, so
 * without this nothing on the machine can tell sent from unsent - and
 * `status` called a lesson the pool already held "ready to sync" forever
 * (ONL-202).
 *
 * It decides nothing about what gets sent. `sync` still pushes everything, so
 * the worst a stale record can do is make `status` describe the pool wrong
 * until the next sync rewrites it. That is the accepted limit: a lesson the
 * pool drops reads as synced here until then.
 *
 * Keyed by API URL because "in the pool" means a particular pool: a machine
 * pointed at staging has synced nothing to production.
 */
export function pushedPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(onlookerDir(env), "pushed.json");
}

export type Pushed =
	| { kind: "none" }
	| { kind: "unreadable"; path: string; error: string }
	| { kind: "found"; apiBaseUrl: string; lessons: Record<string, string> };

/**
 * A fingerprint of a lesson's content.
 *
 * Over the parsed lesson rather than the file bytes, so it describes what
 * `sync` sent. An edited lesson gets a new digest, which is right: the pool
 * answers "conflict" for it, not "noop", so it is not synced.
 */
export function lessonDigest(lesson: TLesson): string {
	return createHash("sha256").update(JSON.stringify(lesson)).digest("hex");
}

/**
 * The record, or why there is none.
 *
 * Never throws. `status` reads this, and `status` exists to explain a broken
 * machine, so a corrupt record has to come back as something it can say.
 */
export function readPushed(env: NodeJS.ProcessEnv = process.env): Pushed {
	const path = pushedPath(env);
	if (!existsSync(path)) return { kind: "none" };

	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as {
			apiBaseUrl?: unknown;
			lessons?: unknown;
		};
		const lessons = parsed.lessons;
		if (
			typeof parsed.apiBaseUrl !== "string" ||
			typeof lessons !== "object" ||
			lessons === null ||
			!Object.values(lessons).every((digest) => typeof digest === "string")
		) {
			return {
				kind: "unreadable",
				path,
				error: "not an apiBaseUrl with a lessons map",
			};
		}
		return {
			kind: "found",
			apiBaseUrl: parsed.apiBaseUrl,
			lessons: lessons as Record<string, string>,
		};
	} catch (error) {
		return { kind: "unreadable", path, error: (error as Error).message };
	}
}

/**
 * Replace the record with what this sync confirmed.
 *
 * Replaced rather than merged: every sync sends every approved lesson, so
 * this run's answers are the whole truth, and a merge would only keep stale
 * entries alive.
 */
export function writePushed(
	apiBaseUrl: string,
	lessons: Record<string, string>,
	env: NodeJS.ProcessEnv = process.env,
): void {
	mkdirSync(onlookerDir(env), { recursive: true });
	atomicWrite(
		pushedPath(env),
		`${JSON.stringify({ apiBaseUrl, lessons }, null, 2)}\n`,
	);
}
