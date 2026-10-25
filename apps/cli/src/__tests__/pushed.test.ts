import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLesson } from "../lessons";
import { lessonDigest, pushedPath, readPushed, writePushed } from "../pushed";

const FIXTURE = join(__dirname, "fixtures", "lesson.json");

function fixture() {
	const parsed = parseLesson(FIXTURE);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.lesson;
}

const dir = () => ({
	ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-pushed-")),
});

describe("the pushed record", () => {
	it("is absent before any sync", () => {
		expect(readPushed(dir())).toEqual({ kind: "none" });
	});

	it("reads back what was written", () => {
		const env = dir();
		writePushed("https://api.onlooker.dev", { a: "x" }, env);
		expect(readPushed(env)).toEqual({
			kind: "found",
			apiBaseUrl: "https://api.onlooker.dev",
			lessons: { a: "x" },
		});
	});

	// status exists to explain a broken machine, so a bad record has to come
	// back as an answer it can print, not an exception that kills it.
	it("reports a corrupt record instead of throwing", () => {
		const env = dir();
		writeFileSync(pushedPath(env), "{not json");
		expect(readPushed(env)).toMatchObject({ kind: "unreadable" });
	});

	it("reports a record of the wrong shape as unreadable", () => {
		const env = dir();
		writeFileSync(
			pushedPath(env),
			JSON.stringify({ apiBaseUrl: "u", lessons: { a: 1 } }),
		);
		expect(readPushed(env)).toMatchObject({ kind: "unreadable" });
	});

	it("leaves no temp file behind", () => {
		const env = dir();
		writePushed("u", {}, env);
		expect(() => readFileSync(`${pushedPath(env)}.tmp`)).toThrow();
	});
});

describe("lessonDigest", () => {
	it("is stable for the same lesson", () => {
		expect(lessonDigest(fixture())).toBe(lessonDigest(fixture()));
	});

	// An edited lesson is a different lesson to the pool - it answers
	// "conflict", not "noop" - so it must not read as already synced.
	it("changes when the content does", () => {
		const lesson = fixture();
		const edited = { ...lesson, claim: `${lesson.claim} (edited)` };
		expect(lessonDigest(edited)).not.toBe(lessonDigest(lesson));
	});
});
