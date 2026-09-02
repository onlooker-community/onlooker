import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { status } from "../commands/status";
import { writeConfig } from "../config";

const FIXTURE = join(__dirname, "fixtures", "lesson.json");
const ok = () =>
	vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		json: async () => ({ lessons: [] }),
	});

describe("status", () => {
	it("says so when nothing is linked, without calling the API", async () => {
		const fetchImpl = ok();
		const message = await status({
			env: { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) },
			fetchImpl,
		});
		expect(message).toMatch(/not linked/i);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	// A stored token that no longer authenticates is the case worth catching -
	// it looks linked until something tries to use it.
	it("reports a stored token that no longer works", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		writeConfig(
			{ apiBaseUrl: "https://api.onlooker.dev", machineToken: "stale" },
			env,
		);
		const rejects = vi
			.fn()
			.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
		const message = await status({ env, fetchImpl: rejects });
		expect(message).toMatch(/rejected|no longer/i);
	});

	// An outage is not a bad credential. `sync` on this exact condition says
	// "Could not reach ..." and exits 2; `status` used to call it a rejection,
	// which sends someone on a flaky network to revoke a token that was fine -
	// from the command whose whole job is diagnosis.
	it("does not blame the token when the API cannot be reached", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		writeConfig(
			{ apiBaseUrl: "http://127.0.0.1:9", machineToken: "fine" },
			env,
		);
		const unreachable = vi.fn().mockRejectedValue(new Error("fetch failed"));
		const message = await status({ env, fetchImpl: unreachable });
		expect(message).not.toMatch(/rejected/i);
		expect(message).toMatch(/could not reach/i);
	});

	// A 503 is not a credential problem either, and neither is a 404 on the
	// endpoint. Only a 401 says anything about the token.
	it("does not blame the token when the endpoint has moved", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		writeConfig(
			{ apiBaseUrl: "https://api.onlooker.dev", machineToken: "fine" },
			env,
		);
		const gone = vi
			.fn()
			.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
		expect(await status({ env, fetchImpl: gone })).not.toMatch(/rejected/i);
	});

	it("counts approved lessons waiting to go", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		writeConfig(
			{ apiBaseUrl: "https://api.onlooker.dev", machineToken: "tok" },
			env,
		);
		const dir = join(
			env.ONLOOKER_DIR as string,
			"librarian",
			"k",
			"lessons",
			"approved",
		);
		mkdirSync(dir, { recursive: true });
		cpSync(FIXTURE, join(dir, "a.json"));
		expect(await status({ env, fetchImpl: ok() })).toMatch(/1 approved lesson/);
	});

	// Counting files rather than lessons advertises work `sync` will refuse, so
	// the two commands read as though they disagree about what is on disk.
	it("counts what sync would send, not what is on disk", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		writeConfig(
			{ apiBaseUrl: "https://api.onlooker.dev", machineToken: "tok" },
			env,
		);
		const dir = join(
			env.ONLOOKER_DIR as string,
			"librarian",
			"k",
			"lessons",
			"approved",
		);
		mkdirSync(dir, { recursive: true });
		cpSync(FIXTURE, join(dir, "a.json"));
		writeFileSync(join(dir, "b.json"), "{}");
		const message = await status({ env, fetchImpl: ok() });
		expect(message).toMatch(/1 approved lesson ready/);
		expect(message).toMatch(/1 that cannot be read/);
	});

	// `lessons.ts` models these as two outcomes because they are two different
	// situations, and `sync` explains each. Printing one sentence for both threw
	// that away in the command meant to diagnose it.
	it("tells a missing onlooker directory from a missing librarian one", async () => {
		const missing = {
			ONLOOKER_DIR: join(tmpdir(), "onlooker-does-not-exist-xyz"),
		};
		expect(await status({ env: missing, fetchImpl: ok() })).toMatch(
			/no plugin has run here yet/,
		);

		const empty = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		expect(await status({ env: empty, fetchImpl: ok() })).toMatch(
			/librarian has not run here yet/,
		);
	});

	// Every value starts in the same column. `Lessons:` is a character wider
	// than the other labels and used to knock its own line out of line.
	it("lines its labels up", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		const message = await status({ env, fetchImpl: ok() });
		const columns = message
			.split("\n")
			.map((line) => /^\S+\s+/.exec(line)?.[0].length);
		expect(message.split("\n")).toHaveLength(4);
		expect(new Set(columns).size).toBe(1);
	});

	it("breaks the pipeline down by stage", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		writeConfig(
			{ apiBaseUrl: "https://api.onlooker.dev", machineToken: "tok" },
			env,
		);
		const dir = join(
			env.ONLOOKER_DIR as string,
			"librarian",
			"aaaaaaaaaaaa",
			"lessons",
			"proposals",
		);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "p1.json"),
			JSON.stringify({ status: "confirmed" }),
		);

		const message = await status({ env, fetchImpl: ok() });
		expect(message).toMatch(/^Pipeline: 0 pending review$/m);
		expect(message).toMatch(/^ {10}1 confirmed, awaiting a jury$/m);
		expect(message).toMatch(/^ {10}0 judged, awaiting promotion$/m);
		expect(message).toMatch(/^ {10}0 declined$/m);
	});

	// Every label pads to the longest, and `Pipeline:` is now the longest.
	it("re-pads every label so the values still share a column", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		writeConfig(
			{ apiBaseUrl: "https://api.onlooker.dev", machineToken: "tok" },
			env,
		);
		mkdirSync(join(env.ONLOOKER_DIR as string, "librarian"), {
			recursive: true,
		});

		const message = await status({ env, fetchImpl: ok() });
		// Continuation lines start with a space and carry no label.
		const labeled = message.split("\n").filter((line) => /^\S/.test(line));
		expect(labeled.length).toBe(5);
		for (const line of labeled) {
			// The first colon is always the label's - a value containing one
			// (the API URL) has it later. Every value begins at column 10.
			const afterLabel = line.indexOf(":") + 1;
			expect(line.slice(afterLabel).search(/\S/) + afterLabel).toBe(10);
		}
	});

	// The pool is empty either way; only `status` can say the difference
	// between "librarian never ran" and "it ran and proposed nothing".
	// The case status most has to survive: it exists to explain a broken
	// machine, so dying on an unlistable directory defeats the command.
	it("reports an unlistable librarian directory instead of throwing", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		writeConfig(
			{ apiBaseUrl: "https://api.onlooker.dev", machineToken: "tok" },
			env,
		);
		writeFileSync(join(env.ONLOOKER_DIR as string, "librarian"), "");

		const message = await status({ env, fetchImpl: ok() });
		expect(message).toMatch(/^Lessons: {2}unknown - .*could not be listed$/m);
		// "unknown", never "none" - we did not look successfully, so a count
		// would be an answer we do not have.
		expect(message).not.toMatch(/Lessons: {2}none/);
		// No pipeline breakdown: it would be zeros restating the line above.
		expect(message).not.toMatch(/^Pipeline:/m);
	});

	it("names a project it could not list beside the count it did manage", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		writeConfig(
			{ apiBaseUrl: "https://api.onlooker.dev", machineToken: "tok" },
			env,
		);
		const broken = join(
			env.ONLOOKER_DIR as string,
			"librarian",
			"bbbbbbbbbbbb",
			"lessons",
		);
		mkdirSync(broken, { recursive: true });
		writeFileSync(join(broken, "approved"), "");

		const message = await status({ env, fetchImpl: ok() });
		expect(message).toMatch(/1 project that could not be listed/);
	});

	it("says when the lesson pipeline has never run", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		writeConfig(
			{ apiBaseUrl: "https://api.onlooker.dev", machineToken: "tok" },
			env,
		);
		mkdirSync(join(env.ONLOOKER_DIR as string, "librarian"), {
			recursive: true,
		});

		const message = await status({ env, fetchImpl: ok() });
		expect(message).toMatch(/^Pipeline: no lesson pipeline has run here$/m);
	});
});
