import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctor } from "../commands/doctor";

function bareMachine(): {
	cwd: string;
	home: string;
	configDir: string;
	env: NodeJS.ProcessEnv;
} {
	const dir = mkdtempSync(join(tmpdir(), "onlooker-doc-"));
	mkdirSync(join(dir, "logs"), { recursive: true });
	writeFileSync(join(dir, "logs", "onlooker-events.jsonl"), "");
	writeFileSync(join(dir, "logs", "hook-health.jsonl"), "");
	const cwd = mkdtempSync(join(tmpdir(), "onlooker-doc-proj-"));
	mkdirSync(join(cwd, ".claude"), { recursive: true });
	writeFileSync(
		join(cwd, ".claude", "settings.json"),
		JSON.stringify({
			enabledPlugins: { "inspector@onlooker-community": true },
		}),
	);
	return {
		cwd,
		home: mkdtempSync(join(tmpdir(), "onlooker-doc-home-")),
		// Empty on purpose - see the isolation note in Task 5.
		configDir: mkdtempSync(join(tmpdir(), "onlooker-doc-cfg-")),
		env: { ONLOOKER_DIR: dir },
	};
}

describe("doctor", () => {
	it("returns rendered text and an exit code together", async () => {
		const { cwd, home, configDir, env } = bareMachine();
		const result = await doctor({ cwd, home, configDir, env });
		expect(typeof result.text).toBe("string");
		expect([0, 1]).toContain(result.code);
		expect(result.text).toContain("Expected:");
	});

	// The contract that matters most: this is the command someone runs
	// because the machine is broken, so it must survive the broken machine.
	it("does not throw when nothing exists at all", async () => {
		const empty = mkdtempSync(join(tmpdir(), "onlooker-doc-none-"));
		await expect(
			doctor({
				cwd: empty,
				home: mkdtempSync(join(tmpdir(), "onlooker-doc-nohome-")),
				configDir: mkdtempSync(join(tmpdir(), "onlooker-doc-nocfg-")),
				env: { ONLOOKER_DIR: empty },
			}),
		).resolves.toBeDefined();
	});

	it("exits 1 when it cannot tell what should be running", async () => {
		const empty = mkdtempSync(join(tmpdir(), "onlooker-doc-unknown-"));
		const result = await doctor({
			cwd: empty,
			home: mkdtempSync(join(tmpdir(), "onlooker-doc-unknown-home-")),
			configDir: mkdtempSync(join(tmpdir(), "onlooker-doc-unknown-cfg-")),
			env: { ONLOOKER_DIR: empty },
		});
		expect(result.code).toBe(1);
	});
});
