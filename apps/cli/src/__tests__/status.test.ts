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
});
