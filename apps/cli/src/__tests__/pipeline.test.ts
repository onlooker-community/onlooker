import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { surveyPipeline } from "../pipeline";

/** A temp `$ONLOOKER_DIR` with nothing in it. */
function emptyDir(): NodeJS.ProcessEnv {
	return { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-pipe-")) };
}

/** Write one proposal under `librarian/<key>/lessons/proposals/<id>.json`. */
function proposal(
	env: NodeJS.ProcessEnv,
	key: string,
	id: string,
	body: unknown,
): void {
	const dir = join(
		env.ONLOOKER_DIR as string,
		"librarian",
		key,
		"lessons",
		"proposals",
	);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${id}.json`),
		typeof body === "string" ? body : JSON.stringify(body),
	);
}

describe("surveyPipeline", () => {
	it("counts nothing when no librarian directory exists", () => {
		const survey = surveyPipeline(emptyDir());
		expect(survey.lessonDirs).toBe(0);
		expect(survey.pendingReview).toBe(0);
		expect(survey.declined).toBe(0);
		expect(survey.unrecognized).toEqual({});
	});

	it("sorts each status into its own bucket", () => {
		const env = emptyDir();
		proposal(env, "aaaaaaaaaaaa", "p1", { status: "pending" });
		proposal(env, "aaaaaaaaaaaa", "p2", { status: "confirmed" });
		proposal(env, "aaaaaaaaaaaa", "p3", { status: "approved" });
		proposal(env, "aaaaaaaaaaaa", "p4", { status: "rejected" });
		proposal(env, "aaaaaaaaaaaa", "p5", { status: "passed" });

		const survey = surveyPipeline(env);
		expect(survey.lessonDirs).toBe(1);
		expect(survey.pendingReview).toBe(1);
		expect(survey.awaitingJury).toBe(1);
		// `approved` and `rejected` are both judged-but-not-yet-promoted, and
		// both are unstuck by the same command, so they share one bucket.
		expect(survey.awaitingPromotion).toBe(2);
		expect(survey.passed).toBe(1);
	});

	// proposals/ is the sole dedup source for an approved lesson, so librarian
	// never prunes a promoted proposal. Its outcome is already counted in
	// approved/ or declined.jsonl - counting it here too would report finished
	// work as stuck, forever.
	it("excludes a proposal that has already been promoted", () => {
		const env = emptyDir();
		proposal(env, "aaaaaaaaaaaa", "p1", {
			status: "approved",
			promoted_at: "2026-08-14T00:00:00Z",
		});
		proposal(env, "aaaaaaaaaaaa", "p2", { status: "approved" });

		expect(surveyPipeline(env).awaitingPromotion).toBe(1);
	});

	it("aggregates across project keys", () => {
		const env = emptyDir();
		proposal(env, "aaaaaaaaaaaa", "p1", { status: "pending" });
		proposal(env, "bbbbbbbbbbbb", "p2", { status: "pending" });
		proposal(env, "cccccccccccc", "p3", { status: "confirmed" });

		const survey = surveyPipeline(env);
		expect(survey.lessonDirs).toBe(3);
		expect(survey.pendingReview).toBe(2);
		expect(survey.awaitingJury).toBe(1);
	});

	it("skips a project key with no lessons directory", () => {
		const env = emptyDir();
		// The shape 15 of 16 real project keys have: librarian's memory queue
		// and no lesson pipeline state at all.
		mkdirSync(
			join(
				env.ONLOOKER_DIR as string,
				"librarian",
				"aaaaaaaaaaaa",
				"proposals",
			),
			{ recursive: true },
		);

		const survey = surveyPipeline(env);
		expect(survey.lessonDirs).toBe(0);
		expect(survey.pendingReview).toBe(0);
	});

	it("counts a malformed proposal instead of throwing", () => {
		const env = emptyDir();
		proposal(env, "aaaaaaaaaaaa", "p1", "{ not json");
		proposal(env, "aaaaaaaaaaaa", "p2", { status: "pending" });

		const survey = surveyPipeline(env);
		expect(survey.unreadable).toBe(1);
		expect(survey.pendingReview).toBe(1);
	});

	it("counts a proposal with no status as unreadable", () => {
		const env = emptyDir();
		proposal(env, "aaaaaaaaaaaa", "p1", { candidate: {} });

		expect(surveyPipeline(env).unreadable).toBe(1);
	});

	// The vocabulary belongs to another repo and can grow. A status we do not
	// know must show up by name, so drift is visible rather than silently
	// subtracted from the totals.
	it("buckets an unrecognized status under its own name", () => {
		const env = emptyDir();
		proposal(env, "aaaaaaaaaaaa", "p1", { status: "quarantined" });
		proposal(env, "aaaaaaaaaaaa", "p2", { status: "quarantined" });

		const survey = surveyPipeline(env);
		expect(survey.unrecognized).toEqual({ quarantined: 2 });
		expect(survey.unreadable).toBe(0);
	});

	it("counts declined entries by line, with or without a trailing newline", () => {
		const env = emptyDir();
		const dir = join(
			env.ONLOOKER_DIR as string,
			"librarian",
			"aaaaaaaaaaaa",
			"lessons",
		);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "declined.jsonl"),
			'{"id":"a"}\n{"id":"b"}\n\n{"id":"c"}',
		);

		expect(surveyPipeline(env).declined).toBe(3);
	});

	// `existsSync` only proves the path exists at that instant - it does not
	// prove `readdirSync` can list it. A file where a directory was expected
	// must not throw past the diagnostic that exists to survive a broken
	// machine.
	it("counts librarian as unreadable instead of throwing when it is a file", () => {
		const env = emptyDir();
		writeFileSync(join(env.ONLOOKER_DIR as string, "librarian"), "");

		const survey = surveyPipeline(env);
		expect(survey.unreadable).toBe(1);
	});

	it("counts one key's unlistable proposals dir without losing its siblings", () => {
		const env = emptyDir();
		mkdirSync(
			join(env.ONLOOKER_DIR as string, "librarian", "aaaaaaaaaaaa", "lessons"),
			{
				recursive: true,
			},
		);
		writeFileSync(
			join(
				env.ONLOOKER_DIR as string,
				"librarian",
				"aaaaaaaaaaaa",
				"lessons",
				"proposals",
			),
			"",
		);
		proposal(env, "bbbbbbbbbbbb", "p1", { status: "pending" });

		const survey = surveyPipeline(env);
		expect(survey.unreadable).toBe(1);
		expect(survey.pendingReview).toBe(1);
	});
});
