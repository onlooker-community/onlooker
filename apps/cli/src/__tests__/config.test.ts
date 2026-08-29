import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath, onlookerDir, readConfig, writeConfig } from "../config";

function sandbox(): NodeJS.ProcessEnv {
	return { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-cli-")) };
}

describe("config", () => {
	it("defaults the API to production and carries no token", () => {
		const config = readConfig(sandbox());
		expect(config.apiBaseUrl).toBe("https://api.onlooker.dev");
		expect(config.machineToken).toBeUndefined();
	});

	it("round-trips a token", () => {
		const env = sandbox();
		writeConfig(
			{ apiBaseUrl: "https://api.onlooker.dev", machineToken: "t" },
			env,
		);
		expect(readConfig(env).machineToken).toBe("t");
	});

	// The file holds a credential that is shown once and recoverable only by
	// revoking the machine. World-readable is not acceptable for that.
	it("writes the config readable only by its owner", () => {
		const env = sandbox();
		writeConfig(
			{ apiBaseUrl: "https://api.onlooker.dev", machineToken: "t" },
			env,
		);
		expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
	});

	// An override is what lets anyone point at staging without editing a file,
	// and what lets these tests avoid the real home directory.
	it("honors ONLOOKER_API_URL over the stored value", () => {
		const env = sandbox();
		writeConfig({ apiBaseUrl: "https://api.onlooker.dev" }, env);
		env.ONLOOKER_API_URL = "https://api-staging.onlooker.dev";
		expect(readConfig(env).apiBaseUrl).toBe("https://api-staging.onlooker.dev");
	});

	it("puts the config beside the lessons it syncs", () => {
		const env = sandbox();
		expect(configPath(env)).toBe(join(onlookerDir(env), "cli.json"));
	});

	// A corrupt file should say so rather than silently resetting the token and
	// making the next command ask for it again with no explanation.
	it("refuses to guess at a corrupt config", () => {
		const env = sandbox();
		writeConfig({ apiBaseUrl: "https://api.onlooker.dev" }, env);
		require("node:fs").writeFileSync(configPath(env), "{ not json");
		expect(() => readConfig(env)).toThrow(/could not be read/i);
	});
});
