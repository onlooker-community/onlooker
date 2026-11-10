import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath, writeConfig } from "../config";
import { crashConsent } from "../consent";

const API = "https://api.onlooker.dev";

function sandbox(crashReports?: boolean): NodeJS.ProcessEnv {
	const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-cli-")) };
	if (crashReports !== undefined)
		writeConfig({ apiBaseUrl: API, crashReports }, env);
	return env;
}

describe("crashConsent", () => {
	it("is off until someone chooses", () => {
		expect(crashConsent(sandbox())).toEqual({ on: false, why: "not-chosen" });
	});

	it("is on only when cli.json says so", () => {
		expect(crashConsent(sandbox(true))).toEqual({ on: true });
		expect(crashConsent(sandbox(false))).toEqual({
			on: false,
			why: "turned-off",
		});
	});

	// The environment can only take consent away. A shell, a CI runner or a
	// dotfile must never be able to opt a machine in.
	it("lets DO_NOT_TRACK override a recorded yes", () => {
		const env = { ...sandbox(true), DO_NOT_TRACK: "1" };
		expect(crashConsent(env)).toEqual({
			on: false,
			why: "environment",
			variable: "DO_NOT_TRACK",
		});
	});

	it("lets ONLOOKER_CRASH_REPORTS=0 override a recorded yes", () => {
		for (const value of ["0", "false", "off", "no"]) {
			const env = { ...sandbox(true), ONLOOKER_CRASH_REPORTS: value };
			expect(crashConsent(env)).toMatchObject({
				on: false,
				variable: "ONLOOKER_CRASH_REPORTS",
			});
		}
	});

	it("cannot be turned on from the environment", () => {
		const env = { ...sandbox(), ONLOOKER_CRASH_REPORTS: "1" };
		expect(crashConsent(env)).toEqual({ on: false, why: "not-chosen" });
	});

	it("ignores an empty or zero DO_NOT_TRACK", () => {
		for (const value of ["", "0", "false"]) {
			expect(crashConsent({ ...sandbox(true), DO_NOT_TRACK: value })).toEqual({
				on: true,
			});
		}
	});

	// Asked from inside a crash handler. A second throw there would replace
	// the error being reported with one about the config.
	it("answers off, not a throw, for a config it cannot read", () => {
		const env = sandbox(true);
		writeFileSync(configPath(env), "{ not json");
		expect(crashConsent(env)).toEqual({ on: false, why: "unreadable" });
	});
});
