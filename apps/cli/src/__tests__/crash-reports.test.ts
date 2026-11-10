import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crashReports, WHAT_IS_SENT } from "../commands/crash-reports";
import { configPath, readConfig, writeConfig } from "../config";
import { CliError } from "../errors";

const API = "https://api.onlooker.dev";

function linked(): NodeJS.ProcessEnv {
	const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-cli-")) };
	writeConfig({ apiBaseUrl: API, machineToken: "t" }, env);
	return env;
}

describe("crash-reports", () => {
	it("records on and off, keeping the token and the file mode", () => {
		const env = linked();
		crashReports("on", { env });
		expect(readConfig(env)).toMatchObject({
			machineToken: "t",
			crashReports: true,
		});
		expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);

		crashReports("off", { env });
		expect(readConfig(env)).toMatchObject({
			machineToken: "t",
			crashReports: false,
		});
	});

	// Agreeing means knowing what you agreed to, so `on` prints the contents.
	it("prints what a report contains when turned on", () => {
		const text = crashReports("on", { env: linked() });
		expect(text).toContain(WHAT_IS_SENT);
		expect(WHAT_IS_SENT).toMatch(/never contains/i);
		expect(WHAT_IS_SENT).toMatch(/hostname/i);
	});

	it("reads the setting back without changing it", () => {
		const env = linked();
		expect(crashReports(undefined, { env })).toMatch(/^Crash reports: off/);
		expect(crashReports("status", { env })).toMatch(/^Crash reports: off/);
		expect(readFileSync(configPath(env), "utf8")).not.toContain("crashReports");
	});

	it("says when the environment is overriding a recorded yes", () => {
		const env = linked();
		crashReports("on", { env });
		expect(
			crashReports("status", { env: { ...env, DO_NOT_TRACK: "1" } }),
		).toContain("DO_NOT_TRACK is set");
	});

	it("refuses an action it does not know, as a CliError", () => {
		expect(() => crashReports("maybe", { env: linked() })).toThrow(CliError);
	});
});
