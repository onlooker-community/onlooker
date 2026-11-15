import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectLabels, WHAT_IS_SENT } from "../commands/project-labels";
import { configPath, readConfig, writeConfig } from "../config";
import { CliError } from "../errors";

const API = "https://api.onlooker.dev";

function linked(): NodeJS.ProcessEnv {
	const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-cli-")) };
	writeConfig({ apiBaseUrl: API, machineToken: "t" }, env);
	return env;
}

function answering(
	status: number,
	body: unknown,
	calls: Request[] = [],
): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(new Request(input, init));
		return new Response(JSON.stringify(body), { status });
	}) as typeof fetch;
}

describe("project-labels", () => {
	it("is off until turned on, and says what on sends", async () => {
		const env = linked();
		expect(await projectLabels(undefined, { env })).toMatch(
			/^Project labels: off/,
		);
		const text = await projectLabels("on", { env });
		expect(readConfig(env).projectLabels).toBe(true);
		expect(text).toContain(WHAT_IS_SENT);
		expect(WHAT_IS_SENT).toMatch(/private/i);
		expect(WHAT_IS_SENT).toMatch(/never/i);
		expect(WHAT_IS_SENT).toMatch(/host/i);
	});

	it("turns off before asking the API to delete", async () => {
		const env = linked();
		await projectLabels("on", { env });
		const calls: Request[] = [];
		const fetchImpl = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			// The choice is on disk before the request leaves.
			expect(readConfig(env).projectLabels).toBe(false);
			calls.push(new Request(input, init));
			return new Response(JSON.stringify({ deleted: 3 }), { status: 200 });
		}) as typeof fetch;
		const text = await projectLabels("off", { env, fetchImpl });
		expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
			"DELETE /machine/project-labels",
		]);
		expect(text).toMatch(/3/);
		expect(readConfig(env).projectLabelsPending).toBeUndefined();
	});

	it("leaves the deletion pending when the API refuses it", async () => {
		const env = linked();
		await projectLabels("on", { env });
		const text = await projectLabels("off", {
			env,
			fetchImpl: answering(503, {}),
		});
		expect(readConfig(env)).toMatchObject({
			projectLabels: false,
			projectLabelsPending: "delete",
		});
		expect(text).toMatch(/pending/i);
		expect(await projectLabels("status", { env })).toMatch(/deletion pending/);
	});

	it("keeps the token and refuses an unknown action", async () => {
		const env = linked();
		await projectLabels("on", { env });
		expect(readConfig(env).machineToken).toBe("t");
		await expect(projectLabels("maybe", { env })).rejects.toThrow(CliError);
		expect(readFileSync(configPath(env), "utf8")).toContain("projectLabels");
	});
});
