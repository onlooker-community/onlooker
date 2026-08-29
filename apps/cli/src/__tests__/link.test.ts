import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { link } from "../commands/link";
import { readConfig } from "../config";

const env = () => ({
	ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-link-")),
});
const ok = () =>
	vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		json: async () => ({ lessons: [] }),
	});

describe("link", () => {
	it("stores a token the API accepts", async () => {
		const e = env();
		await link({ env: e, prompt: async () => "good-token", fetchImpl: ok() });
		expect(readConfig(e).machineToken).toBe("good-token");
	});

	// Storing first and verifying later would leave a bad token on disk and make
	// every later command fail with a puzzle instead of a rejection here.
	it("does not store a token the API rejects", async () => {
		const e = env();
		const rejects = vi
			.fn()
			.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
		await expect(
			link({ env: e, prompt: async () => "bad-token", fetchImpl: rejects }),
		).rejects.toMatchObject({ failure: { kind: "unauthorized" } });
		expect(readConfig(e).machineToken).toBeUndefined();
	});

	it("trims what was pasted", async () => {
		const e = env();
		await link({ env: e, prompt: async () => "  padded\n", fetchImpl: ok() });
		expect(readConfig(e).machineToken).toBe("padded");
	});

	it("refuses an empty token without calling the API", async () => {
		const fetchImpl = ok();
		await expect(
			link({ env: env(), prompt: async () => "   ", fetchImpl }),
		).rejects.toThrow(/no token/i);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	// The token is shown once and recoverable only by revoking the machine.
	// Echoing it into a success message would put it in the scrollback.
	it("never repeats the token back", async () => {
		const message = await link({
			env: env(),
			prompt: async () => "sensitive-value",
			fetchImpl: ok(),
		});
		expect(message).not.toContain("sensitive-value");
	});
});
