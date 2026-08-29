import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sync } from "../commands/sync";
import { writeConfig } from "../config";

const FIXTURE = join(__dirname, "fixtures", "lesson.json");

function linked(): NodeJS.ProcessEnv {
	const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-sync-")) };
	writeConfig(
		{ apiBaseUrl: "https://api.onlooker.dev", machineToken: "tok" },
		env,
	);
	return env;
}

function withLessons(env: NodeJS.ProcessEnv, count: number): void {
	const dir = join(
		env.ONLOOKER_DIR as string,
		"librarian",
		"4c1de90ab372",
		"lessons",
		"approved",
	);
	mkdirSync(dir, { recursive: true });
	for (let i = 0; i < count; i++)
		cpSync(FIXTURE, join(dir, `lesson-${i}.json`));
}

const accepts = () =>
	vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		json: async () => ({ results: [] }),
	});

/** A 200 whose body carries the given per-lesson outcomes. */
const pushes = (
	results: Array<{ id: string; outcome: string; error?: string }>,
) =>
	vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		json: async () => ({ results }),
	});

describe("sync", () => {
	it("refuses to run before the machine is linked", async () => {
		const env = {
			ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-unlinked-")),
		};
		await expect(sync({ env, fetchImpl: accepts() })).rejects.toThrow(
			/onlooker link/,
		);
	});

	// The common path until the ecosystem's promotion step ships. Exiting
	// successfully with a clear sentence is the correct behavior, not an edge
	// case - and it must not look like a failure.
	it("succeeds with nothing to do when no lesson is approved", async () => {
		const env = linked();
		mkdirSync(join(env.ONLOOKER_DIR as string, "librarian"), {
			recursive: true,
		});
		const fetchImpl = accepts();
		const message = await sync({ env, fetchImpl });
		expect(message).toMatch(/nothing to sync/i);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("says where it looked when the ecosystem has never run here", async () => {
		const message = await sync({ env: linked(), fetchImpl: accepts() });
		expect(message).toMatch(/librarian/);
	});

	it("pushes what it finds", async () => {
		const env = linked();
		withLessons(env, 2);
		const fetchImpl = accepts();
		await sync({ env, fetchImpl });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body).lessons).toHaveLength(2);
	});

	it("never exceeds the server's batch ceiling", async () => {
		const env = linked();
		withLessons(env, 150);
		const fetchImpl = accepts();
		await sync({ env, fetchImpl });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		for (const [, init] of fetchImpl.mock.calls) {
			expect(JSON.parse(init.body).lessons.length).toBeLessThanOrEqual(100);
		}
	});

	// Re-running is free because the server dedupes by id. Reporting `noop`
	// separately is what tells the user that, rather than leaving a second run
	// looking like it did the same work twice.
	it("distinguishes newly created lessons from ones already held", async () => {
		const env = linked();
		withLessons(env, 2);
		const fetchImpl = pushes([
			{ id: "a", outcome: "created" },
			{ id: "b", outcome: "noop" },
		]);
		const message = await sync({ env, fetchImpl });
		expect(message).toMatch(/1 new/);
		expect(message).toMatch(/1 already/);
	});

	// The API answers with five outcomes, not two, and its own source warns
	// that conflating them loses lessons: `invalid` means stop sending this,
	// `error` means retry. Counting anything that is not `created` as
	// "already in the pool" would report a lesson that failed to store as one
	// that synced - the exact defect this CLI exists to remove.
	it("does not report a failed lesson as one already in the pool", async () => {
		const env = linked();
		withLessons(env, 1);
		const fetchImpl = pushes([
			{
				id: "c",
				outcome: "error",
				error: "The lesson was not stored; retry it",
			},
		]);
		await expect(sync({ env, fetchImpl })).rejects.toThrow(/retry/i);
	});

	// `invalid` will never succeed, so it must not be reported as retryable.
	// The dispatcher turns a transient failure into exit 2 and everything else
	// into exit 1; getting this wrong tells a script to retry forever.
	it("reports an invalid lesson as terminal, naming the lesson", async () => {
		const env = linked();
		withLessons(env, 1);
		const fetchImpl = pushes([
			{
				id: "01KZ45MKAM734ZS7JK24D2DK0R",
				outcome: "invalid",
				error: "id must be a ULID",
			},
		]);
		await expect(sync({ env, fetchImpl })).rejects.toMatchObject({
			failure: { kind: "rejected" },
		});
		await expect(sync({ env, fetchImpl })).rejects.toThrow(
			/01KZ45MKAM734ZS7JK24D2DK0R/,
		);
	});

	// A conflict means the pool holds a different version under the same id.
	// Silently counting it as synced would hide a real divergence.
	it("surfaces a conflict rather than counting it as synced", async () => {
		const env = linked();
		withLessons(env, 1);
		const fetchImpl = pushes([{ id: "d", outcome: "conflict" }]);
		await expect(sync({ env, fetchImpl })).rejects.toThrow(
			/conflict|different/i,
		);
	});

	// A file the contract rejects is reported and skipped. Aborting the run would
	// let one malformed lesson block every valid one behind it.
	it("skips an invalid lesson and pushes the rest", async () => {
		const env = linked();
		withLessons(env, 1);
		const dir = join(
			env.ONLOOKER_DIR as string,
			"librarian",
			"4c1de90ab372",
			"lessons",
			"approved",
		);
		require("node:fs").writeFileSync(join(dir, "zz-bad.json"), "{}");
		const fetchImpl = accepts();
		const message = await sync({ env, fetchImpl });
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body).lessons).toHaveLength(1);
		expect(message).toMatch(/1 skipped/);
	});
});
