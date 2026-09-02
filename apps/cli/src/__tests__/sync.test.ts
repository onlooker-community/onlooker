import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

/**
 * A 200 that answers for every lesson it was sent, the way the API does: one
 * result per lesson, carrying the id that was actually pushed.
 *
 * The outcomes are applied in order and anything past the end of the list comes
 * back `created`. Echoing the sent ids rather than inventing them is what makes
 * these stubs honest - a stub that answers for lessons nobody sent, or answers
 * for none of them, is now a failure, and it should be.
 */
const pushes = (outcomes: Array<{ outcome: string; error?: string }> = []) =>
	vi.fn().mockImplementation(async (_url, init) => ({
		ok: true,
		status: 200,
		json: async () => ({
			results: (JSON.parse(init.body).lessons as Array<{ id: string }>).map(
				(lesson, index) => ({
					id: lesson.id,
					outcome: outcomes[index]?.outcome ?? "created",
					error: outcomes[index]?.error,
				}),
			),
		}),
	}));

const accepts = () => pushes();

/** A 200 whose body is `{ results: [...] }` verbatim, whatever was sent. */
const answers = (results: unknown) =>
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

	it("says the lesson pipeline has never run when no key has a lessons dir", async () => {
		const env = linked();
		// A project key librarian knows about, with only its memory queue.
		mkdirSync(
			join(
				env.ONLOOKER_DIR as string,
				"librarian",
				"aaaaaaaaaaaa",
				"proposals",
			),
			{ recursive: true },
		);
		const message = await sync({ env, fetchImpl: accepts() });
		expect(message).toMatch(/lesson pipeline never has/i);
	});

	it("says nothing is at any stage when the pipeline has run and proposed nothing", async () => {
		const env = linked();
		mkdirSync(
			join(
				env.ONLOOKER_DIR as string,
				"librarian",
				"aaaaaaaaaaaa",
				"lessons",
				"proposals",
			),
			{ recursive: true },
		);
		const message = await sync({ env, fetchImpl: accepts() });
		expect(message).toMatch(/nothing at any earlier stage/i);
	});

	// The case the bead was filed for: the pool is empty and the reason is two
	// proposals stuck one step short of it.
	it("names the stage that is holding proposals back", async () => {
		const env = linked();
		const dir = join(
			env.ONLOOKER_DIR as string,
			"librarian",
			"aaaaaaaaaaaa",
			"lessons",
			"proposals",
		);
		mkdirSync(dir, { recursive: true });
		for (const id of ["p1", "p2"]) {
			writeFileSync(
				join(dir, `${id}.json`),
				JSON.stringify({ status: "confirmed" }),
			);
		}

		const fetchImpl = accepts();
		const message = await sync({ env, fetchImpl });
		expect(message).toMatch(/2 confirmed and awaiting a jury/);
		expect(message).toMatch(/0 pending review/);
		// Still the success path: nothing to send is not a failure.
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("says where it looked when the ecosystem has never run here", async () => {
		const message = await sync({ env: linked(), fetchImpl: accepts() });
		expect(message).toMatch(/librarian/);
	});

	// Deliberately a failure, not "nothing to sync". Exiting 0 here would claim
	// there is nothing to send on a machine where we could not look.
	it("fails rather than reporting nothing when librarian cannot be listed", async () => {
		const env = linked();
		writeFileSync(join(env.ONLOOKER_DIR as string, "librarian"), "");
		const fetchImpl = accepts();
		await expect(sync({ env, fetchImpl })).rejects.toThrow(
			/could not be listed/i,
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	// A partial listing failure must not read as a complete run: the summary
	// would be true about what was sent and silent about what was missed.
	it("reports a project it could not list even when the push succeeds", async () => {
		const env = linked();
		withLessons(env, 1);
		const broken = join(
			env.ONLOOKER_DIR as string,
			"librarian",
			"bbbbbbbbbbbb",
			"lessons",
		);
		mkdirSync(broken, { recursive: true });
		writeFileSync(join(broken, "approved"), "");

		await expect(sync({ env, fetchImpl: accepts() })).rejects.toThrow(
			/could not be listed/i,
		);
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
		const fetchImpl = pushes([{ outcome: "created" }, { outcome: "noop" }]);
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
			{ outcome: "error", error: "The lesson was not stored; retry it" },
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
			{ outcome: "invalid", error: "id must be a ULID" },
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
		const fetchImpl = pushes([{ outcome: "conflict" }]);
		await expect(sync({ env, fetchImpl })).rejects.toThrow(
			/conflict|different/i,
		);
	});

	/** Writes a file the lesson contract will refuse. */
	function withMalformed(env: NodeJS.ProcessEnv, name: string): void {
		const dir = join(
			env.ONLOOKER_DIR as string,
			"librarian",
			"4c1de90ab372",
			"lessons",
			"approved",
		);
		mkdirSync(dir, { recursive: true });
		require("node:fs").writeFileSync(join(dir, name), "{}");
	}

	// A file the contract rejects is still skipped rather than aborting the run -
	// one malformed lesson must not block every valid one behind it - but the run
	// as a whole did not do what was asked, so it does not report success. The
	// valid lessons go up first; only then does it complain.
	it("pushes the valid lessons and still fails on the skipped one", async () => {
		const env = linked();
		withLessons(env, 1);
		withMalformed(env, "zz-bad.json");
		const fetchImpl = accepts();
		await expect(sync({ env, fetchImpl })).rejects.toMatchObject({
			failure: { kind: "rejected" },
		});
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body).lessons).toHaveLength(1);
	});

	// The report has to survive the throw. Someone told only that a file was
	// skipped, with no word on the lessons that did go up, cannot tell whether
	// re-running is safe.
	it("carries both the counts and the skipped file into the failure", async () => {
		const env = linked();
		withLessons(env, 1);
		withMalformed(env, "zz-bad.json");
		await expect(sync({ env, fetchImpl: accepts() })).rejects.toThrow(
			/1 new[\s\S]*zz-bad\.json/,
		);
	});

	// Nothing was pushed, so exiting 0 would tell a script the run succeeded. A
	// malformed file does not fix itself on a retry, which is why this is
	// `rejected` (go look) and not `transient` (try again).
	it("fails when every lesson on disk is malformed", async () => {
		const env = linked();
		withMalformed(env, "a-bad.json");
		withMalformed(env, "b-bad.json");
		const fetchImpl = accepts();
		await expect(sync({ env, fetchImpl })).rejects.toMatchObject({
			failure: { kind: "rejected" },
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	// The moved-endpoint class of event, one level down from a 404: a 200 whose
	// body is not the shape the CLI expects. Counting only what came back would
	// print "Synced 3 lessons: 0 new, 0 already in the pool." and exit 0.
	it("does not call a lesson synced when the API never answered for it", async () => {
		const env = linked();
		withLessons(env, 3);
		await expect(sync({ env, fetchImpl: answers([]) })).rejects.toMatchObject({
			failure: { kind: "transient" },
		});
	});

	// Lesson ids are not unique across the files on disk: `discoverApproved`
	// walks every project key, so one lesson approved under two of them is two
	// files carrying one id - and the batch-ceiling test above pushes 150 copies
	// of a single id, so this is the suite's normal case, not an exotic one.
	// Reconciling by id alone lets one result stand in for every copy: three
	// sent, one answered, "Synced 3 lessons: 1 new" at exit 0.
	it("does not let one result answer for three copies of an id", async () => {
		const env = linked();
		withLessons(env, 3);
		const fetchImpl = answers([
			{ id: "01KZ45MKAM734ZS7JK24D2DK0R", outcome: "created" },
		]);
		await expect(sync({ env, fetchImpl })).rejects.toMatchObject({
			failure: { kind: "transient" },
		});
		// Two of the three, not one: the count has to be as honest as the throw.
		await expect(sync({ env, fetchImpl })).rejects.toThrow(
			/2 lesson\(s\) were not stored/,
		);
	});

	// The mirror case. Extra results are tallied into the counts before anything
	// notices they answer for nothing, so the summary claims more lessons stored
	// than the run pushed - "Synced 1 lesson: 2 new", exit 0.
	it("does not accept more results than the batch it sent", async () => {
		const env = linked();
		withLessons(env, 1);
		const fetchImpl = answers([
			{ id: "01KZ45MKAM734ZS7JK24D2DK0R", outcome: "created" },
			{ id: "01KZ45MKAM734ZS7JK24D2DK0R", outcome: "created" },
		]);
		await expect(sync({ env, fetchImpl })).rejects.toMatchObject({
			failure: { kind: "transient" },
		});
	});

	// `api.ts` casts the body instead of validating it, so `results` can be
	// anything. Iterating a string would walk it character by character and
	// invent one nonsense failure per letter; the lesson that went unanswered is
	// the thing worth naming.
	it("does not read a results field that is not an array", async () => {
		const env = linked();
		withLessons(env, 1);
		await expect(sync({ env, fetchImpl: answers("oops") })).rejects.toThrow(
			/01KZ45MKAM734ZS7JK24D2DK0R: the API did not answer/,
		);
	});

	// A lesson that fails every time must not hide behind one that fails
	// intermittently. Reporting only the transient error leaves someone running
	// `sync` forever while the permanent problem is never named.
	it("names the terminal failure even when a retryable one is thrown", async () => {
		const env = linked();
		withLessons(env, 2);
		const fetchImpl = pushes([
			{ outcome: "error", error: "storage was busy" },
			{ outcome: "invalid", error: "id must be a ULID" },
		]);
		// `transient` so the exit code still says retry, with the refusal in the
		// message so the retry is not the only thing the user learns.
		await expect(sync({ env, fetchImpl })).rejects.toMatchObject({
			failure: { kind: "transient" },
		});
		await expect(sync({ env, fetchImpl })).rejects.toThrow(
			/storage was busy[\s\S]*id must be a ULID/,
		);
	});
});
