import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
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
});
